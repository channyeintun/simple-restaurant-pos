//! Ordering: `/checks` and `/rounds`.
//!
//! Two prefixes, one router, because they are one subject. A round is not a
//! thing a client creates on a check it already has — on the first send of a
//! seating there is no check yet, and there must not be: a check with no rounds
//! on it is a table somebody tapped and walked away from, and neither the
//! kitchen nor the cashier has any use for one. **The table is the identity**,
//! and `POST /rounds` opens a check for it if there is not one already.
//!
//! ## Everything that writes does so in one `batch`
//!
//! A D1 batch is one transaction: every statement commits or none does. It
//! cannot branch, so every condition that would be an `if` in a read-then-write
//! pair is a `WHERE` clause instead, and the guarded statement's `changes` is
//! how the handler finds out which way it went. That is not a stylistic
//! preference — a read-then-write pair has a window in it, and the windows here
//! are the ones where a table gets two bills, a line gets voided twice, or a
//! customer pays for food that arrived after the cashier read the total.
//!
//! ## Everything that writes answers with the whole check
//!
//! Not `{ ok: true }`. The screen that sent the round is about to draw the
//! check with the round on it, and the response it already has is the cheapest
//! possible way to tell it — the same principle the realtime payloads are built
//! on, applied to the reply a client is holding anyway. It costs one assembled
//! read on a route that has just done several writes.
//!
//! ## `emit` is the last thing and it cannot fail
//!
//! The D1 write has committed by the time anything is published, and clients
//! poll as a backstop, so a Redis failure is logged and swallowed. Nothing in
//! this file turns a realtime problem into a 500 — a cashier's board that is
//! five seconds out of date is a smaller problem than a waiter being told their
//! order did not go through when it did.

use serde_json::json;
use wasm_bindgen::JsValue;
use worker::d1::{D1Database, D1PreparedStatement};
use worker::{Env, Method, Request, Response};

use pos_core::totals;

use crate::db;
use crate::http::{self, ApiResult};
use crate::middleware::{self, Identity};
use crate::realtime::create_pub_sub;
use crate::validate::{self as body, Int, Str};

/// `RESTAURANT_CHANNEL` from `shared/src/events.ts`, taken from the router that
/// guards it rather than written out again.
///
/// `routes/realtime.rs` owns the string because it owns the allowlist that
/// decides what a client may subscribe to, and a publisher that spelled the
/// channel itself would be a second literal agreeing with the first by
/// coincidence. Importing it means a rename is one edit.
use crate::routes::realtime::RESTAURANT_CHANNEL;

/// Who may take money. The manager counts as a cashier — an owner covering the
/// till on a quiet Tuesday should not meet a 403, and every cashier gate in
/// this app is written this way for that reason.
const TILLS: &[&str] = &["cashier", "admin"];

pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let mut segments = path.split('/').skip(1);
    let head = segments.next()?;

    if head == "rounds" {
        if segments.next().is_some() {
            return None;
        }
        return match req.method() {
            Method::Post => Some(send_round(req, env, identity).await),
            _ => None,
        };
    }

    if head != "checks" {
        return None;
    }

    // Collected rather than matched as a tuple, because the longest path here
    // is four segments deep — `/checks/:id/items/:itemId/void` — and a
    // five-slot tuple with `None`s down the right-hand side is unreadable. An
    // empty segment anywhere means a trailing or doubled slash, which is not a
    // route.
    let rest: Vec<&str> = segments.collect();
    if rest.iter().any(|segment| segment.is_empty()) {
        return None;
    }

    Some(match (req.method(), rest.as_slice()) {
        (Method::Get, []) => list_open(env, identity).await,
        // `by-table` sits where an id would. Check ids are `chk_` and twenty
        // hex characters, so the two cannot be confused by anything a client
        // could legitimately send — the same arrangement `/staff/roster` uses.
        (Method::Get, ["by-table", table_id]) => for_table(env, identity, table_id).await,
        (Method::Get, [id]) => one(env, identity, id).await,
        (Method::Post, [id, "items", item_id, "void"]) => {
            void_item(env, identity, id, item_id).await
        }
        (Method::Post, [id, "rounds", round_id, "delivered"]) => {
            deliver_round(env, identity, id, round_id).await
        }
        (Method::Post, [id, "pay"]) => pay(req, env, identity, id).await,
        // Three segments, so it cannot be confused with the four-segment
        // `[id, "items", item_id, "void"]` above, and `/pay` goes on meaning
        // the whole check unambiguously.
        (Method::Post, [id, "items", "pay"]) => pay_items(req, env, identity, id).await,
        _ => return None,
    })
}

/* ------------------------------------------------------------------- reads */

/// The cashier's board and the waiter's table grid, in one list.
///
/// Both screens want the same four facts about every open check, so they share
/// a route and a cache key. It is `require_staff` rather than a till role: a
/// waiter has to see which of their tables are occupied and what they have run
/// up, and that is the same list.
async fn list_open(env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_staff(identity)?;
    let db_handle = crate::env::db(env)?;
    Ok(Response::from_json(&db::list_open_checks(&db_handle).await?)?)
}

async fn one(env: &Env, identity: &Identity, check_id: &str) -> ApiResult<Response> {
    middleware::require_staff(identity)?;
    let db_handle = crate::env::db(env)?;
    match db::check_detail(&db_handle, check_id).await? {
        Some(detail) => Ok(Response::from_json(&detail)?),
        None => Err(http::not_found("No such check")),
    }
}

/// The open check on a table, or `null`.
///
/// `null` with a 200 rather than a 404, and the difference matters to the screen
/// that asks: "this table is free" is an answer, and the waiter's right-hand
/// pane draws an empty cart for it. A 404 would be indistinguishable from a
/// mistyped id and would have the client showing an error for the commonest
/// state a table is in.
async fn for_table(env: &Env, identity: &Identity, table_id: &str) -> ApiResult<Response> {
    middleware::require_staff(identity)?;
    let db_handle = crate::env::db(env)?;
    match db::open_check_for_table(&db_handle, table_id).await? {
        Some(detail) => Ok(Response::from_json(&detail)?),
        None => Ok(Response::from_json(&serde_json::Value::Null)?),
    }
}

