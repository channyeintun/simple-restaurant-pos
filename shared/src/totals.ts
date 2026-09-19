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
  /**
   * How many of `qty` somebody has already settled.
   *
   * Zero until part of a table pays, which is every line on every check until
   * a cashier picks one. It is a *quantity* and not a flag because a waiter
   * tapping the same tile four times produces one line with `qty 4` — four
   * beers for four people is a single row, and it is the row a table is most
   * likely to want split.
   */
  qtyPaid: number;
  /** Set when the line was struck off. The row stays; the total stops counting it. */
  voidedAt: string | null;
}

/**
 * A quantity of a line somebody is settling right now: what the cashier picked.
 *
 * Its own type rather than a `CheckLine`, because the two are different facts.
 * A line carries how much of it is already paid; a pick carries how much of it
 * is being paid for in this transaction, and nothing else about it is relevant
 * to what the customer hands over.
 */
export interface PaidPick {
  priceMinorSnapshot: number;
  qty: number;
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
 *
 * This is the **gross** bill and it stays gross when part of a table has paid.
 * A receipt that dropped the dishes somebody already settled would be a receipt
 * for a meal nobody ate, so what is still owed is a separate question with a
 * separate function below, and every caller has to choose which one it meant.
 */
export function checkTotalMinor(lines: readonly CheckLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.voidedAt !== null) continue;
    total += lineTotalMinor(line.priceMinorSnapshot, line.qty);
  }
  return total;
}

/**
 * What is still owed on one line: the units nobody has paid for yet.
 *
 * Clamped at zero rather than trusted. `qtyPaid > qty` cannot be reached
 * through the API — the write guard refuses a settlement of more units than are
 * unpaid — so the clamp is for a hand-edited row and for the reader, who should
 * not have to prove the subtraction is safe before believing the sign of the
 * answer. A negative here would not fail loudly; it would quietly reduce the
 * rest of the bill.
 */
export function lineOutstandingMinor(
  priceMinor: number,
  qty: number,
  qtyPaid: number,
): number {
  const unpaid = qty - qtyPaid;
  return unpaid <= 0 ? 0 : lineTotalMinor(priceMinor, unpaid);
}

/**
 * What is still owed on the whole check.
 *
 * The number the cashier is handed cash against once anybody has settled part
 * of a table, and therefore the number the Worker charges. It is deliberately
 * not `checkTotalMinor` minus a sum of payments: that would be arithmetic over
 * the money table, which drifts the moment a line is voided after being paid
 * for, and it would make a refund look like an unpaid dish. This counts *units
 * of food nobody has paid for*, which is the thing a customer actually owes.
 *
 * A voided line owes nothing whether or not it was ever settled — see
 * {@link checkTotalMinor} for why it still shows on the bill.
 */
export function checkOutstandingMinor(lines: readonly CheckLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.voidedAt !== null) continue;
    total += lineOutstandingMinor(line.priceMinorSnapshot, line.qty, line.qtyPaid);
  }
  return total;
}

/**
 * What the units a cashier just picked come to.
 *
 * The amount on the button, and — computed again by the Worker from its own
 * copy of the prices — the amount actually charged. The two being the same
 * function with the same test cases is what lets the screen show a figure
 * before the request goes out without that figure being a second opinion.
 */
export function pickedTotalMinor(picks: readonly PaidPick[]): number {
  let total = 0;
  for (const pick of picks) {
    total += lineTotalMinor(pick.priceMinorSnapshot, pick.qty);
  }
  return total;
}
