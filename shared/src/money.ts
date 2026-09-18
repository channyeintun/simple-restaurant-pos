/**
 * Money helpers.
 *
 * All amounts are **integer Vietnamese dong**. VND has no circulating subunit,
 * so there are no fractional amounts anywhere in this app — never introduce a
 * float here. Splitting is done with a largest-remainder allocation so the
 * shares always sum back to the total exactly, with no cent (dong) drift.
 */

/** Cash in Vietnam moves in 1,000d notes; default every split to that grain. */
export const DEFAULT_GRANULARITY = 1_000;

/**
 * Split `total` across `count` people so that:
 *   - every share is a multiple of `granularity` where possible,
 *   - the shares differ by at most one granularity step,
 *   - `sum(shares) === total`, exactly.
 *
 * The extra dong land on the earliest registrants, which is deterministic and
 * therefore reproducible when the organizer re-settles a session.
 */
export function splitEqually(
  total: number,
  count: number,
  granularity: number = DEFAULT_GRANULARITY,
): number[] {
  if (!Number.isFinite(total) || !Number.isFinite(count)) {
    throw new Error('splitEqually: total and count must be finite');
  }
  if (count <= 0) return [];
  if (total <= 0) return new Array(count).fill(0);

  const grain = Math.max(1, Math.floor(granularity));
  const cents = Math.round(total);

  const base = Math.floor(cents / count / grain) * grain;
  const shares: number[] = new Array(count).fill(base);

  let remainder = cents - base * count;
  for (let i = 0; i < count && remainder > 0; i++) {
    const step = Math.min(grain, remainder);
    shares[i] = (shares[i] ?? 0) + step;
    remainder -= step;
  }
  // Guaranteed unreachable (remainder < count * grain), but keeps the
  // invariant sum(shares) === total true even if grain/count change.
  if (remainder > 0) shares[0] = (shares[0] ?? 0) + remainder;

  return shares;
}

export interface SplitInput {
  /** Stable key per payer — a member id. */
  id: string;
  /** Absolute amount fixed by the organizer for this person, if any. */
  override?: number | null;
  /**
   * How many people this payer is paying for: themselves plus any guests they
   * brought. Defaults to 1.
   *
   * The bill is divided by *heads on the pitch*, not by app accounts, because
   * the pitch was hired for bodies. Somebody who brings two friends is three
   * heads and owes three shares.
   */
  heads?: number;
}

/**
 * Split a session's total charge across payers, honouring per-person overrides
 * and party sizes.
 *
 * Overridden people pay exactly what the organizer typed — for their whole
 * party, which is the natural reading of "Bao pays 200.000" — and whatever is
 * left is divided among the remaining *heads*. If the overrides already exceed
 * the total, the remaining players owe nothing rather than a negative amount.
 *
 * ## Why this groups slices instead of multiplying
 *
 * The tempting version computes one share and multiplies it by the head count.
 * That rounds twice — once to find the share, once per party — and the parts
 * stop summing to the total: money is either invented or quietly lost, and in
 * a group that settles up in cash somebody eventually notices they are a
 * thousand dong short every week.
 *
 * Instead the total is split into `heads` slices *once*, by the same
 * largest-remainder allocation as always, and each payer is handed a
 * consecutive run of them. Grouping cannot change a sum, so
 * `sum(result) === total` still holds exactly, by construction rather than by
 * a correction step.
 */
export function splitWithOverrides(
  total: number,
  payers: readonly SplitInput[],
  granularity: number = DEFAULT_GRANULARITY,
): Map<string, number> {
  const result = new Map<string, number>();

  const isFixed = (p: SplitInput) => typeof p.override === 'number' && p.override !== null;
  const fixed = payers.filter(isFixed);
  const flexible = payers.filter((p) => !isFixed(p));

  let fixedSum = 0;
  for (const p of fixed) {
    const amount = Math.max(0, Math.round(p.override as number));
    result.set(p.id, amount);
    fixedSum += amount;
  }

  const remaining = Math.max(0, Math.round(total) - fixedSum);
  const headsOf = (p: SplitInput) => Math.max(1, Math.floor(p.heads ?? 1));
  const totalHeads = flexible.reduce((sum, p) => sum + headsOf(p), 0);

  const slices = splitEqually(remaining, totalHeads, granularity);

  let cursor = 0;
  for (const p of flexible) {
    let owed = 0;
    for (let i = 0; i < headsOf(p); i++) owed += slices[cursor++] ?? 0;
    result.set(p.id, owed);
  }

  return result;
}

/** `120000` → `"120.000d"`. Vietnamese convention uses `.` as the group mark. */
export function formatVnd(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${digits}d`;
}

/** Tolerant of what people actually type: "120k", "120.000", "120 000". */
export function parseVnd(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const shorthand = /^(\d+(?:[.,]\d+)?)\s*k$/.exec(trimmed);
  if (shorthand) return Math.round(Number(shorthand[1]!.replace(',', '.')) * 1_000);

  const digits = trimmed.replace(/[.,\s]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}