/* -------------------------------------------------------------- the send */

/// One tap of **Send to kitchen**.
///
/// The whole of the ordering path, and the one route in this app where getting
/// it slightly wrong means food cooked twice or food nobody cooks. It goes:
///
///  1. **replay?** The client's key is looked up first, before anything is
///     written. Found means this exact tap already landed and the answer is the
///     check as it now stands — no insert, no second ticket.
///  2. **price it.** The menu is read here and snapshotted onto the lines. The
///     client does not send prices, so a tablet holding yesterday's cached menu
///     cannot charge yesterday's prices.
///  3. **write it**, in one batch, with the find-or-open expressed as a `WHERE
///     NOT EXISTS` so that two waiters on one table produce one check.
///  4. **confirm it.** The round is read back by its key. Absent means the
///     batch's guards all declined — the check was paid a moment ago — and the
///     honest answer is a 409 rather than a 200 over nothing.
///  5. **tell the room.** `check.opened` if this send opened one, then
///     `round.sent`, and neither can fail the request.
async fn send_round(req: &mut Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    middleware::require_staff(identity)?;
    let staff_id = identity.staff_id.clone().unwrap_or_default();
    let staff_name = identity.staff_name.clone().unwrap_or_default();

    let raw = body::read_json(req).await?;
    let input = parse_send(&raw)?;

    let db_handle = crate::env::db(env)?;

    // 1. The replay, before any write. A tablet that lost the reply and asked
    //    again gets the same answer it did not hear the first time.
    if let Some(existing) = round_check_id(&db_handle, &input.client_key).await? {
        let Some(detail) = db::check_detail(&db_handle, &existing).await? else {
            return Err(http::internal());
        };
        // 200 rather than 201: nothing was created by *this* request, and a
        // client that distinguishes the two learns whether it was the one that
        // got through.
        return Ok(Response::from_json(&detail)?);
    }

    // 2. The menu, as it is now. Every line has to resolve to an active product
    //    or the whole send is refused — an order silently one dish shorter is
    //    worse than an order that failed, because nobody finds out until the
    //    table asks where it is.
    let ids: Vec<String> = input.items.iter().map(|item| item.product_id.clone()).collect();
    let products = db::products_by_id(&db_handle, &ids).await?;
    let mut priced: Vec<PricedLine> = Vec::with_capacity(input.items.len());
    for item in &input.items {
        let Some(product) = products.iter().find(|row| row.id == item.product_id) else {
            return Err(http::bad_request(format!(
                "items: No such product on the menu ({})",
                item.product_id
            )));
        };
        priced.push(PricedLine {
            id: http::new_id("itm"),
            product_id: product.id.clone(),
            name: product.name.clone(),
            price_minor: product.price_minor,
            prep_minutes: product.prep_minutes,
            qty: item.qty,
            note: item.note.clone(),
        });
    }

    // One timestamp for the whole operation. Calling `now_iso()` twice would
    // give the check, the round and the job three instants a millisecond apart
    // — and worse, any statement guarded on "the row I just stamped" would stop
    // matching.
    let at = http::now_iso();
    let new_check_id = http::new_id("chk");
    let round_id = http::new_id("rnd");

    // 3. The batch. `open_check` is `None` when the round is joining a check
    //    that already exists, which is the only case where nothing is opened.
    let mut statements: Vec<D1PreparedStatement> = Vec::new();
    let opened_index = match &input.target {
        Target::Check(check_id) => {
            // Adding to a takeaway order that is already open. Nothing to open,
            // and the round's own `WHERE` is what refuses a check that has
            // since been paid.
            let _ = check_id;
            None
        }
        Target::Table(table_id) => {
            // The find-or-open, and the reason this route is a batch at all.
            //
            // `WHERE NOT EXISTS` is evaluated by SQLite as part of the write,
            // against the table as it is at that moment. Two waiters tapping
            // Send on table 4 in the same second: D1 serialises the writes, the
            // second batch's `NOT EXISTS` sees the first one's check, inserts
            // nothing, and its round attaches to that check as seq 2. One bill,
            // two tickets, which is what actually happened in the room.
            //
            // `idx_checks_open_table` stays as the backstop rather than the
            // mechanism. If it ever fires, the batch rolls back and step 4
            // notices the round is missing.
            statements.push(
                db_handle
                    .prepare(
                        "INSERT INTO checks (id, table_id, opened_by, status, opened_at, closed_at)
        SELECT ?1, ?2, ?3, 'open', ?4, NULL
        WHERE NOT EXISTS (SELECT 1 FROM checks
                           WHERE table_id = ?2 AND status = 'open')",
                    )
                    .bind(&[
                        db::text(&new_check_id),
                        db::text(table_id),
                        db::text(&staff_id),
                        db::text(&at),
                    ])?,
            );
            Some(statements.len() - 1)
        }
        Target::NewTakeaway => {
            // No table to collide over, so no guard: takeaway and the counter
            // are checks with nothing under them and there may be any number
            // open at once.
            statements.push(
                db_handle
                    .prepare(
                        "INSERT INTO checks (id, table_id, opened_by, status, opened_at, closed_at)
        VALUES (?1, NULL, ?2, 'open', ?3, NULL)",
                    )
                    .bind(&[db::text(&new_check_id), db::text(&staff_id), db::text(&at)])?,
            );
            Some(statements.len() - 1)
        }
    };

    // The round, attached to whichever check is open *now* — the one the
    // statement above just made, or the one another waiter made a second ago.
    // `seq` is computed in the same statement rather than read first, so two
    // sends a second apart cannot both claim to be round 3; `UNIQUE (check_id,
    // seq)` is the backstop behind that.
    statements.push(match &input.target {
        Target::Check(check_id) => db_handle
            .prepare(
                "INSERT INTO rounds (id, check_id, seq, sent_by, sent_at, client_key)
        SELECT ?1, c.id,
               (SELECT COALESCE(MAX(r.seq), 0) + 1 FROM rounds r WHERE r.check_id = c.id),
               ?2, ?3, ?4
        FROM checks c
        WHERE c.id = ?5 AND c.status = 'open'",
            )
            .bind(&[
                db::text(&round_id),
                db::text(&staff_id),
                db::text(&at),
                db::text(&input.client_key),
                db::text(check_id),
            ])?,
        Target::Table(table_id) => db_handle
            .prepare(
                "INSERT INTO rounds (id, check_id, seq, sent_by, sent_at, client_key)
        SELECT ?1, c.id,
               (SELECT COALESCE(MAX(r.seq), 0) + 1 FROM rounds r WHERE r.check_id = c.id),
               ?2, ?3, ?4
        FROM checks c
        WHERE c.table_id = ?5 AND c.status = 'open'",
            )
            .bind(&[
                db::text(&round_id),
                db::text(&staff_id),
                db::text(&at),
                db::text(&input.client_key),
                db::text(table_id),
            ])?,
        Target::NewTakeaway => db_handle
            .prepare(
                "INSERT INTO rounds (id, check_id, seq, sent_by, sent_at, client_key)
        SELECT ?1, c.id, 1, ?2, ?3, ?4
        FROM checks c
        WHERE c.id = ?5 AND c.status = 'open'",
            )
            .bind(&[
                db::text(&round_id),
                db::text(&staff_id),
                db::text(&at),
                db::text(&input.client_key),
                db::text(&new_check_id),
            ])?,
    });

    // The lines, and then the ticket. Both guarded on the round existing, so
    // that a round which found no open check leaves a batch that writes nothing
    // rather than one that dies on a foreign key — the difference between a 409
    // that says what happened and a 500 that says nothing.
    for line in &priced {
        statements.push(
            db_handle
                .prepare(
                    "INSERT INTO items (id, round_id, product_id, name_snapshot,
                           price_minor_snapshot, prep_minutes_snapshot, qty, note)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?2)",
                )
                .bind(&[
                    db::text(&line.id),
                    db::text(&round_id),
                    db::text(&line.product_id),
                    db::text(&line.name),
                    db::number(line.price_minor as f64),
                    db::number(line.prep_minutes as f64),
                    db::number(line.qty as f64),
                    db::opt_text(line.note.as_deref()),
                ])?,
        );
    }

    statements.push(
        db_handle
            .prepare(
                "INSERT INTO print_jobs (id, round_id, item_id, kind, status, attempts, created_at)
        SELECT ?1, ?2, NULL, 'ticket', 'pending', 0, ?3
        WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?2)",
            )
            .bind(&[db::text(&http::new_id("job")), db::text(&round_id), db::text(&at)])?,
    );

    let results = db_handle.batch(statements).await?;

    // 4. Did the round land? The client key is the question and the index on it
    //    is the answer: if two copies of this request were genuinely in flight,
    //    the loser failed that index, its batch rolled back, and this read finds
    //    the winner's round — which is the right answer for both of them.
    let Some(check_id) = round_check_id(&db_handle, &input.client_key).await? else {
        return Err(http::conflict(
            "That check is no longer open. Open the table again and re-send.",
        ));
    };

    let Some(detail) = db::check_detail(&db_handle, &check_id).await? else {
        return Err(http::internal());
    };

    // Whether *this* request opened the check, read off the guarded statement
    // rather than inferred: `NOT EXISTS` declining is a zero here and a check
    // somebody else opened a second ago.
    let opened_now = opened_index
        .and_then(|index| results.get(index))
        .and_then(|result| result.meta().ok().flatten())
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0);

    // 5. The room. `emit` never fails and is never awaited for its result.
    let pubsub = create_pub_sub(env);
    if opened_now {
        pubsub
            .emit(
                &[RESTAURANT_CHANNEL],
                "check.opened",
                &json!({
                    "checkId": detail.id,
                    "tableId": detail.table_id,
                    "staffName": staff_name,
                    "at": at,
                }),
            )
            .await;
    }

    let round = detail.rounds.iter().find(|round| round.id == round_id);
    pubsub
        .emit(
            &[RESTAURANT_CHANNEL],
            "round.sent",
            &json!({
                "checkId": detail.id,
                "roundId": round_id,
                "seq": round.map_or(1, |round| round.seq),
                "items": round.map(|round| &round.items),
                "checkTotal": detail.total_minor,
                "at": at,
            }),
        )
        .await;

    Ok(Response::from_json(&detail)?.with_status(201))
}

