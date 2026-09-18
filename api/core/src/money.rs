//! Money helpers.
//!
//! All amounts are **integer Vietnamese dong**. VND has no circulating subunit,
//! so there are no fractional amounts anywhere in this app — never introduce a
//! float here. Splitting is done with a largest-remainder allocation so the
//! shares always sum back to the total exactly, with no dong drift.
//!
//! Ported from `shared/src/money.ts`, function for function.

/// Cash in Vietnam moves in 1,000d notes; default every split to that grain.
pub const DEFAULT_GRANULARITY: i64 = 1_000;

/// Split `total` across `count` people so that:
///   - every share is a multiple of `granularity` where possible,
///   - the shares differ by at most one granularity step,
///   - `sum(shares) == total`, exactly.
///
/// The extra dong land on the earliest registrants, which is deterministic and
/// therefore reproducible when the organizer re-settles a session.
pub fn split_equally(total: i64, count: i64, granularity: i64) -> Vec<i64> {
    if count <= 0 {
        return Vec::new();
    }
    if total <= 0 {
        return vec![0; count as usize];
    }

    let grain = granularity.max(1);
    let base = total / count / grain * grain;
    let mut shares = vec![base; count as usize];

    let mut remainder = total - base * count;
    let mut i = 0usize;
    while (i as i64) < count && remainder > 0 {
        let step = grain.min(remainder);
        shares[i] += step;
        remainder -= step;
        i += 1;
    }
    // Guaranteed unreachable (remainder < count * grain), but keeps the
    // invariant sum(shares) == total true even if grain/count change.
    if remainder > 0 {
        shares[0] += remainder;
    }

    shares
}

/// One payer's line in a split.
///
/// `heads` is how many people this payer is paying for: themselves plus any
/// guests they brought. The bill is divided by *heads on the pitch*, not by app
/// accounts, because the pitch was hired for bodies.
#[derive(Debug, Clone)]
pub struct SplitInput {
    pub id: String,
    /// Absolute amount fixed by the organizer for this person, if any.
    pub over: Option<i64>,
    pub heads: i64,
}

impl SplitInput {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into(), over: None, heads: 1 }
    }

    fn heads_of(&self) -> i64 {
        self.heads.max(1)
    }
}

/// Split a session's total charge across payers, honouring per-person overrides
/// and party sizes, answering in the order the payers were given.
///
/// Overridden people pay exactly what the organizer typed — for their whole
/// party — and whatever is left is divided among the remaining *heads*. If the
/// overrides already exceed the total, the remaining players owe nothing rather
/// than a negative amount.
///
/// ## Why this groups slices instead of multiplying
///
/// The tempting version computes one share and multiplies it by the head count.
/// That rounds twice and the parts stop summing to the total: money is either
/// invented or quietly lost. Instead the total is split into `heads` slices
/// *once* and each payer is handed a consecutive run of them. Grouping cannot
/// change a sum, so `sum(result) == total` holds by construction.
pub fn split_with_overrides(
    total: i64,
    payers: &[SplitInput],
    granularity: i64,
) -> Vec<(String, i64)> {
    let fixed_sum: i64 = payers.iter().filter_map(|p| p.over).map(|v| v.max(0)).sum();
    let remaining = (total - fixed_sum).max(0);
    let total_heads: i64 =
        payers.iter().filter(|p| p.over.is_none()).map(SplitInput::heads_of).sum();

    let slices = split_equally(remaining, total_heads, granularity);

    let mut out = Vec::with_capacity(payers.len());
    let mut cursor = 0usize;
    for p in payers {
        match p.over {
            Some(amount) => out.push((p.id.clone(), amount.max(0))),
            None => {
                let mut owed = 0;
                for _ in 0..p.heads_of() {
                    owed += slices.get(cursor).copied().unwrap_or(0);
                    cursor += 1;
                }
                out.push((p.id.clone(), owed));
            }
        }
    }
    out
}

/// Look one payer's share out of what `split_with_overrides` answered.
pub fn amount_for(owed: &[(String, i64)], id: &str) -> i64 {
    owed.iter().find(|(who, _)| who == id).map(|(_, amount)| *amount).unwrap_or(0)
}

