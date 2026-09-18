//! The realtime seam.
//!
//! Ported from `src/realtime/{index,upstash,disabled}.ts` — and, because the
//! original delegated the wire to two npm packages, from the parts of
//! `@upstash/realtime@…/dist/server/{realtime,handler}.js` and
//! `@upstash/redis@1.38.1` that those two files actually reach. Routes only ever
//! call `emit`; swapping Upstash for Durable Object WebSockets later means one
//! more variant here and nothing in a route.
//!
//! Two behaviours are load-bearing and easy to lose:
//!
//! - `emit` never fails. The D1 write has already committed and clients poll as
//!   a backstop, so a Redis failure must be logged and swallowed, never turned
//!   into a 500.
//! - `subscribe` is handed the **original** `Request`, because the teardown
//!   hangs off `request.signal`. Rebuilding the request would leak a Redis
//!   subscription every time a client navigates away.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;
use std::time::Duration;

use js_sys::{Array, Promise, Uint8Array};
use serde_json::{json, Map, Value};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::{future_to_promise, spawn_local, JsFuture};
use worker::{console_error, console_log, Delay, Env, Request, Response, Result as WorkerResult};

use crate::http::{code, ApiError};
use crate::js;

/// The client the original constructed, spelled out. `@upstash/redis` reports
/// itself on every request; keeping the string here means the outbound calls
/// stay indistinguishable from the ones the Node client made.
const SDK_VERSION: &str = "v1.38.1";

/// `history: { maxLength: 100, expireAfterSecs: 60 * 60 * 24 * 7 }`. A short
/// replay buffer closes the gap between "page rendered" and "stream connected",
/// so a join landing in that window still shows up. Trim + expiry keep Redis
/// storage flat with no cleanup job.
const HISTORY_MAX_LENGTH: i64 = 100;
const HISTORY_EXPIRE_AFTER_SECS: i64 = 60 * 60 * 24 * 7;

/// `retry: { retries: 1, backoff: () => 100 }`. The REST client retries
/// generously by default; a realtime event is not worth stalling the mutation
/// response that triggered it.
const RETRY_ATTEMPTS: usize = 1;
const RETRY_BACKOFF_MS: u64 = 100;

/// `handle()` publishes a ping every 10s for every open connection. This is the
/// Upstash command budget, and it is not configurable from out here.
const KEEPALIVE_INTERVAL_MS: u64 = 10_000;

/// The recycle timer's safety margin and floor, from `handle()`.
const RECYCLE_MARGIN_MS: f64 = 2_000.0;
const RECYCLE_FLOOR_MS: f64 = 1_000.0;

/// `MAX_BUFFER_SIZE` in the REST client's SSE reader: a line longer than this
/// aborts the read rather than growing without bound.
const MAX_BUFFER_SIZE: usize = 1024 * 1024;

/// Channels the library falls back to when the query string names none. The
/// route requires at least one, so this is unreachable through it — reproduced
/// because the library, not the route, decides it.
const DEFAULT_CHANNEL: &str = "default";

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

pub enum PubSub {
    Upstash(Upstash),
    Disabled,
}

/// Truthiness, not presence: an empty binding selects the disabled
/// implementation, which is the default for local development so `wrangler dev`
/// works without an Upstash account.
pub fn create_pub_sub(env: &Env) -> PubSub {
    match crate::env::upstash(env) {
        Some((url, token)) => {
            PubSub::Upstash(Upstash::new(url, token, crate::env::sse_max_duration_secs(env)))
        }
        None => PubSub::Disabled,
    }
}

impl PubSub {
    /// False when realtime is unavailable; clients then rely on polling alone.
    pub fn enabled(&self) -> bool {
        matches!(self, PubSub::Upstash(_))
    }

    /// Publish one event to one or more channels.
    ///
    /// Never fails. Every per-channel error is logged and dropped, exactly as
    /// the original's `.catch()` did, and the targets are dispatched
    /// concurrently through `Promise.all` — the same shape, so the same
    /// interleaving.
    pub async fn emit(&self, channels: &[&str], event: &str, data: &Value) {
        match self {
            PubSub::Disabled => {
                // `[channels].flat().join(', ')` — a bare string normalises to a
                // one-element list, which is what joining a slice already does.
                console_log!(
                    "[realtime disabled] would emit {} to {}",
                    event,
                    channels.join(", ")
                );
            }
            PubSub::Upstash(client) => {
                /*
                 * Anything derived from the whole history is now wrong.
                 *
                 * Hung off `emit` rather than sprinkled through the routes
                 * because this is already the call every mutation makes to say
                 * it changed something — and a list of a dozen call sites is a
                 * list somebody eventually forgets to add to. The names are
                 * matched positively: a new event has to opt in, so the failure
                 * mode of forgetting is a stale board for an hour rather than a
                 * silent extra Redis round trip on every message posted.
                 *
                 * It is also self-consistent about being switched off. The
                 * cache and the stream are the same Redis, so a deployment
                 * without one has neither, and there is nothing to invalidate.
                 */
                if AFFECTS_HISTORY.contains(&event) {
                    let commands = serde_json::json!([["DEL", crate::cache::LEADERBOARD_KEY]]);
                    if let Err(error) =
                        pipeline(&client.base_url, &client.token, &commands).await
                    {
                        console_log!("[cache] could not drop the leaderboard: {error}");
                    }
                }

                let promises = Array::new();
                for channel in channels {
                    // Stream ids are handed out synchronously for every target
                    // before any of them reaches the network, so a burst inside
                    // one millisecond still gets `-0`, `-1`, … in order.
                    let id = client.next_stream_id();
                    let base_url = client.base_url.clone();
                    let token = client.token.clone();
                    let channel = (*channel).to_string();
                    let event = event.to_string();
                    let data = data.clone();
                    promises.push(&future_to_promise(async move {
                        if let Err(error) =
                            publish_event(&base_url, &token, &channel, &event, &data, &id).await
                        {
                            console_error!(
                                "realtime emit failed ({} -> {}) {}",
                                event,
                                channel,
                                error
                            );
                        }
                        Ok(JsValue::UNDEFINED)
                    }));
                }
                let _ = JsFuture::from(Promise::all(&promises)).await;
            }
        }
    }