/* ------------------------------------------------------------------ voids */

/// Strike a line off a round that has already printed.
///
/// Never a delete: `voided_at` and `voided_by` are set and the row stays,
/// because the bill has to be honest about what was struck off and by whom, and
/// because the kitchen is holding a slip that says to cook it.
///
/// Which is the other half of this route. A void on a sent round **creates a
/// void print job**, so the kitchen is told in the same physical way they were
/// told to cook it. The two statements are one batch and the second is guarded
/// on the first's own timestamp — `voided_at = ?stamp` — so the job exists if
/// and only if this request is the one that did the voiding. A line voided
/// twice by two taps produces one job, not two.
///
/// `require_staff` and not a till role. The waiter who mis-sent the line is
/// standing at the table and is the person who should strike it off; `voided_by`
/// is what carries the accountability.
///
/// ## A line somebody has paid for cannot be struck off
///
/// `NOT EXISTS (an allocation against this item)`, new in 0004. The case was
/// unreachable before it: voiding needs the check open, and taking the money
/// closed it. Partial settlement makes it reachable for the first time, and
/// what it would do is take a paid dish off the bill, tell the kitchen to
/// cancel food a customer has already paid for, and leave the money with
/// nothing to point at — in an API where `amount_minor >= 0` means a refund is
/// not even expressible. The refusal is the honest answer until there is a
/// route that can give money back.
///
/// It guards on any allocation, not on the line being *fully* paid: one of four
/// beers settled is still a beer somebody bought.
async fn void_item(
    env: &Env,
    identity: &Identity,
    check_id: &str,
    item_id: &str,
) -> ApiResult<Response> {
    middleware::require_staff(identity)?;
    let staff_id = identity.staff_id.clone().unwrap_or_default();

    let at = http::now_iso();
    let db_handle = crate::env::db(env)?;

    let results = db_handle
        .batch(vec![
            db_handle
                .prepare(
                    "UPDATE items
        SET voided_at = ?2,
            voided_by = ?3
        WHERE id = ?1
          AND voided_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM payment_items a WHERE a.item_id = ?1)
          AND round_id IN (SELECT r.id FROM rounds r
                             JOIN checks c ON c.id = r.check_id
                            WHERE c.id = ?4 AND c.status = 'open')",
                )
                .bind(&[
                    db::text(item_id),
                    db::text(&at),
                    db::text(&staff_id),
                    db::text(check_id),
                ])?,
            db_handle
                .prepare(
                    "INSERT INTO print_jobs (id, round_id, item_id, kind, status, attempts, created_at)
        SELECT ?1, i.round_id, i.id, 'void', 'pending', 0, ?2
        FROM items i
        WHERE i.id = ?3 AND i.voided_at = ?2",
                )
                .bind(&[db::text(&http::new_id("job")), db::text(&at), db::text(item_id)])?,
        ])
        .await?;

    let struck = results
        .first()
        .and_then(|result| result.meta().ok().flatten())
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0);
    if !struck {
        // Three ways to get here and one message, because the answer to all
        // three is the same: look at the check again. It was already voided,
        // the check has been paid, or the line is not on this check at all.
        return Err(http::conflict("That line cannot be voided now. Check the bill again."));
    }

    let Some(detail) = db::check_detail(&db_handle, check_id).await? else {
        return Err(http::internal());
    };

    create_pub_sub(env)
        .emit(
            &[RESTAURANT_CHANNEL],
            "item.voided",
            &json!({
                "checkId": detail.id,
                "itemId": item_id,
                "checkTotal": detail.total_minor,
                "at": at,
            }),
        )
        .await;

    Ok(Response::from_json(&detail)?)
}

