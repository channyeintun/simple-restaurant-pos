import { z } from 'zod';

/**
 * The two things the whole app has to agree on before it can draw anything: how
 * money is written, and what the clock on the wall says.
 *
 * Both live in `wrangler.jsonc` `vars` — `CURRENCY_CODE`, `CURRENCY_SYMBOL`,
 * `CURRENCY_MINOR_DIGITS`, `TZ_OFFSET_MINUTES` — and the Worker is the single
 * source of truth for all four. The client learns them from `GET /auth/me`
 * rather than from a mirrored `VITE_*` build-time value, and that is a decision
 * worth spelling out because the mirror is the obvious thing to reach for:
 *
 *   * Two copies drift. The day somebody changes the currency they change it in
 *     the Worker, because that is where the money is added up; the frontend
 *     keeps rendering the old symbol until somebody notices and redeploys.
 *   * A build-time var is baked into a PWA that is already installed on a
 *     tablet. The Worker's copy changes on deploy; the tablet's changes when
 *     the service worker next decides to.
 *   * Nothing renders money or a time before the caller is authenticated — the
 *     claim screen and the PIN screen have neither — so reading it from the
 *     session bootstrap costs no first paint.
 *
 * Which is also why `formatMoney` here and `format_money` in `api/core/` take
 * the currency as a parameter instead of closing over a constant: the twin
 * tests on both sides then exercise the same function the app calls, with the
 * currency written out in front of the reader rather than compiled in.
 */

/**
 * How amounts are written. `minorDigits` is the interesting one: it is how many
 * digits of the stored integer are *below* the unit people say out loud. MMK
 * has no circulating subunit, so it is 0 and a minor unit is a kyat; USD would
 * be 2 and a minor unit a cent.
 */
export interface Currency {
  code: string;
  symbol: string;
  minorDigits: number;
}

/** Everything `GET /auth/me` hands back under `config`. */
export interface AppConfig {
  currency: Currency;
  tzOffsetMinutes: number;
}

export const currencySchema = z.object({
  /** ISO 4217, e.g. `MMK`. Not rendered; it is what identifies the currency. */
  code: z.string().length(3),
  /** What is printed beside an amount, e.g. `Ks`. */
  symbol: z.string().min(1).max(8),
  /**
   * Capped at 4 because no live currency has more, and because the cap is what
   * stops a mistyped var turning every price on the screen into a rounding
   * error nobody can explain.
   */
  minorDigits: z.number().int().min(0).max(4),
});

export const appConfigSchema = z.object({
  currency: currencySchema,
  /**
   * Minutes, not hours, and signed. Myanmar is UTC+06:30 — the half hour is
   * exactly why this is not a count of hours — and the range is the widest any
   * inhabited zone uses (UTC-12:00 to UTC+14:00).
   */
  tzOffsetMinutes: z.number().int().min(-720).max(840),
});

/**
 * What to render with until `GET /auth/me` answers.
 *
 * This is *not* a fallback for a misconfigured Worker and must never be used as
 * one — a till that quietly decides the currency for itself is worse than a
 * till that shows nothing. It exists so the client has a shape of the right
 * type to hold before the first response lands, and so the values it holds for
 * those few hundred milliseconds are the ones this restaurant actually uses
 * rather than a placeholder that would flash on screen.
 */
export const DEFAULT_CONFIG: AppConfig = {
  currency: { code: 'MMK', symbol: 'Ks', minorDigits: 0 },
  tzOffsetMinutes: 390,
};

/**
 * Compile-time proof that the schemas and the interfaces above say the same
 * thing.
 *
 * Each is written twice — the interface for readers and for the places that
 * only want the type, the schema for the parse at the API boundary — and this
 * is what stops the two drifting apart silently. `Assert` takes `true` and
 * nothing else, so a schema that stops satisfying its interface fails the build
 * here rather than at the first response that does not fit.
 */
type Assert<T extends true> = T;

export type ConfigIsConsistent = Assert<
  z.infer<typeof currencySchema> extends Currency ? true : false
> &
  Assert<z.infer<typeof appConfigSchema> extends AppConfig ? true : false>;
