import { pinSchema } from '@pos/shared';
import { useNavigate } from '@solidjs/router';
import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { ApiError } from '../api/client.js';
import { switchStaff } from '../api/staff.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { InstallButton } from '../components/pwa.js';
import { Button, ErrorBanner } from '../components/ui.js';
import { useStaff } from '../lib/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * Who is on this tablet.
 *
 * Reached at the start of every shift, after every sign-out, and any time
 * somebody hands the device to somebody else — which at a counter is a dozen
 * times a service. It is the screen this app is used through most often after
 * the waiter's own, so it is a keypad and nothing else: four digits, no name to
 * pick first, no field to focus, no Enter to find.
 *
 * ## The digits are the identity
 *
 * `POST /staff/switch` is given a PIN and nothing else. The Worker computes
 * `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` for each active member of staff
 * and sees which one lands, so there is no "pick your name, then type your PIN"
 * step — that is two taps at a counter with a queue at it, and the second one
 * carries no information the first did not.
 *
 * Which makes the list of names on this screen worth explaining, because it is
 * decoration by that argument. It is here for two things the keypad cannot do.
 * The first is the empty case: a restaurant that has just been set up has no
 * staff rows yet, and without this the first person to pick up the tablet would
 * type four digits over and over against a table with nothing in it. With it,
 * the screen says so — the catalogue's `pin.noStaff` — and names where to fix
 * it.
 * The second is that a shared device gives nobody any reassurance that it is
 * *their* till; seeing the team on it is what makes a tablet feel like the
 * restaurant's rather than a browser somebody left open. It stays deliberately
 * inert: it is a roster, not a chooser, so there is no tappable name that would
 * imply the PIN belongs to the one that was tapped.
 *
 * ## What a wrong PIN says
 *
 * "That PIN did not match" — and not whether the digits were wrong, whether
 * that person exists, or whether they are still employed here. There is nobody
 * this screen could name without naming them to whoever is holding the tablet,
 * and a PIN that identifies as well as authenticates has no distinction to draw
 * anyway: an unrecognised four digits and a mistyped four digits are the same
 * event to the Worker.
 *
 * A 4-digit PIN is not a security boundary and nothing here should suggest it
 * is. It tells Aung from Su on a device an admin has already claimed; the
 * device cookie is what keeps strangers out.
 */

/** The nine, in the order a keypad has them. `0` is placed by hand below. */
const DIGIT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Why the last attempt did not put somebody on the tablet. */
type Failure =
  /** The Worker read the digits and no active member of staff has them. */
  | 'wrong'
  /** The request never arrived. Nothing to do with the PIN. */
  | 'unreachable'
  /** Anything else the Worker answered with, or a response that did not parse. */
  | 'error';