/* ------------------------------------------------------------- delivering */

/// The waiter carried this round to the table.
///
/// The one write in this app that records something the software could not
/// otherwise know. Everything else here is the consequence of a tap that also
/// *did* something — a round was sent, a line was struck off, money changed
/// hands — and this is a tap whose whole purpose is to say that a thing
/// happened in the room.
///
/// It is what stops the clock. A round with `delivered_at` NULL is outstanding,
/// and that is what every timer in the app reads: the countdown on the round,
/// the age on the waiter's table tile, the amber and red. A round nobody marks
/// stays outstanding and goes on showing late, which is the honest behaviour —
/// the alternative is software quietly deciding that food arrived.
///
/// `require_staff` rather than a till role, and no ownership check beyond that.
/// Plates get carried by whoever has a free hand; a waiter who delivers
/// somebody else's table is helping, not doing something that needs refusing.
/// `delivered_by` records which of them it was.
///
/// Guarded on `delivered_at IS NULL` so that two waiters tapping it — which is
/// exactly what happens when two people carry one round between them — leaves
/// the first stamp standing rather than quietly moving the time later. The
/// second tap is not an error worth a red screen either: the round *is*
/// delivered, which is what the person meant, so the answer is the check as it
/// stands.
async fn deliver_round(
    env: &Env,
    identity: &Identity,
    check_id: &str,
    round_id: &str,
) -> ApiResult<Response> {
    middleware::require_staff(identity)?;
    let staff_id = identity.staff_id.clone().unwrap_or_default();

    let at = http::now_iso();
    let db_handle = crate::env::db(env)?;

    let result = db_handle
        .prepare(
            "UPDATE rounds
        SET delivered_at = ?2,
            delivered_by = ?3
        WHERE id = ?1
          AND check_id = ?4
          AND delivered_at IS NULL",
        )
        .bind(&[db::text(round_id), db::text(&at), db::text(&staff_id), db::text(check_id)])?
        .run()
        .await?;

    let Some(detail) = db::check_detail(&db_handle, check_id).await? else {
        return Err(http::not_found("No such check"));
    };

    let changed = result
        .meta()
        .ok()
        .flatten()
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0);

    // A round this check does not have is a 404; one already delivered is not.
    if !changed && !detail.rounds.iter().any(|round| round.id == round_id) {
        return Err(http::not_found("No such round on this check"));
    }

    // Only on the transition. A second tap publishes nothing — every event is
    // three Redis commands, and the board's count is already right.
    if changed {
        // What the check still has out, computed from the detail that was just
        // read rather than counted again — so the numbers on the event and the
        // numbers in the response cannot disagree.
        let outstanding: Vec<&db::RoundDetail> =
            detail.rounds.iter().filter(|round| round.delivered_at.is_none()).collect();
        let oldest = outstanding.first();

        create_pub_sub(env)
            .emit(
                &[RESTAURANT_CHANNEL],
                "round.delivered",
                &json!({
                    "checkId": detail.id,
                    "roundId": round_id,
                    "at": at,
                    "outstandingRounds": outstanding.len(),
                    "oldestOutstandingAt": oldest.map(|round| &round.sent_at),
                    "oldestOutstandingTargetMinutes": oldest.map_or(0, |round| round.target_minutes),
                }),
            )
            .await;
    }

    Ok(Response::from_json(&detail)?)
}

/* --------------------------------------------------------------- payment */

