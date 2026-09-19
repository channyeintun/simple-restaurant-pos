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
//! The file is in the order the app grew into it: devices and staff, which is
//! everything the two ways in need; then the catalogue and the backoffice's
//! lists; then checks, rounds, items and payments, which are what a screen
//! reads rather than what a table holds; then the print queue.

use std::future::Future;

use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use worker::d1::D1Database;
use worker::Result as WorkerResult;

use pos_core::timing::{self, TimedLine};
use pos_core::totals::{self, CheckLine};

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

/// The roster, as the backoffice reads it — everybody, and whether they can
/// sign in.
///
/// `has_pin` is an `i64` because it is `pin_hash IS NOT NULL` computed in SQL
/// rather than a column, and SQLite answers a boolean expression with 0 or 1.
/// Doing it in the statement is what keeps the hash out of this struct: the
/// database answers the only question anybody may ask about a PIN and never
/// hands over the thing itself, so there is no field here for a careless
/// mapper to serialize.
#[derive(Debug, Clone, Deserialize)]
pub struct StaffRosterRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub active: i64,
    pub has_pin: i64,
    pub created_at: String,
}

/// A table in the room, exactly as `"tables"` holds it. Four columns, all of
/// them for the client.
#[derive(Debug, Clone, Deserialize)]
pub struct TableRow {
    pub id: String,
    pub name: String,
    pub sort: i64,
    pub active: i64,
}

/// One chip above the product grid.
#[derive(Debug, Clone, Deserialize)]
pub struct CategoryRow {
    pub id: String,
    pub name: String,
    pub sort: i64,
    pub active: i64,
}

/// A line on the menu. `price_minor` is the price *now*; what a customer is
/// charged is the copy taken onto the item when the round was sent.
#[derive(Debug, Clone, Deserialize)]
pub struct ProductRow {
    pub id: String,
    pub category_id: String,
    pub name: String,
    pub price_minor: i64,
    pub prep_minutes: i64,
    pub sort: i64,
    pub active: i64,
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

/// The roster row, as `staffRosterSchema` declares it: everything true about a
/// person now, then when they joined.
///
/// `hasPin` sits between `active` and `createdAt` rather than at the end,
/// because field order is output order and that is where the schema puts it —
/// the two flags an admin scans down the list for are next to each other.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffRosterEntry {
    pub id: String,
    pub name: String,
    pub role: String,
    pub active: bool,
    pub has_pin: bool,
    pub created_at: String,
}

/// A table, as `tableSchema` declares it.
#[derive(Debug, Clone, Serialize)]
pub struct Table {
    pub id: String,
    pub name: String,
    pub sort: i64,
    pub active: bool,
}

/// A category, as `categorySchema` declares it.
#[derive(Debug, Clone, Serialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub sort: i64,
    pub active: bool,
}

/// A product, as `productSchema` declares it.
///
/// This one needs `rename_all` and the two above do not: `category_id` and
/// `price_minor` are two words in SQLite and one camelCased word on the wire,
/// whereas a table's every column is a single word that spells the same both
/// ways. The attribute is applied where it has something to do rather than
/// everywhere for symmetry — on a struct with nothing to rename it would imply
/// the columns are camelCase, which they are not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub category_id: String,
    pub name: String,
    pub price_minor: i64,
    pub prep_minutes: i64,
    pub sort: i64,
    pub active: bool,
}

/* ---------------------------------------------------------------- mappers */

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

pub fn to_staff_roster_entry(row: &StaffRosterRow) -> StaffRosterEntry {
    StaffRosterEntry {
        id: row.id.clone(),
        name: row.name.clone(),
        role: row.role.clone(),
        active: row.active == 1,
        has_pin: row.has_pin == 1,
        created_at: row.created_at.clone(),
    }
}

pub fn to_table(row: &TableRow) -> Table {
    Table { id: row.id.clone(), name: row.name.clone(), sort: row.sort, active: row.active == 1 }
}

pub fn to_category(row: &CategoryRow) -> Category {
    Category { id: row.id.clone(), name: row.name.clone(), sort: row.sort, active: row.active == 1 }
}

