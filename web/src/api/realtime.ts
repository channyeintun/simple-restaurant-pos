import { type RealtimeEvent, parseWireEvent, wireSystemEventSchema } from '@pos/shared';
import { platform } from '../platform/index.js';
import type { EventStream } from '../platform/index.js';
import { post } from './client.js';

/**
 * Live updates, with a deliberate cost model.
 *
 * `@upstash/realtime`'s SSE handler publishes a keepalive every 10 seconds per
 * open connection — 360 Redis commands per connection-hour, fixed by
 * `KEEPALIVE_INTERVAL_MS` in `api/src/realtime.rs` and not configurable from
 * out here. Upstash's free tier is 500,000 commands a month, so an open stream
 * is the most expensive thing this app can do and everything below is
 * arithmetic against that one number.
 *
 * Which is why **only the cashier page ever calls this.** Waiter tablets fetch
 * a table's check when the table is opened — a waiter is looking at one table
 * at a time and has just caused the change they are looking at — and the
 * printer agent polls for its jobs. One subscriber, one channel, `restaurant`.
 * A twelve-hour service with the cashier's stream open throughout costs 4,320
 * commands, roughly 130,000 a month, and that is the largest line in the
 * budget CLAUDE.md sets out.
 *
 * Within that, the rules this client follows:
 *
 *   * **visible and recently used** → SSE, updates arrive instantly.
 *   * **visible but idle for four hours** → close the stream, poll every 5s.
 *     Polling costs Worker requests (cheap, 100k/day) and zero Redis commands.
 *   * **backgrounded** → nothing at all; refresh once on return.
 *
 * Two of those numbers are not the reference's, and the difference between
 * them is the difference between the two apps. The poll is 5 seconds rather
 * than 30 because the thing waiting on it is not somebody glancing at a
 * fixture list — it is a cashier holding a card machine with a customer in
 * front of them, and half a minute of that is an apology. The idle timeout is
 * four hours rather than five minutes because the cashier's tablet sits
 * untouched on the counter through a quiet afternoon and has to be live the
 * moment somebody walks up to it; 1,440 commands is what that costs and it is
 * cheaper than making them reconnect.
 *
 * Page-hidden still closes the stream immediately, and that is the rule that
 * actually protects the budget. A tablet that gets locked, or switched away
 * from to answer the phone, stops costing anything within the second — which
 * is most of the hours in a day, and is why the generous idle timeout above is
 * affordable at all.
 *
 * The same fallback covers failure: if the stream errors, or the server has no
 * Upstash credentials configured, the caller keeps getting `onRefresh` on a
 * 5-second cadence and the screen simply updates a little later.
 */

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'idle';

export interface LiveOptions {
  channels: string[];
  /** A typed event arrived. Apply it to local state without refetching. */
  onEvent(event: RealtimeEvent): void;
  /** Refetch everything: a poll tick, or coming back from the background. */
  onRefresh(): void;
  onStateChange?(state: ConnectionState): void;
}

export interface LiveConnection {
  close(): void;
}

const POLL_INTERVAL_MS = 5_000;
/** How long without interaction before an open stream is not worth its cost. */
const IDLE_TIMEOUT_MS = 4 * 60 * 60_000;
/** While polling, occasionally try to get back to a live stream. */
const RETRY_LIVE_INTERVAL_MS = 2 * 60_000;
const MAX_STREAM_RETRIES = 3;

