import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { StaffBar } from '../components/ui.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { CategoriesPanel, ProductsPanel, TablesPanel } from './backoffice/CataloguePanels.js';
import { DevicesPanel, StaffPanel } from './backoffice/PeoplePanels.js';
import { TodayPanel } from './backoffice/TodayPanel.js';

/**
 * Where the restaurant is set up: six lists behind one tab bar.
 *
 * This is the one screen in the app used at a desk, so a mouse and a keyboard
 * are allowed to exist here — `Enter` submits an editor, focus rings show. They
 * are not allowed to be *required*, because the manager checks a price on the
 * same tablet everybody else uses, standing up, between services. So the rules
 * hold: nothing under 48px, nothing that only appears on hover, no drag to
 * reorder. Sort order is a number in a field, which is also the only way it can
 * be made to work on a touch screen without inventing a gesture nobody will
 * guess.
 *
 * ## Tabs rather than six routes
 *
 * The sections are local state and not addresses, which is a deliberate
 * exception to how the rest of the app navigates. Nobody deep-links to the
 * device list and nobody needs the back button to step between tabs — going
 * "back" from Devices to Staff and then out of the backoffice entirely would be
 * three presses to leave a screen somebody opened once. What a manager does
 * instead is glance at two tabs and leave, and the tab bar makes both visible
 * at once, which a route would not.
 *
 * ## One panel is mounted at a time
 *
 * `Switch` and not six panels with five hidden, so a tab that has never been
 * opened has never fetched. Opening the backoffice costs the roster query and
 * nothing else; the product list, the device list and the day's takings are
 * three requests that only happen if somebody asks for them. On a free tier
 * that is not an optimisation so much as a habit worth keeping.
 *
 * The ordering is the brief's, and it is also roughly how often each is
 * touched: the menu changes weekly, the floor monthly, the people rarely, the
 * tablets once — and Today is last because it is the one thing here that is
 * read rather than edited.
 */

/*
 * The section keys. A tuple of literals rather than an enum so that `Section`
 * is exactly these six strings and a typo in the switch below is a build error
 * rather than a tab that renders nothing.
 */
const SECTIONS = ['products', 'categories', 'tables', 'staff', 'devices', 'today'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Which tab this tablet was last left on.
 *
 * Per device, through the platform seam like every other stored value. It is a
 * convenience and nothing more, so a stored value that is not one of the six —
 * an older build, a hand-edited key — falls back to the first rather than
 * rendering nothing.
 */
const SECTION_KEY = 'backoffice.section';

function storedSection(): Section {
  const stored = platform.storage.get(SECTION_KEY);
  return SECTIONS.includes(stored as Section) ? (stored as Section) : SECTIONS[0];
}

export function BackofficePage() {
  const { m } = useLocale();
  const app = useApp();
  const [signingOut, setSigningOut] = createSignal(false);
  const [section, setSection] = createSignal<Section>(storedSection());

  const signOut = () => {
    setSigningOut(true);
    void app.signOut().catch(() => setSigningOut(false));
  };

  const choose = (next: Section) => {
    setSection(next);
    platform.storage.set(SECTION_KEY, next);
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
            /* The panel below owns the scrolling, not the page: the tab bar
               stays put while a long product list moves under it. */
            'min-height': '0',
          }}
        >
          <StaffBar
            title={m().roles.admin}
            identity={identity()}
            busy={signingOut()}
            onSignOut={signOut}
          />

          {/*
            `role="tablist"` with `aria-selected` on each button, rather than
            colour alone: the selected tab is a filled pill to a person and a
            pressed state to a screen reader, and both have to be true.
          */}
          <nav class="tabs" role="tablist" aria-label={m().roles.admin}>
            <For each={SECTIONS}>
              {(name) => (
                <button
                  type="button"
                  class="tab"
                  role="tab"
                  aria-selected={section() === name}
                  onClick={() => choose(name)}
                >
                  {m().backoffice.sections[name]}
                </button>
              )}
            </For>
          </nav>

          <Switch>
            <Match when={section() === 'products'}>
              <ProductsPanel />
            </Match>
            <Match when={section() === 'categories'}>
              <CategoriesPanel />
            </Match>
            <Match when={section() === 'tables'}>
              <TablesPanel />
            </Match>
            <Match when={section() === 'staff'}>
              <StaffPanel />
            </Match>
            <Match when={section() === 'devices'}>
              <DevicesPanel />
            </Match>
            <Match when={section() === 'today'}>
              <TodayPanel />
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}