/// Take the money and close the check.
///
/// The amount is **not** in the body. It is the check's own total, computed
/// here from the live lines by `pos_core::totals`, so there is no route by
/// which a client decides what a customer paid. What the client does send is
/// `expectedTotalMinor` — what the cashier was looking at when they took the
/// money — and the two disagreeing is a 409 rather than a charge.
///
/// That is not a formality. A cashier reads a total, counts out change, and
/// taps; in between, a waiter at the table can send another round or strike a
/// line off. Without the check, the bill closes at whatever it happens to come
/// to now — a customer charged for a dish they did not order, or a dish given
/// away — and neither is discoverable afterwards.
///
/// ## The order of the two statements, and why it was turned around
///
/// The payment is written **first**, carrying the whole guard, and the close
/// hangs off the payment having been written. It used to be the other way
/// about — close first, payment guarded on `closed_at = ?stamp` — and that had
/// a one-millisecond hole in it that per-item settlement would have widened
/// into a habit. `?stamp` is this request's own `now_iso()`, so two pays
/// landing in the same millisecond compute the same value: the loser's UPDATE
/// correctly matches nothing and answers 409, and its INSERT then finds
/// `closed_at = ?stamp` perfectly true, because the *winner* wrote that stamp.
/// A second full-amount payment row, on a check the API just told the till it
/// had failed to settle.
///
/// Writing the money first fixes it by construction: `payments.id` is minted
/// per request and `EXISTS (SELECT 1 FROM payments WHERE id = ?1)` can only be
/// true for the request that minted it. Nothing else in the batch depends on a
/// value another request could have written.
///
/// ## The third component of the fingerprint
///
/// The guard used to count rounds and live lines. Neither moves when somebody
/// settles two dishes out of a table's six, so a till holding a screen from
/// before that would have charged the full total on top of it — the sharpest
/// hazard the whole feature has. It now counts settled **units** as well, which
/// is precisely what a per-item payment changes and nothing else does.
async fn pay(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    check_id: &str,
) -> ApiResult<Response> {
    middleware::require_role(identity, TILLS)?;
    let staff_id = identity.staff_id.clone().unwrap_or_default();

    let raw = body::read_json(req).await?;
    let fields = body::object(&raw)?;
    let method = fields.enum_of("method", &["cash", "card", "other"])?;
    let expected = fields.int("expectedTotalMinor", &Int::MINOR)?;

    let db_handle = crate::env::db(env)?;
    let Some(before) = db::check_detail(&db_handle, check_id).await? else {
        return Err(http::not_found("No such check"));
    };
    if before.status != "open" {
        return Err(http::conflict("That check has already been settled."));
    }

    // What is **owed**, not what the meal cost. On a check nobody has split the
    // two are the same number, which is every check this route saw before 0004;
    // on one where two of the four diners have already paid, charging the gross
    // total would take their money a second time.
    let lines = before.lines();
    let owed = totals::check_outstanding_minor(&lines);
    if owed != expected {
        // The new figure is in the message, because the cashier is holding cash
        // and needs the number rather than an instruction to go and look.
        return Err(http::conflict_with(
            format!("The total has changed to {owed}. Check the bill and try again."),
            http::code::CONFLICT,
        ));
    }

    let payment_id = http::new_id("pay");

    let at = http::now_iso();
    let results = db_handle
        .batch(vec![
            // [0] The money, carrying the whole guard.
            //
            // Three counts, and they are the check's fingerprint: a round sent
            // between the read and this statement changes the first, a void
            // changes the second, and somebody settling part of the table
            // changes the third. Any of them moving means the figure on the
            // cashier's screen is no longer what is owed, so the row does not
            // match and nothing at all is written.
            db_handle
                .prepare(
                    "INSERT INTO payments (id, check_id, method, amount_minor, taken_by, at)
        SELECT ?1, c.id, ?2, ?3, ?4, ?5
        FROM checks c
        WHERE c.id = ?6
          AND c.status = 'open'
          AND (SELECT COUNT(*) FROM rounds WHERE check_id = c.id) = ?7
          AND (SELECT COUNT(*) FROM items i
                 JOIN rounds r ON r.id = i.round_id
                WHERE r.check_id = c.id AND i.voided_at IS NULL) = ?8
          AND (SELECT COALESCE(SUM(a.qty_paid), 0) FROM payment_items a
                 JOIN items i ON i.id = a.item_id
                 JOIN rounds r ON r.id = i.round_id
                WHERE r.check_id = c.id) = ?9",
                )
                .bind(&[
                    db::text(&payment_id),
                    db::text(&method),
                    db::number(owed as f64),
                    db::text(&staff_id),
                    db::text(&at),
                    db::text(check_id),
                    db::number(before.rounds.len() as f64),
                    db::number(live_line_count(&before) as f64),
                    db::number(paid_units(&before) as f64),
                ])?,
            // [1] What it bought: every unit of every live line that nobody had
            // settled yet. Set-based rather than a statement per line, so the
            // batch is three statements whatever the size of the dinner.
            //
            // The allocation is what makes "pay the whole check" and "pay these
            // two dishes" the same kind of event afterwards: there is no
            // payment in this database whose subject is unknown, and a closed
            // check's outstanding total computes to zero without a special case.
            db_handle
                .prepare(
                    "INSERT INTO payment_items (payment_id, item_id, qty_paid)
        SELECT ?1,
               i.id,
               i.qty - COALESCE((SELECT SUM(a.qty_paid) FROM payment_items a
                                  WHERE a.item_id = i.id), 0)
        FROM items i
        JOIN rounds r ON r.id = i.round_id
        WHERE r.check_id = ?2
          AND i.voided_at IS NULL
          AND i.qty - COALESCE((SELECT SUM(a.qty_paid) FROM payment_items a
                                 WHERE a.item_id = i.id), 0) > 0
          AND EXISTS (SELECT 1 FROM payments p WHERE p.id = ?1)",
                )
                .bind(&[db::text(&payment_id), db::text(check_id)])?,
            // [2] The close, hanging off the payment rather than off a
            // timestamp. `payment_id` is minted per request, so this can only
            // be true for the request that minted it — which is the whole
            // difference between this shape and the one it replaced.
            db_handle
                .prepare(
                    "UPDATE checks
        SET status = 'paid',
            closed_at = ?2
        WHERE id = ?1
          AND status = 'open'
          AND EXISTS (SELECT 1 FROM payments p WHERE p.id = ?3)",
                )
                .bind(&[db::text(check_id), db::text(&at), db::text(&payment_id)])?,
        ])
        .await?;

    let paid = results
        .first()
        .and_then(|result| result.meta().ok().flatten())
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0);
    if !paid {
        return Err(http::conflict("The check changed while you were paying. Try again."));
    }

    let Some(detail) = db::check_detail(&db_handle, check_id).await? else {
        return Err(http::internal());
    };

    create_pub_sub(env)
        .emit(
            &[RESTAURANT_CHANNEL],
            "check.paid",
            &json!({
                "checkId": detail.id,
                "tableId": detail.table_id,
                "method": method,
                "at": at,
            }),
        )
        .await;

    Ok(Response::from_json(&detail)?)
}

