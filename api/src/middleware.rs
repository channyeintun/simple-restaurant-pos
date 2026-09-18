//! Who the caller is, and what they are allowed to reach.
//!
//! Adapted from the reference Worker's `middleware.rs`, which ported it from
//! `src/middleware.ts`. The CORS half of that file lives in `cors.rs` and the
//! per-request pub/sub with the realtime seam; what is left is the gates the
//! routes hang off, and the [`Identity`] they produce.
//!
//! Three gates, as in the reference, but cut in a different place, because this
//! app's credential has two halves. A tablet is claimed once by an admin and
//! stays claimed for the ninety days a token lasts; the person holding it
//! changes several times a shift and says who they are with four digits. So
//! [`require_device`] says the tablet is still ours, [`require_staff`] says
//! somebody has tapped their PIN on it, and [`require_role`] says which
//! somebody. Routes name the gate they need and never read a claim themselves.

use serde::{Deserialize, Serialize};
use worker::{Env, Request};

use crate::http::{self, ApiResult};
use crate::identity;

/// The caller, as every route sees them.
///
/// Two claims, not one. The device is the credential — the tablet an admin
/// claimed once with a single-use link, and the only reason a stranger with a
/// phone cannot reach any of this — and the staff member is whoever is standing
/// at it now, which may be nobody.
///
/// `GET /auth/me` answers with this object under `identity`, and `/auth/claim`,
/// `/staff/switch` and `/staff/signout` all answer with it under that same key,
/// so **the field order here is the field order on the wire**: `deviceId`,
/// `deviceName`, `staffId`, `staffName`, `role`, matching `identitySchema` in
/// `shared/src/models.ts` key for key.
///
/// The three staff fields serialize as `null` when nobody is signed in, never
/// as missing keys. The token does the opposite and omits them, and the
/// contrast is deliberate: a token is bytes on a wire, where a key that means
/// nothing should not be at all, whereas this is an object a client
/// destructures — and a key that comes and goes is the kind of thing that
/// type-checks on Tuesday and throws on Friday.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub device_id: String,
    pub device_name: String,
    pub staff_id: Option<String>,
    pub staff_name: Option<String>,
    pub role: Option<String>,
}

/// The device columns the gate reads, and nothing else.
///
/// Local to this file rather than taken from `db.rs` on purpose: this query
/// runs on every authenticated request in the app, and a row type shared with
/// the routes is a row type that grows columns the gate has no business
/// loading. Keeping the shape beside the statement that fills it also means the
/// authentication path can be read in one screen.
#[derive(Deserialize)]
struct DeviceAuthRow {
    id: String,
    name: String,
    /// Optional so that a row without a value reads as absent rather than as a
    /// deserialization failure, which is what `current?.token_version ?? 1`
    /// did. The column is `NOT NULL DEFAULT 1`, so this is cover for a
    /// hand-edited database rather than for the schema.
    token_version: Option<i64>,
}

/// The staff columns the gate reads. `pin_hash` is not among them, and never is
/// anywhere outside `POST /staff/switch`.
#[derive(Deserialize)]
struct StaffAuthRow {
    id: String,
    name: String,
    role: String,
}

/// Require a claimed device, and resolve whoever is signed in on it.
///
/// Both halves of the token are re-read from the database here rather than
/// trusted as claims. A token is valid for ninety days, and everything it says
/// was true when it was minted: the tablet that walked out of the restaurant
/// this morning, the waiter who left last week, the cashier demoted to waiter
/// an hour ago. The read is what makes any of those take effect now instead of
/// in three months, and it costs one statement on a request that is about to
/// run several.
pub async fn require_device(req: &Request, env: &Env) -> ApiResult<Identity> {
    let Some(resolved) = identity::authenticate(req, env).await? else {
        return Err(http::unauthorized_default());
    };

    let db_handle = crate::env::db(env)?;

    // One statement where the reference used two. Its first read filtered
    // `active = 1` through a `db.rs` helper and its second fetched the
    // revocation counter; `devices` has no `active` column — a tablet is cut
    // off by bumping `token_version`, not by being struck off — so "does this
    // device still exist" and "is this token still current" are one read.
    let device: Option<DeviceAuthRow> = db_handle
        .prepare("SELECT id, name, token_version FROM devices WHERE id = ?1")
        .bind(&[resolved.device_id.as_str().into()])?
        .first(None)
        .await?;
    let Some(device) = device else {
        return Err(http::unauthorized("This device is no longer registered"));
    };

    // Revocation. The version is carried in the token as `v` and bumping the
    // column signs this tablet out everywhere, which is the only thing to be
    // done about one left in a taxi. A missing value counts as version 1, the
    // column's own default and what a token minted before the column existed
    // resolves to.
    let current_version = device.token_version.unwrap_or(1);
    if current_version != resolved.token_version {
        return Err(http::unauthorized("This device was signed out. Ask for a new link."));
    }

    // The staff claim, resolved the same way and for the same reason. The
    // filter is `active = 1`, so somebody who has left reads as absent.
    //
    // A staff row that has gone leaves the three staff fields `None` rather
    // than failing the request, and that difference matters on a Saturday
    // night: nothing has happened to the device credential, so the tablet is
    // still ours and simply has nobody standing at it — which is the PIN
    // screen, two seconds away. A 401 would send it back to the claim screen
    // instead, where it needs an admin and a freshly minted link, because
    // somebody edited a staff row in the backoffice.
    let mut staff: Option<StaffAuthRow> = None;
    if let Some(staff_id) = resolved.staff_id.as_deref() {
        staff = db_handle
            .prepare("SELECT id, name, role FROM staff WHERE id = ?1 AND active = 1")
            .bind(&[staff_id.into()])?
            .first(None)
            .await?;
    }
    // The three move together or stay absent together: there is no state in
    // which a name is known and an id is not.
    let (staff_id, staff_name, role) = match staff {
        Some(staff) => (Some(staff.id), Some(staff.name), Some(staff.role)),
        None => (None, None, None),
    };

    Ok(Identity {
        device_id: device.id,
        device_name: device.name,
        staff_id,
        staff_name,
        role,
    })
}

/// Require that somebody has tapped their PIN on this device.
///
/// Runs after [`require_device`]: it takes the identity that call produced, so
/// the ordering the original could only ask for in a doc comment is the
/// signature here.
///
/// 403 and not 401, and the difference is the entire point of having two
/// claims. A 401 says the tablet's own credential is gone and it has to be
/// claimed again — an admin, a link, and a walk to the counter. A 403 with a
/// device still attached says the tablet is fine and nobody is signed in on it,
/// which the client answers by showing the PIN screen to the person already
/// standing in front of it.
pub fn require_staff(identity: &Identity) -> ApiResult<()> {
    if identity.staff_id.is_none() {
        return Err(http::forbidden("Tap your PIN to sign in first"));
    }
    Ok(())
}

/// Require one of `allowed`, which are `staff.role` strings — the same three
/// the `CHECK` constraint in `0001_init.sql` permits, because a role named here
/// that the column would refuse is a typo nothing else would catch.
///
/// The nobody-signed-in case is answered by [`require_staff`] rather than here,
/// so an admin-only route tapped on a tablet with no one on it says "tap your
/// PIN" instead of "your role does not allow that" — which would be unhelpful
/// and also untrue, since the caller has no role at all.
pub fn require_role(identity: &Identity, allowed: &[&str]) -> ApiResult<()> {
    require_staff(identity)?;
    match identity.role.as_deref() {
        Some(role) if allowed.contains(&role) => Ok(()),
        _ => Err(http::forbidden_default()),
    }
}
