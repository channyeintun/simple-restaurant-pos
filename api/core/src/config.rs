//! The two things the whole app has to agree on before it can draw anything:
//! how money is written, and what the clock on the wall says.
//!
//! The Rust twin of `shared/src/config.ts`. Both halves describe the same four
//! `wrangler.jsonc` vars — `CURRENCY_CODE`, `CURRENCY_SYMBOL`,
//! `CURRENCY_MINOR_DIGITS`, `TZ_OFFSET_MINUTES` — and the Worker is the single
//! source of truth for all four. `env.rs` reads them, `GET /auth/me` answers
//! with an [`AppConfig`] under `config`, and the client holds on to that
//! instead of mirroring the values as build-time `VITE_*` constants. There is
//! one copy, so it cannot drift; the long version of that argument is in
//! `config.ts` and is not repeated here.
//!
//! Which is also why [`crate::money::format_money`] and everything in
//! [`crate::clock`] take the currency and the offset as *parameters* rather
//! than closing over a constant: the twin tests then exercise the same
//! functions the Worker calls, with the currency written out in front of the
//! reader rather than compiled in.

use serde::{Deserialize, Serialize};

/// How amounts are written.
///
/// `minor_digits` is the interesting one: it is how many digits of the stored
/// integer are *below* the unit people say out loud. MMK has no circulating
/// subunit, so it is 0 and a minor unit is a kyat; USD would be 2 and a minor
/// unit a cent.
///
/// The field order is the JSON order — this struct is what `GET /auth/me`
/// serialises under `config.currency`, and `currencySchema` in `config.ts`
/// reads `code`, `symbol`, `minorDigits` in exactly this order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Currency {
    /// ISO 4217, e.g. `MMK`. Not rendered; it is what identifies the currency.
    pub code: String,
    /// What is printed beside an amount, e.g. `Ks`.
    pub symbol: String,
    /// Unsigned because it is an exponent: `10^minor_digits` is the scale, and
    /// a negative number of digits is not a thing a currency can have. `u32`
    /// specifically because that is what `i64::pow` takes, which keeps
    /// [`Currency::scale`] free of a cast that could be got wrong.
    pub minor_digits: u32,
}

impl Currency {
    /// The cap `currencySchema` enforces on the TypeScript side: no live
    /// currency has more than four minor digits.
    ///
    /// It is repeated here because the two sides validate in different places.
    /// The client parses `config` with zod and a bad value is refused at the
    /// boundary; the Worker builds this struct out of a var in `env.rs`, where
    /// there is no schema at all, so the cap has to be applied where the value
    /// is *used*. Without it a mistyped `CURRENCY_MINOR_DIGITS=20` would
    /// overflow the exponent in [`Currency::scale`] — a panic in the middle of
    /// service, from a typo in a config file, which is the one failure mode a
    /// till is least able to explain to the person standing at it.
    pub const MAX_MINOR_DIGITS: u32 = 4;

    pub fn new(code: impl Into<String>, symbol: impl Into<String>, minor_digits: u32) -> Self {
        Self { code: code.into(), symbol: symbol.into(), minor_digits }
    }

    /// How many minor units make one whole unit: 1 for MMK, 100 for a currency
    /// with cents. The one place `10^minor_digits` is computed, so the clamp
    /// above cannot be forgotten at a second call site.
    pub fn scale(&self) -> i64 {
        10i64.pow(self.minor_digits.min(Self::MAX_MINOR_DIGITS))
    }
}

/// Everything `GET /auth/me` hands back under `config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub currency: Currency,
    /// Minutes, not hours, and signed. Myanmar is UTC+06:30 — the half hour is
    /// exactly why this is not a count of hours — and the range any inhabited
    /// zone uses is UTC-12:00 to UTC+14:00, which is -720 to 840.
    pub tz_offset_minutes: i64,
}

/// What this restaurant is configured with, as `wrangler.jsonc` sets it.
pub const DEFAULT_CURRENCY_CODE: &str = "MMK";
pub const DEFAULT_CURRENCY_SYMBOL: &str = "Ks";
pub const DEFAULT_CURRENCY_MINOR_DIGITS: u32 = 0;
/// UTC+06:30. See [`crate::clock`] for why the offset is counted in minutes.
pub const DEFAULT_TZ_OFFSET_MINUTES: i64 = 390;

/// `DEFAULT_CONFIG` from `config.ts`, as far as Rust will allow: a `String`
/// cannot be built in a `const`, so the constant is an `impl Default` and the
/// values themselves are the four constants above.
///
/// It carries the same warning as its twin, and it matters more on this side.
/// **This is not a fallback for a missing var.** A Worker that cannot read
/// `CURRENCY_SYMBOL` is misconfigured, and a till that quietly decides the
/// currency for itself is worse than a till that refuses to start: the
/// difference between the two is a day's takings counted in the wrong money.
/// `env.rs` should report the missing var, not reach for this. What this is
/// for is the tests below and in `money.rs`, which need the deployment's real
/// currency spelled out rather than a plausible-looking placeholder.
impl Default for Currency {
    fn default() -> Self {
        Self::new(DEFAULT_CURRENCY_CODE, DEFAULT_CURRENCY_SYMBOL, DEFAULT_CURRENCY_MINOR_DIGITS)
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { currency: Currency::default(), tz_offset_minutes: DEFAULT_TZ_OFFSET_MINUTES }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_this_restaurants() {
        let config = AppConfig::default();
        assert_eq!(config.currency, Currency::new("MMK", "Ks", 0));
        assert_eq!(config.tz_offset_minutes, 390);
    }

    #[test]
    fn a_currency_without_a_subunit_scales_by_one() {
        assert_eq!(Currency::new("MMK", "Ks", 0).scale(), 1);
        assert_eq!(Currency::new("USD", "$", 2).scale(), 100);
    }

    /// The case the clamp exists for: a var nobody validated. It has no twin in
    /// `logic.test.ts` because zod refuses the value before `formatMoney` ever
    /// sees it, and this side has no zod.
    #[test]
    fn a_mistyped_var_cannot_overflow_the_exponent() {
        assert_eq!(Currency::new("XXX", "?", 20).scale(), 10_000);
    }

    /// The wire shape `GET /auth/me` promises, keys and order included.
    #[test]
    fn config_serialises_camel_case_in_declaration_order() {
        let json = serde_json::to_string(&AppConfig::default()).unwrap();
        assert_eq!(
            json,
            r#"{"currency":{"code":"MMK","symbol":"Ks","minorDigits":0},"tzOffsetMinutes":390}"#
        );
    }
}
