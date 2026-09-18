-- Migration 0002 — the two columns sending a round needs.
--
-- Both belong to the same operation and neither could be guessed before it was
-- written down: `0001_init.sql` describes what a round *is*, and this is what
-- it takes to create one exactly once and to strike a line off one afterwards.
--
-- A second file rather than an edit to the first. 0001 has a real
-- `database_id` behind it and a deploy workflow that applies migrations by
-- name, so rewriting it would leave a remote database that believes it is
-- migrated and is not. The note in `CLAUDE.md` about putting the device claim
-- columns in 0001 rather than a later migration was written before any of that
-- existed and is about a schema with no history; this one has one.

-- rounds.client_key ----------------------------------------------------------
-- The key a tablet mints for one tap of Send to kitchen, and re-sends unchanged
-- if it has to ask again.
--
-- This is the whole of the idempotency story, and the failure it exists for is
-- specific: the waiter taps Send, the request commits, and the reply is lost on
-- the way back — the wifi by the kitchen door, a tablet that slept. The tablet
-- cannot tell that apart from a request that never arrived, and the two need
-- opposite responses. Retrying the first prints the food twice; not retrying
-- the second means nobody cooks it.
--
-- So the tablet decides. It mints a key when the waiter presses the button,
-- keeps it in the draft beside the lines, and sends the same one every time it
-- tries. The Worker looks the key up before it writes anything: found means
-- this round already exists and the answer is the check as it now stands, with
-- nothing inserted; not found means go ahead. The index below is what makes
-- that true even for two copies genuinely in flight at once — the second insert
-- fails it, the batch rolls back, and the handler answers from the first.
--
-- Nullable, because rows written before this column existed have no key and
-- because nothing but the send route sets one. NULL is "no claim about
-- uniqueness", which is exactly what a partial unique index ignores.
ALTER TABLE rounds ADD COLUMN client_key TEXT;

-- Partial, so that the NULLs do not collide with each other. SQLite already
-- lets NULLs repeat in a unique index; saying so in the predicate states the
-- exemption rather than leaving it to be inferred, the same way
-- `idx_checks_open_table` does.
--
-- Not scoped to a check. A key names one tap on one tablet, and the check it
-- lands on is decided by the Worker — on the first send of the evening there is
-- no check id yet to scope it to, which is the case this has to survive.
CREATE UNIQUE INDEX idx_rounds_client_key
  ON rounds (client_key) WHERE client_key IS NOT NULL;

-- print_jobs.item_id ---------------------------------------------------------
-- Which line a void notice is about.
--
-- `round_id` alone cannot say. A round of four lines that has two of them
-- struck off produces two void jobs, and with only the round to go on they are
-- indistinguishable — the agent would print the same slip twice and the kitchen
-- would take one dish off the pass instead of two.
--
-- NULL on a `ticket` job, where it would mean nothing: a ticket is the round,
-- all of it, as it was sent. Deliberately including any line that has since
-- been voided — the void notice that follows refers to a slip the kitchen is
-- holding, and a ticket that quietly omitted the line would be a strike-off for
-- something they were never told to cook.
--
-- SET NULL rather than CASCADE, to match `items.product_id`: a job that has
-- already printed is a record of a piece of paper that exists in the kitchen,
-- and it should survive whatever happens to the row it was about. Items are
-- never deleted anyway — voiding is a flag — so this fires only if somebody
-- cleans a row out by hand.
ALTER TABLE print_jobs ADD COLUMN item_id TEXT REFERENCES items (id) ON DELETE SET NULL;