pub fn to_product(row: &ProductRow) -> Product {
    Product {
        id: row.id.clone(),
        category_id: row.category_id.clone(),
        name: row.name.clone(),
        price_minor: row.price_minor,
        prep_minutes: row.prep_minutes,
        sort: row.sort,
        active: row.active == 1,
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
/// callers want `token_version` — `/staff/switch` and
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

/* ---------------------------------------------------------- catalogue reads */

/*
 * Every list below comes in two statements rather than one with a condition
 * pasted into it, and the pair is worth explaining once here instead of three
 * times underneath.
 *
 * The floor and the backoffice want different lists. A waiter's grid must show
 * only what is on tonight — a retired table is a tile somebody taps by mistake
 * during service — while the manager editing the floor has to see the retired
 * ones, because un-retiring is the only way one comes back. So the filter is a
 * parameter, and the caller that passes `true` is behind `require_role`.
 *
 * Written as two complete statements in a `match` because SQL text in this file
 * is read against a `wrangler d1` console, and half a `WHERE` clause built by
 * `format!` is not something anybody can paste. The duplication is one line
 * each and it keeps both queries greppable.
 *
 * The ordering is `sort` then name, case-insensitively. `sort` is a small dense
 * integer an admin types, so ties are normal rather than exceptional — a floor
 * that never touches the field is all zeroes — and byte order would put `Table
 * 10` before `Table 2` *and* `Terrace` before `bar`. Name order is what a
 * person expects when the numbers say nothing.
 */

/// The floor.
pub async fn list_tables(db: &D1Database, include_inactive: bool) -> WorkerResult<Vec<Table>> {
    let statement = if include_inactive {
        db.prepare(
            "SELECT id, name, sort, active FROM \"tables\"
        ORDER BY sort ASC, name COLLATE NOCASE ASC",
        )
    } else {
        db.prepare(
            "SELECT id, name, sort, active FROM \"tables\"
        WHERE active = 1
        ORDER BY sort ASC, name COLLATE NOCASE ASC",
        )
    };
    let rows: Vec<TableRow> = statement.all().await?.results()?;
    Ok(rows.iter().map(to_table).collect())
}

/// The chips above the product grid.
pub async fn list_categories(
    db: &D1Database,
    include_inactive: bool,
) -> WorkerResult<Vec<Category>> {
    let statement = if include_inactive {
        db.prepare(
            "SELECT id, name, sort, active FROM categories
        ORDER BY sort ASC, name COLLATE NOCASE ASC",
        )
    } else {
        db.prepare(
            "SELECT id, name, sort, active FROM categories
        WHERE active = 1
        ORDER BY sort ASC, name COLLATE NOCASE ASC",
        )
    };
    let rows: Vec<CategoryRow> = statement.all().await?.results()?;
    Ok(rows.iter().map(to_category).collect())
}

/// The menu, whole.
///
/// Every product in one response rather than a request per category, and that
/// is a deliberate choice about the shape of the waiter's screen: the chips
/// filter a list the tablet is already holding, so switching from Curries to
/// Drinks is instant and costs nothing. A restaurant's menu is a hundred rows
/// at the outside — this is a few kilobytes, fetched once when the screen
/// opens, against a round trip per chip tap for the rest of the shift.
///
/// `category_id` leads the ordering so that the response arrives grouped, which
/// is the order the backoffice's product list draws it in and saves the client
/// a sort it would otherwise do on every render.
pub async fn list_products(db: &D1Database, include_inactive: bool) -> WorkerResult<Vec<Product>> {
    let statement = if include_inactive {
        db.prepare(
            "SELECT id, category_id, name, price_minor, prep_minutes, sort, active FROM products
        ORDER BY category_id ASC, sort ASC, name COLLATE NOCASE ASC",
        )
    } else {
        db.prepare(
            "SELECT id, category_id, name, price_minor, prep_minutes, sort, active FROM products
        WHERE active = 1
        ORDER BY category_id ASC, sort ASC, name COLLATE NOCASE ASC",
        )
    };
    let rows: Vec<ProductRow> = statement.all().await?.results()?;
    Ok(rows.iter().map(to_product).collect())
}

/* -------------------------------------------------------- backoffice reads */

/// Everybody who has ever worked here, including the people who have left.
///
/// The roster, and deliberately not [`list_staff`]: that one is the PIN
/// screen's, filtered to active and cut to three columns because it is the one
/// list a tablet can read with nobody signed in. This one is behind
/// `require_role` and carries two more facts — whether somebody is still here,
/// and whether they can sign in at all.
///
/// `pin_hash IS NOT NULL` rather than `pin_hash`. The question an admin is
/// allowed to ask is whether a PIN exists; the hash itself is not selected, so
/// it is not in the row struct, not in the mapped value and not in the
/// response, and adding a field to this screen later cannot put it there.
///
/// Inactive rows sort to the bottom — `active DESC` — because the roster is a
/// working list first and an archive second.
pub async fn list_staff_roster(db: &D1Database) -> WorkerResult<Vec<StaffRosterEntry>> {
    let results = db
        .prepare(
            "SELECT id, name, role, active, pin_hash IS NOT NULL AS has_pin, created_at
        FROM staff
        ORDER BY active DESC, name COLLATE NOCASE ASC",
        )
        .all()
        .await?;
    let rows: Vec<StaffRosterRow> = results.results()?;
    Ok(rows.iter().map(to_staff_roster_entry).collect())
}

/// Every tablet, claimed or waiting.
///
/// `SELECT *` here matches [`get_device_by_id`] and is safe for the same
/// reason: [`to_device`] is what decides what leaves, and it drops the nonce
/// and the revocation counter. The unclaimed ones come first, because a device
/// list is opened to set a tablet up far more often than to look at one that
/// already works.
pub async fn list_devices(db: &D1Database) -> WorkerResult<Vec<Device>> {
    let results = db
        .prepare(
            "SELECT * FROM devices
        ORDER BY claimed_at IS NOT NULL ASC, name COLLATE NOCASE ASC",
        )
        .all()
        .await?;
    let rows: Vec<DeviceRow> = results.results()?;
    Ok(rows.iter().map(to_device).collect())
}

/// What the restaurant took in a window: the whole of this app's reporting.
///
/// Two statements rather than one, and run together through [`both`] so they
/// cost one round trip rather than two. The split is not an optimisation, it is
/// arithmetic: the per-method totals have to be grouped by method, and a
/// `COUNT(DISTINCT check_id)` inside those groups counts a check once per
/// method it was paid with. V1 takes exactly one payment per check so the two
/// would agree today — and would start disagreeing on the day split payments
/// arrive, quietly, in the one number a manager checks at closing time.
///
/// The window is the caller's, as two ISO-8601 UTC strings, because working out
/// where the restaurant's day starts is `pos_core::clock`'s job and not
/// SQLite's. Half-open — `>= from AND < to` — so a payment taken at exactly
/// local midnight belongs to the day that is beginning and is counted once.
///
/// There is no index on `payments (at)`, deliberately: the table grows by about
/// sixty rows a service, so this scan is cheaper than keeping a second index in
/// step during one. `0001_init.sql` says so at the table.
pub async fn sales_between(db: &D1Database, from: &str, to: &str) -> WorkerResult<SalesTotals> {
    // The two statements are bound to locals before either future is made.
    // A `D1PreparedStatement` owns what its future borrows, so building one
    // inline would leave the future holding a temporary that the statement it
    // came from has already dropped — which the borrow checker refuses, and
    // rightly, since this is precisely the pattern that needs both alive at
    // once.
    let by_method_statement = db
        .prepare(
            "SELECT method, SUM(amount_minor) AS total FROM payments
        WHERE at >= ?1 AND at < ?2
        GROUP BY method",
        )
        .bind(&[text(from), text(to)])?;
    let settled_statement = db
        .prepare(
            "SELECT COUNT(DISTINCT check_id) AS checks FROM payments
        WHERE at >= ?1 AND at < ?2",
        )
        .bind(&[text(from), text(to)])?;

    let (by_method, settled) =
        both(by_method_statement.all(), settled_statement.first::<SettledRow>(None)).await;
    let rows: Vec<MethodTotalRow> = by_method?.results()?;

    let mut totals = SalesTotals {
        total_minor: 0,
        by_method: MethodTotals { cash: 0, card: 0, other: 0 },
        // A window with no payments in it returns one row of `0`, but `first`
        // is typed `Option` and an absent row is a zero day rather than an
        // error: the restaurant was shut.
        check_count: settled?.map_or(0, |row| row.checks),
    };
    for row in &rows {
        let total = row.total.unwrap_or(0);
        totals.total_minor += total;
        match row.method.as_str() {
            "cash" => totals.by_method.cash += total,
            "card" => totals.by_method.card += total,
            // Anything else is `other` by the `CHECK` constraint, and a value
            // SQLite somehow held still belongs in the day's takings — a total
            // that silently omits money is worse than one with a row in it
            // nobody recognises.
            _ => totals.by_method.other += total,
        }
    }
    Ok(totals)
}

/// `SUM` over an empty group is NULL, which is why `total` is optional even
/// though `GROUP BY` cannot produce an empty group. It is cover for a hand-run
/// `UPDATE` that nulled an amount, and it costs one `unwrap_or`.
#[derive(Debug, Clone, Deserialize)]
struct MethodTotalRow {
    method: String,
    total: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct SettledRow {
    checks: i64,
}

/// What `salesTodaySchema` carries under the three aggregate keys. The window
/// itself is the route's — it computed it — so it is not in here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesTotals {
    pub total_minor: i64,
    pub by_method: MethodTotals,
    pub check_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MethodTotals {
    pub cash: i64,
    pub card: i64,
    pub other: i64,
}

/* ---------------------------------------------------- checks, rounds, items */

/*
 * Everything below assembles what a *screen* reads rather than what a table
 * holds, and two rules run through all of it.
 *
 * **No total is computed in SQL.** Not one `SUM(price_minor_snapshot * qty)`
 * anywhere, however convenient, because that would be a third definition of a
 * check's total — in a language neither half of the twin is written in and held
 * to no test case at all. The statements decide *which rows* (`voided_at IS
 * NULL` on a read that wants live lines); `pos_core::totals` decides what they
 * come to. Counting rows is a different thing and `COUNT(*)` is used freely:
 * how many rounds have gone to the kitchen is not money.
 *
 * **Names travel with ids.** A cashier's board has no roster to resolve a
 * `staff_id` against and no floor plan to resolve a `table_id` against, so
 * every join that saves a client a second request is done here. It is the same
 * argument the realtime payloads are built on, applied to a response.
 */

/// One open check, before its lines have been added up.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenCheckRow {
    pub id: String,
    pub table_id: Option<String>,
    pub table_name: Option<String>,
    pub opened_by_name: String,
    pub opened_at: String,
    pub round_count: i64,
}

/// One line of one round that is still out, on some open check.
///
/// Flat rather than nested, for the same reason [`OpenLineRow`] is: the shape
/// that comes back from a join is a list of lines, and grouping it in Rust is
/// cheaper than asking SQLite for a nested aggregate — and here it is not only
/// cheaper but *necessary*. A round's target is the slowest dish on it, which
/// is `pos_core::timing::round_target_minutes`, a twinned rule. A `MAX()` in
/// the statement would be a third implementation of it, in a language neither
/// twin is written in and held to no test case, which is exactly what the twin
/// rule exists to prevent.
#[derive(Debug, Clone, Deserialize)]
pub struct OutstandingLineRow {
    pub check_id: String,
    pub round_id: String,
    pub sent_at: String,
    /// Optional because the join is `LEFT`: a round with no lines cannot be
    /// created through the API and still must not take a screen down.
    pub prep_minutes_snapshot: Option<i64>,
}

/// A live line on some open check, with only the columns a total needs.
///
/// Three now rather than two: the board draws both what the meal has cost and
/// what is still owed, and the second of those cannot be computed from the
/// first without knowing how many units of each line have been settled.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenLineRow {
    pub check_id: String,
    pub price_minor_snapshot: i64,
    pub qty: i64,
    pub qty_paid: i64,
}

/// A check's own row, with the two names a screen would otherwise have to
/// resolve.
#[derive(Debug, Clone, Deserialize)]
pub struct CheckHeaderRow {
    pub id: String,
    pub table_id: Option<String>,
    pub table_name: Option<String>,
    pub opened_by: String,
    pub opened_by_name: String,
    pub status: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
}

/// One row of the flattened rounds-and-items read.
///
/// The join is `LEFT` on items, so every item column is optional even though a
/// round always has at least one line — `sendRoundSchema` refuses an empty
/// order. A round that somehow has none produces one row with `item_id` NULL,
/// which the mapper skips rather than turning into a line with no name.
#[derive(Debug, Clone, Deserialize)]
pub struct RoundItemRow {
    pub round_id: String,
    pub seq: i64,
    pub sent_by_name: String,
    pub sent_at: String,
    /// Null while the round is still out — what every timer in the app reads.
    pub delivered_at: Option<String>,
    pub delivered_by_name: Option<String>,
    pub item_id: Option<String>,
    pub product_id: Option<String>,
    pub name_snapshot: Option<String>,
    pub price_minor_snapshot: Option<i64>,
    pub prep_minutes_snapshot: Option<i64>,
    pub qty: Option<i64>,
    /// `COALESCE`d to 0 in the query, so it is never NULL for a row that has an
    /// item — but it is still `Option` because the LEFT join can produce a row
    /// with no item at all, and every item column here is optional for that
    /// same reason.
    pub qty_paid: Option<i64>,
    pub note: Option<String>,
    pub voided_at: Option<String>,
    pub voided_by: Option<String>,
}

/// A payment, exactly as `payments` holds it — and `paymentSchema` sends it.
///
/// The one struct in this file that is both read from SQLite and written to a
/// client, which is why `rename_all` is scoped to `serialize` and must stay
/// that way. An unscoped `rename_all = "camelCase"` applies to **both**
/// directions: the JSON going out gets `checkId`, and the row coming back from
/// D1 is then expected to have `checkId` too — which it does not, because the
/// column is `check_id`.
///
/// That mismatch does not fail politely. `worker`'s `D1Result::results` calls
/// `serde_wasm_bindgen::from_value(...).unwrap()`, so a row that does not fit
/// is a **panic**, a panic in wasm is a trap, and a trap takes the isolate down
/// — every request in flight on it, plus the next few, which come back as
/// `__wbindgen_start is not a function` from the reinitialisation and say
/// nothing whatever about the actual cause. It cost an afternoon to find once;
/// the `start` hook in `lib.rs` exists so it costs a log line next time.
///
/// Elsewhere the two directions are separate types — a `…Row` and a mapped
/// value — and that separation is the general answer. This one is a single
/// struct because a payment has six columns whose names are the same words on
/// both sides bar the casing, and a mapper that copied six fields would be
/// ceremony rather than a boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct PaymentRow {
    pub id: String,
    pub check_id: String,
    pub method: String,
    pub amount_minor: i64,
    pub taken_by: String,
    pub at: String,
}

