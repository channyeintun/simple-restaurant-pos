import { z } from 'zod';
import { idSchema, isoSchema, itemSchema, minorSchema, paymentMethodSchema } from './models.js';

/**
 * Typed realtime events.
 *
 * The nested shape is what `@upstash/realtime` wants for its dotted event
 * paths (`round.sent` addresses `realtimeSchema.round.sent`), and the same
 * object gives us the payload types on the client. One definition, both sides —
 * a mismatch is a type error rather than a silent no-op at runtime.
 *
 * Payloads are deliberately *self-sufficient*: a client that receives
 * `round.sent` can add the round to the check it is already holding and update
 * the total without issuing a follow-up request. That is not a nicety, it is
 * the budget. The SSE handler spends one Upstash command every ten seconds per
 * open connection — 360 an hour, and a service day of one cashier stream is
 * already about a quarter of the monthly free tier — so every command that is
 * not a keepalive has to earn itself. An event that only said "something
 * changed, go and look" would cost its three commands to publish *and* the
 * round trip it provoked, which is the arrangement this whole design exists to
 * avoid.
 *
 * There are seven, and each one is a thing that happens in the room rather than
 * a table that changed. It was six until the waiter started marking rounds
 * delivered — `round.delivered` is the seventh, and it earns its place the same
 * way the others do: the cashier's board counts how many rounds are still out,
 * and without it that count would only correct itself on a reconnect.
 */

/* ----------------------------------------------------------------- channel */

/**
 * One channel for the whole restaurant, and only the cashier page subscribes to
 * it.
 *
 * Futsal fanned out per session because a member cared about one Friday at a
 * time. Here there is one room, one cashier screen, and perhaps sixty checks in
 * a day — fewer events than a single futsal session generates — so a channel
 * per check would be a subscription per open table, each with its own keepalive,
 * for no gain at all.
 *
 * Waiter tablets and the printer agent never subscribe. A waiter is looking at
 * one table and has just caused the change they are looking at; the agent polls
 * for pending jobs, which is what makes an agent restart self-healing.
 */
export const RESTAURANT_CHANNEL = 'restaurant';

/* ---------------------------------------------------------- the six events */

/**
 * A check was opened — a table's first round has been sent.
 *
 * Carries the staff *name* rather than the id: the cashier's board draws "Table
 * 4, opened by Su" and has no roster to look an id up in. The same reason every
 * name in this catalogue is carried rather than referenced.
 */
export const checkOpenedSchema = z.object({
  checkId: idSchema,
  /** Null for takeaway or the counter, which the board groups separately. */
  tableId: idSchema.nullable(),
  staffName: z.string(),
  at: isoSchema,
});

/**
 * A round was sent to the kitchen.
 *
 * The whole round travels, as full {@link itemSchema} rows rather than a
 * trimmed copy. The cashier needs each line's id to be able to void it, its
 * snapshotted name and price to explain the total, and its quantity to draw the
 * line — which is every field there is. A second, smaller shape for the same
 * thing would be one more place for the two to disagree about what a line is,
 * and the saving is a few dozen bytes on a local network.
 *
 * `checkTotal` is the check's new total, computed server-side with `sumMinor`'s
 * Rust twin. It is carried rather than recomputed on the client so that the
 * number on the cashier's screen is the number the Worker would charge, always
 * — the client never has to hold enough of the check to add it up itself.
 */
export const roundSentSchema = z.object({
  checkId: idSchema,
  roundId: idSchema,
  seq: z.number().int().min(1),
  items: z.array(itemSchema),
  checkTotal: minorSchema,
  at: isoSchema,
});

/**
 * A line was taken off a check.
 *
 * The id and the new total are enough to patch a board that is already holding
 * the check, and a client that is not holding it has nothing to patch. Voiding
 * is never a delete — the row keeps `voided_at` and `voided_by` — but that is
 * the database's business; what the screen has to do is stop counting it.
 */
export const itemVoidedSchema = z.object({
  checkId: idSchema,
  itemId: idSchema,
  checkTotal: minorSchema,
  at: isoSchema,
});

/**
 * A check was paid and closed. `tableId` is carried so the board can free the
 * table without looking the check up again — by the time this arrives the
 * cashier has usually already navigated away from it.
 */
export const checkPaidSchema = z.object({
  checkId: idSchema,
  tableId: idSchema.nullable(),
  method: paymentMethodSchema,
  at: isoSchema,
});

