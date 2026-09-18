//! The realtime endpoints: a short-lived ticket, and the SSE stream it opens.
//!
//! Ported from `src/routes/realtime.ts`. The wire format, the keepalive and the
//! reconnect timer live in `src/realtime.rs` behind `PubSub::subscribe`; what is
//! here is the ticket exchange and the channel allowlist.

use serde_json::json;
use worker::{Env, Request, Response};

use crate::http::{self, ApiResult};
use crate::identity;
use crate::middleware;
use crate::realtime::create_pub_sub;

/// `LOBBY_CHANNEL` from `shared/src/events.ts`: the one channel that is not a
/// session.
const LOBBY_CHANNEL: &str = "lobby";

/// The most channels one stream may hold open. Each is a Redis subscription and
/// a keepalive publish every ten seconds, so this is a cost ceiling as much as
/// an authorization one.
const MAX_CHANNELS: usize = 4;

/// `realtimeRoutes`, mounted at `/realtime` **outside** `protectedRoutes` — so
/// neither handler passes through `requireApproved`, and `/ticket` carries its
/// own `requireMember`.
///
/// The method is read off the raw request rather than through
/// `Request::method()`, which folds every verb the `worker` crate does not know
/// onto `GET` — `QUERY` among them, and the CORS preflight advertises it.
pub async fn route(req: &mut Request, env: &Env) -> Option<ApiResult<Response>> {
    match (req.inner().method().as_str(), req.path().as_str()) {
        ("POST", "/realtime/ticket") => Some(ticket(req, env).await),
        ("GET", "/realtime/stream") => Some(stream(req, env).await),
        _ => None,
    }
}

/// Trade the long-lived session token for a two-minute stream ticket.
///
/// `EventSource` cannot send an `Authorization` header, so the credential has to
/// travel in the query string, where it may end up in logs. A ticket that
/// expires in two minutes and can do nothing but open a stream is a much safer
/// thing to leave lying around than a 90-day token.
async fn ticket(req: &Request, env: &Env) -> ApiResult<Response> {
    // Route-level `requireMember()`, and deliberately not `requireApproved()`:
    // somebody still in the waiting room needs the stream to hear that they
    // have been let in.
    let caller = middleware::require_member(req, env).await?;

    let pubsub = create_pub_sub(env);
    Ok(Response::from_json(&json!({
        "ticket": identity::issue_sse_ticket(env, &caller).await?,
        "enabled": pubsub.enabled(),
    }))?)
}

/// The SSE stream itself. Authenticated by ticket rather than by the usual
/// middleware, and therefore mounted outside the protected router.
async fn stream(req: &Request, env: &Env) -> ApiResult<Response> {
    let ticket = query_first(req, "ticket")?;
    // A missing ticket and an empty one both fail verification. Who the holder
    // is never matters after this line — the ticket's job is to prove that
    // somebody signed in asked for the stream, and every member may watch every
    // channel that passes the format check below.
    if identity::verify_sse_ticket(env, ticket.as_deref()).await?.is_none() {
        return Err(http::unauthorized("Stream ticket is missing or expired"));
    }

    let channels = query_all(req, "channels")?;
    if channels.is_empty() {
        return Err(http::bad_request("Subscribe to at least one channel"));
    }
    if channels.len() > MAX_CHANNELS {
        return Err(http::bad_request("Too many channels"));
    }

    let denied: Vec<&str> = channels
        .iter()
        .map(String::as_str)
        .filter(|channel| !is_subscribable(channel))
        .collect();
    if !denied.is_empty() {
        return Err(http::bad_request(format!("Not subscribable: {}", denied.join(", "))));
    }

    // Every member can see every session, so passing the format check is the
    // whole authorization story today. The check stays because it is what stops
    // a crafted `channels` value from reaching arbitrary Redis keys.
    //
    // A fresh client rather than the request-scoped one, and the **original**
    // request rather than a rebuilt one: the stream's teardown hangs off
    // `request.signal`, and a copy would not be aborted when the client leaves.
    let pubsub = create_pub_sub(env);
    let borrowed: Vec<&str> = channels.iter().map(String::as_str).collect();
    Ok(pubsub.subscribe(req, &borrowed).await?)
}

/// `/^session:[A-Za-z0-9_-]{1,64}$/`, or the lobby. Only these shapes may be
/// subscribed to; anything else is rejected outright.
fn is_subscribable(channel: &str) -> bool {
    if channel == LOBBY_CHANNEL {
        return true;
    }
    let Some(id) = channel.strip_prefix("session:") else {
        return false;
    };
    // The quantifier counts characters, and every character the class admits is
    // one byte, so a length in bytes is the same answer.
    (1..=64).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `c.req.query(name)` — the first occurrence, form-decoded.
fn query_first(req: &Request, name: &str) -> ApiResult<Option<String>> {
    let url = req.url()?;
    Ok(url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()))
}

/// `c.req.queries(name) ?? []` — every occurrence, in the order the query string
/// wrote them. Absent is an empty list, which the caller answers with a 400.
fn query_all(req: &Request, name: &str) -> ApiResult<Vec<String>> {
    let url = req.url()?;
    Ok(url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_lobby_and_well_formed_session_channels() {
        assert!(is_subscribable("lobby"));
        assert!(is_subscribable("session:a"));
        assert!(is_subscribable("session:ses_0123456789abcdef0123"));
        assert!(is_subscribable(&format!("session:{}", "a".repeat(64))));
    }

    #[test]
    fn refuses_anything_that_could_name_another_redis_key() {
        assert!(!is_subscribable(""));
        assert!(!is_subscribable("Lobby"));
        assert!(!is_subscribable("lobby "));
        assert!(!is_subscribable("session:"));
        assert!(!is_subscribable(&format!("session:{}", "a".repeat(65))));
        assert!(!is_subscribable("session:a/b"));
        assert!(!is_subscribable("session:a:b"));
        assert!(!is_subscribable("session:a*"));
        assert!(!is_subscribable("channel:session:a"));
        // `$` in a JavaScript regexp without the `m` flag does not match before
        // a trailing newline, so this stays out.
        assert!(!is_subscribable("session:a\n"));
        assert!(!is_subscribable("session:é"));
    }
}
