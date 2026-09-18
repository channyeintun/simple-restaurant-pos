import type { PrintJobStatus } from '@pos/shared';
import { useQuery } from '@tanstack/solid-query';
import { listDevices, listRoster, salesToday } from '../api/admin.js';
import { getCheck, getTableCheck, listOpenChecks, listPrintJobs } from '../api/orders.js';
import { me } from '../api/auth.js';
import { listCategories, listProducts, listTables } from '../api/catalogue.js';
import { ApiError } from '../api/client.js';
import { listStaff } from '../api/staff.js';

/**
 * Every cached read in the app.
 *
 * ## `useQuery` is handed a function here, never an object
 *
 * `useQuery(() => ({ queryKey, queryFn }))`. Solid's adapter takes a function
 * that *returns* the options, and every query in this file is written that way.
 * Passing the object directly — `useQuery({ queryKey, queryFn })`, which is
 * what the React version takes and what muscle memory will type — compiles,
 * runs and returns data, and that is exactly what makes it dangerous. The
 * options are read once and never again, so a query whose key is built from a
 * signal keeps answering for whatever that signal held on the first pass: open
 * table 4 after table 3 and the screen shows table 3's check, with nothing
 * thrown and nothing logged. It reads as a caching bug and it is a syntax one.
 *
 * The arrow is also what lets `enabled`, `staleTime` and the rest be computed
 * from signals, because it is re-run inside a reactive scope. Every read in
 * this file is written that way; copy the shape when adding one.
 *
 * ## Where this sits
 *
 * TanStack Query sits *above* the transport: everything under `src/api` is
 * still plain `fetch` behind the platform seam, and these functions only decide
 * when to call it. That keeps the data layer portable — the printer agent and
 * any future shell can reuse `src/api` without solid-query coming along.
 *
 * ## Why this replaced fetch-on-mount
 *
 * Fetching in a lifecycle hook starts every mount with no data, so moving
 * between screens means a spinner every single time even though the answer had
 * been on screen a second earlier — and on a tablet at the pass, a spinner is a
 * waiter standing still. The fix is two things together: a cache that outlives
 * the screen, and rendering the spinner on `isPending` — "we have nothing to
 * show" — rather than on `isFetching`, which is also true during the background
 * refresh of data already drawn.
 *
 * `staleTime` is then just "how long before a revisit bothers to refetch",
 * chosen per query by how fast the thing actually changes. Anything the
 * cashier's stream touches can afford a long one, because an event corrects it
 * sooner than a refetch would — and every event payload is self-sufficient, so
 * the correction is a `setQueryData` rather than another request.
 */

/* ------------------------------------------------------------------- keys */

export const queryKeys = {
  /**
   * The session bootstrap — identity *and* config, because one response
   * carries both.
   *
   * Anything that re-mints the token has the new identity in its hand already:
   * `claimDevice`, `switchStaff` and `signOutStaff` all answer with it. Write
   * it in with `setQueryData` — `(prev) => prev && { ...prev, identity }`,
   * keeping the config, which cannot have changed — rather than invalidating.
   * Invalidating would spend a second request asking the Worker for something
   * the first request already said, on the screen where somebody is waiting to
   * start taking orders.
   */
  me: ['me'] as const,
  /** The names on the PIN screen. The backoffice's staff editor invalidates it. */
  staff: ['staff'] as const,

  /*
   * The catalogue, keyed by *which* list it is.
   *
   * `includeRetired` is in the key because it is two different answers from one
   * route, not one answer filtered: the retired rows are simply not in the
   * short list, so a screen holding the short one cannot render the long one by
   * filtering less. Keeping them apart also means the waiter's cached menu is
   * untouched when a manager opens the backoffice on the same tablet.
   */
  tables: (includeRetired: boolean) => ['tables', includeRetired] as const,
  categories: (includeRetired: boolean) => ['categories', includeRetired] as const,
  products: (includeRetired: boolean) => ['products', includeRetired] as const,

  /** The full roster, admin-only. Not {@link queryKeys.staff}, which is the
   *  PIN screen's three columns and a different audience. */
  roster: ['staff', 'roster'] as const,
  devices: ['devices'] as const,
  salesToday: ['reports', 'sales', 'today'] as const,

  /*
   * Ordering.
   *
   * `openChecks` is one list read by two screens — the cashier's board and the
   * waiter's table grid — which is deliberate: two nearly identical lists would
   * be two things to keep in step, and one of them would eventually say a table
   * was free when it was not.
   *
   * `tableCheck` and `check` are separate keys for the same row, and that is
   * *not* redundancy. The waiter asks "what is open on table 4", which has
   * `null` as a perfectly good answer, and the cashier asks "show me check
   * chk_x", which does not. Collapsing them would mean one of the two callers
   * had to hold an id it does not have.
   */
  openChecks: ['checks', 'open'] as const,
  tableCheck: (tableId: string) => ['checks', 'by-table', tableId] as const,
  check: (checkId: string) => ['checks', checkId] as const,
  printJobs: (status: PrintJobStatus) => ['print-jobs', status] as const,
};

