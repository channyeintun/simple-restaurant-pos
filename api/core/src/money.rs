//! Money helpers.
//!
//! Every amount in this app is an **integer in the currency's minor units** —
//! kyat for MMK, which has no circulating subunit, cents for a currency that
//! has one. There is no float anywhere in the path from a product's price to
//! the number on the bill, and introducing one is not a style violation, it is
//! a bug with a cash drawer attached.
//!
//! Ported from `shared/src/money.ts`, function for function, and held to the
//! same numbers: every case in `shared/test/logic.test.ts` is written out again
//! at the bottom of this file. The currency is a parameter on both sides for
//! that reason among others — see `config.rs`.
//!
//! ## What the port deliberately does not carry over
//!
//! Futsal's `split_equally` and `split_with_overrides` were a largest-remainder
//! allocation for dividing a pitch hire between players. This app settles a
//! check with one payment and split payments are out of scope, so they are
//! deleted rather than left in place against a day that may not come: dead code
//! in a money module is worse than absent code, because the next person to read
//! it has to work out whether the till uses it.
//!
//! `format_money` also has no rounding step where `formatMoney` opens with
//! `Math.round(minor)`. That call is there because a TypeScript `number` cannot
//! promise to be an integer; an `i64` can, so the guard has nothing left to
//! guard. The rule is the same on both sides — amounts are integers — and this
//! is the port being faithful to the rule rather than to the line.

use crate::config::Currency;

/// Group mark `.`, decimal mark `,`.
///
/// One pair, chosen once, used on both sides — the twin of the pair in
/// `money.ts`, and the pair matters more than which half of it you prefer: a
/// group mark and a decimal mark that are the same character make `1.500`
/// unreadable, and a POS that renders an amount the cashier cannot read aloud
/// to a customer has failed at its only job.
///
/// This pair is the one the restaurant's own currency wants — MMK has no
/// subunit, so every separator on a Myanmar price tag is a group mark, and
/// `12.500 Ks` is how the price is written on the menu. The decimal mark only
/// ever appears for a currency with `minor_digits > 0`, which this deployment
/// does not have; it is defined so that the function is total rather than
/// because anybody here will see it.
const GROUP_MARK: char = '.';
const DECIMAL_MARK: char = ',';

/// `12500` in MMK -> `"12.500 Ks"`; `1234567` in a 2-digit currency ->
/// `"12.345,67 $"`.
pub fn format_money(minor: i64, currency: &Currency) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    // `unsigned_abs` rather than `abs`, because `i64::MIN.abs()` panics. No
    // price is ever going to be `i64::MIN`, but a total is a sum of things and
    // this function is what renders whatever it was handed.
    let abs = minor.unsigned_abs();

    // `minor_digits == 0` is not an optimisation of the general branch, it is a
    // different rendering: there is no fractional part to write, and dividing
    // by a scale of 1 to prove it would only invite somebody to "simplify" the
    // two into one expression that emits a trailing separator.
    if currency.minor_digits == 0 {
        return format!("{sign}{} {}", grouped(abs), currency.symbol);
    }

    let scale = currency.scale() as u64;
    let whole = grouped(abs / scale);
    let width = currency.minor_digits.min(Currency::MAX_MINOR_DIGITS) as usize;
    let fraction = abs % scale;
    format!("{sign}{whole}{DECIMAL_MARK}{fraction:0width$} {}", currency.symbol)
}

/// Tolerant of what people actually type: `"12500"`, `"12,500"`, `"12 500"`,
/// `"12.500"`, `"12.5k"`. Answers `None` for anything it cannot read, which the
/// caller shows as a validation error rather than as a zero.
///
/// Two rules decide the ambiguous cases, and they are rules rather than
/// guesses:
///
///   1. A separator is a **group mark** unless it is the last one *and* exactly
///      `minor_digits` digits follow it. So `12,500` is twelve and a half
///      thousand in every currency, and `12.50` is twelve-fifty only where
///      there is such a thing as fifty of something.
///   2. Bare digits are **whole units**, never minor ones. `1250` typed into a
///      2-digit currency is one thousand two hundred and fifty, not twelve
///      fifty. Tills that do the opposite are the reason people mistrust tills.
///
/// For MMK both rules collapse to "strip the separators", which is the only
/// path this restaurant will ever take.
///
/// The TypeScript does the reading with three regular expressions. This does it
/// by hand, because the crate has no regex dependency and is not getting one
/// for four hundred bytes of character classification — but the shapes accepted
/// are exactly the originals', which is what the tests at the bottom are for.
/// Where the two genuinely differ is at the far end: `Number` answers with a
/// float and loses precision quietly on an absurd input, whereas every step
/// here is checked and an amount that will not fit an `i64` comes back `None`.
pub fn parse_money(input: &str, currency: &Currency) -> Option<i64> {
    let trimmed = input.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let scale = currency.scale();

    // `12k` is how a price gets said out loud, and typing it is faster than
    // counting zeroes. It is always whole units times a thousand. Anything
    // ending in `k` is either this or nothing: the digits-and-separators check
    // below would refuse the `k` anyway, so there is no fall-through to lose.
    if let Some(head) = trimmed.strip_suffix('k') {
        return shorthand(head.trim_end(), scale);
    }

    // Spaces are never anything but a group mark, so they go first and the rest
    // of the parse never has to think about them.
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    let mut rest = compact.chars();
    if !rest.next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    if !rest.all(|c| c.is_ascii_digit() || c == GROUP_MARK || c == DECIMAL_MARK) {
        return None;
    }

    if currency.minor_digits == 0 {
        return digits_of(&compact).parse::<i64>().ok();
    }

    // Everything left is ASCII, so the string can be cut by byte index. The
    // decimal mark, if there is one, can only be at one place: the check above
    // anchors the match to the *end* of the input, so a separator anywhere else
    // is a group mark no matter how many digits follow it.
    let bytes = compact.as_bytes();
    let point = bytes
        .len()
        .checked_sub(currency.minor_digits as usize + 1)
        .filter(|&at| bytes[at] == GROUP_MARK as u8 || bytes[at] == DECIMAL_MARK as u8)
        .filter(|&at| bytes[at + 1..].iter().all(u8::is_ascii_digit));

    let (whole, fraction) = match point {
        Some(at) => (&compact[..at], compact[at + 1..].parse::<i64>().ok()?),
        None => (compact.as_str(), 0),
    };
    let whole = digits_of(whole);
    if whole.is_empty() {
        return None;
    }
    whole.parse::<i64>().ok()?.checked_mul(scale)?.checked_add(fraction)
}

