import type {
  CompressOptions,
  CompressedImage,
  EventStream,
  EventStreamHandlers,
  HapticName,
  Platform,
  PushSubscriptionJson,
  SoundName,
} from './index.js';
import { flushSync } from 'react-dom';
/*
 * Hashed into `/assets/` by the build, which is the prefix the service worker
 * caches first — so the second launch makes its noise without a request. A
 * file in `web/public/` would be served from the site root instead, match
 * neither cached prefix, and be fetched again on every cold start.
 *
 * Mono, trimmed to the part that is not silence, and levelled to within half a
 * decibel of each other so the two do not sound like different apps. Twenty
 * kilobytes the pair, down from three hundred and fifty of stereo PCM.
 */
import pressClip from '../assets/press.mp3';
import tapOutClip from '../assets/tap-out.mp3';
import modalOpenClip from '../assets/modal-open.mp3';

/**
 * Browser implementation of the platform seam. This is the only file in the
 * frontend allowed to reference `window`, `document`, `localStorage`,
 * `navigator` or `EventSource`.
 */

const STORAGE_PREFIX = 'futsal:';

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
 * `flushSync` is the load-bearing part: `startViewTransition` snapshots the
 * DOM, calls this back, then snapshots again — so React has to have rendered
 * by the time the callback returns. React's own scheduling would otherwise
 * paint after the transition had already given up, and the animation would
 * cross-fade a screen into itself.
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

  const transition = start.call(document, () => {
    flushSync(change);
  });

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
 * before they opened the invite link. Going back from the first screen would
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
 * cross-fade would dissolve an 88px green ball into the 48px one the sign-in
 * screen draws a third of the way up, two of the same logo on screen at once
 * for the length of the animation. That screen is the most common thing behind
 * this.
 *
 * No `requestAnimationFrame` to bridge the swap either. Callers reach this from
 * a passive effect, which React runs after it has committed the DOM, so `#root`
 * already holds the screen and the next frame paints it. There is no gap.
 */
function dismissSplash(): void {
  document.getElementById('splash')?.remove();
}

/* ------------------------------------------------------------------ sound */

/*
 * Two clips, decoded once and fired from one context.
 *
 * `<audio>` was the obvious thing and is the wrong thing: an element can only
 * be playing one copy of itself, so a second tap arriving before the first has
 * finished seeks the first back to the start — and the guest picker, the goal
 * stepper and the team-count row are all places where two taps land eighty
 * milliseconds apart. A buffer source is one-shot and disposable, so overlaps
 * cost nothing and need no pool of clones.
 */

const SOUND_KEY = 'sound';

const CLIP_NAMES = ['press', 'tapOut', 'modalOpen'] as const;

const CLIP_URLS: Record<SoundName, string> = {
  press: pressClip,
  tapOut: tapOutClip,
  modalOpen: modalOpenClip,
};

/** Encoded bytes, fetched ahead of the first press so that press is not silent. */
const clipBytes = new Map<SoundName, Promise<ArrayBuffer | null>>();
const clipBuffers = new Map<SoundName, AudioBuffer>();

let audio: AudioContext | null = null;
/** Every clip goes through this, so the two stay level with each other. */
let level: GainNode | null = null;
/** Latched once a browser has proved it cannot do this, so it is asked once. */
let audioRefused = false;

/**
 * How loud a button is, against the clips as they are stored.
 *
 * They are mastered close to full scale, which is right for a file and far too
 * much for a noise that fires on every press. This is about twenty-eight
 * decibels down — a tick you notice rather than a sound you hear, and something
 * like a seventh of the loudness the first attempt at this shipped at.
 *
 * A press confirms a tap that the screen has already answered: the disc has
 * shrunk under the finger before the clip starts. It does not have to carry the
 * news on its own, so it can afford to sit under whatever else the phone is
 * doing rather than on top of it.
 *
 * Applied in the graph rather than baked into the files, so that the two clips
 * keep the half-decibel match they were encoded with, and so moving it is one
 * number rather than a re-encode.
 */
const CLIP_GAIN = 0.04;

function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/*
 * Safari has a third state, and it is the one that matters on a phone.
 *
 * The spec says a context is `suspended`, `running` or `closed`. WebKit adds
 * `interrupted`, which is what a context becomes when the app goes to the
 * background, another app takes the audio session, or a call arrives. It is not
 * `suspended`, so a check for that string walks straight past it — which is why
 * leaving this app and coming back a few minutes later left every button
 * silent, permanently, until it was force-quit.
 *
 * Nothing throws and nothing logs when this happens: `start()` on a context
 * that is not running is accepted and simply never heard, because the clock
 * those sources are scheduled against is not moving.
 */