/**
 * Both halves of a catalogue list, for a screen that has just changed one.
 *
 * An edit in the backoffice touches the long list it is looking at *and* the
 * short one the waiter screen on the same tablet is holding, and the two are
 * separate cache entries by design. Rather than have each editor remember to
 * invalidate a key it does not otherwise mention, they invalidate the prefix —
 * `['products']` matches `['products', true]` and `['products', false]` both.
 */
export const catalogueRoot = {
  tables: ['tables'] as const,
  categories: ['categories'] as const,
  products: ['products'] as const,
};

/* ----------------------------------------------------------------- policy */

/**
 * A 401 is an answer, not a failure.
 *
 * It means this tablet has never been claimed, or its claim has been revoked,
 * and the only thing to do about it is show the claim screen. TanStack's
 * default is three attempts with backoff, which spends three requests and the
 * best part of three seconds arriving at the same conclusion — in front of
 * somebody who has just picked up a tablet to start a shift. So auth errors are
 * taken at their word, and everything that might genuinely be transient — a
 * cold Worker, the kitchen wifi — still gets the default backoff.
 */
const retryUnlessUnauthorized = (failureCount: number, error: Error): boolean =>
  !(error instanceof ApiError && error.isAuthError) && failureCount < 3;

/* --------------------------------------------------------------- identity */

/**
 * Who this tablet is, who is standing at it, and how this restaurant writes
 * money and time.
 *
 * The app shell reads this before it draws anything else, and it is the only
 * place the currency and the timezone come from — see `shared/src/config.ts`
 * for why they are served rather than baked into the build.
 *
 * Cached hard, because nothing outside this app can change the answer. The
 * identity moves only through the three routes above, each of which writes the
 * new value in; the config moves only when somebody edits `wrangler.jsonc` and
 * deploys. Five minutes is how long a tablet may go on quoting the old symbol
 * after a currency change, which is a thing that happens approximately never
 * and is survivable when it does.
 */
export function useMe() {
  return useQuery(() => ({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => me(signal),
    staleTime: 5 * 60_000,
    retry: retryUnlessUnauthorized,
  }));
}

/* ------------------------------------------------------------------ staff */

/**
 * The names for the PIN screen.
 *
 * A dozen rows that change when somebody is hired or leaves, which is why it is
 * cached for five minutes rather than refetched each time the screen opens —
 * and that screen opens at the start of every shift and after every sign-out,
 * with a person standing in front of it. The backoffice's staff editor, when
 * invalidates {@link queryKeys.staff} whenever it changes the roster.
 *
 * `enabled` is deliberately absent. Reaching this screen at all means the
 * device token is in hand; if it is not, the 401 that comes back is how the
 * shell finds out, and guarding the call would only replace an answer with
 * silence.
 */
export function useStaff() {
  return useQuery(() => ({
    queryKey: queryKeys.staff,
    queryFn: ({ signal }) => listStaff(signal),
    staleTime: 5 * 60_000,
    retry: retryUnlessUnauthorized,
  }));
}

/* -------------------------------------------------------------- catalogue */

/*
 * Cached for five minutes, which is a long time for a list somebody is editing
 * and exactly right for one nobody is.
 *
 * The menu changes a handful of times a month and is read on every screen in
 * the app, so the default — refetch whenever a component mounts — would spend a
 * request every time a waiter walks back to a table. The editors do not rely on
 * the timer: each one writes its result in with `setQueryData` and invalidates
 * the other half of the pair, so an edit is on screen before the response has
 * finished being parsed.
 */
const CATALOGUE_STALE_MS = 5 * 60_000;

export function useTables(includeRetired = false) {
  return useQuery(() => ({
    queryKey: queryKeys.tables(includeRetired),
    queryFn: ({ signal }) => listTables(includeRetired, signal),
    staleTime: CATALOGUE_STALE_MS,
    retry: retryUnlessUnauthorized,
  }));
}

export function useCategories(includeRetired = false) {
  return useQuery(() => ({
    queryKey: queryKeys.categories(includeRetired),
    queryFn: ({ signal }) => listCategories(includeRetired, signal),
    staleTime: CATALOGUE_STALE_MS,
    retry: retryUnlessUnauthorized,
  }));
}

export function useProducts(includeRetired = false) {
  return useQuery(() => ({
    queryKey: queryKeys.products(includeRetired),
    queryFn: ({ signal }) => listProducts(includeRetired, signal),
    staleTime: CATALOGUE_STALE_MS,
    retry: retryUnlessUnauthorized,
  }));
}

/* ------------------------------------------------------------- backoffice */

