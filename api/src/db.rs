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
            "SELECT id, category_id, name, price_minor, sort, active FROM products
        ORDER BY category_id ASC, sort ASC, name COLLATE NOCASE ASC",
        )
    } else {
        db.prepare(
            "SELECT id, category_id, name, price_minor, sort, active FROM products
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
