//! The realtime endpoints: a short-lived ticket, and the SSE stream it opens.
//!
//! Adapted from the reference Worker's `routes/realtime.rs`, which ported it
//! from `src/routes/realtime.ts`. The wire format, the keepalive and the
//! reconnect timer live in `src/realtime.rs` behind `PubSub::subscribe`; what is
//! here is the ticket exchange and the channel allowlist.
//!
//! One stream exists in this app and one page opens it. `CLAUDE.md` spends a
//! table on why: `@upstash/realtime` publishes a keepalive every ten seconds per
//! open connection, which is 360 Redis commands an hour that nothing outside the
//! library can turn down. The cashier's screen is worth that — somebody is
//! standing at it waiting for a table's total to change. Waiter tablets are not,
//! because a waiter has just caused the change they are looking at, and the
//! printer agent is not, because it polls.

use serde_json::json;
use worker::{Env, Request, Response};

use crate::http::{self, ApiResult};
use crate::identity;
use crate::middleware;
use crate::realtime::create_pub_sub;

/// `RESTAURANT_CHANNEL` from `shared/src/events.ts`: the only channel there is.
///
/// One restaurant, one room, one cashier. Every event in the catalogue is about
/// the floor as a whole and the one client that listens wants all six of them,
/// so splitting by table or by check would multiply the keepalive cost by the
/// number of subscriptions to deliver exactly the same set of messages.
pub const RESTAURANT_CHANNEL: &str = "restaurant";

/// The most channels one stream may hold open.
///
/// One, because there is one channel. Each is a Redis subscription and a
/// keepalive publish every ten seconds, so this is a cost ceiling as much as an
/// authorization one — and with a single legal channel, a request naming four
/// of them is either a bug or somebody trying it on, and neither should be
/// answered by opening four subscriptions.
const MAX_CHANNELS: usize = 1;

/// `/realtime`, mounted **before** the device gate in `lib.rs` — so neither
/// handler passes through `require_device` on the way in, and `/ticket` calls it
/// itself.
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
    // `require_device` and deliberately not `require_staff`. The stream carries
    // no prose and nothing addressed to a person — every event on it is a fact
    // about the floor, which the tablet by the till is entitled to know because
    // an admin claimed it. Requiring a PIN would mean the cashier's screen went
    // blank the moment somebody signed out at the end of a shift, and came back
    // only when the next person remembered to sign in.
    let caller = middleware::require_device(req, env).await?;

    let pubsub = create_pub_sub(env);
    Ok(Response::from_json(&json!({
        "ticket": identity::issue_sse_ticket(env, &caller).await?,
        "enabled": pubsub.enabled(),
    }))?)
}

/// The SSE stream itself. Authenticated by ticket rather than by the device
/// gate, and therefore mounted ahead of it.
async fn stream(req: &Request, env: &Env) -> ApiResult<Response> {
    let ticket = query_first(req, "ticket")?;
    // A missing ticket and an empty one both fail verification. Who the holder
    // is never matters after this line — the ticket's job is to prove that a
    // claimed tablet asked for the stream, and there is one channel, which every
    // claimed tablet may watch.
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

    // A fresh client rather than the request-scoped one, and the **original**
    // request rather than a rebuilt one: the stream's teardown hangs off
    // `request.signal`, and a copy would not be aborted when the client leaves.
    let pubsub = create_pub_sub(env);
    let borrowed: Vec<&str> = channels.iter().map(String::as_str).collect();
    Ok(pubsub.subscribe(req, &borrowed).await?)
}

/// The allowlist: `restaurant`, and nothing else.
///
/// It is still a function, it is still called before anything is subscribed to,
/// and it still has tests, even though it has collapsed to one string
/// comparison. The reason it exists has not changed and does not depend on how
/// many channels are legal: whatever arrives in `channels` is attacker-supplied
/// text on its way to being a Redis key, and this is the line that stops a
/// crafted value naming one of somebody else's. A `==` written inline in
/// `stream` would be the same check today and would be the first thing dropped
/// the day a second channel is added — which is the day it starts to matter
/// again.
fn is_subscribable(channel: &str) -> bool {
    channel == RESTAURANT_CHANNEL
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
    fn accepts_the_one_channel_there_is() {
        assert!(is_subscribable("restaurant"));
        assert!(is_subscribable(RESTAURANT_CHANNEL));
    }

    /// The near misses, which are the cases worth having a test for: a client
    /// that gets the name slightly wrong should be told so, and a caller that
    /// gets it deliberately wrong should get nowhere.
    #[test]
    fn refuses_anything_that_could_name_another_redis_key() {
        assert!(!is_subscribable(""));
        assert!(!is_subscribable("Restaurant"));
        assert!(!is_subscribable("restaurant "));
        assert!(!is_subscribable(" restaurant"));
        assert!(!is_subscribable("restaurants"));
        assert!(!is_subscribable("restaurant:1"));
        assert!(!is_subscribable("restaurant*"));
        assert!(!is_subscribable("channel:restaurant"));
        // A trailing newline is not whitespace to be forgiven; it is a
        // different key.
        assert!(!is_subscribable("restaurant\n"));
    }
}
