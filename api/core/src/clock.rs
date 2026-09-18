//! Local time, as a fixed offset from UTC.
//!
//! Ported from `shared/src/time.ts`. Everything crossing the API boundary is an
//! ISO-8601 UTC instant; these helpers exist for the handful of questions that
//! are only meaningful in local terms — what the clock on the kitchen ticket
//! says, and which day's takings a payment belongs to. Instants are carried
//! here as milliseconds since the epoch, the way the rest of the port carries
//! them.
//!
//! ## Why an offset and not a timezone database
//!
//! Myanmar has been on a fixed UTC+06:30 since 1945, with no daylight saving,
//! so the arithmetic below is exact — and it is the same arithmetic in Rust
//! here and in TypeScript in `shared/src/time.ts`, which matters more than it
//! sounds. The alternative is `Intl` with an IANA zone in the browser and a tz
//! crate in the Worker: two implementations of one rule, shipped separately,
//! each carrying data the other does not. A kitchen ticket printed at 00:05 and
//! a day's sales total that disagree about which day it is would be a genuinely
//! hard bug to see and an infuriating one to explain.
//!
//! ## Why minutes
//!
//! Because +06:30 is not a whole number of hours. A `TZ_OFFSET_HOURS` var would
//! have to be `6.5`, which is a float describing a clock — the one place this
//! codebase has already decided floats do not belong — and would round to six
//! the first time somebody typed it into an integer column. Minutes are exact
//! for every offset any inhabited zone has ever used, including the
//! quarter-hour ones.
//!
//! The offset is a **parameter** on every function here, never a constant in
//! this module. It comes from the Worker's `TZ_OFFSET_MINUTES` var;
//! `DEFAULT_TZ_OFFSET_MINUTES` in `config.rs` holds the only literal copy of it
//! on this side, and it is not a fallback. A default argument here would be a
//! second source of truth, and the failure it produces is silent: every time
//! would be half an hour out and still look like a time.
//!
//! ## Why the calendar is written out
//!
//! Futsal's version of this file was pinned to ICT and answered "which Friday
//! is next?". None of that survives — a restaurant is open when it is open, and
//! nothing here schedules anything — but its civil-date arithmetic does, for
//! the reason it was written out in the first place: `from_zoned_parts` has to
//! reproduce what `Date.UTC` does with a day past the end of its month, and
//! that is behaviour to copy rather than to assume. A date crate would be a
//! dependency, a tz database and a second opinion, for two dozen lines of
//! integer division.

const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

/// A wall-clock reading. No weekday and no seconds: nothing a POS prints or
/// groups by needs either, and a field nobody reads is a field that will be
/// wrong when somebody finally does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZonedParts {
    pub year: i64,
    /// 1-12
    pub month: i64,
    /// 1-31
    pub day: i64,
    /// 0-23
    pub hour: i64,
    pub minute: i64,
}

/// Break a UTC instant into its local wall-clock parts.
pub fn to_zoned_parts(instant_ms: i64, offset_minutes: i64) -> ZonedParts {
    let shifted = instant_ms + offset_minutes * MS_PER_MINUTE;
    // Euclidean, not truncating: before 1970 — and, more to the point, at any
    // negative offset in the small hours — `shifted / MS_PER_DAY` would round
    // towards zero and land the reading on the wrong day with a negative hour.
    let days = shifted.div_euclid(MS_PER_DAY);
    let rest = shifted.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    ZonedParts {
        year,
        month,
        day,
        hour: rest / MS_PER_HOUR,
        minute: (rest % MS_PER_HOUR) / MS_PER_MINUTE,
    }
}

/// Interpret the given wall-clock parts as local time and return the UTC
/// instant.
///
/// `day` may run past the end of its month, and the date rolls forward the way
/// `Date.UTC` rolls it — `2026-09-31` is `2026-10-01` — which is what lets a
/// caller add days without owning a calendar. Nothing in the POS does that
/// today; it is kept because `start_of_zoned_day` is built on it and because
/// the TypeScript twin gets the same normalisation free from `Date.UTC`, so a
/// port that quietly refused an out-of-range day would be a difference waiting
/// to be found.
///
/// It takes the whole [`ZonedParts`] rather than futsal's five separate
/// numbers: the only caller that wanted the pieces was `next_weekday`, which is
/// gone, and `from_zoned_parts(to_zoned_parts(t, o), o)` is the round trip the
/// tests want to write.
pub fn from_zoned_parts(parts: ZonedParts, offset_minutes: i64) -> i64 {
    let days = days_from_civil(parts.year, parts.month, 1) + (parts.day - 1);
    days * MS_PER_DAY + parts.hour * MS_PER_HOUR + parts.minute * MS_PER_MINUTE
        - offset_minutes * MS_PER_MINUTE
}