/**
 * Somebody paid for part of a table, and the check is still open.
 *
 * The eighth event, and the only one that reports money arriving without
 * anything closing. It cannot be `check.paid`: the board reducer treats that as
 * "this table is finished, take the card away", and firing it for a table where
 * two of the four diners are still eating would clear the card off the till
 * while the food is on the pass.
 *
 * `outstandingMinor` is the state itself and not a delta, for the same reason
 * `round.delivered` carries a count rather than a decrement: a client that
 * missed an event — a reconnect, a tablet asleep — applies this one and is
 * correct again, instead of being correct relative to something it never saw.
 * `totalMinor` rides along because a part-paid card shows both, and a board
 * that had to fetch the bill to draw one card would spend the request budget
 * this catalogue exists to protect.
 */
export const checkPartPaidSchema = z.object({
  checkId: idSchema,
  tableId: idSchema.nullable(),
  method: paymentMethodSchema,
  /** What this payment took, for a till that wants to show what just happened. */
  amountMinor: minorSchema,
  /** What the meal has cost so far. Unchanged by paying — see `totals.ts`. */
  totalMinor: minorSchema,
  /** What is left to collect. Zero never appears here: that would be a close. */
  outstandingMinor: minorSchema,
  at: isoSchema,
});

/**
 * The kitchen printer did not print something.
 *
 * This is the one event with a person's attention attached to it: it raises the
 * red banner on the cashier screen, and until somebody presses Retry there is a
 * table whose food nobody in the kitchen knows about. So it carries what the
 * banner has to say — which round, which table — rather than a job id the
 * cashier would have to go and resolve.
 *
 * `error` is nullable because a printer can fail without saying anything useful
 * (a socket that simply never opened), and a banner that waits for a good
 * message is a banner that never appears.
 */
export const printJobFailedSchema = z.object({
  jobId: idSchema,
  roundId: idSchema,
  tableId: idSchema.nullable(),
  error: z.string().nullable(),
  at: isoSchema,
});

/**
 * A waiter carried a round to the table.
 *
 * The one event in the catalogue that is recorded by a person rather than
 * caused by one: everything else here is the consequence of a tap that also did
 * something else. This is a tap whose *whole* purpose is to say that a thing
 * happened in the room which no server could otherwise know.
 *
 * It carries no total, because nothing about the money changed — delivering
 * food is not paying for it — and no items, because the board is counting
 * rounds rather than drawing them.
 */
export const roundDeliveredSchema = z.object({
  checkId: idSchema,
  roundId: idSchema,
  at: isoSchema,
  /**
   * What the check still has out, *after* this delivery — absolute, not a
   * delta.
   *
   * Carried because of the rule at the top of this file: a payload has to be
   * applicable without a follow-up request. A board holding a check with three
   * rounds out, told only that one of them arrived, knows the count is now two
   * and has no idea which of the remaining two is now the oldest — so it could
   * only guess, show a stale clock, or ask. Three small numbers cost less than
   * any of those.
   *
   * Absolute rather than a decrement, and that is the better half of the
   * bargain: a client whose stream dropped and missed a send comes back with a
   * count that is wrong, and the next delivery silently corrects it instead of
   * compounding the error.
   */
  outstandingRounds: z.number().int().min(0),
  oldestOutstandingAt: isoSchema.nullable(),
  oldestOutstandingTargetMinutes: z.number().int().min(0).max(600),
});

/** The job printed. Clears the banner; nothing else has to change. */
export const printJobPrintedSchema = z.object({
  jobId: idSchema,
  roundId: idSchema,
  at: isoSchema,
});

/**
 * The single source of truth for the event catalogue. Passed straight into
 * `new Realtime({ schema })` on the Worker, which validates every payload with
 * these before it reaches Redis.
 *
 * `print_job` is snake_case and everything else on the wire is camelCase. That
 * is not an oversight: an event path segment names the thing the event is
 * about, and the thing is the `print_jobs` table. Renaming it `printJob` here
 * would make the event name and the table name differ by one character, which
 * is the worst possible distance between two identifiers for the same thing.
 */
export const realtimeSchema = {
  check: {
    opened: checkOpenedSchema,
    paid: checkPaidSchema,
    part_paid: checkPartPaidSchema,
  },
  round: {
    sent: roundSentSchema,
    delivered: roundDeliveredSchema,
  },
  item: {
    voided: itemVoidedSchema,
  },
  print_job: {
    failed: printJobFailedSchema,
    printed: printJobPrintedSchema,
  },
} as const;

export type RealtimeSchema = typeof realtimeSchema;

/* ------------------------------------------------------------------- types */

