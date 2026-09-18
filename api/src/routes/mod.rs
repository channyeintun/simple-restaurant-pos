//! The routers, one module per file of `src/routes/`.
//!
//! Each exposes `route(...) -> Option<ApiResult<Response>>`: `None` means this
//! router does not claim the path, so the dispatcher tries the next one in the
//! order Hono would have. That is what keeps registration order — which is
//! load-bearing here — visible in `lib.rs` rather than buried in a matcher.

pub mod auth;
pub mod claims;
pub mod members;
pub mod payment_details;
pub mod payments;
pub mod push;
pub mod realtime;
pub mod sessions;
pub mod uploads;
pub mod venues;