    /// Serve an SSE subscription for the given channels.
    pub async fn subscribe(&self, request: &Request, channels: &[&str]) -> WorkerResult<Response> {
        match self {
            // 503, which the client reads as "go straight to polling" rather
            // than as a transient failure to retry.
            PubSub::Disabled => ApiError::new(
                503,
                code::REALTIME_DISABLED,
                "Realtime is not configured; poll instead.",
            )
            .to_response(),
            PubSub::Upstash(client) => client.subscribe(request, channels).await,
        }
    }
}

/// Events after which the leaderboard has to be recomputed.
///
/// Everything the board is derived from: who is registered, who turned up, who
/// won an award, and which sessions are in the window at all. Deliberately not
/// `teams.changed`, `player.moved`, `message.*` or `payment.*` — none of those
/// moves a figure on any board, and dropping the key for them would mean
/// rebuilding it during the busiest minute of a Friday for no reason.
///
/// Goals and member changes do not emit events at all, so those two invalidate
/// by hand at their own call sites.
const AFFECTS_HISTORY: [&str; 5] =
    ["player.joined", "player.left", "player.attendance", "mvp.changed", "session.updated"];

// ---------------------------------------------------------------------------
// Upstash
// ---------------------------------------------------------------------------

pub struct Upstash {
    /// `config.url` with one trailing slash removed, as the REST client does.
    base_url: String,
    token: String,
    /// Recycle long-lived streams so connections (and their keepalives) cannot
    /// accumulate indefinitely. The client reconnects transparently.
    max_duration_secs: i64,
    ids: RefCell<StreamIds>,
}

/// `generateStreamId` state: ids are `<epoch ms>-<sequence>`, and the sequence
/// only has to avoid ids this instance already issued in the same millisecond.
struct StreamIds {
    last_timestamp: f64,
    issued: HashSet<String>,
}

impl Upstash {
    fn new(url: String, token: String, max_duration_secs: i64) -> Self {
        let base_url = url.strip_suffix('/').unwrap_or(&url).to_string();
        Self {
            base_url,
            token,
            max_duration_secs,
            ids: RefCell::new(StreamIds { last_timestamp: 0.0, issued: HashSet::new() }),
        }
    }

    fn next_stream_id(&self) -> String {
        let mut ids = self.ids.borrow_mut();
        let timestamp = js::now_ms();
        if timestamp != ids.last_timestamp {
            ids.issued.clear();
            ids.last_timestamp = timestamp;
        }
        let mut sequence = 0u64;
        let mut id = format!("{}-{}", timestamp as i64, sequence);
        while ids.issued.contains(&id) {
            sequence += 1;
            id = format!("{}-{}", timestamp as i64, sequence);
        }
        ids.issued.insert(id.clone());
        id
    }