export function connectLive(options: LiveOptions): LiveConnection {
  let stream: EventStream | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryLiveTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  let closed = false;
  let retries = 0;
  /** Set once the server tells us realtime is not configured at all. */
  let realtimeUnavailable = false;
  let state: ConnectionState = 'connecting';
  let lastInteraction = Date.now();

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  /* ------------------------------------------------------------- teardown */

  const closeStream = () => {
    stream?.close();
    stream = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const stopRetryingLive = () => {
    if (retryLiveTimer) clearTimeout(retryLiveTimer);
    retryLiveTimer = null;
  };

  /* -------------------------------------------------------------- polling */

  const startPolling = () => {
    if (closed || pollTimer) return;
    closeStream();
    setState('polling');
    pollTimer = setInterval(() => options.onRefresh(), POLL_INTERVAL_MS);

    // Realtime that is merely *broken* is worth retrying; realtime that is
    // switched off server-side is not.
    if (!realtimeUnavailable) {
      stopRetryingLive();
      retryLiveTimer = setTimeout(() => {
        retries = 0;
        stopPolling();
        void openStream();
      }, RETRY_LIVE_INTERVAL_MS);
    }
  };

  /* --------------------------------------------------------------- stream */

  const openStream = async (): Promise<void> => {
    if (closed || stream) return;

    if (realtimeUnavailable || !platform.visibility.isVisible()) {
      if (!platform.visibility.isVisible()) goIdle();
      else startPolling();
      return;
    }

    setState('connecting');

    let ticket: string;
    try {
      const result = await post<{ ticket: string; enabled: boolean }>('/realtime/ticket');
      if (!result.enabled) {
        realtimeUnavailable = true;
        startPolling();
        return;
      }
      ticket = result.ticket;
    } catch {
      startPolling();
      return;
    }
    if (closed) return;

    const query = new URLSearchParams();
    for (const channel of options.channels) query.append('channels', channel);
    query.set('ticket', ticket);

    stream = platform.openEventStream(
      `${platform.apiBaseUrl}/realtime/stream?${query.toString()}`,
      {
        onOpen() {
          retries = 0;
          stopPolling();
          stopRetryingLive();
          setState('live');
          // Anything that happened while disconnected is not in the stream, so
          // resynchronise once on every successful connect.
          options.onRefresh();
        },

        onMessage(raw) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return;
          }

          const system = wireSystemEventSchema.safeParse(parsed);
          if (system.success) {
            switch (system.data.type) {
              case 'reconnect':
                // The server caps stream duration; reopen with a fresh ticket.
                closeStream();
                reconnectTimer = setTimeout(() => void openStream(), 250);
                return;
              case 'error':
                closeStream();
                startPolling();
                return;
              // 'connected', 'ping' and 'disconnected' need no action — their
              // value is keeping the connection warm.
              default:
                return;
            }
          }

          const event = parseWireEvent(parsed);
          if (event) options.onEvent(event);
        },

        onError() {
          closeStream();
          if (closed) return;

          if (retries < MAX_STREAM_RETRIES) {
            retries++;
            const backoff = 1_000 * 2 ** (retries - 1);
            reconnectTimer = setTimeout(() => void openStream(), backoff);
          } else {
            // Give up on live updates and degrade to polling rather than
            // hammering a server that is clearly not cooperating.
            startPolling();
          }
        },
      },
    );
  };

  /* ------------------------------------------------------- idle / visible */

  function goIdle() {
    closeStream();
    stopPolling();
    stopRetryingLive();
    setState('idle');
  }

  const resetIdleTimer = () => {
    lastInteraction = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdleReached, IDLE_TIMEOUT_MS);

    // Interaction after a quiet spell earns a live stream back.
    if (!closed && platform.visibility.isVisible() && state === 'polling' && !realtimeUnavailable) {
      stopPolling();
      stopRetryingLive();
      retries = 0;
      void openStream();
    }
  };

  function onIdleReached() {
    if (closed || !platform.visibility.isVisible()) return;
    if (Date.now() - lastInteraction < IDLE_TIMEOUT_MS) return;
    // Still watching, just not touching. Polling is twelve Worker requests a
    // minute and no Redis commands at all, which against 100,000 requests a day
    // is not a number worth thinking about.
    closeStream();
    startPolling();
  }

  const unsubscribeVisibility = platform.visibility.subscribe((visible) => {
    if (closed) return;
    if (visible) {
      options.onRefresh();
      resetIdleTimer();
      if (!pollTimer && !stream) void openStream();
    } else {
      goIdle();
    }
  });

  const unsubscribeInteraction = platform.visibility.onInteraction(resetIdleTimer);

  /* ----------------------------------------------------------------- boot */

  resetIdleTimer();
  void openStream();

  return {
    close() {
      closed = true;
      closeStream();
      stopPolling();
      stopRetryingLive();
      if (idleTimer) clearTimeout(idleTimer);
      unsubscribeVisibility();
      unsubscribeInteraction();
    },
  };
}

/* ------------------------------------------------------- sharing the stream */

/**
 * One stream per channel set, shared by every component that asks for it, and
 * kept open briefly after the last one goes away.
 *
 * Two things were wrong without this. A component that unmounts on navigation
 * closed its stream and the next screen opened a fresh one, so the status
 * indicator flashed "connecting" on *every* trip back to the open-checks list
 * even though nothing about the connection had actually changed. And on the free
 * tier that reconnect is not free — an SSE stream costs a subscribe and a
 * ticket round-trip each time, paid on every navigation rather than once.
 *
 * The linger is what makes navigation free: leaving a screen keeps the stream
 * warm for long enough to come back to it, and only a genuine departure ends
 * up closing anything.
 */
const LINGER_MS = 30_000;

interface Subscriber {
  onEvent(event: RealtimeEvent): void;
  onRefresh(): void;
  onStateChange?(state: ConnectionState): void;
}

interface SharedStream {
  connection: LiveConnection | null;
  state: ConnectionState;
  subscribers: Set<Subscriber>;
  linger: ReturnType<typeof setTimeout> | null;
}

const shared = new Map<string, SharedStream>();

/** The state a newcomer should start at, so it never re-announces "connecting". */
export function liveStateFor(channels: string[]): ConnectionState {
  return shared.get(channels.join('|'))?.state ?? 'connecting';
}

export function subscribeLive(options: LiveOptions): LiveConnection {
  const key = options.channels.join('|');
  let entry = shared.get(key);

  if (entry?.linger) {
    clearTimeout(entry.linger);
    entry.linger = null;
  }

  if (!entry) {
    const created: SharedStream = {
      connection: null,
      state: 'connecting',
      subscribers: new Set(),
      linger: null,
    };
    shared.set(key, created);
    entry = created;
    created.connection = connectLive({
      channels: key.split('|'),
      onEvent: (event) => {
        for (const s of [...created.subscribers]) s.onEvent(event);
      },
      onRefresh: () => {
        for (const s of [...created.subscribers]) s.onRefresh();
      },
      onStateChange: (next) => {
        created.state = next;
        for (const s of [...created.subscribers]) s.onStateChange?.(next);
      },
    });
  }

  const live = entry;
  const subscriber: Subscriber = {
    onEvent: options.onEvent,
    onRefresh: options.onRefresh,
    onStateChange: options.onStateChange,
  };
  live.subscribers.add(subscriber);
  // Tell the newcomer where things already stand, rather than letting it sit
  // on its own initial guess until the next change.
  options.onStateChange?.(live.state);

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      live.subscribers.delete(subscriber);
      if (live.subscribers.size > 0) return;
      live.linger = setTimeout(() => {
        // Re-check: somebody may have subscribed and unsubscribed again while
        // the timer was pending.
        if (live.subscribers.size > 0) return;
        live.connection?.close();
        shared.delete(key);
      }, LINGER_MS);
    },
  };
}
