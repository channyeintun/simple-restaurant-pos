//! Getting in.
//!
//! There is exactly one way: redeem a claim link the organizer sent you. There
//! is no name picker and no shared password.
//!
//! The previous design — a group-wide invite code plus "pick who you are" — had
//! two problems that only look small until you think about money. Anyone holding
//! the code could pick *any* name, including an organizer's, which made
//! privilege escalation a two-tap operation; and the code itself sits in a group
//! chat forever, so it never really expires. A per-person, single-use link fixes
//! both: it names its holder, it is spent on first use, and it can be reissued
//! without disturbing anybody else.
//!
//! Ported from `src/routes/auth.ts`, which Hono mounted at `/auth` with no auth
//! middleware of its own — `/auth/me` declares `requireMember()` on the route
//! and is the only one of the three that has any.

use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{Env, Method, Request, Response};

use crate::db::{self, MemberRow};
use crate::http::{self, ApiResult};
use crate::identity;
use crate::middleware::{self, Identity};

/// `None` when nothing here matches, so the dispatcher can go on to the next
/// router. A path this file owns but with the wrong method is also `None`: Hono
/// matched on method too, so `GET /auth/claim` fell through to the `ALL /*`
/// gates that `protectedRoutes` installed and came back 401, not 404.
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
/// first person has opened it.
async fn claim(req: &mut Request, env: &Env) -> ApiResult<Response> {
    let nonce = parse_body(req).await?;
    let timestamp = http::now_iso();

    let db_handle = crate::env::db(env)?;
    let row: Option<MemberRow> = db_handle
        .prepare(
            "SELECT * FROM members
        WHERE claim_nonce = ?1 AND active = 1 AND claim_expires_at > ?2",
        )
        .bind(&[JsValue::from_str(&nonce), JsValue::from_str(&timestamp)])?
        .first(None)
        .await?;

    // One message for "wrong", "expired" and "already used": distinguishing
    // them would tell a stranger which of those a value happens to be.
    let Some(row) = row else {
        return Err(spent_link());
    };

    // Spend it. Guarded on the nonce so two simultaneous opens cannot both win.
    let spent = db_handle
        .prepare(
            "UPDATE members
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

    // The row as it was read, before the update: `hasPendingLink` is therefore
    // computed from the nonce this request just spent and is `true`, and
    // `claimedAt` is the old value — `null` for a first redemption.
    let member = db::to_member(&row);
    let identity = Identity {
        member_id: member.id,
        name: member.name,
        is_organizer: member.is_organizer,
        language: member.language,
        hour12: member.hour12,
        approved: member.approved_at.is_some(),
    };

    let credential = identity::issue(&identity, row.token_version, env).await?;
    let response = Response::from_json(&Claimed { token: &credential.token, identity: &identity })?;
    if let Some(set_cookie) = &credential.set_cookie {
        response.headers().set("Set-Cookie", set_cookie)?;
    }
    Ok(response)
}

async fn me(req: &Request, env: &Env) -> ApiResult<Response> {
    let identity = middleware::require_member(req, env).await?;
    Ok(Response::from_json(&Me { identity: &identity })?)
}

fn logout() -> ApiResult<Response> {
    let set_cookie = identity::revoke();
    let response = Response::from_json(&serde_json::json!({ "ok": true }))?;
    response.headers().set("Set-Cookie", &set_cookie)?;
    Ok(response)
}

/// Two top-level keys, `token` before `identity`.
#[derive(Serialize)]
struct Claimed<'a> {
    token: &'a str,
    identity: &'a Identity,
}

#[derive(Serialize)]
struct Me<'a> {
    identity: &'a Identity,
}

fn spent_link() -> http::ApiError {
    http::unauthorized("That link is not valid any more. Ask for a new one.")
}

/* --------------------------------------------------------- body validation */

/// `parseBody(c.req.raw, claimSchema)`.
///
/// Two failures are visible from outside and they are different messages: a
/// body that is not JSON at all, and a body that is JSON of the wrong shape.
/// The second is zod's own text, and only the *first* issue is ever reported.
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

    /// The one message all three "no" answers share.
    #[test]
    fn says_nothing_about_which_kind_of_no_it_is() {
        let error = spent_link();
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "unauthorized");
        assert_eq!(error.message, "That link is not valid any more. Ask for a new one.");
    }
}
