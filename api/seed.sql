-- Optional bootstrap data. NOT a migration — run it once by hand to get an app
-- you can actually tap through, then edit everything from the backoffice.
--
--   npm run db:seed:local -w @pos/api            (local dev)
--   npx wrangler d1 execute restaurant-pos --remote --file=./seed.sql
--
-- `INSERT OR IGNORE` throughout, so running it twice does nothing the second
-- time and running it against a floor somebody has already edited leaves their
-- edits alone.
--
-- The ids below are readable rather than the usual prefix and twenty hex
-- characters. Nothing parses an id — they are opaque keys everywhere in the
-- app — and a row you are going to name on a command line is easier to name if
-- it is called `dev_counter`.

-- The first admin. Everybody else is added from the backoffice by this person.
--
-- `pin_hash` is NULL, which means they cannot sign in yet, and it is NULL
-- because this file cannot compute it: the hash is HMAC-SHA256 keyed with
-- AUTH_SECRET, which lives in the Worker's secrets and deliberately never
-- leaves it. Set the PIN from the backoffice, or with the bootstrap script —
-- the code that writes the hash has to be the code that checks it, and a
-- hand-written digest that disagrees about the encoding just fails to match
-- four digits at a time.
INSERT OR IGNORE INTO staff (id, name, pin_hash, role, active, created_at) VALUES
  -- A name, not a job title: the screen that lists staff shows the role
  -- beside the name, so seeding somebody called "Manager" with the admin
  -- role renders as "Manager \u00b7 Manager". Replace it with the real owner.
  ('stf_admin', 'Owner', NULL, 'admin', 1, '2026-01-01T00:00:00.000Z');

-- One tablet to claim, so there is something for the bootstrap script to mint
-- a link for on a fresh database:
--
--   npm run claim:bootstrap -w @pos/api -- dev_counter --local
--
-- `claimed_at` is NULL until somebody opens that link on the tablet, and
-- `token_version` starts at 1 because the column's own default is 1.
INSERT OR IGNORE INTO devices (id, name, claimed_at, claim_nonce, claim_expires_at, token_version) VALUES
  ('dev_counter', 'Counter tablet', NULL, NULL, NULL, 1);

-- A small floor. Five tables is enough to see the grid wrap and to have one
-- occupied while another is free, which is the state most of the UI is about.
INSERT OR IGNORE INTO "tables" (id, name, sort, active) VALUES
  ('tbl_1', 'Table 1', 1, 1),
  ('tbl_2', 'Table 2', 2, 1),
  ('tbl_3', 'Table 3', 3, 1),
  ('tbl_4', 'Table 4', 4, 1),
  ('tbl_5', 'Table 5', 5, 1);

INSERT OR IGNORE INTO categories (id, name, sort, active) VALUES
  ('cat_curry', 'Curries', 1, 1),
  ('cat_noodles', 'Noodles & rice', 2, 1),
  ('cat_drinks', 'Drinks', 3, 1);

-- Prices are minor units, and MMK has zero minor digits, so these numbers are
-- kyat exactly: 2500 is 2,500 Ks and prints as "2,500 Ks". Nothing here is a
-- fractional anything, which is the whole reason money is an integer.
-- `prep_minutes` is the sixth column, and the numbers are the point of the
-- seed rather than decoration: a salad and a bottle of water are not the same
-- wait as a pork curry, and a menu where everything takes ten minutes makes the
-- whole timing feature say nothing. Set yours from the backoffice.
INSERT OR IGNORE INTO products (id, category_id, name, price_minor, prep_minutes, sort, active) VALUES
  ('prd_chicken_curry', 'cat_curry', 'Chicken curry', 4500, 15, 1, 1),
  ('prd_pork_curry', 'cat_curry', 'Pork curry', 5000, 20, 2, 1),
  ('prd_tealeaf_salad', 'cat_curry', 'Tea leaf salad', 3000, 5, 3, 1),
  ('prd_mohinga', 'cat_noodles', 'Mohinga', 2500, 10, 1, 1),
  ('prd_shan_noodles', 'cat_noodles', 'Shan noodles', 3000, 12, 2, 1),
  ('prd_fried_rice', 'cat_noodles', 'Egg fried rice', 3500, 8, 3, 1),
  ('prd_tea', 'cat_drinks', 'Myanmar tea', 800, 2, 1, 1),
  ('prd_water', 'cat_drinks', 'Bottled water', 500, 0, 2, 1);
