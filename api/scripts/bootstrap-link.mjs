/**
 * Mint a claim link for a member straight against the database.
 *
 *   npm run claim:bootstrap -w @futsal/api -- <memberId> [--local]
 *
 * This is the way in when nobody can get in: the very first organizer, or an
 * organizer who has lost their only device. Everyone else gets a link from
 * inside the app.
 *
 * It needs no secrets — a claim nonce is just a random value looked up in the
 * `members` table, which is precisely why it was not made a signed token.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const local = args.includes('--local');
const memberId = args.find((a) => !a.startsWith('--'));

if (!memberId) {
  console.error(`
Usage: npm run claim:bootstrap -w @futsal/api -- <memberId> [--local]

Find the id with:
  npx wrangler d1 execute futsal-friday --remote --command "SELECT id, name FROM members;"
`);
  process.exit(1);
}

const safeId = memberId.replace(/'/g, "''");

// A deactivated member cannot claim, so a link for one would look fine here
// and then fail with "not valid any more" — which reads like a bug rather than
// "that person was removed from the roster".
const check = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'futsal-friday', local ? '--local' : '--remote', '--json',
   '--command', `SELECT name, active FROM members WHERE id='${safeId}';`],
  { encoding: 'utf8' },
);
const found = JSON.parse(check)[0]?.results?.[0];

if (!found) {
  console.error(`\nNo member with id "${memberId}".`);
  process.exit(1);
}
if (found.active !== 1) {
  console.error(`
"${found.name}" has been removed from the roster, so a link would never work.
Reactivate them first:

  npx wrangler d1 execute futsal-friday ${local ? '--local' : '--remote'} \\
    --command "UPDATE members SET active = 1 WHERE id = '${safeId}';"
`);
  process.exit(1);
}

const nonce = randomBytes(32).toString('base64url');
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const sql =
  `UPDATE members SET claim_nonce='${nonce}', claim_expires_at='${expiresAt}' ` +
  `WHERE id='${safeId}';`;

const out = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'futsal-friday', local ? '--local' : '--remote', '--command', sql],
  { encoding: 'utf8' },
);

const appUrl = (
  process.env.APP_URL ??
  (local ? 'http://localhost:5173' : 'https://futsal-friday.pages.dev')
).replace(/\/$/, '');

console.log(`
Claim link for ${found.name}:

  ${appUrl}/claim#${nonce}

Open it on the device that should be signed in. It works once, and expires in
7 days. Issuing another link for the same member replaces this one.
`);
