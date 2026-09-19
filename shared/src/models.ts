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
 * The ten domain models are all here because they are the shape of the database
 * and a reader should be able to see the whole thing in one file. A request
 * payload, by contrast, arrives with the route that parses it: an unused schema
 * is a guess about a route nobody has written yet, and it will be wrong.
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

/**
 * Roughly how long a dish takes, in minutes.
 *
 * A number a manager types, not a measurement, and the app treats it as such:
 * it is what the waiter quotes to the customer and what "late" is measured
 * against, never a promise. Ten hours is the ceiling — far past anything a
 * restaurant kitchen does in one service, and there so that a mistyped `150`
 * meant as `15` is caught by something rather than turning every round amber
 * for the rest of the evening.
 *
 * Zero is allowed and means instant: a bottle of water off the shelf. It makes
 * the round it is on due the moment it is sent, which is correct.
 */
export const prepMinutesSchema = z.number().int().min(0).max(600);

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

/**
 * Hiring somebody, from the backoffice roster.
 *
 * No PIN. It is a separate route and a separate schema below, because setting
 * one is a different act from adding a person: the hash can only be computed
 * where `AUTH_SECRET` is, a PIN is changed far more often than a name, and a
 * create body carrying four digits is four digits in whatever log captured the
 * request that created the row.
 *
 * So a new member of staff starts with `pin_hash` NULL and cannot sign in
 * anywhere until an admin sets one. That is the honest state — the roster knows
 * they work here, the tablets do not yet know their digits — and the roster
 * screen says so beside the name rather than leaving it to be discovered at the
 * keypad.
 */
export const createStaffSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(40),
  role: staffRoleSchema,
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

/**
 * Renaming somebody, changing what they may do, or striking them off.
 *
 * `active: false` is the only way a person leaves. Their name is snapshotted on
 * no check — a round carries `sent_by`, an id — so deleting the row would
 * leave last month's takings pointing at nothing, and `ON DELETE RESTRICT` in
 * `0001_init.sql` refuses it anyway.
 */
export const updateStaffSchema = createStaffSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

/**
 * The roster, as the backoffice shows it: everybody, including the people who
 * have left, plus the one thing about a PIN that may be told.
 *
 * Written out rather than `staffSchema.extend({ hasPin })`, for the reason
 * {@link staffNameSchema} is written out and for one more: `.extend()` appends,
 * and field order is output order here, so the flag would land after
 * `createdAt` instead of beside the other things that are true about a person
 * now. The order below is the order the roster row reads in.
 *
 * `hasPin` is a boolean and can never be anything else. It is `pin_hash IS NOT
 * NULL` computed in SQL, so the hash is not selected, is not on a struct, and
 * cannot be serialized by somebody adding a field to this screen later. What an
 * admin needs to know is whether this person can sign in at all; the digits are
 * not recoverable by anybody, including the admin, and that is the design
 * rather than a limitation of it.
 */
export const staffRosterSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  role: staffRoleSchema,
  active: z.boolean(),
  hasPin: z.boolean(),
  createdAt: isoSchema,
});
export type StaffRosterEntry = z.infer<typeof staffRosterSchema>;

/**
 * Setting or replacing somebody's four digits is {@link setPinSchema}, and it
 * is declared down in the auth section rather than here.
 *
 * Not for tidiness: `pinSchema` is declared there, a `const` is not hoisted,
 * and a schema up here that referenced one down there would throw at module
 * evaluation rather than fail a type check. The two PIN bodies — the one an
 * admin sets and the one a waiter taps — are held to the same shape by sharing
 * that declaration, so they live beside it.
 */

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

/**
 * Adding a tablet to the restaurant.
 *
 * A name and nothing else. The row starts unclaimed with no nonce on it, and
 * minting the link is a second call — because a device row and an invitation
 * have different lifetimes: a link expires and is replaced, often more than
 * once ("send it again, I lost the message"), while the tablet it names stays
 * the same tablet for as long as it is in the building.
 */
export const createDeviceSchema = z.object({
  name: z.string().trim().min(1, 'Device name is required').max(40),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

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
  /** Roughly how long it takes. Snapshotted onto the item at send time. */
  prepMinutes: prepMinutesSchema,
  sort: sortSchema,
  active: z.boolean(),
});
export type Product = z.infer<typeof productSchema>;

