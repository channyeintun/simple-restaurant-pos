import { en } from './en.js';
import { my } from './my.js';

/**
 * Localisation.
 *
 * No i18n library. The catalogue is a plain nested object where English is the
 * source of truth and every other locale is declared as `typeof en` — so a
 * missing key, or an interpolation whose arguments have drifted, is a build
 * error rather than a screen showing `pin.enterPin` to a waiter mid-service.
 *
 * Strings that need values are functions, not templates with placeholders.
 * `m.pin.enterPin(staff.name)` is checked by the compiler; `t('pin.enterPin',
 * { name })` is not, and the parameter names rot silently.
 *
 * Lives in /shared rather than /web because it is a contract about wording
 * rather than a frontend detail, and because both halves of it have to be kept
 * in step by the compiler wherever they are read.
 *
 * ## The printer agent does not read it, and cannot
 *
 * That was the original intention and it does not survive contact with how the
 * agent runs. `agent/` has no build step on purpose — the thing running in the
 * restaurant should be the thing somebody can open and read when it misbehaves
 * — so it is started with node's type stripping, and stripping does not rewrite
 * the `.js` specifiers this package's modules import each other with. Node
 * resolves `@pos/shared/i18n` and then looks for `./en.js`, which does not
 * exist. Rewriting every import in this package to `.ts` to suit one consumer
 * would be the tail wagging the dog.
 *
 * So the five words a kitchen ticket carries — ROUND, VOID, TAKEAWAY, TABLE and
 * the waiter's line — live in `agent/src/index.ts`, next to the ESC/POS bytes
 * that draw them, and they are deliberately English. A thermal printer's
 * built-in font has no Myanmar glyphs, so a Burmese header prints as boxes
 * unless the agent rasterises; the README says so under Known limitations. Dish
 * names come from the menu and are whatever the manager typed, which is the
 * same problem and not one a catalogue can solve by choosing differently.
 */

export const LOCALES = ['en', 'my'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Shape every catalogue must satisfy. */
export type Messages = typeof en;

const CATALOGUES: Record<Locale, Messages> = { en, my };

export function messagesFor(locale: Locale | string | null | undefined): Messages {
  return CATALOGUES[normalizeLocale(locale)];
}

/**
 * Map anything a browser or database might hand us onto a supported locale.
 *
 * Accepts `my-MM`, `my`, `en-GB`, and the historical Burmese tags `bur`/`mya`,
 * which some Android builds still report.
 */
export function normalizeLocale(value: Locale | string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const tag = value.toLowerCase();
  if (tag.startsWith('my') || tag.startsWith('bur') || tag.startsWith('mya')) return 'my';
  return 'en';
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Native name, for the language switcher — never translated. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  my: 'မြန်မာ',
};
