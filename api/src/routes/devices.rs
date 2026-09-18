//! The tablets: `/devices`.
//!
//! Every path here is admin-only, because every one of them is about which
//! slabs of glass in the building are allowed to take orders. Adding a device,
//! minting the link that sets one up, and cutting one off are the three things
//! a manager does about hardware, and they are the whole of this file.
//!
//! ## The other half of this is in `routes/auth.rs`, and it has to be
//!
//! `POST /auth/claim` *redeems* a link and runs before the device gate, because
//! redeeming one is how a tablet gets a credential in the first place. Minting
//! one runs behind the gate, on a device that already has a credential and
//! whose holder is an admin. The two halves are on opposite sides of
//! `require_device` in `lib.rs` for exactly that reason, and the nonce is what
//! passes between them: a row in the database rather than a signed token, so
//! that spending a link is `SET claim_nonce = NULL` and minting one needs no
//! secret at all.
//!
//! ## The link is shown once and then it is gone
//!
//! The response to a mint is the only copy of the nonce that ever leaves the
//! database. It is not stored anywhere else, cannot be read back, and is not in
//! [`db::Device`] — what a list may say is whether an invitation is outstanding,
//! not what it says. Losing one is therefore harmless: mint another, which also
//! replaces the first, because `claim_nonce` is a single column on the device.
//! That is the behaviour wanted when somebody says "send it again".

use worker::{Env, Method, Request, Response};

use crate::db;
use crate::http::{self, ApiResult};
use crate::identity;
use crate::middleware::{self, Identity};
use crate::validate::{self, Str};

/// The roles that may hand out hardware. One.
const ADMINS: &[&str] = &["admin"];

/// How long a claim link lasts.
///
/// Seven days, the same as `scripts/bootstrap-link.mjs` mints, and the two have
/// to agree because they are the same thing arriving by different roads — a
/// link from the console and a link from the backoffice should not behave
/// differently in the hands of whoever opens it.
///
/// Long because of how it is actually used: an admin reads the URL out over the
/// phone, or sends it in a message, to somebody who will set the tablet up when
/// they next have a free ten minutes. Short enough that a link forgotten in a
/// chat thread stops working before the month is out. It is single-use as well
/// as timed, so the window is what protects a link that was *never* opened,
/// which is the only kind that lingers.
const CLAIM_LINK_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let mut segments = path.split('/').skip(1);
    if segments.next() != Some("devices") {
        return None;
    }
    let id = segments.next();
    let action = segments.next();
    if segments.next().is_some() {
        return None;
    }

    Some(match (req.method(), id, action) {
        (Method::Get, None, None) => list(env, identity).await,
        (Method::Post, None, None) => create(req, env, identity).await,
        (Method::Post, Some(id), Some("claim-link")) => claim_link(env, identity, id).await,
        (Method::Post, Some(id), Some("revoke")) => revoke(env, identity, id).await,
        _ => return None,
    })
}

/// Every tablet, unclaimed ones first.
async fn list(env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_role(identity, ADMINS)?;
    let db_handle = crate::env::db(env)?;
    Ok(Response::from_json(&db::list_devices(&db_handle).await?)?)
}

