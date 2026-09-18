import {
  type AppConfig,
  type Identity,
  type Me,
  type StaffRole,
  DEFAULT_CONFIG,
  formatAmount,
  formatClock,
  formatDateTime,
  formatMoney,
  parseMoney,
} from '@pos/shared';
import { useQueryClient } from '@tanstack/solid-query';
import type { Accessor } from 'solid-js';
import { signOutStaff } from '../api/staff.js';
import { queryKeys, useMe } from '../lib/queries.js';

/**
 * The session, as a screen wants to use it: who is standing at this tablet, and
 * the two facts about this restaurant that decide how anything is written down.
 *
 * ## Why this does not create a context of its own
 *
 * There is nothing for one to hold. The session lives in the query cache under
 * `queryKeys.me` and nowhere else — `App.tsx` reads it through `useMe()` to
 * decide whether a page may render at all, and so does this. A context here
 * would be a second copy of the truth kept in step by hand, and the whole
 * reason `api/auth.ts` parses its responses instead of casting them is that
 * this codebase does not trust two places to agree about a shape.
 *
 * So this module is not the store. It is the *interface* to it, and it earns
 * its file by being three things the raw context is not:
 *
 *   1. **The only place money is formatted.** `formatMoney` takes the currency
 *      as a parameter — deliberately, see `shared/src/config.ts` — which means
 *      every call site would otherwise have to reach for the config and pass
 *      it, and the first one that hard-codes `{ code: 'MMK', symbol: 'Ks' }`
 *      because it is right today is a bug that survives a currency change.
 *      `app.money(item.priceMinorSnapshot)` cannot be got wrong. Same argument
 *      for the clock: the offset is a var on the Worker and a screen has no
 *      business knowing a number for it.
 *   2. **The one way an identity is adopted.** All three routes that change who
 *      is on a tablet — claim, switch, sign out — answer with a fresh identity,
 *      and every one of them has to land in the cache the shell reads. See
 *      `adopt`.
 *   3. **A narrower shape than the raw identity.** `staff()` is the signed-in
 *      person as one object or null, rather than three fields that are all null
 *      together and have to be checked one at a time.
 *
 * If the shell ever grows session state that is not the server's answer — a
 * language the person picked, a pane they collapsed — this is where it goes,
 * and it would want a context then. Until then the store is the cache, and the
 * cache is where the fetch already put it.
 */

/** The signed-in person, when there is one. */
export interface SignedInStaff {
  id: string;
  name: string;
  role: StaffRole;
}

export interface AppValue {
  /** Null on a tablet that has not been claimed; never null inside the routes. */
  identity: Accessor<Identity | null>;
  /** Null when the device is claimed but nobody has entered a PIN. */
  staff: Accessor<SignedInStaff | null>;
  config: Accessor<AppConfig>;
  /** Integer minor units in, `12.500 Ks` out. The only way to write money. */
  money(minor: number): string;
  /**
   * The same number with no symbol on it — `12.500` — for the one field in the
   * app somebody types a price into.
   *
   * It is a pair with {@link AppValue.parseAmount}, and the pair is the point:
   * what this renders into the field is exactly what that reads back out, so a
   * manager who opens a product and presses Save without touching anything
   * cannot have repriced it.
   */
  amount(minor: number): string;
  /**
   * What somebody typed, as integer minor units, or null when it is not an
   * amount at all.
   *
   * Tolerant of `12500`, `12,500`, `12 500`, `12.500` and `12.5k`, because that
   * is what people actually type — `shared/src/money.ts` sets out the two rules
   * that settle the ambiguous cases. Null is shown as a validation error beside
   * the field and never as a zero: a price that silently became nothing is a
   * product given away for the rest of the month.
   */
  parseAmount(text: string): number | null;
  /** `2026-09-18 19:30`, in the restaurant's own offset. */
  dateTime(instant: Date | string | number): string;
  /** `19:30` — the same clock, when the date is already obvious from context. */
  clock(instant: Date | string | number): string;
  /** Take the identity a re-minting route just handed back. */
  adopt(identity: Identity | null): void;
  /** End this person's turn at the tablet, leaving the tablet claimed. */
  signOut(): Promise<void>;
}

/**
 * The session, from any component under the app shell.
 *
 * A hook rather than a provider, so it must be called during a component's
 * setup — `useMe` and `useQueryClient` both read contexts, and a context read
 * from inside an event handler or a promise callback is read from outside the
 * tree that has the value. Call it once at the top of the component and keep
 * the object; every field on it is an accessor or a function, so nothing goes
 * stale by being held.
 */
