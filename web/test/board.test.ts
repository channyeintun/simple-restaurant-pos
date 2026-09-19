import type { CheckSummary, RealtimeEvent } from '@pos/shared';
import { applyBoardEvent, boardNeedsRefetch } from '../src/lib/board.ts';

/**
 * The cashier's board reducer.
 *
 * These exist because of a property of this app that would otherwise make them
 * the least-exercised code in it: local development runs with **no Upstash
 * credentials** — `CLAUDE.md` requires `wrangler dev` to work with no cloud
 * resources at all — so the realtime stream never fires on a developer's
 * machine and every one of these cases would first be tried on a Saturday
 * night, in a dining room, by a cashier.
 *
 * Same harness as `shared/test/logic.test.ts`: one `check` and a non-zero exit,
 * bundled through esbuild and run by node. No framework, no DOM, no server.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${a}\n        want ${e}`}`);
}

/** The floor this restaurant has, as the cashier page would supply it. */
const tables: Record<string, string> = { tbl_4: 'Table 4', tbl_7: 'Table 7' };
const tableNameFor = (id: string | null) => (id === null ? null : (tables[id] ?? null));

/**
 * A card on the board.
 *
 * `outstandingMinor` defaults to whatever `totalMinor` ends up being, because
 * that is what it *is* on every check nobody has split — which is every case in
 * this file except the two that say otherwise. Defaulting it keeps those cases
 * about the thing they are testing instead of repeating a figure twice.
 */
const card = (over: Partial<CheckSummary> = {}): CheckSummary => {
  const base: CheckSummary = {
    id: 'chk_1',
    tableId: 'tbl_4',
    tableName: 'Table 4',
    openedByName: 'Su',
    openedAt: '2026-09-18T13:00:00.000Z',
    roundCount: 1,
    outstandingRounds: 1,
    oldestOutstandingAt: '2026-09-18T13:00:00.000Z',
    oldestOutstandingTargetMinutes: 15,
    totalMinor: 11_400,
    outstandingMinor: 11_400,
    ...over,
  };
  return { ...base, outstandingMinor: over.outstandingMinor ?? base.totalMinor };
};

const partPaid = (
  checkId: string,
  amountMinor: number,
  totalMinor: number,
  outstandingMinor: number,
): RealtimeEvent => ({
  name: 'check.part_paid',
  channel: 'restaurant',
  data: {
    checkId,
    tableId: 'tbl_4',
    method: 'cash',
    amountMinor,
    totalMinor,
    outstandingMinor,
    at: '2026-09-18T13:20:00.000Z',
  },
});

const opened = (checkId: string, tableId: string | null): RealtimeEvent => ({
  name: 'check.opened',
  channel: 'restaurant',
  data: { checkId, tableId, staffName: 'Su', at: '2026-09-18T13:00:00.000Z' },
});

const line = (prepMinutesSnapshot: number) => ({
  id: 'itm_1',
  roundId: 'rnd_1',
  productId: 'prd_1',
  nameSnapshot: 'Chicken curry',
  priceMinorSnapshot: 4_500,
  prepMinutesSnapshot,
  qty: 1,
  note: null,
  voidedAt: null,
  voidedBy: null,
});

const sent = (
  checkId: string,
  seq: number,
  total: number,
  prepMinutes: number[] = [15],
): RealtimeEvent => ({
  name: 'round.sent',
  channel: 'restaurant',
  data: {
    checkId,
    roundId: `rnd_${seq}`,
    seq,
    items: prepMinutes.map(line),
    checkTotal: total,
    at: '2026-09-18T13:05:00.000Z',
  },
});

const delivered = (
  checkId: string,
  outstandingRounds: number,
  oldestOutstandingAt: string | null,
  oldestOutstandingTargetMinutes = 0,
): RealtimeEvent => ({
  name: 'round.delivered',
  channel: 'restaurant',
  data: {
    checkId,
    roundId: 'rnd_1',
    at: '2026-09-18T13:20:00.000Z',
    outstandingRounds,
    oldestOutstandingAt,
    oldestOutstandingTargetMinutes,
  },
});

const voided = (checkId: string, total: number): RealtimeEvent => ({
  name: 'item.voided',
  channel: 'restaurant',
  data: { checkId, itemId: 'itm_1', checkTotal: total, at: '2026-09-18T13:06:00.000Z' },
});

const paid = (checkId: string, tableId: string | null): RealtimeEvent => ({
  name: 'check.paid',
  channel: 'restaurant',
  data: { checkId, tableId, method: 'cash', at: '2026-09-18T13:30:00.000Z' },
});

const printed: RealtimeEvent = {
  name: 'print_job.printed',
  channel: 'restaurant',
  data: { jobId: 'job_1', roundId: 'rnd_1', at: '2026-09-18T13:05:02.000Z' },
};