/// Add a tablet. A name, and nothing else.
///
/// The row lands unclaimed with no link on it, because a device and an
/// invitation have different lifetimes: the invitation expires and is reissued,
/// often more than once, while the tablet it names is the same tablet for as
/// long as it is in the building. Minting the first link is the next call, and
/// it is a separate one so that "add the new tablet to the list" and "set it up
/// now" can happen days apart.
async fn create(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_role(identity, ADMINS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    let name = body.string("name", &Str::name(40, "Device name is required"))?;

    let db_handle = crate::env::db(env)?;
    let row: Option<db::DeviceRow> = db_handle
        .prepare(
            "INSERT INTO devices (id, name)
        VALUES (?1, ?2)
        RETURNING *",
        )
        .bind(&[db::text(&http::new_id("dev")), db::text(&name)])?
        .first(None)
        .await?;

    match row {
        Some(row) => Ok(Response::from_json(&db::to_device(&row))?.with_status(201)),
        None => Err(http::internal()),
    }
}

/// Mint a single-use link for this tablet, and show it once.
///
/// Issuing a link implicitly revokes the previous one, because `claim_nonce` is
/// one column and this overwrites it. That is the behaviour the situation
/// actually calls for: the reason somebody asks for a second link is that the
/// first went astray.
///
/// A tablet that is already claimed can be given a new link and that is
/// deliberate — it is what a wiped or replaced device needs, and `claimed_at`
/// survives it via the `COALESCE` in `routes/auth.rs`, so the date a tablet
/// entered service stays the first one.
async fn claim_link(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    middleware::require_role(identity, ADMINS)?;

    let nonce = identity::new_claim_nonce();
    let expires_at = http::iso_of(crate::js::now_ms() + CLAIM_LINK_TTL_MS);

    let db_handle = crate::env::db(env)?;
    let row: Option<db::DeviceRow> = db_handle
        .prepare(
            "UPDATE devices
        SET claim_nonce = ?2,
            claim_expires_at = ?3
        WHERE id = ?1
        RETURNING *",
        )
        .bind(&[db::text(id), db::text(&nonce), db::text(&expires_at)])?
        .first(None)
        .await?;

    let Some(row) = row else {
        return Err(http::not_found("No such device"));
    };

    // The nonce rides in the **fragment**. Browsers never send a fragment to a
    // server, so the one-use credential stays out of access logs, proxy logs
    // and `Referer` headers on its way to the tablet that will spend it. The
    // claim page reads it with `platform.navigation.hash()` and posts it.
    //
    // `APP_URL` is the Worker's var rather than anything the caller said,
    // because the admin minting this is standing at a different screen from the
    // tablet that will open it, and a URL built from the requesting origin
    // would be whatever that screen happened to be served from.
    let app_url = crate::env::app_url(env);
    let base = app_url.trim_end_matches('/');
    let link = ClaimLink {
        url: format!("{base}/claim#{nonce}"),
        expires_at,
        device_name: row.name,
    };
    Ok(Response::from_json(&link)?.with_status(201))
}

/// Cut a tablet off: bump `token_version` and every token it holds stops
/// working on the next request.
///
/// This is the answer to a device left in a taxi, and it is the only one —
/// tokens are stateless and last ninety days, so there is nothing to delete. It
/// is not a delete of the device either: the row stays, the name stays, and the
/// same tablet can be set up again with a fresh link, which is what happens
/// when it turns up in the lost property box on Monday.
///
/// Any outstanding claim link is cleared at the same time. A link minted before
/// somebody decided to cut this tablet off is a link that would undo the
/// decision, quietly, in whoever's hands it reached.
async fn revoke(env: &Env, identity: &Identity, id: &str) -> ApiResult<Response> {
    middleware::require_role(identity, ADMINS)?;

    // An admin cutting off the tablet they are standing at would sign
    // themselves out mid-sentence and need another admin, on another tablet, to
    // undo it. Refusing is kinder than the 401 that would otherwise arrive on
    // the very next request, and it says which device it is refusing to touch.
    if identity.device_id == id {
        return Err(http::conflict("That is this tablet. Sign it out from another device."));
    }

    let db_handle = crate::env::db(env)?;
    let row: Option<db::DeviceRow> = db_handle
        .prepare(
            "UPDATE devices
        SET token_version = token_version + 1,
            claim_nonce = NULL,
            claim_expires_at = NULL
        WHERE id = ?1
        RETURNING *",
        )
        .bind(&[db::text(id)])?
        .first(None)
        .await?;

    match row {
        Some(row) => Ok(Response::from_json(&db::to_device(&row))?),
        None => Err(http::not_found("No such device")),
    }
}

/// `claimLinkSchema` — `url`, `expiresAt`, `deviceName`, in that order.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimLink {
    url: String,
    expires_at: String,
    device_name: String,
}
