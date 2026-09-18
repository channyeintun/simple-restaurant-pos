//! The one error envelope.
//!
//! Copied from the reference Worker's `http.rs`, which ported it from
//! `src/http.ts` — the envelope, the constructors and the `worker::Error`
//! conversion are unchanged, and only the list of codes is this app's own.
//! Every failure this API reports is
//! `{"error":{"code":"…","message":"…"}}` — two keys, `code` before `message` —
//! and nothing else may leave the Worker with an error status.

use serde::Serialize;
use worker::{Response, Result as WorkerResult};

/// The closed set of codes this API answers with.
///
/// These are the strings that cross the wire; the web app matches on them, so
/// they are part of the API and not an implementation detail. The list is the
/// reference's minus the four that belonged to booking a football pitch, plus
/// the two rules this app has that a bare `conflict` or `unauthorized` would
/// leave the screen with nothing useful to say.
pub mod code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const FORBIDDEN: &str = "forbidden";
    pub const NOT_FOUND: &str = "not_found";
    pub const CONFLICT: &str = "conflict";
    /// The table already has an open check, which is the one conflict in this
    /// app a waiter can do something about: the screen says so by name and
    /// offers to open the existing check instead of starting a second one. The
    /// partial unique index in `0001_init.sql` is what actually settles the
    /// race between two waiters tapping Send on table 4 in the same second —
    /// this is how the loser of that race is told.
    pub const TABLE_BUSY: &str = "table_busy";
    /// Those four digits match nobody. It takes the place of the reference's
    /// `invalid_code`, which a bad invite code was answered with, and exists
    /// for the same reason: the PIN screen clears the keypad and stays where it
    /// is, whereas a plain `unauthorized` means the device credential is gone
    /// and the tablet has to go back to the claim screen — a different thing to
    /// do, needing a different person to do it.
    pub const BAD_PIN: &str = "bad_pin";
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

/// The blanket 403. `require_role` is its only caller, so the message answers
/// the question that gate asks: the caller is signed in as somebody, and that
/// somebody is not allowed to do this. "Organizers only" was the reference's
/// wording and is the one string in this file that could not be carried over.
pub fn forbidden_default() -> ApiError {
    forbidden("Your role does not allow that")
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
///
/// The prefixes in use are `stf_`, `dev_`, `tbl_`, `cat_`, `prd_`, `chk_`,
/// `rnd_`, `itm_`, `pay_` and `job_`. Nothing parses one — an id is an opaque
/// key everywhere in this app — so the prefix is for whoever is reading a log
/// line or a column of ids in a `wrangler d1` result and wants to know at a
/// glance what they are looking at.
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
