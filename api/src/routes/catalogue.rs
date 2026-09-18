//! The menu and the floor: `/tables`, `/categories`, `/products`.
//!
//! Three resources with one shape between them — a hand-ordered list of named
//! rows that are retired rather than deleted — so they share a router, and the
//! handlers below are written out per resource rather than made generic. The
//! SQL is the reason: these statements are the contract with the database, and
//! a table name pasted into a `format!` is a statement nobody can paste back
//! into a `wrangler d1` console at midnight. Nine short handlers that can each
//! be read on their own beat three clever ones that cannot.
//!
//! ## Who may read what
//!
//! Reading is `require_staff`, writing is `require_role(&["admin"])`, and the
//! split is not about secrecy — a menu is printed on a card on every table. It
//! is about the two lists being *different*. A waiter's grid must show only
//! what is on tonight, because a retired table is a tile somebody taps by
//! mistake during service; the manager editing the floor has to see the retired
//! ones, because un-retiring is the only way one comes back. So the same route
//! answers both, `?include=all` asks for the second, and asking for it needs
//! the role that can act on the answer.
//!
//! ## Nothing here deletes
//!
//! There is no `DELETE` in this file and there should never be one. Every row
//! in these three tables is pointed at by history — a check knows its table, an
//! item knows the product it came from, and `0001_init.sql` answers a `DELETE`
//! reaching those references with `RESTRICT` or `SET NULL` rather than with
//! silence. Retiring is `PATCH { "active": false }`, which leaves last month's
//! bills meaning what they meant.

use worker::d1::D1Database;
use worker::{Env, Method, Request, Response};

use crate::db;
use crate::http::{self, ApiResult};
use crate::middleware::{self, Identity};
use crate::validate::{self, Int, Str};

/// The roles that may change the menu. One, and it is spelled here rather than
/// at each call site so that adding a second is one edit.
const EDITORS: &[&str] = &["admin"];

/// `None` when nothing here matches, so the dispatcher moves on to the next
/// router — including for a path this one owns with a method it does not, which
/// is how `DELETE /products/prd_1` reaches the 404 rather than half-matching.
pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let mut segments = path.split('/').skip(1);
    let resource = segments.next()?;
    let id = segments.next();
    // A third segment is not a shape any route here has. `/products/prd_1/x`
    // 404s rather than being read as `/products/prd_1`.
    if segments.next().is_some() {
        return None;
    }
    // `/tables/` splits to a trailing empty segment, which is not an id and is
    // not the collection either.
    if id == Some("") {
        return None;
    }

    Some(match (resource, req.method(), id) {
        ("tables", Method::Get, None) => list_tables(req, env, identity).await,
        ("tables", Method::Post, None) => create_table(req, env, identity).await,
        ("tables", Method::Patch, Some(id)) => update_table(req, env, identity, id).await,

        ("categories", Method::Get, None) => list_categories(req, env, identity).await,
        ("categories", Method::Post, None) => create_category(req, env, identity).await,
        ("categories", Method::Patch, Some(id)) => update_category(req, env, identity, id).await,

        ("products", Method::Get, None) => list_products(req, env, identity).await,
        ("products", Method::Post, None) => create_product(req, env, identity).await,
        ("products", Method::Patch, Some(id)) => update_product(req, env, identity, id).await,

        _ => return None,
    })
}

/* ------------------------------------------------------------------ tables */

async fn list_tables(req: &Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    let all = wants_everything(req, identity)?;
    let db_handle = crate::env::db(env)?;
    Ok(Response::from_json(&db::list_tables(&db_handle, all).await?)?)
}

