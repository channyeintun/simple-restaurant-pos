/**
 * Mint a claim link for a device straight against the database.
 *
 *   npm run claim:bootstrap -w @pos/api -- <deviceId> [--local]
 *
 * This is the way in when nothing can get in: the very first tablet, on a
 * database that has just been migrated and seeded. Every device after it gets a
 * link from the backoffice, on a tablet that is already claimed.
 *
 * It needs no secrets — a claim nonce is just a random value looked up in the
 * `devices` table, which is precisely why it was not made a signed token. A
 * signed one would mean this script held `AUTH_SECRET`, which would mean the
 * secret was on somebody's laptop, which is the thing the whole design is
 * arranged to avoid.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const local = args.includes('--local');
const deviceId = args.find((a) => !a.startsWith('--'));

if (!deviceId) {
  console.error(`
Usage: npm run claim:bootstrap -w @pos/api -- <deviceId> [--local]

Find the id with:
  npx wrangler d1 execute restaurant-pos --remote --command "SELECT id, name FROM devices;"

The seed creates one to start from, called dev_counter.
`);
  process.exit(1);
}

const safeId = deviceId.replace(/'/g, "''");

// Check the row before writing to it.
//
// The reference checked `active` here, because a deactivated member's link
// would mint perfectly well and then fail at redemption with "not valid any
// more" — which reads like a bug in the app rather than "that person is off the
// roster". `devices` has no `active` column: a tablet is cut off by bumping
// `token_version`, and that deliberately does *not* stop a new link working,
// because the tablet you just cut off is usually the one you are about to
// re-issue to.
//
// So the only state that would make a link dead on arrival is a device id that
// does not exist — a typo, or a database that was never seeded — and the same
// read tells the admin whether this tablet has ever been claimed, which is the
// other thing they want to know before reading a URL out over the phone.
const check = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'restaurant-pos', local ? '--local' : '--remote', '--json',
   '--command', `SELECT name, claimed_at FROM devices WHERE id='${safeId}';`],
  { encoding: 'utf8' },
);
const found = JSON.parse(check)[0]?.results?.[0];

if (!found) {
  console.error(`
No device with id "${deviceId}".

Add one first:

  npx wrangler d1 execute restaurant-pos ${local ? '--local' : '--remote'} \\
    --command "INSERT INTO devices (id, name) VALUES ('dev_waiter1', 'Waiter 1');"
`);
  process.exit(1);
}

const nonce = randomBytes(32).toString('base64url');
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const sql =
  `UPDATE devices SET claim_nonce='${nonce}', claim_expires_at='${expiresAt}' ` +
  `WHERE id='${safeId}';`;

execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'restaurant-pos', local ? '--local' : '--remote', '--command', sql],
  { encoding: 'utf8' },
);

const appUrl = (
  process.env.APP_URL ??
  (local ? 'http://localhost:5173' : 'https://restaurant-pos.pages.dev')
).replace(/\/$/, '');

// The nonce is in the fragment, which browsers do not send to a server: it stays
// out of access logs and out of `Referer` headers on the way to whatever the
// claim page loads next.
console.log(`
Claim link for ${found.name}${found.claimed_at ? ' (claimed once already)' : ''}:

  ${appUrl}/claim#${nonce}

Open it on the tablet that should be signed in. It works once, and expires in
7 days. Issuing another link for the same device replaces this one.
`);
