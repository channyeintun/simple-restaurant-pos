/**
 * What time the server thinks it is.
 *
 * Anything the whole group is supposed to see at the same moment has to be
 * scheduled against one clock, and it cannot be the phone's. Two devices in the
 * same room routinely disagree by seconds — a phone that has not synced, one on
 * a network whose NTP is blocked, one that has just come off aeroplane mode —
 * and seconds is enormous next to the thing being fixed.
 *
 * So the Worker stamps every response with its own millisecond clock and this
 * keeps the difference. `serverNow()` is then the same number, to within a few
 * tens of milliseconds, on every device in the group at any given instant.
 *
 * ## Why the tightest round trip wins
 *
 * A sample's error is bounded by its round trip: the server's stamp was written
 * somewhere inside it, and the best assumption is the middle. A 40 ms request
 * therefore pins the offset to ±20 ms, while a 900 ms one — a cold Worker, a
 * phone on a bad cell — says almost nothing. Keeping the tightest sample seen
 * rather than averaging is what makes one good request on a bad network enough.
 *
 * The floor decays slowly so a device that moves to a worse network is not
 * stuck trusting a measurement from a better one forever.
 */

/** Server time minus local time, in milliseconds. */
let offset = 0;

/** The round trip of the sample `offset` came from. Lower is more trustworthy. */
let bestRtt = Number.POSITIVE_INFINITY;

/**
 * How much the standing sample's authority decays per new measurement.
 *
 * Without this, the first fast request of a session would own the offset for as
 * long as the app stayed open. With it, a merely-good sample overtakes an old
 * excellent one after a few dozen requests, which is roughly the point at which
 * the excellent one is stale anyway.
 */
const DECAY = 1.02;

/** Beyond this the sample says nothing useful and is not worth the arithmetic. */
const USELESS_RTT = 4000;

/**
 * Fold one response into the estimate.
 *
 * Called for every API response; cheap enough to be unconditional and silent
 * when the header is absent, which it will be for anything not served by our
 * own Worker.
 */
export function noteServerTime(header: string | null, sentAt: number, receivedAt: number): void {
  if (!header) return;
  const stamp = Number(header);
  if (!Number.isFinite(stamp)) return;

  const rtt = receivedAt - sentAt;
  if (rtt < 0 || rtt > USELESS_RTT) return;

  bestRtt *= DECAY;
  if (rtt >= bestRtt) return;
  bestRtt = rtt;
  // The stamp was written at some point inside the round trip; the midpoint is
  // the least wrong guess, and the error is at most half the trip either way.
  offset = stamp + rtt / 2 - receivedAt;
}

/** The server's clock, as best this device can tell. */
export function serverNow(): number {
  return Date.now() + offset;
}

/**
 * Whether the estimate is worth scheduling against.
 *
 * False before any response has been seen — on a cold start with the app
 * restored from the back/forward cache, say — so a caller can fall back to
 * behaving the way it did before rather than trusting an offset of zero that
 * happens to be a guess.
 */
export function clockIsSynced(): boolean {
  return Number.isFinite(bestRtt);
}