async fn create_table(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_role(identity, EDITORS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    // `createTableSchema` — the key order below is the schema's key order,
    // which is what makes "first issue wins" answer with the same issue zod
    // would have answered with.
    let name = body.string("name", &Str::name(20, "Table name is required"))?;
    let sort = body.opt_int("sort", &Int::SORT)?;

    let db_handle = crate::env::db(env)?;
    let row: Option<db::TableRow> = db_handle
        .prepare(
            "INSERT INTO \"tables\" (id, name, sort, active)
        VALUES (?1, ?2, COALESCE(?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM \"tables\")), 1)
        RETURNING id, name, sort, active",
        )
        .bind(&[
            db::text(&http::new_id("tbl")),
            db::text(&name),
            db::opt_number(sort.map(|value| value as f64)),
        ])?
        .first(None)
        .await?;

    created(row.as_ref().map(db::to_table))
}

async fn update_table(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    id: &str,
) -> ApiResult<Response> {
    middleware::require_role(identity, EDITORS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    if body.is_empty() {
        return Err(empty_patch());
    }
    let name = body.opt_string("name", &Str::name(20, "Table name is required"))?;
    let sort = body.opt_int("sort", &Int::SORT)?;
    let active = body.opt_bool("active")?;

    let db_handle = crate::env::db(env)?;
    let row: Option<db::TableRow> = db_handle
        .prepare(
            "UPDATE \"tables\"
        SET name = COALESCE(?2, name),
            sort = COALESCE(?3, sort),
            active = COALESCE(?4, active)
        WHERE id = ?1
        RETURNING id, name, sort, active",
        )
        .bind(&[db::text(id), db::opt_text(name.as_deref()), db::opt_number(sort.map(|value| value as f64)), db::opt_bool(active)])?
        .first(None)
        .await?;

    updated(row.as_ref().map(db::to_table), "table")
}

/* -------------------------------------------------------------- categories */

async fn list_categories(req: &Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    let all = wants_everything(req, identity)?;
    let db_handle = crate::env::db(env)?;
    Ok(Response::from_json(&db::list_categories(&db_handle, all).await?)?)
}

async fn create_category(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_role(identity, EDITORS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    let name = body.string("name", &Str::name(40, "Category name is required"))?;
    let sort = body.opt_int("sort", &Int::SORT)?;

    let db_handle = crate::env::db(env)?;
    let row: Option<db::CategoryRow> = db_handle
        .prepare(
            "INSERT INTO categories (id, name, sort, active)
        VALUES (?1, ?2, COALESCE(?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM categories)), 1)
        RETURNING id, name, sort, active",
        )
        .bind(&[
            db::text(&http::new_id("cat")),
            db::text(&name),
            db::opt_number(sort.map(|value| value as f64)),
        ])?
        .first(None)
        .await?;

    created(row.as_ref().map(db::to_category))
}

async fn update_category(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    id: &str,
) -> ApiResult<Response> {
    middleware::require_role(identity, EDITORS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    if body.is_empty() {
        return Err(empty_patch());
    }
    let name = body.opt_string("name", &Str::name(40, "Category name is required"))?;
    let sort = body.opt_int("sort", &Int::SORT)?;
    let active = body.opt_bool("active")?;

    let db_handle = crate::env::db(env)?;
    let row: Option<db::CategoryRow> = db_handle
        .prepare(
            "UPDATE categories
        SET name = COALESCE(?2, name),
            sort = COALESCE(?3, sort),
            active = COALESCE(?4, active)
        WHERE id = ?1
        RETURNING id, name, sort, active",
        )
        .bind(&[db::text(id), db::opt_text(name.as_deref()), db::opt_number(sort.map(|value| value as f64)), db::opt_bool(active)])?
        .first(None)
        .await?;

    updated(row.as_ref().map(db::to_category), "category")
}

/* ---------------------------------------------------------------- products */

async fn list_products(req: &Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    let all = wants_everything(req, identity)?;
    let db_handle = crate::env::db(env)?;
    Ok(Response::from_json(&db::list_products(&db_handle, all).await?)?)
}

async fn create_product(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_role(identity, EDITORS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    let category_id = body.string("categoryId", &Str::ID)?;
    let name = body.string("name", &Str::name(60, "Product name is required"))?;
    let price_minor = body.int("priceMinor", &Int::MINOR)?;
    let sort = body.opt_int("sort", &Int::SORT)?;

    let db_handle = crate::env::db(env)?;
    // The foreign key would catch this, and what it would produce is a D1
    // error with SQLite's wording on it, which `From<worker::Error>` turns into
    // a 500 — "something went wrong on our side" for a category the manager
    // just retired in another tab. One read, on a route used a few times a
    // week, buys a 400 that names the field.
    require_category(&db_handle, &category_id).await?;

    let row: Option<db::ProductRow> = db_handle
        .prepare(
            "INSERT INTO products (id, category_id, name, price_minor, sort, active)
        VALUES (?1, ?2, ?3, ?4,
                COALESCE(?5, (SELECT COALESCE(MAX(sort), 0) + 1 FROM products WHERE category_id = ?2)),
                1)
        RETURNING id, category_id, name, price_minor, sort, active",
        )
        .bind(&[
            db::text(&http::new_id("prd")),
            db::text(&category_id),
            db::text(&name),
            db::number(price_minor as f64),
            db::opt_number(sort.map(|value| value as f64)),
        ])?
        .first(None)
        .await?;

    created(row.as_ref().map(db::to_product))
}

async fn update_product(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    id: &str,
) -> ApiResult<Response> {
    middleware::require_role(identity, EDITORS)?;
    let raw = validate::read_json(req).await?;
    let body = validate::object(&raw)?;
    if body.is_empty() {
        return Err(empty_patch());
    }
    let category_id = body.opt_string("categoryId", &Str::ID)?;
    let name = body.opt_string("name", &Str::name(60, "Product name is required"))?;
    let price_minor = body.opt_int("priceMinor", &Int::MINOR)?;
    let sort = body.opt_int("sort", &Int::SORT)?;
    let active = body.opt_bool("active")?;

    let db_handle = crate::env::db(env)?;
    if let Some(category_id) = category_id.as_deref() {
        require_category(&db_handle, category_id).await?;
    }

    // Changing the price here changes what the *next* order costs and nothing
    // that has already been sent. An item copied the name and the price when
    // its round went to the kitchen — see `items.price_minor_snapshot` — so a
    // bill printed at six is not rewritten by an edit at seven. That is the one
    // denormalisation in the schema and it is the reason this route is safe to
    // use during service.
    let row: Option<db::ProductRow> = db_handle
        .prepare(
            "UPDATE products
        SET category_id = COALESCE(?2, category_id),
            name = COALESCE(?3, name),
            price_minor = COALESCE(?4, price_minor),
            sort = COALESCE(?5, sort),
            active = COALESCE(?6, active)
        WHERE id = ?1
        RETURNING id, category_id, name, price_minor, sort, active",
        )
        .bind(&[
            db::text(id),
            db::opt_text(category_id.as_deref()),
            db::opt_text(name.as_deref()),
            db::opt_number(price_minor.map(|value| value as f64)),
            db::opt_number(sort.map(|value| value as f64)),
            db::opt_bool(active),
        ])?
        .first(None)
        .await?;

    updated(row.as_ref().map(db::to_product), "product")
}

/* ------------------------------------------------------------------ shared */

/// Does this request want the retired rows too?
///
/// `?include=all`, and only an editor may ask. The check is here rather than in
/// each `list_*` so that the three cannot drift, and it answers 403 rather than
/// quietly handing back the active-only list: a manager who asked for the whole
/// floor and got half of it would conclude the retired tables had been deleted.
fn wants_everything(req: &Request, identity: &Identity) -> ApiResult<bool> {
    let url = req.url().map_err(http::ApiError::from)?;
    let asked = url.query_pairs().any(|(key, value)| key == "include" && value == "all");
    if !asked {
        // Reading the live menu needs somebody signed in and nothing more. A
        // waiter and a cashier both draw from it.
        middleware::require_staff(identity)?;
        return Ok(false);
    }
    middleware::require_role(identity, EDITORS)?;
    Ok(true)
}

/// A category has to exist before a product can point at it.
///
/// Retired is still existing: a manager moving a product into a category they
/// took off the waiter's chips is doing something deliberate and reversible,
/// and refusing it would make an inactive category a trap rather than a shelf.
async fn require_category(db: &D1Database, id: &str) -> ApiResult<()> {
    let found: Option<db::CategoryRow> = db
        .prepare("SELECT id, name, sort, active FROM categories WHERE id = ?1")
        .bind(&[db::text(id)])?
        .first(None)
        .await?;
    match found {
        Some(_) => Ok(()),
        None => Err(http::bad_request("categoryId: No such category")),
    }
}

/// 201 with the row as it now stands.
///
/// The `None` arm cannot happen — an `INSERT … RETURNING` that inserted a row
/// returns it — and is answered with the internal error rather than an
/// `unwrap`, because a panic in a Worker takes the isolate down and loses every
/// other request in flight on it. A 500 loses one.
fn created<T: serde::Serialize>(row: Option<T>) -> ApiResult<Response> {
    match row {
        Some(row) => Ok(Response::from_json(&row)?.with_status(201)),
        None => Err(http::internal()),
    }
}

/// 200 with the row as it now stands, or 404 when the `WHERE` matched nothing.
///
/// This is why every update here is `UPDATE … RETURNING` rather than an update
/// followed by a read: one statement, and the absence of a returned row *is*
/// the "no such row" answer. Two statements would have a window between them in
/// which the row could go, and would cost a second round trip to learn what the
/// first already knew.
fn updated<T: serde::Serialize>(row: Option<T>, noun: &str) -> ApiResult<Response> {
    match row {
        Some(row) => Ok(Response::from_json(&row)?),
        None => Err(http::not_found(format!("No such {noun}"))),
    }
}

/// `{}` is a valid body for every `PATCH` here — each is an all-optional zod
/// object — and a meaningless request.
///
/// The statements are built from `COALESCE(?, column)`, so an empty body sets
/// every column to itself: a write that changes nothing and a 200 that tells
/// the caller it worked. zod has nothing to say about it, so this is the
/// Worker's own rule, and it says which field was expected rather than only
/// that one was.
fn empty_patch() -> http::ApiError {
    http::bad_request("Give at least one field to change")
}
