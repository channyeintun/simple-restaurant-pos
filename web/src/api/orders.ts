import {
  type CheckDetail,
  type CheckSummary,
  type PaymentMethod,
  type PrintJobStatus,
  type PrintJobView,
  type SendRoundInput,
  checkDetailSchema,
  checkSummarySchema,
  printJobViewSchema,
} from '@pos/shared';
import { z } from 'zod';
import { get, post } from './client.js';

/**
 * Ordering: what the waiter sends, what the cashier settles, and what the
 * printer owes the kitchen.
 *
 * Every function that *changes* a check answers with the whole check, which is
 * why there are no `void` returns here. The screen that sent the round is about
 * to draw the check with the round on it, and the response it is already
 * holding is the cheapest possible way to tell it — so these all end in a
 * `checkDetailSchema.parse`, and the callers write the result straight into the
 * query cache rather than invalidating and fetching it again.
 *
 * `auth.ts` carries the argument for parsing every response rather than casting
 * it. It matters more here than anywhere else in the app: this is the money
 * path, and a field that drifted between the Rust struct and the zod schema
 * would surface as a missing line on a bill rather than as an error.
 */

const summaryListSchema = z.array(checkSummarySchema);
const printJobListSchema = z.array(printJobViewSchema);

/* ------------------------------------------------------------------ reads */

/**
 * Every check still open, oldest first.
 *
 * One list, two screens. The cashier's board draws a card per entry; the
 * waiter's table grid uses it to say which tables are occupied and what they
 * have run up. They share a route and a cache key deliberately — two nearly
 * identical lists would be two things to keep in step, and one of them would
 * eventually say a table was free when it was not.
 */
export const listOpenChecks = (signal?: AbortSignal): Promise<CheckSummary[]> =>
  get<unknown>('/checks?status=open', signal).then((body) => summaryListSchema.parse(body));

export const getCheck = (checkId: string, signal?: AbortSignal): Promise<CheckDetail> =>
  get<unknown>(`/checks/${checkId}`, signal).then((body) => checkDetailSchema.parse(body));

/**
 * The open check on a table, or null when it is free.
 *
 * Null with a 200, not a 404, and the caller must treat it as an answer: "this
 * table is free" is the commonest state a table is in, and the waiter's pane
 * draws an empty cart for it. This is the one request the waiter's screen makes
 * when a table is opened, and it is why a waiter tablet never subscribes to
 * anything — the waiter is looking at one table and has just caused the change
 * they are looking at.
 */
export const getTableCheck = (tableId: string, signal?: AbortSignal): Promise<CheckDetail | null> =>
  get<unknown>(`/checks/by-table/${tableId}`, signal).then((body) =>
    body === null ? null : checkDetailSchema.parse(body),
  );

/* ------------------------------------------------------------------ writes */

/**
 * One tap of Send to kitchen.
 *
 * `clientKey` must be **minted once per tap and re-sent unchanged on a retry**.
 * That is the whole of the idempotency story and getting it backwards is the
 * one mistake on this path that cooks the food twice: the Worker recognises a
 * repeat by the key, so a new key on the Retry button is a new round.
 */
export const sendRound = (input: SendRoundInput): Promise<CheckDetail> =>
  post<unknown>('/rounds', input).then((body) => checkDetailSchema.parse(body));

/**
 * Strike a line off a round that has already printed.
 *
 * Never a delete. The row keeps `voidedAt` and `voidedBy`, the bill stays
 * honest about what was struck off and by whom, and the Worker queues a void
 * ticket so the kitchen is told in the same physical way they were told to cook
 * it — they are holding a slip that says otherwise.
 */
export const voidItem = (checkId: string, itemId: string): Promise<CheckDetail> =>
  post<unknown>(`/checks/${checkId}/items/${itemId}/void`).then((body) =>
    checkDetailSchema.parse(body),
  );

/**
 * The waiter carried this round to the table.
 *
 * The one call in this app that records something the software could not
 * otherwise know — everything else here is the consequence of a tap that also
 * *did* something. It stops that round's clock: a round with `deliveredAt`
 * null is outstanding, and that is what every timer on every screen reads.
 *
 * Tapping it twice is harmless. The Worker guards on the round still being
 * out, so the second tap leaves the first stamp standing and answers with the
 * check as it is — which is what the person tapping meant either way.
 */
export const deliverRound = (checkId: string, roundId: string): Promise<CheckDetail> =>
  post<unknown>(`/checks/${checkId}/rounds/${roundId}/delivered`).then((body) =>
    checkDetailSchema.parse(body),
  );

/**
 * Record that a round's ticket was printed by hand.
 *
 * Called after the browser's print dialog closes. It acks the round's pending
 * `ticket` job, which is the same fact the agent's ack records by a different
 * route — the kitchen has been given this on paper — and the queue cannot tell
 * the difference.
 *
 * It matters because of what happens if it is skipped. The job would sit
 * `pending` forever, so the cashier's stuck-queue banner would stay amber while
 * somebody is standing at the pass holding the slip; and the day an agent is
 * finally plugged in, it would find the evening's backlog and print all of it
 * again.
 *
 * There is no success signal from `print()` — it returns the same whether the
 * dialog was used or cancelled — so this can mark a cancelled print as printed.
 * That is the accepted trade: the round stays on screen and Print can be tapped
 * again, and the Worker's guard makes the second ack a no-op.
 */
export const markRoundPrinted = (roundId: string): Promise<void> =>
  post<void>(`/print-jobs/by-round/${roundId}/printed`);

/**
 * Take the money and close the check.
 *
 * `expectedTotalMinor` is what the cashier was looking at when they took it. If
 * the check has moved since — a round sent at the table, a line struck off —
 * the Worker refuses with a 409 whose message carries the new figure, and the
 * screen shows it rather than charging a number nobody agreed to.
 *
 * The amount is not a parameter. It is the check's own total, computed by the
 * Worker, so there is no route by which this client decides what a customer
 * paid.
 */
export const payCheck = (
  checkId: string,
  method: PaymentMethod,
  expectedTotalMinor: number,
): Promise<CheckDetail> =>
  post<unknown>(`/checks/${checkId}/pay`, { method, expectedTotalMinor }).then((body) =>
    checkDetailSchema.parse(body),
  );

/* -------------------------------------------------------------- print jobs */

/**
 * The print queue in one status.
 *
 * `failed` is what the cashier's red banner reads: which table's food the
 * kitchen never heard about, and what the printer said about it. The agent
 * polls `pending` from the LAN with the same route — one shape for both,
 * because they want the same facts.
 */
export const listPrintJobs = (
  status: PrintJobStatus,
  signal?: AbortSignal,
): Promise<PrintJobView[]> =>
  get<unknown>(`/print-jobs?status=${status}`, signal).then((body) =>
    printJobListSchema.parse(body),
  );

/**
 * Put a given-up ticket back in the queue, once somebody has put paper in the
 * printer.
 *
 * The attempt count goes back to zero on the Worker's side: the three that
 * failed were about a printer that is now fixed, and carrying them would mean
 * the very next hiccup gave up immediately.
 */
export const retryPrintJob = (jobId: string): Promise<PrintJobView> =>
  post<unknown>(`/print-jobs/${jobId}/retry`).then((body) => printJobViewSchema.parse(body));
