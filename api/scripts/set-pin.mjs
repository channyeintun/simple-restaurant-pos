/**
 * Set a staff member's PIN straight against the database.
 *
 *   npm run pin:set -w @pos/api -- <staffId> <pin> [--local]
 *
 * This is the companion to `bootstrap-link.mjs` and exists for the same reason:
 * a freshly seeded restaurant is unusable until somebody can get in. A claim
 * link gets a tablet past the gate; a PIN gets a person past the keypad, and
 * `seed.sql` deliberately leaves `pin_hash` NULL because SQL cannot compute one.
 *
 * ## Why this one needs a secret and the claim script does not
 *
 * A claim nonce is a random value looked up in a table — minting one is a
 * `randomBytes` and an `UPDATE`, and nothing has to agree about how it was
 * derived. A PIN hash is the opposite: it is `HMAC-SHA256(AUTH_SECRET, staffId
 * || pin)`, base64url and unpadded, and it is only ever *compared*, never
 * looked up. Whatever writes it has to construct it exactly the way
 * `identity::verify_pin` does, with the same key, or the person types the right
 * four digits forever and is told they are wrong.
 *
 * So the key has to be here, and it is read from the same place the Worker
 * reads it: `api/.dev.vars` locally, or `AUTH_SECRET` in the environment for a
 * deployment. It is never passed on the command line, where it would sit in a
 * shell history for as long as the shell lives.
 *
 * Rotating `AUTH_SECRET` invalidates every stored PIN along with every issued
 * token, and re-running this is how they come back.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const [staffId, pin] = args.filter((a) => !a.startsWith('--'));

if (!staffId || !pin) {
  console.error(`
Usage: npm run pin:set -w @pos/api -- <staffId> <pin> [--local]

Find the id with:
  npx wrangler d1 execute restaurant-pos ${local ? '--local' : '--remote'} \\
    --command "SELECT id, name, role FROM staff WHERE active = 1;"
`);
  process.exit(1);
}

// Four digits, the same rule `POST /staff/switch` enforces. Checked here too,
// because a PIN this script would accept and that route would not is a PIN
// nobody can ever use.
if (!/^\d{4}$/.test(pin)) {
  console.error('\nA PIN is 4 digits.');
  process.exit(1);
}

/**
 * `AUTH_SECRET`, from the environment or from `.dev.vars`.
 *
 * The file is `KEY=value` lines with `#` comments — wrangler's own format, not
 * dotenv's, so there is nothing to unquote and no `export` to strip.
 */
function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    const file = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of file.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0 && trimmed.slice(0, eq).trim() === 'AUTH_SECRET') {
        return trimmed.slice(eq + 1).trim();
      }
    }
  } catch {
    // No .dev.vars — fall through to the message below.
  }
  return null;
}

const secret = authSecret();
if (!secret) {
  console.error(`
No AUTH_SECRET. ${local ? 'Copy api/.dev.vars.example to api/.dev.vars' : 'Set AUTH_SECRET in the environment'} first —
it has to be the same key the Worker verifies with, or the PIN will never match.
`);
  process.exit(1);
}

const safeId = staffId.replace(/'/g, "''");

// An inactive staff row cannot sign in, so a PIN for one would look like it
// worked here and then be skipped by the route — which reads like a bug rather
// than like "that person has left".
const check = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'restaurant-pos', local ? '--local' : '--remote', '--json',
   '--command', `SELECT name, active FROM staff WHERE id='${safeId}';`],
  { encoding: 'utf8' },
);
const found = JSON.parse(check)[0]?.results?.[0];

if (!found) {
  console.error(`\nNo staff member with id "${staffId}".`);
  process.exit(1);
}
if (found.active !== 1) {
  console.error(`
"${found.name}" is not active, so a PIN would never be checked against this row.
Reactivate them first:

  npx wrangler d1 execute restaurant-pos ${local ? '--local' : '--remote'} \\
    --command "UPDATE staff SET active = 1 WHERE id = '${safeId}';"
`);
  process.exit(1);
}

// `identity::pin_hash`, in JavaScript. The two have to agree byte for byte;
// `hashes_pins_the_way_node_does` in `api/src/identity.rs` pins the same
// vectors this line produces, so a change to either side fails that test.
const hash = createHmac('sha256', secret).update(`${staffId}${pin}`).digest('base64url');

execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'restaurant-pos', local ? '--local' : '--remote',
   '--command', `UPDATE staff SET pin_hash='${hash}' WHERE id='${safeId}';`],
  { encoding: 'utf8' },
);

console.log(`
PIN set for ${found.name}.

Two people must not share four digits: the id is part of the message, so their
hashes differ and neither the column nor any index can see the collision. Check
the list before handing out a PIN that is already in use.
`);
