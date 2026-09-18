import { useQuery } from '@tanstack/solid-query';
import { listDevices, listRoster, salesToday } from '../api/admin.js';
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
 * from signals, because it is re-run inside a reactive scope. Every milestone
 * after this one adds reads here; copy the shape of the two below.
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
 * milestone 1 brings it, invalidates {@link queryKeys.staff}.
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
