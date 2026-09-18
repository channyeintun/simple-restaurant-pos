import { formatAmount, formatMoney, parseMoney, sumMinor } from '../src/money.ts';
import {
  formatClock,
  formatDateTime,
  fromZonedParts,
  startOfZonedDay,
  toZonedParts,
  zonedDateKey,
} from '../src/time.ts';
import type { Currency } from '../src/config.ts';

/**
 * The pure rules, in the browser's language.
 *
 * Every case here has a twin in `api/core/`'s `cargo test` — same inputs, same
 * expected value, written out rather than computed — because Rust cannot import
 * a TypeScript module and the only thing keeping the two implementations honest
 * is that they are held to the same numbers. A case added on one side and not
 * the other is how the bill and the till start to disagree.
 *
 * No test framework: one `check` and a non-zero exit. Bundled through esbuild
 * and run by node, which is what `npm test` does.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${a}\n        want ${e}`}`);
}

/** What this restaurant is configured with: MMK, `Ks`, no subunit. */
const MMK: Currency = { code: 'MMK', symbol: 'Ks', minorDigits: 0 };
/**
 * Not configured anywhere, and present on purpose: with only a 0-digit currency
 * in the suite, every `minorDigits` bug in `formatMoney` and `parseMoney` would
 * pass. This is the other branch.
 */
const USD: Currency = { code: 'USD', symbol: '$', minorDigits: 2 };

/** Myanmar is UTC+06:30. 390 minutes, and the half hour is why it is minutes. */
const MM = 390;
/** Vietnam, UTC+07:00 — used once, to prove the offset is really a parameter. */
const VN = 420;

// --- money: rendering ------------------------------------------------------
// MMK has no subunit, so a minor unit is a kyat and there is no decimal part.
// Groups of three, separated by `.`, then a space and the symbol.
check('MMK 12500 -> 12.500 Ks', formatMoney(12_500, MMK), '12.500 Ks');
check('MMK under a thousand is ungrouped', formatMoney(500, MMK), '500 Ks');
check('MMK zero', formatMoney(0, MMK), '0 Ks');
check('MMK groups every three digits', formatMoney(1_234_567, MMK), '1.234.567 Ks');
check('MMK negative keeps the sign in front', formatMoney(-2_500, MMK), '-2.500 Ks');

// A 2-digit currency divides by 100 and pads the remainder, with `,` as the
// decimal mark so it can never be confused with the `.` between groups.
check('2 digits: 1234567 -> 12.345,67 $', formatMoney(1_234_567, USD), '12.345,67 $');
check('2 digits: 100 is one whole unit', formatMoney(100, USD), '1,00 $');

// The same number without the symbol, which is what goes into the backoffice's
// price field. The round trips below are the point of it existing: whatever is
// rendered into that field has to come back out of `parseMoney` unchanged, or a
// manager who opens a product and presses Save has silently repriced it.
check('amount without the symbol', formatAmount(12_500, MMK), '12.500');
check('amount zero', formatAmount(0, MMK), '0');
check('2 digits: amount keeps its fraction', formatAmount(1_234_567, USD), '12.345,67');
check('MMK price round-trips through the editor', parseMoney(formatAmount(4_500, MMK), MMK), 4_500);
check(
  '2-digit price round-trips through the editor',
  parseMoney(formatAmount(1_234_567, USD), USD),
  1_234_567,
);
check('2 digits: 5 pads to 0,05', formatMoney(5, USD), '0,05 $');
check('2 digits: zero', formatMoney(0, USD), '0,00 $');

// --- money: parsing --------------------------------------------------------
// Everything a person might type for twelve and a half thousand kyat.
check('parse bare digits', parseMoney('12500', MMK), 12_500);
check('parse with commas', parseMoney('12,500', MMK), 12_500);
check('parse with spaces', parseMoney('12 500', MMK), 12_500);
check('parse with dots', parseMoney('12.500', MMK), 12_500);
check('parse k shorthand', parseMoney('12.5k', MMK), 12_500);
check('parse k shorthand with a comma', parseMoney('12,5k', MMK), 12_500);
check('parse whole k', parseMoney('12k', MMK), 12_000);
check('parse ignores surrounding space', parseMoney('  12500  ', MMK), 12_500);
check('parse rejects empty', parseMoney('', MMK), null);
check('parse rejects words', parseMoney('twelve', MMK), null);

