import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { platform } from '../platform/index.js';
import { useLocale } from '../state/locale.js';
import { Button } from './ui.js';

/**
 * The two things that make this a tablet app rather than a web page.
 *
 * Both are one-line affordances that only appear when they are true, and both
 * are the kind of thing an app quietly does badly for years if nobody puts them
 * anywhere.
 */

/**
 * "Add to home screen", when the browser is offering it and not otherwise.
 *
 * It is on the PIN screen, beside the language switcher, and that is the right
 * place for a reason worth stating: a tablet sits on the PIN screen between
 * shifts, so it is the screen a manager is looking at while setting a new
 * device up, and it is the one screen in the app that is not in the middle of
 * anybody's job. Offering it on the waiter's screen would be a button about
 * the browser next to a button about a customer's dinner.
 *
 * Rendered as nothing at all when the browser is not offering — on iOS, in
 * Firefox, inside an app that is already installed, or simply because Chrome
 * has not decided the site qualifies yet. A control that cannot do its job is
 * worse than no control: somebody presses it, nothing happens, and they ring
 * whoever set the restaurant up.
 */
export function InstallButton() {
  const { m } = useLocale();
  const [available, setAvailable] = createSignal(false);

  onMount(() => {
    // `subscribe` reports the current answer immediately as well as on change,
    // which is what makes this work on a screen that mounted long after the
    // browser fired its one and only `beforeinstallprompt`.
    const unsubscribe = platform.install.subscribe(setAvailable);
    onCleanup(unsubscribe);
  });

  return (
    <Show when={available()}>
      <Button variant="text" onClick={() => void platform.install.prompt()}>
        {m().app.install}
      </Button>
    </Show>
  );
}

/**
 * "A new version is ready", with a Reload.
 *
 * A prompt rather than an automatic reload, and that is the whole design. These
 * tablets are installed apps that are never closed, so a deploy would otherwise
 * be picked up whenever somebody happened to restart one — which on a waiter's
 * device is approximately never, and leaves a bundle from a fortnight ago
 * talking to a Worker deployed this morning.
 *
 * But reloading *for* them is worse. The one screen with unsaved state is the
 * waiter's cart, and although the draft survives a reload — it is in the
 * tablet's own storage, per table — a screen that blanks itself mid-order while
 * somebody is reading an order out is a screen nobody trusts afterwards. So it
 * waits, in one quiet line, for a gap between tables.
 */
export function UpdateBanner() {
  const { m } = useLocale();
  const [updated, setUpdated] = createSignal(false);

  onMount(() => {
    const unsubscribe = platform.onAppUpdated(() => setUpdated(true));
    onCleanup(unsubscribe);
  });

  return (
    <Show when={updated()}>
      <div
        role="status"
        style={{
          display: 'flex',
          'flex-wrap': 'wrap',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: 'var(--pos-gap)',
          padding: '8px var(--pos-pane-gap)',
          background: 'var(--md-sys-color-secondary-container)',
          color: 'var(--md-sys-color-on-secondary-container)',
          'font-size': '0.95rem',
        }}
      >
        <span>{m().app.updateReady}</span>
        <Button variant="text" onClick={() => platform.navigation.reload()}>
          {m().app.reload}
        </Button>
      </div>
    </Show>
  );
}
