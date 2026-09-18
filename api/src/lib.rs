//! Futsal Friday REST API — Cloudflare Workers, D1 + R2 + Upstash.
//!
//! Ported from the Hono + TypeScript Worker, route for route. The API is
//! unchanged: same paths, same methods, same status codes, same JSON.
//!
//! ## Why dispatch is written out rather than routed generically
//!
//! Hono's `route()` copies a sub-app's entries — middleware included — into the
//! parent in registration order. Because `protectedRoutes` was mounted last,
//! its two `ALL /*` auth middlewares land *after* `/health`, `/auth/*`,
//! `/realtime/*` and the group-join routes, and *before* the not-found handler.
//! Three observable consequences follow, and all three are part of the API:
//!
//! - the unauthenticated routes never touch auth, because their handler answers
//!   without calling `next()`;
//! - a request to an unknown path still matches the two `ALL /*` middlewares, so
//!   an unauthenticated caller gets **401, not 404**, and an unapproved one gets
//!   403;
//! - `OPTIONS` never reaches any of it.
//!
//! `dispatch` below is that order, spelled out. A generic router would have to
//! be taught the same thing, and would hide it.

mod base64;
mod cache;
mod cors;
mod cron;
mod db;
mod env;
mod http;
mod identity;
mod js;
mod middleware;
mod notifications;
mod push;
mod realtime;
mod routes;

use worker::{
    event, Context, Env, Method, Request, Response, Result as WorkerResult, ScheduleContext,
    ScheduledEvent,
};

use crate::http::{ApiError, ApiResult};

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> WorkerResult<Response> {
    let cors = cors::Cors::read(&req, &crate::env::web_origin(&env));

    // 1. `corsMiddleware()` — a preflight is answered here and goes no further.
    // It never reaches routing, never reaches `requireMember`, and never 404s.
    if cors.is_preflight() {
        return cors.preflight();
    }

    let mut req = req;
    let response = match dispatch(&mut req, &env, &ctx).await {
        Ok(response) => response,
        Err(error) => error.to_response()?,
    };
    cors.apply(response)
}

/// Everything after CORS, in the order Hono would have reached it.
async fn dispatch(req: &mut Request, env: &Env, ctx: &Context) -> ApiResult<Response> {
    let path = req.path();

    // 2. `pubsubMiddleware()` — one PubSub per request. It is built where it is
    // used; `/health` only asks whether it is enabled, which is a property of
    // the environment rather than of the connection.

    // 3. `GET /health`
    if req.method() == Method::Get && path == "/health" {
        return health(env).map_err(ApiError::from);
    }

    // 4. `/auth` — unauthenticated: the invite gate and the name picker.
    if let Some(answer) = routes::auth::route(req, env).await {
        return answer;
    }

    // 5. `/realtime` — ticket-authenticated, because `EventSource` cannot send
    // an `Authorization` header.
    if let Some(answer) = routes::realtime::route(req, env).await {
        return answer;
    }

    // 6. The group join link — unauthenticated by necessity, since it is how
    // people get a credential in the first place. Every restriction is enforced
    // in its SQL.
    // The organizers are notified of the request after the response goes out,
    // which is why this one needs the execution context.
    if let Some(answer) = routes::claims::route_group_join(req, env, ctx).await {
        return answer;
    }

    // 7. `protectedRoutes`. Both middlewares run for every path that reaches
    // here, including paths no handler will match — which is why an unknown
    // path answers 401 before it answers 404.
    let identity = middleware::require_member(req, env).await?;
    middleware::require_approved(&identity)?;

    let method = req.method().to_string();
    let path = req.path();

    if let Some(answer) = routes::members::route(&method, &path, &identity, req, env).await {
        return answer;
    }
    if let Some(answer) = routes::venues::route(req, env, &identity).await {
        return answer;
    }
    if let Some(answer) = routes::sessions::route(req, env, &identity).await {
        return answer;
    }
    // Payment routes declare their own full paths (`/sessions/:id/settle`,
    // `/payments/:id/review`) because they straddle both resources.
    if let Some(answer) = routes::payments::route(req, env, &identity).await {
        return answer;
    }
    if let Some(answer) = routes::uploads::route(req, env, &identity).await {
        return answer;
    }
    if let Some(answer) = routes::push::route(req, env, &identity).await {
        return answer;
    }
    // Declares full paths (`/members/:id/claim-link`, `/auth/my-device-link`),
    // and the group invite alongside them.
    if let Some(answer) = routes::claims::route(req, env, &identity).await {
        return answer;
    }
    if let Some(answer) = routes::payment_details::route(req, env, &identity).await {
        return answer;
    }

    // 8. `notFound` — `c.req.path` verbatim, no query string.
    Err(http::not_found(format!("No route for {path}")))
}

/// `{ ok: true, realtime: <pubsub enabled>, time: <ISO now> }`, keys in that
/// order, `ok` always the literal `true`.
fn health(env: &Env) -> WorkerResult<Response> {
    let body = serde_json::json!({
        "ok": true,
        "realtime": crate::env::upstash(env).is_some(),
        "time": http::now_iso(),
    });
    Response::from_json(&body)
}

/// The cron trigger. The `ScheduledController` is ignored, exactly as it was:
/// `runScheduledMaintenance` uses its own clock rather than `event.scheduledTime`.
///
/// `wait_until` is what keeps the Worker alive for the realtime emits that
/// follow the database writes, which would otherwise be cancelled when the
/// handler returns.
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, ctx: ScheduleContext) {
    ctx.wait_until(async move {
        if let Err(error) = cron::run_scheduled_maintenance(&env).await {
            worker::console_error!("Scheduled maintenance failed {:?}", error);
        }
    });
}
