//! Bindings and the two numeric readers.
//!
//! Ported from `src/env.ts`. The Worker's environment arrives as a JS object;
//! these readers give it names and reproduce the original's fallbacks exactly,
//! including the `parseInt` / `parseFloat` semantics the defaults hang on.

use worker::{Env, Result as WorkerResult};

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

/// `Number.parseFloat(env.REMINDER_LEAD_HOURS ?? '')`, kept when finite and
/// positive, otherwise **3**. Fractional values are legal.
pub fn reminder_lead_hours(env: &Env) -> f64 {
    match var(env, "REMINDER_LEAD_HOURS").as_deref().and_then(js::parse_float_prefix) {
        Some(parsed) if parsed.is_finite() && parsed > 0.0 => parsed,
        _ => 3.0,
    }
}

pub fn db(env: &Env) -> WorkerResult<worker::d1::D1Database> {
    env.d1("DB")
}

pub fn proofs(env: &Env) -> WorkerResult<worker::Bucket> {
    env.bucket("PROOFS")
}

/// The Upstash pair, present only when **both** halves are set — which is what
/// decides whether realtime is enabled at all.
pub fn upstash(env: &Env) -> Option<(String, String)> {
    let url = truthy_var(env, "UPSTASH_REDIS_REST_URL")?;
    let token = truthy_var(env, "UPSTASH_REDIS_REST_TOKEN")?;
    Some((url, token))
}

/// The VAPID triple. Push is configured only when the key pair is present.
pub struct Vapid {
    pub public_key: String,
    pub private_key: String,
    pub subject: String,
}

pub fn vapid(env: &Env) -> Option<Vapid> {
    let public_key = truthy_var(env, "VAPID_PUBLIC_KEY")?;
    let private_key = truthy_var(env, "VAPID_PRIVATE_KEY")?;
    Some(Vapid {
        public_key,
        private_key,
        subject: truthy_var(env, "VAPID_SUBJECT").unwrap_or_default(),
    })
}
