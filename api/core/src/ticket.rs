//! What a kitchen ticket says, as data.
//!
//! The Rust twin of `shared/src/ticket.ts`, held to the same test cases. This
//! is the side that runs: `GET /print-jobs` renders a [`TicketDoc`] per pending
//! job and the agent prints it, so the agent holds no rules at all — a doc in,
//! ESC/POS bytes out.
//!
//! ## The doc carries no words
//!
//! Not a line of prose, and that is the design rather than an omission. A
//! [`TicketDoc`] is a round number, a table, a time, a name and some lines. The
//! labels around them — "ROUND", "VOID", "TAKEAWAY", "TABLE" and the waiter's
//! line — belong to the **agent**, in `agent/src/index.ts`, next to the ESC/POS
//! bytes that draw them.
//!
//! That draws the line in the right place. What a ticket *says* is a rule and
//! lives twice, here and in `shared/src/ticket.ts`; what it *is* on the wire —
//! the bytes, the font size, where the paper is cut, and the words themselves —
//! belongs to the one thing that knows what a printer can render. Which is not
//! much: a thermal printer's built-in character set has no Myanmar glyphs, so
//! those five labels are English, and the README says so under Known
//! limitations.
//!
//! ## The time is the restaurant's
//!
//! [`crate::clock::format_clock`] with the offset from the Worker's vars, so
//! the slip says what the kitchen clock says. A UTC stamp on a piece of paper
//! in Yangon is six and a half hours of confusion for no benefit at all.

use serde::{Deserialize, Serialize};

use crate::clock;

/// One line on a ticket: how many, of what, with what note.
///
/// `Serialize` and field order is wire order, because this crosses to the agent
/// as JSON. `Deserialize` so the tests can read a doc back, and so the agent's
/// contract has a Rust-side reader if anything ever needs one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketLine {
    pub qty: i64,
    pub name: String,
    /// Free text from the waiter — "no chilli". `None` when there was none.
    pub note: Option<String>,
}

/// The rows a ticket is rendered from, as they come out of the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketInput {
    /// `"ticket"` or `"void"`, matching `print_jobs.kind` and the `CHECK`
    /// constraint behind it. A plain `String` rather than an enum, the way
    /// `db.rs` leaves `role` and `status` alone: the database decides which
    /// values exist, and a value SQLite somehow held should travel out
    /// unaltered rather than be rejected where the reader cannot see why.
    pub kind: String,
    /// The round's number within its check. What the ticket calls itself.
    pub seq: i64,
    /// The table's name, or `None` for takeaway and the counter.
    pub table_name: Option<String>,
    /// Who is answerable for this slip: the waiter who sent the round, or — on
    /// a void — whoever struck the line off. The kitchen needs somebody to ask
    /// about the "no chilli", and on a void they need to know who decided.
    pub staff_name: String,
    /// When the round was sent, or the line struck off, as **epoch
    /// milliseconds**.
    ///
    /// Not the ISO string the column holds, and that is the one place the two
    /// twins take different-looking input. This crate may not depend on the
    /// host, so it has no date parser and is not getting one for a field the
    /// caller already knows the instant of; `shared/src/ticket.ts` takes the
    /// same number for symmetry rather than leaning on the browser's `Date`.
    /// The test cases on both sides are the same integer.
    pub at_ms: i64,
    pub lines: Vec<TicketLine>,
}

/// What the agent is handed, and all it is handed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketDoc {
    pub kind: String,
    pub seq: i64,
    pub table: Option<String>,
    /// `19:30`, in the restaurant's own offset.
    pub time: String,
    pub staff: String,
    pub lines: Vec<TicketLine>,
}

/// Turn the rows behind a print job into the ticket they say.
///
/// Which lines arrive is the caller's business, and it is not the same question
/// for the two kinds: a `ticket` is the round entire, as it was sent —
/// including any line that has since been voided, because the void notice that
/// follows refers to a slip the kitchen is holding — and a `void` is the one
/// line that was struck off. This function renders what it is given.
///
/// What it does decide is the two normalisations that would otherwise be got
/// slightly differently in each of the two languages:
///
///   * an empty or all-whitespace note is **`None`**, not an empty line under
///     the dish. A waiter who opened the note field and typed nothing has not
///     said anything, and a blank line on a ticket reads like something went
///     missing.
///   * an empty or all-whitespace table name is **`None`**, which is takeaway.
///     It cannot happen through the API — `createTableSchema` trims and
///     requires a character — and it is handled because the alternative is a
///     ticket headed with a space, which nobody in the kitchen can act on.
pub fn render_ticket(input: &TicketInput, tz_offset_minutes: i64) -> TicketDoc {
    TicketDoc {
        kind: input.kind.clone(),
        seq: input.seq,
        table: blank_to_none(input.table_name.as_deref()),
        time: clock::format_clock(input.at_ms, tz_offset_minutes),
        staff: input.staff_name.clone(),
        lines: input
            .lines
            .iter()
            .map(|line| TicketLine {
                qty: line.qty,
                name: line.name.clone(),
                note: blank_to_none(line.note.as_deref()),
            })
            .collect(),
    }
}

