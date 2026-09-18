//! The queue between the Worker and the printer in the kitchen: `/print-jobs`.
//!
//! Cloudflare cannot open a socket to a printer on TCP 9100 behind somebody's
//! router, and the printer cannot call Cloudflare, so the direction is
//! reversed: a small node process on the restaurant's LAN polls this every
//! three seconds and acks what it managed to print.
//!
//! ## The agent holds no rules, and this file is why
//!
//! `GET /print-jobs` hands back the **rendered ticket** alongside each job —
//! round number, table, time, waiter, lines — so the agent never has to know
//! what a round is, what a void means or which lines belong on which slip. A
//! doc goes in and ESC/POS bytes come out. The rendering is
//! `pos_core::ticket::render_ticket`, whose TypeScript twin renders the same
//! doc from the same inputs, so what the kitchen is handed and what a screen
//! would show are the same thing by construction.
//!
//! It costs nothing to do it here. Ninety-nine polls in a hundred answer with
//! an empty list — `idx_print_jobs_status` makes those a probe of an empty
//! index range — and the join that assembles a ticket is walked only on the
//! hundredth.
//!
//! ## An unacked job is the safe state
//!
//! Nothing leases a job, nothing times one out, and nothing hands one out
//! exclusively. A job is `pending` until the agent says otherwise, so an agent
//! killed mid-print — or a shop that lost power with a ticket half fed through
//! the printer — comes back, polls, and prints it again. A duplicate ticket is
//! a piece of paper somebody throws away; a missing ticket is food nobody
//! cooks, and the waiter finds out when the table asks where their curry is.
//!
//! ## The banner reads the same list
//!
//! `?status=failed` is the cashier's red banner: which table's food the kitchen
//! never heard about, and what the printer said about it. One shape for both
//! readers, because they want the same facts and a second nearly identical one
//! would be somewhere for the two to disagree about what a stuck ticket is.

use serde::Serialize;
use serde_json::json;
use worker::{Env, Method, Request, Response};

use pos_core::ticket::{self, TicketDoc, TicketInput, TicketLine};

use crate::db;
use crate::http::{self, ApiResult};
use crate::middleware::{self, Identity};
use crate::realtime::create_pub_sub;
use crate::routes::realtime::RESTAURANT_CHANNEL;
use crate::validate::{self as body, Str};

/// How many times a job is offered before it is given up on.
///
/// Three. A printer that is switched off, out of paper or unplugged is not a
/// problem this system can solve by trying harder, and the person who can solve
/// it is standing next to it — so after three the job stops being handed out
/// and becomes a red banner on the cashier's screen instead. The agent backs
/// off exponentially in between, so a dead printer is asked politely rather
/// than sixty times a minute.
const MAX_ATTEMPTS: i64 = 3;

/// Who may re-queue a failed ticket. The till, because the banner is on the
/// cashier's screen and they are the one who walked to the kitchen to find out
/// why — and the manager, who is the same person on a Tuesday.
const TILLS: &[&str] = &["cashier", "admin"];

pub async fn route(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
) -> Option<ApiResult<Response>> {
    let path = req.path();
    let mut segments = path.split('/').skip(1);
    if segments.next() != Some("print-jobs") {
        return None;
    }
    let rest: Vec<&str> = segments.collect();
    if rest.iter().any(|segment| segment.is_empty()) {
        return None;
    }

    Some(match (req.method(), rest.as_slice()) {
        (Method::Get, []) => list(req, env, identity).await,
        (Method::Post, [id, "printed"]) => printed(env, identity, id).await,
        (Method::Post, [id, "failed"]) => failed(req, env, identity, id).await,
        (Method::Post, [id, "retry"]) => retry(env, identity, id).await,
        _ => return None,
    })
}

/// The jobs in one status, with their tickets already rendered.
///
/// `require_device` only — which is what the dispatcher has already done, so
/// there is no gate here at all — and deliberately not `require_staff`. The
/// printer agent is a process, not a person: it holds a device token minted
/// from a claim link like any tablet and there is nobody to tap a PIN on it. A
/// staff gate would mean the kitchen stopped printing at the end of every
/// shift.
async fn list(req: &Request, env: &Env, identity: &Identity) -> ApiResult<Response> {
    let _ = identity;
    let status = query(req, "status")?.unwrap_or_else(|| "pending".to_string());
    if !matches!(status.as_str(), "pending" | "printed" | "failed") {
        return Err(http::bad_request(
            "status: Invalid option: expected one of \"pending\"|\"printed\"|\"failed\"",
        ));
    }

    let db_handle = crate::env::db(env)?;
    let offset = crate::env::tz_offset_minutes(env);
    let (jobs, lines) = db::print_jobs_with_lines(&db_handle, &status).await?;

    let views: Vec<PrintJobView> =
        jobs.iter().map(|job| to_view(job, &lines, offset)).collect();
    Ok(Response::from_json(&views)?)
}