/// What a check comes to: every line's price times its quantity, added up.
///
/// This is the primitive the whole app totals with — the cart under the
/// waiter's product grid, the round that gets sent, the bill the cashier takes
/// money against — and it is four lines because it has to be exactly one
/// definition. Two places that each add up a check will eventually disagree by
/// a kyat, and the one that disagrees is always the one the customer is looking
/// at.
///
/// Integers in, integer out, no rounding step. The tests below carry the case
/// that would break under floats.
///
/// Voided lines are the caller's problem, not this function's: it adds up what
/// it is handed, and the queries that feed it filter on `voided_at IS NULL`.
pub fn sum_minor(lines: &[Line]) -> i64 {
    let mut total = 0;
    for line in lines {
        total += line.price_minor * line.qty;
    }
    total
}

/// One priced line on its way into a total.
///
/// `sumMinor` takes `{ priceMinor, qty }[]` and TypeScript's structural typing
/// means a cart line, an `items` row and a round's payload all satisfy it
/// as they stand. Rust has no such thing, so the shape is written out and the
/// callers convert — two integers, `Copy`, no allocation. The field names are
/// the column names minus their `_snapshot` suffix, because a cart line has a
/// live price and a sent item has a frozen one and this function is indifferent
/// to which it was handed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line {
    pub price_minor: i64,
    pub qty: i64,
}

impl Line {
    pub fn new(price_minor: i64, qty: i64) -> Self {
        Self { price_minor, qty }
    }
}

/// `12500` -> `"12.500"`. The thousands separator, inserted right to left.
fn grouped(value: u64) -> String {
    let text = value.to_string();
    if text.len() <= 3 {
        return text;
    }
    let mut out = String::with_capacity(text.len() + text.len() / 3);
    let width = text.len();
    for (i, c) in text.chars().enumerate() {
        if i > 0 && (width - i) % 3 == 0 {
            out.push(GROUP_MARK);
        }
        out.push(c);
    }
    out
}

/// The separators dropped, the digits kept — `compact.replace(/[.,]/g, '')`.
fn digits_of(text: &str) -> String {
    text.chars().filter(|c| *c != GROUP_MARK && *c != DECIMAL_MARK).collect()
}

