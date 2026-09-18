//! Time helpers pinned to Asia/Ho_Chi_Minh (ICT).
//!
//! Ported from `shared/src/time.ts`. Vietnam has been on a fixed UTC+7 with no
//! daylight saving since 1975, so the offset arithmetic is exact and needs no tz
//! database. Everything crossing the API boundary is an ISO-8601 UTC instant,
//! carried here as milliseconds since the epoch.
//!
//! The civil-date conversion is written out rather than taken from a date crate
//! because `from_zoned_parts` is called with a day number past the end of its
//! month — `next_weekday` adds a delta to the day and lets the date normalise,
//! exactly as `Date.UTC` does — and that behaviour has to be reproduced, not
//! assumed.

pub const TZ: &str = "Asia/Ho_Chi_Minh";
/// Fixed ICT offset. Vietnam has observed no DST since 1975.
pub const TZ_OFFSET_MINUTES: i64 = 7 * 60;

/// Default kickoff: Friday 19:30 ICT, counting Sunday as 0.
pub const DEFAULT_KICKOFF_WEEKDAY: i64 = 5;
pub const DEFAULT_KICKOFF_HOUR: i64 = 19;
pub const DEFAULT_KICKOFF_MINUTE: i64 = 30;

/// How long after kickoff a session counts as finished. The cron uses it to mark
/// sessions completed, the team board uses it to stop being a live control and
/// start being a record, and registration closes on it too — one definition, so
/// the three cannot disagree.
pub const SESSION_RUNS_FOR_MS: i64 = 2 * 60 * 60 * 1000;

/// Whether somebody can still put their name down for this session.
///
/// The window used to end at kickoff, which is the one moment it is most wrong:
/// nobody is on their phone at 19:29, and a player who walks on at 19:35 was
/// unregistered for a game they played all of — off the roster, out of the
/// draw, and out of the split, so everybody else covered their share.
///
/// So it runs for as long as the game does. `SESSION_RUNS_FOR_MS` is the same
/// window the cron calls a session finished at and the team board stops being a
/// control at, which is what lets a latecomer be signed up and then dealt onto
/// the smallest side while the game is still on.
///
/// It is not open forever, and that is the other half of the rule: a session
/// that has been played is a record. Signing up for one weeks later would add a
/// name to a roster nobody can check and a head to a bill already split. The
/// status carries the same answer from the other direction — a cancelled game
/// has nothing to join, and settling marks a session completed.
pub fn registration_open(starts_at_ms: i64, status: &str, now_ms: i64) -> bool {
    status == "scheduled" && now_ms < starts_at_ms + SESSION_RUNS_FOR_MS
}

const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

/// A wall-clock reading in Asia/Ho_Chi_Minh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZonedParts {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    /// 0 = Sunday … 6 = Saturday
    pub weekday: i64,
}

/// Break a UTC instant into its Asia/Ho_Chi_Minh wall-clock parts.
pub fn to_zoned_parts(instant_ms: i64) -> ZonedParts {
    let shifted = instant_ms + TZ_OFFSET_MINUTES * MS_PER_MINUTE;
    let days = shifted.div_euclid(MS_PER_DAY);
    let rest = shifted.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    ZonedParts {
        year,
        month,
        day,
        hour: rest / MS_PER_HOUR,
        minute: (rest % MS_PER_HOUR) / MS_PER_MINUTE,
        weekday: (days + 4).rem_euclid(7),
    }
}

