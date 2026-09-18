import { For, Show, createSignal } from 'solid-js';
import { StaffBar } from '../components/ui.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * Where the restaurant is set up — the shell of it, in milestone 0.
 *
 * Six things, and the brief names all six, so this page lists them rather than
 * describing them in a paragraph: each one is a milestone-1 screen, and having
 * them written down as separate cards is what stops the first of them being
 * built as a settings page with everything in it.
 *
 * This is the one screen in the app that is used at a desk, so a mouse and a
 * keyboard are allowed to exist here. They are not allowed to be *required* —
 * the manager checks a price on the same tablet everybody else uses, standing
 * up, between services. So the rules hold: nothing under 48px, nothing that
 * only appears on hover, no drag to reorder. Sort order is a number in a field,
 * which is also the only way it can be made to work on a touch screen without
 * inventing a gesture nobody will guess.
 *
 * Today's sales total is on this page and nowhere else, and it is the only
 * report this app has. `CLAUDE.md` puts reports beyond it out of scope, and the
 * total itself is a single query that the free tier does not notice — the
 * payments table sees about sixty rows on a service.
 */

/*
 * The six things milestone 1 puts here, in the order the brief names them.
 * English and marked as such, like the other two shells: these are scaffolding
 * strings that get deleted rather than translated, and a Burmese twin for them
 * would have to be maintained until then for no reader's benefit.
 */
const SECTIONS: { title: string; body: string }[] = [
  {
    title: 'Products',
    body: 'Name, category, price and sort order. A price is typed in whole kyat and stored as an integer, so nothing here can round.',
  },
  {
    title: 'Categories',
    body: 'The chips above the product grid on a waiter tablet, in the order they appear there.',
  },
  {
    title: 'Tables',
    body: 'The grid a waiter opens a check from. Removing one hides it; past checks keep the table they were opened on.',
  },
  {
    title: 'Staff and PINs',
    body: 'Who can sign in and with which role, and a PIN each. A PIN is set here and never read back — the stored value is a keyed hash and the Worker is the only thing holding the key.',
  },
  {
    title: 'Device claim links',
    body: 'One single-use link per tablet, opened on the tablet it is for. This is the only way a device joins the restaurant; the first one comes from the bootstrap script instead.',
  },
  {
    title: "Today's sales",
    body: "One number: everything taken since the day began, in the restaurant's own timezone rather than the Worker's.",
  },
];

export function BackofficePage() {
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
            title={m().roles.admin}
            identity={identity()}
            busy={signingOut()}
            onSignOut={signOut}
          />

          <div lang="en" style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--pos-gap)' }}>
            <p class="screen-eyebrow" style={{ margin: '0' }}>
              Milestone 1 builds these
            </p>

            {/*
              `--pos-grid-min` at 18rem rather than the tile default: these are
              cards of prose, and a 100px column of words is unreadable. The
              grid itself is the shared one, so the gaps match every other
              screen — and it collapses to a single column on a tablet held
              upright without this page knowing a breakpoint.
            */}
            <div class="grid" style={{ '--pos-grid-min': '18rem' }}>
              <For each={SECTIONS}>
                {(section) => (
                  <section
                    class="card"
                    style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}
                  >
                    <h2 style={{ margin: '0', 'font-size': '1.1rem' }}>{section.title}</h2>
                    <p class="screen-body" style={{ margin: '0' }}>
                      {section.body}
                    </p>
                  </section>
                )}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
