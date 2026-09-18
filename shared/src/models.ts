import { z } from 'zod';

import { appConfigSchema } from './config.js';

/**
 * Domain models + request payloads, defined once and used on both sides of the
 * wire: the Worker parses inbound bodies with these, the frontend types its
 * fetch results from them.
 *
 * Two house rules run through the whole file and are worth stating once rather
 * than repeating at every object:
 *
 *   * **Field order is output order.** The order the keys are declared in is
 *     the order they appear in the JSON, and the Rust structs that produce that
 *     JSON declare their fields in the same order. Reordering an object here is
 *     an API change, not a tidy-up.
 *   * **Money is an integer in minor units**, always, on every field whose name
 *     ends in `Minor`. See `money.ts`.
 *
 * It grows a milestone at a time. Milestone 0 needs the auth payloads and the
 * staff list; milestone 1 needs the catalogue's create and update bodies. The
 * ten domain models are all here because they are the shape of the database and
 * a reader should be able to see the whole thing in one file, but a request
 * payload arrives with the route that parses it — an unused schema is a guess
 * about a route nobody has written yet, and it will be wrong.
 */

export const idSchema = z.string().min(1).max(64);
/** ISO-8601 UTC instant. Every timestamp in the API is one of these. */
export const isoSchema = z.iso.datetime();
/**
 * Non-negative integer minor units.
 *
 * The ceiling is not a business rule — a billion kyat is not a plausible line
 * on a restaurant bill, which is the point. It is there so a price that arrived
 * as a typo, a stray multiplication or a string that coerced badly is refused
 * at the boundary instead of being added into a day's takings.
 */
export const minorSchema = z.number().int().min(0).max(1_000_000_000);

/**
 * Where something sits in a hand-ordered list — the tables grid, the category
 * chips, the product tiles.
 *
 * Small dense integers set in the backoffice, and deliberately not a float
 * "insert between two neighbours" scheme: reordering half a dozen tables by
 * rewriting half a dozen integers is simpler to read in a `wrangler d1`
 * console than fractional keys that drift towards the limits of a double.
 */
export const sortSchema = z.number().int().min(0).max(9_999);

/* ------------------------------------------------------------------- staff */

export const staffRoleSchema = z.enum(['waiter', 'cashier', 'admin']);
export type StaffRole = z.infer<typeof staffRoleSchema>;

/**
 * Somebody who works here.
 *
 * `pin_hash` is absent, and its absence is load-bearing: this schema is what
 * the Worker's row struct is shaped against, so a column that is not declared
 * here is a column that never reaches a client. The hash is
 * `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` over four digits — a keyed hash
 * is what keeps a leaked database from being ten thousand guesses per person,
 * and shipping the hash to a tablet would hand an attacker the ten thousand
 * guesses back. It does not go in a response, a log line or an event payload.
 */
export const staffSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  role: staffRoleSchema,
  /** Soft delete. Somebody who has left keeps their name on old checks. */
  active: z.boolean(),
  createdAt: isoSchema,
});
export type Staff = z.infer<typeof staffSchema>;

/**
 * What `GET /staff` answers with: the names on the PIN screen, and the role
 * badge beside each one.
 *
 * Written out rather than derived from {@link staffSchema} with `.pick()`. The
 * derivation would be shorter and would mean that the day somebody adds a
 * column to the staff row — a phone number, a photo, a hash — the PIN screen,
 * which is the one screen in this app that anybody can see without signing in,
 * starts serving it to whoever is holding the tablet. An explicit list cannot
 * leak a field that was added somewhere else.
 */
export const staffNameSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  role: staffRoleSchema,
});
export type StaffName = z.infer<typeof staffNameSchema>;

/* ------------------------------------------------------------------ device */

/**
 * One tablet.
 *
 * `claim_nonce`, `claim_expires_at` and `token_version` are columns on this
 * table and none of them are here. The nonce is the credential — it exists in
 * the link and in the row, and anywhere else is a copy that can leak — and
 * `token_version` is the revocation counter the middleware compares against on
 * every request; a client has no use for it and no business knowing it.
 */
export const deviceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  /** When a tablet first redeemed a link for this device. Null until one does. */
  claimedAt: isoSchema.nullable(),
  /** True while an unspent claim link is outstanding, so the list can say so. */
  hasPendingLink: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;

/**
 * A minted claim link, as `scripts/bootstrap-link.mjs` prints it and as the
 * backoffice will show it.
 *
 * `url` contains the only copy of the nonce that leaves the database — it is
 * not stored anywhere else and cannot be shown again, which is what makes
 * losing one harmless: mint another.
 */
export const claimLinkSchema = z.object({
  url: z.string(),
  expiresAt: isoSchema,
  deviceName: z.string(),
});
export type ClaimLink = z.infer<typeof claimLinkSchema>;

/* ------------------------------------------------------------------- table */

/**
 * A table in the room. Not a database table — the only place in this codebase
 * where the word is ambiguous, and it is the domain's word, so the domain
 * keeps it.
 */
