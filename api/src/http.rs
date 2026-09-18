//! The one error envelope.
//!
//! Ported from `src/http.ts`. Every failure this API reports is
//! `{"error":{"code":"…","message":"…"}}` — two keys, `code` before `message` —
//! and nothing else may leave the Worker with an error status.

use serde::Serialize;
use worker::{Response, Result as WorkerResult};

/// The closed set of codes the original `ApiErrorCode` union allowed.
///
/// These are the strings that cross the wire; the web app matches on them, so
/// they are part of the API and not an implementation detail.
pub mod code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const INVALID_CODE: &str = "invalid_code";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const FORBIDDEN: &str = "forbidden";
    pub const NOT_FOUND: &str = "not_found";
    pub const CONFLICT: &str = "conflict";
    pub const PAYLOAD_TOO_LARGE: &str = "payload_too_large";
    pub const REGISTRATION_CLOSED: &str = "registration_closed";
    pub const SESSION_FULL: &str = "session_full";
    pub const INTERNAL: &str = "internal";
    /// Not in the original union, but `createDisabledPubSub` emits it verbatim.
    pub const REALTIME_DISABLED: &str = "realtime_disabled";
}

#[derive(Serialize)]
struct Envelope<'a> {
    error: Body<'a>,
}

#[derive(Serialize)]
struct Body<'a> {
    code: &'a str,
    message: &'a str,
}

/// A failure carrying the status, code and message it will be rendered with.
///
/// The original threw `HTTPException` with a pre-built JSON response, and
/// `onError` returned that response untouched. Here the failure travels as a
/// value and is rendered at the edge of `dispatch`, which is the same thing
/// without the throw.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.to_string(), message: message.into() }
    }

    /// Render the envelope. `Response::from_json` sets `application/json`, which
    /// is what `Response.json` did.
    pub fn to_response(&self) -> WorkerResult<Response> {
        let body = Envelope { error: Body { code: &self.code, message: &self.message } };
        Ok(Response::from_json(&body)?.with_status(self.status))
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

pub fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::new(400, code::BAD_REQUEST, message)
}

pub fn bad_request_with(message: impl Into<String>, code: &str) -> ApiError {
    ApiError::new(400, code, message)
}

pub fn unauthorized_default() -> ApiError {
    unauthorized("Sign in first")
}

pub fn unauthorized(message: impl Into<String>) -> ApiError {
    ApiError::new(401, code::UNAUTHORIZED, message)
}

pub fn forbidden_default() -> ApiError {
    forbidden("Organizers only")
}

pub fn forbidden(message: impl Into<String>) -> ApiError {
    ApiError::new(403, code::FORBIDDEN, message)
}

pub fn not_found_default() -> ApiError {
    not_found("Not found")
}

pub fn not_found(message: impl Into<String>) -> ApiError {
    ApiError::new(404, code::NOT_FOUND, message)
}

pub fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(409, code::CONFLICT, message)
}

pub fn conflict_with(message: impl Into<String>, code: &str) -> ApiError {
    ApiError::new(409, code, message)
}

/// `internal` — the only failure the original produced without being asked to.
pub fn internal() -> ApiError {
    ApiError::new(500, code::INTERNAL, "Something went wrong on our side")
}

/// A D1 or host failure that the original would have let bubble to `onError`.
impl From<worker::Error> for ApiError {
    fn from(error: worker::Error) -> Self {
        worker::console_error!("Unhandled error {:?}", error);
        internal()
    }
}

/// `newId(prefix)` — prefix, one underscore, then the first 20 hex characters of
/// a v4 UUID with its hyphens removed.
pub fn new_id(prefix: &str) -> String {
    let uuid = crate::js::random_uuid();
    let flat: String = uuid.chars().filter(|c| *c != '-').take(20).collect();
    format!("{prefix}_{flat}")
}

/// `nowIso()` — `YYYY-MM-DDTHH:MM:SS.sssZ`, always UTC, always three digits of
/// milliseconds, exactly as `Date.prototype.toISOString` writes it.
pub fn now_iso() -> String {
    crate::js::iso_now()
}

/// `new Date(ms).toISOString()`.
pub fn iso_of(ms: f64) -> String {
    crate::js::iso_of(ms)
}