// With a subunit, the last separator is a decimal mark only when exactly
// `minorDigits` digits follow it. Otherwise it is a group mark, so `12,500`
// still means twelve and a half thousand whole units.
check('2 digits: 12.50 is twelve fifty', parseMoney('12.50', USD), 1_250);
check('2 digits: 12,50 is twelve fifty too', parseMoney('12,50', USD), 1_250);
check('2 digits: 12,500 is twelve thousand five hundred', parseMoney('12,500', USD), 1_250_000);
check('2 digits: bare digits are whole units', parseMoney('12500', USD), 1_250_000);
check('2 digits: k shorthand scales too', parseMoney('12.5k', USD), 1_250_000);

// --- money: sumMinor, and why it is integers -------------------------------
check('empty check totals nothing', sumMinor([]), 0);
check(
  'three of one line plus one of another',
  sumMinor([
    { priceMinor: 12_500, qty: 3 },
    { priceMinor: 3_750, qty: 1 },
  ]),
  41_250,
);

// The case that would break under floats. Seven of a line priced at 1.15 of
// some currency is 8.05 exactly; in binary floating point `1.15 * 7` is
// 8.049999999999999, and truncating that back to minor units loses a unit —
// a bill one cent short of the till, once in a while, for no visible reason.
check('115 x 7 is exactly 805', sumMinor([{ priceMinor: 115, qty: 7 }]), 805);
check('the same sum in major units is short', Math.trunc(1.15 * 7 * 100), 804);

// The other classic, for the same reason.
check(
  '10 + 20 is exactly 30',
  sumMinor([
    { priceMinor: 10, qty: 1 },
    { priceMinor: 20, qty: 1 },
  ]),
  30,
);
check('0.1 + 0.2 is not 0.3', 0.1 + 0.2 === 0.3, false);

// --- time: the wall clock at +06:30 ---------------------------------------
// 13:00 UTC + 6h30 = 19:30 in Yangon, which is the middle of dinner service.
check('zoned parts at +06:30', toZonedParts('2026-09-18T13:00:00Z', MM), {
  year: 2026,
  month: 9,
  day: 18,
  hour: 19,
  minute: 30,
});
check('ticket clock', formatClock('2026-09-18T13:00:00Z', MM), '19:30');
check('receipt stamp', formatDateTime('2026-09-18T13:00:00Z', MM), '2026-09-18 19:30');
// The same instant at +07:00 is half an hour later on the clock. If the offset
// were ever stored as hours, this pair would be the same string.
check('the offset really is minutes', formatClock('2026-09-18T13:00:00Z', VN), '20:00');
check(
  'parts round-trip back to the instant',
  fromZonedParts(toZonedParts('2026-09-18T13:00:00Z', MM), MM).toISOString(),
  '2026-09-18T13:00:00.000Z',
);

// --- time: which day's takings ---------------------------------------------
// The trap, and the analogue of futsal's late-UTC-Thursday-is-ICT-Friday case:
// the local day turns at 17:30 UTC, in the middle of the evening's UTC date.
check('mid-service is today', zonedDateKey('2026-09-18T13:00:00Z', MM), '2026-09-18');
check(
  'a minute to local midnight is still today',
  zonedDateKey('2026-09-18T17:29:00Z', MM),
  '2026-09-18',
);
check('local midnight starts the next day', zonedDateKey('2026-09-18T17:30:00Z', MM), '2026-09-19');
check(
  "a sale rung up at 00:05 is tomorrow's takings",
  zonedDateKey('2026-09-18T17:35:00Z', MM),
  '2026-09-19',
);
// What grouping by the UTC date would have said about that same sale — the
// whole evening filed under the wrong day, every night.
check('and UTC would have got it wrong', zonedDateKey('2026-09-18T17:35:00Z', 0), '2026-09-18');

check(
  'the day opened at local midnight',
  startOfZonedDay('2026-09-18T13:00:00Z', MM).toISOString(),
  '2026-09-17T17:30:00.000Z',
);
check(
  'and the late sale belongs to the next one',
  startOfZonedDay('2026-09-18T17:35:00Z', MM).toISOString(),
  '2026-09-18T17:30:00.000Z',
);

// Month and year ends are the same arithmetic, and are where an off-by-one in
// a hand-rolled calendar shows up.
check('crosses a month end', zonedDateKey('2026-09-30T17:35:00Z', MM), '2026-10-01');
check('crosses a year end', zonedDateKey('2026-12-31T17:35:00Z', MM), '2027-01-01');
// A negative offset has to work as well, since the var is signed and the Rust
// twin does this arithmetic in i64.
check('west of UTC', zonedDateKey('2026-09-18T02:00:00Z', -300), '2026-09-17');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
