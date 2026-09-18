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

const card = (over: Partial<CheckSummary> = {}): CheckSummary => ({
  id: 'chk_1',
  tableId: 'tbl_4',
  tableName: 'Table 4',
  openedByName: 'Su',
  openedAt: '2026-09-18T13:00:00.000Z',
  roundCount: 1,
  totalMinor: 11_400,
  ...over,
});

const opened = (checkId: string, tableId: string | null): RealtimeEvent => ({
  name: 'check.opened',
  channel: 'restaurant',
  data: { checkId, tableId, staffName: 'Su', at: '2026-09-18T13:00:00.000Z' },
});

const sent = (checkId: string, seq: number, total: number): RealtimeEvent => ({
  name: 'round.sent',
  channel: 'restaurant',
  data: {
    checkId,
    roundId: `rnd_${seq}`,
    seq,
    items: [],
    checkTotal: total,
    at: '2026-09-18T13:05:00.000Z',
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
  [card({ roundCount: 0, totalMinor: 0 })],
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
  [card({ roundCount: 2, totalMinor: 13_900 })],
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
check('a printer event never does', boardNeedsRefetch([], printed), false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
