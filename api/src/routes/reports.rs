//! The day's takings: `/reports`.
//!
//! One route, and there should stay one. `CLAUDE.md` puts reports beyond the
//! daily total out of scope, and that is a decision about what this product is
//! rather than a corner cut: a restaurant that wants to know which curry sells
//! on Tuesdays wants a spreadsheet and an export, not a screen in the till that
//! nobody has time to read during service.
//!
//! ## "Today" belongs to the restaurant, not to the Worker
//!
//! A Worker in a Singapore colo and a Worker in a London one both think it is
//! whatever UTC says, and neither of them is standing in the dining room. The
//! day here runs from local midnight — `TZ_OFFSET_MINUTES` ahead of UTC, 390 for
//! Myanmar — to the same instant tomorrow, so a bill settled at five past
//! midnight belongs to the new day rather than to the shift that was still
//! stacking chairs. `pos_core::clock` does the arithmetic and its twin in
//! `shared/src/time.ts` does the same arithmetic with the same test cases, which
//! is what stops the screen and the query disagreeing about which day it is.
//!
//! The window is computed here and passed to the query as two ISO strings, so
//! SQLite is never asked what time it is. It is also carried in the response:
//! a screen that says "since 00:00" is then quoting the window that was summed
//! rather than guessing at one, and the day somebody changes the offset, the
//! number and the window move together.

use serde::Serialize;
use worker::{Env, Method, Request, Response};

use pos_core::clock;

use crate::db;
use crate::http::ApiResult;
use crate::middleware::{self, Identity};

/// Who may see the takings. The manager, and — deliberately — nobody else: a
/// waiter's tablet is left on a counter, and the number on this screen is the
/// one thing in the app that is nobody's business but the owner's.
const ADMINS: &[&str] = &["admin"];

/// A day, in milliseconds. The window is `[start, start + DAY)`, half-open, so
/// a payment taken at exactly local midnight is counted once and by the day
/// that is beginning.
///
/// A constant rather than `start_of_zoned_day` applied to tomorrow, because the
/// offset is fixed and nothing near this restaurant observes daylight saving —
/// which is the same assumption `pos_core::clock` is built on, stated once more
/// where it is being relied upon.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    match (req.method(), req.path().as_str()) {
        (Method::Get, "/reports/sales/today") => Some(sales_today(env, identity).await),
        _ => None,
    }
}

async fn sales_today(env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_role(identity, ADMINS)?;

    let offset = crate::env::tz_offset_minutes(env);
    let now_ms = crate::js::now_ms() as i64;
    let day_start_ms = clock::start_of_zoned_day(now_ms, offset);
    let day_start = crate::http::iso_of(day_start_ms as f64);
    let day_end = crate::http::iso_of((day_start_ms + DAY_MS) as f64);

    let db_handle = crate::env::db(env)?;
    let totals = db::sales_between(&db_handle, &day_start, &day_end).await?;

    // `salesTodaySchema`'s key order: the window first, because it is what the
    // three numbers under it are true *of*.
    Ok(Response::from_json(&SalesToday {
        day_start,
        day_end,
        total_minor: totals.total_minor,
        by_method: totals.by_method,
        check_count: totals.check_count,
    })?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SalesToday {
    day_start: String,
    day_end: String,
    total_minor: i64,
    by_method: db::MethodTotals,
    check_count: i64,
}
