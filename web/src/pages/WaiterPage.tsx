import { Show, createSignal } from 'solid-js';
import { StaffBar } from '../components/ui.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * The waiter's screen — the frame, in milestone 0, and not the contents.
 *
 * What is here is honest about that: the two panes are drawn, labelled and
 * empty, and the note in the middle of them says which milestone fills them.
 * Nothing on this page pretends to be a table, a product or a cart, because a
 * shell with fake tiles on it is a screen somebody will tap during a review and
 * then have to be told about.
 *
 * ## Why the frame is here at all, if the contents are not
 *
 * Because the layout is the part that is expensive to change later and the part
 * the brief is most specific about. `CLAUDE.md` asks for a landscape tablet
 * with the tables on the left, the current table on the right, and a cart that
 * is always visible below it rather than behind an icon — and "always visible"
 * is a property of the frame, not of the cart. Building the panes now means
 * milestone 2 fills them; building them then would mean milestone 2 restructures
 * a screen it is also trying to make work.
 *
 * The two panes wrap rather than switching on a media query. A `flex-basis` per
 * pane with `flex-wrap` gives the landscape split the brief asks for on any
 * tablet wide enough for both, and stacks them into one column on anything
 * narrower — without this file guessing a breakpoint in pixels for devices
 * nobody has bought yet, and without a rule in `styles.css`, which this agent
 * does not own. The ratio comes out near 40/60 on a 10-inch tablet in
 * landscape, which is what the brief's grid-and-tiles split wants.
 *
 * ## The sign-out handler, three times
 *
 * This page, the cashier's and the backoffice's each carry their own copy of
 * the six lines below rather than sharing one. They are about to stop being the
 * same thing: this one gets a cart that has to refuse to be abandoned with
 * unsent items in it, the cashier's gets a live stream to tear down. Factoring
 * them together now would only make the first milestone that needs a difference
 * pull them apart again.
 */
export function WaiterPage() {
  const { m } = useLocale();
  const app = useApp();
  const [signingOut, setSigningOut] = createSignal(false);

  const signOut = () => {
    setSigningOut(true);
    // Only on the way back: a sign-out that worked takes this page off screen,
    // so re-enabling the control would be for a frame nobody sees. A sign-out
    // that failed — the wifi, mid-shift — leaves the tablet exactly as it was,
    // and the control coming back is what says so.
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
            /* Lets the panes below own the scrolling instead of the page. */
            'min-height': '0',
          }}
        >
          {/*
            The screen is named after the role it belongs to, and the role is
            already in the catalogue in both languages. Inventing a screen name
            here would mean inventing it in English — there is no key for one —
            and an English heading on a Burmese tablet is a worse answer than
            the word for the job the person is doing. The same goes for the
            other two trees.
          */}
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
            {/*
              Left: the tables grid. It grows more slowly than the pane beside
              it — two parts against three — because a table tile is a number
              and a state, and it does not get more useful at 600px across,
              while every pixel it does not take is another product tile on the
              right. A `max-width` would do the same job on a wide screen and
              then leave the pane stranded at that width when the two stack on a
              narrow one, which is the shape this file is trying to avoid
              hard-coding.
            */}
            <section
              class="card"
              lang="en"
              style={{
                flex: '2 1 18rem',
                display: 'flex',
                'flex-direction': 'column',
                gap: 'var(--pos-gap)',
              }}
            >
              <h2 style={{ margin: '0', 'font-size': '1.1rem' }}>Tables</h2>
              <p class="screen-body" style={{ margin: '0' }}>
                Milestone 2 builds this: every table as a tile, occupied ones showing their open
                check and total.
              </p>
            </section>

            {/*
              Right: the table currently open, with the cart under it. One
              column rather than two panes, because the cart belongs to the
              order being built above it and the brief is explicit that it is
              never behind an icon or on a review screen of its own.
            */}
            <section
              class="card"
              lang="en"
              style={{
                flex: '3 1 22rem',
                display: 'flex',
                'flex-direction': 'column',
                gap: 'var(--pos-gap)',
                'min-height': '0',
              }}
            >
              <h2 style={{ margin: '0', 'font-size': '1.1rem' }}>Current table</h2>
              <p class="screen-body" style={{ margin: '0' }}>
                Milestone 2 builds this: category chips, then product tiles at least 100×100,
                the whole tile tappable.
              </p>

              {/*
                The cart, pinned to the bottom of the pane by `margin-top: auto`
                rather than positioned over it. It is a row in the column, so it
                cannot overlap the tiles above and cannot be scrolled away from;
                `--pos-cart-min-h` is three rows and a total, which is the point
                at which it starts scrolling instead of eating the grid.
              */}
              <div
                style={{
                  'margin-top': 'auto',
                  'min-height': 'var(--pos-cart-min-h)',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: 'var(--pos-gap)',
                  padding: 'var(--pos-gap)',
                  'border-radius': 'var(--pos-radius-row)',
                  background: 'var(--md-sys-color-surface-container)',
                }}
              >
                <h3 style={{ margin: '0', 'font-size': '1rem' }}>Cart</h3>
                <p class="screen-body" style={{ margin: '0' }}>
                  Milestone 2 builds this: a line per product with − and +, an optional note,
                  the total, and one Send to kitchen button. Drafts survive a reload, per table.
                </p>
              </div>
            </section>
          </div>
        </div>
      )}
    </Show>
  );
}
