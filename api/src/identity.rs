//! The identity seam: who is calling, and the compact signed token that says so.
//!
//! Ported from `src/identity/tokens.ts` and `src/identity/index.ts`. The two
//! files are one module here because the signer has exactly one caller and the
//! token layout is only meaningful alongside the claims that fill it.
//!
//! A token is `base64url(payload).base64url(HMAC-SHA256(payload))` and is
//! deliberately not a JWT: there is no algorithm field to confuse, and
//! therefore no "alg: none" class of bug. The payload is signed, not encrypted,
//! so it is readable by the client; nothing secret goes in it.
//!
//! Everything else in the Worker asks for an
//! [`Identity`](crate::middleware::Identity) and never learns how it was
//! obtained. Adding real authentication later — an OAuth provider, a magic link
//! — means writing a second provider and mapping it to `members.external_id`,
//! with no route or query changes.
//!
//! ## Why the MAC is not WebCrypto
//!
//! `crypto.subtle` is asynchronous and unreachable from a host test binary.
//! HMAC-SHA-256 is HMAC-SHA-256, so the RustCrypto implementation produces the
//! same 32 bytes as `crypto.subtle.sign('HMAC', …)` for the same key and
//! message — the tests at the bottom hold it to whole tokens taken from the
//! original code running under node. What that buys is a differential test that
//! runs on `cargo test` rather than only inside a Worker.
//!
//! The seam stays `async` even though nothing in it awaits: these are the
//! functions the original declared `async`, and the day one of them needs a
//! round trip — a key out of KV, a second provider that calls somebody — the
//! callers do not change.

use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;
use worker::{Env, Request};

use crate::base64;
use crate::http::{self, ApiResult};
use crate::js;
use crate::middleware::Identity;

type HmacSha256 = Hmac<Sha256>;

/// The name the provider answers to. One provider exists; the field is what
/// makes a second one a drop-in.
pub const PROVIDER_NAME: &str = "token";

const COOKIE_NAME: &str = "ff_token";
const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 90; // 90 days
const SSE_TICKET_TTL_SECONDS: i64 = 120;

/// A link is useful for a week; long enough to be seen, short enough to rot.
pub const CLAIM_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// The group link lives in a chat thread, so it needs to still work for the
/// friend who reads the message a fortnight late. Longer is tolerable because
/// of what it can do rather than how long it lasts: once everybody has claimed
/// a name it can claim nothing, and the organizer can rotate it at any time.
pub const GROUP_INVITE_TTL_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// The two scopes a token may carry. A session token cannot open a stream and a
/// ticket cannot do anything else, because the scope is checked against one of
/// these literals at every use.
pub mod scope {
    /// Long-lived credential proving "I am this member".
    pub const SESSION: &str = "session";
    /// Very short-lived, single-purpose ticket for the SSE query string.
    pub const SSE: &str = "sse";
}

/// What `issue` hands back: the bearer token, plus a `Set-Cookie` for the
/// same-origin case.
pub struct IssuedCredential {
    /// Bearer token. The client stores this and sends it on every request.
    pub token: String,
    /// Optional `Set-Cookie`, used when API and app share an origin.
    pub set_cookie: Option<String>,
}

/// What `authenticate` recovers from the request alone — before the database
/// has been asked whether that member still exists.
pub struct Resolved {
    pub member_id: String,
    /// Compared against `members.token_version` on every request. See
    /// [`Claims::version`] for what a token without one resolves to.
    pub token_version: i64,
}

/* ------------------------------------------------------------------ tokens */

/// The claims a token carries, in the JSON key order the two call sites write.
///
/// `signToken` appended `exp` to a spread of the caller's object, so `exp` is
/// always last and the rest appear in the order the caller declared them. Both
/// orders are baked into every token already issued, so this is a struct rather
/// than a map.
#[derive(Serialize)]
struct Claimset<'a> {
    scope: &'a str,
    sub: &'a str,
    name: &'a str,
    org: bool,
    /// Snapshot of `members.token_version` when this token was issued. Compared
    /// on every request, so bumping the column signs out that member
    /// everywhere. An SSE ticket carries no version, and `JSON.stringify` drops
    /// an undefined key entirely rather than writing `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    v: Option<i64>,
}

