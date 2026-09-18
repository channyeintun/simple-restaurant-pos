import type { Currency } from './config.js';

/**
 * Money helpers.
 *
 * Every amount in this app is an **integer in the currency's minor units** —
 * kyat for MMK, which has no circulating subunit, cents for a currency that
 * has one. There is no float anywhere in the path from a product's price to
 * the number on the bill, and introducing one is not a style violation, it is
 * a bug with a cash drawer attached.
 *
 * The currency is a parameter rather than a module constant. It comes from the
 * Worker's `vars` and reaches the client through `GET /auth/me` — see
 * `config.ts` for why there is only one copy of it — and passing it in is also
 * what lets the tests here and the twin tests in `api/core/src/money.rs`
 * exercise the same function the app calls, with the currency written out in
 * front of the reader.
 *
 * Splitting went with split payments: futsal's `splitEqually` and
 * `splitWithOverrides` were a largest-remainder allocation for dividing a
 * pitch hire between players, and this app settles a check with one payment.
 * They are deleted rather than left in place against a day that may not come —
 * dead code in a money module is worse than absent code, because the next
 * person to read it has to work out whether the till uses it.
 */

/**
 * Group mark `.`, decimal mark `,`.
 *
 * One pair, chosen once, used everywhere. The pair matters more than which
 * half of it you prefer: a group mark and a decimal mark that are the same
 * character make `1.500` unreadable, and a POS that renders an amount the
 * cashier cannot read aloud to a customer has failed at its only job.
 *
 * This pair is the one the restaurant's own currency wants — MMK has no
 * subunit, so every separator on a Myanmar price tag is a group mark, and
 * `12.500 Ks` is how the price is written on the menu. The decimal mark below
 * only ever appears for a currency with `minorDigits > 0`, which this
 * deployment does not have; it is defined so that the function is total rather
 * than because anybody here will see it.
 */
const GROUP_MARK = '.';
const DECIMAL_MARK = ',';

/** `12500` in MMK → `"12.500 Ks"`; `1234567` in a 2-digit currency → `"12.345,67 $"`. */
export function formatMoney(minor: number, currency: Currency): string {
  return `${formatAmount(minor, currency)} ${currency.symbol}`;
}

/**
 * The same number without the symbol: `12500` in MMK → `"12.500"`.
 *
 * It exists because of the one place in the app that renders a price *into an
 * editable field* — the backoffice's product editor — and that field has a
 * property nothing else does: whatever is put in it has to come back out of
 * {@link parseMoney} as the same integer. Formatting with the symbol and then
 * stripping it at the call site would work until the day a currency's symbol
 * contains a digit or a separator, and the day it does, a price edits itself
 * downwards and nobody notices until the bill.
 *
 * So the two renderings are one function with the symbol added by the other,
 * and the round trip is a test case rather than an assumption.
 */
export function formatAmount(minor: number, currency: Currency): string {
  const rounded = Math.round(minor);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);

  // `minorDigits === 0` is not an optimisation of the general branch, it is a
  // different rendering: there is no fractional part to write, and dividing by
  // a scale of 1 to prove it would only invite somebody to "simplify" the two
  // into one expression that emits a trailing separator.
  if (currency.minorDigits === 0) {
    return `${sign}${group(abs)}`;
  }

  const scale = 10 ** currency.minorDigits;
  const whole = Math.floor(abs / scale);
  const fraction = (abs % scale).toString().padStart(currency.minorDigits, '0');
  return `${sign}${group(whole)}${DECIMAL_MARK}${fraction}`;
}

/**
 * Tolerant of what people actually type: `"12500"`, `"12,500"`, `"12 500"`,
 * `"12.500"`, `"12.5k"`. Returns `null` for anything it cannot read, which the
 * caller shows as a validation error rather than as a zero.
 *
 * Two rules decide the ambiguous cases, and they are rules rather than
 * guesses:
 *
 *   1. A separator is a **group mark** unless it is the last one *and* exactly
 *      `minorDigits` digits follow it. So `12,500` is twelve and a half
 *      thousand in every currency, and `12.50` is twelve-fifty only where
 *      there is such a thing as fifty of something.
 *   2. Bare digits are **whole units**, never minor ones. `1250` typed into a
 *      2-digit currency is one thousand two hundred and fifty, not twelve
 *      fifty. Tills that do the opposite are the reason people mistrust tills.
 *
 * For MMK both rules collapse to "strip the separators", which is the only
 * path this restaurant will ever take.
 */
export function parseMoney(input: string, currency: Currency): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const scale = 10 ** currency.minorDigits;

  // `12k` is how a price gets said out loud, and typing it is faster than
  // counting zeroes. It is always whole units times a thousand.
  const shorthand = /^(\d+(?:[.,]\d+)?)\s*k$/.exec(trimmed);
  if (shorthand) return Math.round(Number(shorthand[1]!.replace(',', '.')) * 1_000 * scale);

  // Spaces are never anything but a group mark, so they go first and the rest
  // of the parse never has to think about them.
  const compact = trimmed.replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(compact)) return null;

  if (currency.minorDigits === 0) {
    const digits = compact.replace(/[.,]/g, '');
    return /^\d+$/.test(digits) ? Number(digits) : null;
  }

  const decimal = new RegExp(`^(.*)[.,](\\d{${currency.minorDigits}})$`).exec(compact);
  const wholeDigits = (decimal ? decimal[1]! : compact).replace(/[.,]/g, '');
  const fraction = (decimal ? decimal[2]! : '').padEnd(currency.minorDigits, '0');
  if (!/^\d+$/.test(wholeDigits)) return null;
  return Number(wholeDigits) * scale + Number(fraction);
}

/**
 * What a check comes to: every line's price times its quantity, added up.
 *
 * This is the primitive the whole app totals with — the cart under the waiter's
 * product grid, the round that gets sent, the bill the cashier takes money
 * against — and it is three lines because it has to be exactly one definition.
 * Two places that each add up a check will eventually disagree by a kyat, and
 * the one that disagrees is always the one the customer is looking at.
 *
 * Integers in, integer out, no rounding step. A float here would not break
 * loudly: it would agree with the till for weeks and then hand somebody a bill
 * one unit off, because `1.15 * 7` is `8.049999999999999` and truncating that
 * back to minor units loses a cent. Multiplying and summing integers cannot do
 * that. Keeping the values integers is the job of `minorSchema` at the API
 * boundary, not of a `Math.round` in here — rounding at the point of use would
 * hide the float that got in instead of refusing it.
 *
 * Voided lines are the caller's problem, not this function's: it adds up what
 * it is handed, and the queries that feed it filter on `voided_at IS NULL`.
 */
export function sumMinor(lines: readonly { priceMinor: number; qty: number }[]): number {
  let total = 0;
  for (const line of lines) total += line.priceMinor * line.qty;
  return total;
}

/** `12500` → `"12.500"`. The thousands separator, inserted right to left. */
function group(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_MARK);
}
