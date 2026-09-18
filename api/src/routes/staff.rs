//! Who is standing at the tablet.
//!
//! The second half of the credential. `routes/auth.rs` gets a device in; this
//! file puts a person on it and takes them off again, both by re-minting the
//! same token with the staff claim added or left out. Nothing here is stored: a
//! shift change writes no row, because the only thing that changes is what the
//! token says.
//!
//! There is no equivalent of this in the reference, which had one claim and one
//! kind of caller. What it is modelled on is the shape of the problem rather
//! than a file: a tablet by the pass is picked up by three people over a shift,
//! and the kitchen ticket has to say which of them took the order.
//!
//! Every path here has already been through `require_device` in `lib.rs`, so a
//! caller who reaches this file is holding a tablet an admin claimed. That is
//! what makes `GET /staff` safe to answer with nobody signed in — it is the PIN
//! screen's own list, readable on a claimed device and nowhere else.
//!
//! **A 4-digit PIN is not a security boundary against outsiders and nothing
//! here describes it as one.** Ten thousand possibilities is an afternoon. The
//! device cookie is what keeps strangers out; the PIN tells Aung from Su on a
//! device they share.

use serde_json::Value;
use worker::d1::D1Database;
use worker::{Env, Method, Request, Response};

use crate::db;
use crate::http::{self, ApiResult};
use crate::identity;
use crate::middleware::Identity;
use crate::routes::auth;

/// `None` when nothing here matches, so the dispatcher can go on — which, since
/// this is the last router, means the 404.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let mut segments = path.split('/').skip(1);
    if segments.next() != Some("staff") {
        return None;
    }
    let action = segments.next();
    if segments.next().is_some() {
        return None;
    }

    // `/staff/` splits to a single empty segment, which matches neither action
    // and is not `/staff` either. It 404s, the same as `/staff/anything-else`.
    match (req.method(), action) {
        (Method::Get, None) => Some(list(env).await),
        (Method::Post, Some("switch")) => Some(switch(req, env, identity).await),
        (Method::Post, Some("signout")) => Some(signout(env, identity).await),
        _ => None,
    }
}

/// The names on the PIN screen, in alphabetical order.
///
/// Three columns — id, name, role — and `pin_hash` is not one of them. That is
/// enforced in the statement rather than here: `db::list_staff` names the
/// columns it wants, so the hash does not come back from the database and there
/// is no struct on this side that could carry it. It never appears in a
/// response, a log line or an event payload, and this is the route it would
/// leak from if it ever did, because it is the one a tablet can call with
/// nobody signed in.
///
/// The body is the array itself rather than `{ staff: [...] }`. The reference
/// wrapped its lists because they were paginated and the wrapper had a cursor
/// to hold; this one has nothing to say about the list except the list — a
/// restaurant has a dozen members of staff — and `shared/src/models.ts` types
/// it as `z.array(staffNameSchema)` to match.
async fn list(env: &Env) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let staff = db::list_staff(&db_handle).await?;
    Ok(Response::from_json(&staff)?)
}

/// Sign somebody in on this tablet: four digits in, a new token out.
///
/// The route is given only the PIN. There is no "pick your name first" step,
/// deliberately — that is two taps at a counter with a queue at it — so the
/// digits are the identifier, and resolving them means computing
/// `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` for every active member of staff
/// and seeing which one lands. `identity::pin_hash` explains why the id is in
/// the message; the consequence here is that this is a scan, and it is a scan
/// of about a dozen rows.
async fn switch(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    let pin = parse_body(req).await?;

    let db_handle = crate::env::db(env)?;
    let secret = crate::env::auth_secret(env);
    let candidates = db::staff_for_pin(&db_handle).await?;

    // Every row is tested and the loop does not stop at the first match.
    //
    // A `break` would be the obvious thing to write and would make this route
    // answer faster for a member of staff near the front of the list than for
    // one near the back — over a few hundred attempts, that difference is
    // readable, and what it reads out is the position of a person in a list
    // whose names are published by the route above. Walking the whole list
    // costs a dozen HMACs, which is microseconds, and makes the time a wrong
    // PIN takes indistinguishable from the time a right one takes.
    //
    // (A *successful* switch does go on to do two more reads, so success and
    // failure are still tellable apart. That is not worth hiding: the status
    // code says which it was.)
    //
    // The `is_none()` keeps the first match rather than the last, and is there
    // so that finding one does not change what the rest of the loop does. Two
    // matches cannot happen anyway — the staff id is inside the hashed message,
    // so the same four digits produce a different hash for every person — and
    // if SHA-256 ever produced two, the first row is as arbitrary a choice as
    // any other.
    let mut matched: Option<&db::StaffPinRow> = None;
    for candidate in &candidates {
        // Computed for every row before anything is decided, so that the `if`
        // below cannot short-circuit the work it is deciding about.
        let is_theirs = identity::verify_pin(&secret, &candidate.id, &pin, &candidate.pin_hash)?;
        if is_theirs && matched.is_none() {
            matched = Some(candidate);
        }
    }
    let Some(matched) = matched else {
        return Err(bad_pin());
    };

    // The name and the role, which `staff_for_pin` deliberately did not fetch —
    // it reads two columns, both of which stay in this function, so that the
    // hash is never in a struct that something else might serialize. One more
    // statement, on a tap that happens a handful of times a shift.
    let Some(staff) = db::get_staff_by_id(&db_handle, &matched.id).await? else {
        return Err(bad_pin());
    };

    let (next, credential) = mint(env, &db_handle, identity, Some(staff)).await?;
    auth::credential_response(&credential, &next)
}

