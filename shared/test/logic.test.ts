import { formatAmount, formatMoney, parseMoney, sumMinor } from '../src/money.ts';
import {
  formatClock,
  formatDateTime,
  fromZonedParts,
  startOfZonedDay,
  toZonedParts,
  zonedDateKey,
} from '../src/time.ts';
import { checkTotalMinor, lineTotalMinor } from '../src/totals.ts';
import { renderTicket } from '../src/ticket.ts';
import { LATE_GRACE_MINUTES, roundTargetMinutes, roundTiming } from '../src/timing.ts';
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

// --- totals ----------------------------------------------------------------
// What a check comes to. Every case below has a named `#[test]` twin in
// `api/core/src/totals.rs` with the same inputs and the same expected value.

check('a line is its price times its quantity', lineTotalMinor(4_500, 1), 4_500);
check('three of a line', lineTotalMinor(4_500, 3), 13_500);
check('a free line', lineTotalMinor(0, 12), 0);
// The case that is the whole argument for integer minor units.
check('115 x 7 is exactly 805, not 804', lineTotalMinor(115, 7), 805);

const live = (priceMinorSnapshot: number, qty: number) => ({
  priceMinorSnapshot,
  qty,
  voidedAt: null,
});
const struck = (priceMinorSnapshot: number, qty: number) => ({
  priceMinorSnapshot,
  qty,
  voidedAt: '2026-09-18T13:00:00.000Z',
});

check('an empty check comes to nothing', checkTotalMinor([]), 0);
check(
  'a check is the sum of its live lines',
  checkTotalMinor([live(4_500, 3), live(2_500, 1), live(800, 2)]),
  17_600,
);
// A voided line is still a row on the bill's paper trail. What it is not is
// money owed.
check(
  'a voided line is not money owed',
  checkTotalMinor([live(4_500, 3), struck(2_500, 1), live(800, 2)]),
  15_100,
);
// Still paid, for zero, and closed — which is what frees the table.
check('a wholly voided check comes to zero', checkTotalMinor([struck(4_500, 3), struck(800, 2)]), 0);
// The schema's own maxima multiplied out: `minorSchema` stops at a billion and
// `qty` at 99. It has to be exact as a JavaScript number, or the twin's answer
// is only approximately the same.
check('the schema maxima multiply exactly', checkTotalMinor([live(1_000_000_000, 99)]), 99_000_000_000);
check('and are inside the exact-integer range', 99_000_000_000 < 2 ** 53, true);

// --- the kitchen ticket ----------------------------------------------------
// `2026-09-18T13:00:00Z` is 19:30 in Yangon — the same instant the clock cases
// above use, as the epoch stamp both twins take.
const AT_MS = 1_789_736_400_000;

const ticketInput = (
  kind: 'ticket' | 'void',
  seq: number,
  tableName: string | null,
  lines: { name: string; qty: number; note: string | null }[],
  atMs = AT_MS,
) => ({ kind, seq, tableName, staffName: 'Su', atMs, lines });

check(
  'a round ticket carries its number, table, time and lines',
  renderTicket(
    ticketInput('ticket', 2, 'Table 4', [
      { qty: 2, name: 'Chicken curry', note: null },
      { qty: 1, name: 'Mohinga', note: 'no chilli' },
    ]),
    MM,
  ),
  {
    kind: 'ticket',
    seq: 2,
    table: 'Table 4',
    time: '19:30',
    staff: 'Su',
    lines: [
      { qty: 2, name: 'Chicken curry', note: null },
      { qty: 1, name: 'Mohinga', note: 'no chilli' },
    ],
  },
);

// Takeaway has no table, and null is what the agent renders its own word for —
// the doc holds no prose, so it cannot hold "Takeaway".
check('takeaway has no table', renderTicket(ticketInput('ticket', 1, null, []), MM).table, null);
check(
  'a blank table name is takeaway too',
  renderTicket(ticketInput('ticket', 1, '   ', []), MM).table,
  null,
);

// A waiter who opened the note field and typed nothing has not said anything.
check(
  'empty and blank notes are no note, and a note is trimmed',
  renderTicket(
    ticketInput('ticket', 1, 'Table 1', [
      { qty: 1, name: 'Tea', note: '' },
      { qty: 1, name: 'Water', note: '   ' },
      { qty: 1, name: 'Rice', note: '  extra  ' },
    ]),
    MM,
  ).lines.map((line) => line.note),
  [null, null, 'extra'],
);

check(
  'a void names the round it undoes',
  renderTicket(ticketInput('void', 12, 'Table 4', [{ qty: 1, name: 'Pork curry', note: null }]), MM),
  {
    kind: 'void',
    seq: 12,
    table: 'Table 4',
    time: '19:30',
    staff: 'Su',
    lines: [{ qty: 1, name: 'Pork curry', note: null }],
  },
);