    async fn subscribe(&self, request: &Request, allowed: &[&str]) -> WorkerResult<Response> {
        let request_start_ms = js::now_ms();

        let url = request.url()?;
        let params: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let first = |name: &str| -> Option<String> {
            params.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
        };

        let mut requested: Vec<String> = params
            .iter()
            .filter(|(key, _)| key == "channels")
            .map(|(_, value)| value.clone())
            .collect();
        if requested.is_empty() {
            requested.push(DEFAULT_CHANNEL.to_string());
        }

        // The route has already authorized `channels` against the caller's
        // identity. Re-checking what the library actually parsed out of the
        // query string means a future change to its parsing fails closed rather
        // than silently widening access.
        let denied: Vec<&str> = requested
            .iter()
            .map(String::as_str)
            .filter(|channel| !allowed.contains(channel))
            .collect();
        if !denied.is_empty() {
            return ApiError::new(
                403,
                code::FORBIDDEN,
                format!("Not subscribable: {}", denied.join(", ")),
            )
            .to_response();
        }

        let context = Rc::new(Context {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
            reconnect: first("reconnect"),
            history_all: first("history_all"),
            history_length: first("history_length"),
            history_since: first("history_since"),
            connection_start: first("connection_start"),
            last_ack: requested
                .iter()
                .filter_map(|channel| {
                    // `if (lastAck)` — an empty value is not an ack.
                    first(&format!("last_ack_{channel}"))
                        .filter(|ack| !ack.is_empty())
                        .map(|ack| (channel.clone(), ack))
                })
                .collect(),
            channels: requested.clone(),
        });

        let transform = web_sys::TransformStream::new()?;
        let readable = transform.readable();
        let writer = transform.writable().get_writer()?;

        let signal = request.inner().signal();
        let stream = Rc::new(Sse {
            writer,
            closed: Cell::new(false),
            controllers: RefCell::new(Vec::new()),
            abort_listener: RefCell::new(None),
            signal: signal.clone(),
            swallow: Closure::new(|_: JsValue| {}),
        });

        // Already gone before we started: close and send nothing at all. The
        // response is still a 200 `text/event-stream`, just an empty one.
        if signal.aborted() {
            stream.cleanup();
            return sse_response(readable);
        }

        // `ReadableStream.cancel()` ran `cleanup()` in the original. A cancelled
        // readable half errors the writable one, which settles this promise —
        // so a client that walks away without aborting still tears the
        // subscriptions down instead of leaving the keepalive publishing.
        spawn_local({
            let stream = stream.clone();
            async move {
                let _ = JsFuture::from(stream.writer.closed()).await;
                stream.cleanup();
            }
        });

        let listener = Closure::<dyn FnMut()>::new({
            let stream = stream.clone();
            move || stream.cleanup()
        });
        signal.add_event_listener_with_callback("abort", listener.as_ref().unchecked_ref())?;
        *stream.abort_listener.borrow_mut() = Some(listener);

        // Recycle timer. With the default 600s cap that is ~598s: a 2s margin
        // under the platform's own limit, floored at 1s so a request that
        // arrives late still gets a usable stream.
        let elapsed_ms = js::now_ms() - request_start_ms;
        let remaining_ms = self.max_duration_secs as f64 * 1000.0 - elapsed_ms;
        let stream_duration_ms = (remaining_ms - RECYCLE_MARGIN_MS).max(RECYCLE_FLOOR_MS);
        spawn_local({
            let stream = stream.clone();
            async move {
                Delay::from(Duration::from_millis(stream_duration_ms as u64)).await;
                if stream.closed.get() {
                    return;
                }
                stream.enqueue(&json!({ "type": "reconnect" }));
                stream.cleanup();
            }
        });

        // One SSE subscription per channel, each with its own abort controller
        // so `cleanup` can hang every one of them up.
        for channel in &requested {
            let controller = web_sys::AbortController::new()?;
            stream.controllers.borrow_mut().push(controller.clone());
            spawn_local(run_subscription(
                context.clone(),
                stream.clone(),
                channel.clone(),
                controller.signal(),
            ));
        }

        // Keepalive. The ping travels out through Redis and comes back on the
        // subscription, so every subscriber of the channel sees it.
        spawn_local({
            let context = context.clone();
            let stream = stream.clone();
            async move {
                loop {
                    Delay::from(Duration::from_millis(KEEPALIVE_INTERVAL_MS)).await;
                    if stream.closed.get() {
                        return;
                    }
                    for channel in &context.channels {
                        let _ = publish_ping(&context.base_url, &context.token, channel).await;
                    }
                }
            }
        });

        sse_response(readable)
    }
}

/// The query string and credentials every subscription task shares.
struct Context {
    base_url: String,
    token: String,
    channels: Vec<String>,
    reconnect: Option<String>,
    history_all: Option<String>,
    history_length: Option<String>,
    history_since: Option<String>,
    connection_start: Option<String>,
    last_ack: Vec<(String, String)>,
}

impl Context {
    fn last_ack_for(&self, channel: &str) -> Option<&str> {
        self.last_ack.iter().find(|(name, _)| name == channel).map(|(_, ack)| ack.as_str())
    }
}

// ---------------------------------------------------------------------------
// The stream the client holds
// ---------------------------------------------------------------------------

/// The writable half of the response, plus everything `cleanup` has to undo.
struct Sse {
    writer: web_sys::WritableStreamDefaultWriter,
    closed: Cell<bool>,
    controllers: RefCell<Vec<web_sys::AbortController>>,
    abort_listener: RefCell<Option<Closure<dyn FnMut()>>>,
    signal: web_sys::AbortSignal,
    /// One reusable rejection handler. Writes are fired and not awaited (the
    /// original enqueued synchronously), and a stream the client has already
    /// dropped rejects them; without a handler that is an unhandled rejection.
    swallow: Closure<dyn FnMut(JsValue)>,
}

impl Sse {
    /// `safeEnqueue(json(data))` — the literal bytes `data: `, compact JSON,
    /// then a blank line. There are no `event:` names, no `id:` lines and no
    /// `retry:` directive; frames are told apart by their JSON shape.
    fn enqueue(&self, value: &Value) {
        if self.closed.get() {
            return;
        }
        let frame = format!("data: {value}\n\n");
        let chunk = Uint8Array::from(frame.as_bytes());
        self.swallow_rejection(self.writer.write_with_chunk(&chunk));
    }

    fn swallow_rejection(&self, promise: Promise) {
        let _ = promise.catch(&self.swallow);
    }

