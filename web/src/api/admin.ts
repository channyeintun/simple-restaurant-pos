import {
  type ClaimLink,
  type CreateDeviceInput,
  type CreateStaffInput,
  type Device,
  type SalesToday,
  type StaffRosterEntry,
  type UpdateStaffInput,
  claimLinkSchema,
  deviceSchema,
  salesTodaySchema,
  staffRosterSchema,
} from '@pos/shared';
import { z } from 'zod';
import { get, patch, post, put } from './client.js';

/**
 * The three lists only a manager sees: the roster, the tablets, and the day's
 * takings.
 *
 * Separate from `staff.ts`, which is the *floor's* half of the same table.
 * That one draws the PIN screen and is readable on a claimed tablet with nobody
 * signed in; every call here needs the admin role. Keeping them in two files
 * means the narrow, unauthenticated read cannot accidentally be widened by
 * somebody adding a field to a backoffice screen — they are not even the same
 * schema.
 *
 * `auth.ts` carries the argument for parsing rather than casting, and it holds
 * here too.
 */

/* ----------------------------------------------------------------- roster */

const rosterSchema = z.array(staffRosterSchema);

/**
 * Everybody who has ever worked here, and whether they can sign in.
 *
 * `hasPin` is the only thing this says about a PIN and the only thing that may
 * be said: the stored value is a keyed hash, so there is nothing to read back
 * even for the person asking. A manager who needs to get somebody in sets a new
 * one; there is no "remind me what it was".
 */
export const listRoster = (signal?: AbortSignal): Promise<StaffRosterEntry[]> =>
  get<unknown>('/staff/roster', signal).then((body) => rosterSchema.parse(body));

export const createStaff = (input: CreateStaffInput): Promise<StaffRosterEntry> =>
  post<unknown>('/staff', input).then((body) => staffRosterSchema.parse(body));

export const updateStaff = (id: string, input: UpdateStaffInput): Promise<StaffRosterEntry> =>
  patch<unknown>(`/staff/${id}`, input).then((body) => staffRosterSchema.parse(body));

/**
 * Set or replace somebody's four digits.
 *
 * `PUT`, not `PATCH`: there is one value, it is replaced whole, and doing it
 * twice with the same digits leaves the same state — which is what `PUT` means
 * and what a manager who taps Save twice on a bad connection needs it to mean.
 *
 * A 409 comes back when those digits already belong to somebody else, and that
 * check can only happen on the Worker: the switch route resolves a person *from
 * the digits alone*, so two people sharing a PIN would leave one of them unable
 * to sign in anywhere, silently. The screen shows the message and keeps the
 * field.
 */
export const setStaffPin = (id: string, pin: string): Promise<StaffRosterEntry> =>
  put<unknown>(`/staff/${id}/pin`, { pin }).then((body) => staffRosterSchema.parse(body));

/* ---------------------------------------------------------------- devices */

const deviceListSchema = z.array(deviceSchema);

export const listDevices = (signal?: AbortSignal): Promise<Device[]> =>
  get<unknown>('/devices', signal).then((body) => deviceListSchema.parse(body));

export const createDevice = (input: CreateDeviceInput): Promise<Device> =>
  post<unknown>('/devices', input).then((body) => deviceSchema.parse(body));

/**
 * Mint a single-use claim link, and show it once.
 *
 * The `url` in this response is the only copy of the nonce that ever leaves the
 * database. It is not stored on the client, is not in the device list, and
 * cannot be asked for again — which is what makes losing one harmless: mint
 * another, and the first stops working, because there is one `claim_nonce`
 * column per device and this overwrote it.
 */
export const mintClaimLink = (id: string): Promise<ClaimLink> =>
  post<unknown>(`/devices/${id}/claim-link`).then((body) => claimLinkSchema.parse(body));

/**
 * Cut a tablet off. Every token it holds stops working on its next request.
 *
 * This is the answer to a device left in a taxi and it is the only one — tokens
 * are stateless for their ninety days, so there is nothing to delete. The
 * device row survives, so the same tablet comes back with a fresh link when it
 * turns up in lost property on Monday.
 */
export const revokeDevice = (id: string): Promise<Device> =>
  post<unknown>(`/devices/${id}/revoke`).then((body) => deviceSchema.parse(body));

/* ----------------------------------------------------------------- report */

/**
 * What the restaurant has taken since local midnight.
 *
 * The window comes back with the number, so the screen quotes the query rather
 * than working out the restaurant's day for itself — and the day somebody
 * changes `TZ_OFFSET_MINUTES`, the total and the "since 00:00" under it move
 * together instead of one of them being six and a half hours out.
 */
export const salesToday = (signal?: AbortSignal): Promise<SalesToday> =>
  get<unknown>('/reports/sales/today', signal).then((body) => salesTodaySchema.parse(body));
