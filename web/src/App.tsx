import type { Messages } from '@pos/shared';
import { Navigate, type RouteSectionProps, useLocation } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { ApiError, getToken, onUnauthorized } from './api/client.js';
import { queryKeys, useMe } from './lib/queries.js';
import { LanguageToggle } from './components/LanguageToggle.js';
import { platform } from './platform/index.js';
import { useLocale } from './state/locale.js';

/**
 * The shell: which of the things a tablet can be, it currently is.
 *
 * A device running this app is in one of three states, and almost every
 * question a page might ask about auth is really a question about which one:
 *
 *   1. **Not a staff device.** No token, or a token the Worker no longer
 *      accepts. There is deliberately no way out of this state from inside the
 *      app — no sign-up, no "enter a code", nothing to press. A manager mints a
 *      claim link in the backoffice and opens it *on this tablet*, and that is
 *      the only way in. That is not an omission to be fixed later: the device
 *      cookie is what keeps a stranger's phone out of the till, so a
 *      self-service door would be the hole in the one wall that exists.
 *   2. **Claimed, nobody signed in.** The tablet is known, but the token
 *      carries no staff claim, so nothing can be sent to the kitchen and
 *      nothing can be paid. Straight to the PIN screen.
 *   3. **Somebody is on.** Render the routes.
 *
 * There is a fourth screen and it is not a state of the tablet but of the
 * question: the bootstrap asked and did not get an answer. `api/auth.ts`'s
 * `me()` rejects rather than resolving null precisely so this can be told
 * apart — "this tablet has never been claimed" is an answer and gets the gate,
 * "the kitchen wifi dropped again" is a missing one and gets a retry.
 * Collapsing them would put "ask the manager for a device link" in front of
 * somebody whose tablet is perfectly well set up.
 *
 * ## Where the session lives
 *
 * In the query cache, under `queryKeys.me`, and nowhere else. The shell reads
 * it through `useMe()` and so does every page that needs the currency, the
 * offset or the name of whoever is signed in — one copy, one cache entry, and
 * a screen that re-mints the token (the claim page, the PIN pad) writes the new
 * identity in with `setQueryData` and every reader sees it on the next tick.
 *
 * A signal held here instead would have been the obvious thing and is the
 * wrong thing: the PIN screen would then have to tell *two* places it had
 * signed somebody in, and the day it tells only one, the tablet either stays on
 * the keypad after a correct PIN or draws a waiter's screen for nobody.
 */

/**
 * How long the boot splash may stay up, whatever the network is doing.
 *
 * `index.html` paints it before the bundle runs and it covers the whole
 * viewport, so the one thing it must never do is outlive a boot that is not
 * coming back. Comfortably past the single request a cold launch makes on the
 * restaurant's own wifi, and short enough that a stalled one drops through to
 * the app's own screens — which can at least say something — while the person
 * holding the tablet is still expecting something to happen.
 */
const SPLASH_CAP_MS = 2500;