function isRunning(context: AudioContext): boolean {
  return (context.state as AudioContextState | 'interrupted') === 'running';
}

function soundSupported(): boolean {
  return !audioRefused && audioCtor() !== undefined;
}

function soundEnabled(): boolean {
  // On unless somebody turned it off. A fresh install should sound like the
  // app was meant to; the switch on the setup screen is the way out.
  return storage.get(SOUND_KEY) !== '0';
}

/** ~20 KB the service worker then keeps, alongside the rest of `/assets/`. */
function fetchClips(): void {
  if (clipBytes.size > 0) return;
  for (const name of CLIP_NAMES) {
    clipBytes.set(
      name,
      fetch(CLIP_URLS[name])
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        // A clip that will not load costs a quiet button and nothing else.
        .catch(() => null),
    );
  }
}

/**
 * The audio context, built on the first interaction and then kept.
 *
 * Deliberately not built at boot: every browser starts one suspended until a
 * gesture has happened, and Safari will only resume one from inside a real
 * gesture, in the same task as that gesture rather than after an `await`.
 *
 * Deliberately not built on the first *press*, either — that press would be
 * the silent one, while `resume` and a decode finished behind it. It rides
 * `visibility.onInteraction` instead, which fires on a scroll or a stray tap
 * long before anybody has aimed at a button.
 */
function wakeAudio(): AudioContext | null {
  if (audio) {
    // Backgrounded, interrupted by a call, or suspended by the tab going away
    // — all of them stop the clock, and none of them un-stop it by themselves.
    if (!isRunning(audio)) void resumeAudio(audio);
    return audio;
  }
  if (audioRefused) return null;
  const built = buildAudio();
  if (!built) return null;
  // Warm both clips now rather than at the first press, for the same reason
  // the context is built here.
  for (const name of CLIP_NAMES) void clipBuffer(name);
  return built;
}

function buildAudio(): AudioContext | null {
  const Ctor = audioCtor();
  if (!Ctor) {
    audioRefused = true;
    return null;
  }
  try {
    audio = new Ctor();
  } catch {
    // Some webviews expose the constructor and then refuse to build one.
    audioRefused = true;
    return null;
  }
  level = audio.createGain();
  level.gain.value = CLIP_GAIN;
  level.connect(audio.destination);
  return audio;
}

/**
 * Get the clock moving again, and build a new one if it will not move.
 *
 * `resume()` is usually enough — but a context that has been interrupted for
 * long enough can come back resolved-and-still-not-running, and no amount of
 * asking will change its mind. A context in that state is scrap: the only way
 * back is a new one. The decoded clips carry over, because an `AudioBuffer`
 * belongs to no context in particular.
 *
 * Returns whether there is now something that can actually be heard.
 */
async function resumeAudio(context: AudioContext): Promise<boolean> {
  try {
    await context.resume();
  } catch {
    /* Refused. The rebuild below is the remaining option. */
  }
  // Something else may have replaced it while that was in flight.
  if (audio !== context) return audio !== null && isRunning(audio);
  if (isRunning(context)) return true;

  audio = null;
  level = null;
  /*
   * Closing the scrap one, carefully.
   *
   * The usual way to get here is a context the browser already closed for us,
   * and closing a closed context is an error — a rejected promise rather than a
   * throw, so a bare `try` around it catches nothing and the rejection surfaces
   * as an unhandled one in the console. Both guards, because a webview may do
   * either.
   */
  if ((context.state as AudioContextState | 'interrupted') !== 'closed') {
    try {
      void context.close().catch(() => {});
    } catch {
      /* Already gone. */
    }
  }
  const fresh = buildAudio();
  if (!fresh) return false;
  try {
    await fresh.resume();
  } catch {
    /* A fresh context that will not start is out of options. */
  }
  return isRunning(fresh);
}