export const tableSchema = z.object({
  id: idSchema,
  /** What is painted on it or what the staff call it: "3", "T3", "Terrace 1". */
  name: z.string().min(1).max(20),
  sort: sortSchema,
  active: z.boolean(),
});
export type Table = z.infer<typeof tableSchema>;

export const createTableSchema = z.object({
  name: z.string().trim().min(1, 'Table name is required').max(20),
  sort: sortSchema.optional(),
});
export type CreateTableInput = z.infer<typeof createTableSchema>;

/**
 * `active: false` is how a table is removed. There is no delete route for any
 * of the catalogue: last month's checks point at these rows and have to keep
 * meaning what they meant.
 */
export const updateTableSchema = createTableSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

/* ---------------------------------------------------------------- category */

export const categorySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  sort: sortSchema,
  active: z.boolean(),
});
export type Category = z.infer<typeof categorySchema>;

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').max(40),
  sort: sortSchema.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/* ----------------------------------------------------------------- product */

/**
 * A line on the menu.
 *
 * The price here is the price *now*. What a customer is charged is the price
 * that was copied onto the item when the round was sent — see {@link itemSchema}
 * — so editing this row changes the next order and never a bill that has
 * already been printed.
 */
export const productSchema = z.object({
  id: idSchema,
  categoryId: idSchema,
  name: z.string().min(1).max(60),
  priceMinor: minorSchema,
  sort: sortSchema,
  active: z.boolean(),
});
export type Product = z.infer<typeof productSchema>;

