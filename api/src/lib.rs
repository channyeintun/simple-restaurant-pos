//! Restaurant POS REST API — Cloudflare Workers, D1 + Upstash.
//!
//! A second app on the reference Worker's skeleton: the same `http.rs`,
//! `identity.rs`, `cors.rs`, `realtime.rs` and dispatcher shape, with a
//! restaurant's domain in place of a football pitch's. Where a file says it was
//! adapted rather than written, the thing it was adapted from is
//! <https://github.com/channyeintun/futsal-friday>.
//!
//! ## Why dispatch is written out rather than routed generically
//!
//! Because **the order below is the API**, not an implementation detail, and a
//! router that matched paths generically would hide the one thing about it
//! worth knowing: `require_device` is a line in the middle of this function,
//! and which side of it a route sits on is the whole of that route's
//! authentication story.
//!
//! Three consequences follow from the order, and all three are deliberate:
//!
//! - the unauthenticated routes never touch the gate. `/auth/claim` cannot —
//!   redeeming a claim link is how a tablet gets a credential in the first
//!   place — and `/realtime/*` cannot either, because `EventSource` will not
//!   send an `Authorization` header and the stream is authenticated by a ticket
//!   in the query string instead;
//! - a request to an unknown path still runs the gate, so an unauthenticated
//!   caller gets **401, not 404**. Somebody without a device credential cannot
//!   map this API by watching which paths answer differently;
//! - `OPTIONS` never reaches any of it. A preflight is answered before routing,
//!   before auth, and before anything can 404 it.
//!
//! There is no cron and there never should be. The reference had one for
//! reminders and cleanup; this app's only background actor is the printer
//! agent, which polls, and a `crons` trigger in `wrangler.jsonc` would be the
//! first thing to break the free-tier budget in `CLAUDE.md`.

mod base64;
mod cors;
mod db;
mod env;
mod http;
mod identity;
mod js;
mod middleware;
mod realtime;
mod routes;
mod validate;

use worker::{event, Context, Env, Method, Request, Response, Result as WorkerResult};

use crate::http::{ApiError, ApiResult};

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> WorkerResult<Response> {
    let cors = cors::Cors::read(&req, &crate::env::web_origin(&env));

    // 1. CORS. A preflight is answered here and goes no further: it never
    // reaches routing, never reaches `require_device`, and never 404s.
    if cors.is_preflight() {
        return cors.preflight();
    }

    let mut req = req;
    let response = match dispatch(&mut req, &env).await {
        Ok(response) => response,
        Err(error) => error.to_response()?,
    };
    cors.apply(response)
}

/// Everything after CORS, in the order it is reached.
async fn dispatch(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let path = req.path();

    // 2. `GET /health`. Unauthenticated because the thing asking is a deploy
    // script or an uptime check, and because "is this Worker up" is not a
    // question that should need a credential to answer.
    if req.method() == Method::Get && path == "/health" {
        return health(env).map_err(ApiError::from);
    }

    // 3. `/auth` — unauthenticated. `/auth/claim` is how a tablet gets a
    // credential, `/auth/logout` throws one away, and `/auth/me` asks for the
    // gate itself rather than inheriting it from here.
    if let Some(answer) = routes::auth::route(req, env).await {
        return answer;
    }

    // 4. `/realtime` — ticket-authenticated, because `EventSource` cannot send
    // an `Authorization` header. `/realtime/ticket` calls the gate itself and
    // hands out the two-minute ticket `/realtime/stream` verifies.
    if let Some(answer) = routes::realtime::route(req, env).await {
        return answer;
    }

    // 5. The device gate. It runs for every path that reaches here, including
    // paths no handler will match — which is why an unknown path answers 401
    // before it answers 404.
    //
    // `require_staff` is deliberately **not** here. A tablet with nobody signed
    // in is a normal state, not an error: it is the PIN screen, and the PIN
    // screen has to be able to read `GET /staff` to draw itself. Routes that
    // need a person name that gate themselves, one at a time, which is the
    // milestone-1 shape and not this one's.
    let identity = middleware::require_device(req, env).await?;

    // 6. `/staff` — the PIN screen's list, the two routes that move a person on
    // and off this tablet, and the roster an admin hires from.
    if let Some(answer) = routes::staff::route(req, env, &identity).await {
        return answer;
    }

    // 7. `/tables`, `/categories`, `/products` — the menu and the floor. Read
    // by anybody signed in, because a waiter's grid is drawn from them;
    // written by an admin alone.
    if let Some(answer) = routes::catalogue::route(req, env, &identity).await {
        return answer;
    }

    // 8. `/devices` — the tablet list and the claim links, admin throughout.
    // It sits after the catalogue rather than beside `/auth/claim` because
    // *minting* a link is an administrative act on a claimed device, while
    // *redeeming* one is how a device gets claimed in the first place; the two
    // are on opposite sides of the gate for that reason.
    if let Some(answer) = routes::devices::route(req, env, &identity).await {
        return answer;
    }

    // 9. `/reports` — the day's takings, and the whole of this app's reporting.
    if let Some(answer) = routes::reports::route(req, env, &identity).await {
        return answer;
    }

    // 10. Not found. The path, with no query string, so a 404 in a log does not
    // carry whatever was in the parameters.
    Err(http::not_found(format!("No route for {path}")))
}

/// `{ ok: true, realtime: <pubsub enabled>, time: <ISO now> }`, keys in that
/// order, `ok` always the literal `true`.
///
/// `realtime` is what makes this worth having beyond a liveness check: it says
/// whether the Upstash pair is configured, which is the difference between the
/// cashier's screen holding a stream open and falling back to a five-second
/// poll. Local development runs with neither credential on purpose, so the
/// honest answer there is `false`.
///
/// `time` is the server's own clock, which is the same thing the `X-Server-Now`
/// header carries on every response and is here so a check can see it without
/// reading headers.
fn health(env: &Env) -> WorkerResult<Response> {
    let body = serde_json::json!({
        "ok": true,
        "realtime": crate::env::upstash(env).is_some(),
        "time": http::now_iso(),
    });
    Response::from_json(&body)
}
