import type { CheckSummary } from '@pos/shared';
import { useNavigate } from '@solidjs/router';
import { For, Show } from 'solid-js';
import { Spinner } from '../../components/ui.js';
import { useOpenChecks } from '../../lib/queries.js';
import { useApp } from '../../state/app.js';
import { useLocale } from '../../state/locale.js';

/**
 * Every open check, as a card.
 *
 * Large cards by table with totals, which is what the brief asks for and what
 * the job wants: a cashier glances at this from a few feet away to find the
 * table whose customer is standing at the till, so the table's name is the
 * biggest thing on the card and the total is the second.
 *
 * The list is the same one the waiter's tables grid reads — `GET /checks` —
 * because two nearly identical lists would be two things to keep in step, and
 * one of them would eventually say a table was free when it was not.
 *
 * Nothing here subscribes. The stream belongs to {@link CashierPage}, which
 * stays mounted while this comes and goes, so walking into a check and back
 * does not open and close a connection — an open SSE connection is 360 Upstash
 * commands an hour, and the budget has room for exactly one of them in the
 * building.
 */
export function CashierBoard() {
  const { m } = useLocale();
  const app = useApp();
  const navigate = useNavigate();
  const checks = useOpenChecks();

  return (
    <section
      class="card"
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--pos-gap)',
        'min-height': '0',
        overflow: 'auto',
      }}
    >
      <h2 style={{ margin: '0', 'font-size': '1.1rem' }}>{m().cashier.openChecks}</h2>

      <Show when={!checks.isPending} fallback={<Spinner />}>
        <Show
          when={(checks.data ?? []).length > 0}
          fallback={
            <p class="screen-body" style={{ margin: '0' }}>
              {m().cashier.none}
            </p>
          }
        >
          {/*
            Wider tracks than the waiter's tables: a cashier's card carries a
            total, a round count and who opened it, and it is read at arm's
            length from behind a counter rather than tapped at speed.
          */}
          <div class="grid" style={{ '--pos-grid-min': '13rem' }}>
            <For each={checks.data}>
              {(check: CheckSummary) => (
                <button
                  type="button"
                  class="tile check-card"
                  onClick={() => navigate(`/cashier/${check.id}`)}
                >
                  <span class="check-card-name">
                    {check.tableName ?? m().waiter.takeaway}
                  </span>
                  <span class="check-card-total money">{app.money(check.totalMinor)}</span>
                  <span class="check-card-meta">
                    {m().waiter.rounds(check.roundCount)} · {check.openedByName} ·{' '}
                    {app.clock(check.openedAt)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}
