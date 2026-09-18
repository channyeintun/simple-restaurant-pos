import { type Product, sumMinor } from '@pos/shared';
import { createStore, produce } from 'solid-js/store';
import { z } from 'zod';
import { platform } from '../platform/index.js';

/**
 * The waiter's cart: what has been tapped but not yet sent.
 *
 * ## Why this is a module-level store and not a context
 *
 * Because it has to outlive the screen. The right-hand pane is a nested route
 * that unmounts every time the waiter walks to a different table, and a store
 * created inside it would take the half-finished order with it. A context above
 * the route would survive that, but not a reload — and a reload is the case
 * that actually matters, because the brief is explicit: *never lose the draft*.
 * Since the drafts have to be in `localStorage` anyway, the store that mirrors
 * them may as well be where they are.
 *
 * ## Drafts are per slot, and the slot is not always a table
 *
 * A draft belongs to whatever the waiter is standing in front of, which is one
 * of three things: a table, an open takeaway check, or a takeaway order that
 * does not exist yet. {@link slotKey} spells those; keying by table id alone
 * would mean the counter shared a cart with table 1, or had none at all.
 *
 * ## Prices in here are display copies
 *
 * `name` and `priceMinor` on a draft line are what the tile said when it was
 * tapped, and they are used for one thing: showing a running total before
 * anything has been sent. **The Worker prices the order at send time** from its
 * own menu, so a tablet holding a stale draft from before a price change
 * charges the new price, not the one in this file. That is deliberate and it is
 * why `sendRound` posts product ids and quantities and no money at all.
 *
 * ## `pending`
 *
 * The key for one tap of Send, held from the moment the button is pressed until
 * the round is confirmed or explicitly discarded. It is the difference between
 * a retry and a second order: the same key means the Worker recognises the
 * repeat, a new one means it cooks the food twice. Nothing in this module ever
 * regenerates it, and the only two ways it goes away are success and Discard.
 */

/* ------------------------------------------------------------------ shape */

export interface DraftLine {
  productId: string;
  /** What the tile said. A display copy — see the note above. */
  name: string;
  priceMinor: number;
  qty: number;
  /** "no chilli", "extra rice". Null when there is none. */
  note: string | null;
}

export interface Draft {
  lines: DraftLine[];
  /** Set while a send is in flight or unconfirmed. Null the rest of the time. */
  pending: { clientKey: string; startedAt: string } | null;
}

const EMPTY: Draft = { lines: [], pending: null };

/**
 * Where a draft belongs.
 *
 * Three shapes, each with its own prefix, so that a table id and a check id can
 * never collide and so that a glance at a stored key says what it was for.
 */
export type Slot =
  | { kind: 'table'; tableId: string }
  | { kind: 'check'; checkId: string }
  | { kind: 'takeaway' };

export function slotKey(slot: Slot): string {
  switch (slot.kind) {
    case 'table':
      return `table:${slot.tableId}`;
    case 'check':
      return `check:${slot.checkId}`;
    /*
     * One key for every new takeaway order, not one per order. There is only
     * ever one being built at a time — the waiter is standing at the counter
     * with one customer — and the moment it is sent it becomes a check with an
     * id, which is the `check:` slot above. A key per order would accumulate
     * abandoned drafts in storage with nothing to ever clear them.
     */
    case 'takeaway':
      return 'takeaway:new';
  }
}

/* ------------------------------------------------------------ persistence */

const STORAGE_KEY = 'waiter.drafts';

/**
 * The stored shape, parsed rather than trusted.
 *
 * What comes out of `localStorage` was written by whatever bundle was installed
 * at the time, which on a PWA may be last week's — and a service worker decides
 * when that stops being true, not us. So a stored blob that does not match is
 * dropped rather than spread into the store, where it would surface as a line
 * with no name on it in the middle of a service.
 *
 * `catch` on the outer object rather than a `safeParse` at the call site,
 * because "drop everything" is the only sensible answer and saying so here
 * keeps the caller a one-liner.
 */
