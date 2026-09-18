//! Getting in.
//!
//! There is exactly one way: open the claim link an admin minted for this
//! tablet. There is no sign-up, no password, and no list of devices to pick
//! yourself out of.
//!
//! Adapted from the reference Worker's `routes/auth.rs`, which ported it from
//! `src/routes/auth.ts`. The reference had already thrown away a group-wide
//! invite code plus "pick who you are", and the reasons it gives transfer
//! intact and get stronger: anybody holding a shared code could claim to be
//! anybody, and a code that lives in a chat thread never really expires. Here
//! the holder is a tablet rather than a person, which removes the escalation
//! entirely — a claim link names one device, is spent the first time it is
//! opened, and can be reissued for that device without disturbing any other.
//!
//! What a claim produces is a token with the device claim and **no staff
//! claim**: a tablet that has just been set up has nobody standing at it, which
//! is the PIN screen. `POST /staff/switch` is what adds the second half, and
//! `routes/staff.rs` is where that lives.
//!
//! Nothing here is behind the device gate except `/auth/me`, which asks for it
//! itself. `/auth/claim` cannot be — it is how a device gets a credential in the
//! first place — and `/auth/logout` throws one away, which needs no proof that
//! it was valid.

use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{Env, Method, Request, Response};

use pos_core::config::AppConfig;

use crate::db;
use crate::http::{self, ApiResult};
use crate::identity;
use crate::middleware::{self, Identity};

/// `None` when nothing here matches, so the dispatcher can go on to the next
/// router. A path this file owns but with the wrong method is also `None`, and
/// that is deliberate rather than an oversight: `GET /auth/claim` falls through
/// to `require_device` in `lib.rs` and comes back **401, not 404**, because a
/// caller with no credential should not be able to map this API by watching
/// which paths answer differently.
pub async fn route(req: &mut Request, env: &Env) -> Option<ApiResult<Response>> {
    match (req.method(), req.path().as_str()) {
        (Method::Post, "/auth/claim") => Some(claim(req, env).await),
        (Method::Get, "/auth/me") => Some(me(req, env).await),
        (Method::Post, "/auth/logout") => Some(logout()),
        _ => None,
    }
}

/// Redeem a link. The nonce is looked up directly — the row is the proof — and
/// cleared in the same statement, so a forwarded link is worthless once the
/// first tablet has opened it.
async fn claim(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let nonce = parse_body(req).await?;
    let timestamp = http::now_iso();

    let db_handle = crate::env::db(env)?;
    let row = db::get_device_by_claim_nonce(&db_handle, &nonce, &timestamp).await?;

    // One message for "wrong", "expired" and "already used": distinguishing
    // them would tell a stranger which of those a value happens to be, and
    // there is nothing any of the three answers would let an honest person do
    // that "ask for a new one" does not.
    let Some(row) = row else {
        return Err(spent_link());
    };

    // Spend it, guarded on the nonce so that two simultaneous opens cannot both
    // win. The read above and this update are not one operation, and a claim
    // link gets opened twice within a second more often than it sounds like it
    // would — a double tap on a tablet, or a page reloaded while the first
    // request was still in flight. Both would find the row; only one can change
    // it, and the other is told the link is spent, which it now is.
    //
    // `COALESCE` keeps the first `claimed_at` rather than overwriting it, so
    // re-issuing a link for a tablet that is already set up — what an admin
    // does after a device has been wiped — leaves the date it entered service
    // alone. A second date for the same tablet is a worse answer to "when did
    // we start using this one" than the first one is.
    let spent = db_handle
        .prepare(
            "UPDATE devices
          SET claim_nonce = NULL,
              claim_expires_at = NULL,
              claimed_at = COALESCE(claimed_at, ?2)
        WHERE id = ?1 AND claim_nonce = ?3",
        )
        .bind(&[
            JsValue::from_str(&row.id),
            JsValue::from_str(&timestamp),
            JsValue::from_str(&nonce),
        ])?
        .run()
        .await?;

    // `spent.meta.changes === 0`. A D1 result that carried no meta at all would
    // have read as `undefined === 0`, i.e. false; there is no such result, and
    // the loser of the race is the row-count case either way.
    if spent.meta()?.and_then(|meta| meta.changes) == Some(0) {
        return Err(spent_link());
    }

    // The device claim and nothing else. Nobody is signed in on a tablet that
    // has this second been claimed, which is exactly what the three `None`s
    // mean to every route downstream: this device is ours, show the PIN screen.
    let identity = Identity {
        device_id: row.id,
        device_name: row.name,
        staff_id: None,
        staff_name: None,
        role: None,
    };

    // The row as it was read, before the update, which is where
    // `row.token_version` comes from. Claiming does not bump it — a claim is a
    // tablet arriving, not a tablet being cut off — so the version in the token
    // is the one `require_device` will compare against on the next request.
    let credential = identity::issue(&identity, row.token_version, env).await?;
    credential_response(&credential, &identity)
}

