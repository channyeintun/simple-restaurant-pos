//! The pure rules of the till, in the Worker's language.
//!
//! This is the Rust half of `shared/`: the same money arithmetic and the same
//! fixed-offset clock the browser runs, written a second time because Rust
//! cannot import a TypeScript module and the Worker is where a check is totalled
//! and a kitchen ticket is stamped.
//!
//! What keeps the two halves honest is that they are held to **the same
//! numbers**. Every case in `shared/test/logic.test.ts` has a named `#[test]`
//! here with the same inputs and the same expected value, written out rather
//! than computed, and the handful of cases that exist on one side only say in a
//! comment why. A rule that changes has to change in two places and prove itself
//! twice; a case added on one side and not the other is how the bill and the
//! till start to disagree — quietly, weeks later, in front of a customer.
//!
//! Only rules live here, not plumbing. Routes, D1, tokens and the realtime seam
//! are `api/src/`'s; anything in this crate is something a person could be shown
//! on paper and asked whether it is right. Totals and the kitchen ticket join
//! money and the clock: `totals.rs` and `ticket.rs`.
//!
//! Nothing in this crate may depend on `worker`, `wasm-bindgen` or the host, so
//! that `cargo test` runs it natively — on the machine, in under a second, with
//! no wasm target and no `wrangler dev`. That constraint is the reason the tests
//! above are worth writing at all: a differential suite nobody can run in a loop
//! is a differential suite that stops being run.

pub mod clock;
pub mod config;
pub mod money;
pub mod ticket;
pub mod totals;
