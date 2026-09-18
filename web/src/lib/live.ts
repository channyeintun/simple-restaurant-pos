import type { RealtimeEvent } from '@pos/shared';
import { type Accessor, createSignal, onCleanup, onMount } from 'solid-js';
import { type ConnectionState, liveStateFor, subscribeLive } from '../api/realtime.js';

/**
 * Subscribe a screen to realtime events for the given channels.
 *
 * This is the reference's `useLive` hook, ported. It is `createLive` rather
 * than `useLive` because Solid has no hooks: the body of a component runs once,
 * so this is an ordinary function that creates a signal and registers some
 * lifecycle under whatever owner is current. The naming follows Solid's own
 * (`createSignal`, `createEffect`) so that nobody reads it as a React hook and
 * starts worrying about the rules that go with one.
 *
 * In this app it has exactly one caller — the cashier page. `api/realtime.ts`
 * sets out why: an open SSE connection is 360 Upstash commands an hour, and the
 * budget only has room for one of them.
 *
 * ## The two things this exists to get right
 *
 * **The indicator must not flash "connecting" when nothing happened.** The
 * state signal is seeded from `liveStateFor()` rather than from `'connecting'`.
 * The stream is shared and lingers past unmount, so walking from the open-checks
 * list into one check and back does not touch the connection at all — but a
 * fresh signal starting at `'connecting'` would tell the reader it did, on
 * every trip, until the next state change corrected it. Seeding from the shared
 * stream is asking what is actually true rather than guessing.
 *
 * **A re-render must not tear the stream down.** In React that needed refs: the
 * component body re-ran on every render, `handlers.onEvent` was a new closure
 * each time, and an effect that depended on it would close and reopen the
 * connection — a ticket round trip and a fresh subscribe, per keystroke. Solid
 * runs the body once, so the closures captured below are already the only ones
 * there will ever be and the problem does not arise. The indirection is kept
 * anyway: the callbacks handed to `subscribeLive` read `handlers.onEvent` at
 * call time rather than capturing it, so a caller that hands over a mutable
 * object — a store, or props whose getters change — keeps working, and nobody
 * has to discover that the rule changed on the way across.
 */

export interface LiveHandlers {
  /**
   * A typed event arrived. Apply it to the query cache with `setQueryData` and
   * do not refetch: the payloads in `shared/src/events.ts` are self-sufficient
   * precisely so that a client never has to, and a round trip per event would
   * spend the budget this whole design exists to protect.
   */
  onEvent(event: RealtimeEvent): void;
  /**
   * Refetch everything. A poll tick, a successful reconnect — which has a gap
   * behind it that the stream cannot fill — or a return from the background.
   */
  onRefresh(): void;
}

/**
 * Returns the connection state as an accessor, for an indicator to read.
 *
 * `enabled` is a plain boolean, read once when the screen mounts, not a signal
 * or a getter. There is one caller and it wants a stream for as long as
 * it is on screen; a reactive flag would mean a `createEffect` here and a
 * connection that opens and closes as the flag moves, which is a cost model
 * nobody has asked for yet. Making it reactive later is a local change to this
 * file and to nothing else.
 */
export function createLive(
  channels: string[],
  handlers: LiveHandlers,
  enabled = true,
): Accessor<ConnectionState> {
  const [state, setState] = createSignal<ConnectionState>(liveStateFor(channels));

  // The reference joined the channels into a string and split it again, so that
  // its effect's dependency array compared by value rather than by array
  // identity. There is no dependency array here and this runs once, so the list
  // goes through as it stands.
  onMount(() => {
    if (!enabled || channels.length === 0) return;

    const connection = subscribeLive({
      channels,
      onEvent: (event) => handlers.onEvent(event),
      onRefresh: () => handlers.onRefresh(),
      onStateChange: setState,
    });

    // Inside `onMount`, so the teardown belongs to this screen's owner and runs
    // when it is disposed. That is the whole of the lifecycle port: `onMount`
    // for "there is a document and a screen on it", `onCleanup` for "this
    // screen is gone". What `close()` does is release a subscriber, not hang up
    // — `subscribeLive` keeps the stream warm for a while in case somebody
    // comes back, which is what makes navigating between cashier screens free.
    onCleanup(() => connection.close());
  });

  return state;
}
