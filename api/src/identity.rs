//! The identity seam: who is calling, and the compact signed token that says so.
//!
//! Taken from the reference Worker's `identity.rs`, which ported it from
//! `src/identity/tokens.ts` and `src/identity/index.ts` — one module here
//! because the signer has exactly one caller and the token layout is only
//! meaningful alongside the claims that fill it. The MAC, the base64url
//! framing, verification, expiry, cookie parsing, the claim nonce and the
//! constant-time compare are unchanged. What this app adds is a second claim
//! and a second use for the same key.
//!
//! A token is `base64url(payload).base64url(HMAC-SHA256(payload))` and is
//! deliberately not a JWT: there is no algorithm field to confuse, and
//! therefore no "alg: none" class of bug. The payload is signed, not encrypted,
//! so it is readable by the client; nothing secret goes in it.
//!
//! Everything else in the Worker asks for an
//! [`Identity`](crate::middleware::Identity) and never learns how it was
//! obtained. A second way in later — a staff login from a phone, an OAuth
//! provider for the backoffice — means writing a second provider that produces
//! the same struct, with no route and no query changed.
//!
//! ## The two claims
//!
//! A token says two things: which tablet this is, and who is standing at it.
//! The device claim — `sub`, `name`, `v` — is the credential. An admin mints a
//! single-use link, the tablet redeems it once, and the cookie is good for
//! ninety days. The staff claim — `staff`, `sname`, `role` — is four digits
//! tapped on a keypad by whoever has just picked the tablet up, and is absent
//! for as long as nobody has.
//!
//! **The device claim is what keeps strangers out. The PIN only tells staff
//! apart.** Four digits is ten thousand guesses, which is an afternoon's work,
//! and nothing in this codebase may call it a security boundary. What it buys
//! is the right name on the kitchen ticket and the right staff id on the
//! payment row, on a tablet three people share across a shift.
//!
//! Tapping a PIN **re-mints the whole token** rather than adding a second
//! cookie or opening a server-side session. Both alternatives look easier and
//! are worth saying no to out loud:
//!
//! * A second cookie is a second credential, and two credentials can disagree.
//!   A device cookie expired beside a staff cookie that has not; a cross-origin
//!   client sending a bearer token and no cookies at all, so the staff half
//!   silently vanishes. Every route would then need an opinion about what a
//!   half-authenticated request means, and that opinion would get written down
//!   four times slightly differently.
//! * A server-side session needs a table, a read on every request, and a sweep
//!   for the rows nobody ever signed out of. What it buys is instant
//!   revocation, which this design already has for free: `require_device`
//!   re-reads the device and staff rows anyway, so somebody deactivated in the
//!   backoffice stops being staff on their next tap.
//!
//! Re-minting keeps one credential, one cookie and one shape. Signing out is
//! the same operation with the staff claim left off, which is why
//! `POST /staff/signout` answers with a token rather than deleting anything.
//!
//! ## Why the MAC is not WebCrypto
//!
//! `crypto.subtle` is asynchronous and unreachable from a host test binary.
//! HMAC-SHA-256 is HMAC-SHA-256, so the RustCrypto implementation produces the
//! same 32 bytes as `crypto.subtle.sign('HMAC', …)` for the same key and
//! message — the tests at the bottom hold it to whole tokens taken from node.
//! What that buys is a differential test that runs on `cargo test` rather than
//! only inside a Worker. The staff PIN hashes are held to the same standard, in
//! the same way, for the same reason: nothing else in the system can tell you
//! that two implementations of the same MAC have started to disagree.
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

const COOKIE_NAME: &str = "pos_token";
const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 90; // 90 days
const SSE_TICKET_TTL_SECONDS: i64 = 120;