/// The agent saying a slip came out of the printer.
///
/// Idempotent on purpose: the guard is `status = 'pending'`, so a second ack —
/// the agent restarted between printing and acking, and printed it again — is a
/// 200 over a job that is already printed rather than a 409 the agent would
/// have no idea what to do with. What it must never do is *undo* a failure, so
/// a job that has been given up on stays given up on until somebody presses
/// Retry.
async fn printed(env: &Env, identity: &Identity, job_id: &str) -> ApiResult<Response> {
    let _ = identity;
    let at = http::now_iso();
    let db_handle = crate::env::db(env)?;

    let result = db_handle
        .prepare(
            "UPDATE print_jobs
        SET status = 'printed',
            printed_at = ?2
        WHERE id = ?1 AND status = 'pending'",
        )
        .bind(&[db::text(job_id), db::text(&at)])?
        .run()
        .await?;

    let view = read_view(env, job_id).await?;

    // Only when this request is the one that changed it. An agent acking twice
    // should not publish twice — every event is three Redis commands, and the
    // budget in `CLAUDE.md` is the whole reason this app is shaped as it is.
    if changed(&result) {
        create_pub_sub(env)
            .emit(
                &[RESTAURANT_CHANNEL],
                "print_job.printed",
                &json!({ "jobId": view.id, "roundId": view.round_id, "at": at }),
            )
            .await;
    }

    Ok(Response::from_json(&view)?)
}

/// The agent saying it could not print.
///
/// The attempt is counted and the error recorded whatever happens; whether the
/// job is *given up on* is decided in the same statement, by comparing the
/// incremented count against [`MAX_ATTEMPTS`]. Doing it in SQL rather than
/// reading the count and deciding here is the usual reason — two agents, or one
/// agent retrying while a slow first attempt is still in flight, would both
/// read two and both write three.
///
/// **The event fires only on the transition.** A printer that is out of paper
/// fails three times in ninety seconds, and publishing each of those would be
/// nine Redis commands and a banner that appears on the first hiccup rather
/// than on the one that needs somebody to walk to the kitchen.
async fn failed(
    req: &mut Request,
    env: &Env,
    identity: &Identity,
    job_id: &str,
) -> ApiResult<Response> {
    let _ = identity;
    let raw = body::read_json(req).await?;
    let fields = body::object(&raw)?;
    let error = fields.opt_string("error", &Str::text(300))?;

    let db_handle = crate::env::db(env)?;
    let result = db_handle
        .prepare(
            "UPDATE print_jobs
        SET attempts = attempts + 1,
            last_error = ?2,
            status = CASE WHEN attempts + 1 >= ?3 THEN 'failed' ELSE 'pending' END
        WHERE id = ?1 AND status = 'pending'",
        )
        .bind(&[
            db::text(job_id),
            db::opt_text(error.as_deref()),
            db::number(MAX_ATTEMPTS as f64),
        ])?
        .run()
        .await?;

    let view = read_view(env, job_id).await?;

    if changed(&result) && view.status == "failed" {
        create_pub_sub(env)
            .emit(
                &[RESTAURANT_CHANNEL],
                "print_job.failed",
                &json!({
                    "jobId": view.id,
                    "roundId": view.round_id,
                    "tableId": view.table_id,
                    "error": view.last_error,
                    "at": http::now_iso(),
                }),
            )
            .await;
    }

    Ok(Response::from_json(&view)?)
}

/// Put a given-up job back in the queue.
///
/// The Retry on the cashier's banner, pressed once somebody has put paper in
/// the printer. `attempts` goes back to zero rather than carrying on from
/// three, because the three that failed were about a printer that is now fixed
/// — leaving the count would mean the very next hiccup gave up immediately.
///
/// `last_error` is kept. It is the only record of what went wrong, it is not in
/// the way, and a banner that clears its own explanation makes "what happened
/// earlier" unanswerable ten minutes later.
async fn retry(env: &Env, identity: &Identity, job_id: &str) -> ApiResult<Response> {
    middleware::require_role(identity, TILLS)?;

    let db_handle = crate::env::db(env)?;
    let result = db_handle
        .prepare(
            "UPDATE print_jobs
        SET status = 'pending',
            attempts = 0
        WHERE id = ?1 AND status = 'failed'",
        )
        .bind(&[db::text(job_id)])?
        .run()
        .await?;

    if !changed(&result) {
        // Either there is no such job, or it is pending already because
        // somebody else pressed Retry a second ago. The second is much the
        // likelier and is not an error worth a red screen, so the view is
        // returned and the banner simply stops showing it.
        return match read_view(env, job_id).await {
            Ok(view) => Ok(Response::from_json(&view)?),
            Err(error) => Err(error),
        };
    }

    Ok(Response::from_json(&read_view(env, job_id).await?)?)
}

