//! The routers, one module per group of paths.
//!
//! Each exposes `route(...) -> Option<ApiResult<Response>>`: `None` means this
//! router does not claim the path, so the dispatcher tries the next one in the
//! order `lib.rs` lists them. That is what keeps registration order — which is
//! load-bearing here, because the device gate sits between two of these lines —
//! visible in one screen of `lib.rs` rather than buried in a matcher.
//!
//! `None` also covers a path a router owns with a method it does not, which is
//! how an unmatched request reaches the gate and answers 401 rather than 404.

pub mod auth;
pub mod realtime;
pub mod staff;