/// `None`, `""` and `"   "` all mean "nothing was said".
fn blank_to_none(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Myanmar is UTC+06:30. 390 minutes, and the half hour is why it is
    /// minutes.
    const MM: i64 = 390;

    /// `2026-09-18T13:00:00Z`, which is 19:30 in Yangon — the same instant the
    /// clock twins are checked against.
    const AT_MS: i64 = 1_789_736_400_000;

    fn input(kind: &str, seq: i64, table: Option<&str>, lines: Vec<TicketLine>) -> TicketInput {
        at(kind, seq, table, lines, AT_MS)
    }

    fn at(
        kind: &str,
        seq: i64,
        table: Option<&str>,
        lines: Vec<TicketLine>,
        at_ms: i64,
    ) -> TicketInput {
        TicketInput {
            kind: kind.to_string(),
            seq,
            table_name: table.map(str::to_string),
            staff_name: "Su".to_string(),
            at_ms,
            lines,
        }
    }

    #[test]
    fn a_round_ticket_carries_its_number_table_time_and_lines() {
        let doc = render_ticket(
            &input(
                "ticket",
                2,
                Some("Table 4"),
                vec![
                    TicketLine { qty: 2, name: "Chicken curry".into(), note: None },
                    TicketLine { qty: 1, name: "Mohinga".into(), note: Some("no chilli".into()) },
                ],
            ),
            MM,
        );

        assert_eq!(doc.kind, "ticket");
        assert_eq!(doc.seq, 2);
        assert_eq!(doc.table.as_deref(), Some("Table 4"));
        assert_eq!(doc.time, "19:30");
        assert_eq!(doc.staff, "Su");
        assert_eq!(doc.lines.len(), 2);
        assert_eq!(doc.lines[1].note.as_deref(), Some("no chilli"));
    }

    /// Takeaway has no table, and `None` is what the agent renders its own word
    /// for. The doc holds no prose, so it cannot hold "Takeaway".
    #[test]
    fn takeaway_has_no_table() {
        let doc = render_ticket(&input("ticket", 1, None, vec![]), MM);
        assert_eq!(doc.table, None);
    }

    /// A name that is only whitespace is takeaway too, for the same reason: a
    /// ticket headed with a space is one nobody in the kitchen can act on.
    #[test]
    fn a_blank_table_name_is_takeaway() {
        let doc = render_ticket(&input("ticket", 1, Some("   "), vec![]), MM);
        assert_eq!(doc.table, None);
    }

    /// A waiter who opened the note field and typed nothing has not said
    /// anything.
    #[test]
    fn an_empty_note_is_no_note() {
        let doc = render_ticket(
            &input(
                "ticket",
                1,
                Some("Table 1"),
                vec![
                    TicketLine { qty: 1, name: "Tea".into(), note: Some("".into()) },
                    TicketLine { qty: 1, name: "Water".into(), note: Some("   ".into()) },
                    TicketLine { qty: 1, name: "Rice".into(), note: Some("  extra  ".into()) },
                ],
            ),
            MM,
        );
        assert_eq!(doc.lines[0].note, None);
        assert_eq!(doc.lines[1].note, None);
        // Trimmed, not merely kept: the waiter's stray spaces are not a note.
        assert_eq!(doc.lines[2].note.as_deref(), Some("extra"));
    }

    /// A void names the one line it is about, and the number of the round the
    /// kitchen is holding a slip for — that number is how they find it.
    #[test]
    fn a_void_names_the_round_it_undoes() {
        let doc = render_ticket(
            &input(
                "void",
                12,
                Some("Table 4"),
                vec![TicketLine { qty: 1, name: "Pork curry".into(), note: None }],
            ),
            MM,
        );
        assert_eq!(doc.kind, "void");
        assert_eq!(doc.seq, 12);
        assert_eq!(doc.lines.len(), 1);
    }

    /// The minute either side of local midnight, which is the case a fixed
    /// offset gets wrong if it is applied in the wrong direction.
    /// `17:29Z` is 23:59 in Yangon and `17:30Z` is 00:00 the next day.
    #[test]
    fn the_clock_is_the_restaurants_own() {
        let before = render_ticket(&at("ticket", 1, None, vec![], 1_789_752_540_000), MM);
        let after = render_ticket(&at("ticket", 1, None, vec![], 1_789_752_600_000), MM);
        assert_eq!(before.time, "23:59");
        assert_eq!(after.time, "00:00");
    }

    /// A 60-character name is the schema's maximum and is printed whole. Where
    /// the paper runs out is the agent's problem — it knows how many columns it
    /// has and this does not.
    #[test]
    fn a_long_name_is_not_truncated() {
        let name = "a".repeat(60);
        let doc = render_ticket(
            &input(
                "ticket",
                1,
                Some("Table 1"),
                vec![TicketLine { qty: 1, name: name.clone(), note: None }],
            ),
            MM,
        );
        assert_eq!(doc.lines[0].name, name);
        assert_eq!(doc.lines[0].name.len(), 60);
    }

    /// The wire shape, keys and order included — this is what the agent parses.
    #[test]
    fn a_doc_serialises_in_declaration_order() {
        let doc = render_ticket(
            &input(
                "ticket",
                3,
                Some("Table 2"),
                vec![TicketLine { qty: 2, name: "Tea".into(), note: None }],
            ),
            MM,
        );
        assert_eq!(
            serde_json::to_string(&doc).unwrap(),
            r#"{"kind":"ticket","seq":3,"table":"Table 2","time":"19:30","staff":"Su","lines":[{"qty":2,"name":"Tea","note":null}]}"#
        );
    }
}