/// Take the money for part of a table, and leave the check open unless that was
/// the last of it.
///
/// The sibling of [`pay`], and the request the owner actually made: four
/// friends, one of whom is leaving, wanting to settle their own dish.
///
/// ## The unit is a unit of a line, not a line
///
/// `addProduct` in the waiter's cart merges a second tap of the same tile into
/// the line already there, so four beers for four people is **one row with
/// `qty 4`** — the most-split line there is. A route that could only take whole
/// rows would fail exactly the case it exists for. So the body names
/// `{ itemId, qty }` and the allocation records a quantity, which also means no
/// `items` row is ever split or mutated: the row the kitchen ticket was
/// rendered from, and that `print_jobs.item_id` points at, is byte-identical
/// afterwards.
///
/// ## Why it needs a client key when [`pay`] did not
///
/// Because it does not close the check. "At most one payment row" used to fall
/// out of "at most one request can close it"; a payment that leaves the table
/// open has no close to hang on. The failure is `rounds.client_key`'s, and
/// worse: a repeat of a per-item payment is indistinguishable from a
/// legitimate *second* settlement of the same dish, so only the tablet can say
/// which one it meant, and a retry that minted a fresh key would take the money
/// twice.
///
/// ## `require_role(TILLS)`, unlike voiding
///
/// Voiding is `require_staff`, because the waiter who mis-sent a line is the
/// right person to strike it off. Taking cash is not the same act, and the
/// tablet in an apron pocket is not the one that should be able to.
async fn pay_items(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    check_id: &str,
) -> ApiResult<Response> {
    middleware::require_role(identity, TILLS)?;
    let staff_id = identity.staff_id.clone().unwrap_or_default();

    let raw = body::read_json(req).await?;
    let input = parse_pay_items(&raw)?;

    let db_handle = crate::env::db(env)?;

    // The same first question `send_round` asks, for the same reason: a key
    // that already bought something means the reply was lost rather than the
    // request. Answer with the check as it stands and write nothing.
    if let Some(existing) = payment_check_id(&db_handle, &input.client_key).await? {
        if existing != check_id {
            return Err(http::conflict("That payment belongs to another check."));
        }
        let Some(detail) = db::check_detail(&db_handle, check_id).await? else {
            return Err(http::internal());
        };
        return Ok(Response::from_json(&detail)?);
    }

    let Some(before) = db::check_detail(&db_handle, check_id).await? else {
        return Err(http::not_found("No such check"));
    };
    if before.status != "open" {
        return Err(http::conflict("That check has already been settled."));
    }

    /*
     * The picks, checked against the check for the *message*.
     *
     * The SQL below is the safety — it refuses to write unless every line still
     * has the units this payment claims — but a guard that fails tells the till
     * only that something moved. A cashier holding cash needs to know which
     * dish and how much of it is left, so the same facts are read here, off the
     * same snapshot the amount was computed from, and turned into a sentence.
     */
    let mut picks = Vec::with_capacity(input.lines.len());
    for line in &input.lines {
        let Some(item) = before.item(&line.item_id) else {
            return Err(http::bad_request("That line is not on this check."));
        };
        if item.voided_at.is_some() {
            return Err(http::conflict_with(
                format!("{} was struck off. Check the bill and try again.", item.name_snapshot),
                http::code::CONFLICT,
            ));
        }
        let unpaid = item.qty - item.qty_paid;
        if line.qty > unpaid {
            return Err(http::conflict_with(
                format!(
                    "Only {unpaid} of {} is still unpaid. Check the bill and try again.",
                    item.name_snapshot
                ),
                http::code::CONFLICT,
            ));
        }
        picks.push(totals::PaidPick {
            price_minor_snapshot: item.price_minor_snapshot,
            qty: line.qty,
        });
    }

    // Priced from the Worker's own snapshots, never from the body. What the
    // client sends is what it *showed*, and the two disagreeing is a refusal
    // rather than a charge.
    let amount = totals::picked_total_minor(&picks);
    if amount != input.expected_amount_minor {
        return Err(http::conflict_with(
            format!("That comes to {amount} now. Check the bill and try again."),
            http::code::CONFLICT,
        ));
    }

    let at = http::now_iso();
    let payment_id = http::new_id("pay");
    // The same picks, numbered for each statement that joins them: the money
    // binds seven values before them, the allocation binds one.
    let money_picks = picks_sql(input.lines.len(), 8);
    let allocation_picks = picks_sql(input.lines.len(), 2);

    // [0] The money, guarded on every named line still having the units this
    //     payment claims. All or nothing: one row or no row, so there is never
    //     a half-allocated payment to unpick afterwards.
    let mut money_args: Vec<JsValue> = vec![
        db::text(&payment_id),
        db::text(&input.method),
        db::number(amount as f64),
        db::text(&staff_id),
        db::text(&at),
        db::text(&input.client_key),
        db::text(check_id),
    ];
    for line in &input.lines {
        money_args.push(db::text(&line.item_id));
        money_args.push(db::number(line.qty as f64));
    }
    money_args.push(db::number(input.lines.len() as f64));

    let mut allocation_args: Vec<JsValue> = vec![db::text(&payment_id)];
    for line in &input.lines {
        allocation_args.push(db::text(&line.item_id));
        allocation_args.push(db::number(line.qty as f64));
    }

    let results = db_handle
        .batch(vec![
            db_handle
                .prepare(format!(
                    "INSERT INTO payments (id, check_id, method, amount_minor, taken_by, at, client_key)
        SELECT ?1, c.id, ?2, ?3, ?4, ?5, ?6
        FROM checks c
        WHERE c.id = ?7
          AND c.status = 'open'
          AND (SELECT COUNT(*) FROM items i
                 JOIN rounds r ON r.id = i.round_id
                 JOIN ({money_picks}) w ON w.item_id = i.id
                WHERE r.check_id = c.id
                  AND i.voided_at IS NULL
                  AND i.qty - COALESCE((SELECT SUM(a.qty_paid) FROM payment_items a
                                         WHERE a.item_id = i.id), 0) >= w.pay_qty) = ?{}",
                    money_args.len()
                ))
                .bind(&money_args)?,
            // [1] What it bought, hanging off the money having been written.
            db_handle
                .prepare(format!(
                    "INSERT INTO payment_items (payment_id, item_id, qty_paid)
        SELECT ?1, w.item_id, w.pay_qty
        FROM ({allocation_picks}) w
        WHERE EXISTS (SELECT 1 FROM payments p WHERE p.id = ?1)"
                ))
                .bind(&allocation_args)?,
            // [2] The close, if that was the last unpaid unit on the check. A
            //     batch cannot branch, so "close it if this finished it" is a
            //     WHERE clause and `changes` is how the handler finds out which
            //     way it went.
            db_handle
                .prepare(
                    "UPDATE checks
        SET status = 'paid',
            closed_at = ?2
        WHERE id = ?1
          AND status = 'open'
          AND EXISTS (SELECT 1 FROM payments p WHERE p.id = ?3)
          AND NOT EXISTS (SELECT 1 FROM items i
                            JOIN rounds r ON r.id = i.round_id
                           WHERE r.check_id = ?1
                             AND i.voided_at IS NULL
                             AND i.qty > COALESCE((SELECT SUM(a.qty_paid) FROM payment_items a
                                                    WHERE a.item_id = i.id), 0))",
                )
                .bind(&[db::text(check_id), db::text(&at), db::text(&payment_id)])?,
        ])
        .await?;

    let took_it = changed(results.first());
    if !took_it {
        return Err(http::conflict("The bill changed while you were paying. Try again."));
    }
    let closed = changed(results.get(2));

    let Some(detail) = db::check_detail(&db_handle, check_id).await? else {
        return Err(http::internal());
    };

    // One event or the other, never both. `check.paid` means the card comes off
    // the board and the table is free; announcing that for a table where three
    // people are still eating would clear the till's screen mid-service.
    let pub_sub = create_pub_sub(env);
    if closed {
        pub_sub
            .emit(
                &[RESTAURANT_CHANNEL],
                "check.paid",
                &json!({
                    "checkId": detail.id,
                    "tableId": detail.table_id,
                    "method": input.method,
                    "at": at,
                }),
            )
            .await;
    } else {
        pub_sub
            .emit(
                &[RESTAURANT_CHANNEL],
                "check.part_paid",
                &json!({
                    "checkId": detail.id,
                    "tableId": detail.table_id,
                    "method": input.method,
                    "amountMinor": amount,
                    "totalMinor": detail.total_minor,
                    "outstandingMinor": detail.outstanding_minor,
                    "at": at,
                }),
            )
            .await;
    }

    Ok(Response::from_json(&detail)?)
}

