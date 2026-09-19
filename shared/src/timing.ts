/**
 * How long a round should take, how long it has taken, and when that stops
 * being acceptable.
 *
 * This is what lets a waiter answer the only question a customer ever asks
 * about an order that has already been placed. It is built from two facts and
 * no guesses: a per-product `prepMinutes` somebody typed in the backoffice, and
 * the moment the round was sent. **Nothing here is told to us by the kitchen** —
 * there is no kitchen screen and no cook touches any of it, which is why this
 * does not contradict the rule in `CLAUDE.md` about there being no
 * preparing/ready states. The one event software cannot observe, a plate
 * arriving at a table, is recorded by the person who carried it.
 *
 * ## What is twinned here and what is not
 *
 * {@link roundTargetMinutes} has a Rust twin in `api/core/src/timing.rs`, held
 * to the same cases, because both sides compute it: the Worker to put a target
 * on a check summary, the browser to draw a countdown.
 *
 * {@link roundTiming} does **not**, and that is deliberate rather than an
 * omission. It is a function of *now* — it changes every second and is
 * re-evaluated on a timer in a browser — and the Worker never renders it. A
 * Rust copy nothing called would be dead code in a crate whose whole discipline
 * is that it contains only rules somebody could be shown on paper. If the
 * Worker ever needs to decide lateness itself, that is when it gets a twin and
 * this comment gets deleted.
 */

/** The one field of a line this module reads. */
export interface TimedLine {
  /** What this dish was expected to take when the round was sent. */
  prepMinutesSnapshot: number;
}

/**
 * How long a round should take: the slowest thing on it.
 *
 * Max rather than sum, and not an average. A round is one trip to the table, so
 * it is finished when the *last* dish is — putting the drinks down twenty
 * minutes before the curry is a different round, or a different trip the
 * software does not model. Summing would say that three drinks take six
 * minutes, which no kitchen has ever done.
 *
 * Zero for a round with no lines. That cannot arrive through the API —
 * `sendRoundSchema` requires at least one item — and answering zero rather than
 * throwing means a hand-cleaned row renders as "due now" instead of taking a
 * screen down.
 */
export function roundTargetMinutes(lines: readonly TimedLine[]): number {
  let longest = 0;
  for (const line of lines) {
    if (line.prepMinutesSnapshot > longest) longest = line.prepMinutesSnapshot;
  }
  return longest;
}

/**
 * How long past its target a round has to be before it is *late* rather than
 * merely due.
 *
 * Five minutes, added rather than multiplied, and the difference matters at
 * both ends of a menu. A factor of 1.5 would call a two-minute drink late after
 * three minutes — which is barely time to pour it — while giving a forty-minute
 * roast twenty minutes of grace. Adding a flat five says the same thing about
 * every dish, which is the thing staff can actually hold in their heads: *five
 * minutes past what we told them*.
 */
export const LATE_GRACE_MINUTES = 5;

/**
 * Where a round stands.
 *
 * Four states and no more, because a waiter glancing at a grid is reading a
 * colour rather than a word: `cooking` is unremarkable, `due` means go and
 * look, `late` means somebody is waiting and knows it, and `delivered` is off
 * the list.
 */
export type RoundState = 'cooking' | 'due' | 'late' | 'delivered';

export interface RoundTiming {
  /** The slowest dish on the round, in minutes. */
  targetMinutes: number;
  /** Whole minutes since it was sent — or until it was delivered. */
  elapsedMinutes: number;
  /** `target - elapsed`. Negative once it is overdue, which is the point. */
  remainingMinutes: number;
  state: RoundState;
}

/**
 * Work out where a round stands, right now.
 *
 * `nowMs` is a parameter rather than read inside, for the usual reason a clock
 * is passed in: it makes this a pure function with test cases instead of
 * something that can only be observed. The caller passes the browser's clock,
 * which is the one place in this app that is right to do — every *stored* time
 * is the Worker's, and this is a duration on a screen rather than a fact in the
 * database.
 *
 * Elapsed is floored, and `remaining` is derived from the floored value rather
 * than computed separately, so the two can never disagree: `remaining` hits
 * zero in the same minute the state turns `due`. Rounding elapsed up instead
 * would have a round go late a minute early, which staff would learn to
 * distrust.
 *
 * A clock that runs backwards — a tablet syncing time, a round that arrives
 * stamped in the future — clamps to zero rather than reporting negative
 * elapsed. The alternative is a round that appears to have been sent in four
 * minutes' time.
 */
export function roundTiming(input: {
  sentAtMs: number;
  /** Null while it is still out. */
  deliveredAtMs: number | null;
  targetMinutes: number;
  nowMs: number;
}): RoundTiming {
  const until = input.deliveredAtMs ?? input.nowMs;
  const elapsedMinutes = Math.max(0, Math.floor((until - input.sentAtMs) / 60_000));
  const remainingMinutes = input.targetMinutes - elapsedMinutes;

  /*
   * Delivered wins over every other reading. A round that took forty minutes
   * and has been eaten is not "late" in any sense the waiter can act on — the
   * state is what to *do* about it, and there is nothing to do about a plate
   * already on the table. How long it took is still in `elapsedMinutes` for
   * anybody who wants to know.
   */
  const state: RoundState =
    input.deliveredAtMs !== null
      ? 'delivered'
      : elapsedMinutes >= input.targetMinutes + LATE_GRACE_MINUTES
        ? 'late'
        : elapsedMinutes >= input.targetMinutes
          ? 'due'
          : 'cooking';

  return { targetMinutes: input.targetMinutes, elapsedMinutes, remainingMinutes, state };
}