export function PinPage() {
  const { m, locale, setLocale } = useLocale();
  const app = useApp();
  const navigate = useNavigate();
  const staff = useStaff();

  const [digits, setDigits] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<Failure | null>(null);

  /**
   * Send the four digits.
   *
   * Fired by the fourth key rather than by an affirmative button. A PIN here is
   * exactly four digits — `pinSchema` is the shared rule and this is the one
   * screen that holds itself against it — so the fourth digit carries all the
   * information an OK key would, and asking for it would be a fifth tap that
   * means nothing, on the screen this app interrupts people with most often.
   *
   * The cost of that choice is that a mistyped digit cannot be caught before it
   * is sent, which is why a failure clears the pad and leaves the keys exactly
   * where they were: the next attempt starts from an empty pad in the same
   * place, instead of from a half-typed one somebody has to reason about.
   */
  function submit(pin: string): void {
    setBusy(true);
    switchStaff(pin)
      .then((identity) => {
        app.adopt(identity);
        /*
         * To `/`, which the router turns into this person's own home —
         * `/waiter`, `/cashier` or `/backoffice`, by role. Going there by name
         * from here would put the rule about which screen belongs to which role
         * in two places, and this is not the file that owns it.
         *
         * `replace`, so the tablet's back button does not step from a waiter's
         * tables back onto the keypad. Getting back here is a deliberate act —
         * the sign-out control — and not something the hardware button does.
         */
        navigate('/', { replace: true });
      })
      .catch((cause: unknown) => {
        setDigits('');
        setFailure(classify(cause));
        setBusy(false);
      });
    // No `finally`: on success this page is on its way out and the keys should
    // stay disabled until it goes, rather than coming back to life for a frame.
  }

  function press(digit: string): void {
    if (busy() || digits().length >= 4) return;
    setFailure(null);

    const next = digits() + digit;
    setDigits(next);
    if (pinSchema.safeParse(next).success) submit(next);
  }

  function backspace(): void {
    if (busy()) return;
    setFailure(null);
    setDigits((current) => current.slice(0, -1));
  }

  /**
   * Hand the tablet back, from the screen that is already about who has it.
   *
   * Not routed through {@link classify}: a rejection here is never "those
   * digits matched nobody", and the one status that would be read as it — a 401
   * — means this device's own token has been revoked, which `client.ts` has
   * already acted on and the shell is already redrawing for.
   */
  function signOut(): void {
    setBusy(true);
    app.signOut().catch((cause: unknown) => {
      setFailure(cause instanceof ApiError && cause.status === 0 ? 'unreachable' : 'error');
      setBusy(false);
    });
  }

  return (
    /*
     * `safe center` over the stylesheet's `center`, and this is the one screen
     * that needs it: a heading, a roster, a keypad and a language switcher is
     * the tallest column in the app, and on a short landscape tablet it can
     * outgrow the viewport. Centred overflow spills equally in both directions,
     * which puts the top of the screen above the scrollable area where nothing
     * can reach it. `safe` means "centre until it would overflow, then align to
     * the start"; a browser that has never heard of it drops the declaration
     * and keeps the stylesheet's behaviour, which is the failure mode we
     * already have.
     */
    <main class="screen" style={{ 'justify-content': 'safe center' }}>
      {/*
        Two headings for two situations, and they are genuinely different jobs:
        an empty tablet at the start of a shift is asking who is arriving, while
        a tablet somebody is already signed in on is asking whether to hand over.
        The second one says who it currently belongs to, because the commonest
        mistake it can prevent is a waiter taking an order under somebody else's
        name after picking up the wrong tablet.
      */}
      <Show
        when={app.staff()}
        fallback={<h1 class="screen-title">{m().pin.title}</h1>}
      >
        {(current) => (
          <>
            <p class="screen-eyebrow">{m().pin.switchStaff}</p>
            <h1 class="screen-title">{m().pin.title}</h1>
            <p class="screen-body">{m().pin.signedInAs(current().name)}</p>
            <p>
              <Button variant="outlined" disabled={busy()} onClick={signOut}>
                {m().pin.signOut}
              </Button>
            </p>
          </>
        )}
      </Show>

      {/*
        The roster. `isPending` rather than `isFetching` decides whether to draw
        anything — the names are cached for five minutes, so coming back to this
        screen between shifts shows them immediately while a refresh happens
        underneath, and there is no spinner where the list had been a moment ago.

        A failed fetch shows nothing at all, deliberately. Nobody needs the list
        to sign in, and an error about a decoration would sit above the keypad
        looking like a reason the PIN will not work.
      */}
      <Show when={!staff.isPending && staff.data}>
        {(people) => (
          <Show
            when={people().length > 0}
            fallback={<p class="screen-body">{m().pin.noStaff}</p>}
          >
            <ul
              style={{
                display: 'flex',
                'flex-wrap': 'wrap',
                'justify-content': 'center',
                gap: '8px',
                margin: '0',
                padding: '0',
                'list-style': 'none',
              }}
            >
              <For each={people()}>
                {(person) => (
                  <li
                    style={{
                      display: 'flex',
                      'align-items': 'baseline',
                      gap: '6px',
                      padding: '6px 14px',
                      'border-radius': 'var(--pos-radius-pill)',
                      background: 'var(--md-sys-color-surface)',
                      'box-shadow': 'var(--pos-shadow-card)',
                    }}
                  >
                    <span style={{ 'font-weight': '600' }}>{person.name}</span>
                    {/* A middot rather than a space. A name and a role set as two
                        bare words read as one repeated phrase the moment they
                        resemble each other — and they will, because "Manager" is
                        both a plausible name for the owner to type and the label
                        this app gives the admin role. */}
                    <span
                      aria-hidden="true"
                      style={{ color: 'var(--md-sys-color-outline)' }}
                    >
                      ·
                    </span>
                    <span
                      style={{
                        'font-size': '0.85rem',
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      {m().roles[person.role]}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>

      {/*
        Four slots, filled as the digits arrive.

        Hidden from assistive technology rather than labelled, and that is a
        decision rather than an oversight. The useful announcement is "three of
        four", which says how far along somebody is without saying what they
        typed — and the only strings this app has are the ones in the catalogue,
        which has no key for it yet. An English count read out by a Burmese
        screen reader would be worse than what the keys already give, which is
        the digit itself as each one is pressed. `pin.digitsEntered` belongs in
        `shared/src/i18n/` the next time that file is opened.
      */}
      <div
        aria-hidden="true"
        style={{ display: 'flex', 'justify-content': 'center', gap: '16px', padding: '8px 0' }}
      >
        <For each={[0, 1, 2, 3]}>
          {(slot) => (
            <span
              style={{
                width: '18px',
                height: '18px',
                'border-radius': 'var(--pos-radius-pill)',
                border: '2px solid var(--md-sys-color-outline)',
                background:
                  slot < digits().length ? 'var(--md-sys-color-primary)' : 'transparent',
              }}
            />
          )}
        </For>
      </div>

      {/*
        The message sits in a slot that is the same height whether or not there
        is a message in it. A banner that appears between the dots and the pad
        would push every key down by its own height at the exact moment somebody
        is reaching for the first digit of their second attempt — which is how
        one wrong PIN becomes two.
      */}
      <div
        style={{
          'min-height': '3.5rem',
          display: 'flex',
          'align-items': 'center',
          /* The banner sizes to its text, so without this it sits against the
             left edge of a column whose every other child is centred. */
          'justify-content': 'center',
        }}
      >
        <Show when={failure()}>
          {(reason) => (
            <ErrorBanner>
              <Switch>
                <Match when={reason() === 'wrong'}>{m().pin.wrongPin}</Match>
                <Match when={reason() === 'unreachable'}>{m().errors.offline}</Match>
                <Match when={reason() === 'error'}>{m().errors.generic}</Match>
              </Switch>
            </ErrorBanner>
          )}
        </Show>
      </div>

      {/*
        Three columns, from the shared grid rather than a hand-rolled one.

        `--pos-grid-min: 30%` is what pins it at three: `auto-fill` fits as many
        30%-wide columns as it can and a fourth would need 120% of the row. A
        percentage rather than a width in pixels because the pad is capped at
        20rem and centred, so the keys grow with the text size rather than
        against it — and each one is already taller than `--pos-touch` before
        any of that.
      */}
      <div
        class="grid"
        style={{ '--pos-grid-min': '30%', 'max-width': '20rem', margin: '0 auto' }}
      >
        <For each={DIGIT_KEYS}>
          {(digit) => <PadKey label={digit} disabled={busy()} onPress={() => press(digit)} />}
        </For>

        {/* The empty corner, so `0` sits under `8` where a thumb expects it. */}
        <span />
        <PadKey label="0" disabled={busy()} onPress={() => press('0')} />
        {/*
          U+232B, the erase glyph, and no `aria-label` beside it — for the same
          reason as the dots above: the catalogue has no word for this key yet,
          and an English "delete" is not an improvement on the character that
          every screen reader worth the name already announces.
        */}
        <PadKey label={'⌫'} disabled={busy() || digits().length === 0} onPress={backspace} />
      </div>

      {/*
        The language switcher, and the only screen that carries one.

        A tablet is set up once and then used by whoever picks it up, so the
        language is a property of the device — see `state/locale.tsx` — and this
        is the screen every one of those people passes through anyway. Putting
        it here means nobody has to find a settings screen mid-service, and
        there is no settings screen to find until milestone 1.

        Each option is written in its own script and carries its own `lang`, so
        the Burmese one gets a Myanmar face and the line height that script
        needs even while the rest of the screen is English.
      */}
      <LanguageToggle />

      {/*
        And the home-screen offer, under the language switcher, for the same
        reason it is: both are settings that belong to the *device* rather than
        to whoever is standing at it, and this is the one screen in the app that
        is not in the middle of somebody's job. It renders as nothing at all
        unless the browser is actually offering — see `InstallButton`.
      */}
      <InstallButton />
    </main>
  );
}

/**
 * One key.
 *
 * A plain `<button>` rather than a Material one. The pad is a grid of equal
 * cells where the whole cell is the target, which is what `.tile` in
 * `styles.css` is for — a Material button would bring its own pill shape and
 * its own height, and the thing that lights up under the finger would stop
 * being the thing that was pressed. `:active` is the only state it has, because
 * nothing in this app is ever used with a mouse and hover is not an affordance
 * a tablet can offer.
 */
function PadKey(props: { label: string; disabled?: boolean; onPress(): void }) {
  return (
    <button
      type="button"
      class="tile"
      disabled={props.disabled}
      onClick={() => props.onPress()}
      style={{
        // Comfortably past the 48px floor: this is the one control in the app
        // pressed four times in a row, without looking, by somebody in a hurry.
        'min-height': 'var(--pos-touch-lg)',
        display: 'grid',
        'place-items': 'center',
        'font-size': '1.6rem',
        'font-weight': '600',
        'text-align': 'center',
      }}
    >
      {props.label}
    </button>
  );
}

/**
 * What went wrong, from what was thrown.
 *
 * `client.ts` gives status 0 to anything that never reached the Worker and the
 * Worker's own status to everything else, so a 401 here means precisely "no
 * active member of staff has those digits" — it is not a dead credential, the
 * device token is untouched, and nothing has signed this tablet out.
 */
function classify(cause: unknown): Failure {
  if (!(cause instanceof ApiError)) return 'error';
  if (cause.status === 0) return 'unreachable';
  return cause.isAuthError ? 'wrong' : 'error';
}