/// The session bootstrap: who this tablet is, and everything it has to know
/// before it can draw a price or a clock.
///
/// The `config` half is read from the `wrangler.jsonc` vars on every call rather
/// than baked into the frontend build, and `shared/src/config.ts` makes the long
/// argument for that. The short one: two copies drift, and the day they disagree
/// the screen is quoting a price the bill does not charge.
async fn me(req: &Request, env: &Env) -> ApiResult<Response> {
    let identity = middleware::require_device(req, env).await?;
    Ok(Response::from_json(&Me { identity: &identity, config: crate::env::app_config(env) })?)
}

/// Throw the credential away. There is nothing to invalidate server-side — a
/// token is stateless for its ninety days — so this clears the cookie and the
/// client forgets the bearer token.
///
/// It is not how a tablet is taken out of service. That is `token_version`,
/// bumped from the backoffice, because a device left in a taxi is not going to
/// call this route.
fn logout() -> ApiResult<Response> {
    let set_cookie = identity::revoke();
    let response = Response::from_json(&serde_json::json!({ "ok": true }))?;
    response.headers().set("Set-Cookie", &set_cookie)?;
    Ok(response)
}

/* ------------------------------------------------------------- the answers */

/// Two top-level keys, `token` before `identity` — `authResultSchema` in
/// `shared/src/models.ts`.
///
/// Declared once and answered by three routes in two files — `/auth/claim`
/// here, `/staff/switch` and `/staff/signout` next door — through the one
/// helper below. All three do the same thing, which is mint a token and say who
/// it now belongs to, and a second declaration of the same two keys is a second
/// thing to keep in step with the schema.
///
/// The token is in the body as well as in the `Set-Cookie` because the API and
/// the app do not have to share an origin: Pages and Workers are different
/// origins in production, where Safari blocks the cookie outright. The bearer
/// token is the one that always works; the cookie is the same-origin bonus that
/// keeps the credential out of reach of XSS.
#[derive(Serialize)]
struct AuthResult<'a> {
    token: &'a str,
    identity: &'a Identity,
}

/// `meSchema`: the identity, then the config.
#[derive(Serialize)]
struct Me<'a> {
    identity: &'a Identity,
    config: AppConfig,
}

/// The response all three token-minting routes send.
///
/// Every one of them re-mints rather than patches, because the staff claim is
/// inside the token: signing somebody in, signing them out and claiming a fresh
/// tablet are the same operation with different claims. So the `Set-Cookie` has
/// to travel with all three — a tablet that switched staff and kept its old
/// cookie would go on presenting the previous person's token on a same-origin
/// deployment, and only the bearer copy would be right.
pub fn credential_response(
    credential: &identity::IssuedCredential,
    identity: &Identity,
) -> ApiResult<Response> {
    let response = Response::from_json(&AuthResult { token: &credential.token, identity })?;
    if let Some(set_cookie) = &credential.set_cookie {
        response.headers().set("Set-Cookie", set_cookie)?;
    }
    Ok(response)
}

fn spent_link() -> http::ApiError {
    http::unauthorized("That link is not valid any more. Ask for a new one.")
}

/* --------------------------------------------------------- body validation */

/// `parseBody(c.req.raw, claimSchema)`, written out.
///
/// Hand-written rather than derived, and that is the house style rather than
/// laziness in reverse: the client parses every response with zod, so the server
/// has to reject exactly what zod would reject and say it in the same words, or
/// the two halves of the app disagree about what a valid request is. The tests
/// at the bottom are the proof, and their expected strings were taken from the
/// real schema running under node.
///
/// Two failures are visible from outside and they are different messages: a body
/// that is not JSON at all, and a body that is JSON of the wrong shape. The
/// second is zod's own text, and only the *first* issue is ever reported.
async fn parse_body(req: &mut Request) -> ApiResult<String> {
    // `await request.json()` is a read plus a parse, and either throw lands in
    // the same `catch`.
    let raw = match req.text().await {
        Ok(text) => serde_json::from_str::<Value>(&text),
        Err(_) => return Err(http::bad_request("Expected a JSON body")),
    };
    let Ok(raw) = raw else {
        return Err(http::bad_request("Expected a JSON body"));
    };
    validate(&raw)
}

