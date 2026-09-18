/**
 * What a check comes to.
 *
 * One definition, written twice — here and in `api/core/src/totals.rs` — and
 * held to the same test cases, because Rust cannot import a TypeScript module
 * and both sides add up the same bill. The Worker's copy decides what the
 * customer is charged; this one decides what the cashier's screen says it is,
 * and the two disagreeing by a kyat is the failure this whole arrangement
 * exists to prevent.
 *
 * ## Why this is not a `SUM` in SQL
 *
 * Because a `SUM(price_minor_snapshot * qty)` in a query is a *third*
 * definition of the total, in a language neither twin is written in and with no
 * test case holding it to the other two. The queries filter — `voided_at IS
 * NULL` on a read that only wants live lines — and these functions add. That
 * split is the rule: SQL decides which rows, this decides what they come to.
 *
 * ## Why voiding is handled here rather than by the caller
 *
 * A voided line is still a row and still on the bill's paper trail; what it is
 * not is money owed. Leaving that to each caller means every screen that totals
 * a check has to remember, and the one that forgets charges a customer for a
 * dish that went back to the kitchen. So {@link checkTotalMinor} takes the
 * lines as they come out of the database — voided ones included — and skips
 * them itself.
 */

/** One line of a check, as the API sends it. A subset of `itemSchema`. */
export interface CheckLine {
  priceMinorSnapshot: number;
  qty: number;
  /** Set when the line was struck off. The row stays; the total stops counting it. */
  voidedAt: string | null;
}

/**
 * What one line comes to: the price that was snapshotted when the round was
 * sent, times how many.
 *
 * Integers in, integer out, and no rounding step — which is the point. A float
 * here would not break loudly: it would agree with the till for weeks and then
 * be a unit out, because `1.15 * 7` is `8.049999999999999` and truncating that
 * back to minor units loses a cent. Multiplying integers cannot do that.
 */
export function lineTotalMinor(priceMinor: number, qty: number): number {
  return priceMinor * qty;
}

/**
 * What the whole check comes to: every live line's total, added up.
 *
 * Voided lines contribute nothing and are not an error — a check whose every
 * line was struck off still gets paid, for zero, and closed, which is what
 * frees the table on the cashier's screen.
 */
export function checkTotalMinor(lines: readonly CheckLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.voidedAt !== null) continue;
    total += lineTotalMinor(line.priceMinorSnapshot, line.qty);
  }
  return total;
}