/// `{ ...claims, exp }`, which is where the "exp is always last" rule comes
/// from.
#[derive(Serialize)]
struct Payload<'a> {
    #[serde(flatten)]
    claims: &'a Claimset<'a>,
    /// Expiry, epoch seconds.
    exp: i64,
}

/// What `JSON.parse` produced, kept whole.
///
/// The original returned the parsed object untouched — including keys the
/// interface never declared — and nothing normalized it, so this holds the
/// `Value` and reads it the way the JS did, `??` and `=== true` included.
#[derive(Debug, Clone)]
pub struct Claims(Value);

impl Claims {
    /// `claims.scope !== expectedScope` — strict, so a missing or non-string
    /// scope fails.
    fn scope_is(&self, expected: &str) -> bool {
        matches!(self.0.get("scope"), Some(Value::String(scope)) if scope == expected)
    }

    /// `typeof claims.exp !== 'number'`: a numeric string is not a number.
    fn exp(&self) -> Option<f64> {
        match self.0.get("exp") {
            Some(Value::Number(exp)) => exp.as_f64(),
            _ => None,
        }
    }

    /// `claims.sub`, read the way `if (!claims?.sub)` read it: absent, `null`
    /// and the empty string are all "no subject".
    ///
    /// A truthy non-string `sub` would have been carried through as a member id
    /// by the original. Only this module mints tokens and it always writes a
    /// string, and forging one needs the secret, so there is nothing there to
    /// reproduce.
    pub fn sub(&self) -> Option<&str> {
        match self.0.get("sub") {
            Some(Value::String(sub)) if !sub.is_empty() => Some(sub),
            _ => None,
        }
    }

    /// `claims.name ?? ''`.
    pub fn name(&self) -> &str {
        match self.0.get("name") {
            Some(Value::String(name)) => name,
            _ => "",
        }
    }

    /// `claims.org === true` — strict identity, so `"true"` and `1` are false.
    pub fn org(&self) -> bool {
        matches!(self.0.get("org"), Some(Value::Bool(true)))
    }

    /// `claims.v ?? 1`. Tokens minted before revocation existed have no version;
    /// treat them as version 1, which is the column default.
    ///
    /// `??`, not `||`: a token carrying `v: 0` is version 0, not 1.
    ///
    /// A `v` that is present but is not a whole number survived the `??` in JS
    /// and then failed the `!==` against the integer column. `i64::MIN` keeps
    /// that outcome, because no `token_version` can equal it. Only this module
    /// mints tokens and it always writes the column's own integer, so the case
    /// needs a defined answer rather than a good one.
    pub fn version(&self) -> i64 {
        match self.0.get("v") {
            None | Some(Value::Null) => 1,
            Some(Value::Number(version)) => version.as_i64().unwrap_or(i64::MIN),
            Some(_) => i64::MIN,
        }
    }
}

