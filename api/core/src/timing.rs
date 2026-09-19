//! How long a round should take.
//!
//! The Rust half of `shared/src/timing.ts`, and deliberately the *smaller*
//! half. Only one function here is twinned, and the module doc on the other
//! side explains why the rest is not: whether a round is late is a function of
//! *now*, re-evaluated every second in a browser, and this Worker never renders
//! it. A copy nothing called would be dead code in a crate whose discipline is
//! that it holds only rules somebody could be shown on paper. If the Worker
//! ever decides lateness itself — a report, a nudge — that is when the rest
//! arrives, with its own test cases.
//!
//! What the Worker *does* need is the target, because it puts one on every open
//! check it hands to the waiter's grid, and the browser draws a countdown from
//! it. Two sides computing the same number from the same rows is exactly the
//! situation the twin rule exists for.
//!
//! Nothing in here is told to us by the kitchen. `CLAUDE.md` says there are no
//! preparing/ready states because the kitchen has a printer rather than a
//! screen, and that is still true — this is built from a number a manager typed
//! and a timestamp the send already wrote.

/// The one field of a line this module reads.
///
/// A struct of one integer rather than a bare `&[i64]`, so a caller cannot pass
/// the quantities by mistake — they are both `i64` and both per-line, which is
/// exactly the pair of arguments worth making un-swappable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimedLine {
    /// What this dish was expected to take when the round was sent.
    pub prep_minutes_snapshot: i64,
}

/// How long a round should take: the slowest thing on it.
///
/// Max rather than sum, and not an average. A round is one trip to the table,
/// so it is finished when the *last* dish is; summing would say three drinks
/// take six minutes, which no kitchen has ever done.
///
/// Zero for a round with no lines. That cannot arrive through the API —
/// `sendRoundSchema` requires at least one item — and answering zero rather
/// than panicking means a hand-cleaned row renders as "due now" instead of
/// taking the isolate down.
pub fn round_target_minutes(lines: &[TimedLine]) -> i64 {
    let mut longest = 0;
    for line in lines {
        if line.prep_minutes_snapshot > longest {
            longest = line.prep_minutes_snapshot;
        }
    }
    longest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(minutes: &[i64]) -> Vec<TimedLine> {
        minutes.iter().map(|m| TimedLine { prep_minutes_snapshot: *m }).collect()
    }

    /// A round is one trip to the table, so it is finished when the last dish
    /// is. Every case here has a twin in `shared/test/logic.test.ts`.
    #[test]
    fn a_rounds_target_is_its_slowest_dish() {
        assert_eq!(round_target_minutes(&lines(&[2, 15, 5])), 15);
        assert_eq!(round_target_minutes(&lines(&[15])), 15);
        assert_eq!(round_target_minutes(&lines(&[2, 2, 2])), 2);
    }

    /// Not a sum. Three drinks take as long as one drink.
    #[test]
    fn three_drinks_do_not_take_three_times_as_long() {
        assert_eq!(round_target_minutes(&lines(&[2, 2, 2])), 2);
    }

    /// Cannot happen through the API, and answers rather than panics.
    #[test]
    fn a_round_with_no_lines_is_due_at_once() {
        assert_eq!(round_target_minutes(&[]), 0);
    }

    /// A dish somebody set to zero is instant, and does not drag the round's
    /// target down with it.
    #[test]
    fn a_zero_minute_dish_does_not_lower_the_target() {
        assert_eq!(round_target_minutes(&lines(&[0, 12])), 12);
        assert_eq!(round_target_minutes(&lines(&[0])), 0);
    }
}
