//! Who the caller is, and what they are allowed to reach.
//!
//! Ported from `src/middleware.ts`. The CORS half of that file lives in
//! `cors.rs` and the per-request pub/sub with the realtime seam; what is left
//! is the three gates the routes hang off, and the `Identity` they produce.

use serde::{Deserialize, Serialize};
use worker::{Env, Request};

use crate::db;
use crate::http::{self, ApiResult};
use crate::identity;

/// The caller, as every route sees them.
///
/// `GET /auth/me` answers with this object verbatim, so the field order is the
/// order of the object literal the original built and is part of the API.
/// `/auth/claim` and the claim-link routes construct the same shape in the same
/// order from a member row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub member_id: String,
    pub name: String,
    pub is_organizer: bool,
    pub language: String,
    pub hour12: bool,
    pub approved: bool,
}

/// The one column the revocation check reads. Optional so that a row without a
/// value reads as absent rather than as a deserialization failure, which is
/// what `current?.token_version ?? 1` did.
#[derive(Deserialize)]
struct TokenVersionRow {
    token_version: Option<i64>,
}

/// Require a signed-in member.
///
/// The token carries the member's name and role, but they are re-read from the
/// database on every request: a token is valid for 90 days, and someone removed
/// from the group — or demoted from organizer — must lose access now, not in
/// three months.
pub async fn require_member(req: &Request, env: &Env) -> ApiResult<Identity> {
    let Some(resolved) = identity::authenticate(req, env).await? else {
        return Err(http::unauthorized_default());
    };

    let db_handle = crate::env::db(env)?;

    // `get_member_by_id` filters on `active = 1`: an inactive member reads as
    // absent, which is what makes removing somebody take effect at once.
    let Some(member) = db::get_member_by_id(&db_handle, &resolved.member_id).await? else {
        return Err(http::unauthorized("Your account is no longer active"));
    };

    // Revocation. The row is already loaded to re-check membership, so cutting
    // off a lost phone costs nothing extra.
    let current: Option<TokenVersionRow> = db_handle
        .prepare("SELECT token_version FROM members WHERE id = ?1")
        .bind(&[member.id.as_str().into()])?
        .first(None)
        .await?;
    // No row — this second read has no `active = 1` filter but the row can
    // still have gone between the two queries — counts as version 1, the
    // column's default and what a token minted before revocation existed
    // resolves to.
    let current_version = current.and_then(|row| row.token_version).unwrap_or(1);
    if current_version != resolved.token_version {
        return Err(http::unauthorized("This device was signed out. Ask for a new link."));
    }

    Ok(Identity {
        member_id: member.id,
        name: member.name,
        is_organizer: member.is_organizer,
        language: member.language,
        hour12: member.hour12,
        approved: member.approved_at.is_some(),
    })
}

/// Everything except finding out that you are still waiting.
///
/// Somebody who added themselves from the group link holds a real token — they
/// have to, or they could not be told anything — so the waiting room is a
/// server-side gate, not a screen the client politely shows. Re-read on every
/// request like membership and role, so approving somebody takes effect at once
/// and so does changing your mind before they have done anything.
///
/// Runs after [`require_member`]: it takes the identity that call produced, so
/// the ordering the original could only ask for in a doc comment is the
/// signature here.
pub fn require_approved(identity: &Identity) -> ApiResult<()> {
    if !identity.approved {
        return Err(http::forbidden("The organizer has not let you in yet."));
    }
    Ok(())
}

/// Runs after [`require_member`], for the same reason.
pub fn require_organizer(identity: &Identity) -> ApiResult<()> {
    if !identity.is_organizer {
        return Err(http::forbidden_default());
    }
    Ok(())
}
