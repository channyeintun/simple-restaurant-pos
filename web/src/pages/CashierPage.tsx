import { type CheckSummary, type PrintJobView, RESTAURANT_CHANNEL } from '@pos/shared';
import type { RouteSectionProps } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createMemo, createSignal } from 'solid-js';
import { retryPrintJob } from '../api/orders.js';
import { Button, StaffBar } from '../components/ui.js';
import { applyBoardEvent, boardNeedsRefetch } from '../lib/board.js';
import { createLive } from '../lib/live.js';
import { queryKeys, usePrintJobs, useTables } from '../lib/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * The till.
 *
 * ## The one page in this app that subscribes to anything
 *
 * `@upstash/realtime` publishes a keepalive every ten seconds per open
 * connection — 360 Redis commands an hour, not configurable from outside the
 * library — against a free tier of 500,000 a month. One service day of one
 * cashier stream is about a quarter of that. So exactly one screen opens a
 * stream, on one channel, and this is it: the waiter's tablets fetch a table's
 * check when they open it, because a waiter has just caused the change they are
 * looking at, and the printer agent polls, because nothing is watching it.
 *
 * The stream lives **here**, in the layout, and not in the board or the check
 * view. Those two are nested routes that unmount as the cashier walks between
 * them; a connection opened in either would be torn down and rebuilt — a ticket
 * round trip and a fresh subscribe — every time somebody opened a check and
 * came back.
 *
 * ## Events are applied, never answered
 *
 * `applyBoardEvent` and `setQueryData`; no `invalidateQueries` in the handler,
 * and no refetch. The payloads in `shared/src/events.ts` are self-sufficient
 * precisely so that a client does not have to ask, and a round trip per event
 * would spend the request the whole design exists to avoid. The single
 * exception is `boardNeedsRefetch`, which is a reconnect gap: an event about a
 * check this board has never seen carries a total and nothing to build a card
 * out of.
 *
 * ## The banner
 *
 * A kitchen ticket that did not print is the one thing in this app that needs
 * somebody to walk across the room, so it is red, it is above everything else,
 * and it names the table rather than a job id. It is raised by
 * `print_job.failed` and backed by a poll of `?status=failed` — which matters
 * more than it sounds, because a stream that is down is exactly when a printer
 * problem would otherwise go unnoticed.
 */
export function CashierPage(props: RouteSectionProps) {
  const { m } = useLocale();
  const app = useApp();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = createSignal(false);

  /*
   * The floor, for turning a `tableId` into the name on a card.
   *
   * `check.opened` carries the id and not the name — the catalogue is six
   * events with fixed payloads, and widening one to carry a name the client
   * already has would be a deviation to save a `Map.get`. This list is cached
   * for five minutes and read by every screen, so it is almost always warm.
   */
  const tables = useTables();
  const tableNameFor = createMemo(() => {
    const names = new Map<string, string>();
    for (const table of tables.data ?? []) names.set(table.id, table.name);
    return (tableId: string | null) => (tableId === null ? null : (names.get(tableId) ?? null));
  });

  const failed = usePrintJobs('failed');

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.openChecks });
    void queryClient.invalidateQueries({ queryKey: queryKeys.printJobs('failed') });
  };

  const connection = createLive([RESTAURANT_CHANNEL], {
    onEvent(event) {
      // The board. `applyBoardEvent` returns the same array when nothing
      // changed, so an event about a check this screen is not showing costs a
      // `setQueryData` that does nothing and re-renders nothing.
      queryClient.setQueryData<CheckSummary[]>(queryKeys.openChecks, (board) =>
        applyBoardEvent(board ?? [], event, tableNameFor()),
      );

      if (boardNeedsRefetch(queryClient.getQueryData<CheckSummary[]>(queryKeys.openChecks) ?? [], event)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.openChecks });
      }

      /*
       * A check the cashier has open, changed by somebody else — a waiter
       * sending a round to the table they are about to settle. The event
       * carries the new total but not the new lines, so the detail is
       * invalidated rather than patched: this is the one screen where being a
       * few hundred milliseconds behind is worse than a request, because the
       * number under the cashier's thumb is the number they are about to
       * charge.
       */
      if (event.name === 'round.sent' || event.name === 'item.voided' || event.name === 'check.paid') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.check(event.data.checkId) });
      }

      // The banner. Both printer events change which jobs are failed, and the
      // list is small and rarely non-empty, so it is refetched rather than
      // reduced — there is no board-sized cost to save here.
      if (event.name === 'print_job.failed' || event.name === 'print_job.printed') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.printJobs('failed') });
      }
    },
    onRefresh: refreshAll,
  });

  /**
   * What the connection is doing, in the app's own words — or nothing at all.
   *
   * `idle` gets no label, and that is the considered answer rather than an
   * omission. It is the **page-hidden** state and nothing else: `connectLive`
   * reaches it only when the document is hidden, and the four-hour quiet timer
   * falls back to polling rather than idling while somebody is still watching.
   * So there is nobody reading anything at the moment it is true, and the one
   * frame it is painted for is the frame after the tablet wakes and before the
   * visibility handler has reconnected. Saying "checking every few seconds"
   * there would be a claim about a screen that is checking nothing.
   */
  const status = (): string | null => {
    switch (connection()) {
      case 'live':
        return m().cashier.live;
      case 'polling':
        return m().cashier.polling;
      case 'connecting':
        return m().cashier.reconnecting;
      case 'idle':
        return null;
    }
  };

  const signOut = () => {
    setSigningOut(true);
    void app.signOut().catch(() => setSigningOut(false));
  };

  const [retrying, setRetrying] = createSignal(false);
  const retryAll = async () => {
    setRetrying(true);
    try {
      // Every stuck ticket at once. The cause is almost always one thing — the
      // printer was off, or out of paper — so retrying them one at a time would
      // be a cashier pressing the same button four times for one fault.
      await Promise.all((failed.data ?? []).map((job) => retryPrintJob(job.id)));
    } finally {
      setRetrying(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.printJobs('failed') });
    }
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

          <Show when={(failed.data ?? []).length > 0}>
            <div class="error-banner" role="alert">
              <div class="section-head">
                <div>
                  <strong>{m().cashier.printFailed((failed.data ?? []).length)}</strong>
                  <For each={failed.data}>
                    {(job: PrintJobView) => (
                      <div>
                        {m().cashier.printFailedLine(
                          job.tableName ?? m().waiter.takeaway,
                          job.lastError ?? m().cashier.printFailedNoReason,
                        )}
                      </div>
                    )}
                  </For>
                </div>
                <Button variant="outlined" disabled={retrying()} onClick={() => void retryAll()}>
                  {m().cashier.retryPrint}
                </Button>
              </div>
            </div>
          </Show>

          {props.children}

          {/*
            The connection, said quietly at the bottom.

            It is here because a cashier watching a board that has stopped
            moving has no other way to tell "nothing is happening" from "this
            screen stopped listening ten minutes ago" — and the answer changes
            what they do. `polling` is not a failure and does not look like one:
            local development runs with no Upstash at all, and the five-second
            fallback is a perfectly good way to run a till.
          */}
          <p class="stat-label" style={{ margin: '0', 'text-align': 'right' }}>
            {status()}
          </p>
        </div>
      )}
    </Show>
  );
}