/// A link is useful for a week; long enough to be seen, short enough to rot.
pub const CLAIM_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// The two scopes a token may carry. A session token cannot open a stream and a
/// ticket cannot do anything else, because the scope is checked against one of
/// these literals at every use.
pub mod scope {
    /// Long-lived credential proving "I am this tablet, and this person is on
    /// it".
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
/// has been asked whether that device still exists.
pub struct Resolved {
    pub device_id: String,
    /// Whoever was signed in when this token was minted, or `None` for a tablet
    /// showing the PIN screen.
    ///
    /// It is the one thing here that cannot be looked up instead: the device
    /// row knows which tablet this is, but only the token knows who picked it
    /// up. `require_device` takes the id from here and re-reads the staff row
    /// with it, so the name and the role come from the database and only the
    /// *identification* comes from the token.
    pub staff_id: Option<String>,
    /// Compared against `devices.token_version` on every request. See
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
    /// The device id — `sub` rather than `device` because it is the subject of
    /// the token in the sense every token format means it: the thing the
    /// credential is about.
    sub: &'a str,
    /// The device name, so a client can say which tablet it is holding without
    /// asking.
    name: &'a str,
    /// The staff id, when somebody is signed in on this tablet.
    ///
    /// Absent rather than `null`, which is what `skip_serializing_if` buys.
    /// The reference needed that for one key — an SSE ticket carries no `v`,
    /// and `JSON.stringify` drops an undefined key entirely rather than writing
    /// `null` — and the reasoning extends to all three staff keys. A token is
    /// bytes on the wire on every single request, so a key whose value is "no"
    /// costs length and says nothing; and "the key is not there" is a state
    /// every reader has to handle regardless, because a device with nobody
    /// signed in on it is the normal resting state of a tablet.
    ///
    /// The [`Identity`] these fill does the opposite and serializes `null` —
    /// see the field-order note on that struct. The two are different things:
    /// this is a credential, that is an object a client destructures.
    #[serde(skip_serializing_if = "Option::is_none")]
    staff: Option<&'a str>,
    /// The staff name. Carried so the SSE path can rebuild an identity without
    /// a database read; every other path re-reads the row and prefers what it
    /// finds there.
    #[serde(skip_serializing_if = "Option::is_none")]
    sname: Option<&'a str>,
    /// `"waiter"`, `"cashier"` or `"admin"` — the strings `staff.role` is
    /// constrained to. Never trusted for a permission decision: `require_role`
    /// checks the freshly read row, because a token minted at six o'clock is
    /// still asserting at eleven whatever was true at six.
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'a str>,
    /// Snapshot of `devices.token_version` when this token was issued. Compared
    /// on every request, so bumping the column signs that tablet out
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
    /// A truthy non-string `sub` would have been carried through as a device id
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

    /// `claims.staff`, read exactly as [`Claims::sub`] is: absent, `null` and
    /// the empty string all mean nobody is signed in on this tablet. A
    /// non-string reads as absent for the same reason — a token this module did
    /// not mint cannot get here without the secret, so the case needs a defined
    /// answer rather than a clever one, and "nobody" is the answer that grants
    /// nothing.
    pub fn staff(&self) -> Option<&str> {
        match self.0.get("staff") {
            Some(Value::String(staff)) if !staff.is_empty() => Some(staff),
            _ => None,
        }
    }

    /// `claims.sname`, same reading. Only the SSE path uses it, and it reads it
    /// alongside [`Claims::staff`] so a claim set with a name and no id cannot
    /// produce an identity with a name and no id.
    pub fn staff_name(&self) -> Option<&str> {
        match self.0.get("sname") {
            Some(Value::String(name)) if !name.is_empty() => Some(name),
            _ => None,
        }
    }