/// What the menu says a product costs *now*, read at send time and copied onto
/// the item.
#[derive(Debug, Clone, Deserialize)]
pub struct ProductPriceRow {
    pub id: String,
    pub name: String,
    pub price_minor: i64,
    /// Copied onto the item beside the price, and for the same reason: what the
    /// kitchen was expected to take is a fact about the evening this round was
    /// sent, not about whatever the backoffice says an hour later.
    pub prep_minutes: i64,
}

/* --------------------------------------------- mapped values for a screen */

/// `checkSummarySchema`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    pub id: String,
    pub table_id: Option<String>,
    pub table_name: Option<String>,
    pub opened_by_name: String,
    pub opened_at: String,
    pub round_count: i64,
    pub outstanding_rounds: i64,
    pub oldest_outstanding_at: Option<String>,
    pub oldest_outstanding_target_minutes: i64,
    pub total_minor: i64,
    pub outstanding_minor: i64,
}

/// `itemSchema`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub round_id: String,
    pub product_id: Option<String>,
    pub name_snapshot: String,
    pub price_minor_snapshot: i64,
    pub prep_minutes_snapshot: i64,
    pub qty: i64,
    /// How many of `qty` are already settled — the sum of this line's rows in
    /// `payment_items`, read alongside the item rather than stored on one.
    pub qty_paid: i64,
    pub note: Option<String>,
    pub voided_at: Option<String>,
    pub voided_by: Option<String>,
}

