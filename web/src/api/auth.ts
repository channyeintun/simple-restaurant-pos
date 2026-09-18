import { type Identity, type Me, authResultSchema, meSchema } from '@pos/shared';
import { clearToken, get, post, setToken } from './client.js';

/**
 * The device half of the credential: redeeming a claim link, asking what this
 * tablet is, and giving the credential up again.
 *
 * Thin on purpose. Everything here is one `fetch` through `client.ts`, one
 * schema, and — where a route hands back a new token — the one line that
 * installs it. No component builds a URL, and no component knows that
 * `POST /auth/claim` is the route behind a claim link.
 *
 * ## Why these parse and the reference's did not
 *
 * The futsal wrappers cast their responses: `get<Identity>('/auth/me')` and
 * trust it. This file parses instead, and so does `staff.ts`, because the two
 * sides of this wire are written in different languages against a contract
 * that lives in a third place. A Rust struct whose field order or nullability
 * drifted from `shared/src/models.ts` would produce JSON that casts cleanly
 * and then turns up as `undefined` on a screen three components away, at which
 * point the thing to debug is a blank line on a bill rather than a mismatched
 * struct. Parsing at the boundary spends microseconds on a dozen fields and
 * names the field that is wrong.
 *
 * It also catches the deploy skew that a PWA makes possible: a tablet running
 * a bundle from last week, talking to a Worker deployed this morning, with a
 * service worker in between deciding when that stops being true.
 *
 * A parse failure is allowed to throw its `ZodError` rather than being dressed
 * up as an `ApiError`. The two are not the same event — an `ApiError` is
 * something the person holding the tablet may be able to do something about,
 * a failed parse is a bug in this repository — and flattening them would put
 * "Could not reach the server" in front of somebody whose network is fine.
 */

/**
 * Redeem a device claim link.
 *
 * The nonce comes from the URL fragment, never the query string, so it does
 * not reach any server log on the way in — see `platform.navigation.hash()`.
 * It is single-use: the row is cleared in the same statement that reads it, so
 * a second tap on the same link fails and that is correct rather than a bug to
 * work around.
 *
 * Returns the identity and swallows the token, which is the shape every
 * re-minting route in this app uses. The token is transport — it belongs to
 * `client.ts`, which puts it on every subsequent request — and a caller that
 * held a copy would be a second place for a stale one to live.
 */
export async function claimDevice(nonce: string): Promise<Identity> {
  const result = authResultSchema.parse(await post<unknown>('/auth/claim', { nonce }));
  setToken(result.token);
  return result.identity;
}

/**
 * The session bootstrap: who is calling, and how this restaurant writes money
 * and time.
 *
 * The `config` half is the whole reason this is fetched rather than compiled
 * in — `shared/src/config.ts` sets out why the currency and the offset are
 * served by the Worker and never mirrored into a `VITE_*` value.
 *
 * Deliberately *not* the reference's `currentIdentity`, which caught
 * everything and resolved null. Null collapsed two different answers into one:
 * "this tablet has never been claimed", which means show the claim screen and
 * stop, and "the wifi in the kitchen dropped again", which means keep what is
 * on screen and try once more. The caller — `lib/queries.ts` — needs to tell
 * those apart, and `client.ts` has already done the only cleanup that a 401
 * calls for by the time this rejects.
 */
export const me = (signal?: AbortSignal): Promise<Me> =>
  get<unknown>('/auth/me', signal).then((body) => meSchema.parse(body));

/**
 * Hand the credential back.
 *
 * The local token is dropped in a `finally`, so a logout on a tablet that
 * cannot reach the Worker still logs out. The alternative — leaving the token
 * in place because the round trip failed — means a tablet that somebody has
 * explicitly signed out of goes on holding a 90-day credential until it next
 * has a network, which is the opposite of what the press meant.
 */
export async function logout(): Promise<void> {
  try {
    await post('/auth/logout');
  } finally {
    clearToken();
  }
}