    /// `claims.role`. Not checked against the three legal roles here — that is
    /// `require_role`'s job, and it does it against the row rather than the
    /// claim. An unknown string is simply a role that matches nothing.
    pub fn role(&self) -> Option<&str> {
        match self.0.get("role") {
            Some(Value::String(role)) if !role.is_empty() => Some(role),
            _ => None,
        }
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

/// Constant-time string compare, so a wrong guess cannot be narrowed down by
/// timing.
///
/// The original exported it for a shared invite code this app does not have.
/// Here it is what [`verify_pin`] compares with — the use it was always worth
/// keeping for.
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
/// Must not touch the database; the device row and the staff row are re-read by
/// the caller, so a revoked tablet and a member of staff who left last week
/// both lose access immediately.
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
    Ok(Some(Resolved {
        device_id: sub.to_string(),
        staff_id: claims.staff().map(str::to_string),
        token_version: claims.version(),
    }))
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

/// Mint a credential.
///
/// Three routes call it: `/auth/claim` when a tablet redeems a link,
/// `/staff/switch` when four digits match somebody, and `/staff/signout` with
/// the staff fields cleared. All three mint a whole token rather than patching
/// one, which is what makes the staff claim part of this credential instead of
/// a second credential beside it.
pub async fn issue(
    identity: &Identity,
    token_version: i64,
    env: &Env,
) -> ApiResult<IssuedCredential> {
    let token = sign_token(
        &crate::env::auth_secret(env),
        &Claimset {
            scope: scope::SESSION,
            sub: &identity.device_id,
            name: &identity.device_name,
            staff: identity.staff_id.as_deref(),
            sname: identity.staff_name.as_deref(),
            role: identity.role.as_deref(),
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

/* -------------------------------------------------------------- staff pins */

/// What `staff.pin_hash` stores: base64url
/// `HMAC-SHA256(AUTH_SECRET, staff_id || pin)`, 43 characters, the same shape
/// and the same key as a token signature.
///
/// **Keyed, not merely hashed.** A PIN is four digits, so an unkeyed digest of
/// one is a ten-thousand-entry lookup table that anybody who reads this column
/// builds in a second — and a per-row salt only makes it ten thousand entries
/// per person, which is the same afternoon. The key never leaves the Worker, so
/// a leaked copy of the database is not a leaked list of PINs. It costs nothing
/// to do this way: `hmac`/`sha2` are already here for the tokens.
///
/// **Deliberately not a slow KDF.** bcrypt or PBKDF2 is the right answer when
/// the stored hash is the only thing between an attacker and the password,
/// because the work factor is what buys time against the offline guess. Here
/// the pepper is what carries the strength: without `AUTH_SECRET` there is no
/// offline attack to slow down, and with it four digits fall to a hundred
/// thousand iterations as surely as to one. The cost is real and lands in the
/// wrong place — a Worker's CPU budget is measured in milliseconds, and
/// `POST /staff/switch` walks every active member of staff, so a KDF would be
/// paid once per row on the tap that a waiter is standing at a table waiting
/// for.
///
/// **The message is the id and the PIN concatenated, with no separator.** That
/// is unambiguous only because `pinSchema` is `/^\d{4}$/`: the last four
/// characters of the message are always the PIN and everything before them is
/// always the id, so no two pairs can produce the same message. Loosen the PIN
/// to a variable length and that stops being true — there is a test below that
/// says so in one line.
///
/// Including the id is also what stops two people who both chose 1234 sharing a
/// hash. The database consequently cannot see that collision and no unique
/// index would catch it, which is why `0001_init.sql` says at the column that
/// checking it belongs to whoever sets the PIN.
///
/// Rotating `AUTH_SECRET` invalidates every stored PIN as well as every issued
/// token. That is a property to know rather than a bug: it is one key, and both
/// of the things it protects are meant to be re-established by a person.
///
/// `ApiResult` rather than a plain `String` because the secret can be missing,
/// and a Worker with no `AUTH_SECRET` can no more check a PIN than verify a
/// token. It fails identically — a 500 from importing the key, not a confident
/// wrong answer.
pub fn pin_hash(secret: &str, staff_id: &str, pin: &str) -> ApiResult<String> {
    hmac(secret, &format!("{staff_id}{pin}"))
}

/// Does `pin` belong to `staff_id`?
///
/// Compared with [`timing_safe_equal`] rather than `==`. What is being compared
/// is a MAC rather than the PIN itself, so the leak is small — but
/// `POST /staff/switch` is given only four digits and has to try each active
/// member of staff in turn, since the digits are the identifier. That makes a
/// per-row timing signal a per-row oracle, and the constant-time compare is one
/// line.
///
/// A row whose `pin_hash` is NULL has no PIN set and must be skipped by the
/// caller rather than passed here as an empty string. It would answer `false`
/// either way; skipping it says why.
pub fn verify_pin(secret: &str, staff_id: &str, pin: &str, stored: &str) -> ApiResult<bool> {
    Ok(timing_safe_equal(&pin_hash(secret, staff_id, pin)?, stored))
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
            sub: &identity.device_id,
            name: &identity.device_name,
            staff: identity.staff_id.as_deref(),
            sname: identity.staff_name.as_deref(),
            role: identity.role.as_deref(),
            // A ticket carries no token version: it expires long before a
            // revocation could matter.
            v: None,
        },
        SSE_TICKET_TTL_SECONDS,
    )
    .await
}

/// The only place an [`Identity`] is built from claims instead of from rows.
///
/// It is also the only place where that is safe. A ticket lives two minutes,
/// the stream it opens can do exactly one thing — receive events on the
/// `restaurant` channel — and the route re-checks nothing else, so the worst a
/// stale ticket can assert is a stale name on a connection that is about to
/// close.
pub async fn verify_sse_ticket(env: &Env, ticket: Option<&str>) -> ApiResult<Option<Identity>> {
    let Some(claims) = verify_token(&crate::env::auth_secret(env), ticket, scope::SSE).await? else {
        return Ok(None);
    };
    let Some(sub) = claims.sub() else {
        return Ok(None);
    };
    // The three staff fields are read as one: `staff` is what decides whether
    // anybody is signed in, so a ticket that somehow carried a name and no id
    // cannot produce an identity with a name and no id.
    let staff_id = claims.staff();
    Ok(Some(Identity {
        device_id: sub.to_string(),
        device_name: claims.name().to_string(),
        staff_id: staff_id.map(str::to_string),
        staff_name: staff_id.and(claims.staff_name()).map(str::to_string),
        role: staff_id.and(claims.role()).map(str::to_string),
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
    /// A staff name in Burmese, because that is what the names in these tokens
    /// are going to be. The body is UTF-8 rather than `\u`-escaped, so a token
    /// carrying one is what proves the two encoders agree about that.
    const STAFF_NAME: &str = "မောင်မောင်";
    /// The session token of `signs_the_same_tokens`, reused by the verifiers.
    const SESSION_TOKEN: &str = "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJkZXZfY291bnRlciIsIm5hbWUiOiJDb3\
                                 VudGVyIHRhYmxldCIsInN0YWZmIjoic3RmX2FkbWluIiwic25hbWUiOiLhgJnhgLHh\
                                 gKzhgIThgLrhgJnhgLHhgKzhgIThgLoiLCJyb2xlIjoiYWRtaW4iLCJ2IjozLCJleH\
                                 AiOjE3MDc3NzYwMDB9.HgMGv5Gxvc3OlEPnSE1d_yncfT8ZIOcxjnhlVgEvTtA";

    fn body_of(token: &str) -> String {
        let separator = token.rfind('.').unwrap();
        String::from_utf8(base64::b64url_decode(&token[..separator]).unwrap()).unwrap()
    }

    /// The counter tablet with the manager signed in on it, which is the shape
    /// almost every token this app mints has.
    fn staffed(scope: &'static str, v: Option<i64>) -> Claimset<'static> {
        Claimset {
            scope,
            sub: "dev_counter",
            name: "Counter tablet",
            staff: Some("stf_admin"),
            sname: Some(STAFF_NAME),
            role: Some("admin"),
            v,
        }
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
        let claims = staffed(scope::SESSION, Some(3));
        let session = sign_token_at(ISSUED_AT_MS, SECRET, &claims, SESSION_TTL_SECONDS).unwrap();
        assert_eq!(session, SESSION_TOKEN);
        assert_eq!(
            body_of(&session),
            r#"{"scope":"session","sub":"dev_counter","name":"Counter tablet","staff":"stf_admin","sname":"မောင်မောင်","role":"admin","v":3,"exp":1707776000}"#
        );

        // An SSE ticket: the same two claims, no `v` key at all, and a
        // two-minute life.
        let claims = staffed(scope::SSE, None);
        let ticket = sign_token_at(ISSUED_AT_MS, SECRET, &claims, SSE_TICKET_TTL_SECONDS).unwrap();
        assert_eq!(
            ticket,
            "eyJzY29wZSI6InNzZSIsInN1YiI6ImRldl9jb3VudGVyIiwibmFtZSI6IkNvdW50ZXIgdGFibGV0Iiwic3RhZm\
             YiOiJzdGZfYWRtaW4iLCJzbmFtZSI6IuGAmeGAseGArOGAhOGAuuGAmeGAseGArOGAhOGAuiIsInJvbGUiOiJh\
             ZG1pbiIsImV4cCI6MTcwMDAwMDEyMH0.0Q-KWdSOO-7nc4KiGkyTKIgkMpGios8L8rpIZnyHZoE"
        );
        assert_eq!(
            body_of(&ticket),
            r#"{"scope":"sse","sub":"dev_counter","name":"Counter tablet","staff":"stf_admin","sname":"မောင်မောင်","role":"admin","exp":1700000120}"#
        );
    }

    /// A claimed tablet with nobody on it — the state every tablet is in at
    /// opening time, and between one waiter signing out and the next signing
    /// in.
    ///
    /// The three staff keys are not in the body at all: not `null`, not empty
    /// strings, absent. That is `skip_serializing_if` reproducing what
    /// `JSON.stringify` did with an undefined value, and it is the reason the
    /// readers treat "no key" as the ordinary case rather than as damage.
    #[test]
    fn omits_the_staff_claim_entirely() {
        let token = sign_token_at(
            ISSUED_AT_MS,
            SECRET,
            &Claimset {
                scope: scope::SESSION,
                sub: "dev_counter",
                name: "Counter tablet",
                staff: None,
                sname: None,
                role: None,
                v: Some(1),
            },
            SESSION_TTL_SECONDS,
        )
        .unwrap();
        assert_eq!(
            token,
            "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJkZXZfY291bnRlciIsIm5hbWUiOiJDb3VudGVyIHRhYmxldCIsIn\
             YiOjEsImV4cCI6MTcwNzc3NjAwMH0.EpzR9nRwvM8nvp2woti4jhSsGokyq0RRmpnPVUUuKV4"
        );
        assert_eq!(
            body_of(&token),
            r#"{"scope":"session","sub":"dev_counter","name":"Counter tablet","v":1,"exp":1707776000}"#
        );

        let claims = verify_token_at(1_700_000_100_000.0, SECRET, Some(&token), scope::SESSION)
            .unwrap()
            .expect("a device-only token is a perfectly good token");
        assert_eq!(claims.sub(), Some("dev_counter"));
        assert_eq!(claims.staff(), None);
        assert_eq!(claims.staff_name(), None);
        assert_eq!(claims.role(), None);
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
                sub: "dev_1",
                name: "A \"B\" \\ C\n\tD\u{1} ⚽😀",
                staff: Some("stf_1"),
                sname: Some(STAFF_NAME),
                role: Some("waiter"),
                v: Some(0),
            },
            SESSION_TTL_SECONDS,
        )
        .unwrap();
        assert_eq!(
            token,
            "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJkZXZfMSIsIm5hbWUiOiJBIFwiQlwiIFxcIENcblx0RFx1MDAwMS\
             Dimr3wn5iAIiwic3RhZmYiOiJzdGZfMSIsInNuYW1lIjoi4YCZ4YCx4YCs4YCE4YC64YCZ4YCx4YCs4YCE4YC6\
             Iiwicm9sZSI6IndhaXRlciIsInYiOjAsImV4cCI6MTcwNzc3NjAwMH0.ibctIZKfo4yIGrbif0Zu54XKqKtCWf\
             F0MqSitoSBbYE"
        );
    }

    /// The key is the secret's UTF-8 bytes, whatever they happen to be.
    #[test]
    fn signs_with_non_ascii_and_oversized_secrets() {
        let claims = Claimset {
            scope: scope::SESSION,
            sub: "dev_1",
            name: "n",
            staff: Some("stf_1"),
            sname: Some("s"),
            role: Some("cashier"),
            v: Some(2),
        };
        assert_eq!(
            sign_token_at(ISSUED_AT_MS, &"k".repeat(65), &claims, SESSION_TTL_SECONDS).unwrap(),
            "eyJzY29wZSI6InNlc3Npb24iLCJzdWIiOiJkZXZfMSIsIm5hbWUiOiJuIiwic3RhZmYiOiJzdGZfMSIsInNuYW\
             1lIjoicyIsInJvbGUiOiJjYXNoaWVyIiwidiI6MiwiZXhwIjoxNzA3Nzc2MDAwfQ.Vm7HgMyp2mO0CZry5DUnp\
             2RfPtuJQxikzeQLcsuzZfE"
        );

        let ticket = Claimset {
            scope: scope::SSE,
            sub: "dev_1",
            name: "n",
            staff: None,
            sname: None,
            role: None,
            v: None,
        };
        assert_eq!(
            sign_token_at(ISSUED_AT_MS, "sécret-⚽", &ticket, SSE_TICKET_TTL_SECONDS).unwrap(),
            "eyJzY29wZSI6InNzZSIsInN1YiI6ImRldl8xIiwibmFtZSI6Im4iLCJleHAiOjE3MDAwMDAxMjB9.mF5DD0I4N\
             bVRYYK8-SLItKh-_xtxHjxU6yPuN7N3Upw"
        );
    }

    /// A token minted here verifies here, and the claims come back whole.
    #[test]
    fn verifies_its_own_tokens() {
        let now = 1_700_000_100_000.0;

        let claims = verify_token_at(now, SECRET, Some(SESSION_TOKEN), scope::SESSION)
            .unwrap()
            .expect("a good token verifies");
        assert_eq!(claims.sub(), Some("dev_counter"));
        assert_eq!(claims.name(), "Counter tablet");
        assert_eq!(claims.staff(), Some("stf_admin"));
        assert_eq!(claims.staff_name(), Some(STAFF_NAME));
        assert_eq!(claims.role(), Some("admin"));
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
            &Claimset {
                scope: scope::SESSION,
                sub: "dev_1",
                name: "n",
                staff: None,
                sname: None,
                role: None,
                v: None,
            },
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
            base64::b64url_encode(br#"{"scope":"session","sub":"d1","extra":[1,2],"exp":2000000000}"#);
        let token = format!("{body}.{}", hmac(SECRET, &body).unwrap());
        let claims = verify_token_at(0.0, SECRET, Some(&token), scope::SESSION).unwrap().unwrap();
        assert_eq!(claims.0["extra"], serde_json::json!([1, 2]));

        // `exp` as a string is not a number.
        let body = base64::b64url_encode(br#"{"scope":"session","sub":"d1","exp":"2000000000"}"#);
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

        assert_eq!(claims(r#"{"name":null}"#).name(), "");
        assert_eq!(claims("{}").name(), "");

        assert_eq!(claims(r#"{"sub":""}"#).sub(), None, "the empty string is falsy");
        assert_eq!(claims(r#"{"sub":null}"#).sub(), None);
        assert_eq!(claims(r#"{"sub":"d1"}"#).sub(), Some("d1"));

        // The staff claim, read the same way. Absent is the resting state of a
        // tablet rather than a fault, which is why none of these is an error.
        assert_eq!(claims("{}").staff(), None, "nobody is signed in");
        assert_eq!(claims(r#"{"staff":null}"#).staff(), None);
        assert_eq!(claims(r#"{"staff":""}"#).staff(), None);
        assert_eq!(claims(r#"{"staff":123}"#).staff(), None, "a number is not an id");
        assert_eq!(claims(r#"{"staff":"stf_1"}"#).staff(), Some("stf_1"));

        assert_eq!(claims("{}").staff_name(), None);
        assert_eq!(claims(r#"{"sname":""}"#).staff_name(), None);
        assert_eq!(claims(r#"{"sname":"Su"}"#).staff_name(), Some("Su"));

        assert_eq!(claims("{}").role(), None);
        assert_eq!(claims(r#"{"role":"admin"}"#).role(), Some("admin"));
        // Reading is not checking: an unknown role is a string that will match
        // nothing in `require_role`, which is where the list lives.
        assert_eq!(claims(r#"{"role":"chef"}"#).role(), Some("chef"));
    }

    #[test]
    fn prefers_the_bearer_then_falls_back_to_the_cookie() {
        let cookie = Some("pos_token=from_cookie");

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

        assert_eq!(read("pos_token=abc"), Some("abc"));
        assert_eq!(read("a=1; pos_token = abc ; b=2"), Some("abc"));
        assert_eq!(read("\tpos_token\t=\tabc\t"), Some("abc"));
        assert_eq!(read("pos_token=one; pos_token=two"), Some("one"), "first match wins");
        assert_eq!(read("junk; pos_token=abc"), Some("abc"), "a part without = is skipped");
        assert_eq!(read("pos_token=a=b=c"), Some("a=b=c"), "only the first = splits");
        assert_eq!(read("pos_token="), Some(""));
        assert_eq!(read("pos_token=\"abc\""), Some("\"abc\""), "quotes are not stripped");
        assert_eq!(read("other=1"), None);
        assert_eq!(read(""), None);
        assert_eq!(read_cookie(None, COOKIE_NAME), None);
    }

    #[test]
    fn builds_and_clears_the_cookie() {
        assert_eq!(
            build_cookie("abc", SESSION_TTL_SECONDS),
            "pos_token=abc; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=7776000"
        );
        assert_eq!(revoke(), "pos_token=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0");
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

    /// The PIN hashes, taken from the same node script as the tokens. Same MAC,
    /// same key, same base64url — so if the two implementations ever drift,
    /// every PIN in the restaurant stops working on the same deploy, and this
    /// is the test that says so first.
    #[test]
    fn hashes_pins_the_way_node_does() {
        assert_eq!(
            pin_hash(SECRET, "stf_admin", "1234").unwrap(),
            "SbFdT74YMGyg4cs9DmUWC4VPjcz2EhdXZc1lFjXboBU"
        );
        // 32 bytes of MAC, base64url, unpadded: the 43 characters a token
        // signature also is.
        assert_eq!(pin_hash(SECRET, "stf_admin", "1234").unwrap().len(), 43);

        // The same four digits chosen by somebody else. The id is in the
        // message, so the column cannot see that the two people picked the same
        // PIN — which is why the backoffice has to check, and why no unique
        // index would have helped.
        assert_eq!(
            pin_hash(SECRET, "stf_waiter", "1234").unwrap(),
            "QbxrK9CVouHn27-YdM0eiaxmwAxY8cLOiuhLEetxoQQ"
        );
        // And the same person changing theirs.
        assert_eq!(
            pin_hash(SECRET, "stf_admin", "4321").unwrap(),
            "04QB7qZMmWHfN8XlAsvGjZ90tTox6KRoVESso0CIuuQ"
        );

        // No `AUTH_SECRET`, no answer — the same 500 a token gets, rather than
        // a confident "that PIN is wrong".
        assert_eq!(pin_hash("", "stf_admin", "1234").unwrap_err().status, 500);
    }

    /// The message is `staff_id || pin` with nothing between them, and that is
    /// only unambiguous because a PIN is exactly four digits: the last four
    /// characters are the PIN and everything before them is the id.
    ///
    /// Here is the collision that rule is keeping out — two different people,
    /// two different "PINs", one message and therefore one hash. `pinSchema`
    /// (`/^\d{4}$/`) is what stops the five-digit one ever reaching here, so
    /// the rule lives at the boundary and this test is what says why it must.
    #[test]
    fn the_fixed_pin_length_is_what_makes_concatenation_safe() {
        assert_eq!(
            pin_hash(SECRET, "stf_a", "11234").unwrap(),
            pin_hash(SECRET, "stf_a1", "1234").unwrap()
        );
    }

    #[test]
    fn verifies_pins_against_the_stored_hash() {
        let stored = pin_hash(SECRET, "stf_admin", "1234").unwrap();

        assert!(verify_pin(SECRET, "stf_admin", "1234", &stored).unwrap());
        assert!(!verify_pin(SECRET, "stf_admin", "4321", &stored).unwrap());
        // Right digits, wrong person: `/staff/switch` walks every active row
        // with the same four digits, and only one of them can match.
        assert!(!verify_pin(SECRET, "stf_waiter", "1234", &stored).unwrap());
        // Another key cannot reproduce it, which is the entire point of keying
        // it — and is also why rotating `AUTH_SECRET` retires every PIN.
        assert!(!verify_pin("other", "stf_admin", "1234", &stored).unwrap());
        // A row with no PIN set, if a caller passes it here instead of skipping
        // it. It can never match, which is the behaviour `0001_init.sql`
        // describes for a NULL `pin_hash`.
        assert!(!verify_pin(SECRET, "stf_admin", "1234", "").unwrap());
    }

    /// The lifetimes, spelled out so a typo in the arithmetic cannot pass.
    #[test]
    fn keeps_the_documented_lifetimes() {
        assert_eq!(SESSION_TTL_SECONDS, 7_776_000);
        assert_eq!(SSE_TICKET_TTL_SECONDS, 120);
        assert_eq!(CLAIM_TTL_MS, 604_800_000.0);
    }
}