/// The HMAC key: the secret's UTF-8 bytes, used as-is with no hashing, padding
/// or truncation. A key longer than SHA-256's block is folded by the HMAC
/// construction itself, per RFC 2104, which is exactly what WebCrypto does.
///
/// `crypto.subtle.importKey` refuses a zero-length key with a `DataError`, and
/// neither signing nor verifying caught it — the rejection reached Hono's
/// `onError`, which logged it and answered 500. A Worker deployed without
/// `AUTH_SECRET` is the only way to get here, and it fails the same way.
fn import_key(secret: &str) -> ApiResult<HmacSha256> {
    if secret.is_empty() {
        return Err(http::internal());
    }
    Ok(HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length"))
}

/// The signature over `data`, base64url — 32 bytes, so 43 characters.
fn hmac(secret: &str, data: &str) -> ApiResult<String> {
    let mut key = import_key(secret)?;
    key.update(data.as_bytes());
    Ok(base64::b64url_encode(&key.finalize().into_bytes()))
}

async fn sign_token(secret: &str, claims: &Claimset<'_>, ttl_seconds: i64) -> ApiResult<String> {
    sign_token_at(js::now_ms(), secret, claims, ttl_seconds)
}

/// `signToken`, with the clock passed in so a test can pin it.
///
/// The MAC covers the base64url *text* of the body, not the JSON bytes that
/// text encodes: the signer hands `encoder.encode(body)` to the MAC, and
/// base64url is pure ASCII.
fn sign_token_at(
    now_ms: f64,
    secret: &str,
    claims: &Claimset<'_>,
    ttl_seconds: i64,
) -> ApiResult<String> {
    let payload = Payload {
        claims,
        // Floored to whole seconds first, and only then is the TTL added.
        exp: (now_ms / 1000.0).floor() as i64 + ttl_seconds,
    };
    let json = serde_json::to_string(&payload).expect("the claim set is always serializable");
    let body = base64::b64url_encode(json.as_bytes());
    let signature = hmac(secret, &body)?;
    Ok(format!("{body}.{signature}"))
}

/// Verify signature, expiry and scope. Returns `None` on any failure — callers
/// cannot accidentally treat a bad token as merely expired.
pub async fn verify_token(
    secret: &str,
    token: Option<&str>,
    expected_scope: &str,
) -> ApiResult<Option<Claims>> {
    verify_token_at(js::now_ms(), secret, token, expected_scope)
}

fn verify_token_at(
    now_ms: f64,
    secret: &str,
    token: Option<&str>,
    expected_scope: &str,
) -> ApiResult<Option<Claims>> {
    // `if (!token)` — a missing token and an empty one are the same thing, and
    // both are answered before the key is ever built.
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok(None);
    };

    // The last dot, not the first: a base64url body cannot contain one, but the
    // rule is the rule. At index 0 the body would be empty.
    let Some(separator) = token.rfind('.') else {
        return Ok(None);
    };
    if separator == 0 {
        return Ok(None);
    }
    let body = &token[..separator];
    let signature = &token[separator + 1..];

    let mut key = import_key(secret)?;

    // The original's `try` covered decoding the signature as well as checking
    // it, so a malformed segment is a failed check rather than an error.
    let Ok(signature) = base64::b64url_decode(signature) else {
        return Ok(None);
    };
    key.update(body.as_bytes());
    if key.verify_slice(&signature).is_err() {
        return Ok(None);
    }

    // Only a well-signed body is ever parsed.
    let Ok(bytes) = base64::b64url_decode(body) else {
        return Ok(None);
    };
    // `new TextDecoder()` is non-fatal: bad UTF-8 becomes U+FFFD and it is
    // `JSON.parse` that objects, if anything does.
    let Ok(value) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
        return Ok(None);
    };
    let claims = Claims(value);

    if !claims.scope_is(expected_scope) {
        return Ok(None);
    }
    let Some(exp) = claims.exp() else {
        return Ok(None);
    };
    // Unfloored fractional seconds, and a strict `<`: a token whose `exp` is
    // exactly now is still valid.
    if exp < now_ms / 1000.0 {
        return Ok(None);
    }

    Ok(Some(claims))
}

