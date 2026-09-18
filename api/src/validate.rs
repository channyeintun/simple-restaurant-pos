//! Body validation, worded the way zod words it.
//!
//! `routes/staff.rs` explains the rule this file generalises: the client parses
//! every request body with the real schema from `shared/src/models.ts`, so the
//! Worker has to refuse exactly what that schema refuses **and say the same
//! thing about it**. A server that is merely stricter puts a message on screen
//! that the client's own validation would never have produced, next to a field
//! whose rules it does not quite share.
//!
//! Milestone 0 could hand-roll that for one schema with one field. Milestone 1
//! has nine bodies across four routers, so the checks live here instead: a
//! [`Body`] wrapping the parsed JSON, and one method per zod primitive, each
//! producing the string zod 4 produces. Every message in this file was taken
//! from zod 4.1 running the real schema — they are not reconstructions from the
//! documentation, and the tests at the bottom are what keeps them that way.
//!
//! ## First issue wins
//!
//! zod collects every issue and this reports the first, in the order the schema
//! declares its keys. That is the shape `routes/staff.rs` already answers with
//! and the shape the error envelope has room for — one `message`. It is also
//! the more useful half: a form that shows one error at the top and puts the
//! cursor in the field it names is a form somebody fixes, whereas a list of
//! four is a wall. So **the order the checks are written in a handler is part
//! of the contract**, and it must match the key order in the zod object.
//!
//! ## Lengths are counted in UTF-16 code units
//!
//! Because `String.prototype.length` is, and a product called `🍜 ramen` is 8
//! characters to a person, 8 scalar values to Rust, and 9 units to JavaScript.
//! A name that zod accepts and this refuses is the same bug as a name this
//! accepts and zod refuses, one field further along.

use serde_json::{Map, Value};
use worker::Request;

use crate::http::{self, ApiResult};

/* ------------------------------------------------------------------- rules */

/// A string field, as a zod chain declares one.
///
/// The fields are in chain order — `z.string().trim().min(n, msg).max(m)` — so
/// a rule reads against the schema it mirrors. `trim` runs before the length
/// checks because `.trim()` is a transform and sits before them in the chain,
/// which is why zod refuses `"   "` against `.trim().min(1)`.
pub struct Str {
    pub trim: bool,
    pub min: usize,
    pub max: usize,
    /// A custom message on a zod check **replaces** the default entirely, and
    /// loses the field prefix with it — `min(1, 'Table name is required')`
    /// renders as `name: Table name is required`, where the prefix is the path
    /// and not part of the message.
    pub min_message: Option<&'static str>,
}

impl Str {
    /// `idSchema` — `z.string().min(1).max(64)`. No trim: an id is not typed by
    /// a person, so whitespace in one is a bug in the caller rather than a
    /// stray keystroke to forgive.
    pub const ID: Self = Self { trim: false, min: 1, max: 64, min_message: None };

    /// A name somebody types into the backoffice: trimmed, non-empty, capped.
    /// The message is the schema's own, because every one of these has a custom
    /// one — "Table name is required" rather than "Too small".
    pub const fn name(max: usize, required: &'static str) -> Self {
        Self { trim: true, min: 1, max, min_message: Some(required) }
    }

    /// Free text that may be empty and is still trimmed and capped — an item's
    /// note, which is the only one in the app.
    pub const fn text(max: usize) -> Self {
        Self { trim: true, min: 0, max, min_message: None }
    }
}

/// An integer field: `z.number().int().min(a).max(b)`.
pub struct Int {
    pub min: i64,
    pub max: i64,
}

impl Int {
    /// `sortSchema`.
    pub const SORT: Self = Self { min: 0, max: 9_999 };
    /// `minorSchema`. The ceiling is not a business rule — a billion kyat is
    /// not a plausible line on a bill, which is the point.
    pub const MINOR: Self = Self { min: 0, max: 1_000_000_000 };
    /// `itemSchema.qty` — at least one, and no more than a table can eat.
    pub const QTY: Self = Self { min: 1, max: 99 };
}

/* -------------------------------------------------------------------- body */

/// Read the request body as JSON.
///
/// One message for both failures — an unreadable stream and unparseable text —
/// because the caller can do exactly the same thing about either, and because
/// `parseBody` on the client side draws the same line.
pub async fn read_json(req: &mut Request) -> ApiResult<Value> {
    let Ok(raw) = req.text().await else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    serde_json::from_str::<Value>(&raw).map_err(|_| http::bad_request("Expected a JSON body"))
}