// --- a check opening ---------------------------------------------------------
// The card appears at zero and the `round.sent` a beat later fills it in, which
// is what the cashier sees: the table lights up as the waiter presses Send.

check(
  'an opened check lands on the board at zero',
  applyBoardEvent([], opened('chk_1', 'tbl_4'), tableNameFor),
  [
    card({
      roundCount: 0,
      totalMinor: 0,
      outstandingRounds: 0,
      oldestOutstandingAt: null,
      oldestOutstandingTargetMinutes: 0,
    }),
  ],
);

// The event carries the table's id, not its name — the catalogue is six events
// with fixed payloads — so the name is resolved from the list the page holds.
check(
  'takeaway opens with no table name',
  applyBoardEvent([], opened('chk_2', null), tableNameFor).map((c) => c.tableName),
  [null],
);
check(
  'a table this client has never heard of resolves to nothing',
  applyBoardEvent([], opened('chk_3', 'tbl_99'), tableNameFor).map((c) => c.tableName),
  [null],
);

// A replayed event on reconnect must not double the card.
check(
  'opening a check already on the board changes nothing',
  applyBoardEvent([card()], opened('chk_1', 'tbl_4'), tableNameFor),
  [card()],
);

// --- rounds and voids --------------------------------------------------------
// The total travels with the event and is the Worker's own, computed with the
// twin of the arithmetic this client would use. It is adopted, never recomputed.

check(
  'a sent round adopts the total the Worker sent',
  applyBoardEvent([card({ roundCount: 1, totalMinor: 11_400 })], sent('chk_1', 2, 13_900), tableNameFor),
  [card({ roundCount: 2, totalMinor: 13_900, outstandingRounds: 2 })],
);

// A check with something already out does not restart its clock because a
// second round was sent — the oldest one is still the oldest.
check(
  'a second round leaves the oldest clock alone',
  applyBoardEvent([card()], sent('chk_1', 2, 13_900), tableNameFor).map((c) => c.oldestOutstandingAt),
  ['2026-09-18T13:00:00.000Z'],
);

// But a check with nothing out starts its clock on this round, and takes the
// target from the round's own lines via the twinned `roundTargetMinutes`.
const idle = card({ outstandingRounds: 0, oldestOutstandingAt: null, oldestOutstandingTargetMinutes: 0 });
check(
  'the first round out starts the clock',
  applyBoardEvent([idle], sent('chk_1', 3, 20_000, [2, 15, 8]), tableNameFor).map((c) => ({
    at: c.oldestOutstandingAt,
    target: c.oldestOutstandingTargetMinutes,
  })),
  [{ at: '2026-09-18T13:05:00.000Z', target: 15 }],
);

// `seq` is authoritative over the running count, so a card that missed an event
// while the stream was down catches up rather than drifting one behind forever.
check(
  'the round count catches up to seq after a gap',
  applyBoardEvent([card({ roundCount: 1 })], sent('chk_1', 4, 20_000), tableNameFor).map(
    (c) => c.roundCount,
  ),
  [4],
);

check(
  'a void lowers the total and leaves the round count alone',
  applyBoardEvent([card({ roundCount: 2, totalMinor: 13_900 })], voided('chk_1', 11_500), tableNameFor),
  [card({ roundCount: 2, totalMinor: 11_500 })],
);

// A check whose every line was struck off is still a check, and still has to be
// paid for zero before the table is free.
check(
  'voiding everything leaves a card at zero rather than removing it',
  applyBoardEvent([card()], voided('chk_1', 0), tableNameFor),
  [card({ totalMinor: 0 })],
);

// --- paying ------------------------------------------------------------------

check(
  'a paid check comes off the board',
  applyBoardEvent([card(), card({ id: 'chk_2', tableId: 'tbl_7', tableName: 'Table 7' })], paid('chk_1', 'tbl_4'), tableNameFor),
  [card({ id: 'chk_2', tableId: 'tbl_7', tableName: 'Table 7' })],
);

// --- events that are not the board's ----------------------------------------
// The printer's two say nothing about a total or a state; they belong to the
// banner, against a different query.

// --- delivery ---------------------------------------------------------------
// The payload is absolute state, not a decrement, so applying it is a copy
// rather than arithmetic — and a board that missed a send while its stream was
// down is corrected here instead of compounding the error.

check(
  'a delivery adopts the count the Worker sent',
  applyBoardEvent([card({ outstandingRounds: 3 })], delivered('chk_1', 2, '2026-09-18T13:10:00.000Z', 20), tableNameFor),
  [card({ outstandingRounds: 2, oldestOutstandingAt: '2026-09-18T13:10:00.000Z', oldestOutstandingTargetMinutes: 20 })],
);

// The last round out clears the clock entirely: a table waiting for its bill
// rather than for its food.
check(
  'the last delivery clears the clock',
  applyBoardEvent([card()], delivered('chk_1', 0, null), tableNameFor),
  [card({ outstandingRounds: 0, oldestOutstandingAt: null, oldestOutstandingTargetMinutes: 0 })],
);

