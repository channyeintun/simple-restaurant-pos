import { type TicketDoc, renderEscPos } from '../src/index.ts';

/**
 * The bytes a ticket turns into.
 *
 * This is the only part of the printing path that can be checked without a
 * printer, and it is the part where a mistake is silent: an escape sequence
 * with the wrong byte in it does not throw, it prints a `0` in the middle of a
 * dish name, and nobody finds out until a cook asks what "R0UND 3" means.
 *
 * What is *said* on the ticket is not tested here — that is `renderTicket` in
 * `shared/src/ticket.ts` and its Rust twin, both held to the same cases. This
 * is only about the layout and the control codes.
 *
 * Same harness as the other two suites: one `check` and a non-zero exit.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${a}\n        want ${e}`}`);
}

const doc = (over: Partial<TicketDoc> = {}): TicketDoc => ({
  kind: 'ticket',
  seq: 2,
  table: 'Table 4',
  time: '19:30',
  staff: 'Su',
  lines: [
    { qty: 2, name: 'Chicken curry', note: 'no chilli' },
    { qty: 1, name: 'Mohinga', note: null },
  ],
  ...over,
});

/**
 * The printable text, with the control sequences taken out.
 *
 * The exact sequences, listed, rather than a pattern like `/\x1b.[\x00-\xff]?/`
 * — which is what this started as and which is subtly wrong: the optional byte
 * is greedy, so stripping the two-byte `ESC @` also eats the first byte of
 * whatever follows it, and the assertions then fail for a reason that has
 * nothing to do with the renderer. ESC/POS is not a regular language and should
 * not be parsed as one.
 */
const CONTROLS = [
  '\x1b@',
  '\x1ba\x00',
  '\x1ba\x01',
  '\x1b!\x00',
  '\x1b!\x30',
  '\x1b!\x10',
  '\x1bE\x01',
  '\x1bE\x00',
  '\x1dV\x42\x03',
];

const text = (d: TicketDoc) =>
  CONTROLS.reduce((out, control) => out.split(control).join(''), renderEscPos(d));

// --- what ends up on the paper ----------------------------------------------

const plain = text(doc());
check('the table is on it', plain.includes('TABLE Table 4'), true);
check('the round number is on it', plain.includes('ROUND 2'), true);
check('the time and the waiter are on it', plain.includes('19:30  Waiter: Su'), true);
check('each line has its quantity at the margin', plain.includes(' 2  Chicken curry'), true);
check('a note is indented and marked', plain.includes('    * no chilli'), true);
check('a line with no note adds nothing', plain.includes(' 1  Mohinga\n'), true);

// Takeaway has no table, so the doc carries null and the agent supplies the
// only word it has for that.
check('takeaway prints its own word', text(doc({ table: null })).includes('TAKEAWAY'), true);
check('and not an empty table line', text(doc({ table: null })).includes('TABLE'), false);

// A void is the same slip with the header reversed: the kitchen is holding a
// piece of paper that says to cook this, and this one has to be unmistakably
// not that.
const voided = text(doc({ kind: 'void', lines: [{ qty: 1, name: 'Pork curry', note: null }] }));
check('a void says so first', voided.trimStart().startsWith('VOID'), true);
check('and still names the round, so the original can be found', voided.includes('ROUND 2'), true);

// --- the control codes ------------------------------------------------------
// Each of these is a sequence with no plausible alternative, and each is silent
// when wrong.

const raw = renderEscPos(doc());
check('it resets the printer first', raw.startsWith('\x1b@'), true);
check('it cuts the paper last', raw.endsWith('\x1dV\x42\x03'), true);
check('it feeds before the cut', raw.includes('\n\n\n\x1dV\x42\x03'), true);
check('the header is double width and height', raw.includes('\x1b!\x30'), true);
check('the order lines are double height', raw.includes('\x1b!\x10'), true);
check('it returns to the left margin for the lines', raw.includes('\x1ba\x00'), true);
check('every style is turned off again', raw.includes('\x1b!\x00'), true);
check('emphasis is balanced', raw.split('\x1bE\x01').length, raw.split('\x1bE\x00').length);

// Every byte has to survive `Buffer.from(…, 'binary')`, which keeps the low
// byte and drops the rest — so a control sequence must never contain a
// character above 0xff.
check(
  'no byte in the output is outside the binary range',
  [...raw].every((character) => character.charCodeAt(0) <= 0xff),
  true,
);

// --- wrapping ---------------------------------------------------------------
// A 60-character dish name is the schema's maximum and has to end up on the
// paper, indented under itself rather than starting again at the margin, where
// it would read as a second dish.

// `Z` rather than `a`, because the assertion counts characters and the rest of
// the slip — "Table 4", "Waiter: Su" — has its own.
const long = text(doc({ lines: [{ qty: 1, name: 'Z'.repeat(60), note: null }] }));
check('a long name wraps onto a continuation line', long.includes('\n    Z'), true);
check('and every character of it survives', long.replace(/[^Z]/g, '').length, 60);

// A name with no spaces in it cannot be broken politely and is broken anyway,
// because it still has to be printed.
const unbroken = text(doc({ lines: [{ qty: 3, name: 'x'.repeat(40), note: null }] }));
check('an unbreakable name is broken mid-word', unbroken.replace(/[^x]/g, '').length, 40);

// A ticket for a round whose every line was voided is still a piece of paper,
// and it still has to cut — a slip that never cuts jams the next one.
check('an empty ticket still cuts', renderEscPos(doc({ lines: [] })).endsWith('\x1dV\x42\x03'), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