/// Did this statement write anything? The batch's only way of answering a
/// question, and the reason every guard here is a `WHERE` rather than an `if`.
fn changed(result: Option<&worker::D1Result>) -> bool {
    result
        .and_then(|result| result.meta().ok().flatten())
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0)
}

/// Has this key already bought something? [`round_check_id`]'s twin for money.
async fn payment_check_id(db: &D1Database, client_key: &str) -> ApiResult<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        check_id: String,
    }
    let row: Option<Row> = db
        .prepare("SELECT check_id FROM payments WHERE client_key = ?1")
        .bind(&[db::text(client_key)])?
        .first(None)
        .await?;
    Ok(row.map(|row| row.check_id))
}

/// The picks, as an inline table a statement can join against.
///
/// Built from the **count** of picks and never from the ids themselves — the
/// ids ride in as bound parameters — which is the same rule the catalogue's
/// `products_by_id` follows and the reason no string from a client is ever
/// spliced into SQL here.
///
/// `SELECT … UNION ALL SELECT …` rather than a bare `VALUES`, because SQLite
/// names a bare `VALUES` subquery's columns `column1` and `column2`, and a
/// statement whose meaning depends on knowing that is not one to read against a
/// `wrangler d1` console at midnight.
fn picks_sql(count: usize, first: usize) -> String {
    let mut sql = format!("SELECT ?{first} AS item_id, ?{} AS pay_qty", first + 1);
    for index in 1..count {
        let item = first + index * 2;
        let qty = item + 1;
        sql.push_str(&format!(" UNION ALL SELECT ?{item}, ?{qty}"));
    }
    sql
}

/* -------------------------------------------- the per-item payment's body */

/// One line of a split payment: which item, and how many of it.
struct PayPick {
    item_id: String,
    qty: i64,
}

struct PayItemsInput {
    method: String,
    lines: Vec<PayPick>,
    expected_amount_minor: i64,
    client_key: String,
}

/// `payItemsSchema`, read the way every other body in this file is read.
fn parse_pay_items(raw: &serde_json::Value) -> ApiResult<PayItemsInput> {
    let fields = body::object(raw)?;
    let method = fields.enum_of("method", &["cash", "card", "other"])?;
    let expected_amount_minor = fields.int("expectedAmountMinor", &Int::MINOR)?;
    let client_key =
        fields.string("clientKey", &Str { trim: false, min: 8, max: 64, min_message: None })?;

    let Some(lines) = raw.get("lines").and_then(|value| value.as_array()) else {
        return Err(http::bad_request(format!(
            "lines: Invalid input: expected array, received {}",
            raw.get("lines").map_or("undefined", body::zod_type)
        )));
    };
    if lines.is_empty() {
        return Err(http::bad_request("lines: Pick something to pay for first"));
    }
    if lines.len() > 60 {
        return Err(http::bad_request("lines: Too big: expected array to have <=60 items"));
    }

    let mut picks: Vec<PayPick> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let line = body::object(line)
            .map_err(|error| http::bad_request(format!("lines[{index}]: {}", error.message)))?;
        let item_id = line
            .string("itemId", &Str::ID)
            .map_err(|error| http::bad_request(format!("lines[{index}].{}", error.message)))?;
        let qty = line
            .int("qty", &Int::QTY)
            .map_err(|error| http::bad_request(format!("lines[{index}].{}", error.message)))?;

        // A body naming the same line twice would otherwise reach
        // `PRIMARY KEY (payment_id, item_id)` and come back as a constraint
        // violation — a 500 for what is a client mistake and deserves a
        // sentence. It would also mean the guard counted one matching row for
        // two claims and let the second through unchecked.
        if picks.iter().any(|pick| pick.item_id == item_id) {
            return Err(http::bad_request(format!("lines[{index}].itemId: Named twice")));
        }
        picks.push(PayPick { item_id, qty });
    }

    Ok(PayItemsInput { method, lines: picks, expected_amount_minor, client_key })
}