/// Interpret the given wall-clock parts as ICT and return the UTC instant.
///
/// `day` may run past the end of its month, and the date rolls forward the way
/// `Date.UTC` rolls it. That is what `next_weekday` relies on.
pub fn from_zoned_parts(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> i64 {
    let days = days_from_civil(year, month, 1) + (day - 1);
    days * MS_PER_DAY + hour * MS_PER_HOUR + minute * MS_PER_MINUTE
        - TZ_OFFSET_MINUTES * MS_PER_MINUTE
}

/// The next kickoff strictly after `from`.
///
/// If today is the target weekday but kickoff has already passed, this rolls to
/// next week — which is what the cron wants when it runs the morning after a
/// session.
pub fn next_weekday(from_ms: i64, weekday: i64, hour: i64, minute: i64) -> i64 {
    let local = to_zoned_parts(from_ms);
    let mut delta_days = (weekday - local.weekday).rem_euclid(7);
    let mut candidate =
        from_zoned_parts(local.year, local.month, local.day + delta_days, hour, minute);
    if candidate <= from_ms {
        delta_days += 7;
        candidate = from_zoned_parts(local.year, local.month, local.day + delta_days, hour, minute);
    }
    candidate
}

/// The upcoming Friday 19:30 ICT.
pub fn next_friday_kickoff(from_ms: i64) -> i64 {
    next_weekday(from_ms, DEFAULT_KICKOFF_WEEKDAY, DEFAULT_KICKOFF_HOUR, DEFAULT_KICKOFF_MINUTE)
}

/// `YYYY-MM-DD` of the instant, in ICT. Used to dedupe "one session per day".
pub fn zoned_date_key(instant_ms: i64) -> String {
    let p = to_zoned_parts(instant_ms);
    format!("{}-{:02}-{:02}", p.year, p.month, p.day)
}

/// Midnight ICT that opened the day containing `instant`, as a UTC instant.
///
/// This is where home draws the line between the fixture at the top and the
/// "previously" list underneath. It stops being today's game when today ends.
pub fn start_of_zoned_day(instant_ms: i64) -> i64 {
    let p = to_zoned_parts(instant_ms);
    from_zoned_parts(p.year, p.month, p.day, 0, 0)
}

/// The clock, in whichever style the reader has asked for.
///
/// AM/PM stays in Latin in both locales. No leading zero on a 12-hour clock:
/// "07:30 PM" is a digital-watch reading, not something anybody says.
pub fn clock_time(hour: i64, minute: i64, hour12: bool) -> String {
    if !hour12 {
        return format!("{hour:02}:{minute:02}");
    }
    let suffix = if hour < 12 { "AM" } else { "PM" };
    let h = if hour % 12 == 0 { 12 } else { hour % 12 };
    format!("{h}:{minute:02} {suffix}")
}

/// Weekday and month names per locale.
///
/// Hardcoded rather than left to a locale service: the Worker and the browser
/// must produce identical strings — a push notification and the screen it links
/// to should not disagree.
const WEEKDAYS_EN: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_MY: [&str; 7] = [
    "တနင်္ဂနွေ", "တနင်္လာ", "အင်္ဂါ", "ဗုဒ္ဓဟူး", "ကြာသပတေး", "သောကြာ", "စနေ",
];
const MONTHS_EN: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_MY: [&str; 12] = [
    "ဇန်နဝါရီ", "ဖေဖော်ဝါရီ", "မတ်", "ဧပြီ", "မေ", "ဇွန်",
    "ဇူလိုင်", "ဩဂုတ်", "စက်တင်ဘာ", "အောက်တိုဘာ", "နိုဝင်ဘာ", "ဒီဇင်ဘာ",
];

fn weekday_name(locale: &str, weekday: i64) -> &'static str {
    let table = if locale == "my" { &WEEKDAYS_MY } else { &WEEKDAYS_EN };
    table.get(weekday as usize).copied().unwrap_or("")
}

fn month_name(locale: &str, month: i64) -> &'static str {
    let table = if locale == "my" { &MONTHS_MY } else { &MONTHS_EN };
    table.get((month - 1) as usize).copied().unwrap_or("")
}

/// e.g. "Fri 08 Aug, 19:30" / "သောကြာ 08 ဩဂုတ်၊ 7:30 PM".
pub fn format_kickoff(instant_ms: i64, locale: &str, hour12: bool) -> String {
    let p = to_zoned_parts(instant_ms);
    let day =
        format!("{} {:02} {}", weekday_name(locale, p.weekday), p.day, month_name(locale, p.month));
    let at = clock_time(p.hour, p.minute, hour12);
    // Burmese uses its own comma (U+104A); an ASCII one reads as a typo.
    if locale == "my" {
        format!("{day}၊ {at}")
    } else {
        format!("{day}, {at}")
    }
}

/// e.g. "19:30" or "7:30 PM" in ICT.
pub fn format_time(instant_ms: i64, hour12: bool) -> String {
    let p = to_zoned_parts(instant_ms);
    clock_time(p.hour, p.minute, hour12)
}

/// e.g. "08 Aug 2026" in ICT.
pub fn format_date(instant_ms: i64, locale: &str) -> String {
    let p = to_zoned_parts(instant_ms);
    format!("{:02} {} {}", p.day, month_name(locale, p.month), p.year)
}

/// Value for an `<input type="datetime-local">`, in ICT wall-clock.
pub fn to_datetime_local(instant_ms: i64) -> String {
    let p = to_zoned_parts(instant_ms);
    format!("{}-{:02}-{:02}T{:02}:{:02}", p.year, p.month, p.day, p.hour, p.minute)
}

/// Inverse of `to_datetime_local`: reads a local-time string as ICT.
pub fn from_datetime_local(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    let field = |from: usize, to: usize| -> Option<i64> {
        let text = value.get(from..to)?;
        if !text.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        text.parse::<i64>().ok()
    };
    Some(from_zoned_parts(
        field(0, 4)?,
        field(5, 7)?,
        field(8, 10)?,
        field(11, 13)?,
        field(14, 16)?,
    ))
}