export function useApp(): AppValue {
  const session = useMe();
  const queryClient = useQueryClient();

  /*
   * Until the bootstrap answers there is no identity and no config. The config
   * falls back to `DEFAULT_CONFIG` rather than to null so that `money()` and
   * `clock()` are total functions — a screen that renders a price for the one
   * frame before `/auth/me` lands should show a slightly wrong currency at
   * worst, never throw. The identity does not get the same treatment, because
   * "nobody is signed in" is a real state the shell renders a screen for.
   */
  const identity = (): Identity | null => session.data?.identity ?? null;
  const config = (): AppConfig => session.data?.config ?? DEFAULT_CONFIG;

  const staff = (): SignedInStaff | null => {
    const current = identity();
    /*
     * The three staff fields move together — the Worker mints them from one
     * row — so one check answers for all three. It is `staffId` rather than
     * `role` because that is the field the middleware guards on: `require_staff`
     * is what stands between this tablet and sending a round to the kitchen,
     * and it reads the staff claim.
     */
    if (!current?.staffId || !current.staffName || !current.role) return null;
    return { id: current.staffId, name: current.staffName, role: current.role };
  };

  /**
   * Write a freshly minted identity into the one place that holds one.
   *
   * That place is the query cache, which is what decides which screen renders:
   * the shell reads the same entry to tell a claimed tablet from a signed-in
   * one. Because there is exactly one copy, there is no second write to forget
   * — which is the whole argument for keeping the session here rather than in a
   * signal beside it.
   *
   * `setQueryData` rather than an invalidation, for the reason `queryKeys.me`
   * spells out: the response that produced this identity has already told us
   * everything a refetch would, and the person standing at the tablet is
   * waiting to start a shift rather than to watch a second request. The config
   * is carried over untouched, because nothing but a deploy can change it.
   *
   * ## Unless there is nothing to carry over
   *
   * Writing a partial `Me` would hand the next reader an object with no
   * currency in it, so that is never done — but *stopping* there is not the
   * answer either, and getting this wrong breaks the one path every tablet
   * takes exactly once. A device that has never been claimed boots, asks
   * `GET /auth/me`, and is told 401; the entry is then in an error state with
   * no data, and `retryUnlessUnauthorized` has quite rightly stopped it trying
   * again. A moment later the claim link is redeemed and hands back an
   * identity — and an updater that returns the previous value when there is no
   * previous value writes nothing at all. The tablet is claimed, holds a
   * working token, and goes on showing "this tablet has not been set up".
   *
   * So the empty case refetches instead. It is one request on the one screen in
   * the app where a request is unavoidable anyway — the claim reply carries an
   * identity but not the currency or the offset, and this tablet has neither.
   */
  const adopt = (next: Identity | null): void => {
    const previous = queryClient.getQueryData<Me>(queryKeys.me);
    if (previous && next) {
      queryClient.setQueryData<Me>(queryKeys.me, { ...previous, identity: next });
      return;
    }
    /*
     * `refetchQueries`, not `invalidateQueries`. Invalidation marks an entry
     * stale and leaves the refetch to whatever policy applies, and the policy
     * that applies here is the one that just decided not to retry a 401. A
     * refetch runs the query function, which is the point: the credential has
     * changed since it last failed.
     */
    void queryClient.refetchQueries({ queryKey: queryKeys.me });
  };

  return {
    identity,
    staff,
    config,
    money: (minor) => formatMoney(minor, config().currency),
    amount: (minor) => formatAmount(minor, config().currency),
    parseAmount: (text) => parseMoney(text, config().currency),
    dateTime: (instant) => formatDateTime(instant, config().tzOffsetMinutes),
    clock: (instant) => formatClock(instant, config().tzOffsetMinutes),
    adopt,
    /*
     * Signing a person out, not a device. The route answers with a token
     * re-minted without the staff claim, which is still this tablet's
     * credential — `api/staff.ts` installs it — so the shell drops to the PIN
     * screen rather than to the gate.
     *
     * There is deliberately no device sign-out anywhere in the app. Un-claiming
     * a tablet needs an admin with a fresh link to undo, and a control that can
     * strand a till mid-service has no business sitting next to the one that
     * ends a shift.
     */
    signOut: async () => {
      adopt(await signOutStaff());
    },
  };
}