/// `claimSchema` — `z.object({ nonce: z.string().min(20).max(100) })` — and the
/// `validate` around it, which prefixes the message with the dotted path of the
/// issue when there is one. The object's own issues have an empty path, so
/// `path.join('.')` is falsy for those and the message stands alone.
///
/// The bounds are not arbitrary. `identity::new_claim_nonce` is 32 random bytes
/// as base64url, which is 43 characters; 20 is comfortably below that and 100
/// comfortably above, so the range rejects the obviously-not-a-nonce without
/// pinning the length of something that could reasonably be regenerated wider.
fn validate(raw: &Value) -> ApiResult<String> {
    let Some(object) = raw.as_object() else {
        return Err(http::bad_request(format!(
            "Invalid input: expected object, received {}",
            zod_type(raw)
        )));
    };
    let nonce = match object.get("nonce") {
        Some(Value::String(nonce)) => nonce,
        // An absent key is `undefined`, which zod names rather than skips.
        other => {
            return Err(http::bad_request(format!(
                "nonce: Invalid input: expected string, received {}",
                other.map_or("undefined", zod_type)
            )))
        }
    };

    // zod measures `String.prototype.length`, which counts UTF-16 code units:
    // ten emoji are twenty characters and clear the minimum.
    let length = nonce.encode_utf16().count();
    if length < 20 {
        return Err(http::bad_request("nonce: Too small: expected string to have >=20 characters"));
    }
    if length > 100 {
        return Err(http::bad_request("nonce: Too big: expected string to have <=100 characters"));
    }
    Ok(nonce.clone())
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

    /// Every string here was taken from zod 4.4.3 running the real schema
    /// through the real `validate`.
    #[test]
    fn reports_the_first_issue_the_way_zod_words_it() {
        assert_eq!(message("{}"), "nonce: Invalid input: expected string, received undefined");
        assert_eq!(
            message(r#"{"nonce":null}"#),
            "nonce: Invalid input: expected string, received null"
        );
        assert_eq!(
            message(r#"{"nonce":123}"#),
            "nonce: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(r#"{"nonce":true}"#),
            "nonce: Invalid input: expected string, received boolean"
        );
        assert_eq!(
            message(r#"{"nonce":{}}"#),
            "nonce: Invalid input: expected string, received object"
        );
        // Two issues here; the first is still the type one.
        assert_eq!(
            message(r#"{"nonce":[]}"#),
            "nonce: Invalid input: expected string, received array"
        );

        assert_eq!(
            message(r#"{"nonce":"short"}"#),
            "nonce: Too small: expected string to have >=20 characters"
        );
        assert_eq!(
            message(&format!(r#"{{"nonce":"{}"}}"#, "x".repeat(101))),
            "nonce: Too big: expected string to have <=100 characters"
        );

        // The object's own failure has an empty path, so no prefix.
        assert_eq!(message(r#""nope""#), "Invalid input: expected object, received string");
        assert_eq!(message("42"), "Invalid input: expected object, received number");
        assert_eq!(message("true"), "Invalid input: expected object, received boolean");
        assert_eq!(message("null"), "Invalid input: expected object, received null");
        assert_eq!(message("[]"), "Invalid input: expected object, received array");
    }

    #[test]
    fn accepts_what_the_schema_accepts() {
        let ok = |json: &str| validate(&serde_json::from_str(json).unwrap()).unwrap();
        assert_eq!(ok(&format!(r#"{{"nonce":"{}"}}"#, "y".repeat(20))), "y".repeat(20));
        assert_eq!(ok(&format!(r#"{{"nonce":"{}"}}"#, "y".repeat(100))), "y".repeat(100));
        // Unknown keys are stripped, not rejected.
        assert_eq!(ok(&format!(r#"{{"nonce":"{}","x":1}}"#, "y".repeat(20))), "y".repeat(20));
        // Ten emoji are twenty UTF-16 code units.
        assert_eq!(ok(r#"{"nonce":"😀😀😀😀😀😀😀😀😀😀"}"#), "😀😀😀😀😀😀😀😀😀😀");
    }

    /// The nonce this Worker actually mints clears the minimum with room to
    /// spare — the one case the bounds exist to let through.
    #[test]
    fn accepts_a_nonce_of_the_length_this_worker_mints() {
        let minted = "y".repeat(43);
        assert_eq!(
            validate(&serde_json::from_str(&format!(r#"{{"nonce":"{minted}"}}"#)).unwrap())
                .unwrap(),
            minted
        );
    }

    /// The one message all three "no" answers share.
    #[test]
    fn says_nothing_about_which_kind_of_no_it_is() {
        let error = spent_link();
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "unauthorized");
        assert_eq!(error.message, "That link is not valid any more. Ask for a new one.");
    }
}
