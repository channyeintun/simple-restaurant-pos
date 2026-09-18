/**
 * Time helpers pinned to Asia/Ho_Chi_Minh (ICT).
 *
 * Vietnam has been on a fixed UTC+7 with no daylight saving since 1975, so the
 * offset arithmetic below is exact and needs no tz database. Formatting still
 * goes through `Intl` with an explicit `timeZone` so the rendered strings stay
 * correct even if that ever changes.
 *
 * Everything crossing the API boundary is an ISO-8601 UTC instant. The "wall
 * clock" helpers exist only to answer questions like "which Friday is next?",
 * which are inherently local questions.
 */

import type { Locale } from './i18n/index.js';

export const TZ = 'Asia/Ho_Chi_Minh' as const;

/** Fixed ICT offset. Vietnam has observed no DST since 1975. */
export const TZ_OFFSET_MINUTES = 7 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Default kickoff: Friday 19:30 ICT. */
export const DEFAULT_KICKOFF = { weekday: 5, hour: 19, minute: 30 } as const;

/**
 * How long after kickoff a session counts as finished.
 *
 * Long enough that a late start cannot close registration early, short enough
 * that the organizer can settle up the same evening. The cron uses it to mark
 * sessions completed, the team board uses it to stop being a live control and
 * start being a record, and registration closes on it too — one definition, so
 * the three cannot disagree about when the game ended.
 */
export const SESSION_RUNS_FOR_MS = 2 * 60 * 60 * 1000;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/** Break a UTC instant into its Asia/Ho_Chi_Minh wall-clock parts. */
export function toZonedParts(instant: Date | string | number): ZonedParts {
  const date = asDate(instant);
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Interpret the given wall-clock parts as ICT and return the UTC instant. */
export function fromZonedParts(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    0,
    0,
  );
  return new Date(asUtc - TZ_OFFSET_MINUTES * MS_PER_MINUTE);
}

/**
 * The next kickoff strictly after `from`.
 *
 * If today is the target weekday but kickoff has already passed, this rolls to
 * next week — which is what the cron wants when it runs the morning after a
 * session.
 */
export function nextWeekday(
  from: Date | string | number = new Date(),
  weekday: number = DEFAULT_KICKOFF.weekday,
  hour: number = DEFAULT_KICKOFF.hour,
  minute: number = DEFAULT_KICKOFF.minute,
): Date {
  const now = asDate(from);
  const local = toZonedParts(now);

  let deltaDays = (weekday - local.weekday + 7) % 7;
  let candidate = fromZonedParts({
    year: local.year,
    month: local.month,
    day: local.day + deltaDays,
    hour,
    minute,
  });

  // Same-day but already kicked off → next week.
  if (candidate.getTime() <= now.getTime()) {
    deltaDays += 7;
    candidate = fromZonedParts({
      year: local.year,
      month: local.month,
      day: local.day + deltaDays,
      hour,
      minute,
    });
  }
  return candidate;
}

/** Convenience wrapper: the upcoming Friday 19:30 ICT. */
export function nextFridayKickoff(from: Date | string | number = new Date()): Date {
  return nextWeekday(from, DEFAULT_KICKOFF.weekday, DEFAULT_KICKOFF.hour, DEFAULT_KICKOFF.minute);
}

/** `YYYY-MM-DD` of the instant, in ICT. Used to dedupe "one session per day". */
export function zonedDateKey(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Midnight ICT that opened the day containing `instant`, as a UTC instant.
 *
 * This is where home draws the line between the fixture it shows at the top and
 * the "previously" list underneath — not at kickoff, and not at the moment the
 * cron marks a game completed. Everything the group does about a game happens
 * after it starts: the score goes in, the bill is split, the MVP is voted for,
 * people pay. Filing tonight's game under history while everyone is still
 * standing on the pitch means all of them go hunting for it. It stops being
 * today's game when today ends, which is exactly what this returns.
 */
export function startOfZonedDay(instant: Date | string | number = new Date()): Date {
  const p = toZonedParts(instant);
  return fromZonedParts({ year: p.year, month: p.month, day: p.day });
}

/**
 * Weekday and month names per locale.
 *
 * Hardcoded rather than left to `Intl`: the Worker and the browser must produce
 * identical strings (a push notification and the screen it links to should not
 * disagree), and ICU data for `my` is not guaranteed to be present in every
 * runtime. Nineteen strings is a cheap price for that certainty.
 */
const WEEKDAY_NAMES: Record<Locale, readonly string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  my: ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'],
};

const MONTH_NAMES: Record<Locale, readonly string[]> = {
  en: [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ],
  my: [
    'ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်',
    'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ',
  ],
};