/// A parsed object, ready to be read field by field.
#[derive(Debug)]
pub struct Body<'a> {
    object: &'a Map<String, Value>,
}

/// `z.object({…})` against something that is not one.
pub fn object(raw: &Value) -> ApiResult<Body<'_>> {
    match raw.as_object() {
        Some(object) => Ok(Body { object }),
        None => Err(http::bad_request(format!(
            "Invalid input: expected object, received {}",
            zod_type(raw)
        ))),
    }
}

impl Body<'_> {
    /// A required string.
    pub fn string(&self, key: &str, rule: &Str) -> ApiResult<String> {
        match self.opt_string(key, rule)? {
            Some(value) => Ok(value),
            // Absent is `undefined` to zod, which names it in the type issue
            // rather than reporting it as a separate kind of problem.
            None => Err(type_issue(key, "string", "undefined")),
        }
    }

    /// A string that may be absent. An explicit `null` is **not** absent: zod's
    /// `.optional()` admits `undefined` and nothing else, and JSON has no
    /// `undefined`, so a client that means "leave this alone" omits the key.
    pub fn opt_string(&self, key: &str, rule: &Str) -> ApiResult<Option<String>> {
        let Some(raw) = self.object.get(key) else {
            return Ok(None);
        };
        let Some(value) = raw.as_str() else {
            return Err(type_issue(key, "string", zod_type(raw)));
        };
        let value = if rule.trim { value.trim() } else { value };
        let length = value.encode_utf16().count();
        if length < rule.min {
            return Err(match rule.min_message {
                Some(message) => http::bad_request(format!("{key}: {message}")),
                None => http::bad_request(format!(
                    "{key}: Too small: expected string to have >={} characters",
                    rule.min
                )),
            });
        }
        if length > rule.max {
            return Err(http::bad_request(format!(
                "{key}: Too big: expected string to have <={} characters",
                rule.max
            )));
        }
        Ok(Some(value.to_string()))
    }

    /// A required integer.
    pub fn int(&self, key: &str, rule: &Int) -> ApiResult<i64> {
        match self.opt_int(key, rule)? {
            Some(value) => Ok(value),
            None => Err(type_issue(key, "number", "undefined")),
        }
    }

    /// An integer that may be absent.
    ///
    /// Three failures and three different messages, in zod's own order: not a
    /// number at all, a number that is not whole, and a whole number out of
    /// range. The middle one is the reason `as_i64` is not enough on its own —
    /// `4500.5` is a perfectly good JSON number and a perfectly bad price.
    pub fn opt_int(&self, key: &str, rule: &Int) -> ApiResult<Option<i64>> {
        let Some(raw) = self.object.get(key) else {
            return Ok(None);
        };
        let Some(number) = raw.as_f64() else {
            return Err(type_issue(key, "number", zod_type(raw)));
        };
        let Some(value) = raw.as_i64() else {
            // A float, or an integer too large for an `i64`. Both are "not an
            // int" to zod when they are not whole, and the second is caught by
            // the range check below in every case this app has — `minorSchema`
            // stops at a billion.
            return Err(if number.fract() == 0.0 {
                http::bad_request(format!("{key}: Too big: expected number to be <={}", rule.max))
            } else {
                http::bad_request(format!("{key}: Invalid input: expected int, received number"))
            });
        };
        if value < rule.min {
            return Err(http::bad_request(format!(
                "{key}: Too small: expected number to be >={}",
                rule.min
            )));
        }
        if value > rule.max {
            return Err(http::bad_request(format!(
                "{key}: Too big: expected number to be <={}",
                rule.max
            )));
        }
        Ok(Some(value))
    }

    /// A required member of a `z.enum`.
    pub fn enum_of(&self, key: &str, options: &[&str]) -> ApiResult<String> {
        match self.opt_enum(key, options)? {
            Some(value) => Ok(value),
            None => Err(enum_issue(key, options)),
        }
    }

    /// A member of a `z.enum` that may be absent.
    ///
    /// One message for every way of being wrong, which is zod's own behaviour
    /// and is right here too: `"boss"` and `3` are the same mistake, and the
    /// useful half of the answer is the list of things that would have worked.
    pub fn opt_enum(&self, key: &str, options: &[&str]) -> ApiResult<Option<String>> {
        let Some(raw) = self.object.get(key) else {
            return Ok(None);
        };
        match raw.as_str() {
            Some(value) if options.contains(&value) => Ok(Some(value.to_string())),
            _ => Err(enum_issue(key, options)),
        }
    }

    /// A boolean that may be absent — which is every boolean in this API, since
    /// the only one is `active` on a `PATCH`.
    pub fn opt_bool(&self, key: &str) -> ApiResult<Option<bool>> {
        let Some(raw) = self.object.get(key) else {
            return Ok(None);
        };
        match raw.as_bool() {
            Some(value) => Ok(Some(value)),
            None => Err(type_issue(key, "boolean", zod_type(raw))),
        }
    }

    /// True when the body carries nothing at all.
    ///
    /// Every `PATCH` in this app is a partial update built out of
    /// `COALESCE(?, column)`, so an empty body is a statement that sets each
    /// column to itself: valid SQL, a wasted write, and a 200 that tells the
    /// caller their request worked when it did nothing. zod has nothing to say
    /// about this — `{}` satisfies an all-optional object — so it is the one
    /// check here that is the Worker's own, and it answers 400 rather than
    /// pretending.
    pub fn is_empty(&self) -> bool {
        self.object.is_empty()
    }
}