/// `YYYY-MM-DD` of the instant, locally. This is the key the day's sales total
/// is grouped by.
///
/// It has to be the local day and not the UTC one, and at +06:30 the two differ
/// for the last six and a half hours of every UTC day — which in Yangon is the
/// evening service, the busiest part of it. Grouping by the UTC date would file
/// everything after 17:30 UTC under the previous day and hand the manager a
/// daily total that is wrong every single night.
pub fn zoned_date_key(instant_ms: i64, offset_minutes: i64) -> String {
    let p = to_zoned_parts(instant_ms, offset_minutes);
    format!("{}-{:02}-{:02}", p.year, p.month, p.day)
}

/// Local midnight that opened the day containing `instant`, as a UTC instant.
///
/// The lower bound of the "today" queries — today's sales, today's checks — so
/// that the range the database is asked for and the key the rows are grouped by
/// are derived from the same definition of a day.
///
/// A restaurant that serves past midnight will file the late tables under the
/// next day. That is a real thing to decide about and this is not the place to
/// decide it: a business day that starts at 06:00 is a policy, and it would
/// belong in a var next to the offset rather than hidden in a helper called
/// "start of day".
pub fn start_of_zoned_day(instant_ms: i64, offset_minutes: i64) -> i64 {
    let p = to_zoned_parts(instant_ms, offset_minutes);
    from_zoned_parts(ZonedParts { hour: 0, minute: 0, ..p }, offset_minutes)
}

/// `"19:30"` — the time at the top of a kitchen ticket.
pub fn format_clock(instant_ms: i64, offset_minutes: i64) -> String {
    let p = to_zoned_parts(instant_ms, offset_minutes);
    format!("{:02}:{:02}", p.hour, p.minute)
}

/// `"2026-09-18 19:30"` — the stamp on a receipt.
///
/// Numeric and locale-free on purpose. A receipt is a record somebody may have
/// to match against a bank line or a day's takings weeks later, and the two
/// things a date on a record has to be are unambiguous and sortable. Month
/// names would be neither: they would need a table in English and Burmese, kept
/// in step here and in `shared/`, so that the printer agent and the cashier's
/// screen agree on what to call September — a lot of machinery for a line that
/// reads better as digits anyway. It is also why this module, unlike futsal's,
/// has no `Locale` parameter and no month table to get out of step.
///
/// 24-hour, because a bill is not a conversation and `19:30` cannot be read as
/// half past seven in the morning.
pub fn format_date_time(instant_ms: i64, offset_minutes: i64) -> String {
    let p = to_zoned_parts(instant_ms, offset_minutes);
    format!("{}-{:02}-{:02} {:02}:{:02}", p.year, p.month, p.day, p.hour, p.minute)
}

// ---- civil arithmetic ------------------------------------------------------