/**
 * The roster and the tablet list.
 *
 * A minute rather than the catalogue's five. These are the two lists a manager
 * edits *while looking at them* — hiring somebody, minting a link, watching for
 * a tablet to report itself set up — and the last of those is the one that
 * matters: `claimedAt` changes because somebody walked to another room and
 * opened a link, so it is the one thing on this screen that can change without
 * this screen having caused it.
 */
const BACKOFFICE_STALE_MS = 60_000;

export function useRoster() {
  return useQuery(() => ({
    queryKey: queryKeys.roster,
    queryFn: ({ signal }) => listRoster(signal),
    staleTime: BACKOFFICE_STALE_MS,
    retry: retryUnlessUnauthorized,
  }));
}

export function useDevices() {
  return useQuery(() => ({
    queryKey: queryKeys.devices,
    queryFn: ({ signal }) => listDevices(signal),
    staleTime: BACKOFFICE_STALE_MS,
    retry: retryUnlessUnauthorized,
  }));
}

/**
 * The day's takings.
 *
 * Thirty seconds, because this is the one figure in the backoffice that moves
 * on its own: every payment the cashier takes changes it, and a manager who
 * opens this screen during service is asking what it is *now*. It is still a
 * cache rather than a poll — nothing refetches while the screen sits untouched,
 * and re-opening the tab within half a minute costs nothing.
 */
export function useSalesToday() {
  return useQuery(() => ({
    queryKey: queryKeys.salesToday,
    queryFn: ({ signal }) => salesToday(signal),
    staleTime: 30_000,
    retry: retryUnlessUnauthorized,
  }));
}

/* -------------------------------------------------------------- ordering */

/**
 * Every open check.
 *
 * `staleTime: 0`, which is the opposite of everything above it and is right:
 * this is the one list in the app that changes because of something somebody
 * else did. A waiter walking back to the tables grid wants to know that table 6
 * was paid two minutes ago, and the cashier's board is the whole subject of the
 * realtime stream.
 *
 * Refetching is still not how either screen stays current. The cashier applies
 * events with `setQueryData` and the waiter writes the response of its own send
 * in; `staleTime: 0` only decides what happens when a screen is *re-entered*,
 * which for a waiter is every time they walk back from a table.
 */
export function useOpenChecks() {
  return useQuery(() => ({
    queryKey: queryKeys.openChecks,
    queryFn: ({ signal }) => listOpenChecks(signal),
    staleTime: 0,
    retry: retryUnlessUnauthorized,
  }));
}

/**
 * The open check on one table, or null when it is free.
 *
 * The accessor is not decoration. `useQuery` is handed a **function** returning
 * the options, and the key is built inside it, so walking from table 3 to table
 * 4 re-keys the query and refetches. Passing a plain object — which is what the
 * React version takes and what muscle memory types — would read `tableId` once
 * and go on answering with table 3's check forever, silently. `lib/queries.ts`
 * opens with that warning because this is the query it was written about.
 *
 * This single request is why a waiter tablet subscribes to nothing. A waiter is
 * looking at one table and has just caused the change they are looking at; an
 * open SSE connection would be 360 Upstash commands an hour per tablet, against
 * a budget that has room for exactly one such connection in the building.
 */
export function useTableCheck(tableId: () => string | null) {
  return useQuery(() => ({
    queryKey: queryKeys.tableCheck(tableId() ?? ''),
    queryFn: ({ signal }) => getTableCheck(tableId() as string, signal),
    enabled: tableId() !== null,
    staleTime: 0,
    retry: retryUnlessUnauthorized,
  }));
}

/**
 * One check by id.
 *
 * The cashier opens a card and the waiter reloads on `/waiter/check/chk_x`;
 * both land here. It is a separate hook from {@link useTableCheck} rather than
 * the same one with a different key, because the two questions have different
 * answers: "what is open on table 4" may legitimately be nothing, and "show me
 * this check" may not.
 *
 * The accessor again, and for the reason at the top of this file: the key is
 * built inside the options function, so moving from one check to the next
 * re-keys the query. A plain object would go on answering with the first one.
 */
export function useCheck(checkId: () => string | null) {
  return useQuery(() => ({
    queryKey: queryKeys.check(checkId() ?? ''),
    queryFn: ({ signal }) => getCheck(checkId() as string, signal),
    enabled: checkId() !== null,
    staleTime: 0,
    retry: retryUnlessUnauthorized,
  }));
}

/**
 * The print queue, in one status.
 *
 * `failed` is the cashier's red banner and is polled on the same fallback
 * cadence as the rest of that screen; `print_job.failed` on the stream is what
 * normally raises it, and this is the backstop for a tablet whose stream is
 * down — which is exactly when a printer problem is most likely to go unnoticed.
 */
export function usePrintJobs(status: PrintJobStatus, enabled = true) {
  return useQuery(() => ({
    queryKey: queryKeys.printJobs(status),
    queryFn: ({ signal }) => listPrintJobs(status, signal),
    enabled,
    staleTime: 0,
    retry: retryUnlessUnauthorized,
  }));
}
