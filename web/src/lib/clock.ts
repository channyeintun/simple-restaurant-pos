import { type Accessor, createSignal, onCleanup, onMount } from 'solid-js';

/**
 * A clock that ticks, for the screens that draw a countdown.
 *
 * `roundTiming` takes `nowMs` as a parameter — which is what makes it a pure
 * function with test cases — so something has to supply a *changing* now, or a
 * table that has been waiting eleven minutes goes on saying four until
 * somebody navigates.
 *
 * ## One timer, however many components read it
 *
 * The signal and the interval are at module scope and reference-counted, the
 * same shape `subscribeLive` uses for the SSE stream and for the same reason:
 * the waiter's grid draws a timer per table and the pane beside it draws one
 * per round, and a dozen independent intervals all firing to compute the same
 * number is a dozen wake-ups a minute on a device somebody is holding. The
 * last component to unmount stops the clock, so a screen with no timers on it
 * costs nothing at all.
 *
 * ## Fifteen seconds
 *
 * Everything drawn from this is in whole minutes, so the only thing the
 * interval decides is how long a stale minute can linger — up to fifteen
 * seconds, which nobody will catch. Ticking every second would be sixty times
 * the wake-ups to change the same number four times an hour.
 *
 * It keeps ticking while the page is hidden, which is a small waste and the
 * cheaper of the two mistakes: pausing it would mean a tablet woken from a
 * pocket shows a frozen clock for up to fifteen seconds, and a frozen clock on
 * a screen about lateness is worse than a timer nobody was looking at.
 */
const TICK_MS = 15_000;

const [now, setNow] = createSignal(Date.now());
let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function createNow(): Accessor<number> {
  onMount(() => {
    readers += 1;
    if (!timer) {
      // Re-read immediately: the signal may be holding whatever the last reader
      // left behind, which on a screen re-entered after ten minutes would be
      // ten minutes wrong for up to fifteen seconds.
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), TICK_MS);
    }
    onCleanup(() => {
      readers -= 1;
      if (readers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    });
  });

  return now;
}
