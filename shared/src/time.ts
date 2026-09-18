/**
 * Local time, as a fixed offset from UTC.
 *
 * Everything crossing the API boundary is an ISO-8601 UTC instant. These
 * helpers exist for the handful of questions that are only meaningful in local
 * terms: what the clock on the kitchen ticket says, and which day's takings a
 * payment belongs to.
 *
 * ## Why an offset and not a timezone database
 *
 * Myanmar has been on a fixed UTC+06:30 since 1945, with no daylight saving,
 * so the arithmetic below is exact — and it is the same arithmetic in
 * TypeScript here and in Rust in `api/core/src/clock.rs`, which matters more
 * than it sounds. The alternative is `Intl` with an IANA zone in the browser
 * and a tz crate in the Worker, which is two implementations of one rule,
 * shipped separately, each carrying data the other does not. A kitchen ticket
 * printed at 00:05 and a day's sales total that disagree about which day it is
 * would be a genuinely hard bug to see and an infuriating one to explain.
 *
 * ## Why minutes
 *
 * Because +06:30 is not a whole number of hours. A `TZ_OFFSET_HOURS` var
 * would have to be `6.5`, which is a float describing a clock — the one place
 * this codebase has already decided floats do not belong — and would round to
 * six the first time somebody typed it into an integer column. Minutes are
 * exact for every offset any inhabited zone has ever used, including the
 * quarter-hour ones.
 *
 * The offset is a **parameter** on every function here, never a constant in
 * this module. It comes from the Worker's `TZ_OFFSET_MINUTES` var by way of
 * `GET /auth/me`; `DEFAULT_CONFIG` in `config.ts` holds the only literal copy
 * of it in the frontend, and that copy exists to have something of the right
 * shape before the first response lands. A default argument here would be a
 * second source of truth, and the failure it produces is silent: every time
 * would be half an hour out and still look like a time.
 *
 * Futsal's version of this file answered "which Friday is next?" and when a
 * session was over. None of that survives — a restaurant is open when it is
 * open, and nothing here schedules anything.
 */

const MS_PER_MINUTE = 60_000;

/**
 * A wall-clock reading. No weekday and no seconds: nothing a POS prints or
 * groups by needs either, and a field nobody reads is a field that will be
 * wrong when somebody finally does.
 */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
}

/** Break a UTC instant into its local wall-clock parts. */
export function toZonedParts(instant: Date | string | number, offsetMinutes: number): ZonedParts {
  const date = asDate(instant);
  const shifted = new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * Interpret the given wall-clock parts as local time and return the UTC
 * instant.
 *
 * `day` may be out of range — `Date.UTC` normalises `2026-09-31` to
 * `2026-10-01` — which is what lets a caller add days without owning a
 * calendar. Nothing in the POS does that today; it is kept because
 * `startOfZonedDay` is built on it and because the Rust twin has to reproduce
 * the same normalisation to stay in step.
 */
export function fromZonedParts(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number },
  offsetMinutes: number,
): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    0,
    0,
  );
  return new Date(asUtc - offsetMinutes * MS_PER_MINUTE);
}

/**
 * `YYYY-MM-DD` of the instant, locally. This is the key the day's sales total
 * is grouped by.
 *
 * It has to be the local day and not the UTC one, and at +06:30 the two differ
 * for the last six and a half hours of every UTC day — which in Yangon is the
 * evening service, the busiest part of it. Grouping by the UTC date would file
 * everything after 17:30 UTC under the previous day and hand the manager a
 * daily total that is wrong every single night.
 */
export function zonedDateKey(instant: Date | string | number, offsetMinutes: number): string {
  const p = toZonedParts(instant, offsetMinutes);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Local midnight that opened the day containing `instant`, as a UTC instant.
 *
 * The lower bound of the "today" queries — today's sales, today's checks — so
 * that the range the database is asked for and the key the rows are grouped by
 * are derived from the same definition of a day.
 *
 * A restaurant that serves past midnight will file the late tables under the
 * next day. That is a real thing to decide about and this is not the place to
 * decide it: a business day that starts at 06:00 is a policy, and it would
 * belong in a var next to the offset rather than hidden in a helper called
 * "start of day".
 */
export function startOfZonedDay(instant: Date | string | number, offsetMinutes: number): Date {
  const p = toZonedParts(instant, offsetMinutes);
  return fromZonedParts({ year: p.year, month: p.month, day: p.day }, offsetMinutes);
}

/** `"19:30"` — the time at the top of a kitchen ticket. */
export function formatClock(instant: Date | string | number, offsetMinutes: number): string {
  const p = toZonedParts(instant, offsetMinutes);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * `"2026-09-18 19:30"` — the stamp on a receipt.
 *
 * Numeric and locale-free on purpose. A receipt is a record somebody may have
 * to match against a bank line or a day's takings weeks later, and the two
 * things a date on a record has to be are unambiguous and sortable. Month
 * names would be neither: they would need a table in English and Burmese, kept
 * in step here and in `api/core/`, so that the printer agent and the cashier's
 * screen agree on what to call September — a lot of machinery for a line that
 * reads better as digits anyway.
 *
 * 24-hour, because a bill is not a conversation and `19:30` cannot be read as
 * half past seven in the morning.
 */
export function formatDateTime(instant: Date | string | number, offsetMinutes: number): string {
  const p = toZonedParts(instant, offsetMinutes);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function asDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
