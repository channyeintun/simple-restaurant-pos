//! D1 access: row shapes, mappers, and the reads that more than one route
//! needs. Single-table CRUD stays inline in the routes.
//!
//! Every row type mirrors its table exactly (snake_case, 0/1 booleans, ISO
//! strings) and is converted at the boundary, so nothing downstream has to know
//! how SQLite spells things.
//!
//! Adapted from the reference Worker's `db.rs`. What survives is the shape of
//! the file rather than any of its queries: a rows section, a mapped-values
//! section, the mappers between them, the reads, and the bind primitives at the
//! bottom. The futsal domain — sessions, registrations, the leaderboard, the
//! cursors — is gone, because none of it is a restaurant.
//!
//! The statement text is formatted the way the reference formats it: keywords
//! right-aligned, one clause a line, `?N` numbered in bind order. The queries
//! are the contract with the database, and a reformatted one is a different
//! thing to read against a `wrangler d1` console at midnight.
//!
//! The mapped structs are what the routes serialize, so **field order is output
//! order**: each is declared in the order `shared/src/models.ts` declares the
//! schema it answers, not the order the columns came back in.
//!
//! This file is milestone 0's share of the schema — devices and staff, which is
//! everything the two ways in need. Tables, the catalogue, checks, rounds,
//! items, payments and print jobs arrive with the milestones that read them.

use std::future::Future;

use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use worker::d1::D1Database;
use worker::Result as WorkerResult;

/* ------------------------------------------------------------------- rows */

/// One tablet, exactly as `devices` holds it.
///
/// All six columns, including the three that never reach a client: the
/// outstanding nonce, its expiry, and the revocation counter. A row type that
/// mirrors its table is a row type nobody has to check against the schema
/// before writing a query, and the mapped [`Device`] below is where the columns
/// stop.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceRow {
    pub id: String,
    pub name: String,
    pub claimed_at: Option<String>,
    pub claim_nonce: Option<String>,
    /// Nothing on this side reads it: whether a link has expired is decided in
    /// the `WHERE` clause of the one statement that looks a nonce up, which is
    /// where a comparison between two timestamps belongs. It is declared anyway
    /// because the row mirrors the table, and a column this type does not
    /// mention is a column the next person has to go and look up.
    #[allow(dead_code)]
    pub claim_expires_at: Option<String>,
    /// Compared against the token's `v` on every authenticated request, and
    /// carried into every token this Worker mints. It is the reason both device
    /// reads here hand back the row rather than the mapped value.
    pub token_version: i64,
}

/// Somebody who works here — and **not** their `pin_hash`.
///
/// This is the one row type in the file that does not mirror its table, and the
/// omission is the point. `pin_hash` is the single column in the schema that
/// must not leave the Worker; a struct that carries it is a struct that ends up
/// serialized into a response by somebody who was adding a field to a screen
/// and had no idea it was in there. The hash has its own two-field row type
/// below, read by one statement, in one route.
#[derive(Debug, Clone, Deserialize)]
pub struct StaffRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub active: i64,
    pub created_at: String,
}

/// The two columns `POST /staff/switch` compares against, and nothing else.
///
/// Both of them stay inside that handler: the id because it is half the HMAC
/// message, and the hash because it is the other half's answer. Neither is
/// serialized anywhere, which is why this type derives `Deserialize` alone —
/// `Serialize` on it would be a loaded gun on a shelf.
///
/// `pin_hash` is `String` rather than `Option<String>` because the read filters
/// the NULLs out in SQL. A staff row with no PIN set cannot match four digits
/// no matter what is computed for it, so it is cheaper and clearer to leave it
/// in the database than to carry it here and skip it.
#[derive(Debug, Clone, Deserialize)]
pub struct StaffPinRow {
    pub id: String,
    pub pin_hash: String,
}

/* --------------------------------------------------------- mapped values */

/// A tablet, as the backoffice device list will show it: `deviceSchema` in
/// `shared/src/models.ts`, field for field and in that order.
///
/// The nonce is not here and never will be. It exists in the link and in the
/// row, and a third copy is a third place it can leak from; what a list needs
/// to know is only whether an invitation is still outstanding, which is the
/// boolean below.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub claimed_at: Option<String>,
    pub has_pending_link: bool,
}

/// A member of staff, as `staffSchema` declares them.
///
/// `role` stays a plain string rather than becoming an enum, the way the
/// reference let `status` stay one: the `CHECK` constraint in `0001_init.sql`
/// is what decides which three values exist, and a value SQLite somehow held
/// should travel out unaltered rather than be rejected here, where the reader
/// would have no idea what happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staff {
    pub id: String,
    pub name: String,
    pub role: String,
    pub active: bool,
    pub created_at: String,
}

