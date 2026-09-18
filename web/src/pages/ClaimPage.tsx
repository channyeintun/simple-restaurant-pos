import { useNavigate } from '@solidjs/router';
import { Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js';
import { claimDevice } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { Button, ErrorBanner, Spinner } from '../components/ui.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * The only way a tablet becomes this restaurant's.
 *
 * A manager mints a single-use link — `scripts/bootstrap-link.mjs` for the first
 * tablet, the backoffice for the rest — and opens it on the device. This screen
 * is what that link lands on: it takes the nonce out of the URL, spends it, and
 * sends the tablet on to the PIN screen. There is nothing to type and nothing
 * to choose, which is the point. The device cookie is the wall that keeps a
 * stranger's phone out of the till, so a self-service way through it would be
 * the hole in the only wall there is.
 *
 * ## The nonce rides in the fragment, never the query string
 *
 * `platform.navigation.hash()`, and it matters. A browser never sends the
 * fragment to a server, so a claim link cannot turn up in the Worker's access
 * log, in a proxy log at whatever the restaurant's ISP runs, or in the
 * `Referer` header of the next request this page makes. A `?nonce=` would be in
 * all three before it was ever redeemed, and every one of those copies would
 * still work, because the link is only spent when this page posts it.
 *
 * The fragment is then stripped from the address bar the moment it has been
 * read, so it does not survive in the tab's history or in a screenshot of a
 * tablet somebody photographed to show the setup worked.
 */

/**
 * Why this screen failed, as something to render rather than a sentence.
 *
 * Keeping the code and picking the words in the markup is what lets the message
 * follow a language change, and — more to the point — keeps the decision about
 * *which* message in one place, three lines below, where it can be read against
 * what the Worker actually answers.
 */
type Failure =
  /** Opened without a link at all: a bookmark, or somebody typing `/claim`. */
  | 'no-link'
  /** The Worker said no. Wrong, expired or already spent — see below. */
  | 'rejected'
  /** The Worker never answered. The link is probably still good. */
  | 'unreachable';

export function ClaimPage() {
  const { m } = useLocale();
  const app = useApp();
  const navigate = useNavigate();

  const [hash, setHash] = createSignal(platform.navigation.hash());
  const [busy, setBusy] = createSignal(true);
  const [failure, setFailure] = createSignal<Failure | null>(null);

  /*
   * The nonce this screen has already sent, kept out of the reactive graph
   * because nothing renders it — it is a note about what has been done, not
   * state that anything is drawn from.
   *
   * The effect below is keyed on it rather than on a "have we tried yet"
   * boolean. Solid re-runs an effect whenever any signal it read changes, and a
   * second attempt at the same link would be spent for nothing: the row is
   * cleared in the same statement that reads it, so the retry would report the
   * link as invalid and put that in front of somebody whose setup had in fact
   * just worked. A *different* link arriving in the same tab — a manager
   * re-pointing a tablet — is a new nonce and does get tried.
   */
  let attempted: string | null = null;

  /*
   * Opening a second link in a tab that is already on this screen changes only
   * the fragment, and a fragment-only navigation does not reload the document
   * or fire `popstate`. Without this the tablet would sit on the failure from
   * the first link with the second one in the address bar, doing nothing.
   */
  onCleanup(platform.navigation.subscribe(() => setHash(platform.navigation.hash())));

  function attempt(nonce: string): void {
    attempted = nonce;
    setBusy(true);
    setFailure(null);

    // Before the request, not after: everything from here on is asynchronous,
    // and the secret should not still be in the address bar while it is.
    platform.navigation.replace('/claim');

    claimDevice(nonce)
      .then((identity) => {
        app.adopt(identity);
        /*
         * Straight to the PIN screen rather than to `/`, and not left to the
         * shell. The shell sends a claimed device with nobody on it to `/staff`
         * on its own — but only for a path it is deciding about, and `/claim`
         * is the one path it renders whatever the session says, because this
         * screen has to be able to run with no credential at all.
         *
         * `replace`, so the back button cannot return a tablet to a claim
         * screen whose link has already been spent.
         */
        navigate('/staff', { replace: true });
      })
      .catch((cause: unknown) => {
        /*
         * A dropped request and a refused one are different problems with
         * different answers, and `client.ts` has already told them apart: it
         * gives status 0 to anything that never reached the Worker — no
         * network, DNS, a refused preflight — and the Worker's own status to
         * everything else.
         *
         * Everything the Worker rejects gets one message. A link that was never
         * valid, one that expired and one that has already been redeemed all
         * say the same thing, because the API deliberately says the same thing:
         * distinguishing them would tell somebody probing nonces which ones
         * exist, and it would tell the manager standing there nothing they
         * could act on. All three answers are "that link is no good, get
         * another one", which is what the screen says.
         */
        setFailure(cause instanceof ApiError && cause.status === 0 ? 'unreachable' : 'rejected');
        setBusy(false);
      });
    // No `finally` clearing `busy` on success: this page navigates away, and
    // the spinner should still be up while it does rather than flashing the
    // failure layout for a frame on its way out.
  }

  createEffect(() => {
    const nonce = hash();

    if (!nonce) {
      /*
       * An empty fragment here is usually *us*, a moment after `attempt` took
       * the secret out of the address bar — not somebody arriving without a
       * link. Only the second deserves an error, so say nothing while a claim
       * has been started.
       */
      if (attempted === null) {
        setFailure('no-link');
        setBusy(false);
      }
      return;
    }

    if (nonce === attempted) return;
    attempt(nonce);
  });

  return (
    <main class="screen">
      <p class="screen-eyebrow">{m().claim.tagline}</p>
      <h1 class="screen-title">{m().app.name}</h1>

      <Show when={!busy()} fallback={<Spinner label={m().claim.settingUp} />}>
        <ErrorBanner>
          <Switch>
            <Match when={failure() === 'no-link'}>{m().claim.noLink}</Match>
            <Match when={failure() === 'unreachable'}>{m().errors.offline}</Match>
            <Match when={failure() === 'rejected'}>{m().claim.failed}</Match>
          </Switch>
        </ErrorBanner>

        <Switch>
          {/*
            The Worker never answered, so the link has not been spent and is
            almost certainly still good — the restaurant's wifi is the thing
            that failed. Offering the attempt again is worth more than sending
            somebody to find a manager for a link they already have, and it is
            the remembered nonce that makes it possible after the address bar
            was cleaned out.
          */}
          <Match when={failure() === 'unreachable'}>
            <p>
              <Button
                onClick={() => {
                  const nonce = attempted;
                  if (nonce) attempt(nonce);
                }}
              >
                {m().app.retry}
              </Button>
            </p>
          </Match>

          {/*
            Nothing to press, in both the other cases, and that is honest rather
            than unfinished: a spent link cannot be un-spent from this tablet
            and a missing one cannot be conjured on it. The one instruction
            people need is that the new link has to be opened *here* — the
            commonest failure is a manager opening it on the laptop that
            generated it and wondering why the tablet did not change.
          */}
          <Match when={failure() !== 'unreachable'}>
            <p class="screen-body">{m().claim.askAdmin}</p>
          </Match>
        </Switch>
      </Show>
    </main>
  );
}
