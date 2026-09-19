import { onCleanup, onMount } from 'solid-js';
import { platform } from '../platform/index.js';

/**
 * Ask again, every so often, while somebody is looking.
 *
 * ## Why the waiter polls when the cashier has a stream
 *
 * Because the two budgets are not the same size, and this app is shaped around
 * that one fact. An SSE subscription costs 360 Upstash commands an hour per
 * connection — for silence as much as for events — against a free tier of
 * 500,000 a month, which has room for exactly one such connection in the
 * building. That one is the till's. A second tablet on the stream would take
 * the month from roughly 173,000 to over 300,000, and a fourth would not fit
 * at all.
 *
 * A poll costs Worker requests instead, and those are 100,000 a **day**. Four
 * tablets asking every ten seconds through a twelve-hour service is about
 * 17,000 of them, next to the printer agent's 17,000 and the cashier's 11,000.
 * So the scarce budget buys the screen that has to be instant, and the abundant
 * one buys the screens that have to be current — which is the same trade
 * `CLAUDE.md` makes for the printer agent, for the same reason.
 *
 * ## Why the waiter needs it at all
 *
 * The rule that waiter tablets do not subscribe was written alongside the
 * claim that a waiter "has just caused the change they are looking at". That is
 * true of rounds and it is not true of money: the cashier settles a table from
 * a different tablet across the room, and until that reaches the grid the
 * waiter is looking at a table that says it is occupied and owes 30,000 Ks
 * while the customers are putting their coats on.
 *
 * ## Hidden means stopped
 *
 * Not throttled — stopped, and the same rule the cashier's stream follows. A
 * tablet face-down on a counter or in an apron pocket is not being read by
 * anybody, and the cheapest request is the one nobody makes. Coming back runs
 * the callback **immediately** rather than waiting out the interval, because
 * the moment a tablet is taken out of a pocket is exactly when what is on it is
 * most likely to be ten minutes stale.
 */
export function createPoll(everyMs: number, run: () => void): void {
  onMount(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(run, everyMs);
    };

    if (platform.visibility.isVisible()) start();

    const unsubscribe = platform.visibility.subscribe((visible) => {
      if (!visible) {
        stop();
        return;
      }
      // Catch up first, then resume the cadence — a tablet woken after an hour
      // should not show an hour-old floor for another ten seconds.
      run();
      start();
    });

    onCleanup(() => {
      stop();
      unsubscribe();
    });
  });
}
