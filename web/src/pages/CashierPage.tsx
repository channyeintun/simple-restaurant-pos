import { Show, createSignal } from 'solid-js';
import { StaffBar } from '../components/ui.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * The till — the shell of it, in milestone 0.
 *
 * One column rather than the waiter's two panes, because the cashier's screen
 * is a list of open checks and then one of them opened up. There is no second
 * pane that stays put while the first changes, so a split would be a divider
 * across a screen that has one subject at a time.
 *
 * ## The one page in this app that subscribes to anything
 *
 * Worth stating here even though milestone 3 is what builds it, because it is
 * the reason this page is separate from the waiter's at all and the reason it
 * must not be copied. `@upstash/realtime` publishes a keepalive every ten
 * seconds per open connection — 360 Redis commands an hour, against a free tier
 * of 500,000 a month — so exactly one screen in this app opens a stream, on one
 * channel named `restaurant`, and that screen is this one. The waiter's tablets
 * fetch a table's check when they open it; the printer agent polls. A second
 * subscriber would not break anything, which is precisely why the rule is
 * written down instead of enforced.
 *
 * When that stream arrives, its teardown belongs to this component's lifetime:
 * `createLive()` wrapping `connectLive()` with `onMount`/`onCleanup`, handlers
 * read through a store so that a re-render never tears the connection down and
 * builds it again.
 */
export function CashierPage() {
  const { m } = useLocale();
  const app = useApp();
  const [signingOut, setSigningOut] = createSignal(false);

  const signOut = () => {
    setSigningOut(true);
    void app.signOut().catch(() => setSigningOut(false));
  };

  return (
    <Show when={app.identity()}>
      {(identity) => (
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            flex: '1',
            gap: 'var(--pos-pane-gap)',
            padding: 'var(--pos-pane-gap)',
            'min-height': '0',
          }}
        >
          <StaffBar
            title={m().roles.cashier}
            identity={identity()}
            busy={signingOut()}
            onSignOut={signOut}
          />

          {/*
            English, and marked as English, because every word in it is
            scaffolding that milestone 3 deletes. It is deliberately not in
            `shared/src/i18n/` — a key there has to be translated into Burmese
            and kept in step with its English twin, and translating a note about
            a screen that does not exist yet is how a catalogue fills up with
            strings that no longer match what is on the button.
          */}
          <section
            class="card"
            lang="en"
            style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--pos-gap)' }}
          >
            <h2 style={{ margin: '0', 'font-size': '1.1rem' }}>Open checks</h2>
            <p class="screen-body" style={{ margin: '0' }}>
              Milestone 3 builds this: every open check as a large card by table with its total,
              updating live. Opening one shows its rounds and items; from there, void an item, take
              payment as cash, card or other, and close it.
            </p>
            <p class="screen-body" style={{ margin: '0' }}>
              A red banner appears above this list when a kitchen ticket fails to print, naming the
              table and the error, with a Retry that re-queues the job. That banner is the reason
              this screen is the one that stays open all service.
            </p>
          </section>
        </div>
      )}
    </Show>
  );
}