export function App(props: RouteSectionProps) {
  /*
   * Whether there was a credential worth waiting for, sampled once before the
   * first request goes out.
   *
   * With no stored token the gate goes up immediately instead of parking a
   * tablet on a splash while a request that is certain to 401 goes out and
   * comes back. The query still runs underneath, which recovers the rarer case
   * of a live auth cookie with no token beside it — a same-origin deployment,
   * or storage the browser cleared — and if it does come back with an identity
   * the gate is replaced by the app.
   */
  const hadToken = getToken() !== null;

  const session = useMe();
  const queryClient = useQueryClient();
  const location = useLocation();

  /*
   * The language, from the one signal that holds it.
   *
   * Read through `useLocale()` rather than worked out here from the device
   * setting, so that the shell's own screens follow the switcher like every
   * other screen does. They are exactly the screens that need to: a tablet that
   * has not been claimed shows nothing *but* shell, so a manager who cannot
   * read the English on it has to be able to change the language from there.
   *
   * `m` is an accessor and is called at the point of use. Solid compiles a JSX
   * prop into a getter, so `m={m()}` below re-reads on a change rather than
   * capturing the catalogue that happened to be current at mount.
   */
  const { m } = useLocale();

  /** True once there is a screen worth drawing behind the splash. */
  const ready = () => !(session.isPending && hadToken);
  const identity = () => session.data?.identity ?? null;
  const staffSignedIn = () => identity()?.staffId != null;

  /**
   * The bootstrap failed in a way that is nobody's answer.
   *
   * A 401 is excluded because it *is* an answer: the tablet has never been
   * claimed, or the claim was revoked, and `client.ts` has already dropped the
   * dead token on the way past. Everything else — no network, a Worker that is
   * cold or down, a response that did not match the schema — leaves the
   * question open, and only matters when there was a credential worth asking
   * about: a tablet with no token has already been told what to do, and a
   * network error does not change the instruction.
   */
  const unreachable = (): ApiError | null => {
    if (!session.isError || !hadToken) return null;
    const error: unknown = session.error;
    if (error instanceof ApiError && error.isAuthError) return null;
    return error instanceof ApiError ? error : new ApiError(0, 'unknown', String(error));
  };

  /*
   * Whether the boot has gone on long enough to be worth showing.
   *
   * Under the cap there is nothing to draw — the splash is still up and
   * anything behind it would only be seen as a flicker on the way out. Past it
   * the splash is gone, and a blank coloured screen while `retry` works through
   * its backoff is the one thing worse than a slow boot.
   */
  const [slow, setSlow] = createSignal(false);

  onMount(() => {
    /*
     * A rejected token can surface from any request in the app — a manager
     * revoking this tablet bumps `token_version` and everything in flight
     * starts failing at once. Re-asking is what puts the shell back on the
     * gate: the token is already gone by the time this runs, so the refetch
     * goes out bare, comes back 401, and the query lands in the error state
     * that state 1 reads. That is one request to confirm something we could
     * have assumed — and it is the price of the cache being the only place the
     * session is written down, rather than the shell keeping a second copy that
     * can disagree with it.
     */
    onUnauthorized(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    });

    const cap = setTimeout(() => {
      platform.dismissSplash();
      setSlow(true);
    }, SPLASH_CAP_MS);
    // Hung off the component's owner rather than off the mount, which is what
    // `onCleanup` does wherever it is written; here it means a hot reload does
    // not leave a timer pointing at a splash that has already gone.
    onCleanup(() => clearTimeout(cap));
  });

  /*
   * The splash comes down the moment there is a real screen behind it.
   *
   * Every milestone-0 screen is its own content as soon as it commits — the
   * gate, the claim flow, the PIN pad — so "the bootstrap has answered" is the
   * right moment for all of them, and there is no screen here that opens on a
   * spinner of its own and would hand the splash straight over to it. When one
   * arrives it should report for itself rather than move this line.
   *
   * `dismissSplash()` is idempotent, so the cap above racing this is fine.
   */
  createEffect(() => {
    if (ready()) platform.dismissSplash();
  });

  return (
    <div class="app">
      <Show when={ready()} fallback={<Booting m={m()} visible={slow()} />}>
        <Switch>
          {/*
            The claim screen renders in every state, including signed in. It is
            the only screen that can run without a credential — that is its
            whole job — and an already-claimed tablet opening a fresh link is a
            manager re-pointing a device, not a mistake to guard against.
          */}
          <Match when={location.pathname === '/claim'}>{props.children}</Match>

          <Match when={unreachable()}>
            {(error) => (
              <CouldNotAsk
                m={m()}
                error={error()}
                busy={session.isFetching}
                onRetry={() => void session.refetch()}
              />
            )}
          </Match>

          <Match when={identity() === null}>
            <NotAStaffDevice m={m()} />
          </Match>

          {/*
            Claimed, nobody on. The PIN screen is a route rather than something
            rendered from here, so that signing in at the start of a shift and
            switching staff mid-service are the same screen reached the same
            way — and so this file does not import a page, which would be a
            cycle the moment that page read the session back out of the cache.
          */}
          <Match when={!staffSignedIn()}>
            <Show when={location.pathname === '/staff'} fallback={<Navigate href="/staff" />}>
              {props.children}
            </Show>
          </Match>

          <Match when={staffSignedIn()}>{props.children}</Match>
        </Switch>
      </Show>
    </div>
  );
}

/**
 * The boot, before there is anything to show.
 *
 * Silent to look at and not silent to hear: the splash is decoration and hidden
 * from assistive technology, so somebody who landed on an empty document would
 * be told less than a spinner tells them. Once the splash has timed out there
 * is nothing covering the screen any more, and the same sentence is drawn.
 */
function Booting(props: { m: Messages; visible: boolean }) {
  return (
    <Show
      when={props.visible}
      fallback={
        <p class="sr-only" role="status">
          {props.m.app.loading}
        </p>
      }
    >
      <main class="screen">
        <p class="screen-body" role="status">
          {props.m.app.loading}
        </p>
      </main>
    </Show>
  );
}

/**
 * The end of the line for a tablet nobody has set up.
 *
 * Deliberately not a form. There is nothing to type, nothing to paste and
 * nothing to press: a device joins this restaurant when a manager opens a claim
 * link on it, and saying so plainly is more useful than a button that could
 * only ever explain itself. The one instruction people need is that the link
 * has to be opened *here*, on this tablet — the commonest failure is a manager
 * opening it on the laptop that generated it and wondering why the tablet did
 * not change.
 */
function NotAStaffDevice(props: { m: Messages }) {
  return (
    <main class="screen">
      <p class="screen-eyebrow">{props.m.claim.tagline}</p>
      <h1 class="screen-title">{props.m.app.name}</h1>
      <p class="screen-body">{props.m.claim.noLink}</p>
      <p class="screen-body">{props.m.claim.askAdmin}</p>
      {/* The only screen this tablet can show, so the only place its language
          can be changed from. See `LanguageToggle`. */}
      <LanguageToggle />
    </main>
  );
}

/**
 * The tablet is probably fine; we just could not ask.
 *
 * Two different sentences behind one screen, because the two failures need
 * different people: no connection is something whoever is holding the tablet
 * can act on — the restaurant's wifi is in the room — while anything else is
 * ours, and the only honest thing to offer is another attempt.
 *
 * The retry refetches rather than reloading the page. A reload would work, but
 * it throws away the bundle and brings the boot splash back, which reads as the
 * app having crashed rather than having asked again.
 */
function CouldNotAsk(props: {
  m: Messages;
  error: ApiError;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <main class="screen">
      <h1 class="screen-title">{props.m.app.somethingWrong}</h1>
      <p class="screen-body">
        {props.error.code === 'offline' ? props.m.errors.offline : props.m.errors.generic}
      </p>
      <p>
        <button type="button" class="button" disabled={props.busy} onClick={props.onRetry}>
          {props.m.app.retry}
        </button>
      </p>
    </main>
  );
}
