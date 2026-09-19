/**
 * The platform seam.
 *
 * Every browser capability the app depends on is declared here and implemented
 * in `web.ts`. Pages and components import from this module and never touch
 * `window`, `document`, `localStorage`, `navigator` or `EventSource` directly.
 *
 * The payoff is not hypothetical portability — it is that all the parts with
 * awkward platform behaviour (clipboard in webviews, view transitions where
 * the reader has asked for less motion, idle detection for the realtime
 * budget) live in one file that can be reasoned about and stubbed, instead of
 * being sprinkled through components.
 *
 * ## What the reference had and this does not
 *
 * This seam is the futsal app's, trimmed. Four capabilities are gone, and they
 * are gone because the features behind them are out of scope rather than
 * because they were hard:
 *
 *   * **Push notifications** (`notifications`, `PushSubscriptionJson`). Nothing
 *     in a POS happens while nobody is looking at it. The tablets are on the
 *     counter during service, and the one thing that does need attention — a
 *     kitchen ticket that failed to print — is a red banner on a screen a
 *     cashier is already standing at.
 *   * **Image handling** (`pickImage`, `compressImage`, `objectUrl`, `share`).
 *     There are no uploads: no payment screenshots, no product photos, no R2
 *     bucket for any of it to live in.
 *   * **Sound, haptics and the press-feedback listener**
 *     (`sound`, `haptics`, `installPressFeedback`). A dining room is not a
 *     place to add noise to, and a phone in a pocket is not what these run on.
 *   * **The tour and the pitch display preference** (`tour`, `display`). One
 *     was for teaching a member of a kickabout where to press once a season;
 *     the other drew a football pitch in perspective. Staff are trained on
 *     this in person, on their first shift, by somebody standing next to them.
 *
 * `appUrl` is gone too, for a reason worth stating because it is the one that
 * looks like an omission: the only URL this app used to build was a claim
 * link, and a claim link is now minted by the Worker from its own `APP_URL`
 * var. The admin generating one is standing at a different screen from the
 * tablet that will open it, so the app has no business guessing where that
 * tablet thinks it lives.
 */

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface Clipboard {
  /** Resolves false when the platform refused rather than throwing. */
  write(text: string): Promise<boolean>;
  /**
   * Resolves null when reading is unavailable or refused — which is common:
   * Safari only allows it from a user gesture, Firefox not at all, and chat
   * webviews frequently block it. Callers must keep a text field as the way
   * that always works.
   */
  read(): Promise<string | null>;
}

/**
 * Cross-fade one screen into the next.
 *
 * A seam because `document.startViewTransition` is browser-only and not
 * universal: the implementation no-ops where it is missing, and — more
 * importantly — where the reader has asked for reduced motion. Callers just
 * hand over the state change and get animation where it is welcome.
 */
export type ViewTransition = (change: () => void) => void;

export interface Navigation {
  /** Current in-app path, e.g. `/cashier/chk_123`. */
  path(): string;
  /** Jump to the top of the page, without a smooth-scroll animation. */
  scrollToTop(): void;
  /**
   * The URL fragment, without the leading `#`.
   *
   * Device claim links carry their nonce here rather than in the query string:
   * browsers never send a fragment to the server, so it stays out of access
   * logs, proxy logs and `Referer` headers.
   */
  hash(): string;
  push(path: string): void;
  replace(path: string): void;
  /**
   * Load the page again from scratch.
   *
   * Not navigation — nowhere changes — but it belongs to the same capability
   * for the same reason everything else here does: it is `window.location`, and
   * components do not touch `window`. Its one caller is the "a new version is
   * ready" banner, which is the only thing in this app that ever wants the
   * bundle replaced rather than the route changed.
   */
  reload(): void;
  /** True when this app has somewhere of its own to go back to. */
  canGoBack(): boolean;
  /** Step back one entry. Returns false when there was nothing to step to. */
  back(): boolean;
  /** Subscribe to path changes. Returns an unsubscribe function. */
  subscribe(listener: (path: string) => void): () => void;
}

/**
 * A server-sent-events connection.
 *
 * Modelled on just the parts of `EventSource` this app uses, so it could be
 * backed by a WebSocket instead without the caller noticing.
 */
export interface EventStream {
  close(): void;
}

export interface EventStreamHandlers {
  onMessage(data: string): void;
  onError(): void;
  onOpen(): void;
}

/** Signals that let the client hang up an idle stream — the Upstash budget. */
export interface Visibility {
  /** False when the app is backgrounded. */
  isVisible(): boolean;
  subscribe(listener: (visible: boolean) => void): () => void;
  /** Fires on any user interaction; used to reset the idle timer. */
  onInteraction(listener: () => void): () => void;
}

/**
 * Adding the app to a tablet's home screen, and noticing when a deploy has
 * landed under one.
 *
 * Both are here for the usual reason — `beforeinstallprompt` and
 * `navigator.serviceWorker` are browser APIs and components do not touch those
 * — and both are genuinely awkward in ways that are better solved once.
 *
 * The install prompt is an event the browser fires **at most once**, whenever
 * it decides the app is installable, and the only way to show it later is to
 * have kept the event object. A component that happened not to be mounted at
 * that moment misses it forever. So it is captured at module scope, before any
 * component exists, and offered to whoever asks afterwards.
 */
