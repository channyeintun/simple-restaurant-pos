-- Migration 0004 — paying for part of a table.
--
-- `0001_init.sql` said, at the `payments` table: "V1 takes exactly one payment
-- per check — there are no split bills — but this is a table rather than three
-- columns on `checks`, because 'how much, how, who took it, when' is a
-- row-shaped fact, and the day splitting arrives it should be a route rather
-- than a migration." Half of that has held up. The table already permits many
-- rows per check, so the money side needs no column at all. What no route can
-- supply is the link between a payment and the lines it settled — and without
-- that link "what is still owed on this check" is not a question the database
-- can answer, which means it is not one the till can answer either, and the
-- till is the one holding the money.
--
-- A fourth file rather than an edit to any of the first three, for 0002's own
-- reason: 0001 has a real `database_id` behind it and a deploy workflow that
-- applies migrations by name, so rewriting one would leave a remote database
-- that believes it is migrated and is not.

-- payments.client_key ---------------------------------------------------------
-- The key a till mints for one tap of a payment button, and re-sends unchanged
-- if it has to ask again.
--
-- Exactly `rounds.client_key` from 0002, for exactly its failure: the request
-- commits and the reply is lost on the way back — the wifi by the kitchen door,
-- a tablet that slept — and the tablet cannot tell that apart from a request
-- that never arrived. The two need opposite answers, and taking money twice is
-- worse than cooking twice.
--
-- Until now a payment did not need one, because "at most one payment row" fell
-- out of "at most one request can close the check". A payment taken while the
-- check stays **open** has no close to hang on, so it needs the guard 0002
-- already wrote down.
--
-- Nullable, because every row written before this migration has no key, and
-- because NULL is "no claim about uniqueness" — which is what a partial unique
-- index ignores.
ALTER TABLE payments ADD COLUMN client_key TEXT;

-- Partial, so the NULLs do not collide with each other. SQLite already lets
-- NULLs repeat in a unique index; saying so in the predicate states the
-- exemption rather than leaving it to be inferred, the same way
-- `idx_rounds_client_key` and `idx_checks_open_table` do.
CREATE UNIQUE INDEX idx_payments_client_key
  ON payments (client_key) WHERE client_key IS NOT NULL;

-- payment_items ---------------------------------------------------------------
-- One row per line a payment settled, and how many of it.
--
-- `qty_paid` rather than a flag, and this is the decision the whole feature
-- turns on. `addProduct` in `web/src/state/cart.ts` merges a second tap of the
-- same tile into the line already there — four taps on Beer is **one row with
-- qty 4**, and only a note forks a new line. So a table of four drinking the
-- same thing is a single row, which is the most common split there is, and a
-- settlement that could only take whole rows would fail exactly that case while
-- succeeding on the rarest one.
--
-- Splitting the row into 1 and 3 instead is not available: the row is what the
-- kitchen ticket was rendered from, `print_jobs.item_id` points at it, and the
-- manual reprint in `PrintSheet` re-renders from the live rows — so a reprint
-- after a split would hand the kitchen paper that disagrees with the paper they
-- are already holding, and `live_line_count`'s answer would move for a reason
-- that has nothing to do with the bill. An allocation row touches none of that:
-- the item row the ticket printed from is byte-identical afterwards.
--
-- **There is no amount column here, and that is deliberate.** What this
-- allocation came to is `line_total_minor(price_minor_snapshot, qty_paid)` from
-- `api/core/src/totals.rs` — the same twinned function the browser used to show
-- the figure to the cashier — and `price_minor_snapshot` is frozen at send
-- time: `UPDATE items` appears exactly once in this whole API, on the void, and
-- touches only `voided_at` and `voided_by`. A stored copy would be a second
-- money figure that could disagree with `payments.amount_minor`, and the
-- arithmetic that produced it would have to happen in SQL — a third definition
-- of what a line comes to, in a language neither twin is written in and held to
-- no test case, which `totals.ts`, `totals.rs` and `db.rs` all forbid by name.
-- One money column in the money table.
--
-- No `id`, and that is a deliberate departure from this schema's otherwise
-- universal `new_id(prefix)` key. The prefix exists so somebody reading a log
-- line or a column of ids in a `wrangler d1` result knows what they are looking
-- at; nothing references an allocation, nothing logs one, and none is ever in a
-- URL. Its identity *is* (payment, item), and saying so as the primary key buys
-- a real constraint: one payment cannot allocate to the same line twice, so a
-- body naming a line twice is caught by the boundary rather than by paying for
-- it twice.
--
-- ON DELETE RESTRICT on `item_id`, unlike `items.product_id` and
-- `print_jobs.item_id`, which are both SET NULL. Those reference context a row
-- can survive losing. This references the *subject* of a money row, and a
-- ledger entry pointing at nothing is not a ledger entry — it matches
-- `payments.taken_by`, which is RESTRICT for the same reason. Items are never
-- deleted anyway, since voiding is a flag, so this fires only for somebody
-- clearing rows out by hand.
CREATE TABLE payment_items (
  payment_id TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  -- At least one. A payment that bought nothing of a line is not a row. The
  -- ceiling is the API boundary's `Int::QTY`, like every other bounded integer
  -- here; the floor is worth a CHECK because this is a new table and, unlike
  -- 0003's columns, nothing stops one being written into a CREATE TABLE.
  qty_paid   INTEGER NOT NULL CHECK (qty_paid > 0),
  PRIMARY KEY (payment_id, item_id)
);

-- "How much of this line is already paid for" is asked by every write guard in
-- the payment path and by both check reads, always as a lookup by `item_id`.
-- The primary key above leads with `payment_id` and cannot serve it.
CREATE INDEX idx_payment_items_item ON payment_items (item_id);

-- Nothing is backfilled, and that is the answer rather than an omission. A
-- payment taken before this migration covered the whole of its check, which is
-- true and which its `amount_minor` already says; writing allocations for it
-- would mean computing per-line quantities in this file for rows nobody will
-- ever query. Closed checks are history and the ledger starts here. Nothing
-- reads it backwards either: what is outstanding is only ever asked of an open
-- check, and every check open when this migration lands has no payments on it
-- at all, because taking one used to close it.
