-- Migration 0001 — initial schema.
--
-- Conventions used throughout:
--   * ids are application-generated TEXT with a type prefix ('chk_' and twenty
--     hex characters), not autoincrement, so the Worker can insert a row and
--     publish the realtime event that names it without a round-trip to read
--     the id back.
--   * timestamps are ISO-8601 UTC strings ('2026-09-18T12:30:00.000Z'). SQLite
--     sorts these lexicographically in true chronological order. Local time is
--     a fixed offset — TZ_OFFSET_MINUTES, 390 for Myanmar — applied at the
--     edges when something is shown to a person, and never stored.
--   * booleans are INTEGER 0/1.
--   * money is INTEGER minor units. MMK has zero minor digits, so a minor unit
--     is a kyat; the schema does not know that and does not need to. No floats
--     anywhere, on either side, ever.
--   * nothing is deleted. Catalogue rows carry `active`, a struck-off line
--     carries `voided_at`, and a check written last month keeps meaning what
--     it meant when the customer paid it.
--   * "tables" is written quoted everywhere it appears. SQLite accepts it
--     bare, but the word is what every other database tool calls its own
--     metadata, so an unquoted one reads like a keyword at a glance — and a
--     glance is all it gets from whoever is typing SQL into `wrangler d1
--     execute` at midnight. Quoted, it is unambiguously this table.

