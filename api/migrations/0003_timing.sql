-- Migration 0003 — how long a round should take, and when it went out.
--
-- The brief said there are no preparing/ready states because the kitchen has a
-- printer rather than a screen, and that is still true: **nothing in here is
-- filled in by the kitchen.** What this adds is the two facts the *waiter*
-- already has and the software was throwing away — roughly how long a dish
-- takes, and the moment somebody carried it to the table. Between them they
-- answer the question a customer actually asks, which is "how long will it be",
-- and the one a manager asks afterwards, which is "how long did it take".
--
-- A kitchen display would be the other thing, and this is deliberately not it.
-- No cook touches any of this.

-- products.prep_minutes -------------------------------------------------------
-- Roughly how long this dish takes, in minutes, as a number somebody types in
-- the backoffice.
--
-- Per product rather than one number for the whole menu, because the whole
-- point is to be able to say "your drinks now, the curry in fifteen" — and a
-- single global target makes a bottle of water late at the same moment a slow-
-- cooked pork curry is. A round's target is the **slowest** item on it, since
-- the round is not done until the last thing is.
--
-- 10 is the default and it is a guess, deliberately a middling one: a menu
-- nobody has set times on behaves as though everything takes ten minutes, which
-- is wrong for both ends and wrong in a way somebody will notice and fix. A
-- default of 0 would mark every round late the instant it was sent, and a
-- default of 60 would never flag anything.
--
-- No CHECK constraint, and that is not an oversight. SQLite cannot add a column
-- with a CHECK to an existing table, so the ceiling lives in `prepMinutesSchema`
-- at the API boundary — which is where the other bounded integers in this schema
-- are really enforced anyway, since `sort` and `qty` are checked by zod and by
-- `validate.rs` long before SQLite sees them.
ALTER TABLE products ADD COLUMN prep_minutes INTEGER NOT NULL DEFAULT 10;

-- items.prep_minutes_snapshot -------------------------------------------------
-- What that dish was expected to take **when this round was sent**.
--
-- Snapshotted for the same reason the name and the price are, one table up: a
-- round sent at six should not become retrospectively late because somebody
-- edited a prep time at seven. Whether the kitchen was slow is a fact about
-- that evening, and it is settled by what was expected at the time.
--
-- It also removes a join that could not always be made. `items.product_id` is
-- `ON DELETE SET NULL`, so a line whose product row was cleaned out by hand has
-- nothing to look a prep time up against — the same argument that put
-- `name_snapshot` and `price_minor_snapshot` here, arriving at the same answer.
ALTER TABLE items ADD COLUMN prep_minutes_snapshot INTEGER NOT NULL DEFAULT 10;

-- rounds.delivered_at / delivered_by ------------------------------------------
-- When the food reached the table, and who carried it.
--
-- Set by the **waiter**, on their own tablet, by tapping Delivered on the round
-- — not by the kitchen, which has no screen to tap, and not inferred from
-- anything. It is the one moment in this flow that software cannot observe and
-- a person can, so a person records it.
--
-- NULL means still outstanding, which is what drives every timer in the app:
-- the waiter's table tiles, the per-round countdown and the late colouring all
-- read "sent_at, and not yet delivered". A round that is never marked stays
-- outstanding forever and goes on showing as late, which is the honest
-- behaviour — the alternative is software quietly deciding food arrived.
--
-- `delivered_by` is SET NULL rather than RESTRICT, unlike `sent_by` beside it.
-- Who *sent* a round is on the kitchen ticket and is part of the record; who
-- carried it out is operational, and losing it when somebody leaves the roster
-- is not worth blocking a delete over. Both are NULL-defaulted, which is what
-- SQLite requires of a column added with a REFERENCES clause.
ALTER TABLE rounds ADD COLUMN delivered_at TEXT;
ALTER TABLE rounds ADD COLUMN delivered_by TEXT REFERENCES staff (id) ON DELETE SET NULL;

-- The waiter's grid asks "which rounds on this check are still out, and what is
-- the oldest", on every refresh of every tablet. That is a filter on
-- `delivered_at IS NULL` within a check, which is exactly this index — and
-- partial, so the rows it covers are only the handful outstanding at any moment
-- rather than every round the restaurant has ever sent.
CREATE INDEX idx_rounds_outstanding ON rounds (check_id, sent_at)
  WHERE delivered_at IS NULL;