/**
 * The clock, in whichever style the reader has asked for.
 *
 * AM/PM stays in Latin in both locales, for the same reason the numerals do:
 * Myanmar apps overwhelmingly write clock times that way, and picking one of
 * the several Burmese words for a part of the day (နံနက် / နေ့လယ် / ညနေ / ည)
 * means picking wrong for half the kickoffs — 19:30 is arguably ည, not ညနေ.
 *
 * No leading zero on a 12-hour clock: "07:30 PM" is a digital-watch reading,
 * not something anybody says.
 */
export function clockTime(hour: number, minute: number, hour12 = false): string {
  if (!hour12) return `${pad(hour)}:${pad(minute)}`;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${pad(minute)} ${suffix}`;
}

/** e.g. "Fri 08 Aug, 19:30" / "သောကြာ 08 ဩဂုတ်၊ 7:30 PM". */
export function formatKickoff(
  instant: Date | string | number,
  locale: Locale = 'en',
  hour12 = false,
): string {
  const p = toZonedParts(instant);
  const day = `${WEEKDAY_NAMES[locale][p.weekday]} ${pad(p.day)} ${MONTH_NAMES[locale][p.month - 1]}`;
  const time = clockTime(p.hour, p.minute, hour12);
  // Burmese uses its own comma (U+104A); an ASCII one reads as a typo.
  return locale === 'my' ? `${day}၊ ${time}` : `${day}, ${time}`;
}

/** e.g. "19:30" or "7:30 PM" in ICT. */
export function formatTime(instant: Date | string | number, hour12 = false): string {
  const p = toZonedParts(instant);
  return clockTime(p.hour, p.minute, hour12);
}

/** e.g. "08 Aug 2026" in ICT. */
export function formatDate(instant: Date | string | number, locale: Locale = 'en'): string {
  const p = toZonedParts(instant);
  return `${pad(p.day)} ${MONTH_NAMES[locale][p.month - 1]} ${p.year}`;
}

/**
 * Value for a `<input type="datetime-local">`, expressed in ICT wall-clock so
 * the organizer edits the time they actually see on the poster.
 */
export function toDatetimeLocal(instant: Date | string | number): string {
  const p = toZonedParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Inverse of {@link toDatetimeLocal}: reads a local-time string as ICT. */
export function fromDatetimeLocal(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) throw new Error(`Not a datetime-local value: ${value}`);
  return fromZonedParts({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  });
}

/**
 * Whole days between now and an expiry, floored, never below zero.
 *
 * Floored rather than rounded because this counts a permission down, and the
 * honest half-day is the one you have rather than the one you might: a link
 * with nine and a half days left says nine. The floor is also what makes the
 * last day say zero, which the caller renders as "less than a day left" rather
 * than as a count — "1 day left" on something that dies in twenty minutes is
 * the screen misleading whoever is deciding whether to bother reposting it.
 *
 * It is a duration and not a calendar difference, which is why the wording it
 * feeds avoids saying "today": twenty hours left can still land tomorrow.
 */
export function wholeDaysUntil(instant: Date | string | number, now: Date = new Date()): number {
  const diffMs = asDate(instant).getTime() - now.getTime();
  return Math.max(0, Math.floor(diffMs / MS_PER_DAY));
}

/** Short human delta, e.g. "in 2d 3h" / "3d 2h အကြာ". */
export function relativeToNow(
  instant: Date | string | number,
  now: Date = new Date(),
  locale: Locale = 'en',
): string {
  const diffMs = asDate(instant).getTime() - now.getTime();
  const future = diffMs >= 0;
  const abs = Math.abs(diffMs);

  const days = Math.floor(abs / MS_PER_DAY);
  const hours = Math.floor((abs % MS_PER_DAY) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);

  const unit = UNITS[locale];
  let value: string;
  if (days > 0) value = `${days}${unit.d}${hours > 0 ? ` ${hours}${unit.h}` : ''}`;
  else if (hours > 0) value = `${hours}${unit.h}${minutes > 0 ? ` ${minutes}${unit.m}` : ''}`;
  else value = `${Math.max(minutes, 1)}${unit.m}`;

  // Burmese puts the relation after the amount in both directions, so the
  // English "in X" prefix has no equivalent to mirror.
  if (locale === 'my') return future ? `${value} အကြာ` : `${value} က`;
  return future ? `in ${value}` : `${value} ago`;
}

const UNITS: Record<Locale, { d: string; h: string; m: string }> = {
  en: { d: 'd', h: 'h', m: 'm' },
  my: { d: ' ရက်', h: ' နာရီ', m: ' မိနစ်' },
};

function asDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