/// What `GET /staff` answers with: `staffNameSchema`, which is the three
/// columns the PIN screen draws a button out of.
///
/// One struct doing both jobs, which is the only place in this file that
/// happens. There is nothing to convert — three TEXT columns whose names are
/// single words, so the SQLite spelling and the JSON spelling are the same
/// string — and a row type, a mapped type and a mapper that copies three
/// `String`s between them would be ceremony rather than a boundary. The
/// `rename_all` every other mapped value carries is deliberately absent for the
/// same reason: there is nothing to rename, and the attribute would imply the
/// columns are camelCase, which they are not.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StaffName {
    pub id: String,
    pub name: String,
    pub role: String,
}

/* ---------------------------------------------------------------- mappers */

/// Not called yet: the device list is a backoffice screen and the backoffice is
/// milestone 1. It is written now, beside the row it maps and the schema it
/// answers, because the three drifting apart is exactly what a mapper exists to
/// prevent — and because a mapper added at the same time as the screen that
/// needs it is a mapper written in a hurry.
#[allow(dead_code)]
pub fn to_device(row: &DeviceRow) -> Device {
    Device {
        id: row.id.clone(),
        name: row.name.clone(),
        claimed_at: row.claimed_at.clone(),
        // The nonce itself never leaves the server; the list only needs to know
        // whether an invitation is outstanding, so an admin can tell "waiting
        // to be set up" from "link sent, nobody has opened it".
        has_pending_link: row.claim_nonce.is_some(),
    }
}

pub fn to_staff(row: &StaffRow) -> Staff {
    Staff {
        id: row.id.clone(),
        name: row.name.clone(),
        role: row.role.clone(),
        active: row.active == 1,
        created_at: row.created_at.clone(),
    }
}

/* ------------------------------------------------------------- SQL pieces */

/// The columns of `staff` that may be read into a struct, written out because
/// the one that may not is the reason this constant exists.
///
/// `SELECT *` is used on `devices` a few lines down and refused here, and the
/// difference is `pin_hash`. On `devices` every column is either needed or
/// harmless in a row type that stays in the Worker; on `staff` a `*` is one
/// careless mapper away from putting the keyed hash of somebody's four digits
/// into a JSON response. Naming the columns means the database refuses to hand
/// it over in the first place, which is a better place for the rule to live
/// than in the discipline of whoever writes the next query.
const STAFF_COLUMNS: &str = "id, name, role, active, created_at";

/* ------------------------------------------------------------ basic reads */