/// `roundDetailSchema`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundDetail {
    pub id: String,
    pub seq: i64,
    pub sent_by_name: String,
    pub sent_at: String,
    pub delivered_at: Option<String>,
    pub delivered_by_name: Option<String>,
    /// The slowest dish on the round, from `pos_core::timing`. The browser
    /// draws its countdown from this rather than working it out again, so the
    /// number a waiter quotes and the number the Worker believes are one value.
    pub target_minutes: i64,
    pub items: Vec<Item>,
}

/// `checkDetailSchema` — what every route that changes a check answers with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDetail {
    pub id: String,
    pub table_id: Option<String>,
    pub table_name: Option<String>,
    pub opened_by: String,
    pub opened_by_name: String,
    pub status: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub rounds: Vec<RoundDetail>,
    pub payments: Vec<PaymentRow>,
    pub total_minor: i64,
    pub outstanding_minor: i64,
}

impl CheckDetail {
    /// The live lines, as `pos_core::totals` wants them.
    ///
    /// Built from the detail rather than from a second read, so that the number
    /// on the response and the lines on the response cannot disagree: they came
    /// out of the same rows.
    pub fn lines(&self) -> Vec<CheckLine> {
        self.rounds
            .iter()
            .flat_map(|round| round.items.iter())
            .map(|item| CheckLine {
                price_minor_snapshot: item.price_minor_snapshot,
                qty: item.qty,
                qty_paid: item.qty_paid,
                voided_at: item.voided_at.clone(),
            })
            .collect()
    }

    /// The live item with this id, for a route that has been handed one by a
    /// client and has to decide whether it is on this check at all.
    ///
    /// Linear over a check's twenty-odd lines, which is cheaper than the map
    /// that would avoid the scan and very much cheaper than asking the database
    /// again — and the answer has to come from the same read the guard's counts
    /// came from, or the message and the write disagree about what they saw.
    pub fn item(&self, item_id: &str) -> Option<&Item> {
        self.rounds.iter().flat_map(|round| round.items.iter()).find(|item| item.id == item_id)
    }
}

/* ------------------------------------------------------------------ reads */