/* ------------------------------------------------------------------ issues */

fn type_issue(key: &str, expected: &str, received: &str) -> http::ApiError {
    http::bad_request(format!("{key}: Invalid input: expected {expected}, received {received}"))
}

fn enum_issue(key: &str, options: &[&str]) -> http::ApiError {
    let rendered: Vec<String> = options.iter().map(|option| format!("\"{option}\"")).collect();
    http::bad_request(format!("{key}: Invalid option: expected one of {}", rendered.join("|")))
}

/// The names zod prints in `expected X, received Y`.
///
/// An array is its own name there rather than `object`, which is the one place
/// it differs from `typeof`. There is no `NaN` arm even though zod has one: a
/// JSON document cannot carry NaN, so nothing that arrives through
/// [`read_json`] can ever be it.
pub fn zod_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    fn message(result: ApiResult<impl std::fmt::Debug>) -> String {
        result.unwrap_err().message
    }

    /// Every string below was taken from zod 4.1 running the real schema
    /// against the real value. They are the contract, not an approximation of
    /// it, and a change to any of them is a change to the API.
    #[test]
    fn strings_are_refused_the_way_zod_refuses_them() {
        let raw = body(
            r#"{"n":5,"b":true,"nil":null,"arr":[],"obj":{},"blank":"   ","empty":"","long":"abcdef"}"#,
        );
        let it = object(&raw).unwrap();
        let name = Str::name(5, "Table name is required");

        assert_eq!(
            message(it.string("missing", &name)),
            "missing: Invalid input: expected string, received undefined"
        );
        assert_eq!(message(it.string("n", &name)), "n: Invalid input: expected string, received number");
        assert_eq!(message(it.string("b", &name)), "b: Invalid input: expected string, received boolean");
        assert_eq!(message(it.string("nil", &name)), "nil: Invalid input: expected string, received null");
        assert_eq!(message(it.string("arr", &name)), "arr: Invalid input: expected string, received array");
        assert_eq!(message(it.string("obj", &name)), "obj: Invalid input: expected string, received object");

        // `.trim()` is a transform and runs before `.min(1)`, so spaces are not
        // a one-character name.
        assert_eq!(message(it.string("blank", &name)), "blank: Table name is required");
        assert_eq!(
            message(it.string("long", &name)),
            "long: Too big: expected string to have <=5 characters"
        );
        // Without a custom message the default is zod's own wording. `Str::ID`
        // does not trim, so it takes a genuinely empty string to be too small —
        // three spaces are three characters to `idSchema`, which is right,
        // because nobody types an id.
        assert_eq!(
            message(it.string("empty", &Str::ID)),
            "empty: Too small: expected string to have >=1 characters"
        );
        assert_eq!(it.string("blank", &Str::ID).unwrap(), "   ");
    }

    #[test]
    fn a_trimmed_string_comes_back_trimmed() {
        let raw = body(r#"{"name":"  Table 4  "}"#);
        let it = object(&raw).unwrap();
        assert_eq!(it.string("name", &Str::name(20, "required")).unwrap(), "Table 4");
        // An id is not trimmed, because nobody typed it.
        assert_eq!(it.string("name", &Str::ID).unwrap(), "  Table 4  ");
    }

    /// The reason lengths are counted in UTF-16 units: a name that zod accepts
    /// and this refuses is a bug, and an astral character is where the two
    /// counts part company. `🍜` is one scalar value and two UTF-16 units.
    #[test]
    fn length_is_counted_the_way_javascript_counts_it() {
        let raw = body(r#"{"name":"🍜"}"#);
        let it = object(&raw).unwrap();
        assert!(it.string("name", &Str::name(2, "required")).is_ok());
        assert_eq!(
            message(it.string("name", &Str::name(1, "required"))),
            "name: Too big: expected string to have <=1 characters"
        );
    }

    #[test]
    fn integers_are_refused_the_way_zod_refuses_them() {
        let raw = body(r#"{"frac":1.5,"neg":-1,"big":10000,"str":"3","ok":7}"#);
        let it = object(&raw).unwrap();

        assert_eq!(
            message(it.int("missing", &Int::SORT)),
            "missing: Invalid input: expected number, received undefined"
        );
        assert_eq!(message(it.int("str", &Int::SORT)), "str: Invalid input: expected number, received string");
        assert_eq!(message(it.int("frac", &Int::SORT)), "frac: Invalid input: expected int, received number");
        assert_eq!(message(it.int("neg", &Int::SORT)), "neg: Too small: expected number to be >=0");
        assert_eq!(message(it.int("big", &Int::SORT)), "big: Too big: expected number to be <=9999");
        assert_eq!(it.int("ok", &Int::SORT).unwrap(), 7);
        // `minorSchema`'s own ceiling, which is the one a mistyped price hits.
        assert_eq!(
            message(it.int("big", &Int { min: 0, max: 9 })),
            "big: Too big: expected number to be <=9"
        );
    }

    #[test]
    fn enums_name_what_would_have_worked() {
        let raw = body(r#"{"role":"boss","n":3}"#);
        let it = object(&raw).unwrap();
        let roles = ["waiter", "cashier", "admin"];
        let expected = "Invalid option: expected one of \"waiter\"|\"cashier\"|\"admin\"";
        assert_eq!(message(it.enum_of("role", &roles)), format!("role: {expected}"));
        assert_eq!(message(it.enum_of("n", &roles)), format!("n: {expected}"));
        assert_eq!(message(it.enum_of("missing", &roles)), format!("missing: {expected}"));
    }

    #[test]
    fn booleans_and_absence() {
        let raw = body(r#"{"active":false,"wrong":"yes"}"#);
        let it = object(&raw).unwrap();
        assert_eq!(it.opt_bool("active").unwrap(), Some(false));
        assert_eq!(it.opt_bool("missing").unwrap(), None);
        assert_eq!(
            message(it.opt_bool("wrong")),
            "wrong: Invalid input: expected boolean, received string"
        );
    }

    /// An explicit `null` is not an omission. zod's `.optional()` admits
    /// `undefined`, JSON has no `undefined`, so a client that means "leave this
    /// alone" leaves the key out.
    #[test]
    fn null_is_a_value_and_not_an_omission() {
        let raw = body(r#"{"name":null,"sort":null}"#);
        let it = object(&raw).unwrap();
        assert_eq!(
            message(it.opt_string("name", &Str::ID)),
            "name: Invalid input: expected string, received null"
        );
        assert_eq!(
            message(it.opt_int("sort", &Int::SORT)),
            "sort: Invalid input: expected number, received null"
        );
    }

    #[test]
    fn the_object_itself_has_to_be_one() {
        assert_eq!(
            message(object(&body("5"))),
            "Invalid input: expected object, received number"
        );
        assert_eq!(
            message(object(&body("null"))),
            "Invalid input: expected object, received null"
        );
        assert_eq!(
            message(object(&body(r#""x""#))),
            "Invalid input: expected object, received string"
        );
        assert_eq!(message(object(&body("[]"))), "Invalid input: expected object, received array");
    }

    #[test]
    fn an_empty_patch_is_recognisable() {
        assert!(object(&body("{}")).unwrap().is_empty());
        assert!(!object(&body(r#"{"active":true}"#)).unwrap().is_empty());
    }

    /// Unknown keys are stripped rather than rejected, which is zod's default
    /// and the behaviour a client relies on when it sends a whole object back.
    #[test]
    fn unknown_keys_are_ignored() {
        let raw = body(r#"{"name":"Bar","somethingElse":1}"#);
        let it = object(&raw).unwrap();
        assert_eq!(it.string("name", &Str::name(20, "required")).unwrap(), "Bar");
    }
}
