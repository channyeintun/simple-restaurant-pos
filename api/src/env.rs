//! Bindings, and the readers that give the environment types.
//!
//! Copied from the reference Worker's `env.rs`, which ported it from
//! `src/env.ts`. The Worker's environment arrives as a JS object; these readers
//! give it names and reproduce the original's fallbacks exactly, including the
//! `parseInt` semantics the defaults hang on.
//!
//! What is new here is the currency and the clock. `wrangler.jsonc` `vars` is
//! the single source of truth for both, and the web app learns them from
//! `GET /auth/me` rather than from a mirrored `VITE_*` value — so this file is
//! the only place the four are read, and [`app_config`] is the only place they
//! are assembled into the object that answer carries.

use worker::{Env, Result as WorkerResult};

use pos_core::config::{AppConfig, Currency};

use crate::js;

/// Read a `vars` entry or a secret. Absent is `None`, never an error, because
/// every caller here treats absence as "not configured".
pub fn var(env: &Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|v| v.to_string()).or_else(|| env.secret(name).ok().map(|v| v.to_string()))
}

/// Absent, or present and empty, both count as "not set" — the original tested
/// these with plain truthiness.
pub fn truthy_var(env: &Env, name: &str) -> Option<String> {
    var(env, name).filter(|v| !v.is_empty())
}

pub fn web_origin(env: &Env) -> String {
    var(env, "WEB_ORIGIN").unwrap_or_default()
}

pub fn app_url(env: &Env) -> String {
    var(env, "APP_URL").unwrap_or_default()
}

pub fn auth_secret(env: &Env) -> String {
    var(env, "AUTH_SECRET").unwrap_or_default()
}

/// `Number.parseInt(env.SSE_MAX_DURATION_SECS ?? '', 10)`, kept when finite and
/// positive, otherwise **600**.
pub fn sse_max_duration_secs(env: &Env) -> i64 {
    match var(env, "SSE_MAX_DURATION_SECS").as_deref().and_then(js::parse_int_prefix) {
        Some(parsed) if parsed > 0 => parsed,
        _ => 600,
    }
}

/* -------------------------------------------------- currency and the clock */

/// ISO 4217, e.g. `MMK`. Nothing prints it — [`currency_symbol`] is what goes
/// beside an amount — but it is what says which currency this restaurant takes.
///
/// Unset reads as the empty string rather than as a guess, and that is
/// deliberate: the client parses this with `appConfigSchema`, whose `code` is
/// `z.string().length(3)`, so a Worker deployed without the var makes the tablet
/// refuse the config outright instead of quietly pricing a menu in a currency
/// nobody chose. `shared/src/config.ts` puts it plainly — a till that decides
/// the currency for itself is worse than a till that shows nothing.
pub fn currency_code(env: &Env) -> String {
    var(env, "CURRENCY_CODE").unwrap_or_default()
}

/// What is printed beside an amount, e.g. `Ks`. Empty when unset, for the same
/// reason the code is: `appConfigSchema` wants at least one character, so the
/// tablet says the config is wrong rather than handing a customer a bill with
/// bare numbers on it.
pub fn currency_symbol(env: &Env) -> String {
    var(env, "CURRENCY_SYMBOL").unwrap_or_default()
}

/// `Number.parseInt(env.CURRENCY_MINOR_DIGITS ?? '', 10)`, kept when it parses
/// to something a `u32` can hold, otherwise **0**.
///
/// How many digits of the stored integer sit below the unit people say out
/// loud: 0 for MMK, where a minor unit is a kyat and the integers in the
/// database are the numbers on the bill; 2 for a currency with cents.
///
/// `u32` because it is an exponent, for the reasons
/// [`pos_core::config::Currency`] gives at the field — so a negative var cannot
/// survive the read and lands on the default. A number too *large* is passed
/// through rather than corrected here: `Currency::scale` clamps it where it is
/// used, so nothing overflows, and the client refuses a config outside 0–4
/// outright, which is how anybody finds out the var is wrong. Rewriting it
/// quietly here would fix the symptom in the one place nobody is looking.
///
/// The **0** default is this restaurant's own value, and defaulting at all is
/// only safe because the code and symbol above default to nothing: a Worker
/// that has lost its currency vars cannot render kyat-shaped anything else,
/// because it cannot render a currency at all.
pub fn currency_minor_digits(env: &Env) -> u32 {
    var(env, "CURRENCY_MINOR_DIGITS")
        .as_deref()
        .and_then(js::parse_int_prefix)
        .and_then(|parsed| u32::try_from(parsed).ok())
        .unwrap_or(0)
}

/// `Number.parseInt(env.TZ_OFFSET_MINUTES ?? '', 10)`, kept when it parses,
/// otherwise **390** — UTC+06:30, Myanmar.
///
/// Minutes rather than hours because half an hour does not fit in a count of
/// hours, and a fixed offset rather than a timezone database because there is
/// one restaurant, it does not move, and nothing near it observes DST. A
/// leading `-` parses, so a deployment west of UTC is one var away.
///
/// The default is this deployment's own offset and not 0. UTC is the tidier
/// looking fallback and the worse one: every timestamp would still render, six
/// and a half hours out, and the service day would roll over in the middle of
/// dinner — wrong in the way a rounding error is wrong rather than in the way a
/// missing var is.
pub fn tz_offset_minutes(env: &Env) -> i64 {
    var(env, "TZ_OFFSET_MINUTES").as_deref().and_then(js::parse_int_prefix).unwrap_or(390)
}

/// The `config` half of `GET /auth/me`: everything a tablet has to know before
/// it can draw a price or a clock.
///
/// It is assembled in one function so the four vars are read together, and it
/// is served on the session bootstrap rather than baked into the frontend build
/// so there is exactly one copy of them. A build-time mirror would be a second
/// source of truth living inside an installed PWA, changing when the service
/// worker felt like it rather than when the Worker was deployed — and the day
/// the two disagreed, the tablet would be quoting a price the bill does not
/// charge.
pub fn app_config(env: &Env) -> AppConfig {
    AppConfig {
        currency: Currency {
            code: currency_code(env),
            symbol: currency_symbol(env),
            minor_digits: currency_minor_digits(env),
        },
        tz_offset_minutes: tz_offset_minutes(env),
    }
}

/* ------------------------------------------------------------ the bindings */

pub fn db(env: &Env) -> WorkerResult<worker::d1::D1Database> {
    env.d1("DB")
}

/// The Upstash pair, present only when **both** halves are set — which is what
/// decides whether realtime is enabled at all.
pub fn upstash(env: &Env) -> Option<(String, String)> {
    let url = truthy_var(env, "UPSTASH_REDIS_REST_URL")?;
    let token = truthy_var(env, "UPSTASH_REDIS_REST_TOKEN")?;
    Some((url, token))
}