/// The tablet behind a request, by id.
///
/// It hands back the **row** rather than the mapped [`Device`], because both
/// callers in this milestone want `token_version` — `/staff/switch` and
/// `/staff/signout` re-mint the device token with the staff claim added or
/// taken away, and a token minted without the current version would be signed
/// out by its own middleware on the next request. That column is one the mapped
/// value deliberately drops, so the read stops short of mapping and lets the
/// caller decide whether any of this is for a client.
///
/// There is no `active = 1` filter, unlike the reference's `get_member_by_id`,
/// because `devices` has no such column. A tablet is cut off by bumping
/// `token_version`, which `require_device` checks on every request; adding a
/// second way to say the same thing would mean two things to remember to do
/// when somebody leaves a tablet in a taxi.
pub async fn get_device_by_id(db: &D1Database, id: &str) -> WorkerResult<Option<DeviceRow>> {
    let row: Option<DeviceRow> = db
        .prepare("SELECT * FROM devices WHERE id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    Ok(row)
}

/// The device an unspent, unexpired claim link names.
///
/// `now` is the caller's timestamp rather than SQLite's `datetime()`, so that
/// the instant this request is treated as happening at is the same one written
/// into `claimed_at` a statement later. Both are ISO-8601 UTC text, which
/// SQLite compares lexicographically in true chronological order, so `>` is a
/// real expiry test and not a string curiosity.
///
/// A row that comes back has not been checked for anything else, because there
/// is nothing else to check: a device with no nonce has no link outstanding and
/// cannot match, and a device with a different nonce is a different device.
pub async fn get_device_by_claim_nonce(
    db: &D1Database,
    nonce: &str,
    now: &str,
) -> WorkerResult<Option<DeviceRow>> {
    let row: Option<DeviceRow> = db
        .prepare(
            "SELECT * FROM devices
              WHERE claim_nonce = ?1 AND claim_expires_at > ?2",
        )
        .bind(&[text(nonce), text(now)])?
        .first(None)
        .await?;
    Ok(row)
}

/// Somebody who still works here, by id. A struck-off row reads as absent,
/// which is what makes `active = 0` take effect on the next tap rather than
/// whenever a token happens to expire.
pub async fn get_staff_by_id(db: &D1Database, id: &str) -> WorkerResult<Option<Staff>> {
    let row: Option<StaffRow> = db
        .prepare(format!("SELECT {STAFF_COLUMNS} FROM staff WHERE id = ?1 AND active = 1"))
        .bind(&[text(id)])?
        .first(None)
        .await?;
    Ok(row.as_ref().map(to_staff))
}

/// Everybody still working here, for the PIN screen.
///
/// The one read of `staff` in the app that is not by id, and the only list a
/// tablet can see before anybody has signed in — so it is also the one that
/// would hurt most if it grew a column. Three columns, named, no `*`.
///
/// `idx_staff_active (active, name)` covers the filter. The ordering is
/// case-insensitive rather than the index's own byte order, because a list of
/// names is read by a person and byte order would put `Zaw` above `aung`; a
/// dozen rows is a sort SQLite does without noticing.
pub async fn list_staff(db: &D1Database) -> WorkerResult<Vec<StaffName>> {
    let results = db
        .prepare(
            "SELECT id, name, role FROM staff
              WHERE active = 1
              ORDER BY name COLLATE NOCASE ASC",
        )
        .all()
        .await?;
    let rows: Vec<StaffName> = results.results()?;
    Ok(rows)
}

/// Every active staff member who has a PIN set, as an id and a hash.
///
/// `POST /staff/switch` is given four digits and nothing else — there is no
/// "who are you" step before the keypad, deliberately, because tapping a name
/// and then a PIN is two taps at a counter with a queue at it. So the digits
/// are the identifier, and the only way to resolve them is to compute
/// `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` for each candidate and see which
/// one lands. The id is in the message so that two people who both chose 1234
/// get different hashes; that is what makes this a scan rather than a lookup,
/// and it is worth the scan.
///
/// `pin_hash IS NOT NULL` skips the rows that cannot match. A seeded or newly
/// created staff member starts with no hash — it can only be computed where
/// `AUTH_SECRET` is — and testing four digits against a NULL is arithmetic
/// nobody needs.
///
/// No `ORDER BY`. The caller tests every row it gets back and does not stop at
/// the first match, so the order they arrive in is not observable, in the
/// response or in the time it takes.
pub async fn staff_for_pin(db: &D1Database) -> WorkerResult<Vec<StaffPinRow>> {
    let results = db
        .prepare(
            "SELECT id, pin_hash FROM staff
              WHERE active = 1 AND pin_hash IS NOT NULL",
        )
        .all()
        .await?;
    let rows: Vec<StaffPinRow> = results.results()?;
    Ok(rows)
}

/* ------------------------------------------------------------- primitives */

/// A bound value. D1 takes JS values; text and number are all this file needs.
fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

/// No caller yet — every read in this milestone binds a string. It stays
/// because `text` without `number` beside it is half a pair, and the first
/// query that filters on a `sort`, a `qty` or a `price_minor` would otherwise
/// reach for `JsValue::from_f64` inline and start a second convention.
#[allow(dead_code)]
fn number(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

/// `Promise.all([a, b])` for two futures.
///
/// Rust futures do nothing until polled, so awaiting one and then the other
/// would turn a pair of independent reads into two round trips — which is the
/// cost the original went out of its way to avoid on the screens that use it.
/// Polling both from one future starts both requests before either is waited
/// on, which is what `Promise.all` did.
///
/// Nothing in milestone 0 reads two things at once; the cashier's screen, which
/// wants a check's rounds and its payments in one breath, is what this is here
/// for. It is carried across now rather than rewritten later because it is
/// subtle enough to get wrong the second time.
#[allow(dead_code)]
async fn both<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = Box::pin(a);
    let mut b = Box::pin(b);
    let mut first = None;
    let mut second = None;
    std::future::poll_fn(move |cx| {
        if first.is_none() {
            if let std::task::Poll::Ready(value) = a.as_mut().poll(cx) {
                first = Some(value);
            }
        }
        if second.is_none() {
            if let std::task::Poll::Ready(value) = b.as_mut().poll(cx) {
                second = Some(value);
            }
        }
        match (first.take(), second.take()) {
            (Some(one), Some(two)) => std::task::Poll::Ready((one, two)),
            (one, two) => {
                first = one;
                second = two;
                std::task::Poll::Pending
            }
        }
    })
    .await
}
