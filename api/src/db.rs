//! D1 access: row shapes, mappers, and the composite reads that more than one
//! route needs. Single-table CRUD stays inline in the routes.
//!
//! Every row type mirrors its table exactly (snake_case, 0/1 booleans, ISO
//! strings) and is converted at the boundary, so nothing downstream has to know
//! how SQLite spells things.
//!
//! Ported from `src/db.ts`. The statement text is copied character for
//! character — same line breaks, same indentation, same `?N` numbering, same
//! bind order. The queries are the contract with the database, and a
//! reformatted one is a different thing to read against a `wrangler d1` console
//! at midnight.
//!
//! The mapped structs are what the routes serialize, so **field order is
//! output order**: each one is declared in the order of the object literal the
//! original built, not the order of the columns it came from.

use std::cmp::Ordering;
use std::future::Future;

use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use worker::d1::D1Database;
use worker::Result as WorkerResult;

use futsal_core::clock::registration_open;

use crate::js;

/* ------------------------------------------------------------------- rows */

#[derive(Debug, Clone, Deserialize)]
pub struct MemberRow {
    pub id: String,
    pub name: String,
    pub is_organizer: i64,
    pub active: i64,
    /// Reserved hook for an external identity provider. Unused today.
    pub external_id: Option<String>,
    pub created_at: String,
    pub notify_session: i64,
    pub notify_payment: i64,
    pub language: String,
    pub claimed_at: Option<String>,
    pub claim_nonce: Option<String>,
    pub claim_expires_at: Option<String>,
    pub token_version: i64,
    pub avatar_key: Option<String>,
    pub avatar_updated_at: Option<String>,
    pub approved_at: Option<String>,
    pub hour12: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VenueRow {
    pub id: String,
    pub name: String,
    pub address: Option<String>,
    pub map_url: Option<String>,
    pub price_note: Option<String>,
    pub active: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub starts_at: String,
    pub venue_id: Option<String>,
    pub status: String,
    pub fee_per_person: Option<i64>,
    pub total_charge: Option<i64>,
    pub max_players: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A session left-joined onto its venue; venue columns are `v_`-prefixed.
///
/// TypeScript spelled this `extends SessionRow`. Rust has no struct
/// inheritance, so the session half is written out again — the two are read
/// from the same `SELECT` and must not drift.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionWithVenueRow {
    pub id: String,
    pub starts_at: String,
    pub venue_id: Option<String>,
    pub status: String,
    pub fee_per_person: Option<i64>,
    pub total_charge: Option<i64>,
    pub max_players: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub v_id: Option<String>,
    pub v_name: Option<String>,
    pub v_address: Option<String>,
    pub v_map_url: Option<String>,
    pub v_price_note: Option<String>,
    pub v_active: Option<i64>,
    pub v_created_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegistrationRow {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub guests: i64,
    pub slot: Option<i64>,
    pub attended: Option<i64>,
    pub guests_arrived: Option<i64>,
    pub goals: i64,
    pub status: String,
    pub position: i64,
    pub created_at: String,
}

/// A team slot joined to its draw. The draw's own columns repeat on every row,
/// which is what lets one query answer "are there teams, and who is on them" —
/// see [`load_team_draw`].
#[derive(Debug, Clone, Deserialize)]
pub struct TeamSlotRow {
    pub team_count: i64,
    pub drawn_at: String,
    pub drawn_by: Option<String>,
    pub drawn_by_name: Option<String>,
    pub confirmed_at: Option<String>,
    pub confirmed_by: Option<String>,
    pub confirmed_by_name: Option<String>,
    pub team: Option<i64>,
    pub guest_index: Option<i64>,
    pub member_id: Option<String>,
    pub member_name: Option<String>,
    pub member_avatar_updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TeamMatchRow {
    pub id: String,
    pub ordinal: i64,
    pub first_team: i64,
    pub second_team: i64,
    pub first_goals: Option<i64>,
    pub second_goals: Option<i64>,
    pub recorded_at: Option<String>,
    pub recorded_by: Option<String>,
    pub recorded_by_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaymentRow {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    pub amount_due: i64,
    pub amount_override: Option<i64>,
    pub guests: i64,
    pub status: String,
    pub proof_key: Option<String>,
    pub note: Option<String>,
    pub reject_reason: Option<String>,
    pub claimed_at: Option<String>,
    pub confirmed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionMessageRow {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub body: String,
    pub created_at: String,
}

/* --------------------------------------------------------- mapped values */

/// `status` on the mapped values stays a plain string, as the original's
/// `row.status as Session['status']` did: the cast checked nothing, so a value
/// SQLite somehow held would travel out unaltered rather than being rejected
/// here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    pub is_organizer: bool,
    pub active: bool,
    pub created_at: String,
    pub notify_session: bool,
    pub notify_payment: bool,
    pub language: String,
    pub hour12: bool,
    pub claimed_at: Option<String>,
    pub has_pending_link: bool,
    pub avatar_updated_at: Option<String>,
    pub approved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Venue {
    pub id: String,
    pub name: String,
    pub address: Option<String>,
    pub map_url: Option<String>,
    pub price_note: Option<String>,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub starts_at: String,
    pub venue_id: Option<String>,
    pub venue: Option<Venue>,
    pub status: String,
    pub fee_per_person: Option<i64>,
    pub total_charge: Option<i64>,
    pub max_players: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub guests: i64,
    /// Which spot on the pitch they pressed, if they pressed one. `None` is the
    /// ordinary case — no preference — and the screen fills those into the gaps.
    pub slot: Option<i64>,
    /// SQLite has no boolean, and the three states are load-bearing: `None` is
    /// "unmarked", which is not the same as "marked absent".
    pub attended: Option<bool>,
    pub guests_arrived: Option<i64>,
    pub goals: i64,
    pub status: String,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payment {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    pub amount_due: i64,
    pub amount_override: Option<i64>,
    pub guests: i64,
    pub status: String,
    /// True when a screenshot exists; the object key itself stays server-side.
    pub has_proof: bool,
    pub note: Option<String>,
    pub reject_reason: Option<String>,
    pub claimed_at: Option<String>,
    pub confirmed_at: Option<String>,
    pub updated_at: String,
}

/// Whoever did something to a draw or a fixture, as the screen names them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub member_id: String,
    pub member_name: String,
}

/// One body on the pitch: `guest_index` 0 is the member, 1..5 their guests.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSlot {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub guest_index: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMatch {
    pub id: String,
    pub ordinal: i64,
    pub first_team: i64,
    pub second_team: i64,
    pub first_goals: Option<i64>,
    pub second_goals: Option<i64>,
    pub recorded_by: Option<Actor>,
    pub recorded_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamDraw {
    pub team_count: i64,
    pub teams: Vec<Vec<TeamSlot>>,
    pub drawn_by: Option<Actor>,
    pub drawn_at: String,
    pub confirmed_at: Option<String>,
    pub confirmed_by: Option<Actor>,
    pub matches: Vec<TeamMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    pub session_id: String,
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub body: String,
    pub created_at: String,
}

/// A tally entry without its count — who may be voted for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvpCandidate {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
}

/// The spread `{ ...entry, votes }`, so `votes` comes last.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvpTallyEntry {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub votes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mvp {
    pub candidates: Vec<MvpCandidate>,
    pub my_vote: Option<String>,
    pub tally: Vec<MvpTallyEntry>,
    pub leaders: Vec<String>,
    pub votes_cast: i64,
    pub voter_count: i64,
}

/// Heads, not rows — see [`count_registrations`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct RegistrationCounts {
    pub r#in: i64,
    pub waitlist: i64,
    pub guests: i64,
}

/// Rows, not heads — see [`count_registrations_by_session`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct RegistrationTotals {
    pub r#in: i64,
    pub waitlist: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: Session,
    pub registrations: Vec<Registration>,
    pub counts: RegistrationCounts,
    pub registration_open: bool,
    pub me: Option<Registration>,
    pub teams: Option<TeamDraw>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentSummary {
    pub session_id: String,
    pub total_charge: Option<i64>,
    pub collected: i64,
    pub pending: i64,
    pub outstanding: i64,
    pub payments: Vec<Payment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberBalance {
    pub member: Member,
    pub sessions_played: i64,
    pub total_owed: i64,
    pub total_confirmed: i64,
    pub outstanding: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberBalancePage {
    pub balances: Vec<MemberBalance>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberProfile {
    pub member: Member,
    pub streak: Streak,
    pub goals: i64,
    pub mvps: i64,
    pub outstanding: i64,
}

/// Which side they were on that week and how its games went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTeams {
    pub team: i64,
    pub outcomes: Vec<MatchOutcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberHistoryEntry {
    pub session: Session,
    pub registration_status: Option<String>,
    pub teams: Option<HistoryTeams>,
    pub payment: Option<Payment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberHistoryPage {
    pub history: Vec<MemberHistoryEntry>,
    pub next_cursor: Option<String>,
}

/*
 * Round-trips through the cache, so it is `Deserialize` as well.
 *
 * The camel-case rename applies in both directions, which is what makes the
 * stored form and the wire form the same bytes — one shape to reason about
 * rather than two that have to agree.
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    pub member: Member,
    pub streak: Streak,
    pub goals: i64,
    pub mvps: i64,
}

/* ---------------------------------------------------------------- mappers */

pub fn to_member(row: &MemberRow) -> Member {
    Member {
        id: row.id.clone(),
        name: row.name.clone(),
        is_organizer: row.is_organizer == 1,
        active: row.active == 1,
        created_at: row.created_at.clone(),
        // The `?? 1` the original wrote keeps rows from before migration 0002
        // behaving as opted-in; the columns are NOT NULL, so it never fires.
        notify_session: row.notify_session == 1,
        notify_payment: row.notify_payment == 1,
        language: normalize_locale(&row.language).to_string(),
        hour12: row.hour12 == 1,
        claimed_at: row.claimed_at.clone(),
        // The nonce itself never leaves the server; the roster only needs to
        // know whether an invitation is outstanding.
        has_pending_link: row.claim_nonce.is_some(),
        // Likewise the R2 key: the client gets a timestamp to cache against and
        // reads the picture through an authorized route.
        avatar_updated_at: row.avatar_updated_at.clone(),
        approved_at: row.approved_at.clone(),
    }
}

pub fn to_venue(row: &VenueRow) -> Venue {
    Venue {
        id: row.id.clone(),
        name: row.name.clone(),
        address: row.address.clone(),
        map_url: row.map_url.clone(),
        price_note: row.price_note.clone(),
        active: row.active == 1,
        created_at: row.created_at.clone(),
    }
}

pub fn to_session(row: &SessionWithVenueRow) -> Session {
    // `row.v_id && row.v_name` — JavaScript truthiness, so an empty string reads
    // as no venue exactly as it did before.
    let venue = match (&row.v_id, &row.v_name) {
        (Some(id), Some(name)) if !id.is_empty() && !name.is_empty() => Some(Venue {
            id: id.clone(),
            name: name.clone(),
            address: row.v_address.clone(),
            map_url: row.v_map_url.clone(),
            price_note: row.v_price_note.clone(),
            active: row.v_active == Some(1),
            created_at: row.v_created_at.clone().unwrap_or_else(|| row.created_at.clone()),
        }),
        _ => None,
    };
    Session {
        id: row.id.clone(),
        starts_at: row.starts_at.clone(),
        venue_id: row.venue_id.clone(),
        venue,
        status: row.status.clone(),
        fee_per_person: row.fee_per_person,
        total_charge: row.total_charge,
        max_players: row.max_players,
        notes: row.notes.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

pub fn to_registration(row: &RegistrationRow) -> Registration {
    Registration {
        id: row.id.clone(),
        session_id: row.session_id.clone(),
        member_id: row.member_id.clone(),
        member_name: row.member_name.clone(),
        member_avatar_updated_at: row.member_avatar_updated_at.clone(),
        guests: row.guests,
        slot: row.slot,
        // Three states: unmarked is not "marked absent".
        attended: row.attended.map(|value| value == 1),
        guests_arrived: row.guests_arrived,
        goals: row.goals,
        status: row.status.clone(),
        position: row.position,
        created_at: row.created_at.clone(),
    }
}

pub fn to_payment(row: &PaymentRow) -> Payment {
    Payment {
        id: row.id.clone(),
        session_id: row.session_id.clone(),
        member_id: row.member_id.clone(),
        member_name: row.member_name.clone(),
        amount_due: row.amount_due,
        amount_override: row.amount_override,
        guests: row.guests,
        status: row.status.clone(),
        has_proof: row.proof_key.is_some(),
        note: row.note.clone(),
        reject_reason: row.reject_reason.clone(),
        claimed_at: row.claimed_at.clone(),
        confirmed_at: row.confirmed_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

/* ------------------------------------------------------------- SQL pieces */

/// Column list for a session joined to its venue. Keep in sync with the row
/// type. The leading and trailing newlines are the template literal's and are
/// part of the text the statements are built from.
pub const SESSION_COLUMNS: &str = "
  s.id, s.starts_at, s.venue_id, s.status, s.fee_per_person, s.total_charge,
  s.max_players, s.notes, s.created_at, s.updated_at,
  v.id AS v_id, v.name AS v_name, v.address AS v_address, v.map_url AS v_map_url,
  v.price_note AS v_price_note, v.active AS v_active, v.created_at AS v_created_at
";

pub const SESSION_FROM: &str = "FROM sessions s LEFT JOIN venues v ON v.id = s.venue_id";

/* ------------------------------------------------------------ basic reads */

pub async fn get_session_row(db: &D1Database, session_id: &str) -> WorkerResult<Option<Session>> {
    let row: Option<SessionWithVenueRow> = db
        .prepare(format!("SELECT {SESSION_COLUMNS} {SESSION_FROM} WHERE s.id = ?1"))
        .bind(&[text(session_id)])?
        .first(None)
        .await?;
    Ok(row.as_ref().map(to_session))
}

/// Inactive members read as absent, which is what makes removal instant.
pub async fn get_member_by_id(db: &D1Database, id: &str) -> WorkerResult<Option<Member>> {
    let row: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1 AND active = 1")
        .bind(&[text(id)])?
        .first(None)
        .await?;
    Ok(row.as_ref().map(to_member))
}

pub async fn list_registrations(
    db: &D1Database,
    session_id: &str,
) -> WorkerResult<Vec<Registration>> {
    let results = db
        .prepare(
            "SELECT r.id, r.session_id, r.member_id, m.name AS member_name,
              m.avatar_updated_at AS member_avatar_updated_at,
              r.guests, r.slot, r.attended, r.guests_arrived, r.goals,
              r.status, r.position, r.created_at
         FROM registrations r
         JOIN members m ON m.id = r.member_id
        WHERE r.session_id = ?1
        ORDER BY r.position ASC",
        )
        .bind(&[text(session_id)])?
        .all()
        .await?;
    let rows: Vec<RegistrationRow> = results.results()?;
    Ok(rows.iter().map(to_registration).collect())
}

/// The teams as they currently stand, or `None` if nobody has split them.
///
/// One query rather than two. The draw's metadata repeats on every slot row,
/// which is a few bytes duplicated a dozen times in exchange for one less round
/// trip on the screen people open while standing on a pitch. The LEFT JOIN also
/// makes "a draw exists but everybody in it has since left" representable,
/// rather than indistinguishable from no draw at all.
pub async fn load_team_draw(db: &D1Database, session_id: &str) -> WorkerResult<Option<TeamDraw>> {
    // Slots and fixtures are independent, so they go together rather than one
    // after the other. Both are a dozen rows at most.
    let slots_statement = db
        .prepare(
            "SELECT d.team_count, d.drawn_at, d.drawn_by, b.name AS drawn_by_name,
                d.confirmed_at, d.confirmed_by, c.name AS confirmed_by_name,
                s.team, s.guest_index, s.member_id, m.name AS member_name,
                m.avatar_updated_at AS member_avatar_updated_at
           FROM team_draws d
           LEFT JOIN members b ON b.id = d.drawn_by
           LEFT JOIN members c ON c.id = d.confirmed_by
           LEFT JOIN team_slots s ON s.session_id = d.session_id
           LEFT JOIN members m ON m.id = s.member_id
          WHERE d.session_id = ?1
          ORDER BY s.team ASC, m.name COLLATE NOCASE ASC, s.guest_index ASC",
        )
        .bind(&[text(session_id)])?;
    let fixtures_statement = db
        .prepare(
            "SELECT x.id, x.ordinal, x.first_team, x.second_team,
                x.first_goals, x.second_goals, x.recorded_at, x.recorded_by,
                r.name AS recorded_by_name
           FROM team_matches x
           LEFT JOIN members r ON r.id = x.recorded_by
          WHERE x.session_id = ?1
          ORDER BY x.ordinal ASC",
        )
        .bind(&[text(session_id)])?;

    let (slots, fixtures) = both(slots_statement.all(), fixtures_statement.all()).await;
    let results: Vec<TeamSlotRow> = slots?.results()?;
    let fixture_rows: Vec<TeamMatchRow> = fixtures?.results()?;

    let Some(first) = results.first() else { return Ok(None) };

    let mut teams: Vec<Vec<TeamSlot>> = vec![Vec::new(); first.team_count.max(0) as usize];
    for row in &results {
        // The slot half of the join is null when the draw has no slots left.
        let (Some(team), Some(member_id), Some(member_name)) =
            (row.team, row.member_id.as_ref(), row.member_name.as_ref())
        else {
            continue;
        };
        // A team index outside the stored count would have to come from a
        // shrunk `team_count`, which nothing writes — but dropping the row is
        // better than indexing off the end of the board.
        let Some(side) = usize::try_from(team).ok().and_then(|index| teams.get_mut(index)) else {
            continue;
        };
        side.push(TeamSlot {
            member_id: member_id.clone(),
            member_name: member_name.clone(),
            member_avatar_updated_at: row.member_avatar_updated_at.clone(),
            guest_index: row.guest_index.unwrap_or(0),
        });
    }

    Ok(Some(TeamDraw {
        team_count: first.team_count,
        teams,
        drawn_by: actor(&first.drawn_by, &first.drawn_by_name),
        drawn_at: first.drawn_at.clone(),
        confirmed_at: first.confirmed_at.clone(),
        confirmed_by: actor(&first.confirmed_by, &first.confirmed_by_name),
        matches: fixture_rows
            .iter()
            .map(|row| TeamMatch {
                id: row.id.clone(),
                ordinal: row.ordinal,
                first_team: row.first_team,
                second_team: row.second_team,
                // A half-recorded score cannot be written, but reading it back
                // as unplayed is safer than reporting a one-sided scoreline.
                first_goals: row.first_goals,
                second_goals: row.second_goals,
                recorded_by: actor(&row.recorded_by, &row.recorded_by_name),
                recorded_at: row.recorded_at.clone(),
            })
            .collect(),
    }))
}

/// `id && name ? { memberId, memberName } : null` — both halves truthy, so an
/// empty string counts as absent just as it did in JavaScript.
fn actor(id: &Option<String>, name: &Option<String>) -> Option<Actor> {
    match (id, name) {
        (Some(id), Some(name)) if !id.is_empty() && !name.is_empty() => {
            Some(Actor { member_id: id.clone(), member_name: name.clone() })
        }
        _ => None,
    }
}

/// The cap the thread is read with, as the original's default argument.
pub const SESSION_MESSAGE_LIMIT: i64 = 200;

/// A session's thread, oldest first, with the default cap.
pub async fn list_session_messages(
    db: &D1Database,
    session_id: &str,
) -> WorkerResult<Vec<SessionMessage>> {
    list_session_messages_capped(db, session_id, SESSION_MESSAGE_LIMIT).await
}

/// A session's thread, oldest first.
///
/// Capped rather than paged. A thread is one week of banter about one game, so
/// the realistic ceiling is a few dozen; a cursor here would be machinery for a
/// case that does not arrive, and a chat that starts halfway through is worse
/// than one that starts at the beginning. The cap exists only so a runaway
/// cannot put a megabyte on somebody's phone.
pub async fn list_session_messages_capped(
    db: &D1Database,
    session_id: &str,
    limit: i64,
) -> WorkerResult<Vec<SessionMessage>> {
    let results = db
        .prepare(
            "SELECT x.id, x.session_id, x.member_id, m.name AS member_name,
              m.avatar_updated_at AS member_avatar_updated_at,
              x.body, x.created_at
         FROM session_messages x
         JOIN members m ON m.id = x.member_id
        WHERE x.session_id = ?1
        ORDER BY x.created_at DESC, x.id DESC
        LIMIT ?2",
        )
        .bind(&[text(session_id), number(limit as f64)])?
        .all()
        .await?;
    let mut rows: Vec<SessionMessageRow> = results.results()?;

    // Newest-first in SQL so the cap keeps the *latest* messages, then flipped
    // for display: a conversation reads downwards.
    rows.reverse();
    Ok(rows
        .into_iter()
        .map(|row| SessionMessage {
            id: row.id,
            session_id: row.session_id,
            member_id: row.member_id,
            member_name: row.member_name,
            member_avatar_updated_at: row.member_avatar_updated_at,
            body: row.body,
            created_at: row.created_at,
        })
        .collect())
}

#[derive(Deserialize)]
struct MvpVoteRow {
    voter_id: String,
    nominee_id: String,
}

/// The MVP vote on one session, as one caller is allowed to see it.
///
/// One withholding, deliberate and done here rather than on the screen: **no
/// voter identity leaves this function.** `voter_id` is read only to find the
/// caller's own choice and to count how many have voted; who voted for whom is
/// never returned to anybody.
///
/// The count itself is not withheld from anyone. It belongs to the group, not
/// only to the people who played or the people who got round to voting — the
/// reserve who sat this one out and the member who never registered still want
/// to know who was named best, and refusing them the answer buys nothing.
pub async fn load_mvp(
    db: &D1Database,
    session_id: &str,
    viewer_member_id: &str,
) -> WorkerResult<Mvp> {
    let registrations = list_registrations(db, session_id).await?;
    // Whoever played, members only. A guest has no account to award, and no
    // profile for it to accumulate on.
    let candidates: Vec<MvpCandidate> = registrations
        .iter()
        .filter(|registration| did_attend(registration))
        .map(|registration| MvpCandidate {
            member_id: registration.member_id.clone(),
            member_name: registration.member_name.clone(),
            member_avatar_updated_at: registration.member_avatar_updated_at.clone(),
        })
        .collect();

    let results = db
        .prepare("SELECT voter_id, nominee_id FROM mvp_votes WHERE session_id = ?1")
        .bind(&[text(session_id)])?
        .all()
        .await?;
    let votes: Vec<MvpVoteRow> = results.results()?;

    // A `Map` in the original, and its insertion order decides the order the
    // unnamed nominees are appended in below — which `sort_tally`, being
    // stable, then preserves among entries level on both keys. So the counts
    // are kept in a list rather than a hash.
    let mut counts: Vec<(String, i64)> = Vec::new();
    let mut my_vote: Option<String> = None;
    for vote in &votes {
        match counts.iter_mut().find(|(id, _)| *id == vote.nominee_id) {
            Some((_, seen)) => *seen += 1,
            None => counts.push((vote.nominee_id.clone(), 1)),
        }
        if vote.voter_id == viewer_member_id {
            my_vote = Some(vote.nominee_id.clone());
        }
    }

    // Everyone who has a vote counted, even somebody since marked absent —
    // their votes were cast and are not the app's to quietly discard.
    let mut named = candidates.clone();
    for (nominee_id, _) in &counts {
        if named.iter().any(|entry| entry.member_id == *nominee_id) {
            continue;
        }
        let known = registrations.iter().find(|r| r.member_id == *nominee_id);
        named.push(MvpCandidate {
            member_id: nominee_id.clone(),
            member_name: known.map(|r| r.member_name.clone()).unwrap_or_default(),
            member_avatar_updated_at: known.and_then(|r| r.member_avatar_updated_at.clone()),
        });
    }

    let tally = sort_tally(
        named
            .into_iter()
            .map(|entry| {
                let votes = counts
                    .iter()
                    .find(|(id, _)| *id == entry.member_id)
                    .map(|(_, n)| *n)
                    .unwrap_or(0);
                MvpTallyEntry {
                    member_id: entry.member_id,
                    member_name: entry.member_name,
                    member_avatar_updated_at: entry.member_avatar_updated_at,
                    votes,
                }
            })
            .collect(),
    );

    let leaders = mvp_leaders(&tally);
    let voter_count = candidates.len() as i64;
    Ok(Mvp {
        candidates,
        my_vote,
        tally,
        leaders,
        // How many have voted says nothing about who for.
        votes_cast: votes.len() as i64,
        voter_count,
    })
}

/// Sessions this member was voted the best in.
///
/// Wins, not votes received. Twenty votes spread over five games somebody else
/// won is not five MVPs, and a career count that says otherwise is the kind of
/// number people notice is wrong.
///
/// A shared win counts for everyone tied, which is the same answer the session
/// screen gives — see [`mvp_leaders`]. Inventing a tiebreak here so the totals
/// look tidier would make the profile disagree with the trophy.
const MVP_WINS: &str = "
  WITH tallies AS (
    SELECT session_id, nominee_id, COUNT(*) AS votes
      FROM mvp_votes GROUP BY session_id, nominee_id
  ),
  tops AS (
    SELECT session_id, MAX(votes) AS best FROM tallies GROUP BY session_id
  )
  SELECT t.nominee_id AS member_id, COUNT(*) AS wins
    FROM tallies t
    JOIN tops ON tops.session_id = t.session_id
   WHERE t.votes = tops.best AND tops.best > 0
";

#[derive(Deserialize)]
struct WinsRow {
    wins: i64,
}

#[derive(Deserialize)]
struct MemberWinsRow {
    member_id: String,
    wins: i64,
}

pub async fn count_mvp_wins(db: &D1Database, member_id: &str) -> WorkerResult<i64> {
    let row: Option<WinsRow> = db
        .prepare(format!("{MVP_WINS} AND t.nominee_id = ?1 GROUP BY t.nominee_id"))
        .bind(&[text(member_id)])?
        .first(None)
        .await?;
    Ok(row.map(|row| row.wins).unwrap_or(0))
}

/// The same count for everybody at once, for the leaderboard.
pub async fn mvp_wins_by_member(db: &D1Database) -> WorkerResult<Vec<(String, i64)>> {
    let results = db.prepare(format!("{MVP_WINS} GROUP BY t.nominee_id")).all().await?;
    let rows: Vec<MemberWinsRow> = results.results()?;
    Ok(rows.into_iter().map(|row| (row.member_id, row.wins)).collect())
}

/* -------------------------------------------------------- composite reads */

/// Registration is open while the session is still scheduled and the game has
/// not finished — `futsal_core::clock::registration_open` is where that window
/// is written down and why. Every route that writes a registration asks here,
/// and the screen only mirrors the answer for button state: the server decides.
pub fn is_registration_open(session: &Session) -> bool {
    is_registration_open_at(session, js::now_ms())
}

/// The same rule against a given instant, in `Date.now()` milliseconds.
///
/// The row is parsed here and answered in `futsal_core::clock`, which is where
/// the window itself is written down and tested. An unparseable `starts_at` is
/// closed — the `NaN` comparison in the original said the same, and the check is
/// explicit here because `NaN as i64` is 0 in Rust rather than another `NaN`,
/// which would put every such session in January 1970 and open.
pub fn is_registration_open_at(session: &Session, now_ms: f64) -> bool {
    let starts_at = js::parse_date(&session.starts_at);
    if starts_at.is_nan() {
        return false;
    }
    registration_open(starts_at as i64, &session.status, now_ms as i64)
}

pub async fn load_session_detail(
    db: &D1Database,
    session_id: &str,
    viewer_member_id: &str,
) -> WorkerResult<Option<SessionDetail>> {
    let Some(session) = get_session_row(db, session_id).await? else { return Ok(None) };

    // Independent reads, so they cost one round trip between them rather than
    // two. The team board is on the same screen as the roster and is wanted at
    // the same moment.
    let (registrations, teams) =
        both(list_registrations(db, session_id), load_team_draw(db, session_id)).await;
    let registrations = registrations?;
    let teams = teams?;

    Ok(Some(SessionDetail {
        counts: count_registrations(&registrations),
        registration_open: is_registration_open(&session),
        me: registrations.iter().find(|r| r.member_id == viewer_member_id).cloned(),
        session,
        registrations,
        teams,
    }))
}

/// Heads, not rows.
///
/// A member who brought two friends is three bodies on a pitch that was hired
/// for twelve, so every number the cap is compared against counts guests. The
/// list of names is shorter than `in` whenever anyone brought somebody, which
/// is why `guests` is returned too — a screen showing "7 playing" over five
/// rows needs to be able to say why.
pub fn count_registrations(registrations: &[Registration]) -> RegistrationCounts {
    let mut in_count = 0;
    let mut waitlist_count = 0;
    let mut guest_count = 0;
    for r in registrations {
        let heads = 1 + r.guests;
        // The `else` catches every non-`in` status, not only `waitlist`.
        if r.status == "in" {
            in_count += heads;
            guest_count += r.guests;
        } else {
            waitlist_count += heads;
        }
    }
    RegistrationCounts { r#in: in_count, waitlist: waitlist_count, guests: guest_count }
}

#[derive(Deserialize)]
struct RegistrationCountRow {
    in_count: Option<i64>,
    wait_count: Option<i64>,
}

/// Counts straight from SQL, for the paths that do not need the full list.
pub async fn count_registrations_by_session(
    db: &D1Database,
    session_id: &str,
) -> WorkerResult<RegistrationTotals> {
    let row: Option<RegistrationCountRow> = db
        .prepare(
            "SELECT
         SUM(CASE WHEN status = 'in' THEN 1 ELSE 0 END) AS in_count,
         SUM(CASE WHEN status = 'waitlist' THEN 1 ELSE 0 END) AS wait_count
       FROM registrations WHERE session_id = ?1",
        )
        .bind(&[text(session_id)])?
        .first(None)
        .await?;
    Ok(RegistrationTotals {
        r#in: row.as_ref().and_then(|row| row.in_count).unwrap_or(0),
        waitlist: row.as_ref().and_then(|row| row.wait_count).unwrap_or(0),
    })
}

pub async fn list_payments(db: &D1Database, session_id: &str) -> WorkerResult<Vec<Payment>> {
    let results = db
        .prepare(
            "SELECT p.id, p.session_id, p.member_id, m.name AS member_name, p.amount_due,
              p.amount_override, p.guests, p.status, p.proof_key, p.note, p.reject_reason,
              p.claimed_at, p.confirmed_at, p.updated_at
         FROM payments p
         JOIN members m ON m.id = p.member_id
        WHERE p.session_id = ?1
        ORDER BY m.name COLLATE NOCASE ASC",
        )
        .bind(&[text(session_id)])?
        .all()
        .await?;
    let rows: Vec<PaymentRow> = results.results()?;
    Ok(rows.iter().map(to_payment).collect())
}

pub async fn load_payment_summary(
    db: &D1Database,
    session: &Session,
) -> WorkerResult<PaymentSummary> {
    let payments = list_payments(db, &session.id).await?;

    let mut collected = 0;
    let mut pending = 0;
    let mut outstanding = 0;
    for p in &payments {
        // A pending amount counts in both `pending` and `outstanding`, and
        // every sum is of `amountDue` — never of the override.
        if p.status == "confirmed" {
            collected += p.amount_due;
        } else if p.status == "pending" {
            pending += p.amount_due;
            outstanding += p.amount_due;
        } else {
            outstanding += p.amount_due;
        }
    }

    Ok(PaymentSummary {
        session_id: session.id.clone(),
        total_charge: session.total_charge,
        collected,
        pending,
        outstanding,
        payments,
    })
}

/// The `(outstanding, id)` position a balance page resumes from.
#[derive(Debug, Clone)]
pub struct BalanceCursor {
    /// A JavaScript number, because that is all `typeof parsed.o === 'number'`
    /// asked for: the encoder only ever writes the integer the SQL column held,
    /// but a hand-made cursor carrying `1.5` was honoured and still is.
    pub outstanding: f64,
    pub id: String,
}

/// The `(starts_at, id)` position a session page resumes from.
#[derive(Debug, Clone)]
pub struct SessionCursor {
    pub starts_at: String,
    pub id: String,
}

#[derive(Deserialize)]
struct BalanceAggregates {
    sessions_played: i64,
    total_owed: i64,
    total_confirmed: i64,
    outstanding: i64,
}

/// Who owes what, biggest debt first, a page at a time.
///
/// The order moved from the client to here when this list grew past one screen.
/// Sorting "debtors first" in the browser only sorts what the browser happens
/// to have fetched, so with paging the top of page two could easily outrank the
/// bottom of page one — the list would no longer be in any order at all.
///
/// Keyset on `(outstanding DESC, id ASC)`, spelled out rather than as a row
/// value because the two directions differ and `(a, b) < (?, ?)` cannot express
/// that. `HAVING`, not `WHERE`, because `outstanding` is an aggregate and does
/// not exist yet when `WHERE` runs.
///
/// `limit` is a JavaScript number in the original and the routes hand it
/// whatever `Number(query)` produced, fractions included, so it stays one here.
pub async fn load_member_balances(
    db: &D1Database,
    limit: Option<f64>,
    cursor: Option<BalanceCursor>,
) -> WorkerResult<MemberBalancePage> {
    let limit = limit.unwrap_or(50.0).max(1.0).min(100.0);

    let columns = "m.id, m.name, m.is_organizer, m.active, m.external_id, m.created_at,
              m.notify_session, m.notify_payment, m.language, m.claimed_at, m.claim_nonce,
              m.claim_expires_at, m.token_version, m.avatar_key, m.avatar_updated_at,
              m.approved_at, m.hour12,
              COUNT(p.id) AS sessions_played,
              COALESCE(SUM(p.amount_due), 0) AS total_owed,
              COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_due ELSE 0 END), 0)
                AS total_confirmed,
              MAX(0, COALESCE(SUM(p.amount_due), 0)
                     - COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_due ELSE 0 END), 0))
                AS outstanding";

    let statement = match &cursor {
        Some(cursor) => db
            .prepare(format!(
                "SELECT {columns}
           FROM members m
           LEFT JOIN payments p ON p.member_id = m.id
          WHERE m.active = 1
          GROUP BY m.id
         HAVING outstanding < ?1 OR (outstanding = ?1 AND m.id > ?2)
          ORDER BY outstanding DESC, m.id ASC
          LIMIT ?3"
            ))
            .bind(&[number(cursor.outstanding), text(&cursor.id), number(limit + 1.0)])?,
        None => db
            .prepare(format!(
                "SELECT {columns}
           FROM members m
           LEFT JOIN payments p ON p.member_id = m.id
          WHERE m.active = 1
          GROUP BY m.id
          ORDER BY outstanding DESC, m.id ASC
          LIMIT ?1"
            ))
            .bind(&[number(limit + 1.0)])?,
    };

    // The TypeScript row type was `MemberRow & { …four aggregates }`. Reading
    // the same result twice, once through each half, is that intersection
    // without restating seventeen columns that would then be free to drift.
    let results = statement.all().await?;
    let members: Vec<MemberRow> = results.results()?;
    let aggregates: Vec<BalanceAggregates> = results.results()?;

    // `slice(0, limit)` with a fractional limit truncates, which is what
    // `Array.prototype.slice` does with a non-integer end.
    let page_size = (limit as usize).min(members.len());
    let next_cursor = if members.len() as f64 > limit && page_size > 0 {
        // Built from the *last row of the page*, whose `outstanding` is the SQL
        // column rather than the value recomputed below.
        Some(encode_balance_cursor(
            aggregates[page_size - 1].outstanding,
            &members[page_size - 1].id,
        ))
    } else {
        None
    };

    Ok(MemberBalancePage {
        balances: members[..page_size]
            .iter()
            .zip(&aggregates[..page_size])
            .map(|(row, totals)| MemberBalance {
                member: to_member(row),
                sessions_played: totals.sessions_played,
                total_owed: totals.total_owed,
                total_confirmed: totals.total_confirmed,
                outstanding: (totals.total_owed - totals.total_confirmed).max(0),
            })
            .collect(),
        next_cursor,
    })
}

/* ---------------------------------------------------------------- cursors */

#[derive(Serialize)]
struct SessionCursorBody<'a> {
    s: &'a str,
    i: &'a str,
}

#[derive(Serialize)]
struct BalanceCursorBody<'a> {
    o: i64,
    i: &'a str,
}

/// Opaque `(starts_at, id)` position in a list of sessions, newest first.
///
/// The id is in the tuple because two sessions can share a kickoff time — a
/// midweek game added twice, a fixture moved onto another — and a keyset on the
/// timestamp alone would make one of them unreachable. Both the group's fixture
/// history and a member's own page ride on this.
pub fn encode_session_cursor(starts_at: &str, id: &str) -> String {
    // `btoa(unescape(encodeURIComponent(json)))` is base64 of the UTF-8 bytes,
    // standard alphabet, `=` padded — not the base64url the tokens use.
    let json = serde_json::to_string(&SessionCursorBody { s: starts_at, i: id })
        .unwrap_or_else(|_| String::from("{}"));
    btoa(json.as_bytes())
}

pub fn decode_session_cursor(raw: Option<&str>) -> Option<SessionCursor> {
    let parsed = decode_cursor(raw)?;
    // Only when both halves are strings; anything else is the first page.
    let starts_at = parsed.get("s")?.as_str()?.to_string();
    let id = parsed.get("i")?.as_str()?.to_string();
    Some(SessionCursor { starts_at, id })
}

/// Opaque `(outstanding, id)` position in the debt list.
pub fn encode_balance_cursor(outstanding: i64, id: &str) -> String {
    let json = serde_json::to_string(&BalanceCursorBody { o: outstanding, i: id })
        .unwrap_or_else(|_| String::from("{}"));
    btoa(json.as_bytes())
}

pub fn decode_balance_cursor(raw: Option<&str>) -> Option<BalanceCursor> {
    let parsed = decode_cursor(raw)?;
    let outstanding = parsed.get("o")?.as_f64()?;
    let id = parsed.get("i")?.as_str()?.to_string();
    Some(BalanceCursor { outstanding, id })
}

/// The shared half of both decoders: base64, UTF-8, `JSON.parse`. An unreadable
/// cursor is the first page, not an error, so every failure is `None`.
fn decode_cursor(raw: Option<&str>) -> Option<serde_json::Value> {
    let raw = raw.filter(|value| !value.is_empty())?;
    let bytes = atob(raw)?;
    // `decodeURIComponent(escape(...))` is a UTF-8 decode, and it throws on a
    // malformed sequence exactly where this returns `None`.
    let json = String::from_utf8(bytes).ok()?;
    serde_json::from_str::<serde_json::Value>(&json).ok()
}

/* ----------------------------------------------------------- member views */

#[derive(Deserialize)]
struct ProfileSessionRow {
    id: String,
    starts_at: String,
    reg_status: Option<String>,
    reg_attended: Option<i64>,
}

#[derive(Deserialize)]
struct OwedRow {
    due: i64,
}

#[derive(Deserialize)]
struct ScoredRow {
    n: i64,
}

/// Everything a profile screen shows, against the current clock.
pub async fn load_member_profile(
    db: &D1Database,
    member_id: &str,
) -> WorkerResult<Option<MemberProfile>> {
    load_member_profile_at(db, member_id, &crate::http::now_iso()).await
}

/// Everything a profile screen shows: who they are, their attendance run, and
/// what they still owe.
///
/// The streak deliberately does *not* reuse [`load_member_history`]. That query
/// keeps only sessions where the member has a registration or payment row,
/// which silently drops the games they ignored entirely — exactly the gaps that
/// are supposed to end a run. Reading it from there would hand every no-show a
/// perfect record.
///
/// `now` arrives already rendered, because the only thing the original did with
/// its `Date` was call `toISOString()` on it.
pub async fn load_member_profile_at(
    db: &D1Database,
    member_id: &str,
    now_iso: &str,
) -> WorkerResult<Option<MemberProfile>> {
    // No `active = 1` filter here, unlike `get_member_by_id`: a profile stays
    // readable after somebody has left.
    let row: Option<MemberRow> = db
        .prepare("SELECT * FROM members WHERE id = ?1")
        .bind(&[text(member_id)])?
        .first(None)
        .await?;
    let Some(row) = row else { return Ok(None) };

    let results = db
        .prepare(
            // Every game that has already kicked off since they joined.
            // Cancelled ones are excluded rather than treated as misses: nobody
            // played, so nobody's run should end. `starts_at` rather than
            // `status` decides whether it has happened, so a late cron cannot
            // resurrect a streak.
            "SELECT s.id, s.starts_at, r.status AS reg_status, r.attended AS reg_attended
         FROM sessions s
         LEFT JOIN registrations r ON r.session_id = s.id AND r.member_id = ?1
        WHERE s.status != 'cancelled'
          AND s.starts_at < ?2
          AND s.starts_at >= ?3
        ORDER BY s.starts_at DESC
        LIMIT 200",
        )
        .bind(&[text(member_id), text(now_iso), text(&row.created_at)])?
        .all()
        .await?;
    let sessions: Vec<ProfileSessionRow> = results.results()?;

    let entries: Vec<StreakEntry> = sessions
        .into_iter()
        .map(|session| StreakEntry {
            session_id: session.id,
            starts_at: session.starts_at,
            attendance: to_attendance(session.reg_status.as_deref(), session.reg_attended),
        })
        .collect();

    // This one sums `COALESCE(amount_override, amount_due)`, unlike
    // `load_member_balances`, which sums `amount_due` alone.
    let owed: Option<OwedRow> = db
        .prepare(
            "SELECT COALESCE(SUM(COALESCE(amount_override, amount_due)), 0) AS due
         FROM payments
        WHERE member_id = ?1 AND status != 'confirmed'",
        )
        .bind(&[text(member_id)])?
        .first(None)
        .await?;

    let scored: Option<ScoredRow> = db
        .prepare("SELECT COALESCE(SUM(goals), 0) AS n FROM registrations WHERE member_id = ?1")
        .bind(&[text(member_id)])?
        .first(None)
        .await?;

    Ok(Some(MemberProfile {
        member: to_member(&row),
        streak: compute_streak(&entries),
        goals: scored.map(|row| row.n).unwrap_or(0),
        mvps: count_mvp_wins(db, member_id).await?,
        outstanding: owed.map(|row| row.due).unwrap_or(0).max(0),
    }))
}

/// What one past session says about somebody's run.
///
/// A streak is supposed to mean "turned up N weeks running", and until
/// attendance existed it meant "said yes N weeks running" — so a no-show kept a
/// streak for a game they never came to, which is the opposite of the point.
///
/// `attended` is the decider where it has been set; where it has not, the old
/// presumption stands and a registration still reads as playing. So histories
/// from before this existed are unchanged, and only games somebody actually
/// marked can break a run. No registration row at all reads the same as "out":
/// they were not there.
fn to_attendance(status: Option<&str>, attended: Option<i64>) -> Attendance {
    let Some(status) = status else { return Attendance::Missed };
    if let Some(attended) = attended {
        return if attended == 1 { Attendance::In } else { Attendance::Missed };
    }
    match status {
        "in" => Attendance::In,
        "waitlist" => Attendance::Waitlist,
        _ => Attendance::Missed,
    }
}

/// The payment, registration and team columns hung off a history row.
///
/// The original typed this as `SessionWithVenueRow & { … }` and read the row
/// once; here the same result is deserialized through both halves — see
/// [`load_member_balances`] for the same trick and the same reason.
#[derive(Deserialize)]
struct MemberHistoryExtras {
    reg_status: Option<String>,
    pay_id: Option<String>,
    amount_due: Option<i64>,
    amount_override: Option<i64>,
    guests: Option<i64>,
    pay_status: Option<String>,
    proof_key: Option<String>,
    note: Option<String>,
    reject_reason: Option<String>,
    claimed_at: Option<String>,
    confirmed_at: Option<String>,
    pay_updated_at: Option<String>,
    member_name: String,
    team: Option<i64>,
}

/// The fixtures query on the history path selects seven columns, not the nine
/// `TeamMatchRow` has: `recorded_by`/`recorded_at` are deliberately not fetched
/// there, and the original's cast to `TeamMatchRow & { session_id }` claimed
/// two fields that were `undefined` at runtime.
#[derive(Deserialize)]
struct HistoryMatchRow {
    session_id: String,
    id: String,
    ordinal: i64,
    first_team: i64,
    second_team: i64,
    first_goals: Option<i64>,
    second_goals: Option<i64>,
}

/// One member's session-by-session history, newest first.
pub async fn load_member_history(
    db: &D1Database,
    member_id: &str,
    limit: Option<f64>,
    cursor: Option<SessionCursor>,
) -> WorkerResult<MemberHistoryPage> {
    let limit = limit.unwrap_or(20.0).max(1.0).min(100.0);

    // Keyset on `(starts_at DESC, id ASC)`, the same tuple the group's fixture
    // list pages on — see `encode_session_cursor`. One row past the page is
    // fetched to answer "is there more" without a second count query.
    let keyset = match &cursor {
        Some(_) => "AND (s.starts_at < ?3 OR (s.starts_at = ?3 AND s.id > ?4))",
        None => "",
    };

    let statement = db.prepare(format!(
        "SELECT {SESSION_COLUMNS},
              r.status AS reg_status,
              p.id AS pay_id, p.amount_due, p.amount_override, p.guests,
              p.status AS pay_status,
              p.proof_key, p.note, p.reject_reason, p.claimed_at, p.confirmed_at,
              p.updated_at AS pay_updated_at,
              m.name AS member_name,
              ts.team AS team
         {SESSION_FROM}
         JOIN members m ON m.id = ?1
         LEFT JOIN registrations r ON r.session_id = s.id AND r.member_id = ?1
         LEFT JOIN payments p ON p.session_id = s.id AND p.member_id = ?1
         -- Their own slot, not their guests': guest_index 0 is the member.
         LEFT JOIN team_slots ts
                ON ts.session_id = s.id AND ts.member_id = ?1 AND ts.guest_index = 0
        WHERE (r.id IS NOT NULL OR p.id IS NOT NULL)
          {keyset}
        ORDER BY s.starts_at DESC, s.id ASC
        LIMIT ?2"
    ));

    let statement = match &cursor {
        Some(cursor) => statement.bind(&[
            text(member_id),
            number(limit + 1.0),
            text(&cursor.starts_at),
            text(&cursor.id),
        ])?,
        None => statement.bind(&[text(member_id), number(limit + 1.0)])?,
    };

    let page = statement.all().await?;
    let all_sessions: Vec<SessionWithVenueRow> = page.results()?;
    let all_extras: Vec<MemberHistoryExtras> = page.results()?;

    // The extra row was only ever the answer to "is there more".
    let page_size = (limit as usize).min(all_sessions.len());
    let next_cursor = if all_sessions.len() as f64 > limit && page_size > 0 {
        let last = &all_sessions[page_size - 1];
        Some(encode_session_cursor(&last.starts_at, &last.id))
    } else {
        None
    };
    let session_rows = &all_sessions[..page_size];
    let extras = &all_extras[..page_size];

    // The fixtures for every session on the page, in one go.
    //
    // A second query rather than a join: a session has several games and this
    // one has a row per session, so joining them would multiply the page out
    // and then need collapsing again. A page at most — see the `limit` — which
    // is comfortably inside D1's bound-parameter ceiling.
    let played: Vec<&str> = session_rows
        .iter()
        .zip(extras)
        .filter(|(_, extra)| extra.team.is_some())
        .map(|(row, _)| row.id.as_str())
        .collect();
    let mut fixtures: Vec<(String, Vec<TeamMatch>)> = Vec::new();

    if !played.is_empty() {
        let placeholders = played
            .iter()
            .enumerate()
            .map(|(index, _)| format!("?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let binds: Vec<JsValue> = played.iter().map(|id| text(id)).collect();
        let results = db
            .prepare(format!(
                "SELECT session_id, id, ordinal, first_team, second_team, first_goals, second_goals
           FROM team_matches
          WHERE session_id IN ({placeholders})
          ORDER BY session_id, ordinal ASC"
            ))
            .bind(&binds)?
            .all()
            .await?;
        let match_rows: Vec<HistoryMatchRow> = results.results()?;

        for row in match_rows {
            let entry = TeamMatch {
                id: row.id,
                ordinal: row.ordinal,
                first_team: row.first_team,
                second_team: row.second_team,
                first_goals: row.first_goals,
                second_goals: row.second_goals,
                // Deliberately not fetched here.
                recorded_by: None,
                recorded_at: None,
            };
            match fixtures.iter_mut().find(|(id, _)| *id == row.session_id) {
                Some((_, list)) => list.push(entry),
                None => fixtures.push((row.session_id, vec![entry])),
            }
        }
    }

    let empty: Vec<TeamMatch> = Vec::new();
    let history = session_rows
        .iter()
        .zip(extras)
        .map(|(row, extra)| MemberHistoryEntry {
            session: to_session(row),
            registration_status: extra.reg_status.clone(),
            teams: extra.team.map(|team| HistoryTeams {
                team,
                // Resolved with the shared helper, so a row in the history list
                // and the board on the session screen can never disagree about
                // who won.
                outcomes: team_outcomes(
                    team,
                    fixtures
                        .iter()
                        .find(|(id, _)| *id == row.id)
                        .map(|(_, list)| list.as_slice())
                        .unwrap_or(&empty),
                ),
            }),
            payment: match &extra.pay_id {
                Some(pay_id) if !pay_id.is_empty() => Some(to_payment(&PaymentRow {
                    id: pay_id.clone(),
                    session_id: row.id.clone(),
                    member_id: member_id.to_string(),
                    member_name: extra.member_name.clone(),
                    amount_due: extra.amount_due.unwrap_or(0),
                    amount_override: extra.amount_override,
                    guests: extra.guests.unwrap_or(0),
                    status: extra.pay_status.clone().unwrap_or_else(|| String::from("unpaid")),
                    proof_key: extra.proof_key.clone(),
                    note: extra.note.clone(),
                    reject_reason: extra.reject_reason.clone(),
                    claimed_at: extra.claimed_at.clone(),
                    confirmed_at: extra.confirmed_at.clone(),
                    // Falls back to the *session's* `updated_at`.
                    updated_at: extra
                        .pay_updated_at
                        .clone()
                        .unwrap_or_else(|| row.updated_at.clone()),
                })),
                _ => None,
            },
        })
        .collect();

    Ok(MemberHistoryPage { history, next_cursor })
}

/* ------------------------------------------------------------ form + ranks */

/// How many past games the little squares beside a name show.
pub const FORM_WINDOW: i64 = 8;

#[derive(Deserialize)]
struct FormSessionRow {
    id: String,
    starts_at: String,
}

#[derive(Deserialize)]
struct FormRegistrationRow {
    session_id: String,
    member_id: String,
    status: String,
    attended: Option<i64>,
}

#[derive(Deserialize)]
struct FormMemberRow {
    id: String,
    created_at: String,
}

/// Recent form for everybody at once, over the default window.
pub async fn load_recent_form(db: &D1Database) -> WorkerResult<Vec<(String, Vec<Attendance>)>> {
    load_recent_form_window(db, FORM_WINDOW).await
}

/// Recent form for everybody at once.
///
/// One bounded query, not one per player: the home screen draws a row of
/// squares beside every name, and asking per member would be a dozen round
/// trips on the screen people open most. The window is the last handful of
/// games, so the whole thing is at most `window x roster` rows however long the
/// group has existed.
///
/// A game from before somebody joined is `none` rather than `missed` — an empty
/// square, not a black mark for a match that happened without them.
///
/// The result is a list of pairs rather than a hash: it is a `Map` in the
/// original and the route spreads it (`[...form]`), so the roster query's order
/// is the response's order.
pub async fn load_recent_form_window(
    db: &D1Database,
    window: i64,
) -> WorkerResult<Vec<(String, Vec<Attendance>)>> {
    let results = db
        .prepare(
            "SELECT id, starts_at FROM sessions
        WHERE status != 'cancelled' AND starts_at < ?1
        ORDER BY starts_at DESC LIMIT ?2",
        )
        .bind(&[text(&crate::http::now_iso()), number(window as f64)])?
        .all()
        .await?;
    let mut sessions: Vec<FormSessionRow> = results.results()?;

    // Oldest first, so the row reads left to right like a calendar.
    sessions.reverse();
    let ordered = sessions;
    let mut by_member: Vec<(String, Vec<Attendance>)> = Vec::new();
    if ordered.is_empty() {
        return Ok(by_member);
    }

    // Joined against the same window rather than an `IN (?, ?, ...)` list of
    // ids: D1 refuses more than 100 bound parameters, so a list would cap how
    // far back any of this could ever look. Two parameters, whatever the
    // window. The clock is read again here, exactly as the original read it.
    let results = db
        .prepare(
            "SELECT r.session_id, r.member_id, r.status, r.attended
         FROM registrations r
         JOIN (SELECT id FROM sessions
                WHERE status != 'cancelled' AND starts_at < ?1
                ORDER BY starts_at DESC LIMIT ?2) s ON s.id = r.session_id",
        )
        .bind(&[text(&crate::http::now_iso()), number(window as f64)])?
        .all()
        .await?;
    let rows: Vec<FormRegistrationRow> = results.results()?;

    let results = db
        .prepare("SELECT id, created_at FROM members WHERE active = 1 AND approved_at IS NOT NULL")
        .all()
        .await?;
    let members: Vec<FormMemberRow> = results.results()?;

    let lookup = RegistrationLookup::new(&rows);

    for member in &members {
        by_member.push((
            member.id.clone(),
            ordered
                .iter()
                .map(|session| {
                    // Not yet a member: nothing to say about that game either
                    // way. String comparison on ISO text, as in the original.
                    if session.starts_at < member.created_at {
                        return Attendance::None;
                    }
                    match lookup.get(&session.id, &member.id) {
                        Some(row) => to_attendance(Some(&row.status), row.attended),
                        None => to_attendance(None, None),
                    }
                })
                .collect(),
        ));
    }
    Ok(by_member)
}

/// The `${session_id}|${member_id}` map both bulk reads build.
struct RegistrationLookup<'a> {
    entries: Vec<(String, &'a FormRegistrationRow)>,
}

impl<'a> RegistrationLookup<'a> {
    fn new(rows: &'a [FormRegistrationRow]) -> Self {
        let mut entries: Vec<(String, &'a FormRegistrationRow)> = rows
            .iter()
            .map(|row| (format!("{}|{}", row.session_id, row.member_id), row))
            .collect();
        // Sorted so the lookup is a binary search rather than a scan per member
        // per session. The key is a table primary key, so there are no
        // duplicates for the sort to have to break a tie between.
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        Self { entries }
    }

    fn get(&self, session_id: &str, member_id: &str) -> Option<&'a FormRegistrationRow> {
        let key = format!("{session_id}|{member_id}");
        self.entries
            .binary_search_by(|(candidate, _)| candidate.as_str().cmp(key.as_str()))
            .ok()
            .map(|index| self.entries[index].1)
    }
}

/// How far back the leaderboard's streak looks.
///
/// A streak cannot be a `SUM` — it is "how many in a row, counting back from
/// the newest", which needs the sequence. So this reads a bounded slice of
/// history once and runs the same `compute_streak` the profile uses, rather
/// than inventing a second definition in SQL that would drift from the first.
///
/// Bounded by this many games rather than all of them: a streak longer than two
/// years of Fridays is not the number anybody is arguing about, and the
/// alternative is a query that grows for ever.
const HISTORY_LIMIT: i64 = 120;

#[derive(Deserialize)]
struct GoalsRow {
    member_id: String,
    n: i64,
}

/// The whole ranking, computed.
pub async fn load_leaderboard(db: &D1Database) -> WorkerResult<Vec<LeaderboardEntry>> {
    let results = db
        .prepare(
            "SELECT id, starts_at FROM sessions
        WHERE status != 'cancelled' AND starts_at < ?1
        ORDER BY starts_at DESC LIMIT ?2",
        )
        .bind(&[text(&crate::http::now_iso()), number(HISTORY_LIMIT as f64)])?
        .all()
        .await?;
    // Not reversed: `compute_streak` wants them newest first.
    let sessions: Vec<FormSessionRow> = results.results()?;

    let results = db
        .prepare(
            "SELECT * FROM members WHERE active = 1 AND approved_at IS NOT NULL
        ORDER BY name COLLATE NOCASE ASC",
        )
        .all()
        .await?;
    // This ordering is the output order of the whole function.
    let members: Vec<MemberRow> = results.results()?;

    // Same join rather than a parameter list — see `load_recent_form_window`.
    // With 120 sessions in the window an `IN` list would be 120 bound
    // parameters, and D1 stops at 100.
    let results = db
        .prepare(
            "SELECT r.session_id, r.member_id, r.status, r.attended
         FROM registrations r
         JOIN (SELECT id FROM sessions
                WHERE status != 'cancelled' AND starts_at < ?1
                ORDER BY starts_at DESC LIMIT ?2) s ON s.id = r.session_id",
        )
        .bind(&[text(&crate::http::now_iso()), number(HISTORY_LIMIT as f64)])?
        .all()
        .await?;
    let regs: Vec<FormRegistrationRow> = results.results()?;

    let results = db
        .prepare(
            "SELECT member_id, COALESCE(SUM(goals), 0) AS n FROM registrations GROUP BY member_id",
        )
        .all()
        .await?;
    let scored: Vec<GoalsRow> = results.results()?;
    let mvps_by = mvp_wins_by_member(db).await?;

    let lookup = RegistrationLookup::new(&regs);

    Ok(members
        .iter()
        .map(|row| {
            let entries: Vec<StreakEntry> = sessions
                .iter()
                .filter(|session| session.starts_at >= row.created_at)
                .map(|session| {
                    let reg = lookup.get(&session.id, &row.id);
                    StreakEntry {
                        session_id: session.id.clone(),
                        starts_at: session.starts_at.clone(),
                        attendance: to_attendance(
                            reg.map(|reg| reg.status.as_str()),
                            reg.and_then(|reg| reg.attended),
                        ),
                    }
                })
                .collect();
            LeaderboardEntry {
                member: to_member(row),
                streak: compute_streak(&entries),
                goals: scored
                    .iter()
                    .find(|scored| scored.member_id == row.id)
                    .map(|scored| scored.n)
                    .unwrap_or(0),
                mvps: mvps_by
                    .iter()
                    .find(|(id, _)| *id == row.id)
                    .map(|(_, wins)| *wins)
                    .unwrap_or(0),
            }
        })
        .collect())
}

/* ------------------------------------------------------- the shared rules */
//
// These six came from `@futsal/shared` in the original. They live here because
// `futsal-core` is not on this crate's dependency list; the two of them that
// already exist there — `streak::compute_streak` and `attendance::did_attend` —
// should replace these the moment it is.

/// What a member did about one session that has already happened.
///
/// `None` is the fourth state the form squares need and `to_attendance` never
/// produces: a game from before somebody joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Attendance {
    In,
    Waitlist,
    Missed,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreakEntry {
    pub session_id: String,
    pub starts_at: String,
    pub attendance: Attendance,
}

/// Attendance run, computed from every past session since the member joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Streak {
    /// Consecutive games played, counting back from the most recent one.
    pub current: i64,
    /// The longest run ever, which is the one worth bragging about.
    pub best: i64,
    pub played: i64,
    /// Every game that happened while they were a member. Waitlisted games are
    /// counted here even though the streak ignores them — "played 12 of 15"
    /// should not quietly shrink its own denominator.
    pub total: i64,
}

/// `entries` must be newest-first, which is the order the query returns and the
/// order the current streak has to be read in.
pub fn compute_streak(entries: &[StreakEntry]) -> Streak {
    let mut current = 0;
    let mut best = 0;
    let mut run = 0;
    let mut played = 0;
    // Only the leading run counts as "current", so stop growing it at the first
    // miss — but keep walking, because `best` may be further back.
    let mut current_is_live = true;

    for entry in entries {
        match entry.attendance {
            // The waitlist neither extends nor breaks: you said yes and there
            // was no room, and ending a run for the organizer's cap would be
            // punishing the wrong person.
            Attendance::Waitlist => continue,
            Attendance::In => {
                played += 1;
                run += 1;
                if current_is_live {
                    current += 1;
                }
                if run > best {
                    best = run;
                }
            }
            _ => {
                run = 0;
                current_is_live = false;
            }
        }
    }

    Streak { current, best, played, total: entries.len() as i64 }
}

/// Did this person play?
///
/// Unmarked is a *presumption*, not a default value, and it differs by status:
/// somebody who was in is presumed to have turned up, somebody on the waitlist
/// is presumed not to have. An explicit mark beats both.
pub fn did_attend(registration: &Registration) -> bool {
    match registration.attended {
        Some(attended) => attended,
        None => registration.status == "in",
    }
}

/// Highest first, then by name so the order is stable between renders.
///
/// `Vec::sort_by` is stable and so is `Array.prototype.sort`, so entries level
/// on both keys keep the order they were built in.
pub fn sort_tally(tally: Vec<MvpTallyEntry>) -> Vec<MvpTallyEntry> {
    let mut out = tally;
    out.sort_by(|a, b| match b.votes.cmp(&a.votes) {
        Ordering::Equal => locale_compare(&a.member_name, &b.member_name),
        other => other,
    });
    out
}

/// Everybody level at the top, or nobody.
///
/// Ties are ties: a tiebreak the group did not agree to is worse than an honest
/// draw. And nobody is at the top on zero votes — with none cast, every
/// candidate is level on nothing, which is the arithmetic being true and the
/// meaning being false.
pub fn mvp_leaders(tally: &[MvpTallyEntry]) -> Vec<String> {
    // `Math.max(0, ...votes)`: the floor of zero is what makes an empty tally
    // answer zero rather than -Infinity.
    let most = tally.iter().map(|entry| entry.votes).fold(0, i64::max);
    if most == 0 {
        return Vec::new();
    }
    tally
        .iter()
        .filter(|entry| entry.votes == most)
        .map(|entry| entry.member_id.clone())
        .collect()
}

/// How one game went for one of the two sides in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchOutcome {
    Won,
    Drawn,
    Lost,
}

/// How one side's games went, in fixture order.
///
/// The sequence rather than the tally, because that is what a history row
/// wants: three marks in a line say "won, won, lost" — a shape you read without
/// reading. Fixtures with no score contribute nothing; a game not played is not
/// a draw.
pub fn team_outcomes(team: i64, matches: &[TeamMatch]) -> Vec<MatchOutcome> {
    let mut outcomes = Vec::new();

    for fixture in matches {
        // A fixture with a score against it. Both halves or neither.
        let (Some(first_goals), Some(second_goals)) = (fixture.first_goals, fixture.second_goals)
        else {
            continue;
        };

        let (mine, theirs) = if fixture.first_team == team {
            (first_goals, second_goals)
        } else if fixture.second_team == team {
            (second_goals, first_goals)
        } else {
            // Not this team's game.
            continue;
        };

        outcomes.push(match mine.cmp(&theirs) {
            Ordering::Greater => MatchOutcome::Won,
            Ordering::Less => MatchOutcome::Lost,
            Ordering::Equal => MatchOutcome::Drawn,
        });
    }

    outcomes
}

/// Map anything a browser or database might hand us onto a supported locale.
///
/// Accepts `my-MM`, `my`, `en-GB`, and the historical Burmese tags `bur`/`mya`,
/// which some Android builds still report.
pub fn normalize_locale(value: &str) -> &'static str {
    if value.is_empty() {
        return "en";
    }
    let tag = value.to_lowercase();
    if tag.starts_with("my") || tag.starts_with("bur") || tag.starts_with("mya") {
        "my"
    } else {
        "en"
    }
}

/* ------------------------------------------------------------- primitives */

/// A bound value. D1 takes JS values; text and number are all this file needs.
fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn number(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

/// `String.prototype.localeCompare` with the default locale, which is what the
/// tally's name tiebreak sorts on. An empty `locales` array means "nothing
/// requested", the same as passing no argument at all.
fn locale_compare(a: &str, b: &str) -> Ordering {
    let result =
        js_sys::JsString::from(a).locale_compare(b, &js_sys::Array::new(), &js_sys::Object::new());
    result.cmp(&0)
}

/// `Promise.all([a, b])` for two futures.
///
/// Rust futures do nothing until polled, so awaiting one and then the other
/// would turn a pair of independent reads into two round trips — which is the
/// cost the original went out of its way to avoid on the screens that use it.
/// Polling both from one future starts both requests before either is waited
/// on, which is what `Promise.all` did.
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

/// `btoa` over raw bytes: the standard alphabet with `=` padding, which is what
/// the cursors are and what tells them apart from the base64url the identity
/// tokens use.
fn btoa(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let packed = (u32::from(group[0]) << 16)
            | (u32::from(group.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(group.get(2).copied().unwrap_or(0));
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 { ALPHABET[(packed >> 6) as usize & 63] as char } else { '=' });
        out.push(if group.len() > 2 { ALPHABET[packed as usize & 63] as char } else { '=' });
    }
    out
}

/// `atob`, which is the WHATWG "forgiving-base64 decode": ASCII whitespace is
/// stripped first, then up to two trailing `=` come off a properly sized
/// string, a remainder of one character is a failure, and anything outside the
/// alphabet is a failure. Every failure is `None`, because both callers read
/// that as "start from the beginning".
fn atob(value: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = value
        .bytes()
        .filter(|byte| !matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    if !value.is_ascii() {
        return None;
    }
    if data.len() % 4 == 0 {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }

    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in data {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            // A leftover `=` included: well-formed padding is already off.
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    // The bits past the last whole byte are dropped, not checked for zero.
    Some(out)
}

#[cfg(test)]
mod cache_round_trip {
    use super::*;

    /// The board goes to Redis as JSON and comes back as these structs.
    ///
    /// Worth pinning because the failure is quiet in the wrong direction: a
    /// field that serialises one way and reads back another produces a board
    /// that is subtly wrong rather than one that is obviously broken, and the
    /// camel-case rename means the stored names are not the Rust ones. A
    /// mismatch that made it un-deserialisable would be harmless — that is a
    /// cache miss — so this checks the case that is not.
    #[test]
    fn an_entry_survives_the_cache() {
        let entry = LeaderboardEntry {
            member: Member {
                id: "mem_a".into(),
                name: "Aung".into(),
                is_organizer: true,
                active: true,
                created_at: "2026-01-02T03:04:05.000Z".into(),
                notify_session: false,
                notify_payment: true,
                language: "my".into(),
                hour12: true,
                claimed_at: Some("2026-02-03T04:05:06.000Z".into()),
                has_pending_link: true,
                avatar_updated_at: Some("2026-03-04T05:06:07.000Z".into()),
                approved_at: Some("2026-04-05T06:07:08.000Z".into()),
            },
            streak: Streak { current: 3, best: 9, played: 11, total: 14 },
            goals: 27,
            mvps: 4,
        };

        let stored = serde_json::to_string(&entry).unwrap();
        let read: LeaderboardEntry = serde_json::from_str(&stored).unwrap();

        // Field by field would drift as the struct grows; re-serialising asks
        // the only question that matters, which is whether anything moved.
        assert_eq!(serde_json::to_string(&read).unwrap(), stored);
        assert_eq!(read.member.id, "mem_a");
        assert_eq!(read.streak.best, 9);
        assert_eq!(read.goals, 27);
        assert_eq!(read.mvps, 4);
        // The names in Redis are the names on the wire, not the Rust ones.
        assert!(stored.contains("\"isOrganizer\""));
        assert!(stored.contains("\"avatarUpdatedAt\""));
    }
}