/// Constant-time string compare for the shared invite code, so a wrong guess
/// cannot be narrowed down by timing.
///
/// Exported by the original and, as it stands, called by nothing. Kept because
/// dropping an exported primitive is not a port.
pub fn timing_safe_equal(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    // Length alone is not secret enough to matter, but mixing it in keeps the
    // loop a fixed number of iterations regardless of where the mismatch is.
    let mut diff = (a.len() as u32) ^ (b.len() as u32);
    for i in 0..a.len().max(b.len()) {
        diff |= u32::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

/* ---------------------------------------------------------------- provider */

/// Identify the caller from the raw request, or `None` for anonymous.
///
/// Must not touch the database; membership is re-checked by the caller so a
/// removed member loses access immediately.
///
/// The bearer token is the primary credential because it survives the shape
/// this app is actually deployed in: Pages and Workers on different origins,
/// where Safari blocks third-party cookies outright. The cookie is a bonus for
/// same-origin deployments — there it carries the credential out of reach of
/// XSS.
pub async fn authenticate(request: &Request, env: &Env) -> ApiResult<Option<Resolved>> {
    let authorization = request.headers().get("Authorization").ok().flatten();
    let cookie = request.headers().get("Cookie").ok().flatten();
    let token = credential(authorization.as_deref(), cookie.as_deref());

    let Some(claims) =
        verify_token(&crate::env::auth_secret(env), token.as_deref(), scope::SESSION).await?
    else {
        return Ok(None);
    };
    let Some(sub) = claims.sub() else {
        return Ok(None);
    };
    Ok(Some(Resolved { member_id: sub.to_string(), token_version: claims.version() }))
}

/// `Authorization: Bearer …` first, the cookie second.
///
/// The fallback is `??`, so it only runs when there was no bearer at all. A
/// header of exactly `"Bearer "` yields the empty string, which is not nullish:
/// the cookie is *not* consulted, and the empty token fails verification.
fn credential(authorization: Option<&str>, cookie_header: Option<&str>) -> Option<String> {
    authorization
        // Case-sensitive and exact — capital `B`, one ASCII space.
        .filter(|header| header.starts_with("Bearer "))
        .map(|header| js_trim(&header[7..]).to_string())
        .or_else(|| read_cookie(cookie_header, COOKIE_NAME).map(str::to_string))
}

/// Mint a credential for a member who has just redeemed a claim link.
pub async fn issue(
    identity: &Identity,
    token_version: i64,
    env: &Env,
) -> ApiResult<IssuedCredential> {
    let token = sign_token(
        &crate::env::auth_secret(env),
        &Claimset {
            scope: scope::SESSION,
            sub: &identity.member_id,
            name: &identity.name,
            org: identity.is_organizer,
            v: Some(token_version),
        },
        SESSION_TTL_SECONDS,
    )
    .await?;
    let set_cookie = build_cookie(&token, SESSION_TTL_SECONDS);
    Ok(IssuedCredential { token, set_cookie: Some(set_cookie) })
}

/// The header value that clears any stored credential. Always present, so the
/// caller's `if (setCookie)` was never false.
pub fn revoke() -> String {
    build_cookie("", 0)
}

/* ----------------------------------------------------------- claim nonces */

/// A claim link's secret.
///
/// 256 bits of randomness, looked up directly in the database. Not a signed
/// token on purpose: the DB row *is* the proof, so spending a link is a delete
/// rather than a revocation list, and the bootstrap path can mint one with a
/// single SQL statement without needing `AUTH_SECRET`.
pub fn new_claim_nonce() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("crypto.getRandomValues is always available");
    base64::b64url_encode(&bytes)
}

/* ------------------------------------------------------------ SSE tickets */

/// `EventSource` cannot set an `Authorization` header, so the SSE endpoint takes
/// its credential from the query string. Rather than putting the 90-day session
/// token somewhere it could be logged by a proxy, the client trades it for a
/// two-minute, stream-only ticket.
pub async fn issue_sse_ticket(env: &Env, identity: &Identity) -> ApiResult<String> {
    sign_token(
        &crate::env::auth_secret(env),
        &Claimset {
            scope: scope::SSE,
            sub: &identity.member_id,
            name: &identity.name,
            org: identity.is_organizer,
            // A ticket carries no token version: it expires long before a
            // revocation could matter.
            v: None,
        },
        SSE_TICKET_TTL_SECONDS,
    )
    .await
}

pub async fn verify_sse_ticket(env: &Env, ticket: Option<&str>) -> ApiResult<Option<Identity>> {
    let Some(claims) = verify_token(&crate::env::auth_secret(env), ticket, scope::SSE).await? else {
        return Ok(None);
    };
    let Some(sub) = claims.sub() else {
        return Ok(None);
    };
    Ok(Some(Identity {
        member_id: sub.to_string(),
        name: claims.name().to_string(),
        is_organizer: claims.org(),
        // Not carried in the ticket: the stream endpoint sends no prose.
        language: "en".to_string(),
        hour12: false,
        // A ticket is only ever minted for an approved member, and the stream
        // route re-checks nothing else; carrying the flag would only let a
        // stale ticket assert it.
        approved: true,
    }))
}

/* ---------------------------------------------------------------- helpers */

fn build_cookie(value: &str, max_age: i64) -> String {
    // SameSite=None is required for the cross-origin Pages -> Workers case; it
    // implies Secure, which browsers accept on http://localhost for dev.
    format!("{COOKIE_NAME}={value}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age={max_age}")
}

/// Split on `;`, then on the first `=` of each part. The value is not
/// URL-decoded and quotes are not stripped; the first match wins.
fn read_cookie<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    // An absent header and an empty one are the same falsy thing.
    let header = header.filter(|header| !header.is_empty())?;
    for part in header.split(';') {
        let Some(index) = part.find('=') else {
            continue;
        };
        if js_trim(&part[..index]) == name {
            return Some(js_trim(&part[index + 1..]));
        }
    }
    None
}