/// Days since 1970-01-01 for a proleptic Gregorian date, after Howard Hinnant's
/// `days_from_civil`. The same answer `Date.UTC` gives.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of `days_from_civil`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { y + 1 } else { y }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Myanmar is UTC+06:30. 390 minutes, and the half hour is why it is
    /// minutes.
    const MM: i64 = 390;
    /// Vietnam, UTC+07:00 — used once, to prove the offset is really a
    /// parameter.
    const VN: i64 = 420;

    /// The instants the TypeScript writes as ISO strings. Rust has no `Date` to
    /// parse them with and is not growing a dependency to get one, so they are
    /// epoch milliseconds with the string beside them — which is also the last
    /// place the two suites could silently stop testing the same moment.
    const MID_SERVICE: i64 = 1_789_736_400_000; // 2026-09-18T13:00:00Z
    const A_MINUTE_TO_MIDNIGHT: i64 = 1_789_752_540_000; // 2026-09-18T17:29:00Z
    const LOCAL_MIDNIGHT: i64 = 1_789_752_600_000; // 2026-09-18T17:30:00Z
    const FIVE_PAST_MIDNIGHT: i64 = 1_789_752_900_000; // 2026-09-18T17:35:00Z
    const MONTH_END: i64 = 1_790_789_700_000; // 2026-09-30T17:35:00Z
    const YEAR_END: i64 = 1_798_738_500_000; // 2026-12-31T17:35:00Z
    const WEST_OF_UTC: i64 = 1_789_696_800_000; // 2026-09-18T02:00:00Z
    const YESTERDAYS_MIDNIGHT: i64 = 1_789_666_200_000; // 2026-09-17T17:30:00Z

    /// 13:00 UTC + 6h30 = 19:30 in Yangon, which is the middle of dinner
    /// service.
    #[test]
    fn the_wall_clock_at_plus_six_thirty() {
        assert_eq!(
            to_zoned_parts(MID_SERVICE, MM),
            ZonedParts { year: 2026, month: 9, day: 18, hour: 19, minute: 30 }
        );
        assert_eq!(format_clock(MID_SERVICE, MM), "19:30");
        assert_eq!(format_date_time(MID_SERVICE, MM), "2026-09-18 19:30");
    }

    /// The same instant at +07:00 is half an hour later on the clock. If the
    /// offset were ever stored as hours, this pair would be the same string.
    #[test]
    fn the_offset_really_is_minutes() {
        assert_eq!(format_clock(MID_SERVICE, VN), "20:00");
    }

    #[test]
    fn parts_round_trip_back_to_the_instant() {
        assert_eq!(from_zoned_parts(to_zoned_parts(MID_SERVICE, MM), MM), MID_SERVICE);
    }

    /// The trap, and the analogue of futsal's late-UTC-Thursday-is-ICT-Friday
    /// case: the local day turns at 17:30 UTC, in the middle of the evening's
    /// UTC date.
    #[test]
    fn which_days_takings() {
        assert_eq!(zoned_date_key(MID_SERVICE, MM), "2026-09-18");
        assert_eq!(zoned_date_key(A_MINUTE_TO_MIDNIGHT, MM), "2026-09-18");
        assert_eq!(zoned_date_key(LOCAL_MIDNIGHT, MM), "2026-09-19");
        assert_eq!(zoned_date_key(FIVE_PAST_MIDNIGHT, MM), "2026-09-19");
        // What grouping by the UTC date would have said about that same sale —
        // the whole evening filed under the wrong day, every night.
        assert_eq!(zoned_date_key(FIVE_PAST_MIDNIGHT, 0), "2026-09-18");
    }

    #[test]
    fn the_day_opened_at_local_midnight() {
        assert_eq!(start_of_zoned_day(MID_SERVICE, MM), YESTERDAYS_MIDNIGHT);
        assert_eq!(start_of_zoned_day(FIVE_PAST_MIDNIGHT, MM), LOCAL_MIDNIGHT);
    }

    /// Month and year ends are the same arithmetic, and are where an off-by-one
    /// in a hand-rolled calendar shows up.
    #[test]
    fn the_calendar_carries() {
        assert_eq!(zoned_date_key(MONTH_END, MM), "2026-10-01");
        assert_eq!(zoned_date_key(YEAR_END, MM), "2027-01-01");
    }

    /// A negative offset has to work as well, since the var is signed and this
    /// side does the arithmetic in `i64` rather than in a `Date`.
    #[test]
    fn west_of_utc() {
        assert_eq!(zoned_date_key(WEST_OF_UTC, -300), "2026-09-17");
    }

    /// No twin in `logic.test.ts`: `Date.UTC` normalises an out-of-range day
    /// for free and the TypeScript has nothing to prove, whereas here it is a
    /// property of the four lines in `from_zoned_parts` and worth pinning.
    #[test]
    fn a_day_past_the_end_of_the_month_rolls_forward() {
        let overflowing = ZonedParts { year: 2026, month: 9, day: 31, hour: 0, minute: 0 };
        assert_eq!(
            to_zoned_parts(from_zoned_parts(overflowing, MM), MM),
            ZonedParts { year: 2026, month: 10, day: 1, hour: 0, minute: 0 }
        );
    }
}