const draftSchema = z.object({
  lines: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      priceMinor: z.number().int().min(0),
      qty: z.number().int().min(1).max(99),
      note: z.string().nullable(),
    }),
  ),
  pending: z
    .object({ clientKey: z.string(), startedAt: z.string() })
    .nullable(),
});
const draftsSchema = z.record(z.string(), draftSchema).catch({});

function hydrate(): Record<string, Draft> {
  const stored = platform.storage.get(STORAGE_KEY);
  if (!stored) return {};
  try {
    return draftsSchema.parse(JSON.parse(stored));
  } catch {
    // Not JSON at all. Same answer.
    return {};
  }
}

const [drafts, setDrafts] = createStore<Record<string, Draft>>(hydrate());

/**
 * Write the whole map back after every change.
 *
 * Written from the mutators rather than from a `createEffect`, because a
 * module-level effect needs a root to own it and this needs to be synchronous
 * anyway: the case the brief cares about is a tablet that loses power between
 * the tap and the next frame, and an effect that runs at the end of the batch
 * is one frame too late to be sure.
 *
 * Storage can throw — a private window, a device with no room left — and it
 * throwing must not take the cart with it. A draft that is only in memory is
 * still a draft the waiter can send; what it will not do is survive a reload,
 * which is a worse outcome than this one and not one this line can prevent.
 */
function persist(): void {
  try {
    platform.storage.set(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* Ignored on purpose. See above. */
  }
}

/* ---------------------------------------------------------------- reading */

/** The draft for a slot, which is always an object and never undefined. */
export function draftFor(slot: Slot): Draft {
  return drafts[slotKey(slot)] ?? EMPTY;
}

/** True when this slot has something waiting to be sent. */
export function hasDraft(key: string): boolean {
  const draft = drafts[key];
  return draft !== undefined && draft.lines.length > 0;
}

/**
 * What the cart comes to, before anything has been sent.
 *
 * `sumMinor` from `shared/` — the same integer arithmetic the Worker totals a
 * check with — rather than a local `reduce`. It is the one definition, and it
 * is the reason no float ever reaches a price in this app.
 */
export function draftTotalMinor(slot: Slot): number {
  return sumMinor(draftFor(slot).lines.map((line) => ({ priceMinor: line.priceMinor, qty: line.qty })));
}

/* --------------------------------------------------------------- writing */

/**
 * Tap a product tile.
 *
 * A second tap on the same tile makes it two, and the line it finds is the
 * **un-noted** one: a line with "no chilli" on it is its own line, and tapping
 * the tile again must not add a second portion to it. That is what makes "two
 * curries, one of them without chilli" three taps and a note rather than a
 * puzzle — tap, tap, note the new line, tap again.
 */
export function addProduct(slot: Slot, product: Product): void {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      const draft = (state[key] ??= { lines: [], pending: null });
      const existing = draft.lines.find(
        (line) => line.productId === product.id && line.note === null,
      );
      if (existing) {
        // 99 is `itemSchema.qty`'s ceiling. Stopping there rather than letting
        // it climb means the Worker's validation can never be the thing that
        // refuses a send — the tile simply stops counting, which is visible.
        existing.qty = Math.min(99, existing.qty + 1);
        return;
      }
      draft.lines.push({
        productId: product.id,
        name: product.name,
        priceMinor: product.priceMinor,
        qty: 1,
        note: null,
      });
    }),
  );
  persist();
}

/**
 * The `−` and `+` on a cart line.
 *
 * Going below one **removes the line**, with no confirmation. That is not the
 * same act as voiding: nothing has been sent, the kitchen has never heard of
 * it, and a dialog for taking back something you have not done yet is the kind
 * of confirmation that teaches people to dismiss confirmations. The brief asks
 * for exactly two confirmed actions — clearing the cart and voiding a sent line
 * — and this is neither.
 */
