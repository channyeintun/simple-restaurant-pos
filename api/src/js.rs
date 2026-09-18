//! The few host primitives the port reaches for directly.
//!
//! Kept in one file so that "what this Worker asks the runtime for" is a short,
//! reviewable list rather than a `js_sys` call buried in a route.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = randomUUID)]
    fn crypto_random_uuid() -> String;
}

/// `crypto.randomUUID()` — lowercase hex with hyphens, v4.
pub fn random_uuid() -> String {
    crypto_random_uuid()
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    js_sys::Date::new_0().to_iso_string().into()
}

/// `new Date(ms).toISOString()`.
pub fn iso_of(ms: f64) -> String {
    js_sys::Date::new(&JsValue::from_f64(ms)).to_iso_string().into()
}

/// `Date.now()`, as the milliseconds every time helper here counts in.
pub fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// `Date.parse(iso)` — `NaN` when the string is not a date, which callers test
/// with `is_nan` exactly as the original tested `Number.isNaN`.
pub fn parse_date(iso: &str) -> f64 {
    js_sys::Date::parse(iso)
}

/// JavaScript's `parseInt(value, 10)`: leading whitespace skipped, an optional
/// sign, then as many digits as there are — `"600abc"` is 600, `"abc"` is NaN.
/// Returned as `None` where JavaScript would answer `NaN`.
pub fn parse_int_prefix(value: &str) -> Option<i64> {
    let text = value.trim_start();
    let mut chars = text.chars().peekable();
    let mut out = String::new();
    if matches!(chars.peek(), Some('+') | Some('-')) {
        out.push(chars.next().unwrap());
    }
    let mut digits = 0usize;
    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() {
            out.push(*c);
            chars.next();
            digits += 1;
        } else {
            break;
        }
    }
    if digits == 0 {
        return None;
    }
    out.parse::<i64>().ok()
}

/// JavaScript's `parseFloat(value)`, to the extent this Worker needs it: leading
/// whitespace, an optional sign, digits with an optional fractional part and an
/// optional exponent. `None` where JavaScript would answer `NaN`.
pub fn parse_float_prefix(value: &str) -> Option<f64> {
    let text = value.trim_start();
    let bytes = text.as_bytes();
    let mut end = 0usize;
    let mut seen_digit = false;
    let mut seen_dot = false;

    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_digit() {
            seen_digit = true;
            end += 1;
        } else if b == b'.' && !seen_dot {
            seen_dot = true;
            end += 1;
        } else {
            break;
        }
    }
    if !seen_digit {
        return None;
    }
    // An exponent only counts when it is followed by at least one digit.
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let mut probe = end + 1;
        if probe < bytes.len() && (bytes[probe] == b'+' || bytes[probe] == b'-') {
            probe += 1;
        }
        let exponent_start = probe;
        while probe < bytes.len() && bytes[probe].is_ascii_digit() {
            probe += 1;
        }
        if probe > exponent_start {
            end = probe;
        }
    }
    text[..end].parse::<f64>().ok()
}
