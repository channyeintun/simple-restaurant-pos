//! What a check comes to.
//!
//! The Rust twin of `shared/src/totals.ts`, function for function and held to
//! the same numbers: every case in `logic.test.ts` is written out again at the
//! bottom of this file. The Worker's copy is the one that decides what the
//! customer is charged, and the browser's is the one that decides what the
//! screen says it is — two of them disagreeing by a kyat is the failure the
//! twin rule exists to prevent, and it is the kind that shows up weeks later,
//! in front of somebody at the till.
//!
//! ## Why this is not a `SUM` in SQL
//!
//! A `SUM(price_minor_snapshot * qty)` in a query would be a *third* definition
//! of the total, written in a language neither twin is written in and held to
//! no test case at all. The queries in `db.rs` decide **which rows** — the
//! `voided_at IS NULL` on a read that wants live lines — and this decides what
//! they come to. That split is the rule, and a route that totals in SQL because
//! it was already reading the rows is the way it gets broken.

/// One line of a check, as the row holds it.
///
/// `voided_at` rather than a boolean, mirroring both the column and the field
/// on `itemSchema`, so the twin test cases are the same values on both sides
/// rather than the same values plus a conversion somebody could get backwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckLine {
    pub price_minor_snapshot: i64,
    pub qty: i64,
    pub voided_at: Option<String>,
}

impl CheckLine {
    /// A live line, for the places that are building one rather than reading it.
    pub fn live(price_minor_snapshot: i64, qty: i64) -> Self {
        Self { price_minor_snapshot, qty, voided_at: None }
    }
}

/// What one line comes to: the price snapshotted when the round was sent, times
/// how many.
///
/// Integers in, integer out, and no rounding step — which is the point. A float
/// here would not break loudly: it would agree with the till for weeks and then
/// be a unit out, because `1.15 * 7` is `8.049999999999999` and truncating that
/// back to minor units loses a cent. Multiplying integers cannot do that.
///
/// `saturating_mul` rather than `*`, and it is not defensive programming for
/// its own sake: in a release build an overflow here wraps silently and hands
/// somebody a negative bill, while in a debug build it panics and takes the
/// isolate down mid-service. Saturating gives an absurd number instead, which
/// is the failure mode a person notices. It cannot be reached through the API —
/// `minorSchema` stops at a billion and `qty` at 99, which is eleven digits
/// short of the ceiling — so this is cover for a hand-edited row.
pub fn line_total_minor(price_minor: i64, qty: i64) -> i64 {
    price_minor.saturating_mul(qty)
}

/// What the whole check comes to: every live line's total, added up.
///
/// Voided lines contribute nothing and are not an error. A check whose every
/// line was struck off still gets paid, for zero, and closed — which is what
/// frees the table on the cashier's screen, and why `payments.amount_minor` is
/// `>= 0` rather than `> 0`.
pub fn check_total_minor(lines: &[CheckLine]) -> i64 {
    let mut total = 0i64;
    for line in lines {
        if line.voided_at.is_some() {
            continue;
        }
        total = total.saturating_add(line_total_minor(line.price_minor_snapshot, line.qty));
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voided(price_minor_snapshot: i64, qty: i64) -> CheckLine {
        CheckLine {
            price_minor_snapshot,
            qty,
            voided_at: Some("2026-09-18T13:00:00.000Z".to_string()),
        }
    }

    #[test]
    fn a_line_is_its_price_times_its_quantity() {
        assert_eq!(line_total_minor(4_500, 1), 4_500);
        assert_eq!(line_total_minor(4_500, 3), 13_500);
        assert_eq!(line_total_minor(0, 12), 0);
    }

    /// The case that is the whole argument for integer minor units: `1.15 * 7`
    /// is `8.049999999999999` as a float, and truncating it back loses a cent.
    #[test]
    fn a_line_cannot_lose_a_unit_to_a_float() {
        assert_eq!(line_total_minor(115, 7), 805);
    }

    #[test]
    fn an_empty_check_comes_to_nothing() {
        assert_eq!(check_total_minor(&[]), 0);
    }

    #[test]
    fn a_check_is_the_sum_of_its_live_lines() {
        let lines =
            [CheckLine::live(4_500, 3), CheckLine::live(2_500, 1), CheckLine::live(800, 2)];
        assert_eq!(check_total_minor(&lines), 17_600);
    }

    /// Voided lines are skipped rather than removed. The row is still on the
    /// bill's paper trail; what it is not is money owed.
    #[test]
    fn a_voided_line_is_not_money_owed() {
        let lines = [CheckLine::live(4_500, 3), voided(2_500, 1), CheckLine::live(800, 2)];
        assert_eq!(check_total_minor(&lines), 15_100);
    }

    /// A check whose every line was struck off still gets paid, for zero, and
    /// closed — which is what frees the table.
    #[test]
    fn a_wholly_voided_check_comes_to_zero() {
        assert_eq!(check_total_minor(&[voided(4_500, 3), voided(800, 2)]), 0);
    }

    /// The schema's own maxima, multiplied out: `minorSchema` stops at a billion
    /// and `qty` at 99. Ninety-nine billion fits an `i64` with room to spare and
    /// fits a JavaScript number exactly, which is what makes the twin's answer
    /// the same rather than approximately the same.
    #[test]
    fn the_schema_maxima_are_nowhere_near_the_ceiling() {
        let lines = [CheckLine::live(1_000_000_000, 99)];
        assert_eq!(check_total_minor(&lines), 99_000_000_000);
        assert!(99_000_000_000i64 < (1i64 << 53));
    }
}