    /// Idempotent: clear the listener, hang up every subscription, close the
    /// body. Taking the listener out also breaks the cycle that keeps this
    /// struct alive.
    fn cleanup(self: &Rc<Self>) {
        if self.closed.get() {
            return;
        }
        self.closed.set(true);
        if let Some(listener) = self.abort_listener.borrow_mut().take() {
            let _ = self
                .signal
                .remove_event_listener_with_callback("abort", listener.as_ref().unchecked_ref());
        }
        for controller in self.controllers.borrow().iter() {
            controller.abort();
        }
        self.controllers.borrow_mut().clear();
        self.swallow_rejection(self.writer.close());
    }
}

/// `class StreamingResponse extends Response` — status is always 200, even when
/// nothing is ever written. The app's CORS middleware runs afterwards and
/// overwrites `Access-Control-Allow-Origin` whenever an `Origin` was sent.
fn sse_response(readable: web_sys::ReadableStream) -> WorkerResult<Response> {
    let headers = worker::Headers::new();
    headers.set("Content-Type", "text/event-stream")?;
    headers.set("Cache-Control", "no-cache")?;
    headers.set("Connection", "keep-alive")?;
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Headers", "Cache-Control")?;
    Ok(Response::builder().with_status(200).with_headers(headers).stream(readable))
}

// ---------------------------------------------------------------------------
// One channel's subscription
// ---------------------------------------------------------------------------

/// `redis.subscribe([...])` opens one `POST /subscribe/<key>` per channel and
/// streams `type,channel,payload` lines back. `subscribe`, `message` and
/// `unsubscribe` each fan out to every listener registered on the subscriber —
/// which is why `on_subscribe` runs once per channel that confirms, not once
/// per stream.
async fn run_subscription(
    context: Rc<Context>,
    stream: Rc<Sse>,
    channel: String,
    signal: web_sys::AbortSignal,
) {
    let channel_key = format!("channel:{channel}");
    let url = format!("{}/subscribe/{}", context.base_url, channel_key);

    let headers = match rest_headers(&context.token) {
        Ok(headers) => headers,
        Err(error) => return on_error(&stream, &js_message(&error)),
    };
    // `mergeHeaders(this.headers, sseHeaders)` — the streaming command adds
    // these three on top of the client's own.
    let _ = headers.set("Accept", "text/event-stream");
    let _ = headers.set("Cache-Control", "no-cache");
    let _ = headers.set("Connection", "keep-alive");

    let response = match post(&url, &headers, "[]", Some(&signal)).await {
        Ok(response) => response,
        Err(error) => {
            // An abort is the client hanging up, not a failure to report.
            if !signal.aborted() {
                on_error(&stream, &js_message(&error));
            }
            return;
        }
    };
    if !response.ok() {
        on_error(&stream, &rest_error(&response, "[]").await);
        return;
    }

    let Some(body) = response.body() else { return };
    let reader: web_sys::ReadableStreamDefaultReader = body.get_reader().unchecked_into();

    // The REST client buffers the decoded text and splits on newlines; a line
    // break is never part of a multi-byte sequence, so buffering the bytes and
    // splitting on `\n` is the same thing without a streaming decoder.
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let result = match JsFuture::from(reader.read()).await {
            Ok(result) => result,
            Err(_) => break,
        };
        let done = js_sys::Reflect::get(&result, &JsValue::from_str("done"))
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if done {
            break;
        }
        let Ok(value) = js_sys::Reflect::get(&result, &JsValue::from_str("value")) else {
            break;
        };
        buffer.extend_from_slice(&Uint8Array::new(&value).to_vec());

        // The size guard is applied to what is left over after the split, and
        // before any complete line is handled.
        let carried = match buffer.iter().rposition(|byte| *byte == b'\n') {
            Some(index) => buffer.len() - index - 1,
            None => buffer.len(),
        };
        if carried > MAX_BUFFER_SIZE {
            break;
        }

        while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=index).take(index).collect();
            let line = String::from_utf8_lossy(&line).into_owned();
            if let Some(data) = line.strip_prefix("data: ") {
                handle_message(&context, &stream, data);
            }
        }
    }
    let _ = reader.cancel();
}

/// `Subscriber.handleMessage` — split `type,channel,payload` on the first two
/// commas, then dispatch by type. Dispatch is synchronous and the listeners are
/// not awaited, so a replay in flight never stalls the reader.
fn handle_message(context: &Rc<Context>, stream: &Rc<Sse>, data: &str) {
    let message_data = strip_data_prefix(data);

    let Some(first_comma) = message_data.find(',') else { return };
    let Some(second_comma) = message_data[first_comma + 1..].find(',').map(|i| i + first_comma + 1)
    else {
        return;
    };

    let kind = &message_data[..first_comma];
    let channel = &message_data[first_comma + 1..second_comma];
    let payload = &message_data[second_comma + 1..];

    match kind {
        // The subscribe acknowledgement for *any* channel replays the whole
        // channel list, because the library dispatches it to every listener.
        "subscribe" => spawn_local(on_subscribe(context.clone(), stream.clone())),
        "unsubscribe" => {
            for channel in &context.channels {
                stream.enqueue(&json!({ "type": "disconnected", "channel": channel }));
            }
            stream.cleanup();
        }
        "message" => {
            // `parseWithTryCatch`: JSON when it parses, the raw text otherwise.
            let message = serde_json::from_str::<Value>(payload)
                .unwrap_or_else(|_| Value::String(payload.to_string()));
            on_message(stream, channel, message);
        }
        // Every other type — the pattern variants included — reaches a
        // listener set that has nothing registered for it.
        _ => {}
    }
}