/// How many live lines this check has. One third of the payment's fingerprint;
/// the guard compares it against the database's own count a moment later.
fn live_line_count(detail: &db::CheckDetail) -> usize {
    detail
        .rounds
        .iter()
        .flat_map(|round| round.items.iter())
        .filter(|item| item.voided_at.is_none())
        .count()
}

/// How many units of this check somebody has already settled.
///
/// The component of the fingerprint that exists because of per-item payment,
/// and the only one that can move without any row being added or struck off.
/// Voided lines are counted too, deliberately: the SQL it is compared against
/// sums every allocation on the check, and a line struck off after being paid
/// for would otherwise make the two disagree for ever and wedge the check.
fn paid_units(detail: &db::CheckDetail) -> i64 {
    detail.rounds.iter().flat_map(|round| round.items.iter()).map(|item| item.qty_paid).sum()
}

/// `SELECT check_id FROM rounds WHERE client_key = ?1`.
///
/// Called twice in the send: once before writing, to recognise a replay, and
/// once after, to confirm the write landed. The partial unique index on the
/// column is what makes one row the only possible answer.
async fn round_check_id(db: &D1Database, client_key: &str) -> ApiResult<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        check_id: String,
    }
    let row: Option<Row> = db
        .prepare("SELECT check_id FROM rounds WHERE client_key = ?1")
        .bind(&[db::text(client_key)])?
        .first(None)
        .await?;
    Ok(row.map(|row| row.check_id))
}

/* ------------------------------------------------------- the send's body */

/// Where a round is going. One of three, decided at the boundary rather than
/// left as two nullable fields for each statement to interpret.
enum Target {
    /// Adding to a takeaway order that is already open.
    Check(String),
    /// The usual case: find this table's open check, or open one.
    Table(String),
    /// A new takeaway or counter sale, with no table under it.
    NewTakeaway,
}

struct SendInput {
    target: Target,
    client_key: String,
    items: Vec<SendLine>,
}

struct SendLine {
    product_id: String,
    qty: i64,
    note: Option<String>,
}

/// A line with the menu's own price on it, ready to be inserted.
struct PricedLine {
    id: String,
    product_id: String,
    name: String,
    price_minor: i64,
    prep_minutes: i64,
    qty: i64,
    note: Option<String>,
}

/// `sendRoundSchema`, in its key order.
fn parse_send(raw: &serde_json::Value) -> ApiResult<SendInput> {
    let fields = body::object(raw)?;
    // `.nullable()`, not `.optional()`: the schema declares both keys as
    // present-and-possibly-null, because "no table" is a *value* a takeaway
    // order has rather than a field it leaves out. `nullable_string` is the
    // reader that matches, and using `opt_string` here would refuse exactly the
    // body `sendRoundSchema` tells a client to send.
    let table_id = fields.nullable_string("tableId", &Str::ID)?;
    let check_id = fields.nullable_string("checkId", &Str::ID)?;
    let client_key = fields.string("clientKey", &Str { trim: false, min: 8, max: 64, min_message: None })?;

    // The one rule zod cannot express as a field check and the schema states in
    // prose: exactly one of the two, or neither. Both would leave the statement
    // choosing, and a round that quietly went to a different check from the one
    // the waiter was looking at is the worst kind of wrong.
    let target = match (table_id, check_id) {
        (Some(_), Some(_)) => {
            return Err(http::bad_request("Give a table or a check, not both"));
        }
        (Some(table_id), None) => Target::Table(table_id),
        (None, Some(check_id)) => Target::Check(check_id),
        (None, None) => Target::NewTakeaway,
    };

    let Some(items) = raw.get("items").and_then(|value| value.as_array()) else {
        return Err(http::bad_request(format!(
            "items: Invalid input: expected array, received {}",
            raw.get("items").map_or("undefined", body::zod_type)
        )));
    };
    if items.is_empty() {
        return Err(http::bad_request("items: Add something to the order first"));
    }
    if items.len() > 60 {
        return Err(http::bad_request("items: Too big: expected array to have <=60 items"));
    }

    let mut lines = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        // zod paths an array element as `items[0].qty`, so the prefix is built
        // rather than left to `Body`, which only knows about object keys.
        let line = body::object(item).map_err(|error| {
            http::bad_request(format!("items[{index}]: {}", error.message))
        })?;
        let product_id = line
            .string("productId", &Str::ID)
            .map_err(|error| http::bad_request(format!("items[{index}].{}", error.message)))?;
        let qty = line
            .int("qty", &Int::QTY)
            .map_err(|error| http::bad_request(format!("items[{index}].{}", error.message)))?;
        // `.nullable()` again, and for the same reason: a line without a note
        // sends `note: null` rather than leaving the key out.
        let note = line
            .nullable_string("note", &Str::text(120))
            .map_err(|error| http::bad_request(format!("items[{index}].{}", error.message)))?;

        lines.push(SendLine {
            product_id,
            qty,
            // A note somebody opened and left empty is no note. The ticket
            // renderer does this too — a blank line under a dish reads like
            // something went missing — and doing it here as well means the
            // database never holds the empty string to begin with.
            note: note.filter(|value| !value.is_empty()),
        });
    }

    Ok(SendInput { target, client_key, items: lines })
}