/// Every check still open, oldest first, with its total.
///
/// Two statements in one `batch`, which is one round trip: the headers, and the
/// live lines of every open check at once. The alternative — a query per check
/// to total it — is the N+1 that would turn the cashier's five-second fallback
/// poll into eleven D1 reads every five seconds.
///
/// The lines come back flat and are grouped here. A restaurant has a dozen open
/// checks at the busiest moment and perhaps eighty live lines between them, so
/// this is a map of eighty entries built on a screen refresh — nothing worth
/// pushing into SQL, and pushing the addition into SQL is the thing this file
/// exists not to do.
pub async fn list_open_checks(db: &D1Database) -> WorkerResult<Vec<CheckSummary>> {
    let results = db
        .batch(vec![
            db.prepare(
                "SELECT c.id AS id,
                c.table_id AS table_id,
                t.name AS table_name,
                s.name AS opened_by_name,
                c.opened_at AS opened_at,
                (SELECT COUNT(*) FROM rounds r WHERE r.check_id = c.id) AS round_count
        FROM checks c
        LEFT JOIN \"tables\" t ON t.id = c.table_id
        JOIN staff s ON s.id = c.opened_by
        WHERE c.status = 'open'
        ORDER BY c.opened_at ASC",
            ),
            db.prepare(
                "SELECT r.check_id AS check_id,
                i.price_minor_snapshot AS price_minor_snapshot,
                i.qty AS qty,
                COALESCE((SELECT SUM(a.qty_paid) FROM payment_items a
                           WHERE a.item_id = i.id), 0) AS qty_paid
        FROM items i
        JOIN rounds r ON r.id = i.round_id
        JOIN checks c ON c.id = r.check_id
        WHERE c.status = 'open' AND i.voided_at IS NULL",
            ),
            // What is still out, oldest first. `idx_rounds_outstanding` covers
            // the predicate and the ordering, and it is partial — so this walks
            // the handful of rounds the kitchen currently has rather than every
            // round the restaurant has ever sent.
            db.prepare(
                "SELECT r.check_id AS check_id,
                r.id AS round_id,
                r.sent_at AS sent_at,
                i.prep_minutes_snapshot AS prep_minutes_snapshot
        FROM rounds r
        JOIN checks c ON c.id = r.check_id
        LEFT JOIN items i ON i.round_id = r.id
        WHERE c.status = 'open' AND r.delivered_at IS NULL
        ORDER BY r.sent_at ASC, r.id ASC",
            ),
        ])
        .await?;

    let headers: Vec<OpenCheckRow> = results[0].results()?;
    let lines: Vec<OpenLineRow> = results[1].results()?;
    let outstanding: Vec<OutstandingLineRow> = results[2].results()?;

    let mut by_check: std::collections::HashMap<String, Vec<CheckLine>> =
        std::collections::HashMap::new();
    for line in lines {
        by_check
            .entry(line.check_id)
            .or_default()
            // Already filtered to live lines by the statement, so `voided_at` is
            // None by construction. The type still carries the field, because
            // `check_total_minor` is the one definition of a total and it is not
            // going to grow a second entry point that trusts its caller.
            .push(CheckLine {
                price_minor_snapshot: line.price_minor_snapshot,
                qty: line.qty,
                qty_paid: line.qty_paid,
                voided_at: None,
            });
    }

    /*
     * The outstanding rounds, grouped twice: by check, then by round within it.
     *
     * Walked in order rather than grouped through nested maps, because the
     * statement already returned it oldest-first and a map would throw that
     * away — the *first* round seen for a check is the oldest one, which is the
     * only one a tile shows.
     */
    let mut out_by_check: std::collections::HashMap<String, OutstandingRounds> =
        std::collections::HashMap::new();
    for row in outstanding {
        let entry = out_by_check.entry(row.check_id).or_default();

        /*
         * A **set** of round ids rather than a counter, because these rows are
         * lines and not rounds: a round of three dishes arrives as three rows,
         * and anything that increments per row counts it three times. Comparing
         * against the previously-seen id would work only while rows of one
         * round stay adjacent, which the `ORDER BY` does not actually promise
         * for two rounds sent in the same millisecond. A set does not care.
         */
        entry.round_ids.insert(row.round_id.clone());

        // First row wins, and the statement orders oldest first — so the first
        // round seen for a check is the one whose clock a tile shows.
        if entry.oldest_round_id.is_none() {
            entry.oldest_round_id = Some(row.round_id.clone());
            entry.oldest_at = Some(row.sent_at.clone());
        }

        // Only the oldest round's target is ever shown, so only its lines are
        // collected. The rest are counted and dropped.
        if entry.oldest_round_id.as_deref() == Some(row.round_id.as_str()) {
            if let Some(minutes) = row.prep_minutes_snapshot {
                entry.oldest_lines.push(TimedLine { prep_minutes_snapshot: minutes });
            }
        }
    }

    Ok(headers
        .into_iter()
        .map(|header| {
            // Both figures from the same lines, by the two twinned rules. A
            // card that computed one of them from the other would be adding a
            // third definition of a total in the place least likely to be read.
            let check_lines = by_check.get(&header.id);
            let total = check_lines.map_or(0, |lines| totals::check_total_minor(lines));
            let outstanding =
                check_lines.map_or(0, |lines| totals::check_outstanding_minor(lines));
            let out = out_by_check.remove(&header.id).unwrap_or_default();
            CheckSummary {
                id: header.id,
                table_id: header.table_id,
                table_name: header.table_name,
                opened_by_name: header.opened_by_name,
                opened_at: header.opened_at,
                round_count: header.round_count,
                outstanding_rounds: out.round_ids.len() as i64,
                oldest_outstanding_at: out.oldest_at,
                // The twinned rule, not a `MAX()` in the statement above.
                oldest_outstanding_target_minutes: timing::round_target_minutes(&out.oldest_lines),
                total_minor: total,
                outstanding_minor: outstanding,
            }
        })
        .collect())
}

/// What one check still has out, while the flat rows are being grouped.
#[derive(Debug, Default)]
struct OutstandingRounds {
    /// Distinct rounds, not rows. See the comment where it is filled.
    round_ids: std::collections::HashSet<String>,
    oldest_round_id: Option<String>,
    oldest_at: Option<String>,
    oldest_lines: Vec<TimedLine>,
}

