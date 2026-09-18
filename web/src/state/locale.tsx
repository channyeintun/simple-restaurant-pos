import {
  DEFAULT_LOCALE,
  type Locale,
  type Messages,
  isLocale,
  messagesFor,
  normalizeLocale,
} from '@pos/shared';
import {
  type Accessor,
  type JSX,
  createContext,
  createEffect,
  createSignal,
  useContext,
} from 'solid-js';
import { platform } from '../platform/index.js';

/**
 * Which language the app is speaking.
 *
 * Resolved in this order, and it is a shorter order than the app this is
 * descended from used:
 *
 *   1. **An explicit choice on this tablet**, remembered in `platform.storage`.
 *   2. **The device's own language**, when it is one this app has a catalogue
 *      for. A tablet set up in Burmese opens in Burmese.
 *   3. English.
 *
 * There is no fourth step and there is deliberately no server-side preference,
 * which is the whole of the difference. In the reference the language was a
 * column on the person: it followed them between their phone and their laptop,
 * and it had to, because push notification text is composed on a server while
 * the device that chose the language is asleep. Neither half of that applies
 * here. Nothing in this app writes words while nobody is looking at it, and the
 * thing holding a preference is a tablet bolted to a counter that a dozen
 * people share during a shift — so the language belongs to the device, is
 * chosen once when it is set up, and does not follow a waiter from the till to
 * the pass and change the screen underneath the next person.
 *
 * ## Why the state is a module-level signal and the context is still here
 *
 * The signal below sits outside the component tree, which is not what the
 * reference did and is worth being plain about. React has no such thing — state
 * lives in a component or it is not state — so a context was the only way to
 * make a value reactive across a tree. A Solid signal is already reactive
 * wherever it is read from, so the provider is no longer what makes the
 * language work; it is only what gives the document-language effect a lifetime.
 *
 * That is exactly the property this app needs, because two of its screens
 * render outside any provider. `App.tsx` draws the "this tablet has not been
 * set up" gate and the "could not reach the Worker" screen itself, before and
 * outside anything a page mounts, and an untranslated gate is a worse outcome
 * than a slightly unusual module. `useLocale()` therefore answers correctly
 * with or without a provider above it — the context is kept so that the shell
 * can adopt one in a single line, and so that a later milestone can scope a
 * language to part of the tree without every caller changing.
 */

interface LocaleValue {
  locale: Accessor<Locale>;
  /**
   * The catalogue, as an accessor. Call it at the point of use —
   * `m().pin.title` — rather than destructuring the messages out once, or the
   * strings stop following a language change.
   */
  m: Accessor<Messages>;
  setLocale(next: Locale): void;
}

const STORAGE_KEY = 'locale';

/**
 * `normalizeLocale` handles the tags a browser actually reports — `my-MM`,
 * `en-GB`, and the historical `bur`/`mya` that some Android builds still send —
 * so this only has to decide between a stored choice and a guess.
 */
function initialLocale(): Locale {
  const stored = platform.storage.get(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  return normalizeLocale(platform.deviceLanguage());
}

const [locale, storeLocale] = createSignal<Locale>(initialLocale());

function setLocale(next: Locale): void {
  storeLocale(next);
  platform.storage.set(STORAGE_KEY, next);
  /*
   * Reflected here as well as in the provider's effect, because the provider is
   * not mounted yet and this is the moment that matters: `<html lang>` is what
   * makes the browser pick a Myanmar face and line-break a script with no
   * spaces in it, and the `:lang(my)` rule in `styles.css` that opens the line
   * height up hangs off the same attribute. Setting it twice is free.
   */
  platform.setDocumentLanguage(next);
}

/**
 * One value object for every consumer.
 *
 * `m` is a plain derived function rather than a `createMemo`, on purpose: a memo
 * created at module scope has no owner to dispose it, and `messagesFor` is a
 * lookup in a two-entry record. There is nothing here worth caching.
 */
const sharedValue: LocaleValue = {
  locale,
  m: () => messagesFor(locale()),
  setLocale,
};

const LocaleContext = createContext<LocaleValue>();

/**
 * Optional, and not mounted by anything in milestone 0 — see the module note.
 * Wrapping the shell in it is what moves the document-language effect into the
 * app's lifetime, which is where it belongs once there is a shell to hang it
 * off.
 */
export function LocaleProvider(props: { children: JSX.Element }) {
  createEffect(() => platform.setDocumentLanguage(locale()));

  return <LocaleContext.Provider value={sharedValue}>{props.children}</LocaleContext.Provider>;
}

/**
 * The active language and its catalogue.
 *
 * Falls back to the shared value rather than throwing when there is no provider
 * above it. That is not defensive coding for its own sake: it is what lets the
 * shell's own screens use the same strings as the pages, and since both paths
 * read the same signal there is no second copy of the state to disagree.
 */
export function useLocale(): LocaleValue {
  return useContext(LocaleContext) ?? sharedValue;
}

export { DEFAULT_LOCALE };