export interface Install {
  /**
   * Whether the browser is currently offering to install. Subscribing also
   * reports the answer immediately, so a screen that mounts after the event
   * still learns about it.
   *
   * False on iOS, on Firefox, in an already-installed app, and on any browser
   * that has decided not to offer — which is most of the time. The control is
   * hidden in all of those cases rather than shown and disabled: an install
   * button that cannot install is a support call.
   */
  subscribe(listener: (available: boolean) => void): () => void;
  /** Show the browser's own prompt. Resolves true when it was accepted. */
  prompt(): Promise<boolean>;
}

/**
 * A new build has taken over from under a running page.
 *
 * Matters here more than on an ordinary site: these tablets are installed apps
 * that are never closed, so without something saying so a device can go on
 * running a bundle from a fortnight ago against a Worker deployed this morning
 * — which is exactly the skew `api/auth.ts` parses its responses to survive.
 *
 * The listener fires only when a worker replaces one that was **already
 * controlling** the page. A first-ever registration also changes the
 * controller, and telling somebody their brand-new install is out of date on
 * its first launch would be nonsense.
 */
export type AppUpdated = (listener: () => void) => () => void;

/**
 * The one noise this app makes.
 *
 * The seam this is descended from dropped sound outright, with the reasoning
 * that a dining room is not a place to add noise to — and that is still right
 * about the *waiter's* tablets, which are carried between tables and stay
 * silent. This is for the till: one screen, at a counter, where somebody needs
 * to know an order has gone to the kitchen without watching the board.
 *
 * Three things make it awkward enough to be worth solving once, here.
 *
 * **Browsers refuse to play audio until the page has been interacted with.**
 * Not a bug and not avoidable: an autoplay policy that could be talked out of
 * would not be a policy. So {@link Sound.prime} exists to be called from inside
 * a real gesture — `visibility.onInteraction` fires on `pointerdown` and
 * `keydown`, which both qualify — and it plays each clip muted and immediately
 * pauses it, which is what marks the element as user-activated for the rest of
 * the page's life.
 *
 * **It has to be switchable off, and remember.** A till in a small room at
 * eight in the evening is a different place from the same till at lunchtime,
 * and a sound somebody cannot turn off is a sound somebody unplugs the speaker
 * over. The preference is per device, like the language.
 *
 * **It has to fail silently.** The file is supplied by whoever runs the
 * restaurant and may simply not be there; a missing clip must cost a rejected
 * promise nobody sees, never an error on a screen that is taking money.
 */
export type SoundName = 'newOrder';

export interface Sound {
  /**
   * Unlock playback, from inside a user gesture. Calling it anywhere else is
   * harmless and does nothing; calling it twice is harmless too.
   */
  prime(): void;
  /** Play it, if sound is on and the clip exists. Never throws. */
  play(name: SoundName): void;
  /** Whether this device wants to hear anything. Defaults to on. */
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

export interface Platform {
  storage: KeyValueStorage;
  clipboard: Clipboard;
  navigation: Navigation;
  viewTransition: ViewTransition;
  visibility: Visibility;
  /**
   * Hand the page to the operating system's print dialog.
   *
   * Here for the same reason everything else is — it is `window.print` and
   * components do not touch `window` — and it is worth knowing what it can and
   * cannot tell you: **nothing**. It blocks until the dialog closes and then
   * returns, identically whether the person printed, saved a PDF or hit
   * Cancel. `afterprint` fires on cancel too in several browsers, so there is
   * no success signal to wait for and callers must not pretend otherwise.
   */
  print(): void;
  /** Registers the service worker. Resolves false where unsupported. */
  registerServiceWorker(): Promise<boolean>;
  install: Install;
  onAppUpdated: AppUpdated;
  sound: Sound;
  openExternal(url: string): void;
  openEventStream(url: string, handlers: EventStreamHandlers): EventStream;
  /**
   * The device's preferred language tag, e.g. `my-MM`. Used only as the initial
   * guess before somebody has chosen one.
   */
  deviceLanguage(): string | null;
  /** Reflects the active language onto the document, for font and hyphenation. */
  setDocumentLanguage(tag: string): void;
  /**
   * Take down the boot splash that `index.html` painted.
   *
   * A capability rather than a `getElementById` in a component, on the usual
   * rule — and the only DOM the app owns that Solid does not, since the whole
   * point of that element is to be on screen before the bundle has run.
   * Calling it twice is harmless.
   */
  dismissSplash(): void;
  /**
   * A random, unguessable id for one attempt at something.
   *
   * `crypto.randomUUID` is a browser API and therefore belongs here rather than
   * in a component, like everything else in this seam. Its one caller is the
   * waiter's cart: the key that identifies a single tap of Send to kitchen, so
   * that a retry after a lost reply is recognised as the same tap instead of
   * printing the food twice.
   *
   * It has a fallback, which is unusual for this file and is the point. The
   * Web Crypto API is only available in a secure context, and a restaurant that
   * runs this over plain HTTP on the LAN — which is exactly the kind of place
   * this app runs — would otherwise get a `TypeError` at the moment the waiter
   * presses the button. Uniqueness is what the key needs; unguessability is a
   * bonus it is nice to have and not what protects anything here.
   */
  randomId(): string;
  /** Base URL of the API. */
  apiBaseUrl: string;
}

import { webPlatform } from './web.js';

/** The active platform implementation. */
export const platform: Platform = webPlatform;