/// `data.replace(/^data:\s*/, '')` — the reader already stripped `data: `, so
/// this only bites on a line that carried the prefix twice.
fn strip_data_prefix(data: &str) -> &str {
    match data.strip_prefix("data:") {
        Some(rest) => rest.trim_start_matches(|c: char| c.is_whitespace()),
        None => data,
    }
}

/// `onMessage` — a ping is echoed as a ping frame; anything else is forwarded
/// as a user event. Keys absent from the payload stay absent from the frame,
/// because `JSON.stringify` drops `undefined`.
fn on_message(stream: &Rc<Sse>, redis_channel: &str, message: Value) {
    let channel = redis_channel.strip_prefix("channel:").unwrap_or(redis_channel);

    let payload = match message {
        Value::Object(map) => Value::Object(map),
        other => json!({ "data": other }),
    };

    if payload.get("type").and_then(Value::as_str) == Some("ping") {
        let mut frame = Map::new();
        frame.insert("type".into(), Value::String("ping".into()));
        if let Some(timestamp) = payload.get("timestamp") {
            frame.insert("timestamp".into(), timestamp.clone());
        }
        stream.enqueue(&Value::Object(frame));
        return;
    }

    let mut frame = Map::new();
    if let Some(data) = payload.get("data") {
        frame.insert("data".into(), data.clone());
    }
    if let Some(path) = payload.get("__event_path") {
        frame.insert("__event_path".into(), path.clone());
    }
    if let Some(id) = payload.get("__stream_id") {
        frame.insert("__stream_id".into(), id.clone());
    }
    frame.insert("__channel".into(), Value::String(channel.to_string()));
    stream.enqueue(&Value::Object(frame));
}

/// `onError` — a subscriber failure is reported on the stream, not by tearing
/// it down.
fn on_error(stream: &Rc<Sse>, message: &str) {
    stream.enqueue(&json!({ "type": "error", "error": message }));
}

/// `onSubscribe` — for every channel, in the order the query string gave them:
/// announce the connection and replay whatever the client missed.
async fn on_subscribe(context: Rc<Context>, stream: Rc<Sse>) {
    for channel in &context.channels {
        if let Err(error) = replay_channel(&context, &stream, channel).await {
            stream.enqueue(&json!({ "type": "error", "error": error }));
            return;
        }
    }
}

async fn replay_channel(context: &Context, stream: &Rc<Sse>, channel: &str) -> Result<(), String> {
    let channel_key = format!("channel:{channel}");

    if context.reconnect.as_deref() == Some("true") {
        if let Some(ack) = context.last_ack_for(channel) {
            // Resume from the last id the client acknowledged, exclusive.
            let start_id = format!("({ack}");
            let missing =
                xrange(&context.base_url, &context.token, &channel_key, &start_id, "+").await?;
            // No cursor on this path: the client already has one.
            stream.enqueue(&json!({ "type": "connected", "channel": channel }));
            for (id, entry) in &missing {
                stream.enqueue(&user_event(id, entry, channel));
            }
            return Ok(());
        }
    }

    // `??`, so an explicitly empty `connection_start` is honoured as empty.
    let connection_start = context
        .connection_start
        .clone()
        .unwrap_or_else(|| format!("{}", js::now_ms() as i64));

    let wants_history = truthy(&context.history_all)
        || truthy(&context.history_length)
        || truthy(&context.history_since);

    let history = if wants_history {
        let mut start = match &context.history_since {
            Some(since) if !since.is_empty() => since.clone(),
            _ => "-".to_string(),
        };
        // `history_length` truthy but unparseable still pushes a COUNT, whose
        // NaN argument serialises as JSON `null`.
        let count = match &context.history_length {
            Some(length) if !length.is_empty() => Some(
                js::parse_int_prefix(length)
                    .map(|value| Value::from(value))
                    .unwrap_or(Value::Null),
            ),
            _ => None,
        };
        if let Some(since) = &context.history_since {
            if !since.is_empty() {
                let since_ms = js::parse_int_prefix(since);
                let start_ms = js::parse_int_prefix(&connection_start);
                // A `since` in the future would replay nothing; clamp it to the
                // moment the connection opened.
                if let (Some(since_ms), Some(start_ms)) = (since_ms, start_ms) {
                    if since_ms > start_ms {
                        start = connection_start.clone();
                    }
                }
            }
        }
        xrevrange(&context.base_url, &context.token, &channel_key, "+", &start, count).await?
    } else {
        xrevrange(
            &context.base_url,
            &context.token,
            &channel_key,
            "+",
            &connection_start,
            None,
        )
        .await?
    };

    // XREVRANGE answers newest first, so the newest id is the cursor and the
    // replay runs the other way.
    let cursor = history.first().map(|(id, _)| id.clone()).unwrap_or_else(|| "0-0".to_string());
    stream.enqueue(&json!({ "type": "connected", "channel": channel, "cursor": cursor }));
    for (id, entry) in history.iter().rev() {
        stream.enqueue(&user_event(id, entry, channel));
    }
    Ok(())
}