/// Short human delta, e.g. "in 2d 3h" / "3d 2h အကြာ".
pub fn relative_to_now(instant_ms: i64, now_ms: i64, locale: &str) -> String {
    let diff = instant_ms - now_ms;
    let future = diff >= 0;
    let span = diff.abs();

    let days = span / MS_PER_DAY;
    let hours = (span % MS_PER_DAY) / MS_PER_HOUR;
    let minutes = (span % MS_PER_HOUR) / MS_PER_MINUTE;

    let (d, h, m) = if locale == "my" {
        (" ရက်", " နာရီ", " မိနစ်")
    } else {
        ("d", "h", "m")
    };

    let value = if days > 0 {
        let tail = if hours > 0 { format!(" {hours}{h}") } else { String::new() };
        format!("{days}{d}{tail}")
    } else if hours > 0 {
        let tail = if minutes > 0 { format!(" {minutes}{m}") } else { String::new() };
        format!("{hours}{h}{tail}")
    } else {
        format!("{}{m}", minutes.max(1))
    };

    // Burmese puts the relation after the amount in both directions, so the
    // English "in X" prefix has no equivalent to mirror.
    match (locale == "my", future) {
        (true, true) => format!("{value} အကြာ"),
        (true, false) => format!("{value} က"),
        (false, true) => format!("in {value}"),
        (false, false) => format!("{value} ago"),
    }
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

    #[test]
    fn a_known_kickoff() {
        // 2025-08-08T12:30:00Z is Friday 19:30 in Ho Chi Minh City.
        let p = to_zoned_parts(1_754_656_200_000);
        assert_eq!(
            p,
            ZonedParts { year: 2025, month: 8, day: 8, hour: 19, minute: 30, weekday: 5 }
        );
        assert_eq!(zoned_date_key(1_754_656_200_000), "2025-08-08");
    }

    #[test]
    fn the_round_trip_lands_where_it_started() {
        let mut ms = -2_000_000_000_000i64;
        while ms < 2_000_000_000_000 {
            let p = to_zoned_parts(ms);
            let back = from_zoned_parts(p.year, p.month, p.day, p.hour, p.minute);
            assert_eq!(back, ms - ms.rem_euclid(MS_PER_MINUTE), "at {ms}");
            ms += 37 * MS_PER_HOUR;
        }
    }

    #[test]
    fn a_kickoff_that_has_passed_rolls_to_next_week() {
        let kickoff = 1_754_656_200_000;
        assert_eq!(next_friday_kickoff(kickoff - 1), kickoff);
        assert_eq!(next_friday_kickoff(kickoff), kickoff + 7 * MS_PER_DAY);
    }

    #[test]
    fn the_clock_reads_both_ways() {
        assert_eq!(clock_time(19, 30, false), "19:30");
        assert_eq!(clock_time(19, 30, true), "7:30 PM");
        assert_eq!(clock_time(0, 5, true), "12:05 AM");
        assert_eq!(clock_time(12, 0, true), "12:00 PM");
    }

    #[test]
    fn registration_runs_through_the_game_and_stops_there() {
        let kickoff = 1_754_656_200_000; // Fri 19:30 ICT.

        assert!(registration_open(kickoff, "scheduled", kickoff - MS_PER_DAY));
        // The case this rule exists for: 19:30 on the dot, and ten minutes in.
        assert!(registration_open(kickoff, "scheduled", kickoff));
        assert!(registration_open(kickoff, "scheduled", kickoff + 10 * MS_PER_MINUTE));
        assert!(registration_open(kickoff, "scheduled", kickoff + SESSION_RUNS_FOR_MS - 1));

        // Everybody has gone home; from here the fixture is a record.
        assert!(!registration_open(kickoff, "scheduled", kickoff + SESSION_RUNS_FOR_MS));
        assert!(!registration_open(kickoff, "scheduled", kickoff + 7 * MS_PER_DAY));

        // Status closes it from the other side, whatever the clock says.
        assert!(!registration_open(kickoff, "cancelled", kickoff - MS_PER_DAY));
        assert!(!registration_open(kickoff, "completed", kickoff + MS_PER_MINUTE));
    }

    #[test]
    fn datetime_local_round_trips() {
        let ms = 1_754_656_200_000;
        assert_eq!(to_datetime_local(ms), "2025-08-08T19:30");
        assert_eq!(from_datetime_local("2025-08-08T19:30"), Some(ms));
        assert_eq!(from_datetime_local("nonsense"), None);
    }
}
