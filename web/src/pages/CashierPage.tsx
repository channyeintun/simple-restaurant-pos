import { type CheckSummary, type PrintJobView, RESTAURANT_CHANNEL } from '@pos/shared';
import type { RouteSectionProps } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { retryPrintJob } from '../api/orders.js';
import { Button, StaffBar } from '../components/ui.js';
import { applyBoardEvent, boardNeedsRefetch } from '../lib/board.js';
import { createLive } from '../lib/live.js';
import { queryKeys, useOpenChecks, usePrintJobs, useStuckQueue, useTables } from '../lib/queries.js';
import { platform } from '../platform/index.js';
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
  const pending = useStuckQueue();

  /*
   * The one noise this app makes, and the two awkward parts of making it.
   *
   * Browsers refuse audio until the page has been interacted with, so the clip
   * is unlocked from inside a real gesture — `onInteraction` fires on
   * `pointerdown` and `keydown`, which both qualify. A cashier touches this
   * screen within seconds of a shift starting, so in practice it is primed long
   * before the first order; a till nobody has touched all morning has nobody
   * listening to it either.
   *
   * `prime()` is idempotent, so subscribing to every interaction rather than
   * unsubscribing after the first costs one boolean check per tap and saves a
   * teardown that would have to get the ordering right.
   */
  const [soundOn, setSoundOn] = createSignal(platform.sound.enabled());
  /**
   * Set when the browser refused to make a noise it was asked to make.
   *
   * There is no third setting here — sound is on or off, and this is neither.
   * It is the till reporting that it *tried*: a tablet that has not been
   * touched since it was unlocked has an autoplay policy in front of its
   * speaker, and the only cure is a tap. Without this the control says Sound
   * on, orders land, nothing is heard, and there is no way to tell that from a
   * broken speaker or a cook who has gone home.
   */
  const [soundBlocked, setSoundBlocked] = createSignal(false);
  onMount(() => {
    const stop = platform.visibility.onInteraction(() => platform.sound.prime());
    onCleanup(stop);
  });

  /**
   * Make the noise, and believe the answer.
   *
   * `play` resolves false for two different reasons and only one of them is a
   * fault: sound switched off is a choice, and a refused play is a problem. The
   * `enabled()` check is what tells them apart.
   */
  const ping = async () => {
    const played = await platform.sound.play('newOrder');
    if (played) setSoundBlocked(false);
    else if (platform.sound.enabled()) setSoundBlocked(true);
  };

  const toggleSound = () => {
    const next = !soundOn();
    platform.sound.setEnabled(next);
    setSoundOn(next);
    if (!next) {
      setSoundBlocked(false);
      return;
    }
    // Play it on the way *on* so the person pressing it hears what they just
    // switched on — a mute toggle that gives no feedback is one people press
    // twice. It doubles as the cure for a blocked speaker: this call is inside
    // a real tap, which is the one thing an autoplay policy accepts.
    platform.sound.prime();
    void ping();
  };

  /**
   * The ping, from the **board** rather than from the event stream.
   *
   * This used to hang off `onEvent`, which was wrong in a way that only shows
   * up on a bad night. The stream is not the only way this screen learns that
   * an order landed — when it is down the cashier falls back to polling every
   * five seconds, and the board fills in perfectly well. It just did so in
   * silence, with the control still saying Sound on, on exactly the evening
   * when nobody should be watching a screen to find out.
   *
   * `roundCount` is the signal because it is the one the two transports share:
   * `applyBoardEvent` increments it on `round.sent` and a refetch brings the
   * server's number. Watching it covers both with one rule and cannot ping
   * twice for one round.
   *
   * The first snapshot only establishes a baseline. A till opening at eleven in
   * the morning to a board with four checks on it has not just been sent four
   * orders, and a screen that announced them would teach the cashier to ignore
   * the sound by lunchtime. The same is true of a reconnect, except there it is
   * a judgement call rather than an obvious one: rounds that arrived while the
   * stream was down *are* news, so they ping, once, however many there were.
   */
  const board = useOpenChecks();
  let seenRounds: Map<string, number> | null = null;
  createEffect(() => {
    const checks = board.data;
    if (!checks) return;

    const next = new Map(checks.map((check) => [check.id, check.roundCount]));
    const baseline = seenRounds;
    seenRounds = next;
    if (baseline === null) return;

    for (const [id, count] of next) {
      const before = baseline.get(id);
      // A check this board has not seen before counts as new only once it has
      // a round on it: `check.opened` and `round.sent` arrive a beat apart and
      // the first of them is not an order.
      if (before === undefined ? count > 0 : count > before) {
        void ping();
        return;
      }
    }
  });

  /**
   * How long the oldest unprinted ticket has been waiting, in whole minutes.
   *
   * Null when the queue is empty or moving normally. The threshold is two
   * minutes because that is comfortably longer than the worst honest case —
   * the agent polls every three seconds, and a dead printer resolves to
   * `failed` in about twenty — so anything past it means no process is emptying
   * the queue at all.
   *
   * `app.serverNow()` is not a thing and deliberately so: this compares against
   * the tablet's own clock, which is the one case in this app where that is
   * right. A tablet whose clock is wrong by minutes would misreport this, and a
   * tablet whose clock is wrong by minutes has worse problems; every *stored*
   * time in this app is the Worker's, and this is a duration on a screen rather
   * than a fact in the database.
   */
  const stuckMinutes = createMemo(() => {
    const jobs = pending.data ?? [];
    if (jobs.length === 0) return null;
    const oldest = jobs.reduce(
      (earliest, job) => Math.min(earliest, Date.parse(job.createdAt)),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(oldest)) return null;
    const minutes = Math.floor((Date.now() - oldest) / 60_000);
    return minutes >= 2 ? minutes : null;
  });

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
      if (
        event.name === 'round.sent' ||
        event.name === 'round.delivered' ||
        event.name === 'item.voided' ||
        event.name === 'check.paid' ||
        // A second till settling somebody else's dish changes which lines are
        // still pickable on the check this one is looking at, and picking a
        // line that has just been paid for is a 409 in front of a customer.
        event.name === 'check.part_paid'
      ) {
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

          {/*
            The quieter of the two printer warnings, and the one that covers the
            hole the red banner cannot: a job is only `failed` once the agent has
            *tried* it, so a machine that is switched off leaves every ticket at
            `pending` and the red banner silent. The kitchen just stops getting
            orders.

            Amber rather than red, and the wording is different on purpose. Red
            is "the kitchen definitely never got this round, go and tell them".
            This is "nothing is printing, go and look at the machine" — and the
            orders themselves are safe, which the second line says, because the
            first thing anybody will want to know is whether they have to re-key
            the evening.
          */}
          <Show when={stuckMinutes()}>
            {(minutes) => (
              <div
                role="alert"
                style={{
                  padding: '14px 16px',
                  'border-radius': 'var(--pos-radius-row)',
                  background: 'var(--pos-open-container)',
                  color: 'var(--pos-open)',
                  'font-size': '1rem',
                }}
              >
                <strong>{m().cashier.queueStuck(minutes())}</strong>
                <br />
                {m().cashier.queueStuckBody}
              </div>
            )}
          </Show>

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
          {/*
            Device-level state, together, out of the way: whether this screen is
            hearing the room and whether it is making a noise about it. Both
            belong to the tablet rather than to whoever is standing at it, which
            is why neither is in the staff bar.
          */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'flex-end',
              gap: 'var(--pos-gap)',
            }}
          >
            {/*
              Three labels, two states. Blocked is not a setting the cashier
              chose, so it does not get a third position in the toggle — it
              replaces the "on" label with the one thing that fixes it, and
              tapping still means the same thing it always meant. The tap that
              turns sound off and on again is itself the gesture the browser
              was holding out for.
            */}
            <Button variant="text" onClick={toggleSound}>
              {soundOn()
                ? soundBlocked()
                  ? m().cashier.soundBlocked
                  : m().cashier.soundOn
                : m().cashier.soundOff}
            </Button>
            <p class="stat-label" style={{ margin: '0' }}>
              {status()}
            </p>
          </div>
        </div>
      )}
    </Show>
  );
}