/// JavaScript's `trim`: `WhiteSpace` plus `LineTerminator`, which is Unicode's
/// `White_Space` with U+FEFF added and U+0085 left out.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The secret every vector below was signed with under node.
    const SECRET: &str = "test-secret-key";
    /// `Date.now()` pinned while the vectors were taken, so `exp` is
    /// `floor(1700000000123 / 1000) + ttl`.
    const ISSUED_AT_MS: f64 = 1_700_000_000_123.0;
    /// The session token of `signs_the_same_tokens`, reused by the verifiers.
    const SESSION_TOKEN: &str = "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJtZW1fYWJjMTIzIiwibmFtZSI6Ik5n\
                                 dXnhu4VuIFbEg24gQSIsIm9yZyI6dHJ1ZSwidiI6MywiZXhwIjoxNzA3Nzc2MDAw\
                                 fQ.pE0q6_8psTYMcyhw7bR1JePZWrn52QN5OZpgreGi6RQ";

    fn body_of(token: &str) -> String {
        let separator = token.rfind('.').unwrap();
        String::from_utf8(base64::b64url_decode(&token[..separator]).unwrap()).unwrap()
    }

    /// The signature the original produced for a known key and message. If
    /// RustCrypto's HMAC and WebCrypto's ever disagreed, this is where.
    #[test]
    fn hmac_matches_web_crypto() {
        assert_eq!(hmac(SECRET, "hello").unwrap(), "KJNV_8-dFl9c6U86oQDHzXP_HcD9gFfaqYHvcu6D4To");
        // 65 bytes: past SHA-256's block size, where RFC 2104 hashes the key.
        assert_eq!(
            hmac(&"k".repeat(65), "hello").unwrap(),
            "7bvjKpV4b3NOwCiHoJqIFLg_cb5u2P-NXGBJvcLQNcw"
        );
    }

    /// Whole tokens, character for character, as node minted them.
    #[test]
    fn signs_the_same_tokens() {
        let session = sign_token_at(
            ISSUED_AT_MS,
            SECRET,
            &Claimset {
                scope: scope::SESSION,
                sub: "mem_abc123",
                name: "Nguyễn Văn A",
                org: true,
                v: Some(3),
            },
            SESSION_TTL_SECONDS,
        )
        .unwrap();
        assert_eq!(session, SESSION_TOKEN);
        assert_eq!(
            body_of(&session),
            r#"{"scope":"session","sub":"mem_abc123","name":"Nguyễn Văn A","org":true,"v":3,"exp":1707776000}"#
        );

        // An SSE ticket: no `v` key at all, and a two-minute life.
        let ticket = sign_token_at(
            ISSUED_AT_MS,
            SECRET,
            &Claimset {
                scope: scope::SSE,
                sub: "mem_abc123",
                name: "Nguyễn Văn A",
                org: false,
                v: None,
            },
            SSE_TICKET_TTL_SECONDS,
        )
        .unwrap();
        assert_eq!(
            ticket,
            "eyJzY29wZSI6InNzZSIsInN1YiI6Im1lbV9hYmMxMjMiLCJuYW1lIjoiTmd1eeG7hW4gVsSDbiBBIiwib3JnIj\
             pmYWxzZSwiZXhwIjoxNzAwMDAwMTIwfQ.Zqnrb-peee6Lrcmp1V2PvBtpuYKhrktNZvxSDqnFNjM"
        );
        assert_eq!(
            body_of(&ticket),
            r#"{"scope":"sse","sub":"mem_abc123","name":"Nguyễn Văn A","org":false,"exp":1700000120}"#
        );
    }

    /// `JSON.stringify`'s escaping, which the body is the base64url of: short
    /// escapes for the usual controls, `\u00XX` for the rest, and non-ASCII
    /// written out as UTF-8 rather than `\u`-escaped.
    #[test]
    fn escapes_the_payload_the_same_way() {
        let token = sign_token_at(
            ISSUED_AT_MS,
            SECRET,
            &Claimset {
                scope: scope::SESSION,
                sub: "mem_1",
                name: "A \"B\" \\ C\n\tD\u{1} ⚽😀",
                org: false,
                v: Some(0),
            },
            SESSION_TTL_SECONDS,
        )
        .unwrap();
        assert_eq!(
            token,
            "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJtZW1fMSIsIm5hbWUiOiJBIFwiQlwiIFxcIENcblx0RFx1MDAwMS\
             Dimr3wn5iAIiwib3JnIjpmYWxzZSwidiI6MCwiZXhwIjoxNzA3Nzc2MDAwfQ.yfio2JjEjezdVBhf4dhxdTk9\
             D82UiacYfKEg8ZlkW6Y"
        );
    }

    /// The key is the secret's UTF-8 bytes, whatever they happen to be.
    #[test]
    fn signs_with_non_ascii_and_oversized_secrets() {
        let claims =
            Claimset { scope: scope::SESSION, sub: "mem_1", name: "n", org: true, v: Some(2) };
        assert_eq!(
            sign_token_at(ISSUED_AT_MS, &"k".repeat(65), &claims, SESSION_TTL_SECONDS).unwrap(),
            "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJtZW1fMSIsIm5hbWUiOiJuIiwib3JnIjp0cnVlLCJ2IjoyLCJleH\
             AiOjE3MDc3NzYwMDB9.aO0WPTsJepCk9MIN65I0kzVryObAZUhNFWFdbmr7WbY"
        );

        let ticket = Claimset { scope: scope::SSE, sub: "mem_1", name: "n", org: false, v: None };
        assert_eq!(
            sign_token_at(ISSUED_AT_MS, "sécret-⚽", &ticket, SSE_TICKET_TTL_SECONDS).unwrap(),
            "eyJzY29wZSI6InNzZSIsInN1YiI6Im1lbV8xIiwibmFtZSI6Im4iLCJvcmciOmZhbHNlLCJleHAiOjE3MDAwMD\
             AxMjB9.3frRJ2l1g6erLJN9c1GoJXG5n80c0LQBhdQhN63tIFA"
        );
    }

    /// A token minted here verifies here, and the claims come back whole.
    #[test]
    fn verifies_its_own_tokens() {
        let now = 1_700_000_100_000.0;

        let claims = verify_token_at(now, SECRET, Some(SESSION_TOKEN), scope::SESSION)
            .unwrap()
            .expect("a good token verifies");
        assert_eq!(claims.sub(), Some("mem_abc123"));
        assert_eq!(claims.name(), "Nguyễn Văn A");
        assert!(claims.org());
        assert_eq!(claims.version(), 3);

        // Scope is checked against a literal, so a session token is not a ticket.
        assert!(verify_token_at(now, SECRET, Some(SESSION_TOKEN), scope::SSE).unwrap().is_none());
        // And the MAC is over the body text, so another secret fails.
        assert!(verify_token_at(now, "other", Some(SESSION_TOKEN), scope::SESSION)
            .unwrap()
            .is_none());
    }

    /// Every shape the original answered `null` for.
    #[test]
    fn rejects_malformed_tokens() {
        let now = 1_700_000_100_000.0;
        let separator = SESSION_TOKEN.rfind('.').unwrap();
        let body = &SESSION_TOKEN[..separator];
        let signature = &SESSION_TOKEN[separator + 1..];

        let bad = [
            String::new(),                   // falsy, answered before anything
            body.to_string(),                // no separator at all
            format!(".{signature}"),         // separator at index 0: empty body
            format!("{body}."),              // empty signature
            format!("{body}.!!!!"),          // a signature `atob` refuses
            format!("{body}.A"),             // 4n+1 characters
            format!("{body}.{signature}.x"), // the *last* dot is the separator
        ];
        for token in &bad {
            assert!(
                verify_token_at(now, SECRET, Some(token), scope::SESSION).unwrap().is_none(),
                "{token} should not verify"
            );
        }
        assert!(verify_token_at(now, SECRET, None, scope::SESSION).unwrap().is_none());
    }

    /// Expiry is `exp < now` on unfloored fractional seconds — a token whose
    /// `exp` is exactly now is still good.
    #[test]
    fn expires_on_a_strict_less_than() {
        let token = sign_token_at(
            1_700_000_000_000.0,
            SECRET,
            &Claimset { scope: scope::SESSION, sub: "m1", name: "n", org: false, v: None },
            100,
        )
        .unwrap(); // exp = 1700000100

        let verify = |now: f64| {
            verify_token_at(now, SECRET, Some(&token), scope::SESSION).unwrap().is_some()
        };
        assert!(verify(1_700_000_099_999.0));
        assert!(verify(1_700_000_100_000.0), "exp == now is still valid");
        assert!(!verify(1_700_000_100_001.0), "a millisecond past is not");
    }

    /// Only a well-signed body is parsed, and what parses is returned untouched.
    #[test]
    fn checks_the_mac_before_reading_the_body() {
        // Correctly signed, but the body is not JSON.
        let body = base64::b64url_encode(b"not json");
        let token = format!("{body}.{}", hmac(SECRET, &body).unwrap());
        assert!(verify_token_at(0.0, SECRET, Some(&token), scope::SESSION).unwrap().is_none());

        // Claims the interface never declared survive verification.
        let body =
            base64::b64url_encode(br#"{"scope":"session","sub":"m1","extra":[1,2],"exp":2000000000}"#);
        let token = format!("{body}.{}", hmac(SECRET, &body).unwrap());
        let claims = verify_token_at(0.0, SECRET, Some(&token), scope::SESSION).unwrap().unwrap();
        assert_eq!(claims.0["extra"], serde_json::json!([1, 2]));

        // `exp` as a string is not a number.
        let body = base64::b64url_encode(br#"{"scope":"session","sub":"m1","exp":"2000000000"}"#);
        let token = format!("{body}.{}", hmac(SECRET, &body).unwrap());
        assert!(verify_token_at(0.0, SECRET, Some(&token), scope::SESSION).unwrap().is_none());
    }

    /// A Worker without `AUTH_SECRET`: `importKey` threw, and the throw escaped
    /// `verifyToken` because it happened outside the `try`. But not before the
    /// falsy-token check, which is why an anonymous request still gets its 401.
    #[test]
    fn an_empty_secret_is_an_error_not_a_rejection() {
        assert_eq!(verify_token_at(0.0, "", Some("a.b"), scope::SESSION).unwrap_err().status, 500);
        assert!(verify_token_at(0.0, "", None, scope::SESSION).unwrap().is_none());
        assert!(verify_token_at(0.0, "", Some(""), scope::SESSION).unwrap().is_none());
    }

    #[test]
    fn reads_claims_the_way_the_js_read_them() {
        let claims = |json: &str| Claims(serde_json::from_str(json).unwrap());

        assert_eq!(claims("{}").version(), 1, "no version means version 1");
        assert_eq!(claims(r#"{"v":null}"#).version(), 1);
        assert_eq!(claims(r#"{"v":0}"#).version(), 0, "?? is not ||");
        assert_eq!(claims(r#"{"v":"2"}"#).version(), i64::MIN, "no column can match this");
        assert_eq!(claims(r#"{"v":1.5}"#).version(), i64::MIN);

        assert!(claims(r#"{"org":true}"#).org());
        assert!(!claims(r#"{"org":"true"}"#).org(), "=== true, not truthy");
        assert!(!claims(r#"{"org":1}"#).org());
        assert!(!claims("{}").org());

        assert_eq!(claims(r#"{"name":null}"#).name(), "");
        assert_eq!(claims("{}").name(), "");

        assert_eq!(claims(r#"{"sub":""}"#).sub(), None, "the empty string is falsy");
        assert_eq!(claims(r#"{"sub":null}"#).sub(), None);
        assert_eq!(claims(r#"{"sub":"m1"}"#).sub(), Some("m1"));
    }

    #[test]
    fn prefers_the_bearer_then_falls_back_to_the_cookie() {
        let cookie = Some("ff_token=from_cookie");

        assert_eq!(credential(Some("Bearer abc"), cookie).as_deref(), Some("abc"));
        assert_eq!(credential(Some("Bearer   abc  "), cookie).as_deref(), Some("abc"));
        assert_eq!(credential(Some("Bearer abc\r\n"), cookie).as_deref(), Some("abc"));

        // The prefix is exact: anything else is not a bearer at all.
        for header in ["bearer abc", "BEARER abc", "Bearer\tabc", "Bearerabc", ""] {
            assert_eq!(
                credential(Some(header), cookie).as_deref(),
                Some("from_cookie"),
                "{header:?} is not a bearer"
            );
        }
        assert_eq!(credential(None, cookie).as_deref(), Some("from_cookie"));

        // `??`, not `||`: an empty bearer is still a bearer, so the cookie is
        // never reached and the empty token fails verification instead.
        assert_eq!(credential(Some("Bearer "), cookie).as_deref(), Some(""));
        assert_eq!(credential(Some("Bearer    "), cookie).as_deref(), Some(""));

        assert_eq!(credential(None, None), None);
    }

    #[test]
    fn reads_cookies_like_the_original() {
        let read = |header: &'static str| read_cookie(Some(header), COOKIE_NAME);

        assert_eq!(read("ff_token=abc"), Some("abc"));
        assert_eq!(read("a=1; ff_token = abc ; b=2"), Some("abc"));
        assert_eq!(read("\tff_token\t=\tabc\t"), Some("abc"));
        assert_eq!(read("ff_token=one; ff_token=two"), Some("one"), "first match wins");
        assert_eq!(read("junk; ff_token=abc"), Some("abc"), "a part without = is skipped");
        assert_eq!(read("ff_token=a=b=c"), Some("a=b=c"), "only the first = splits");
        assert_eq!(read("ff_token="), Some(""));
        assert_eq!(read("ff_token=\"abc\""), Some("\"abc\""), "quotes are not stripped");
        assert_eq!(read("other=1"), None);
        assert_eq!(read(""), None);
        assert_eq!(read_cookie(None, COOKIE_NAME), None);
    }

    #[test]
    fn builds_and_clears_the_cookie() {
        assert_eq!(
            build_cookie("abc", SESSION_TTL_SECONDS),
            "ff_token=abc; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=7776000"
        );
        assert_eq!(revoke(), "ff_token=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0");
    }

    #[test]
    fn compares_in_constant_time() {
        assert!(timing_safe_equal("abc", "abc"));
        assert!(!timing_safe_equal("abc", "abd"));
        assert!(!timing_safe_equal("abc", "abcd"), "a prefix is not a match");
        assert!(timing_safe_equal("", ""));
        assert!(!timing_safe_equal("", "a"));
        // Compared as UTF-8 bytes, not as characters.
        assert!(timing_safe_equal("é", "é"));
        assert!(!timing_safe_equal("é", "Ã©"));
    }

    #[test]
    fn mints_43_character_nonces() {
        let nonce = new_claim_nonce();
        assert_eq!(nonce.len(), 43, "32 bytes, base64url, unpadded");
        assert!(nonce.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(nonce, new_claim_nonce());
    }

    /// The lifetimes, spelled out so a typo in the arithmetic cannot pass.
    #[test]
    fn keeps_the_documented_lifetimes() {
        assert_eq!(SESSION_TTL_SECONDS, 7_776_000);
        assert_eq!(SSE_TICKET_TTL_SECONDS, 120);
        assert_eq!(CLAIM_TTL_MS, 604_800_000.0);
        assert_eq!(GROUP_INVITE_TTL_MS, 2_592_000_000.0);
    }
}