// The minute either side of local midnight, which a fixed offset gets wrong if
// it is applied in the wrong direction.
check(
  'a minute to local midnight',
  renderTicket(ticketInput('ticket', 1, null, [], 1_789_752_540_000), MM).time,
  '23:59',
);
check(
  'and local midnight itself',
  renderTicket(ticketInput('ticket', 1, null, [], 1_789_752_600_000), MM).time,
  '00:00',
);

// A 60-character name is the schema's maximum and is printed whole. Where the
// paper runs out is the agent's problem — it knows how many columns it has and
// this does not.
check(
  'a long name is not truncated',
  renderTicket(ticketInput('ticket', 1, 'Table 1', [{ qty: 1, name: 'a'.repeat(60), note: null }]), MM)
    .lines[0]!.name.length,
  60,
);

// --- how long a round should take ------------------------------------------
// `roundTargetMinutes` has a Rust twin in api/core/src/timing.rs and every case
// below is written out there with the same numbers.

const prep = (...minutes: number[]) => minutes.map((m) => ({ prepMinutesSnapshot: m }));

check("a round's target is its slowest dish", roundTargetMinutes(prep(2, 15, 5)), 15);
check('one dish is its own target', roundTargetMinutes(prep(15)), 15);
// Not a sum: three drinks take as long as one drink.
check('three drinks do not take three times as long', roundTargetMinutes(prep(2, 2, 2)), 2);
check('a round with no lines is due at once', roundTargetMinutes([]), 0);
check('a zero-minute dish does not lower the target', roundTargetMinutes(prep(0, 12)), 12);
check('a round of only zero-minute dishes', roundTargetMinutes(prep(0)), 0);

// --- where a round stands --------------------------------------------------
// TypeScript only, and `timing.ts` says why: this is a function of *now*, it is
// re-evaluated every second in a browser, and the Worker never renders it.

const SENT = 1_789_736_400_000; // 2026-09-18T13:00:00Z, the instant the other cases use.
const at = (minutesLater: number, deliveredAtMs: number | null = null) =>
  roundTiming({
    sentAtMs: SENT,
    deliveredAtMs,
    targetMinutes: 15,
    nowMs: SENT + minutesLater * 60_000,
  });

check('just sent', at(0).state, 'cooking');
check('and the whole target is still to run', at(0).remainingMinutes, 15);
check('halfway', at(7).state, 'cooking');
check('and it says how long is left', at(7).remainingMinutes, 8);
// `due` at the target exactly, and `remaining` hits zero in the same minute —
// they are derived from one floored value so they cannot disagree.
check('due on the minute it was promised', at(15).state, 'due');
check('with nothing left to run', at(15).remainingMinutes, 0);
check('still only due four minutes past', at(19).state, 'due');
check('and says how far overdue', at(19).remainingMinutes, -4);
// Five minutes of grace, added rather than multiplied — the same five whether
// the dish takes two minutes or forty.
check('late five minutes past', at(20).state, 'late');
check('the grace is five minutes', LATE_GRACE_MINUTES, 5);

// A fast dish gets the same five minutes, which a 1.5x factor would not give
// it: a two-minute drink would be "late" after three.
const drink = (minutesLater: number) =>
  roundTiming({ sentAtMs: SENT, deliveredAtMs: null, targetMinutes: 2, nowMs: SENT + minutesLater * 60_000 });
check('a drink is due at two minutes', drink(2).state, 'due');
check('and not late until seven', drink(6).state, 'due');
check('late at seven', drink(7).state, 'late');

// Delivered wins over every other reading: there is nothing to *do* about a
// plate already on the table, however long it took to get there.
check('a delivered round is delivered, not late', at(40, SENT + 40 * 60_000).state, 'delivered');
check('and still records how long it took', at(40, SENT + 40 * 60_000).elapsedMinutes, 40);
check('delivered early is delivered too', at(3, SENT + 3 * 60_000).state, 'delivered');

// A tablet syncing its clock, or a round stamped in the future: clamp rather
// than report that something was sent in four minutes' time.
check('a backwards clock clamps to zero', at(-4).elapsedMinutes, 0);
check('and is still cooking', at(-4).state, 'cooking');

// Seconds are floored, so a round is not late a minute early.
check(
  'fifty-nine seconds is still zero minutes',
  roundTiming({ sentAtMs: SENT, deliveredAtMs: null, targetMinutes: 15, nowMs: SENT + 59_000 })
    .elapsedMinutes,
  0,
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
