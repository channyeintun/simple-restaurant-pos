import { type Identity, type StaffName, authResultSchema, staffNameSchema } from '@pos/shared';
import { z } from 'zod';
import { get, post, setToken } from './client.js';

/**
 * The staff half of the credential: the names on the PIN screen, and the two
 * routes that put somebody on this tablet and take them off again.
 *
 * Every route here needs a claimed device and nothing more, which is what lets
 * the PIN screen draw a list of names with nobody signed in. `auth.ts` carries
 * the note on why these wrappers parse their responses instead of casting
 * them; the same applies to all three below.
 *
 * Nothing in this file is stored anywhere. A shift change writes no row —
 * signing in and signing out are both the same token minted again with the
 * staff claim added or left out — so there is no "session" to end, nothing to
 * reconcile after a tablet is switched off mid-shift, and no state that can
 * disagree with the token the next request carries.
 */

/**
 * `GET /staff` answers with the array itself rather than `{ staff: [...] }`,
 * and this is the schema that says so.
 *
 * Built here from `staffNameSchema` rather than exported from `shared/`: the
 * element type is the contract and is worth a name, while the fact that a
 * dozen of them arrive in a list is something both sides can spell in one
 * line.
 */
const staffListSchema = z.array(staffNameSchema);

/**
 * The names for the PIN screen, alphabetically, with the role badge beside
 * each one.
 *
 * Three fields per person and the PIN hash is not among them — it is not
 * selected by the query, does not exist on the Worker's row struct, and is not
 * in `staffNameSchema`, so there are three separate places this would have to
 * be got wrong. That is deliberate: this is the one route in the app a tablet
 * can call with nobody signed in, and therefore the one a stranger holding an
 * unlocked tablet can call.
 */
export const listStaff = (signal?: AbortSignal): Promise<StaffName[]> =>
  get<unknown>('/staff', signal).then((body) => staffListSchema.parse(body));

/**
 * Sign somebody in: four digits in, a new token out.
 *
 * There is no "pick your name, then type your PIN" step. That is two taps at a
 * counter with a queue at it, so the digits are the identifier — the Worker
 * computes `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` for each active member
 * of staff and sees which one lands.
 *
 * The digits are not validated here. `pinSchema` in `shared/` is what the
 * keypad holds its own Enter key against, and a wrapper that threw on four
 * bad characters would be a second, quieter copy of that rule — one that a
 * screen could not show next to the field the person is typing in.
 *
 * A wrong PIN comes back as a 401 and means "nobody here has those digits". It
 * is not a dead credential: the device token is untouched and `client.ts` will
 * not clear it, because the tablet is still a claimed tablet. The screen says
 * so and lets them try again.
 */
export async function switchStaff(pin: string): Promise<Identity> {
  const result = authResultSchema.parse(await post<unknown>('/staff/switch', { pin }));
  setToken(result.token);
  return result.identity;
}

/**
 * Sign the current person out, leaving the tablet claimed.
 *
 * `setToken`, emphatically not `clearToken`. The route answers with a token
 * re-minted *without* the staff claim, and that token is still this device's
 * credential — dropping it instead would un-claim a tablet at the end of every
 * shift and send somebody looking for an admin and a fresh link at the start
 * of the next one. Signing out of a person is not signing out of a device;
 * that is `logout()` in `auth.ts`.
 */
export async function signOutStaff(): Promise<Identity> {
  const result = authResultSchema.parse(await post<unknown>('/staff/signout'));
  setToken(result.token);
  return result.identity;
}