/// One check, entire.
///
/// Three statements in one `batch`, and therefore one round trip: the header,
/// the rounds with their lines flattened, and the payments. Every route that
/// changes a check answers with this, so it runs on the send, the void and the
/// payment as well as on a plain read — which is why it is one trip rather than
/// three and why the assembly is here rather than in each of them.
///
/// `ORDER BY r.seq ASC, i.rowid ASC` is the order things happened: rounds in
/// the order they went to the kitchen, and lines within a round in the order
/// the waiter tapped them into the cart. `rowid` rather than a column of our
/// own, because SQLite hands one out per row in insert order and adding a
/// `position INTEGER` would be a column to maintain for something the database
/// already knows. It is stated here because it is the kind of implicit ordering
/// somebody removes as untidy.
pub async fn check_detail(db: &D1Database, check_id: &str) -> WorkerResult<Option<CheckDetail>> {
    let results = db
        .batch(vec![
            db.prepare(
                "SELECT c.id AS id,
                c.table_id AS table_id,
                t.name AS table_name,
                c.opened_by AS opened_by,
                s.name AS opened_by_name,
                c.status AS status,
                c.opened_at AS opened_at,
                c.closed_at AS closed_at
        FROM checks c
        LEFT JOIN \"tables\" t ON t.id = c.table_id
        JOIN staff s ON s.id = c.opened_by
        WHERE c.id = ?1",
            )
            .bind(&[text(check_id)])?,
            db.prepare(
                "SELECT r.id AS round_id,
                r.seq AS seq,
                s.name AS sent_by_name,
                r.sent_at AS sent_at,
                r.delivered_at AS delivered_at,
                carrier.name AS delivered_by_name,
                i.id AS item_id,
                i.product_id AS product_id,
                i.name_snapshot AS name_snapshot,
                i.price_minor_snapshot AS price_minor_snapshot,
                i.prep_minutes_snapshot AS prep_minutes_snapshot,
                i.qty AS qty,
                COALESCE((SELECT SUM(a.qty_paid) FROM payment_items a
                           WHERE a.item_id = i.id), 0) AS qty_paid,
                i.note AS note,
                i.voided_at AS voided_at,
                i.voided_by AS voided_by
        FROM rounds r
        JOIN staff s ON s.id = r.sent_by
        LEFT JOIN staff carrier ON carrier.id = r.delivered_by
        LEFT JOIN items i ON i.round_id = r.id
        WHERE r.check_id = ?1
        ORDER BY r.seq ASC, i.rowid ASC",
            )
            .bind(&[text(check_id)])?,
            db.prepare(
                "SELECT id, check_id, method, amount_minor, taken_by, at FROM payments
        WHERE check_id = ?1
        ORDER BY at ASC",
            )
            .bind(&[text(check_id)])?,
        ])
        .await?;

    let header: Vec<CheckHeaderRow> = results[0].results()?;
    let Some(header) = header.into_iter().next() else {
        return Ok(None);
    };
    let flat: Vec<RoundItemRow> = results[1].results()?;
    let payments: Vec<PaymentRow> = results[2].results()?;

    // Walked in order rather than grouped through a map, because the statement
    // already returned it in order and a `HashMap` would throw that away and
    // need it sorted back.
    let mut rounds: Vec<RoundDetail> = Vec::new();
    for row in flat {
        if rounds.last().map(|round| round.id.as_str()) != Some(row.round_id.as_str()) {
            rounds.push(RoundDetail {
                id: row.round_id.clone(),
                seq: row.seq,
                sent_by_name: row.sent_by_name.clone(),
                sent_at: row.sent_at.clone(),
                delivered_at: row.delivered_at.clone(),
                delivered_by_name: row.delivered_by_name.clone(),
                // Filled in once the round's lines have all been seen — the
                // target is the slowest of them and there is no way to know
                // which that is until the last one has arrived.
                target_minutes: 0,
                items: Vec::new(),
            });
        }
        // The `LEFT JOIN`'s empty side. A round with no lines cannot be created
        // through the API, and a line with no name is not something to render.
        let (Some(id), Some(name_snapshot), Some(price_minor_snapshot), Some(qty)) =
            (row.item_id, row.name_snapshot, row.price_minor_snapshot, row.qty)
        else {
            continue;
        };
        // Defaulted rather than required, because the column was added by
        // migration 0003 with a default of its own: a line written before that
        // migration ran has the value SQLite backfilled, and a line somehow
        // without one is a ten-minute dish rather than a dropped row.
        let prep_minutes_snapshot = row.prep_minutes_snapshot.unwrap_or(10);
        if let Some(round) = rounds.last_mut() {
            round.items.push(Item {
                id,
                round_id: row.round_id,
                product_id: row.product_id,
                name_snapshot,
                price_minor_snapshot,
                prep_minutes_snapshot,
                qty,
                // `COALESCE`d to 0 by the statement, so the fallback here is
                // for the row shape rather than for the data: an item that came
                // back without the column at all owes for all of itself, which
                // is the safe way round to be wrong.
                qty_paid: row.qty_paid.unwrap_or(0),
                note: row.note,
                voided_at: row.voided_at,
                voided_by: row.voided_by,
            });
        }
    }

    // Now that every line has been seen, each round knows its slowest dish.
    for round in &mut rounds {
        let lines: Vec<TimedLine> = round
            .items
            .iter()
            .map(|item| TimedLine { prep_minutes_snapshot: item.prep_minutes_snapshot })
            .collect();
        round.target_minutes = timing::round_target_minutes(&lines);
    }

    let mut detail = CheckDetail {
        id: header.id,
        table_id: header.table_id,
        table_name: header.table_name,
        opened_by: header.opened_by,
        opened_by_name: header.opened_by_name,
        status: header.status,
        opened_at: header.opened_at,
        closed_at: header.closed_at,
        rounds,
        payments,
        total_minor: 0,
        outstanding_minor: 0,
    };
    // Both from the same lines and both by their own twinned rule. `total` is
    // what the meal cost and goes on the bill; `outstanding` is what the
    // customer still hands over, and it is the one every control that takes
    // money has to be showing.
    let lines = detail.lines();
    detail.total_minor = totals::check_total_minor(&lines);
    detail.outstanding_minor = totals::check_outstanding_minor(&lines);
    Ok(Some(detail))
}

