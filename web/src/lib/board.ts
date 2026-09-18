import type { CheckSummary, RealtimeEvent } from '@pos/shared';

/**
 * The cashier's board, as a pure function of what it was and what just
 * happened.
 *
 * ## Why this is a function and not a `setQueryData` callback in the page
 *
 * Because it is the only part of the realtime path that can be *tested*.
 * Local development runs with no Upstash credentials — deliberately; `CLAUDE.md`
 * says `wrangler dev` must need no cloud resources — so the stream is never
 * exercised on a developer's machine, and a reducer written inline in a
 * component is a reducer nobody runs until a Saturday service. Pulling it out
 * here means `web/test/board.test.ts` runs every case on every `npm test`,
 * without a server, a socket or a Redis.
 *
 * ## The rule these obey
 *
 * **Never refetch on an event.** The payloads in `shared/src/events.ts` are
 * self-sufficient precisely so a client does not have to, and the reason is the
 * budget: one event costs three Redis commands to publish, and answering it
 * with a round trip would spend the request it was sent to avoid. So every
 * function here works from the payload alone.
 *
 * There is exactly one exception and {@link boardNeedsRefetch} is it.
 */

/**
 * Turn a table id into the name on the card.
 *
 * A parameter rather than a lookup inside, because `check.opened` carries the
 * table's **id** and not its name — the event catalogue is fixed at six events
 * with fixed payloads, and widening one to carry a name the client already has
 * would be a deviation to save a `Map.get`. The cashier's page already holds
 * the tables list; this is how it gets in.
 *
 * Null for takeaway, and null again for a table this client has never heard of
 * — a table added in the backoffice since the page loaded. The card then shows
 * the screen's own word for a sale with nowhere to sit, which is wrong but
 * harmless and corrects itself on the next refresh.
 */
export type TableNameLookup = (tableId: string | null) => string | null;

/**
 * Apply one event to the board.
 *
 * Returns a new array whenever anything changed and **the same array reference**
 * when nothing did, which is not a micro-optimisation: `setQueryData` with an
 * unchanged reference is a no-op, so an event about a check this board is not
 * showing costs nothing and re-renders nothing.
 *
 * Ordering is not assumed. `round.sent` for a check the board has never seen
 * is left alone rather than invented, because the payload does not carry who
 * opened it or when — see {@link boardNeedsRefetch}, which is what notices.
 */
export function applyBoardEvent(
  board: readonly CheckSummary[],
  event: RealtimeEvent,
  tableNameFor: TableNameLookup,
): CheckSummary[] {
  switch (event.name) {
    case 'check.opened': {
      // A check is opened by the same request that sends its first round, so
      // this arrives a beat before a `round.sent` that will fill in the total.
      // It is inserted at zero rather than waiting, so the card appears the
      // moment the table does — a cashier watching the board sees the table
      // light up as the waiter presses Send.
      if (board.some((check) => check.id === event.data.checkId)) return board as CheckSummary[];
      return [
        ...board,
        {
          id: event.data.checkId,
          tableId: event.data.tableId,
          tableName: tableNameFor(event.data.tableId),
          openedByName: event.data.staffName,
          openedAt: event.data.at,
          roundCount: 0,
          totalMinor: 0,
        },
      ];
    }

    case 'round.sent': {
      // The total travels with the event and is the Worker's own, computed with
      // the twin of the arithmetic this client would use — so it is adopted
      // rather than recomputed. The client never has to hold enough of a check
      // to add it up itself, which is the whole point of carrying it.
      return patch(board, event.data.checkId, (check) => ({
        ...check,
        roundCount: Math.max(check.roundCount + 1, event.data.seq),
        totalMinor: event.data.checkTotal,
      }));
    }

    case 'item.voided': {
      return patch(board, event.data.checkId, (check) => ({
        ...check,
        totalMinor: event.data.checkTotal,
      }));
    }

    case 'check.paid': {
      // Off the board. This is the event that frees a table, and it is why the
      // payload carries `tableId` — by the time it arrives the cashier has
      // usually navigated away from the check itself.
      const without = board.filter((check) => check.id !== event.data.checkId);
      return without.length === board.length ? (board as CheckSummary[]) : without;
    }

    /*
     * The printer's two events say nothing about a check's total or its state,
     * so the board is untouched. They are the banner's, and the cashier page
     * handles them against a different query.
     */
    case 'print_job.failed':
    case 'print_job.printed':
      return board as CheckSummary[];
  }
}

/**
 * The one case that has to ask the server.
 *
 * A stream that dropped and reconnected has a gap behind it: the events that
 * happened while it was down are gone, and the first one to arrive afterwards
 * may well be about a check this board has never seen. `round.sent` and
 * `item.voided` both carry a new total and nothing else about the check — no
 * table, no waiter, no opening time — so there is genuinely nothing to build a
 * card out of, and inventing a blank one would be worse than a refetch.
 *
 * `check.paid` is deliberately not here: a check the board does not have,
 * being removed, is already in the state the event describes.
 */
export function boardNeedsRefetch(
  board: readonly CheckSummary[],
  event: RealtimeEvent,
): boolean {
  switch (event.name) {
    case 'round.sent':
    case 'item.voided':
      return !board.some((check) => check.id === event.data.checkId);
    default:
      return false;
  }
}

/** Replace one check, or leave the board exactly as it was. */
function patch(
  board: readonly CheckSummary[],
  checkId: string,
  change: (check: CheckSummary) => CheckSummary,
): CheckSummary[] {
  const index = board.findIndex((check) => check.id === checkId);
  if (index === -1) return board as CheckSummary[];
  const next = board.slice();
  next[index] = change(board[index]!);
  return next;
}