/// End a shift: the same device token, re-minted without the staff claim.
///
/// This is a person putting the tablet down, not a tablet being taken out of
/// service, which is why the device claim survives it. The next person picks it
/// up, taps four digits, and is signed in — no admin, no link, no walk to the
/// counter. Cutting a tablet off is `token_version`, bumped from the
/// backoffice, and it is a different operation on purpose.
///
/// It answers with a token rather than with `{ ok: true }` because there is
/// nothing to delete: the staff claim lives inside the token, so removing it
/// means issuing a new one. A client that threw the old token away instead
/// would be signing the *device* out too.
async fn signout(env: &Env, identity: &Identity) -> ApiResult<Response> {
    let db_handle = crate::env::db(env)?;
    let (next, credential) = mint(env, &db_handle, identity, None).await?;
    auth::credential_response(&credential, &next)
}

/// Re-mint this device's token with `staff` on it, or with nobody on it.
///
/// The device half is copied from the identity the gate already resolved; only
/// the staff half moves. The `token_version` is read again rather than carried
/// on [`Identity`], and that is a deliberate cost: the revocation counter is
/// the middleware's business and a route has no use for it, so it is not in the
/// struct every route receives. Minting a token is the one thing that needs it,
/// and it needs the *current* value — a token signed with a stale version would
/// be rejected by `require_device` on the very next request, which is a bug
/// that would look like "the tablet signs itself out at random".
async fn mint(
    env: &Env,
    db_handle: &D1Database,
    identity: &Identity,
    staff: Option<db::Staff>,
) -> ApiResult<(Identity, identity::IssuedCredential)> {
    let Some(device) = db::get_device_by_id(db_handle, &identity.device_id).await? else {
        // Between the gate and here, somebody deleted the row. Vanishingly
        // unlikely and worth answering honestly: the same message the gate
        // itself gives, so the tablet does the same thing it would have done a
        // moment earlier.
        return Err(http::unauthorized("This device is no longer registered."));
    };

    // The three staff fields move together or stay absent together, the same
    // rule `require_device` follows: there is no state in which a name is known
    // and an id is not.
    let (staff_id, staff_name, role) = match staff {
        Some(staff) => (Some(staff.id), Some(staff.name), Some(staff.role)),
        None => (None, None, None),
    };
    let next = Identity {
        device_id: identity.device_id.clone(),
        device_name: identity.device_name.clone(),
        staff_id,
        staff_name,
        role,
    };

    let credential = identity::issue(&next, device.token_version, env).await?;
    Ok((next, credential))
}

/// 401 with `bad_pin`, and a message that says nothing about which part was
/// wrong.
///
/// 401 rather than 403 even though the device credential is fine, because the
/// caller is not authenticated *as a person* and that is what the status means.
/// The code is what carries the difference: `http.rs` explains it at the
/// constant — a plain `unauthorized` sends the tablet back to the claim screen,
/// which needs an admin, whereas `bad_pin` clears the keypad and stays where it
/// is, which needs the person already standing there to try again.
///
/// The message does not distinguish "no such PIN" from "that person has left",
/// for the same reason `/auth/claim` has one message for three failures: the
/// difference is not actionable by whoever is holding the tablet, and stating
/// it would confirm that a particular four digits used to belong to somebody.
fn bad_pin() -> http::ApiError {
    http::ApiError::new(401, http::code::BAD_PIN, "That PIN does not match anybody here.")
}

/* --------------------------------------------------------- body validation */

/// `parseBody(c.req.raw, staffSwitchSchema)`, written out — the same
/// hand-rolled zod that `routes/auth.rs` does, for the same reason: the client
/// parses with the real schema, so the server has to refuse exactly what the
/// schema refuses and word it identically.
async fn parse_body(req: &mut Request) -> ApiResult<String> {
    let raw = match req.text().await {
        Ok(text) => serde_json::from_str::<Value>(&text),
        Err(_) => return Err(http::bad_request("Expected a JSON body")),
    };
    let Ok(raw) = raw else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    validate(&raw)
}