/// `"12"` or `"12.5"` in front of a `k`: whole units, times a thousand, times
/// the currency's scale.
///
/// The original multiplies a `Number` and rounds it. This does the same
/// arithmetic in integers — `12.5k` is `(125 * 1000 * scale) / 10`, and the
/// rounding is half away from zero, the way `Math.round` rounds a positive
/// number — because the whole point of the module is that no amount is ever
/// carried in a float, and "only in the shorthand parser" is exactly how a
/// float gets into a money path.
fn shorthand(head: &str, scale: i64) -> Option<i64> {
    if head.is_empty() {
        return None;
    }

    let mut whole = String::new();
    let mut fraction = String::new();
    let mut seen_point = false;
    for c in head.chars() {
        if c == GROUP_MARK || c == DECIMAL_MARK {
            if seen_point {
                return None;
            }
            seen_point = true;
            continue;
        }
        if !c.is_ascii_digit() {
            return None;
        }
        if seen_point {
            fraction.push(c);
        } else {
            whole.push(c);
        }
    }
    // `\d+(?:[.,]\d+)?` — digits either side of the point, if there is a point.
    if whole.is_empty() || (seen_point && fraction.is_empty()) {
        return None;
    }

    let thousands = whole.parse::<i64>().ok()?.checked_mul(1_000)?.checked_mul(scale)?;
    if fraction.is_empty() {
        return Some(thousands);
    }
    let part = fraction.parse::<i64>().ok()?;
    let denominator = 10i64.checked_pow(fraction.len() as u32)?;
    let numerator = part.checked_mul(1_000)?.checked_mul(scale)?;
    let extra = (numerator.checked_mul(2)? + denominator) / (denominator * 2);
    thousands.checked_add(extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What this restaurant is configured with: MMK, `Ks`, no subunit.
    fn mmk() -> Currency {
        Currency::new("MMK", "Ks", 0)
    }

    /// Not configured anywhere, and present on purpose: with only a 0-digit
    /// currency in the suite, every `minor_digits` bug in `format_money` and
    /// `parse_money` would pass. This is the other branch.
    fn usd() -> Currency {
        Currency::new("USD", "$", 2)
    }

    /// MMK has no subunit, so a minor unit is a kyat and there is no decimal
    /// part. Groups of three, separated by `.`, then a space and the symbol.
    #[test]
    fn mmk_renders_as_whole_kyat() {
        assert_eq!(format_money(12_500, &mmk()), "12.500 Ks");
        assert_eq!(format_money(500, &mmk()), "500 Ks");
        assert_eq!(format_money(0, &mmk()), "0 Ks");
        assert_eq!(format_money(1_234_567, &mmk()), "1.234.567 Ks");
        assert_eq!(format_money(-2_500, &mmk()), "-2.500 Ks");
    }

    /// A 2-digit currency divides by 100 and pads the remainder, with `,` as
    /// the decimal mark so it can never be confused with the `.` between
    /// groups.
    #[test]
    fn a_subunit_currency_divides_and_pads() {
        assert_eq!(format_money(1_234_567, &usd()), "12.345,67 $");
        assert_eq!(format_money(100, &usd()), "1,00 $");
        assert_eq!(format_money(5, &usd()), "0,05 $");
        assert_eq!(format_money(0, &usd()), "0,00 $");
    }

    /// Everything a person might type for twelve and a half thousand kyat.
    #[test]
    fn parsing_what_people_type() {
        assert_eq!(parse_money("12500", &mmk()), Some(12_500));
        assert_eq!(parse_money("12,500", &mmk()), Some(12_500));
        assert_eq!(parse_money("12 500", &mmk()), Some(12_500));
        assert_eq!(parse_money("12.500", &mmk()), Some(12_500));
        assert_eq!(parse_money("12.5k", &mmk()), Some(12_500));
        assert_eq!(parse_money("12,5k", &mmk()), Some(12_500));
        assert_eq!(parse_money("12k", &mmk()), Some(12_000));
        assert_eq!(parse_money("  12500  ", &mmk()), Some(12_500));
        assert_eq!(parse_money("", &mmk()), None);
        assert_eq!(parse_money("twelve", &mmk()), None);
    }

    /// With a subunit, the last separator is a decimal mark only when exactly
    /// `minor_digits` digits follow it. Otherwise it is a group mark, so
    /// `12,500` still means twelve and a half thousand whole units.
    #[test]
    fn a_decimal_mark_is_the_last_separator_with_exactly_the_right_digits_after_it() {
        assert_eq!(parse_money("12.50", &usd()), Some(1_250));
        assert_eq!(parse_money("12,50", &usd()), Some(1_250));
        assert_eq!(parse_money("12,500", &usd()), Some(1_250_000));
        assert_eq!(parse_money("12500", &usd()), Some(1_250_000));
        assert_eq!(parse_money("12.5k", &usd()), Some(1_250_000));
    }

    #[test]
    fn a_check_is_the_sum_of_its_lines() {
        assert_eq!(sum_minor(&[]), 0);
        assert_eq!(sum_minor(&[Line::new(12_500, 3), Line::new(3_750, 1)]), 41_250);
        assert_eq!(sum_minor(&[Line::new(115, 7)]), 805);
        assert_eq!(sum_minor(&[Line::new(10, 1), Line::new(20, 1)]), 30);
    }

    /// The twin of the two cases in `logic.test.ts` that assert what floats
    /// would have done, and the only place in this crate where an `f64`
    /// appears at all.
    ///
    /// Seven of a line priced at 1.15 of some currency is 8.05 exactly; in
    /// binary floating point `1.15 * 7` is 8.049999999999999, and truncating
    /// that back to minor units loses a unit — a bill one cent short of the
    /// till, once in a while, for no visible reason. `i64` multiplication
    /// cannot do that, which is the argument for the whole module written as an
    /// assertion. Rust's `f64` is IEEE-754 binary64 and so is JavaScript's
    /// `number`, so both sides are wrong by exactly the same amount.
    #[test]
    fn the_same_sums_in_floats_are_short() {
        assert_eq!((1.15_f64 * 7.0 * 100.0).trunc() as i64, 804);
        assert_ne!(0.1_f64 + 0.2_f64, 0.3_f64);
    }
}
