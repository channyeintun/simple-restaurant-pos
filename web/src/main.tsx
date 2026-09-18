import { Router } from '@solidjs/router';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { render } from 'solid-js/web';
import { App } from './App.js';
import { platform } from './platform/index.js';
import { routes } from './router.js';
import { LocaleProvider } from './state/locale.js';
import './styles.css';

/**
 * The entry point: mount the app, then register the service worker.
 */

/**
 * One client for the whole app; every read goes through it.
 *
 * `refetchOnWindowFocus` is left **on**, which is the opposite of what the
 * reference does, and the reason is the difference between a phone and a till.
 * There, a phone coming out of a pocket would fire a burst of requests across
 * every mounted query for a screen nobody had looked at in an hour. Here, a
 * tablet waking up is a person picking it up to do something — and what they
 * are about to do is charge somebody for what is on the screen. A stale open
 * check is worse than a request, there are four tablets rather than a group
 * chat's worth of phones, and the Workers budget the whole design is bounded by
 * is nowhere near this: the printer agent's own polling is twice the traffic
 * every tablet in the building makes.
 *
 * `gcTime` outliving the component is what stops switching screens showing a
 * spinner for data that is already in hand; the call sites tell the difference
 * with `isPending` against `isFetching`.
 *
 * Realtime events are applied with `queryClient.setQueryData` and never by
 * refetching — the payloads are self-sufficient precisely so that a cashier
 * watching a busy service does not spend a request per event.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 30 * 60_000,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

/*
 * `App` is the router's root layout rather than a component wrapped around it:
 * it has to see the current path — the claim screen runs with no credential,
 * the PIN screen with a device but no staff — and as the root it gets the
 * matched route as its children and decides whether to render it.
 */
render(
  () => (
    <QueryClientProvider client={queryClient}>
      {/*
        `LocaleProvider` wraps the router rather than sitting inside `App`, so
        that the effect reflecting the language onto `<html lang>` is owned for
        the whole life of the app. The locale signal itself lives at module
        scope either way — see `state/locale.tsx` — so this is about the
        effect's owner, not about where the state is.
      */}
      <LocaleProvider>
        <Router root={App}>{routes}</Router>
      </LocaleProvider>
    </QueryClientProvider>
  ),
  container,
);

// Registered after render so it never delays first paint. Failure is fine — it
// only costs the offline shell, not the app.
void platform.registerServiceWorker();
