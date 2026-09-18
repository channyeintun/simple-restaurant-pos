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
 * Lives in /shared rather than /web because the browser is not the only thing
 * here that renders words: the printer agent is a Node process on the
 * restaurant's LAN, importing this same package for what a kitchen ticket says.
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
