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

export interface Platform {
  storage: KeyValueStorage;
  clipboard: Clipboard;
  navigation: Navigation;
  viewTransition: ViewTransition;
  visibility: Visibility;
  /** Registers the service worker. Resolves false where unsupported. */
  registerServiceWorker(): Promise<boolean>;
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
  /** Base URL of the API. */
  apiBaseUrl: string;
}

import { webPlatform } from './web.js';

/** The active platform implementation. */
export const platform: Platform = webPlatform;
