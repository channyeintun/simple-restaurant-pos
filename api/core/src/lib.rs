//! Types, validation and pure helpers shared between the Worker's routes.
//!
//! This is the Rust half of what `shared/` used to be. The other half is
//! `web/src/*.kite` — a TypeScript module cannot be imported by either Rust or
//! Kite, so the logic is written twice and both copies are held to the same
//! differential tests against the original.
//!
//! Nothing in this crate may depend on `worker`, `wasm-bindgen` or the host, so
//! that `cargo test` runs it natively.

pub mod announce;
pub mod attendance;
pub mod banks;
pub mod clock;
pub mod events;
pub mod i18n;
pub mod invite;
pub mod models;
pub mod money;
pub mod mvp;
pub mod names;
pub mod streak;
pub mod summary;
pub mod teams;
pub mod vietqr;
