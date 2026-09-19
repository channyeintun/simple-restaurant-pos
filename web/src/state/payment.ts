import { platform } from '../platform/index.js';

/**
 * The key the till mints for one tap of Pay, held somewhere a reload cannot
 * lose it.
 *
 * ## Why this is not a signal in the dialog
 *
 * Because the failure it exists for is the one where the screen goes away. The
 * request commits, the reply is lost on the way back — the wifi by the kitchen
 * door, a tablet that slept, the PWA backgrounded — and the spinner hangs. The
 * cashier taps Cancel, or walks back to the board and reopens the check, or the
 * tablet wakes and the component has remounted. Every one of those destroys a
 * component signal, and the next tap would then mint a *fresh* key: a second
 * payment for the same dishes, indistinguishable to the Worker from a table
 * where two people ordered the same thing and paid separately.
 *
 * `beginSend` in `state/cart.ts` solved exactly this for rounds and this is the
 * same shape, with the same `??=` doing the same work. It matters more here.
 * Cooking twice wastes a dish; charging twice is somebody's money, and the
 * repeat is not detectable afterwards by looking at the bill.
 *
 * ## Per check, not per pick
 *
 * A key belongs to "the payment this till is currently trying to take on this
 * check", and there is only ever one of those: the dialog is modal. Keying it
 * by the picks as well would mint a new one every time the cashier adjusted a
 * quantity, which is the fresh-key bug wearing a hat.
 *
 * ## Per device, like every other stored value
 *
 * Through `platform.storage`, so it is this tablet's. Two tills settling the
 * same check are two different payments and must not share a key — that is the
 * case the *database* arbitrates, with the per-line guard, and it arbitrates it
 * correctly: whichever lands second finds the units already settled and is
 * refused by name.
 */
const KEY_PREFIX = 'till.payment.';

/**
 * The key for this attempt, minting one only if there is not one already.
 *
 * The `??` is the whole idempotency rule and must not be "simplified" into an
 * assignment. A retry after a lost reply has to send the **same** key: that is
 * how the Worker recognises the repeat and answers with the check it already
 * settled, rather than settling it again.
 */
export function beginPayment(checkId: string): string {
  const stored = platform.storage.get(KEY_PREFIX + checkId);
  if (stored) return stored;
  const minted = platform.randomId();
  platform.storage.set(KEY_PREFIX + checkId, minted);
  return minted;
}

/**
 * The money landed. Let the key go.
 *
 * Called on **every** success and nowhere else, which is what makes the next
 * genuine payment on the same check a new payment rather than a replay the
 * Worker answers with a no-op. A table settling in three goes round this loop
 * three times, and each turn needs its own key.
 */
export function paymentSucceeded(checkId: string): void {
  platform.storage.remove(KEY_PREFIX + checkId);
}