/// `120000` -> `"120.000d"`. Vietnamese convention uses `.` as the group mark.
pub fn format_vnd(amount: i64) -> String {
    let sign = if amount < 0 { "-" } else { "" };
    format!("{sign}{}d", grouped(amount.unsigned_abs()))
}

fn grouped(n: u64) -> String {
    let text = n.to_string();
    if text.len() <= 3 {
        return text;
    }
    let mut out = String::with_capacity(text.len() + text.len() / 3);
    let width = text.len();
    for (i, c) in text.chars().enumerate() {
        if i > 0 && (width - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    out
}

/// Tolerant of what people actually type: "120k", "120.000", "120 000".
pub fn parse_vnd(input: &str) -> Option<i64> {
    let trimmed = input.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(head) = trimmed.strip_suffix('k') {
        return shorthand(head.trim());
    }

    let mut digits = String::new();
    for c in trimmed.chars() {
        if c == '.' || c == ',' || c.is_whitespace() {
            continue;
        }
        if !c.is_ascii_digit() {
            return None;
        }
        digits.push(c);
    }
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok()
}

/// `"120"` or `"1.5"` in front of a `k`, in thousands of dong.
fn shorthand(head: &str) -> Option<i64> {
    if head.is_empty() {
        return None;
    }
    let mut whole = String::new();
    let mut fraction = String::new();
    let mut seen_point = false;
    for c in head.chars() {
        if c == '.' || c == ',' {
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
    if whole.is_empty() || (seen_point && fraction.is_empty()) {
        return None;
    }

    let units = whole.parse::<i64>().ok()?;
    if fraction.is_empty() {
        return Some(units * 1_000);
    }
    let part = fraction.parse::<i64>().ok()?;
    let scale = 10i64.checked_pow(fraction.len() as u32)?;
    // Half away from zero, in integer arithmetic, the way `Math.round` rounds a
    // positive number.
    let extra = (part * 1_000 * 2 + scale) / (scale * 2);
    Some(units * 1_000 + extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_sum_to_the_total() {
        for total in [0, 1, 999, 1_000, 12_345, 333_333, 1_000_000] {
            for count in 1..=11 {
                for grain in [1, 500, 1_000, 5_000] {
                    let shares = split_equally(total, count, grain);
                    assert_eq!(shares.len(), count as usize);
                    assert_eq!(shares.iter().sum::<i64>(), total.max(0), "{total}/{count}/{grain}");
                }
            }
        }
    }

    #[test]
    fn the_earliest_registrants_carry_the_remainder() {
        assert_eq!(split_equally(100_000, 7, 1_000)[0], 15_000);
        assert_eq!(split_equally(100_000, 7, 1_000).iter().sum::<i64>(), 100_000);
    }

    #[test]
    fn a_party_is_a_run_of_slices_not_a_multiplication() {
        let payers = vec![
            SplitInput { id: "a".into(), over: None, heads: 3 },
            SplitInput::new("b"),
            SplitInput { id: "c".into(), over: None, heads: 2 },
        ];
        let owed = split_with_overrides(350_000, &payers, 1_000);
        assert_eq!(owed.iter().map(|(_, v)| *v).sum::<i64>(), 350_000);
    }

    #[test]
    fn overrides_beyond_the_total_leave_nothing_owing() {
        let payers = vec![
            SplitInput { id: "a".into(), over: Some(999_999), heads: 1 },
            SplitInput::new("b"),
        ];
        let owed = split_with_overrides(100_000, &payers, 1_000);
        assert_eq!(amount_for(&owed, "a"), 999_999);
        assert_eq!(amount_for(&owed, "b"), 0);
    }

    #[test]
    fn formatting_and_parsing() {
        assert_eq!(format_vnd(120_000), "120.000d");
        assert_eq!(format_vnd(-1_500), "-1.500d");
        assert_eq!(format_vnd(0), "0d");
        assert_eq!(parse_vnd("120k"), Some(120_000));
        assert_eq!(parse_vnd("1.5k"), Some(1_500));
        assert_eq!(parse_vnd("120.000"), Some(120_000));
        assert_eq!(parse_vnd("120 000"), Some(120_000));
        assert_eq!(parse_vnd("abc"), None);
        assert_eq!(parse_vnd(""), None);
    }
}