export interface EventPayloadMap {
  'check.opened': z.infer<typeof checkOpenedSchema>;
  'check.paid': z.infer<typeof checkPaidSchema>;
  'check.part_paid': z.infer<typeof checkPartPaidSchema>;
  'round.sent': z.infer<typeof roundSentSchema>;
  'round.delivered': z.infer<typeof roundDeliveredSchema>;
  'item.voided': z.infer<typeof itemVoidedSchema>;
  'print_job.failed': z.infer<typeof printJobFailedSchema>;
  'print_job.printed': z.infer<typeof printJobPrintedSchema>;
}

export type EventName = keyof EventPayloadMap;
export type EventPayload<K extends EventName> = EventPayloadMap[K];

export const EVENT_NAMES = [
  'check.opened',
  'check.paid',
  'check.part_paid',
  'round.sent',
  'round.delivered',
  'item.voided',
  'print_job.failed',
  'print_job.printed',
] as const satisfies readonly EventName[];

/**
 * Compile-time proof that {@link EventPayloadMap} says exactly what
 * {@link realtimeSchema} says.
 *
 * `@upstash/realtime` types `emit` by walking the schema object along the
 * dotted path, which TypeScript cannot prove equivalent to a lookup in the map
 * above while the event name is still a generic parameter. The Worker's pub/sub
 * adapter therefore casts once at that seam — and these assertions are what
 * make the cast safe. Point a payload at the wrong schema, or add an event to
 * one side only, and the build fails here rather than at runtime in Redis.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type EventCatalogueIsConsistent = Assert<
  Exact<EventPayloadMap['check.opened'], z.infer<typeof realtimeSchema.check.opened>>
> &
  Assert<Exact<EventPayloadMap['check.paid'], z.infer<typeof realtimeSchema.check.paid>>> &
  Assert<
    Exact<EventPayloadMap['check.part_paid'], z.infer<typeof realtimeSchema.check.part_paid>>
  > &
  Assert<Exact<EventPayloadMap['round.sent'], z.infer<typeof realtimeSchema.round.sent>>> &
  Assert<
    Exact<EventPayloadMap['round.delivered'], z.infer<typeof realtimeSchema.round.delivered>>
  > &
  Assert<Exact<EventPayloadMap['item.voided'], z.infer<typeof realtimeSchema.item.voided>>> &
  Assert<
    Exact<EventPayloadMap['print_job.failed'], z.infer<typeof realtimeSchema.print_job.failed>>
  > &
  Assert<
    Exact<EventPayloadMap['print_job.printed'], z.infer<typeof realtimeSchema.print_job.printed>>
  >;

/** Discriminated union of every event, handy for exhaustive `switch`es. */
export type RealtimeEvent = {
  [K in EventName]: { name: K; channel: string; data: EventPayload<K> };
}[EventName];

/* ------------------------------------------------------------- wire format */

/**
 * SSE frame shapes emitted by `@upstash/realtime`'s `handle()`.
 *
 * Mirrored here (rather than imported) so the frontend never has to depend on
 * the server library, and so a different transport could speak the same
 * protocol.
 */
export const wireUserEventSchema = z.object({
  data: z.unknown(),
  __event_path: z.array(z.string()),
  __stream_id: z.string().optional(),
  __channel: z.string().optional(),
});

export const wireSystemEventSchema = z.union([
  z.object({ type: z.literal('connected'), channel: z.string(), cursor: z.string().optional() }),
  z.object({ type: z.literal('reconnect') }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('disconnected'), channel: z.string() }),
  z.object({ type: z.literal('ping'), timestamp: z.number() }),
]);

export type WireSystemEvent = z.infer<typeof wireSystemEventSchema>;

/**
 * Narrow a raw SSE frame into a typed application event, or `null` if it is a
 * system frame / an event this build does not know about. Unknown events are
 * ignored rather than thrown so a tablet that has not reloaded since last week
 * survives a deploy that added one.
 */
export function parseWireEvent(raw: unknown): RealtimeEvent | null {
  const parsed = wireUserEventSchema.safeParse(raw);
  if (!parsed.success) return null;

  const name = parsed.data.__event_path.join('.') as EventName;
  const schema = lookupSchema(parsed.data.__event_path);
  if (!schema) return null;

  const payload = schema.safeParse(parsed.data.data);
  if (!payload.success) return null;

  return {
    name,
    channel: parsed.data.__channel ?? '',
    data: payload.data,
  } as RealtimeEvent;
}

function lookupSchema(path: readonly string[]): z.ZodType | null {
  let node: unknown = realtimeSchema;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return node instanceof z.ZodType ? node : null;
}