-- Staff ---------------------------------------------------------------------
-- Who is standing at the tablet. An admin keeps this list from the backoffice;
-- there is no self-signup, and nobody "logs in" in the web sense. Staff tap
-- four digits on a device that was claimed once, weeks ago.
CREATE TABLE staff (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- HMAC-SHA256(AUTH_SECRET, staff_id || pin), not a plain digest and not a
  -- password hash. A PIN is four digits: an unkeyed hash of one is a
  -- 10,000-entry lookup table that anybody who reads this column builds in a
  -- second, and a per-row salt only makes it 10,000 entries per person. Keying
  -- it with a secret that never leaves the Worker is what makes a leaked copy
  -- of this database uninvertible. It costs nothing to do — `hmac`/`sha2` are
  -- already in the tree for identity.rs, which signs tokens with them.
  --
  -- Rotating AUTH_SECRET therefore invalidates every stored PIN as well as
  -- every issued token. That is a property to know about, not a bug: it is the
  -- same key, and both things it protects are meant to be re-established by a
  -- person rather than migrated.
  --
  -- Including staff_id in the message means two people who both chose 1234 get
  -- different hashes, so the database cannot see that collision and no unique
  -- index here would catch it. It matters because `POST /staff/switch` is
  -- given only a PIN — the digits are the identifier, and whoever sets one has
  -- to check it is not already in use.
  --
  -- NULL means no PIN has been set and this person cannot sign in anywhere.
  -- Seeded and freshly created rows start that way, because the hash can only
  -- be computed where AUTH_SECRET is, which is the Worker.
  pin_hash   TEXT,
  -- What the tablet will let them do: a waiter sends rounds, a cashier also
  -- takes payment, an admin also edits the catalogue and hands out devices.
  -- Checked in `require_role`, so the strings here are the strings there.
  role       TEXT NOT NULL CHECK (role IN ('waiter', 'cashier', 'admin')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

-- The PIN screen lists everyone still working here, by name. That is the only
-- read of this table that is not by id — `GET /staff` returns names and roles
-- and never `pin_hash`, which is the one column in the schema that must not
-- leave the Worker.
CREATE INDEX idx_staff_active ON staff (active, name);

-- Devices -------------------------------------------------------------------
-- One row per tablet. The device, not the person, is what the cookie proves:
-- staff come and go through a PIN layered on top of a device an admin claimed
-- once and which stays claimed for the ninety days a token lasts.
CREATE TABLE devices (
  id               TEXT PRIMARY KEY,
  -- What it is called on the device list: "Waiter 1", "Counter". It is printed
  -- on nothing — the name on a kitchen ticket comes from the staff claim, so
  -- that a ticket says who took the order rather than which slab of glass it
  -- was typed on.
  name             TEXT NOT NULL,
  -- NULL until somebody has opened the claim link on this tablet. Shown in the
  -- backoffice so an admin can see at a glance which devices are still waiting.
  claimed_at       TEXT,
  -- The one outstanding claim link for this device, or NULL.
  --
  -- The nonce is a row rather than a signed token, for the reasons futsal's
  -- migration 0004 gives: a link has to be single-use, and single-use here is
  -- `SET claim_nonce = NULL`, whereas revoking a signed token needs a list of
  -- the ones you have revoked — which is this table again, with extra steps.
  -- Minting one needs no secret either, so the bootstrap script can write a
  -- random string straight into D1 without ever holding AUTH_SECRET.
  --
  -- Storing it on the device also means issuing a new link implicitly revokes
  -- the previous one, which is the behaviour wanted when somebody says "send
  -- it again, I lost the message".
  claim_nonce      TEXT,
  claim_expires_at TEXT,
  -- Bumped to sign this tablet out. Tokens are stateless and last ninety days,
  -- so without this a tablet left in a taxi keeps ordering food for three
  -- months. The version is carried in the token as `v` and compared against
  -- this column on every request — a read `require_device` is already doing to
  -- check the device still exists, so revocation costs nothing.
  token_version    INTEGER NOT NULL DEFAULT 1
);

-- Claiming is a lookup by nonce, so it has to be indexed and unique. Partial,
-- so that the many NULLs — every device that has already claimed, which is all
-- of them most of the time — do not collide with each other.
CREATE UNIQUE INDEX idx_devices_claim_nonce
  ON devices (claim_nonce) WHERE claim_nonce IS NOT NULL;

-- Tables --------------------------------------------------------------------
-- The floor, as a flat list. No shape, no coordinates, no room: the waiter
-- screen is a grid of buttons, and a restaurant that moves its furniture on a
-- busy Saturday should not have to redraw a plan before it can take an order.
CREATE TABLE "tables" (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  -- Position in the grid, set in the backoffice. Ties break by name, so a
  -- floor that never touches this still comes out in a stable order rather
  -- than in whatever order D1 felt like.
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX idx_tables_sort ON "tables" (active, sort, name);

-- Categories ----------------------------------------------------------------
-- The chips above the product tiles. One level, never a tree — the waiter is
-- standing at a table with a customer waiting, and a second tap to get to
-- "Curries > Chicken" is a second tap.
CREATE TABLE categories (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX idx_categories_sort ON categories (active, sort, name);

-- Products ------------------------------------------------------------------
CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  -- RESTRICT rather than CASCADE: a category is retired with `active = 0` and
  -- never deleted, so a DELETE reaching this constraint is a mistake, and the
  -- useful thing to do with a mistake is refuse it rather than propagate it
  -- through the menu.
  category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  -- Minor units — kyat, under MMK. This is what the tile shows and what an
  -- item copies at send time; see `items.price_minor_snapshot` for why the
  -- copy exists.
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Every read of this table is "the products in this category, in tile order",
-- because that is the shape of the screen it feeds.
CREATE INDEX idx_products_category ON products (category_id, sort, name);

-- Checks --------------------------------------------------------------------
-- One table seating. It opens on the first Send to kitchen and closes when it
-- is paid; there is no "seat the table" step, because there is no moment in a
-- waiter's evening when they would perform one.
CREATE TABLE checks (
  id        TEXT PRIMARY KEY,
  -- NULL is takeaway or a counter sale: a real check with no table under it.
  -- SET NULL rather than CASCADE, because retiring a table must never take
  -- last week's takings with it — and tables are retired with `active = 0`
  -- anyway, so this fires only if somebody cleans a row out by hand.
  table_id  TEXT REFERENCES "tables" (id) ON DELETE SET NULL,
  -- The waiter who opened it, for the evening somebody asks whose table this
  -- was. The name on each kitchen ticket hangs off the round instead, since
  -- the second round may well be sent by somebody else.
  opened_by TEXT NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  status    TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'paid', 'voided')),
  opened_at TEXT NOT NULL,
  -- Set when it stops being open, whichever of the two ways it went.
  closed_at TEXT
);

-- The cashier's entire screen is "the checks that are still open, oldest
-- first". It is re-read on every realtime event and on every five-second
-- fallback poll, which makes this the second busiest index here.
CREATE INDEX idx_checks_status ON checks (status, opened_at);

-- A table may have at most one open check, and the database is where that rule
-- lives. A route that read first and inserted second would be a race rather
-- than a rule: two waiters tapping Send on table 4 in the same second both see
-- no open check, both open one, and the table now has two bills and half its
-- food on each. SQLite settles it instead — the second insert fails this index
-- and the route turns that failure into "this table already has a check open",
-- which is the truth and is what the waiter needs to hear.
--
-- Partial on both counts. `status = 'open'` so that a paid check does not
-- block the next seating; `table_id IS NOT NULL` because takeaway is a check
-- without a table and there can be any number of those at once. The second
-- half is belt and braces — SQLite already lets NULLs repeat in a unique index
-- — but it says the exemption out loud rather than leaving it to be inferred.
CREATE UNIQUE INDEX idx_checks_open_table ON checks (table_id)
  WHERE status = 'open' AND table_id IS NOT NULL;

-- Rounds --------------------------------------------------------------------
-- One tap of Send to kitchen, and therefore exactly one kitchen ticket. The
-- ticket carries this round's items and nothing else: the kitchen cooked the
-- last round twenty minutes ago, and a reprint of the whole check is how a
-- table ends up with two of everything.
CREATE TABLE rounds (
  id       TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  -- 1, 2, 3 … within the check. It is the heading on the printed ticket, so it
  -- has to mean the same thing to the kitchen and to the screen; the UNIQUE
  -- below is what stops two sends a second apart both claiming to be round 3.
  seq      INTEGER NOT NULL CHECK (seq >= 1),
  -- Whose name goes on the ticket. This is the staff claim off the token, not
  -- the device: two waiters share a tablet over a shift and the kitchen needs
  -- to know which of them to ask about the "no chilli".
  sent_by  TEXT NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  sent_at  TEXT NOT NULL,
  -- Reading a check is reading its rounds in order, every single time, and
  -- this constraint's own index is that read — so there is deliberately no
  -- second index on `check_id` next to it.
  UNIQUE (check_id, seq)
);

-- Items ---------------------------------------------------------------------
-- A line on a round.
--
-- The name and the price are copies taken at send time, not joins. The ticket
-- that printed and the bill the customer is handed have to say what was
-- ordered and what it cost then: an admin who renames "Chicken curry" or puts
-- it up five hundred kyat at seven o'clock must not silently rewrite a check
-- that was opened at six. This is the one denormalisation in the schema and it
-- is the whole reason the schema is trustworthy.
CREATE TABLE items (
  id                   TEXT PRIMARY KEY,
  round_id             TEXT NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  -- Which product this was, for the day somebody wants to count how many of
  -- them went out. SET NULL rather than CASCADE, and the snapshots above are
  -- what make that safe: the line still reads and still totals with nothing
  -- behind it.
  product_id           TEXT REFERENCES products (id) ON DELETE SET NULL,
  name_snapshot        TEXT NOT NULL,
  price_minor_snapshot INTEGER NOT NULL CHECK (price_minor_snapshot >= 0),
  qty                  INTEGER NOT NULL CHECK (qty > 0),
  -- Free text from the waiter — "no chilli", "extra rice". The only modifier
  -- this app has, deliberately: anything structured is a menu editor, and a
  -- menu editor is a different product.
  note                 TEXT,
  -- Voiding is a flag, never a delete. The round has already printed, so the
  -- row has to survive to explain the void ticket that follows it and to keep
  -- the bill honest about what was struck off and by whom.
  voided_at            TEXT,
  voided_by            TEXT REFERENCES staff (id) ON DELETE SET NULL
);

-- Every read is "the lines on this round": a check's total walks its rounds
-- and sums what this index hands back, and a kitchen ticket is one lookup.
CREATE INDEX idx_items_round ON items (round_id);

-- Payments ------------------------------------------------------------------
-- What was handed over. V1 takes exactly one payment per check — there are no
-- split bills — but this is a table rather than three columns on `checks`,
-- because "how much, how, who took it, when" is a row-shaped fact, and the day
-- splitting arrives it should be a route rather than a migration.
CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  check_id     TEXT NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  method       TEXT NOT NULL CHECK (method IN ('cash', 'card', 'other')),
  -- Minor units, like every other amount here. Non-negative rather than
  -- strictly positive: a check whose every line was voided still gets paid and
  -- closed, for zero, and refusing that row would leave the table occupied on
  -- the cashier's screen forever.
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  taken_by     TEXT NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  at           TEXT NOT NULL
);

-- Finding a check's payment. There is no index on `at` for the backoffice's
-- daily total on purpose: this table grows by about sixty rows a day, so the
-- scan is cheaper than the write cost of keeping a second index in step during
-- service.
CREATE INDEX idx_payments_check ON payments (check_id);

-- Print jobs ----------------------------------------------------------------
-- The queue between the Worker and the printer agent on the restaurant's LAN.
--
-- Cloudflare cannot open a socket to a printer on TCP 9100 behind somebody's
-- router, and the printer cannot call Cloudflare, so the direction is reversed:
-- the agent polls this table through the API every three seconds and acks what
-- it managed to print. A job nobody acked stays pending, which is exactly what
-- makes a power cut or an agent restart self-healing — it comes back, polls,
-- and prints what it missed while it was gone.
CREATE TABLE print_jobs (
  id         TEXT PRIMARY KEY,
  round_id   TEXT NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  -- 'ticket' is the round as sent. 'void' is a strike-off the kitchen has to
  -- be told about in the same physical way they were told to cook it, because
  -- the last piece of paper they were handed says to cook it.
  kind       TEXT NOT NULL CHECK (kind IN ('ticket', 'void')),
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'printed', 'failed')),
  -- Counted up by the agent, which backs off between tries and gives up at
  -- three. A printer that is switched off or out of paper stops being retried
  -- forever and becomes a red banner on the cashier's screen instead, which is
  -- the only place a person can do anything about it.
  attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Whatever the agent could say about the failure — ECONNREFUSED, a timeout.
  -- It is what that banner prints, so it is stored for a person to read and
  -- not for code to match on.
  last_error TEXT,
  created_at TEXT NOT NULL,
  printed_at TEXT
);

-- The hottest index in the schema. `GET /print-jobs?status=pending` runs every
-- three seconds all day — fourteen thousand times — and almost every one of
-- those answers "nothing". This is what makes that answer a probe of an empty
-- range rather than a walk over every ticket printed since opening.
CREATE INDEX idx_print_jobs_status ON print_jobs (status, created_at);
