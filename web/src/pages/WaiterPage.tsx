import type { RouteSectionProps } from '@solidjs/router';
import { useParams } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { Show, createSignal } from 'solid-js';
import { StaffBar } from '../components/ui.js';
import { createPoll } from '../lib/poll.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { TablesPane } from './waiter/TablesPane.js';

/**
 * How often a waiter tablet asks what has changed on the floor.
 *
 * Ten seconds, not the cashier's five. The till's number is read by somebody
 * standing still with a customer in front of them; this one is read by somebody
 * walking, and the thing it has to carry — a table that has been settled and is
 * free to seat — does not become urgent inside ten seconds. It is also half the
 * requests, which is the half of the decision that can be counted.
 */
const FLOOR_POLL_MS = 10_000;

/**
 * The waiter's screen: tables on the left, the order on the right.
 *
 * ## The two panes wrap rather than switching on a breakpoint
 *
 * A `flex-basis` per pane with `flex-wrap` gives the landscape split the brief
 * asks for on any tablet wide enough for both, and stacks them into one column
 * on anything narrower — without this file guessing a pixel width for devices
 * nobody has bought yet. The ratio comes out near 40/60 on a ten-inch tablet in
 * landscape, which is what a grid-and-tiles split wants: the tables pane grows
 * more slowly because a table tile is a number and a state and does not get
 * more useful at 600px across, while every pixel it does not take is another
 * product tile on the right.
 *
 * ## The left pane never unmounts
 *
 * It is here, in the parent, and the right pane is the nested route. Walking
 * from table 3 to table 4 replaces the right-hand side and leaves the grid
 * exactly where it was — same scroll position, no refetch, no flicker. That is
 * the whole reason the routes are nested rather than three sibling pages, and
 * it is what makes the grid usable as *navigation* rather than as a screen you
 * pass through.
 */
export function WaiterPage(props: RouteSectionProps) {
  const { m } = useLocale();
  const app = useApp();
  const params = useParams();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = createSignal(false);

  /*
   * What the cashier did, on the waiter's screen.
   *
   * Everything else a waiter sees is something a waiter caused — they tapped
   * Send, so they have the new round in their hand. Payment is the exception:
   * it happens on a different tablet, across the room, and until this arrives
   * the grid goes on showing a table as occupied, with a total owed, while the
   * customers are standing up. Settling is also the only thing that *frees* a
   * table, so it is the one change a waiter is actually waiting on.
   *
   * The `['checks']` prefix and not three separate keys: `openChecks`,
   * `tableCheck` and `check` all live under it, and solid-query only refetches
   * queries that are mounted — so this is one request for the grid, plus one
   * for the pane beside it if a table is open, and nothing at all for the
   * dozens of table checks this tablet has looked at today.
   *
   * It lives here rather than in `TablesPane` because the grid is not the only
   * thing that goes stale: a waiter standing inside a table's order pane when
   * the cashier settles it needs that pane to stop being an open check, or the
   * next Send adds a round to a bill that has been paid.
   */
  createPoll(FLOOR_POLL_MS, () => {
    void queryClient.invalidateQueries({ queryKey: ['checks'] });
  });

  const signOut = () => {
    setSigningOut(true);
    // Only on the way back: a sign-out that worked takes this page off screen,
    // so re-enabling the control would be for a frame nobody sees. A sign-out
    // that failed — the wifi, mid-shift — leaves the tablet exactly as it was,
    // and the control coming back is what says so.
    void app.signOut().catch(() => setSigningOut(false));
  };

  /**
   * Which tile is ringed. A table id, a check id, or the literal `takeaway`
   * for the tile that starts a new counter sale — the left pane compares
   * against all three and does not need to know which kind it got.
   */
  const current = () =>
    params.tableId ??
    params.checkId ??
    (props.location.pathname.endsWith('/takeaway') ? 'takeaway' : null);

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
            /* Lets the panes below own the scrolling instead of the page. */
            'min-height': '0',
          }}
        >
          <StaffBar
            title={m().roles.waiter}
            identity={identity()}
            busy={signingOut()}
            onSignOut={signOut}
          />

          <div
            style={{
              display: 'flex',
              'flex-wrap': 'wrap',
              'align-items': 'stretch',
              flex: '1',
              gap: 'var(--pos-pane-gap)',
              'min-height': '0',
            }}
          >
            <TablesPane current={current()} />
            {props.children}
          </div>
        </div>
      )}
    </Show>
  );
}

/**
 * The right pane before a table has been picked.
 *
 * One line, centred, and deliberately not a summary of the day or a list of
 * anything: the only useful thing to do from here is tap a tile on the left,
 * and a screen with something else on it is a screen somebody reads first.
 */
export function PickTable() {
  const { m } = useLocale();

  return (
    <section
      class="card"
      style={{
        flex: '3 1 22rem',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        'min-height': '0',
      }}
    >
      <p class="screen-body" style={{ margin: '0', 'text-align': 'center' }}>
        {m().waiter.pickTable}
      </p>
    </section>
  );
}