/// The open check on a table, if there is one.
///
/// Two statements rather than one because the second is [`check_detail`]'s
/// three: this finds the id and that assembles the check. The partial unique
/// index `idx_checks_open_table` is what makes "the" open check a well-formed
/// phrase — a table may have at most one, and the database is where that rule
/// lives.
pub async fn open_check_for_table(
    db: &D1Database,
    table_id: &str,
) -> WorkerResult<Option<CheckDetail>> {
    let row: Option<CheckHeaderRow> = db
        .prepare(
            "SELECT c.id AS id,
                c.table_id AS table_id,
                NULL AS table_name,
                c.opened_by AS opened_by,
                '' AS opened_by_name,
                c.status AS status,
                c.opened_at AS opened_at,
                c.closed_at AS closed_at
        FROM checks c
        WHERE c.table_id = ?1 AND c.status = 'open'",
        )
        .bind(&[text(table_id)])?
        .first(None)
        .await?;

    match row {
        Some(row) => check_detail(db, &row.id).await,
        None => Ok(None),
    }
}

/// The menu rows a send is about, by id, active only.
///
/// Read at send time and copied onto each item, which is the one
/// denormalisation in the schema and the reason the schema is trustworthy: an
/// admin who renames a dish or puts it up five hundred kyat at seven o'clock
/// must not rewrite a check that was opened at six.
///
/// It is also why the client does **not** send prices. A tablet holding
/// yesterday's cached menu would otherwise charge yesterday's prices, and the
/// only copy of a price that matters is the one the Worker read.
///
/// `active = 1`, so a retired product cannot be ordered even by a tablet whose
/// menu has not caught up — the waiter is told which line it was rather than
/// having the order silently shortened.
pub async fn products_by_id(
    db: &D1Database,
    ids: &[String],
) -> WorkerResult<Vec<ProductPriceRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // The placeholder list is built from the *count* of ids and never from the
    // ids themselves, so nothing a client sent reaches the statement text. The
    // values go through `bind`, which is the only way a value gets into a query
    // in this file.
    let placeholders: Vec<String> = (1..=ids.len()).map(|index| format!("?{index}")).collect();
    let statement = format!(
        "SELECT id, name, price_minor, prep_minutes FROM products
        WHERE active = 1 AND id IN ({})",
        placeholders.join(", ")
    );
    let bindings: Vec<JsValue> = ids.iter().map(|id| text(id)).collect();
    let results = db.prepare(statement).bind(&bindings)?.all().await?;
    Ok(results.results()?)
}

/* ------------------------------------------------------------- print jobs */

/// A job with everything around it a ticket needs, except its lines.
///
/// The joins are what make the agent's poll one request: the round it belongs
/// to, who sent that round, the check's table, and — on a void — the line that
/// was struck off and by whom. Without them the agent would fetch a job and
/// then three more things to find out what it said.
///
/// `item_id`, `voided_at` and `voided_by_name` are NULL on a `ticket` job and
/// carry the struck line on a `void` one. That asymmetry is the two kinds
/// sharing a table, and it is cheaper than two tables for a queue that holds
/// about two hundred rows a day.
#[derive(Debug, Clone, Deserialize)]
pub struct PrintJobRow {
    pub id: String,
    pub round_id: String,
    pub kind: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub printed_at: Option<String>,
    pub item_id: Option<String>,
    pub seq: i64,
    pub sent_at: String,
    pub sent_by_name: String,
    pub table_id: Option<String>,
    pub table_name: Option<String>,
    pub voided_at: Option<String>,
    pub voided_by_name: Option<String>,
}

/// A line belonging to one of the rounds being printed.
#[derive(Debug, Clone, Deserialize)]
pub struct JobItemRow {
    pub id: String,
    pub round_id: String,
    pub name_snapshot: String,
    pub qty: i64,
    pub note: Option<String>,
}

/// Every job in one status, with the lines needed to print all of them.
///
/// Two statements in one `batch` — one round trip — and that matters more here
/// than anywhere else in this file: the agent runs this every three seconds all
/// day, fourteen thousand times, and `idx_print_jobs_status` makes the
/// overwhelming majority of them (the ones that answer "nothing") a probe of an
/// empty index range.
///
/// The second statement is deliberately scoped by the same `status` rather than
/// by a list of round ids gathered from the first: they run in one batch, so
/// there is no first result to gather from, and re-stating the predicate is
/// what lets both go out together. When nothing is pending, both return nothing
/// and the join is never walked.
///
/// A ticket's lines are **all** of its round's, including any that have since
/// been voided. The void notice that follows refers to a slip the kitchen is
/// holding, and a ticket that quietly omitted the line would be a strike-off
/// for something they were never told to cook.
pub async fn print_jobs_with_lines(
    db: &D1Database,
    status: &str,
) -> WorkerResult<(Vec<PrintJobRow>, Vec<JobItemRow>)> {
    let results = db
        .batch(vec![
            db.prepare(
                "SELECT j.id AS id,
                j.round_id AS round_id,
                j.kind AS kind,
                j.status AS status,
                j.attempts AS attempts,
                j.last_error AS last_error,
                j.created_at AS created_at,
                j.printed_at AS printed_at,
                j.item_id AS item_id,
                r.seq AS seq,
                r.sent_at AS sent_at,
                sender.name AS sent_by_name,
                c.table_id AS table_id,
                t.name AS table_name,
                voided.voided_at AS voided_at,
                voider.name AS voided_by_name
        FROM print_jobs j
        JOIN rounds r ON r.id = j.round_id
        JOIN staff sender ON sender.id = r.sent_by
        JOIN checks c ON c.id = r.check_id
        LEFT JOIN \"tables\" t ON t.id = c.table_id
        LEFT JOIN items voided ON voided.id = j.item_id
        LEFT JOIN staff voider ON voider.id = voided.voided_by
        WHERE j.status = ?1
        ORDER BY j.created_at ASC",
            )
            .bind(&[text(status)])?,
            db.prepare(
                "SELECT i.id AS id,
                i.round_id AS round_id,
                i.name_snapshot AS name_snapshot,
                i.qty AS qty,
                i.note AS note
        FROM items i
        WHERE i.round_id IN (SELECT round_id FROM print_jobs WHERE status = ?1)
        ORDER BY i.rowid ASC",
            )
            .bind(&[text(status)])?,
        ])
        .await?;

    Ok((results[0].results()?, results[1].results()?))
}