async function clipBuffer(name: SoundName): Promise<AudioBuffer | null> {
  const ready = clipBuffers.get(name);
  if (ready) return ready;
  if (!audio) return null;

  fetchClips();
  const bytes = await clipBytes.get(name);
  if (!bytes) return null;

  try {
    // A copy: `decodeAudioData` detaches the buffer it is handed, and the same
    // bytes have to survive being decoded a second time.
    const decoded = await audio.decodeAudioData(bytes.slice(0));
    clipBuffers.set(name, decoded);
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Two of the same clip inside this window is a double-fire rather than a second
 * press — a listener installed twice by a hot reload, or a component reaching
 * for `play()` on a click the document was always going to hear. Past it, clips
 * overlap rather than cutting each other off, which is the whole reason these
 * are buffer sources and not an `<audio>` element.
 */
const RETRIGGER_FLOOR_MS = 45;
const lastPlayedAt = new Map<SoundName, number>();

function playSound(name: SoundName): void {
  if (!soundEnabled()) return;

  const now = performance.now();
  if (now - (lastPlayedAt.get(name) ?? -Infinity) < RETRIGGER_FLOOR_MS) return;
  lastPlayedAt.set(name, now);

  const context = wakeAudio();
  if (!context) return;

  /*
   * Read `audio` again rather than closing over `context`.
   *
   * Waking a dead context can replace it, and a source built on the old one is
   * connected to a graph nobody is listening to. This always starts the clip on
   * whichever context is current by the time it runs.
   */
  const start = () => {
    const live = audio;
    if (!live || !isRunning(live)) return;
    const ready = clipBuffers.get(name);
    if (ready) {
      startClip(live, ready);
      return;
    }
    // Only reached before the warm-up above has landed, and only by however
    // long a decode takes — a few milliseconds for a third of a second of mono.
    void clipBuffer(name).then((buffer) => {
      if (buffer && audio && isRunning(audio)) startClip(audio, buffer);
    });
  };

  if (isRunning(context)) {
    start();
    return;
  }

  /*
   * Not running, so waking it has to finish before the clip starts.
   *
   * Starting a source on a stopped context is accepted and silently never
   * heard — the schedule it is placed on is not advancing — so firing the clip
   * alongside `resume()` rather than after it loses the press that asked for
   * it. That is a millisecond or two on a press that has already been answered
   * on screen, and it is the difference between the first press back from the
   * background being silent and being the one that fixes everything.
   */
  void resumeAudio(context).then((ok) => {
    if (ok) start();
  });
}

function startClip(context: AudioContext, buffer: AudioBuffer): void {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(level ?? context.destination);
  source.start();
}

/**
 * Everything that counts as a button.
 *
 * Material Web's buttons are custom elements that keep their real `<button>`
 * inside an open shadow root, so a listener at the document never sees that
 * element — the event is retargeted to the host on its way out, which is
 * exactly what makes matching on these host names work, and exactly why
 * `closest('button')` on its own would match none of them.
 *
 * Text fields, selects and the dialog itself are deliberately absent. Tapping
 * into a field is not pressing a button, and the one native `<select>` in the
 * app opens a menu the page does not own. `md-switch` is absent for a related
 * reason: a switch is a state rather than a press, and one of the four sits
 * inside a virtualized list where a mis-tap during a scroll is routine.
 */
const PRESSABLE = [
  'button',
  '[role="button"]',
  'md-filled-button',
  'md-filled-tonal-button',
  'md-outlined-button',
  'md-text-button',
  'md-icon-button',
  'md-assist-chip',
  'md-select-option',
].join(',');

function isDisabled(element: Element): boolean {
  return element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
}

/**
 * What a control declared, walking up from whatever was actually hit.
 *
 * Bounded at the control on purpose. These are properties of a button and not
 * of the region it sits in, so an unbounded walk would let one marked container
 * re-voice every button inside it — a bug nobody would find by ear. The walk
 * still has to *start* at the target, because a tap on a slotted `<Icon>`
 * inside a Material button lands on the `<svg>`.
 */
function declaredOn(target: Element, control: Element, attribute: string): string | null {
  let node: Element | null = target;
  while (node) {
    const value = node.getAttribute(attribute);
    if (value !== null) return value;
    if (node === control) break;
    node = node.parentElement;
  }
  return null;
}

/** Which clip a control asked for. Every button makes a noise unless it opts out. */
function clipFor(target: Element, control: Element): SoundName | null {
  const marked = declaredOn(target, control, 'data-sound');
  if (marked === 'none') return null;
  return marked === 'tap-out' ? 'tapOut' : 'press';
}

/**
 * Which buzz a control asked for, and `null` for the overwhelming majority.
 *
 * The opposite default to the clip: sound is on everywhere unless refused,
 * haptics is off everywhere unless asked for. A phone that vibrates on every
 * tap is a phone somebody switches off, and then the two presses that were
 * worth feeling are switched off with it.
 */
function hapticFor(target: Element, control: Element): HapticName | null {
  const marked = declaredOn(target, control, 'data-haptic');
  return marked === 'in' || marked === 'out' ? marked : null;
}

function installPressFeedback(): () => void {
  fetchClips();

  /*
   * The hardware wakes on the first interaction of any kind — a scroll, a tap
   * on a card — rather than on the first button, so the first button is not the
   * one that misses.
   *
   * It used to unsubscribe itself on the grounds that it only had to happen
   * once. That was the bug: a context is interrupted every time the app goes to
   * the background, so waking it is not a thing that happens once but a thing
   * that happens after every interruption. It stays subscribed, and costs a
   * string comparison on a gesture somebody was making anyway.
   */
  const stopPriming = visibility.onInteraction(() => {
    wakeAudio();
  });

  /*
   * And again on the way back in, before anything is pressed.
   *
   * Not a substitute for the line above: WebKit will only start a context from
   * inside a real gesture, and coming back to an app is not one, so this can be
   * refused. It costs nothing when it is, and when it works — which is most of
   * the time, for a context that was running before it was interrupted — the
   * first press back is answered instead of being the one that pays for the
   * wake-up.
   */
  const stopWatchingVisibility = visibility.subscribe((visible) => {
    if (visible) wakeAudio();
  });

  /*
   * On `click`, in the capture phase.
   *
   * `pointerdown` was the tempting one — the noise is feedback for the finger,
   * and firing it on the way down is a frame tighter. It is wrong here for one
   * specific reason: half the rows in this app *are* buttons, inside
   * virtualized scrollers, so a thumb starting a scroll on the history list or
   * the roster would chime every time somebody scrolled. `click` never fires
   * for a gesture that turned into a scroll.
   *
   * It also gets the keyboard for free: Enter and Space on a focused button
   * produce a click and no pointer event at all, so there is nothing extra to
   * listen for and no way to sound twice for one press.
   *
   * Capture, so the sound starts while React's own handler is still deciding
   * what to do — the button never waits on the network to make its noise.
   */
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest(PRESSABLE);
    if (!control || isDisabled(control)) return;
    const clip = clipFor(target, control);
    if (clip) playSound(clip);
    const haptic = hapticFor(target, control);
    if (haptic) buzz(haptic);
  };

  document.addEventListener('click', onClick, { capture: true });
  return () => {
    stopPriming();
    stopWatchingVisibility();
    document.removeEventListener('click', onClick, { capture: true });
  };
}

const sound: Platform['sound'] = {
  play: playSound,
  supported: soundSupported,
  enabled: soundEnabled,
  setEnabled(on) {
    storage.set(SOUND_KEY, on ? '1' : '0');
    // Turning it back on says what it sounds like. The press that turns it
    // *off* has already made its noise on the way through, which is the right
    // way round: the last thing sound does is confirm it heard you.
    if (on) playSound('press');
  },
};

/* ----------------------------------------------------------------- share */

const share: Platform['share'] = {
  canShareFile(file) {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  },
  async file(file, text) {
    try {
      await navigator.share({ files: [file], ...(text ? { text } : {}) });
      return true;
    } catch {
      /*
       * Cancelling rejects, and so does a webview that advertised the API and
       * then declined. Neither is worth telling anybody about: the person
       * either changed their mind or is looking at a sheet that did not open,
       * and a toast saying "could not share" on a deliberate cancel is the app
       * arguing with them.
       */
      return false;
    }
  },
};

/* --------------------------------------------------------------- haptics */

const HAPTICS_KEY = 'haptics';

/**
 * What each of the two feels like.
 *
 * Short, because the API's unit is a blunt motor running for a number of
 * milliseconds rather than anything shaped: past about forty it stops being a
 * tick and becomes a phone going off in a pocket.
 *
 * Taking a spot is one clean tap. Giving one up is two, split by a gap — the
 * same idea as the second clip, and for the same reason: a single buzz cannot
 * mean two opposite things.
 *
 * Both pulses are 25ms rather than the 12 the first cut of this used. The cheap
 * rotating-mass actuators in the phones this group actually carries need time to
 * spin up, and a pulse that short can produce nothing you would feel — which
 * would have quietly collapsed `out` into a single buzz indistinguishable from
 * `in`, destroying the one distinction the whole thing exists to make. It would
 * have looked correct in the test and been wrong in the hand.
 *
 * Odd-length on purpose. Chromium discards a trailing entry when the pattern
 * ends on a pause, so an even-length pattern is not the pattern you wrote.
 */
const HAPTIC_PATTERNS: Record<HapticName, number[]> = {
  in: [25],
  out: [25, 45, 25],
};

function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function hapticsEnabled(): boolean {
  return storage.get(HAPTICS_KEY) !== '0';
}

function buzz(name: HapticName): void {
  if (!hapticsEnabled() || !hapticsSupported()) return;
  try {
    // Returns false rather than throwing when the browser declines — a
    // backgrounded tab, a device with no motor, an OS-level setting. There is
    // nothing to do about any of those, and nothing worth saying about them.
    navigator.vibrate(HAPTIC_PATTERNS[name]);
  } catch {
    /* Some webviews expose it and then refuse. */
  }
}

/* --------------------------------------------------------------- display */

const PERSPECTIVE_KEY = 'pitch-perspective';

/*
 * On unless this device has said otherwise, like every other preference here.
 *
 * Stored as the negative — '0' means off — so that a member who has never
 * touched the switch, and a member whose storage has been cleared, both get the
 * drawing the screen was designed around rather than a fallback.
 */
const display: Platform['display'] = {
  prefersReducedMotion: () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  pitchPerspective: () => storage.get(PERSPECTIVE_KEY) !== '0',
  setPitchPerspective(on) {
    storage.set(PERSPECTIVE_KEY, on ? '1' : '0');
  },
};

/* --------------------------------------------------------------- haptics */

const haptics: Platform['haptics'] = {
  supported: hapticsSupported,
  enabled: hapticsEnabled,
  setEnabled(on) {
    storage.set(HAPTICS_KEY, on ? '1' : '0');
    // Turning it on shows what it feels like, for the same reason the sound
    // switch makes its noise: a setting about a sensation should demonstrate.
    if (on) buzz('in');
  },
  buzz,
};

/* ------------------------------------------------------------------- tour */

/**
 * The one running tour, so a second call cannot leave the first painted over
 * the page with nothing left holding a handle to it.
 */
let openTour: { destroy(): void } | null = null;

/**
 * Loaded on demand, and never for most sessions.
 *
 * This runs at most twice in a member's life and then never again, so putting
 * it in the main bundle would cost every launch for something almost nobody is
 * about to see. The import failing — offline, on the very first run, which is
 * exactly when a tour would want to show — is a tour that does not happen, not
 * an error: see `Tour.show`.
 */
async function loadDriver() {
  const [{ driver }] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')]);
  return driver;
}

const tour: Platform['tour'] = {
  async show(steps, options) {
    tour.stop();
    /*
     * Decided against the document, not against the props that asked for it.
     *
     * A caller knows it wants to point at "an empty spot"; only the document
     * knows whether there is one right now. Somebody else taking the last spot
     * between the effect running and the tour opening is an ordinary race on a
     * live screen, and dropping the step is the whole handling it needs.
     */
    const live = steps.filter((step) => document.querySelector(step.target) !== null);
    if (live.length === 0) return false;

    let driver: Awaited<ReturnType<typeof loadDriver>>;
    try {
      driver = await loadDriver();
    } catch {
      return false;
    }

    const instance = driver({
      // The app's own motion preference is honoured by driver's stylesheet,
      // but the stage slide between steps is ours to switch off.
      animate: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      overlayColor: '#05070c',
      overlayOpacity: 0.72,
      stagePadding: 6,
      stageRadius: 12,
      popoverClass: 'ff-tour',
      // One press to be rid of it, and no back button: there is nothing to go
      // back to that is not already on the screen behind it.
      showButtons: ['next'],
      nextBtnText: options.dismiss,
      doneBtnText: options.dismiss,
      showProgress: false,
      steps: live.map((step) => ({
        element: step.target,
        popover: { title: step.title, description: step.body },
      })),
      onDestroyed: () => {
        openTour = null;
      },
    });
    openTour = instance;
    instance.drive();

    /*
     * The popover carries the copy, so it carries the language.
     *
     * Everything else in the app gets `:lang(my)` from an ancestor, but driver
     * mounts its popover on `document.body` — outside the tree that says what
     * language this is — and Burmese there would be laid out with Latin's
     * line-height and letter-spacing.
     */
    document.querySelector('.ff-tour')?.setAttribute('lang', options.lang);
    return true;
  },

  stop() {
    const instance = openTour;
    openTour = null;
    instance?.destroy();
  },
};

/* ----------------------------------------------------------- notifications */

/**
 * Standalone means "launched from the Home Screen" rather than in a tab.
 * `display-mode: standalone` covers Android and desktop; `navigator.standalone`
 * is the old iOS-only flag, which is still the reliable signal there.
 */
function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  // iPadOS reports as Mac, so the touch-point check is what catches it.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

const notifications: Platform['notifications'] = {
  supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  requiresInstall() {
    // iOS 16.4+ only delivers Web Push to a Home Screen install — in a plain
    // Safari tab the APIs may not even be defined.
    return isIos() && !isInstalled();
  },

  permission() {
    if (!('Notification' in window)) return 'denied';
    return Notification.permission as 'default' | 'granted' | 'denied';
  },

  async requestPermission() {
    if (!('Notification' in window)) return 'denied';
    return (await Notification.requestPermission()) as 'default' | 'granted' | 'denied';
  },

  async subscribe(applicationServerKey) {
    const registration = await navigator.serviceWorker.ready;

    // Reuse an existing subscription rather than creating a second one for the
    // same device; `applicationServerKey` cannot be changed on an existing sub.
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing.toJSON() as PushSubscriptionJson;

    const subscription = await registration.pushManager.subscribe({
      // Required to be true: silent push is not permitted on the open web.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(applicationServerKey) as BufferSource,
    });
    return subscription.toJSON() as PushSubscriptionJson;
  },

  async current() {
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? (subscription.toJSON() as PushSubscriptionJson) : null;
  },

  async unsubscribe() {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  },

  onSubscriptionChange(listener) {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'push-subscription-change') listener();
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  },
};