// It corrects a count that drifted while the stream was down, rather than
// decrementing a number it has no reason to trust.
check(
  'it corrects a drifted count rather than decrementing',
  applyBoardEvent([card({ outstandingRounds: 99 })], delivered('chk_1', 1, '2026-09-18T13:02:00.000Z', 12), tableNameFor)
    .map((c) => c.outstandingRounds),
  [1],
);

check(
  'a delivery leaves the total alone — food arriving is not paying for it',
  applyBoardEvent([card({ totalMinor: 11_400 })], delivered('chk_1', 0, null), tableNameFor).map((c) => c.totalMinor),
  [11_400],
);

// --- part of a table settling ------------------------------------------------
// The card stays. That is the whole difference between this and `check.paid`,
// and the reason an eighth event had to exist: clearing a table off the till
// because one of four diners has paid would take the card away while the other
// three are still eating.

check(
  'a part payment keeps the card and lowers what is owed',
  applyBoardEvent([card({ totalMinor: 13_000 })], partPaid('chk_1', 1_000, 13_000, 12_000), tableNameFor),
  [card({ totalMinor: 13_000, outstandingMinor: 12_000 })],
);

// Absolute, not a decrement — so a board that missed the last part payment is
// corrected here rather than compounding the error.
check(
  'it adopts the outstanding figure rather than subtracting',
  applyBoardEvent([card({ totalMinor: 13_000, outstandingMinor: 99_999 })], partPaid('chk_1', 1_000, 13_000, 12_000), tableNameFor)
    .map((c) => c.outstandingMinor),
  [12_000],
);

// A round sent to a table that is part way through settling adds to what is
// owed by exactly what it adds to the bill. The event carries only the gross,
// and every change it can describe is a change in unpaid food.
check(
  'a round sent to a part-paid table raises both figures together',
  applyBoardEvent(
    [card({ roundCount: 1, totalMinor: 13_000, outstandingMinor: 12_000 })],
    sent('chk_1', 2, 17_500),
    tableNameFor,
  ).map((c) => [c.totalMinor, c.outstandingMinor]),
  [[17_500, 16_500]],
);

// And a line struck off lowers both. Only an unpaid line can be voided — the
// Worker refuses one with money against it — so the two move by the same amount.
check(
  'a void on a part-paid table lowers both figures together',
  applyBoardEvent(
    [card({ totalMinor: 13_000, outstandingMinor: 12_000 })],
    voided('chk_1', 9_000),
    tableNameFor,
  ).map((c) => [c.totalMinor, c.outstandingMinor]),
  [[9_000, 8_000]],
);

// A board whose total had drifted low must not produce a negative, which would
// quietly discount the rest of the table.
check(
  'a drifted total cannot make what is owed negative',
  applyBoardEvent(
    [card({ totalMinor: 50_000, outstandingMinor: 1_000 })],
    voided('chk_1', 9_000),
    tableNameFor,
  ).map((c) => c.outstandingMinor),
  [0],
);

check(
  'a printed job leaves the board alone',
  applyBoardEvent([card()], printed, tableNameFor),
  [card()],
);

// --- identity, which is what makes an unrelated event free ------------------
// `setQueryData` with an unchanged reference is a no-op, so an event about a
// check this board is not showing costs nothing and re-renders nothing.

const board = [card()];
check('an event for an unknown check returns the same array', applyBoardEvent(board, sent('chk_9', 1, 100), tableNameFor) === board, true);
check('a printer event returns the same array', applyBoardEvent(board, printed, tableNameFor) === board, true);
check('paying a check that is not here returns the same array', applyBoardEvent(board, paid('chk_9', null), tableNameFor) === board, true);

// --- the one legitimate refetch ---------------------------------------------
// A stream that dropped and reconnected has a gap behind it, and `round.sent`
// carries a total but no table, no waiter and no opening time — so there is
// genuinely nothing to build a card out of.

check('a round for an unknown check asks for a refetch', boardNeedsRefetch([card()], sent('chk_9', 1, 100)), true);
check('a void for an unknown check asks for a refetch', boardNeedsRefetch([card()], voided('chk_9', 100)), true);
check('a round for a known check does not', boardNeedsRefetch([card()], sent('chk_1', 2, 100)), false);
// A check the board does not have, being removed, is already in the state the
// event describes.
check('paying a check that is not here does not', boardNeedsRefetch([card()], paid('chk_9', null)), false);
check('opening a check never does', boardNeedsRefetch([], opened('chk_9', 'tbl_4')), false);
// A delivery for a check the board does not have means it is missing a card,
// not that it is showing a wrong clock — nothing to correct by asking.
check('a delivery never does', boardNeedsRefetch([card()], delivered('chk_9', 0, null)), false);
check('a printer event never does', boardNeedsRefetch([], printed), false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