/// One job, after it has been acked, so the response can say what it now is.
///
/// The same shape as the list above and the same joins, because the ack answers
/// with the job — a client that has just told the Worker something should be
/// told what the Worker now believes rather than `{ ok: true }`.
pub async fn print_job_with_lines(
    db: &D1Database,
    job_id: &str,
) -> WorkerResult<Option<(PrintJobRow, Vec<JobItemRow>)>> {
    let results = db
        .batch(vec![
            db.prepare(
                "SELECT j.id AS id,
                j.round_id AS round_id,
                j.kind AS kind,
                j.status AS status,
                j.attempts AS attempts,
                j.last_error AS last_error,
                j.created_at AS created_at,
                j.printed_at AS printed_at,
                j.item_id AS item_id,
                r.seq AS seq,
                r.sent_at AS sent_at,
                sender.name AS sent_by_name,
                c.table_id AS table_id,
                t.name AS table_name,
                voided.voided_at AS voided_at,
                voider.name AS voided_by_name
        FROM print_jobs j
        JOIN rounds r ON r.id = j.round_id
        JOIN staff sender ON sender.id = r.sent_by
        JOIN checks c ON c.id = r.check_id
        LEFT JOIN \"tables\" t ON t.id = c.table_id
        LEFT JOIN items voided ON voided.id = j.item_id
        LEFT JOIN staff voider ON voider.id = voided.voided_by
        WHERE j.id = ?1",
            )
            .bind(&[text(job_id)])?,
            db.prepare(
                "SELECT i.id AS id,
                i.round_id AS round_id,
                i.name_snapshot AS name_snapshot,
                i.qty AS qty,
                i.note AS note
        FROM items i
        WHERE i.round_id = (SELECT round_id FROM print_jobs WHERE id = ?1)
        ORDER BY i.rowid ASC",
            )
            .bind(&[text(job_id)])?,
        ])
        .await?;

    let jobs: Vec<PrintJobRow> = results[0].results()?;
    let Some(job) = jobs.into_iter().next() else {
        return Ok(None);
    };
    Ok(Some((job, results[1].results()?)))
}

/* ------------------------------------------------------------- primitives */

/// A bound value. D1 takes JS values, and these four are every kind this app
/// binds: text, a number, SQL NULL, and the two optional wrappers that turn an
/// absent field into that NULL.
///
/// Public, because single-table CRUD stays inline in the routes and the routes
/// therefore bind their own parameters. One set of constructors used everywhere
/// is what stops the first route in a hurry reaching for `JsValue::from_f64`
/// and starting a second convention next to this one.
pub fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

pub fn number(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

/// SQL NULL, which is `null` and emphatically not `undefined`: D1 marshals
/// `undefined` as a missing argument and refuses the statement, whereas this
/// binds the value SQLite understands. It is the whole mechanism behind the
/// partial updates in `routes/` — `COALESCE(?2, name)` leaves the column alone
/// exactly when this is what arrived.
pub fn null() -> JsValue {
    JsValue::NULL
}

/// An absent string becomes NULL. The two `opt_*` helpers exist so a `PATCH`
/// handler is a list of binds rather than a list of `match` expressions, and so
/// that "absent means leave it alone" is spelled the same way in every one.
pub fn opt_text(value: Option<&str>) -> JsValue {
    value.map_or_else(null, text)
}

pub fn opt_number(value: Option<f64>) -> JsValue {
    value.map_or_else(null, number)
}

/// An absent boolean becomes NULL; a present one becomes the 0 or 1 the `CHECK`
/// constraints permit.
///
/// Not `JsValue::from_bool`, which D1 marshals as a JavaScript boolean and
/// SQLite then stores as… a JavaScript boolean, which is not one of the five
/// storage classes it has. Every boolean in this schema is `INTEGER 0/1` with a
/// `CHECK` behind it, so the conversion happens here, once, rather than in
/// whichever route forgot.
pub fn opt_bool(value: Option<bool>) -> JsValue {
    match value {
        Some(true) => number(1.0),
        Some(false) => number(0.0),
        None => null(),
    }
}


/// `Promise.all([a, b])` for two futures.
///
/// Rust futures do nothing until polled, so awaiting one and then the other
/// would turn a pair of independent reads into two round trips — which is the
/// cost the original went out of its way to avoid on the screens that use it.
/// Polling both from one future starts both requests before either is waited
/// on, which is what `Promise.all` did.
///
/// [`sales_between`] is its first caller — the day's takings and the number of
/// checks behind them are two aggregates over the same window — and the
/// cashier's screen, which wants a check's rounds and its payments in one
/// breath, is the next.
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