/// A replayed stream entry, in the wire shape a live event uses.
fn user_event(id: &str, entry: &Map<String, Value>, channel: &str) -> Value {
    let mut frame = Map::new();
    if let Some(data) = entry.get("data") {
        frame.insert("data".into(), data.clone());
    }
    if let Some(path) = entry.get("__event_path") {
        frame.insert("__event_path".into(), path.clone());
    }
    frame.insert("__stream_id".into(), Value::String(id.to_string()));
    frame.insert("__channel".into(), Value::String(channel.to_string()));
    Value::Object(frame)
}

fn truthy(value: &Option<String>) -> bool {
    matches!(value, Some(text) if !text.is_empty())
}

// ---------------------------------------------------------------------------
// Redis commands
// ---------------------------------------------------------------------------

/// One emit: `XADD` (trimmed) + `EXPIRE` + `PUBLISH`, pipelined into a single
/// POST — the three commands the free-tier arithmetic in the original counts.
async fn publish_event(
    base_url: &str,
    token: &str,
    channel: &str,
    event: &str,
    data: &Value,
    id: &str,
) -> Result<(), String> {
    let channel_key = format!("channel:{channel}");
    let path_parts = Value::Array(
        event.split('.').map(|part| Value::String(part.to_string())).collect::<Vec<_>>(),
    );

    let commands = Value::Array(vec![
        Value::Array(vec![
            Value::String("XADD".into()),
            Value::String(channel_key.clone()),
            Value::String("MAXLEN".into()),
            Value::String("=".into()),
            Value::from(HISTORY_MAX_LENGTH),
            Value::String(id.to_string()),
            Value::String("data".into()),
            argument(data),
            Value::String("__event_path".into()),
            argument(&path_parts),
        ]),
        Value::Array(vec![
            Value::String("expire".into()),
            Value::String(channel_key.clone()),
            Value::from(HISTORY_EXPIRE_AFTER_SECS),
        ]),
        Value::Array(vec![
            Value::String("publish".into()),
            Value::String(channel_key),
            argument(&json!({
                "data": data,
                "__event_path": path_parts,
                "__stream_id": id,
            })),
        ]),
    ]);

    pipeline(base_url, token, &commands).await.map(|_| ())
}

/// The keepalive publish. Auto-pipelining is on by default in the REST client
/// and the original awaits each channel in turn, so every ping is its own
/// single-command pipeline request.
async fn publish_ping(base_url: &str, token: &str, channel: &str) -> Result<(), String> {
    let commands = Value::Array(vec![Value::Array(vec![
        Value::String("publish".into()),
        Value::String(format!("channel:{channel}")),
        argument(&json!({ "type": "ping", "timestamp": js::now_ms() as i64 })),
    ])]);
    pipeline(base_url, token, &commands).await.map(|_| ())
}

async fn xrange(
    base_url: &str,
    token: &str,
    key: &str,
    start: &str,
    end: &str,
) -> Result<Vec<(String, Map<String, Value>)>, String> {
    let command = Value::Array(vec![
        Value::String("XRANGE".into()),
        Value::String(key.to_string()),
        Value::String(start.to_string()),
        Value::String(end.to_string()),
    ]);
    stream_entries(command_result(base_url, token, &command).await?)
}

async fn xrevrange(
    base_url: &str,
    token: &str,
    key: &str,
    end: &str,
    start: &str,
    count: Option<Value>,
) -> Result<Vec<(String, Map<String, Value>)>, String> {
    let mut command = vec![
        Value::String("XREVRANGE".into()),
        Value::String(key.to_string()),
        Value::String(end.to_string()),
        Value::String(start.to_string()),
    ];
    if let Some(count) = count {
        command.push(Value::String("COUNT".into()));
        command.push(count);
    }
    stream_entries(command_result(base_url, token, &Value::Array(command)).await?)
}

/// `deserialize` for the stream commands: `[[id, [field, value, …]], …]` folded
/// into id → fields, each value JSON-parsed when it parses.
fn stream_entries(result: Value) -> Result<Vec<(String, Map<String, Value>)>, String> {
    let Value::Array(rows) = result else { return Ok(Vec::new()) };
    let mut out: Vec<(String, Map<String, Value>)> = Vec::new();
    for row in rows {
        let Value::Array(row) = row else { continue };
        let mut index = 0;
        while index + 1 < row.len() {
            let Some(stream_id) = row[index].as_str().map(str::to_string) else {
                index += 2;
                continue;
            };
            let Value::Array(fields) = &row[index + 1] else {
                index += 2;
                continue;
            };
            if !out.iter().any(|(id, _)| *id == stream_id) {
                out.push((stream_id.clone(), Map::new()));
            }
            let slot = out.iter_mut().find(|(id, _)| *id == stream_id).expect("just inserted");
            let mut field = 0;
            while field + 1 < fields.len() {
                if let Some(name) = fields[field].as_str() {
                    let raw = &fields[field + 1];
                    let parsed = raw
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .unwrap_or_else(|| raw.clone());
                    slot.1.insert(name.to_string(), parsed);
                }
                field += 2;
            }
            index += 2;
        }
    }
    Ok(out)
}

