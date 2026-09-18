import type { CheckSummary, Table } from '@pos/shared';
import { useNavigate } from '@solidjs/router';
import { For, Show, createMemo } from 'solid-js';
import { Spinner } from '../../components/ui.js';
import { useOpenChecks, useTables } from '../../lib/queries.js';
import { useApp } from '../../state/app.js';
import { hasDraft, slotKey } from '../../state/cart.js';
import { useLocale } from '../../state/locale.js';

/**
 * The left pane: every table, plus whatever takeaway orders are open.
 *
 * ## Why takeaway orders are tiles rather than a separate list
 *
 * Because to a waiter they are the same thing: something with an order on it
 * that is not finished. A takeaway check has no table to be found by, so if it
 * were not here it could only be reached through the cashier's screen — and the
 * waiter who took it is the one who has to add the drink the customer just
 * remembered. One grid, one mental model, and a `New takeaway` tile at the end
 * to start one.
 *
 * ## What a tile says
 *
 * A name, and then either "Free" or the total and how many rounds have gone to
 * the kitchen. The occupied ones are tinted amber rather than badged, because
 * the waiter is scanning a dozen tiles for the two that need something and a
 * fill is readable in peripheral vision where a word in a corner is not.
 *
 * The dot in the corner is the one piece of state that lives only on this
 * tablet: this table has an order tapped in and not sent. Nobody else can see
 * it and it goes with the tablet, so it is small and unlabelled — what it has
 * to do is stop a waiter walking away from a half-tapped order.
 */
export function TablesPane(props: { current: string | null }) {
  const { m } = useLocale();
  const app = useApp();
  const navigate = useNavigate();
  const tables = useTables();
  const checks = useOpenChecks();

  /** Open checks by table id, so a tile can find its own without a scan. */
  const byTable = createMemo(() => {
    const map = new Map<string, CheckSummary>();
    for (const check of checks.data ?? []) {
      if (check.tableId) map.set(check.tableId, check);
    }
    return map;
  });

  /** Open checks with no table under them: takeaway and the counter. */
  const takeaway = createMemo(() => (checks.data ?? []).filter((check) => check.tableId === null));

  const state = (check: CheckSummary | undefined) =>
    check ? `${app.money(check.totalMinor)} · ${m().waiter.rounds(check.roundCount)}` : m().waiter.free;

  /*
   * The tabular-figures face is for money and only for money. An occupied
   * tile's line is an amount and lines up down the column with the others; a
   * free one says "Free", which is a word, and setting a word in the numeric
   * face makes it look like a code for something.
   */
  const stateClass = (check: CheckSummary | undefined) =>
    check ? 'table-tile-state money' : 'table-tile-state';

  return (
    <section
      class="card"
      style={{
        flex: '2 1 18rem',
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--pos-gap)',
        'min-height': '0',
        overflow: 'auto',
      }}
    >
      <h2 style={{ margin: '0', 'font-size': '1.1rem' }}>{m().waiter.tables}</h2>

      <Show when={!tables.isPending} fallback={<Spinner />}>
        <div class="grid" style={{ '--pos-grid-min': '7.5rem' }}>
          <For each={tables.data ?? []}>
            {(table: Table) => {
              const check = () => byTable().get(table.id);
              const key = () => {
                // The draft follows the *check* once one is open, so that a
                // half-tapped second round does not go missing the moment the
                // first is sent and the slot changes under it.
                const open = check();
                return open
                  ? slotKey({ kind: 'check', checkId: open.id })
                  : slotKey({ kind: 'table', tableId: table.id });
              };

              return (
                <button
                  type="button"
                  class="tile table-tile"
                  data-open={check() ? 'true' : 'false'}
                  data-current={props.current === table.id ? 'true' : 'false'}
                  onClick={() => navigate(`/waiter/table/${table.id}`)}
                >
                  <span class="table-tile-name">{table.name}</span>
                  <span class={stateClass(check())}>{state(check())}</span>
                  <Show when={hasDraft(key())}>
                    <span class="table-tile-dot" aria-label={m().waiter.unsent} />
                  </Show>
                </button>
              );
            }}
          </For>

          <For each={takeaway()}>
            {(check) => (
              <button
                type="button"
                class="tile table-tile"
                data-open="true"
                data-current={props.current === check.id ? 'true' : 'false'}
                onClick={() => navigate(`/waiter/check/${check.id}`)}
              >
                <span class="table-tile-name">{m().waiter.takeaway}</span>
                <span class={stateClass(check)}>{state(check)}</span>
                <Show when={hasDraft(slotKey({ kind: 'check', checkId: check.id }))}>
                  <span class="table-tile-dot" aria-label={m().waiter.unsent} />
                </Show>
              </button>
            )}
          </For>

          {/*
            Always last, and always present. Starting a counter sale is a thing
            a waiter does ten times an evening in some restaurants and never in
            others, and a tile that appeared only when it was relevant would be
            a tile whose position moved.
          */}
          <button
            type="button"
            class="tile table-tile"
            data-current={props.current === 'takeaway' ? 'true' : 'false'}
            onClick={() => navigate('/waiter/takeaway')}
          >
            <span class="table-tile-name">+</span>
            <span class="table-tile-state">{m().waiter.newTakeaway}</span>
            <Show when={hasDraft(slotKey({ kind: 'takeaway' }))}>
              <span class="table-tile-dot" aria-label={m().waiter.unsent} />
            </Show>
          </button>
        </div>
      </Show>
    </section>
  );
}