export const createProductSchema = z.object({
  categoryId: idSchema,
  name: z.string().trim().min(1, 'Product name is required').max(60),
  priceMinor: minorSchema,
  sort: sortSchema.optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/* ------------------------------------------------------------------- check */

export const checkStatusSchema = z.enum(['open', 'paid', 'voided']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/**
 * One table seating, from the first round sent to the moment it is paid.
 *
 * A table may have at most one open check, and that rule lives in a partial
 * unique index in the database rather than in a route, because two waiters
 * tapping Send on the same table at the same second is not a rare case in a
 * busy room — it is the normal case for the table by the door.
 */
export const checkSchema = z.object({
  id: idSchema,
  /** Null is takeaway or the counter: a real sale with nowhere to sit. */
  tableId: idSchema.nullable(),
  /** The staff id that sent the first round, not the device. */
  openedBy: idSchema,
  status: checkStatusSchema,
  openedAt: isoSchema,
  /** Set when it is paid or voided; null while it is open. */
  closedAt: isoSchema.nullable(),
});
export type Check = z.infer<typeof checkSchema>;

/* ------------------------------------------------------------------- round */

/**
 * One "Send to kitchen" tap, and therefore exactly one kitchen ticket carrying
 * exactly this round's items.
 *
 * A round is never reprinted as the whole check. The kitchen is cooking the
 * three things that just arrived, and handing them a sheet with the starters
 * they plated twenty minutes ago is how a table gets its food twice.
 */
export const roundSchema = z.object({
  id: idSchema,
  checkId: idSchema,
  /** 1, 2, 3 … within the check. What the ticket header calls itself. */
  seq: z.number().int().min(1),
  sentBy: idSchema,
  sentAt: isoSchema,
});
export type Round = z.infer<typeof roundSchema>;

/* -------------------------------------------------------------------- item */

/**
 * One line on a check. Never a product — a product is what is on the menu, an
 * item is what somebody ordered.
 *
 * `nameSnapshot` and `priceMinorSnapshot` keep their suffix on the wire. The
 * shorter names would read better and would be a lie by omission: these are
 * frozen copies taken when the round was sent, they will drift from the
 * product they came from, and every client that draws them should be told so by
 * the field name rather than by a comment it may not read. `productId` still
 * points at a live row — the catalogue soft-deletes and never deletes, so the
 * reference cannot dangle — and that is for reporting, not for rendering.
 */
export const itemSchema = z.object({
  id: idSchema,
  roundId: idSchema,
  productId: idSchema,
  nameSnapshot: z.string().min(1).max(60),
  priceMinorSnapshot: minorSchema,
  qty: z.number().int().min(1).max(99),
  /** Free text for the kitchen: "no chilli", "extra rice". The only modifier. */
  note: z.string().max(120).nullable(),
  /** Set when the line is voided. The row stays; the total stops counting it. */
  voidedAt: isoSchema.nullable(),
  voidedBy: idSchema.nullable(),
});
export type Item = z.infer<typeof itemSchema>;

/* ----------------------------------------------------------------- payment */

export const paymentMethodSchema = z.enum(['cash', 'card', 'other']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/**
 * Money taken against a check.
 *
 * One row per check in V1 — there are no split payments — but it is a table
 * rather than three columns on `checks` because "how the money arrived" is a
 * different fact from "this seating happened", and the day the restaurant does
 * want to take half in cash the shape already fits.
 */
export const paymentSchema = z.object({
  id: idSchema,
  checkId: idSchema,
  method: paymentMethodSchema,
  amountMinor: minorSchema,
  /** The staff id that took it. The till is answerable to a person. */
  takenBy: idSchema,
  at: isoSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

/* --------------------------------------------------------------- print job */

/** A ticket for a new round, or a void notice for a line taken off one. */
export const printJobKindSchema = z.enum(['ticket', 'void']);
export type PrintJobKind = z.infer<typeof printJobKindSchema>;

export const printJobStatusSchema = z.enum(['pending', 'printed', 'failed']);
export type PrintJobStatus = z.infer<typeof printJobStatusSchema>;

/**
 * Something the kitchen printer owes the room.
 *
 * The queue is a table and not a push, which is what makes a power cut
 * survivable: the agent polls for `pending`, prints, and acks. A job nobody
 * acked stays pending, so an agent that died mid-print — or a printer that was
 * switched off at the wall — catches up by itself when it comes back, and
 * nobody has to know that it did.
 */
export const printJobSchema = z.object({
  id: idSchema,
  roundId: idSchema,
  kind: printJobKindSchema,
  status: printJobStatusSchema,
  /** Given up on after 3. The agent backs off exponentially in between. */
  attempts: z.number().int().min(0),
  /** Whatever the agent said went wrong, so the cashier's banner can say it. */
  lastError: z.string().max(300).nullable(),
  createdAt: isoSchema,
  printedAt: isoSchema.nullable(),
});
export type PrintJob = z.infer<typeof printJobSchema>;

/* -------------------------------------------------------------------- auth */

/**
 * Redeeming a device claim link.
 *
 * The nonce travels in the URL *fragment*, which browsers never send to the
 * server and which therefore stays out of access logs and `Referer` headers.
 * The claim page reads it and posts it here, where the row is looked up and
 * cleared in the same statement — single-use is a delete, and minting one
 * needs no secret.
 */
export const claimSchema = z.object({
  nonce: z.string().min(20).max(100),
});
export type ClaimInput = z.infer<typeof claimSchema>;

/** Four digits, because that is what a keypad on a tablet by the pass wants. */
export const pinSchema = z.string().regex(/^\d{4}$/, 'A PIN is 4 digits');

/**
 * Signing a member of staff in on a tablet that is already claimed.
 *
 * A 4-digit PIN is **not** a security boundary against outsiders and nothing in
 * this codebase should describe it as one. Ten thousand possibilities is a
 * lunchtime's work for anyone who wants them. What keeps strangers out is the
 * device cookie: the tablet was claimed by an admin with a single-use link, and
 * without that cookie this route is not reachable at all. The PIN's job is to
 * tell Aung from Su on a device they share, so the waiter's name on the ticket
 * and the staff id on the payment are the right ones.
 */
export const staffSwitchSchema = z.object({
  pin: pinSchema,
});
export type StaffSwitchInput = z.infer<typeof staffSwitchSchema>;

/* ---------------------------------------------------------------- identity */

/**
 * Who is calling, as every route sees them and as `GET /auth/me` answers.
 *
 * Two claims, not one. The device is the credential and is always present; the
 * staff member is who is currently standing at it and may not be. A tablet with
 * nobody signed in can still ask what it is — that is the PIN screen — and can
 * do nothing else.
 *
 * The three staff fields are `null` here, never absent. That is deliberately
 * *not* what the token does: the claim set omits `staff`, `sname` and `role`
 * entirely when no one is signed in, because a token is bytes on the wire and
 * a key that means nothing should not be in it. This object is a JSON shape a
 * client destructures, and a key that appears and disappears is the kind of
 * thing that type-checks on Tuesday and throws on Friday.
 */
export const identitySchema = z.object({
  deviceId: idSchema,
  deviceName: z.string(),
  staffId: idSchema.nullable(),
  staffName: z.string().nullable(),
  role: staffRoleSchema.nullable(),
});
export type Identity = z.infer<typeof identitySchema>;

/**
 * What `POST /auth/claim`, `POST /staff/switch` and `POST /staff/signout` all
 * answer with.
 *
 * The token comes back in the body as well as in the `Set-Cookie`, because the
 * API and the app do not have to share an origin — the cookie is the
 * same-origin convenience and the bearer token is the thing that always works.
 * All three routes re-mint rather than patch: a token carries the staff claim,
 * so signing somebody out means issuing a new token without it, not deleting
 * anything.
 */
export const authResultSchema = z.object({
  token: z.string(),
  identity: identitySchema,
});
export type AuthResult = z.infer<typeof authResultSchema>;

/**
 * `GET /auth/me` — the session bootstrap, and the only place the client learns
 * the currency and the timezone. See `config.ts` for why they are served rather
 * than mirrored into the frontend build.
 */
export const meSchema = z.object({
  identity: identitySchema,
  config: appConfigSchema,
});
export type Me = z.infer<typeof meSchema>;