/// `defaultSerializer` — strings, numbers and booleans travel as themselves;
/// everything else is JSON text.
fn argument(value: &Value) -> Value {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
        other => Value::String(other.to_string()),
    }
}

/// `POST <base>/pipeline` with the commands as a JSON array of arrays.
/// The REST endpoint and token, when Redis is configured at all.
///
/// Exposed so the cache can sit on the same connection rather than growing a
/// second client with its own configuration and its own way of being absent.
pub fn upstash_rest(env: &Env) -> Option<(String, String)> {
    crate::env::upstash(env)
        .map(|(url, token)| (url.strip_suffix('/').unwrap_or(&url).to_string(), token))
}

/// Run Redis commands over the REST pipeline. Shared with `cache`.
pub async fn redis_pipeline(
    base_url: &str,
    token: &str,
    commands: &Value,
) -> Result<Value, String> {
    pipeline(base_url, token, commands).await
}

async fn pipeline(base_url: &str, token: &str, commands: &Value) -> Result<Value, String> {
    let body = commands.to_string();
    let url = format!("{base_url}/pipeline");
    let headers = rest_headers(token).map_err(|error| js_message(&error))?;

    let response = post(&url, &headers, &body, None).await.map_err(|error| js_message(&error))?;
    if !response.ok() {
        return Err(rest_error(&response, &body).await);
    }

    let parsed = response_json(&response).await?;
    // `exec()` without `keepErrors` throws on the first command that failed.
    if let (Value::Array(results), Value::Array(sent)) = (&parsed, commands) {
        for (index, entry) in results.iter().enumerate() {
            if let Some(error) = entry.get("error").filter(|value| !value.is_null()) {
                let name = sent
                    .get(index)
                    .and_then(|command| command.get(0))
                    .map(text_of)
                    .unwrap_or_default();
                return Err(format!(
                    "Command {} [ {} ] failed: {}",
                    index + 1,
                    name,
                    text_of(error)
                ));
            }
        }
    }
    Ok(parsed)
}

/// A single command, sent to the base URL with no path — which is how the REST
/// client sends the stream reads that auto-pipelining excludes.
async fn command_result(base_url: &str, token: &str, command: &Value) -> Result<Value, String> {
    let body = command.to_string();
    let headers = rest_headers(token).map_err(|error| js_message(&error))?;

    let response =
        post(base_url, &headers, &body, None).await.map_err(|error| js_message(&error))?;
    if !response.ok() {
        return Err(rest_error(&response, &body).await);
    }

    let parsed = response_json(&response).await?;
    if let Some(error) = parsed.get("error").filter(|value| !value.is_null()) {
        return Err(text_of(error));
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

/// The client asks for `Upstash-Encoding: base64`, so every string in a result
/// comes back base64 and has to be unwrapped before anything else looks at it.
async fn response_json(response: &web_sys::Response) -> Result<Value, String> {
    let raw = response_text(response).await;
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| parse_error(&raw))?;
    Ok(decode_base64_payload(parsed))
}

/// `decode()` from the REST client: results are base64, errors are not, and an
/// array is walked one level at a time.
fn decode_base64_payload(value: Value) -> Value {
    match value {
        Value::Array(entries) => {
            Value::Array(entries.into_iter().map(decode_envelope).collect())
        }
        Value::Object(mut map) => {
            let result = map.remove("result").map(decode_value).unwrap_or(Value::Null);
            let error = map.remove("error").unwrap_or(Value::Null);
            let mut out = Map::new();
            out.insert("result".into(), result);
            out.insert("error".into(), error);
            Value::Object(out)
        }
        other => other,
    }
}

fn decode_envelope(entry: Value) -> Value {
    match entry {
        Value::Object(mut map) => {
            let result = map.remove("result").map(decode_value).unwrap_or(Value::Null);
            let error = map.remove("error").unwrap_or(Value::Null);
            let mut out = Map::new();
            out.insert("result".into(), result);
            out.insert("error".into(), error);
            Value::Object(out)
        }
        other => other,
    }
}

fn decode_value(value: Value) -> Value {
    match value {
        Value::Number(number) => Value::Number(number),
        Value::Array(entries) => Value::Array(entries.into_iter().map(decode_element).collect()),
        Value::String(text) => {
            if text == "OK" {
                Value::String(text)
            } else {
                Value::String(base64_decode(&text))
            }
        }
        // `typeof null === 'object'` and it is not an array, so the client
        // answers null for anything else it is handed.
        _ => Value::Null,
    }
}

/// The arm inside `decode`'s array branch, which is deliberately *not* the same
/// as `decode` itself: at this depth a string is base64 unconditionally, and
/// only one level further down does the `"OK"` sentinel get honoured again.
fn decode_element(entry: Value) -> Value {
    match entry {
        Value::String(text) => Value::String(base64_decode(&text)),
        Value::Array(entries) => Value::Array(entries.into_iter().map(decode_value).collect()),
        other => other,
    }
}

/// `atob` then a UTF-8 read, falling back to the input when either fails —
/// which is exactly what `base64decode`'s `catch` does.
fn base64_decode(value: &str) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    // `atob` strips ASCII whitespace before it validates.
    let cleaned: Vec<u8> = value
        .bytes()
        .filter(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r'))
        .collect();
    let cleaned = match cleaned.split_at(cleaned.len().saturating_sub(2)) {
        (head, [b'=', b'=']) => head.to_vec(),
        (head, [rest @ .., b'=']) => [head, rest].concat(),
        _ => cleaned.clone(),
    };
    if cleaned.len() % 4 == 1 {
        return value.to_string();
    }

    let mut bits = 0u32;
    let mut count = 0u32;
    let mut out: Vec<u8> = Vec::with_capacity(cleaned.len() / 4 * 3);
    for byte in cleaned {
        let Some(index) = TABLE.iter().position(|candidate| *candidate == byte) else {
            return value.to_string();
        };
        bits = (bits << 6) | index as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push(((bits >> count) & 0xff) as u8);
        }
    }
    String::from_utf8(out).unwrap_or_else(|error| {
        String::from_utf8_lossy(error.as_bytes()).into_owned()
    })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// The headers the REST client sends on every request, in the order it builds
/// them. `upstash-sync-token` is empty because read-your-writes starts empty and
/// this Worker never reuses a client across requests.
fn rest_headers(token: &str) -> Result<web_sys::Headers, JsValue> {
    let headers = web_sys::Headers::new()?;
    headers.set("Content-Type", "application/json")?;
    headers.set("authorization", &format!("Bearer {token}"))?;
    headers.set("Upstash-Encoding", "base64")?;
    headers.set("Upstash-Telemetry-Runtime", &runtime_tag())?;
    headers.set("Upstash-Telemetry-Platform", "unknown")?;
    headers.set("Upstash-Telemetry-Sdk", &format!("@upstash/redis@{SDK_VERSION}"))?;
    headers.set("upstash-sync-token", "")?;
    Ok(headers)
}

/// `node@${process.version}` when `nodejs_compat` supplies a `process`, else
/// `unknown` — the same two answers the client's own probe produces here.
fn runtime_tag() -> String {
    let process = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("process"))
        .unwrap_or(JsValue::UNDEFINED);
    if process.is_object() {
        if let Ok(version) = js_sys::Reflect::get(&process, &JsValue::from_str("version")) {
            if let Some(version) = version.as_string() {
                if !version.is_empty() {
                    return format!("node@{version}");
                }
            }
        }
    }
    "unknown".to_string()
}

