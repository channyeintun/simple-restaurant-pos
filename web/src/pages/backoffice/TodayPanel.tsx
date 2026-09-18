import { useApp } from '../../state/app.js';
import { useLocale } from '../../state/locale.js';
import { useSalesToday } from '../../lib/queries.js';
import { Panel, QueryView, SectionHead } from './parts.js';

/**
 * What the restaurant has taken since local midnight, and the whole of this
 * app's reporting.
 *
 * `CLAUDE.md` puts anything beyond this out of scope, and that is a decision
 * about what the product is rather than a corner cut: a restaurant that wants
 * to know which curry sells on Tuesdays wants a spreadsheet, and a till is a
 * bad place to read one. What this screen is for is the question somebody
 * actually asks mid-afternoon — "how are we doing" — and the one they ask at
 * closing time, which is how much of it should be in the drawer.
 *
 * ## Why the three methods are separate numbers
 *
 * Because counting a cash drawer against a total that includes card takings is
 * how a drawer comes up short by exactly the amount that was never in it. The
 * big number is the day; the cash line is the one that has to match what is
 * being counted.
 *
 * ## Why the window is on the screen
 *
 * "Today" is the restaurant's day, not the Worker's — it starts at local
 * midnight, `TZ_OFFSET_MINUTES` ahead of UTC — and the Worker sends back the
 * window it actually summed over rather than leaving the client to work one
 * out. So the line under the total is quoting the query. The day somebody
 * changes the offset, the number and the window it covers move together
 * instead of one of them being six and a half hours out.
 */
export function TodayPanel() {
  const { m } = useLocale();
  const app = useApp();
  const sales = useSalesToday();

  return (
    <Panel>
      <SectionHead title={m().backoffice.sections.today} />

      <QueryView pending={sales.isPending} error={sales.error} data={sales.data}>
        {(today) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--pos-pane-gap)' }}>
            <div class="stat">
              <span class="stat-value money">{app.money(today.totalMinor)}</span>
              <span class="stat-label">
                {m().today.takings} · {m().today.since(app.clock(today.dayStart))} ·{' '}
                {m().today.checks(today.checkCount)}
              </span>
            </div>

            {/*
              The three methods, in a grid rather than a row, so they wrap on a
              tablet held upright instead of shrinking to fit. `--pos-grid-min`
              is wide enough for the longest amount this restaurant will ever
              take plus its label.
            */}
            <div class="grid" style={{ '--pos-grid-min': '9rem' }}>
              <Method label={m().today.cash} amount={today.byMethod.cash} />
              <Method label={m().today.card} amount={today.byMethod.card} />
              <Method label={m().today.other} amount={today.byMethod.other} />
            </div>
          </div>
        )}
      </QueryView>
    </Panel>
  );
}

function Method(props: { label: string; amount: number }) {
  const app = useApp();

  return (
    <div
      class="stat stat-small"
      style={{
        padding: '14px 16px',
        'border-radius': 'var(--pos-radius-row)',
        background: 'var(--md-sys-color-surface-container)',
      }}
    >
      <span class="stat-value money">{app.money(props.amount)}</span>
      <span class="stat-label">{props.label}</span>
    </div>
  );
}