/* ------------------------------------------------------------------ views */

/// `printJobViewSchema` — the job, the table it belongs to, and the ticket.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintJobView {
    id: String,
    round_id: String,
    kind: String,
    status: String,
    attempts: i64,
    last_error: Option<String>,
    created_at: String,
    printed_at: Option<String>,
    table_id: Option<String>,
    table_name: Option<String>,
    ticket: TicketDoc,
}

/// Assemble one job's view, including the ticket it will print.
///
/// The two kinds differ in three ways and all three are here rather than spread
/// through the queries:
///
///   * a **ticket** carries every line of its round, *including any that have
///     since been voided*. The void notice that follows refers to a slip the
///     kitchen is holding, and a ticket that quietly omitted the line would be
///     a strike-off for something they were never told to cook.
///   * a **void** carries the one line it names.
///   * who the slip is attributed to, and when, moves with it: a ticket is the
///     waiter who sent the round at the moment they sent it, a void is whoever
///     struck the line off at the moment they did.
fn to_view(job: &db::PrintJobRow, lines: &[db::JobItemRow], tz_offset_minutes: i64) -> PrintJobView {
    let is_void = job.kind == "void";

    let ticket_lines: Vec<TicketLine> = lines
        .iter()
        .filter(|line| {
            line.round_id == job.round_id
                && match &job.item_id {
                    Some(item_id) => !is_void || &line.id == item_id,
                    None => true,
                }
        })
        .map(|line| TicketLine {
            qty: line.qty,
            name: line.name_snapshot.clone(),
            note: line.note.clone(),
        })
        .collect();

    // A void's stamp and name, with the round's as the fallback. The fallback
    // is not expected — a void job is created in the same batch that sets
    // `voided_at`, so the join always finds it — and it is there because a
    // ticket with no time on it is worse than one with the round's time.
    let (at_iso, staff_name) = if is_void {
        (
            job.voided_at.clone().unwrap_or_else(|| job.sent_at.clone()),
            job.voided_by_name.clone().unwrap_or_else(|| job.sent_by_name.clone()),
        )
    } else {
        (job.sent_at.clone(), job.sent_by_name.clone())
    };

    let input = TicketInput {
        kind: job.kind.clone(),
        seq: job.seq,
        table_name: job.table_name.clone(),
        staff_name,
        // The one place this Worker parses an ISO string. `pos_core` may not
        // depend on the host and so takes the instant as a number; `Date.parse`
        // is the host's, and a stamp SQLite somehow held that is not a date
        // becomes the epoch rather than a panic — a ticket headed `07:00` is
        // wrong and printable, and a Worker that died would take every other
        // request on the isolate with it.
        at_ms: parse_iso_ms(&at_iso),
        lines: ticket_lines,
    };

    PrintJobView {
        id: job.id.clone(),
        round_id: job.round_id.clone(),
        kind: job.kind.clone(),
        status: job.status.clone(),
        attempts: job.attempts,
        last_error: job.last_error.clone(),
        created_at: job.created_at.clone(),
        printed_at: job.printed_at.clone(),
        table_id: job.table_id.clone(),
        table_name: job.table_name.clone(),
        ticket: ticket::render_ticket(&input, tz_offset_minutes),
    }
}

async fn read_view(env: &Env, job_id: &str) -> ApiResult<PrintJobView> {
    let db_handle = crate::env::db(env)?;
    let offset = crate::env::tz_offset_minutes(env);
    match db::print_job_with_lines(&db_handle, job_id).await? {
        Some((job, lines)) => Ok(to_view(&job, &lines, offset)),
        None => Err(http::not_found("No such print job")),
    }
}

/// `Date.parse(iso)`, with `NaN` read as the epoch rather than propagated.
fn parse_iso_ms(iso: &str) -> i64 {
    let parsed = crate::js::parse_date(iso);
    if parsed.is_nan() {
        0
    } else {
        parsed as i64
    }
}

/// `result.meta.changes > 0` — did this statement actually change a row?
///
/// Every ack in this file is guarded in its `WHERE`, so this is how each one
/// tells "I did it" from "somebody already had". It is what stops a second ack
/// publishing a second event.
fn changed(result: &worker::D1Result) -> bool {
    result
        .meta()
        .ok()
        .flatten()
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0)
}

/// `c.req.query(name)` — the first occurrence, form-decoded.
fn query(req: &Request, name: &str) -> ApiResult<Option<String>> {
    let url = req.url().map_err(http::ApiError::from)?;
    Ok(url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()))
}