/// One POST with the configured retry policy: two attempts, 100 ms apart, and
/// only a thrown fetch is retried — a non-2xx answer is returned as-is.
async fn post(
    url: &str,
    headers: &web_sys::Headers,
    body: &str,
    signal: Option<&web_sys::AbortSignal>,
) -> Result<web_sys::Response, JsValue> {
    let init = web_sys::RequestInit::new();
    init.set_method("POST");
    init.set_headers(headers);
    init.set_body(&JsValue::from_str(body));
    if let Some(signal) = signal {
        init.set_signal(Some(signal));
    }

    let global: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    let mut last = JsValue::from_str("Exhausted all retries");
    for attempt in 0..=RETRY_ATTEMPTS {
        match JsFuture::from(global.fetch_with_str_and_init(url, &init)).await {
            Ok(value) => return Ok(value.unchecked_into()),
            Err(error) => {
                if signal.map(web_sys::AbortSignal::aborted).unwrap_or(false) {
                    return Err(error);
                }
                last = error;
                if attempt < RETRY_ATTEMPTS {
                    Delay::from(Duration::from_millis(RETRY_BACKOFF_MS)).await;
                }
            }
        }
    }
    Err(last)
}

async fn response_text(response: &web_sys::Response) -> String {
    match response.text() {
        Ok(promise) => JsFuture::from(promise)
            .await
            .ok()
            .and_then(|value| value.as_string())
            .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// `UpstashError` for a non-2xx answer, quoting the command that produced it.
async fn rest_error(response: &web_sys::Response, body: &str) -> String {
    let raw = response_text(response).await;
    match serde_json::from_str::<Value>(&raw) {
        Ok(parsed) => {
            let error = parsed.get("error").map(text_of).unwrap_or_else(|| "undefined".to_string());
            format!("{error}, command was: {body}")
        }
        Err(_) => parse_error(&raw),
    }
}

/// `UpstashJSONParseError`, including its 200-character truncation.
fn parse_error(raw: &str) -> String {
    let truncated = if raw.chars().count() > 200 {
        let head: String = raw.chars().take(200).collect();
        format!("{head}...")
    } else {
        raw.to_string()
    };
    format!("Unable to parse response body: {truncated}")
}

/// Template-literal stringification: a string is itself, anything else is its
/// JSON form.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn js_message(error: &JsValue) -> String {
    if let Some(text) = error.as_string() {
        return text;
    }
    js_sys::Reflect::get(error, &JsValue::from_str("message"))
        .ok()
        .and_then(|value| value.as_string())
        .unwrap_or_else(|| format!("{error:?}"))
}
