import type {
  AppUpdated,
  EventStream,
  EventStreamHandlers,
  Install,
  Platform,
  Sound,
  SoundName,
} from './index.js';

/**
 * Browser implementation of the platform seam. This is the only file in the
 * frontend allowed to reference `window`, `document`, `localStorage`,
 * `navigator` or `EventSource`.
 *
 * It is also, after the trim described in `index.ts`, the only file in the
 * frontend that imports nothing from a framework. The reference's copy had one
 * React import — `flushSync`, for the view transition — and that line is the
 * single porting difference between the two files; see `viewTransition` below
 * for why Solid does not need it.
 */

const STORAGE_PREFIX = 'pos:';

const storage: Platform['storage'] = {
  get(key) {
    try {
      return localStorage.getItem(STORAGE_PREFIX + key);
    } catch {
      // Private browsing modes throw rather than degrade. Treat as empty.
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch {
      /* nothing we can do; the session simply will not persist */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};

const clipboard: Platform['clipboard'] = {
  async write(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Falls through to the legacy path — chat webviews often block the
      // async clipboard API but still allow execCommand.
    }
    return legacyCopy(text);
  },

  async read() {
    try {
      if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
    } catch {
      // Denied, or no permission prompt available. There is no legacy fallback
      // for reading — `execCommand('paste')` was never allowed — so the caller
      // falls back to letting the user paste into a field themselves.
    }
    return null;
  },
};

/** `document.execCommand` is deprecated but is the only path in some webviews. */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- navigation */

const listeners = new Set<(path: string) => void>();

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

function notify() {
  const path = currentPath();
  for (const listener of listeners) listener(path);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
  // A URL that differs only in its fragment is a same-document navigation:
  // no reload, no popstate. Claim links live in the fragment, so without this
  // opening a second one in an already-open tab would appear to do nothing.
  window.addEventListener('hashchange', notify);
}

/**
 * Run a state change inside a view transition.
 *
 * The reference ran the callback through React's `flushSync`, and the absence
 * of anything like it here is the one thing in this file a reader coming from
 * that code will stop at. `startViewTransition` snapshots the DOM, calls this
 * back, then snapshots again — so whatever `change` does has to be in the DOM
 * by the time the callback returns. React schedules its render, so it has to be
 * told to do it now; without that it painted after the transition had already
 * given up and the animation cross-faded a screen into itself.
 *
 * Solid has nothing to flush. Writing a signal runs the computations that read
 * it synchronously, and a `batch` runs them before it returns, so by the time
 * `change()` has returned the DOM is already the new screen. The port is one
 * import deleted and one call unwrapped, and it is worth the paragraph because
 * the obvious reading of the deletion is that somebody forgot it.
 */
interface ViewTransitionHandle {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
}

const viewTransition: Platform['viewTransition'] = (change) => {
  const start = (
    document as Document & {
      startViewTransition?: (cb: () => void) => ViewTransitionHandle;
    }
  ).startViewTransition;

  // Motion is a preference, not a default. Anyone who has asked for less of it
  // gets the same navigation without the cross-fade.
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  if (typeof start !== 'function' || reduced) {
    change();
    return;
  }

  const transition = start.call(document, change);

  // A transition that is superseded — two taps in quick succession, or a
  // backgrounded tab — rejects these with `AbortError`. Nothing is wrong and
  // there is nothing to do, but an unhandled rejection would show up in the
  // console and in any error reporting attached to it.
  transition.finished.catch(() => {});
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
};

/**
 * How many entries this app has pushed onto the history stack.
 *
 * `history.length` cannot answer "can I go back *within the app*" — it counts
 * everything the tab has ever visited, including whatever page the user was on
 * before they opened the claim link. Going back from the first screen would
 * then leave the app entirely. Counting our own pushes is the only reliable
 * way to know there is somewhere of ours to return to.
 *
 * A `popstate` decrements it, so walking back down the stack eventually
 * reaches zero and the back button starts falling through to home instead.
 */
let ownDepth = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    ownDepth = Math.max(0, ownDepth - 1);
  });
}