/// `staffSwitchSchema` — `z.object({ pin: pinSchema })`, where `pinSchema` is
/// `z.string().regex(/^\d{4}$/, 'A PIN is 4 digits')`.
///
/// The regex is worth reading carefully, because the PIN's length is load
/// bearing somewhere else entirely. `identity::pin_hash` concatenates the staff
/// id and the PIN with no separator, and that is unambiguous *only* because the
/// PIN is always exactly four characters. Widen this to `{4,6}` and two
/// different pairs can produce the same message.
///
/// `\d` in a JavaScript regexp without the `u` flag is ASCII `0-9` and nothing
/// else — Arabic-Indic digits are not digits here — and `$` without `m` matches
/// only at the very end of the string, so a trailing newline is a failure
/// rather than something to forgive.
fn validate(raw: &Value) -> ApiResult<String> {
    let Some(object) = raw.as_object() else {
        return Err(http::bad_request(format!(
            "Invalid input: expected object, received {}",
            zod_type(raw)
        )));
    };
    let pin = match object.get("pin") {
        Some(Value::String(pin)) => pin,
        // An absent key is `undefined`, which zod names rather than skips.
        other => {
            return Err(http::bad_request(format!(
                "pin: Invalid input: expected string, received {}",
                other.map_or("undefined", zod_type)
            )))
        }
    };

    // The byte length and the character length are the same number once every
    // byte is an ASCII digit, so one test covers both.
    if pin.len() != 4 || !pin.bytes().all(|byte| byte.is_ascii_digit()) {
        // A custom message on a zod check replaces the default entirely, so
        // this is the whole issue text and the prefix is `validate`'s doing.
        return Err(http::bad_request("pin: A PIN is 4 digits"));
    }
    Ok(pin.clone())
}

/// The names zod prints in `expected X, received Y`. An array is its own name
/// there rather than `object`, which is the one place it differs from `typeof`.
fn zod_type(value: &Value) -> &'static str {
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

    fn message(json: &str) -> String {
        validate(&serde_json::from_str(json).unwrap()).unwrap_err().message
    }

    /// Every string here was taken from zod 4.4.3 running the real schema.
    #[test]
    fn reports_the_first_issue_the_way_zod_words_it() {
        assert_eq!(message("{}"), "pin: Invalid input: expected string, received undefined");
        assert_eq!(
            message(r#"{"pin":null}"#),
            "pin: Invalid input: expected string, received null"
        );
        // The commonest mistake a client makes here: sending the keypad's digits
        // as a number, which also loses a leading zero on the way.
        assert_eq!(
            message(r#"{"pin":1234}"#),
            "pin: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(r#"{"pin":[]}"#),
            "pin: Invalid input: expected string, received array"
        );

        assert_eq!(message(r#"{"pin":""}"#), "pin: A PIN is 4 digits");
        assert_eq!(message(r#"{"pin":"123"}"#), "pin: A PIN is 4 digits");
        assert_eq!(message(r#"{"pin":"12345"}"#), "pin: A PIN is 4 digits");
        assert_eq!(message(r#"{"pin":"12 4"}"#), "pin: A PIN is 4 digits");
        assert_eq!(message(r#"{"pin":"12a4"}"#), "pin: A PIN is 4 digits");
        // `$` without the `m` flag does not match before a trailing newline.
        assert_eq!(message("{\"pin\":\"1234\\n\"}"), "pin: A PIN is 4 digits");
        // `\d` without the `u` flag is ASCII, so these Arabic-Indic digits fail
        // the character class in zod. They are four characters and twelve
        // bytes, so on this side the byte-length test happens to reject them
        // first — a different route to the same one message, which is the only
        // thing either side promises.
        assert_eq!(message(r#"{"pin":"١٢٣٤"}"#), "pin: A PIN is 4 digits");

        // The object's own failure has an empty path, so no prefix.
        assert_eq!(message(r#""1234""#), "Invalid input: expected object, received string");
        assert_eq!(message("null"), "Invalid input: expected object, received null");
    }

    #[test]
    fn accepts_what_the_schema_accepts() {
        let ok = |json: &str| validate(&serde_json::from_str(json).unwrap()).unwrap();
        assert_eq!(ok(r#"{"pin":"1234"}"#), "1234");
        // A leading zero survives, which is the whole reason the PIN is a
        // string on the wire.
        assert_eq!(ok(r#"{"pin":"0000"}"#), "0000");
        assert_eq!(ok(r#"{"pin":"0007"}"#), "0007");
        // Unknown keys are stripped, not rejected.
        assert_eq!(ok(r#"{"pin":"4321","staffId":"stf_admin"}"#), "4321");
    }

    /// The failure the PIN screen is built around.
    #[test]
    fn says_nothing_about_who_the_pin_did_not_match() {
        let error = bad_pin();
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "bad_pin");
        assert_eq!(error.message, "That PIN does not match anybody here.");
    }
}