/** `applicationServerKey` must be raw bytes, not the base64url string. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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

/* ---------------------------------------------------------- image handling */

/**
 * A hidden `<input type="file">`, driven imperatively.
 *
 * `cancel` is not universally supported, so the promise also settles when the
 * window regains focus without a file having been chosen — otherwise backing
 * out of the picker would leave the caller waiting forever.
 */
function pickImage(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (result: Blob | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(result);
    };

    const onFocus = () => {
      // Fires before `change` in some browsers; give the file a moment to land.
      window.setTimeout(() => finish(input.files?.[0] ?? null), 500);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', onFocus, { once: true });

    input.click();
  });
}

/**
 * Resize and re-encode a screenshot in the browser.
 *
 * A phone screenshot is typically 2-4 MB; R2's free tier is 10 GB and a Worker
 * has no image library, so the shrinking has to happen here. Targets ~150 KB by
 * capping the long edge and then stepping quality down until the blob fits.
 */
async function compressImage(
  file: Blob,
  options: CompressOptions = {},
): Promise<CompressedImage> {
  const maxDimension = options.maxDimension ?? 1280;
  const targetBytes = options.targetBytes ?? 150_000;
  let quality = options.quality ?? 0.82;

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.drawImage(bitmap, 0, 0, width, height);

    // Transfer screenshots are photos of text; JPEG at moderate quality keeps
    // them legible at a fraction of a PNG's size.
    const contentType = 'image/jpeg';
    let blob = await toBlob(canvas, contentType, quality);

    // Three attempts is enough to get an over-sized image under the target
    // without spending seconds on a phone CPU.
    for (let attempt = 0; attempt < 3 && blob.size > targetBytes; attempt++) {
      quality = Math.max(0.4, quality - 0.15);
      blob = await toBlob(canvas, contentType, quality);
    }

    return { blob, contentType, width, height };
  } finally {
    bitmap.close();
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
      type,
      quality,
    );
  });
}

/* -------------------------------------------------------------------- env */

/**
 * `VITE_API_URL` is baked in at build time. Left unset, requests go to `/api`,
 * which the dev server proxies to `wrangler dev` — same-origin, so no CORS and
 * no cookie trouble while developing.
 */
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

const appUrl =
  (import.meta.env.VITE_APP_URL as string | undefined) ??
  (typeof window === 'undefined' ? '' : window.location.origin);

export const webPlatform: Platform = {
  storage,
  clipboard,
  navigation,
  viewTransition,
  visibility,
  sound,
  haptics,
  display,
  share,
  tour,
  installPressFeedback,
  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  notifications,
  registerServiceWorker,
  deviceLanguage,
  setDocumentLanguage,
  dismissSplash,
  openEventStream,
  pickImage,
  compressImage,
  objectUrl: {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  apiBaseUrl,
  appUrl,
};