const navigation: Platform['navigation'] = {
  path: currentPath,
  // `instant`, not smooth: this runs inside a view transition, and a
  // smooth-scroll would still be travelling after the cross-fade had finished.
  scrollToTop: () => window.scrollTo({ top: 0, behavior: 'instant' }),
  hash: () => window.location.hash.replace(/^#/, ''),
  canGoBack: () => ownDepth > 0,
  back() {
    if (ownDepth === 0) return false;
    // `history.back()` is asynchronous and fires `popstate`, which the counter
    // above and the path subscribers both listen for — so nothing needs to be
    // notified here.
    window.history.back();
    return true;
  },
  push(path) {
    window.history.pushState({}, '', path);
    ownDepth += 1;
    notify();
  },
  replace(path) {
    window.history.replaceState({}, '', path);
    notify();
  },
  reload() {
    window.location.reload();
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/* -------------------------------------------------------------- visibility */

const visibility: Platform['visibility'] = {
  isVisible() {
    return document.visibilityState === 'visible';
  },
  subscribe(listener) {
    const handler = () => listener(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  onInteraction(listener) {
    const events = ['pointerdown', 'keydown', 'focus'] as const;
    for (const event of events) {
      window.addEventListener(event, listener, { passive: true });
    }
    return () => {
      for (const event of events) window.removeEventListener(event, listener);
    };
  },
};

/* ------------------------------------------------------------ event stream */

function openEventStream(url: string, handlers: EventStreamHandlers): EventStream {
  // `withCredentials` is deliberately off: the stream authenticates with a
  // short-lived ticket in the query string, so the server can keep its
  // permissive CORS header and this works cross-origin on every browser.
  const source = new EventSource(url);

  source.onopen = () => handlers.onOpen();
  source.onmessage = (event: MessageEvent<string>) => handlers.onMessage(event.data);
  source.onerror = () => handlers.onError();

  return {
    close() {
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
    },
  };
}

/* -------------------------------------------------------------- language */

function deviceLanguage(): string | null {
  return navigator.languages?.[0] ?? navigator.language ?? null;
}

/**
 * `<html lang>` is not cosmetic here: it is what tells the browser to pick a
 * Myanmar font for Burmese text and to line-break a script that has no spaces
 * between words.
 */
function setDocumentLanguage(tag: string): void {
  document.documentElement.lang = tag;
}

/* ---------------------------------------------------------------- splash */

/**
 * Take down the boot splash that `index.html` painted.
 *
 * A cut rather than a fade, deliberately. The splash field is the app's own
 * background colour, so removing it changes nothing but the mark — while a
 * cross-fade would dissolve the receipt `index.html` draws into whatever the
 * first screen paints in the same third of the frame, two marks on screen at
 * once for the length of the animation.
 *
 * No `requestAnimationFrame` to bridge the swap either. Callers reach this from
 * `onMount`, which Solid runs once the component's nodes are in the document,
 * so `#root` already holds the screen and the next frame paints it. There is no
 * gap.
 */
function dismissSplash(): void {
  document.getElementById('splash')?.remove();
}

/* --------------------------------------------------------- service worker */

/* ---------------------------------------------------------------- install */

/**
 * The install prompt, captured before any component exists.
 *
 * `beforeinstallprompt` fires once, early, and the event object is the *only*
 * way to show the prompt afterwards — so it is caught at module scope rather
 * than in a component, which might not be mounted yet and would then miss it
 * for the life of the page. `preventDefault` stops Chrome's own mini-infobar,
 * because the app puts the offer somewhere deliberate: beside the language
 * toggle on the PIN screen, which is what a tablet sits on between shifts.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallPromptEvent | null = null;
const installListeners = new Set<(available: boolean) => void>();

function announceInstall() {
  for (const listener of [...installListeners]) listener(deferredInstall !== null);
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
  announceInstall();
});

// Once it is installed there is nothing left to offer, and the browser will not
// fire `beforeinstallprompt` again. Dropping the held event is what takes the
// control off the screen.
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  announceInstall();
});

const install: Install = {
  subscribe(listener) {
    installListeners.add(listener);
    // Immediately, so a screen that mounts after the event still learns.
    listener(deferredInstall !== null);
    return () => installListeners.delete(listener);
  },
  async prompt() {
    const event = deferredInstall;
    if (!event) return false;
    // Spent either way. The browser refuses a second `prompt()` on the same
    // event, so keeping it would leave a button that silently does nothing.
    deferredInstall = null;
    announceInstall();
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      return outcome === 'accepted';
    } catch {
      return false;
    }
  },
};

/* ----------------------------------------------------------------- update */

/**
 * A new build took over from under a running page.
 *
 * `controllerchange` is the signal, and the guard is the whole subtlety: it
 * also fires the first time a service worker ever claims this page, and telling
 * somebody their brand-new install is out of date on its first launch would be
 * nonsense. Sampling `navigator.serviceWorker.controller` when the listener is
 * registered — before any of this has had a chance to change — is what tells
 * "replaced" from "arrived".
 */
const onAppUpdated: AppUpdated = (listener) => {
  if (!('serviceWorker' in navigator)) return () => {};
  const wasControlled = navigator.serviceWorker.controller !== null;
  const handler = () => {
    if (wasControlled) listener();
  };
  navigator.serviceWorker.addEventListener('controllerchange', handler);
  return () => navigator.serviceWorker.removeEventListener('controllerchange', handler);
};

async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return true;
  } catch (error) {
    console.warn('Service worker registration failed', error);
    return false;
  }
}

/* ------------------------------------------------------------------ sound */

/**
 * Where the clips live. One entry today; the map is what stops the next one
 * being a string literal somewhere in a component.
 *
 * `/sounds/` is served straight out of `web/public/`, so adding a clip is
 * dropping a file in — no import, no build step, and no bundle growth. A file
 * that is not there costs a 404 and a rejected promise that nobody sees, which
 * is the behaviour wanted: a restaurant that has not supplied a sound gets a
 * silent till rather than an error.
 */
const SOUND_SOURCES: Record<SoundName, string> = {
  newOrder: '/sounds/new-order.mp3',
};

/** Per device, like the language. Absent means on. */
const SOUND_KEY = 'sound.enabled';

const soundCache = new Map<SoundName, HTMLAudioElement>();
let soundPrimed = false;

function soundElement(name: SoundName): HTMLAudioElement {
  let audio = soundCache.get(name);
  if (!audio) {
    audio = new Audio(SOUND_SOURCES[name]);
    // The clip is a few kilobytes and is wanted the instant an order lands, so
    // it is fetched when the element is built rather than on first play — the
    // first ping of a service should not be the one that waits for a download.
    audio.preload = 'auto';
    soundCache.set(name, audio);
  }
  return audio;
}

function soundEnabled(): boolean {
  return storage.get(SOUND_KEY) !== 'off';
}

const sound: Sound = {
  prime() {
    if (soundPrimed) return;
    soundPrimed = true;
    for (const name of Object.keys(SOUND_SOURCES) as SoundName[]) {
      const audio = soundElement(name);
      /*
       * Play it muted and stop it again. That is the whole trick: what an
       * autoplay policy actually gates is whether an element has been played
       * during a gesture, so a muted play inside one buys the element the right
       * to make noise later, when nobody is touching the screen.
       *
       * Both paths put `muted` back. A rejection here means the gesture was not
       * one the browser accepted — leaving the element muted would then make
       * the first real ping silent and look like a broken speaker.
       */
      audio.muted = true;
      audio
        .play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        })
        .catch(() => {
          audio.muted = false;
        });
    }
  },

  play(name) {
    if (!soundEnabled()) return;
    const audio = soundElement(name);
    // Rewind first, so two orders a second apart are two pings rather than one
    // — `play()` on an element that is already playing does nothing at all.
    audio.currentTime = 0;
    void audio.play().catch(() => {
      /* No clip, or never primed. Silence is the correct failure here. */
    });
  },

  enabled: soundEnabled,

  setEnabled(on) {
    storage.set(SOUND_KEY, on ? 'on' : 'off');
  },
};

/* ----------------------------------------------------------------- random */

/**
 * A random id for one attempt at something. Its only caller is the key on a
 * tap of Send to kitchen.
 *
 * `crypto.randomUUID` needs a secure context — HTTPS or localhost — and a
 * restaurant running this over plain HTTP on its own LAN is exactly the kind of
 * place that has neither. On such a page `crypto.randomUUID` is `undefined` and
 * calling it throws, at the moment a waiter presses the button, which is the
 * worst possible moment for this app to discover a platform difference.
 *
 * So there are three steps down. `randomUUID`, then `getRandomValues`, then the
 * timestamp-and-`Math.random` pair — and the last one is fine for what this is
 * actually for. The key has to be **unique**, so that one tablet's tap is not
 * mistaken for another's; it does not have to be unguessable, because guessing
 * one gets you nothing but a replay of a round that already exists. The
 * millisecond plus twelve random characters is unique across every tablet in a
 * restaurant by a margin of many orders of magnitude.
 */
function randomId(): string {
  const api = globalThis.crypto as Crypto | undefined;
  if (typeof api?.randomUUID === 'function') return api.randomUUID();
  if (typeof api?.getRandomValues === 'function') {
    const bytes = api.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/* -------------------------------------------------------------------- env */

/**
 * `VITE_API_URL` is baked in at build time. Left unset, requests go to `/api`,
 * which the dev server proxies to `wrangler dev` — same-origin, so no CORS and
 * no cookie trouble while developing.
 */
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

/*
 * There is no `appUrl` beside it, and there is no `VITE_APP_URL` for one to be
 * read from. The reference needed to know where it lived so it could paste its
 * own address into a shareable summary; the only address this app ever hands
 * out is a device claim link, which the Worker builds from its own `APP_URL`
 * var because the admin minting one is standing at a different screen from the
 * tablet that will redeem it.
 */

export const webPlatform: Platform = {
  storage,
  clipboard,
  navigation,
  viewTransition,
  visibility,
  registerServiceWorker,
  install,
  onAppUpdated,
  sound,
  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  openEventStream,
  deviceLanguage,
  setDocumentLanguage,
  dismissSplash,
  randomId,
  apiBaseUrl,
};