export const createProductSchema = z.object({
  categoryId: idSchema,
  name: z.string().trim().min(1, 'Product name is required').max(60),
  priceMinor: minorSchema,
  /** Omitted means ten minutes — the column's own default. */
  prepMinutes: prepMinutesSchema.optional(),
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

/**
 * One tap of **Send to kitchen**.
 *
 * The client posts this to `/rounds` — not to `/checks/:id/rounds` — and the
 * difference is the whole design of the route. On the first send of a seating
 * there is no check id yet, and an "open the table first" step would create the
 * state this schema says does not exist: a check with no rounds on it, sitting
 * open because somebody tapped a table and walked away. **The table is the
 * identity**, and the Worker opens a check for it if there is not one already.
 */
export const sendRoundSchema = z.object({
  /**
   * The table this round is for, or null.
   *
   * Exactly one of `tableId` and `checkId` may be given, and the three cases
   * are the three ways a round starts:
   *
   *   * a **table** — the usual one. The Worker finds the table's open check or
   *     opens one, atomically, so two waiters tapping Send on table 4 in the
   *     same second end up with one bill and two tickets rather than two bills
   *     and half the food on each.
   *   * a **check** — adding to a takeaway order that is already open. A
   *     takeaway check has no table to find it by, so the client names it.
   *   * **neither** — a new takeaway or counter sale, which opens a check with
   *     no table under it. There can be any number of those at once, which is
   *     why `idx_checks_open_table` exempts NULL.
   */
  tableId: idSchema.nullable(),
  /** The open check to add to, for a takeaway order that has one. */
  checkId: idSchema.nullable(),
  /**
   * The key this tablet minted when the button was pressed, and re-sends
   * unchanged if it has to ask again.
   *
   * It exists for one failure: the request commits and the reply is lost on the
   * way back. The tablet cannot tell that from a request that never arrived,
   * and the two need opposite responses — retrying the first prints the food
   * twice, not retrying the second means nobody cooks it. So the tablet decides
   * once, and the Worker recognises the repeat. `0002_send_and_void.sql` is the
   * unique index that makes it true even for two copies in flight at once.
   *
   * Minted per **attempt**, not per retry: regenerating it on the Retry button
   * is exactly the bug this prevents.
   */
  clientKey: z.string().min(8).max(64),
  /**
   * What to cook. At least one line — a round with nothing on it is a blank
   * slip of paper in the kitchen — and the prices are deliberately not here:
   * the Worker reads them from the menu and snapshots them, so a tablet holding
   * yesterday's cached prices cannot charge yesterday's prices.
   */
  items: z
    .array(
      z.object({
        productId: idSchema,
        qty: z.number().int().min(1).max(99),
        note: z.string().max(120).nullable(),
      }),
    )
    .min(1, 'Add something to the order first')
    .max(60),
});
export type SendRoundInput = z.infer<typeof sendRoundSchema>;

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
  /**
   * Null when the product row it came from has been cleaned out by hand.
   *
   * `items.product_id` is `ON DELETE SET NULL` — see `0001_init.sql` — and the
   * snapshots below are what make that safe: the line still reads and still
   * totals with nothing behind it. Declaring it non-null here would mean one
   * deleted product turns a whole check into a parse failure on the cashier's
   * screen, which is a worse outcome than a line that cannot be traced back to
   * the menu.
   */
  productId: idSchema.nullable(),
  nameSnapshot: z.string().min(1).max(60),
  priceMinorSnapshot: minorSchema,
  /**
   * What this dish was expected to take **when the round was sent**.
   *
   * Snapshotted for the same reason the name and the price are: a round sent at
   * six should not become retrospectively late because somebody edited a prep
   * time at seven. It also survives a product row being cleaned out by hand,
   * which `productId` above does not.
   */
  prepMinutesSnapshot: prepMinutesSchema,
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

/**
 * Settling a check: how the money arrived, and what the cashier believed the
 * total to be.
 *
 * `expectedTotalMinor` is not belt and braces. A cashier reads a total off the
 * screen, takes that much cash, and taps Take payment — and in between, a
 * waiter at the table can send another round or void a line. Without this the
 * check closes at whatever it happens to come to now, which is a customer
 * charged for a dish they did not order or a dish given away. With it, the
 * Worker refuses and the screen shows the new figure, which is the only honest
 * thing to do: the person holding the money has to agree with the number.
 *
 * The amount taken is **not** in the body. It is the check's own total,
 * computed by the Worker, so there is no route by which a client can decide
 * what a customer paid.
 */
export const payCheckSchema = z.object({
  method: paymentMethodSchema,
  expectedTotalMinor: minorSchema,
});
export type PayCheckInput = z.infer<typeof payCheckSchema>;

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

/**
 * What a ticket says, as the Worker renders it and the agent prints it.
 *
 * The rendering rules live twice — `shared/src/ticket.ts` and
 * `api/core/src/ticket.rs` — and this is the wire shape they both produce. It
 * carries **no prose**: a round number, a table, a time, a name and some lines.
 * The words around them come from the i18n catalogue at the moment of printing,
 * which is what lets the ticket be printed in Burmese without either half of
 * the twin holding a message catalogue.
 */
export const ticketDocSchema = z.object({
  kind: printJobKindSchema,
  seq: z.number().int().min(1),
  /** The table's name, or null for takeaway. */
  table: z.string().nullable(),
  /** `19:30`, already in the restaurant's own offset. */
  time: z.string(),
  staff: z.string(),
  lines: z.array(
    z.object({
      qty: z.number().int().min(1),
      name: z.string(),
      note: z.string().nullable(),
    }),
  ),
});

/**
 * A pending job, with everything needed to print it or to complain about it.
 *
 * One shape for two readers, which is unusual here and is the right call: the
 * printer agent polls this to get something to print, and the cashier's failure
 * banner reads the same list to say which table's food the kitchen never heard
 * about. They want the same facts — which round, which table, what went wrong —
 * and a second, nearly identical shape would be one more place for the two to
 * disagree about what a stuck ticket is.
 *
 * Carrying the rendered `ticket` is what keeps the agent free of rules
 * entirely: it holds no schema, no totals and no idea what a round is. A doc
 * comes in and ESC/POS bytes go out.
 */
export const printJobViewSchema = z.object({
  id: idSchema,
  roundId: idSchema,
  kind: printJobKindSchema,
  status: printJobStatusSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().max(300).nullable(),
  createdAt: isoSchema,
  printedAt: isoSchema.nullable(),
  /** So the cashier's banner can name the table rather than a job id. */
  tableId: idSchema.nullable(),
  tableName: z.string().nullable(),
  ticket: ticketDocSchema,
});
export type PrintJobView = z.infer<typeof printJobViewSchema>;

/**
 * The agent saying it could not print.
 *
 * `printFailureSchema` and not `printJobFailedSchema`, which `events.ts`
 * already has: that one is the realtime payload the cashier's banner is raised
 * by, and this is the request body that may eventually cause it. They are two
 * ends of the same event and sharing a name would make the barrel ambiguous —
 * which is how the clash was found, and it is a fair warning rather than a
 * technicality.
 *
 * `error` is nullable because a printer can fail without saying anything useful
 * — a socket that simply never opened — and a banner that waits for a good
 * message is a banner that never appears.
 */
export const printFailureSchema = z.object({
  error: z.string().max(300).nullable(),
});
export type PrintFailureInput = z.infer<typeof printFailureSchema>;

/**
 * Compile-time proof that {@link ticketDocSchema} says exactly what
 * `renderTicket` produces.
 *
 * The schema is here because it is a wire model and this is where wire models
 * live; the type is in `ticket.ts` because that is where the rule that produces
 * it lives. This is the line that stops the two drifting — add a field to the
 * doc and forget the schema, and the build fails here rather than the agent
 * silently printing a ticket with a piece missing.
 *
 * The import is type-only, so it is erased and cannot make a runtime cycle
 * between these two modules.
 */
type TicketDocIsTheSchema = Assert<
  Exact<z.infer<typeof ticketDocSchema>, import('./ticket.js').TicketDoc>
>;
export type { TicketDocIsTheSchema };

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/* ------------------------------------------------------- what a screen reads */

/*
 * The three shapes below are not tables. They are what a screen needs in one
 * response, assembled by the Worker out of several — and they exist because the
 * alternative is a tablet issuing four requests to draw one card and then
 * joining the results itself, which is four times the free tier's request
 * budget to arrive at the same picture more slowly and with more ways to be
 * half-right.
 *
 * Every id that a screen would have to resolve against another list arrives
 * with its name beside it, for the same reason the realtime payloads carry
 * names: the cashier's board has no roster to look a `staff_id` up in, and a
 * dash where a waiter's name should be is worse than the extra column.
 */

/**
 * One open check, as a card on the cashier's board and a tile in the waiter's
 * table grid.
 *
 * Deliberately not the whole check. A board shows ten of these at once and
 * needs four facts about each; sending every line of every one of them would be
 * the entire evening's ordering on a screen where none of it is legible.
 */
export const checkSummarySchema = z.object({
  id: idSchema,
  tableId: idSchema.nullable(),
  /** Null for takeaway, where the screen shows its own word instead. */
  tableName: z.string().nullable(),
  openedByName: z.string(),
  openedAt: isoSchema,
  /** How many rounds have gone to the kitchen. Roughly how far along they are. */
  roundCount: z.number().int().min(0),
  /**
   * How many of those are still out, and the oldest one's clock.
   *
   * Three fields rather than a computed state, because "late" depends on the
   * current second and a response cannot carry that — the tile works it out
   * with `roundTiming` and re-renders on a timer. Zero and nulls mean
   * everything has been delivered, which is a table waiting for its bill
   * rather than for its food.
   */
  outstandingRounds: z.number().int().min(0),
  oldestOutstandingAt: isoSchema.nullable(),
  oldestOutstandingTargetMinutes: prepMinutesSchema,
  /** Live lines only — a voided line is on the paper trail, not on the bill. */
  totalMinor: minorSchema,
});
export type CheckSummary = z.infer<typeof checkSummarySchema>;

/** A round with its lines, in the order they were sent. */
export const roundDetailSchema = z.object({
  id: idSchema,
  seq: z.number().int().min(1),
  sentByName: z.string(),
  sentAt: isoSchema,
  /**
   * When the food reached the table, and who carried it. Null while it is
   * still out, which is what every timer in the app reads.
   *
   * Set by the waiter on their own tablet — it is the one moment in this flow
   * software cannot observe and a person can. The kitchen has a printer, not a
   * screen, and touches none of this.
   */
  deliveredAt: isoSchema.nullable(),
  deliveredByName: z.string().nullable(),
  /**
   * How long this round should take: the slowest dish on it. Computed by the
   * Worker with `round_target_minutes`, whose TypeScript twin the browser uses
   * to draw the countdown.
   */
  targetMinutes: prepMinutesSchema,
  items: z.array(itemSchema),
});
export type RoundDetail = z.infer<typeof roundDetailSchema>;

/**
 * One check, entire: what every route that changes one answers with.
 *
 * Sending a round, voiding a line and taking payment all reply with this rather
 * than with `{ ok: true }`, and that is what lets the screen apply the result
 * without a follow-up request — the same principle the realtime payloads are
 * built on, applied to the response a client already has open.
 */
export const checkDetailSchema = z.object({
  id: idSchema,
  tableId: idSchema.nullable(),
  tableName: z.string().nullable(),
  openedBy: idSchema,
  openedByName: z.string(),
  status: checkStatusSchema,
  openedAt: isoSchema,
  closedAt: isoSchema.nullable(),
  rounds: z.array(roundDetailSchema),
  payments: z.array(paymentSchema),
  totalMinor: minorSchema,
});
export type CheckDetail = z.infer<typeof checkDetailSchema>;

/* ----------------------------------------------------------------- reports */

/**
 * The only report this app has: what the restaurant took today.
 *
 * "Today" is the restaurant's day, not the Worker's. It runs from local
 * midnight — `TZ_OFFSET_MINUTES` minutes ahead of UTC — to the same instant
 * tomorrow, which is why a sale rung up at five past midnight belongs to the
 * new day rather than to the shift that was still clearing tables. `time.ts`
 * has the arithmetic and the twin tests; this is the shape it comes back in.
 *
 * `dayStart` and `dayEnd` are carried rather than left for the client to work
 * out. They are the window the Worker actually summed over, so a screen that
 * shows "since 00:00" is quoting the query rather than guessing at it — and the
 * day somebody changes the offset, the number and the window it covers move
 * together instead of one of them being six and a half hours out.
 *
 * The three totals are separate because a cashier counting a drawer at close
 * cares about the cash line specifically, and adding the card takings into it
 * makes the drawer wrong by exactly the amount that was never in it.
 */
export const salesTodaySchema = z.object({
  dayStart: isoSchema,
  dayEnd: isoSchema,
  /** Every payment in the window, whatever the method. */
  totalMinor: minorSchema,
  /** How it arrived, so a drawer can be counted against the cash line alone. */
  byMethod: z.object({
    cash: minorSchema,
    card: minorSchema,
    other: minorSchema,
  }),
  /** How many checks were settled, which is roughly how many tables ate. */
  checkCount: z.number().int().min(0),
});
export type SalesToday = z.infer<typeof salesTodaySchema>;

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

/**
 * An admin setting or replacing somebody's four digits, from the roster.
 *
 * The same {@link pinSchema} as the keypad above, and sharing that declaration
 * is the point: the digits that are stored and the digits that are typed have
 * to be the same shape, and the length is load-bearing rather than cosmetic —
 * `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` concatenates the two with no
 * separator, which is unambiguous only because a PIN is always exactly four
 * characters. Widen one side and two different pairs can hash to one message.
 *
 * There is no route that reads a PIN back. `pin_hash` is the one column in the
 * schema that must not leave the Worker, and it is a keyed hash rather than the
 * digits anyway — so the roster shows "PIN set" or "No PIN" beside a name and
 * offers to replace it, which is the whole of what an admin can do about one
 * somebody has forgotten.
 */
export const setPinSchema = z.object({
  pin: pinSchema,
});
export type SetPinInput = z.infer<typeof setPinSchema>;

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