export function changeQty(slot: Slot, index: number, delta: number): void {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      const draft = state[key];
      const line = draft?.lines[index];
      if (!draft || !line) return;
      const next = line.qty + delta;
      if (next < 1) draft.lines.splice(index, 1);
      else line.qty = Math.min(99, next);
    }),
  );
  persist();
}

/** Set or clear a line's note. Empty and whitespace both mean "no note". */
export function setNote(slot: Slot, index: number, note: string): void {
  const key = slotKey(slot);
  const trimmed = note.trim();
  setDrafts(
    produce((state) => {
      const line = state[key]?.lines[index];
      if (line) line.note = trimmed === '' ? null : trimmed;
    }),
  );
  persist();
}

/** Clear the cart. The one destructive thing here, and it is confirmed. */
export function clearDraft(slot: Slot): void {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      const draft = state[key];
      if (draft) draft.lines = [];
    }),
  );
  persist();
}

/**
 * Take the key for this attempt at sending, minting one only if there is not
 * one already.
 *
 * The `??=` is the entire idempotency rule expressed in two characters, and it
 * is the one line in this file that must not be "simplified" into an
 * assignment. Pressing Retry after a send whose reply was lost has to send the
 * *same* key — that is how the Worker recognises the repeat and answers with
 * the round it already has. A fresh key is a fresh round, which is the same
 * food cooked twice.
 */
export function beginSend(slot: Slot): string {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      const draft = (state[key] ??= { lines: [], pending: null });
      draft.pending ??= { clientKey: platform.randomId(), startedAt: new Date().toISOString() };
    }),
  );
  persist();
  return drafts[key]?.pending?.clientKey ?? '';
}

/**
 * The round landed. Empty the cart and let the key go.
 *
 * Both at once, and only here: a cart emptied while its key survived would send
 * nothing on the next Retry, and a key dropped while the lines survived would
 * send them again as a new round.
 */
export function sendSucceeded(slot: Slot): void {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      const draft = state[key];
      if (!draft) return;
      draft.lines = [];
      draft.pending = null;
    }),
  );
  persist();
}

/**
 * Give up on an unconfirmed send, keeping the lines.
 *
 * Only reachable behind a confirmation that says what it means: the kitchen may
 * already have this round. Dropping the key without dropping the lines is the
 * deliberate half-measure — the waiter is saying "I do not know whether that
 * went through, let me look" — and what they do next is either send again,
 * which is now a genuinely new round, or clear the cart.
 */
export function discardPending(slot: Slot): void {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      const draft = state[key];
      if (draft) draft.pending = null;
    }),
  );
  persist();
}

/**
 * Move a draft from the "new takeaway" slot onto the check that was just
 * opened for it.
 *
 * Called after a takeaway send so that the next round for the same customer
 * lands in the same place as the first. Without it, the waiter would tap
 * Takeaway again and get a second check — a second bill for one order.
 */
export function adoptCheckSlot(checkId: string): void {
  const from = slotKey({ kind: 'takeaway' });
  const to = slotKey({ kind: 'check', checkId });
  setDrafts(
    produce((state) => {
      const draft = state[from];
      if (!draft) return;
      state[to] = { lines: draft.lines, pending: draft.pending };
      delete state[from];
    }),
  );
  persist();
}

/**
 * Forget a slot entirely — the check was paid, or the table was cleared.
 *
 * Nothing calls this on a timer and nothing should: an abandoned draft is a
 * waiter who walked away mid-order, and it is theirs to come back to. What this
 * is for is the slot that can no longer exist, where leaving the draft would
 * mean a cart attached to a check that has been settled.
 */
export function forgetSlot(slot: Slot): void {
  const key = slotKey(slot);
  setDrafts(
    produce((state) => {
      delete state[key];
    }),
  );
  persist();
}

