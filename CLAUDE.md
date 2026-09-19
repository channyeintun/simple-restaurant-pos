# Simple Restaurant POS

A point-of-sale for **one** restaurant: a few waiter tablets, one cashier tablet, one
kitchen printer, one backoffice screen. Everything runs on Cloudflare and Upstash free
tiers, so the running cost is zero and the design is bounded by that rather than by
taste.

This file is the brief and the conventions. It is the thing to re-read before writing
code, and the thing to update when a rule changes.

---

## The reference repo

<https://github.com/channyeintun/futsal-friday> is how these apps are built here. The POS
is a **second app on the same skeleton**, not a redesign. Read its README, `api/src/`,
`shared/src/` and `web/src/{api,platform}/` before writing anything; clone it to
`/home/user/channyeintun/futsal-friday` if it is not already there.

**Copied verbatim, adjusting names only.** Changing any of these is a deviation and needs
asking first:

| From | What |
| --- | --- |
| `api/src/` | `http.rs`, `middleware.rs`, `cors.rs`, `env.rs`, `db.rs`, `identity.rs`, `realtime.rs`, `base64.rs`, `js.rs` |
| `api/src/routes/mod.rs` | the `route(...) -> Option<ApiResult<Response>>` dispatcher pattern, and registration order spelled out in `lib.rs` |
| `api/` | `wrangler.jsonc` shape, `Cargo.toml` pins (worker 0.6 + pinned `worker-build@^0.1`), `migrations/` layout, `seed.sql`, `scripts/bootstrap-link.mjs`, `package.json` scripts |
| `shared/` | package shape, `models.ts` zod style, `events.ts` style, `money.ts`, `i18n/` (en + my, English is the source of truth) |
| `web/src/api/` | `client.ts`, `realtime.ts` — framework-free, copy as-is |
| `web/src/platform/` | the whole seam, as-is |
| `web/public/` | `sw.js`, `manifest.webmanifest`, `_redirects`, `scripts/generate-icons.mjs` |

**Dropped from the reference:** push notifications, R2 uploads, the cron, guest players,
teams, the leaderboard. Nothing in this repo should grow a `push.rs`, a `PROOFS` bucket
or a `crons` trigger.

**The one React coupling in the copied code** is `web/src/platform/web.ts`, which imports
`flushSync` from `react-dom` for the view transition. Solid applies updates synchronously
at the end of a batch, so the Solid version calls the change directly inside
`startViewTransition` and drops the import. Everything else in `platform/` is plain DOM.

---

## Layout

```
simple-restaurant-pos/
├── shared/      types, zod schemas, and pure helpers the web app is built on
│   ├── models.ts     domain models + request validation
│   ├── events.ts     the six realtime events, defined once
│   ├── money.ts      integer minor units, no floats
│   ├── totals.ts     what a check comes to, voided lines skipped
│   ├── timing.ts     how long a round should take, and when it is late
│   ├── time.ts       fixed-offset local time, like futsal's ICT handling
│   ├── ticket.ts     what a kitchen ticket says, as data
│   └── i18n/         message catalogues; English is the source of truth
├── api/         Rust on Cloudflare Workers
│   ├── core/         the pure crate: money, ticket, totals, timing, clock
│   ├── migrations/   versioned D1 SQL
│   └── src/routes/
├── web/         Solid + Vite + Material Design 3, on Cloudflare Pages
│   ├── api/          every fetch call in the app
│   ├── platform/     every browser-only API in the app
│   ├── public/       manifest, service worker, icons
│   └── pages/        /waiter/*, /cashier/*, /backoffice/*
└── agent/       the printer agent: Node + TypeScript, runs on the restaurant LAN
```

`npm` workspaces: `shared`, `api`, `web`, `agent`.

---

## Stack

- **`api/`** — Rust on Cloudflare Workers, D1, Upstash Redis over REST behind the same
  `PubSub` seam. `worker 0.6`, `wasm-bindgen =0.2.105`, `worker-build@^0.1`; the pins are
  load-bearing and explained in `api/Cargo.toml`.
- **`web/`** — **Solid.js, not React.** Vite + `vite-plugin-solid` + `@solidjs/router` +
  `@tanstack/solid-query` v5 + `@material/web` + zod. One app, three route trees:
  `/waiter/*`, `/cashier/*`, `/backoffice/*`. Installable PWA on Cloudflare Pages.
- **`agent/`** — Node + TypeScript, one file plus a config. Runs on the restaurant LAN.

### Solid notes

`@material/web` ships web components, and Solid talks to them differently from React:

- `prop:` for element properties (`prop:value`, `prop:selected`), plain attributes for
  the rest. Solid sets unknown JSX attributes as attributes, so anything non-primitive
  needs `prop:`.
- `on:` for custom events (`on:close`, `on:input` where the element fires its own).
- Augment `solid-js`'s `JSX.IntrinsicElements` for the `md-*` tags, in
  `web/src/types/material.d.ts` — the same list the reference declares for React.
- `createStore` for the waiter cart and the session state; signals for everything else.
- `createLive()` wraps `connectLive()` from `web/src/api/realtime.ts` with `onMount` /
  `onCleanup`. It replaces the reference's `useLive` hook and keeps the same contract:
  handlers are read through the store so a re-render never tears the stream down.
- `useQuery(() => ({ queryKey, queryFn }))` — solid-query takes a **function** returning
  the options, which is what makes the key reactive. Passing a plain object is the
  commonest porting mistake.
- Apply realtime events with `queryClient.setQueryData`. Never refetch on an event: the
  payloads are self-sufficient precisely so a client does not have to.

---

## Domain model

`api/migrations/`. Conventions are the reference's: application-generated
`TEXT` ids with a type prefix, ISO-8601 UTC timestamps as `TEXT`, booleans as `INTEGER`
0/1, money as `INTEGER` minor units.

```
staff       (id, name, pin_hash, role waiter|cashier|admin, active, created_at)
devices     (id, name, claimed_at)
tables      (id, name, sort, active)
categories  (id, name, sort, active)
products    (id, category_id, name, price_minor, prep_minutes, sort, active)
checks      (id, table_id NULL, opened_by, status open|paid|voided, opened_at, closed_at)
rounds      (id, check_id, seq, sent_by, sent_at, client_key, delivered_at, delivered_by)
items       (id, round_id, product_id, name_snapshot, price_minor_snapshot,
             prep_minutes_snapshot, qty, note, voided_at, voided_by)
payments    (id, check_id, method cash|card|other, amount_minor, taken_by, at)
print_jobs  (id, round_id, item_id, kind ticket|void, status pending|printed|failed, attempts,
             last_error, created_at, printed_at)
```

`devices` additionally carries `claim_nonce`, `claim_expires_at` and `token_version`, the
same three columns `members` grew in futsal's migration 0004 — the claim link and the
revocation check are the reference's, so the columns they read have to exist. They go in
`0001_init.sql` rather than a later migration: at the time that schema had no history
to preserve. It has one now — `0002_send_and_void.sql` adds `rounds.client_key`, which
is how a re-sent round is recognised as the same tap rather than a second dinner, and
`print_jobs.item_id`, without which two strikes off one round print the same void slip
twice. `0003_timing.sql` adds `products.prep_minutes`, its snapshot on `items`, and
`rounds.delivered_at`/`delivered_by`. Each is a new file rather than an edit, because
0001 has a real `database_id` behind it and a deploy workflow that applies migrations by
name.

### Rules

- A **check** is one table seating. It opens on the first send and closes on payment.
  `table_id` NULL means takeaway or counter. **A table may have at most one open check**,
  enforced by a partial unique index — `CREATE UNIQUE INDEX idx_checks_open_table ON
  checks (table_id) WHERE status = 'open' AND table_id IS NOT NULL`, the same shape as
  futsal's `idx_sessions_slot`. The database is where that rule lives; a route that only
  checked first would race two waiters tapping Send at once.
- A **round** is one "Send to kitchen" tap. One round is exactly one kitchen ticket
  printing **only that round's items**. Never reprint the whole check. `UNIQUE (check_id,
  seq)`, `seq` starting at 1.
- Items **snapshot** `name` and `price_minor` at send time. The kitchen ticket and the
  bill must not change because somebody edited a product in the backoffice afterwards.
- Money is **integer minor units**. No floats anywhere, on either side, ever. Currency
  code, symbol and minor-unit digits come from wrangler vars (see below).
- **Voiding an item on a sent round** creates a `void` print job, so the kitchen learns.
  Voiding is never a delete: `voided_at` and `voided_by` are set and the row stays.
- There are **no preparing/ready states**, because the kitchen has a printer rather
  than a screen and no cook touches this software. That rule stands, and the timing
  added in `0003_timing.sql` does not break it: `prep_minutes` is a number a manager
  types, and `delivered_at` is set by the **waiter** on their own tablet when they
  carry the food out. Both are facts the floor already had; neither is the kitchen
  reporting progress, and a kitchen display is still out of scope.
- A round's target is the **slowest dish on it** — `round_target_minutes`, twinned —
  because a round is one trip to the table and is not finished until the last thing on
  it is. Never a sum: three drinks take as long as one drink. Whether that target has
  been missed is `roundTiming`, which is TypeScript only and says in its own doc why:
  it is a function of *now*, redrawn every fifteen seconds in a browser, and the Worker
  never renders it.
- Time is a **fixed offset** from a wrangler var, handled the way futsal handles ICT: a
  constant, not a timezone database. Myanmar is UTC+06:30, which is why the var is
  `TZ_OFFSET_MINUTES` and not hours.

### Configuration vars

`wrangler.jsonc` `vars`, and the Worker is the single source of truth for all four:

| Var | Meaning |
| --- | --- |
| `CURRENCY_CODE` | ISO 4217, e.g. `MMK` |
| `CURRENCY_SYMBOL` | what is printed beside an amount, e.g. `Ks` |
| `CURRENCY_MINOR_DIGITS` | `0` for MMK; decides how minor units are rendered |
| `TZ_OFFSET_MINUTES` | fixed offset, e.g. `390` |

The web app does **not** mirror these as build-time `VITE_*` values. It reads them from
the API in the session bootstrap and caches them, so there is one copy and it cannot
drift. Nothing renders money or a time before the caller is authenticated, so there is
no first-paint problem. `formatMoney` in `shared/` and `format_money` in `api/core/` take
the currency as a **parameter** rather than closing over a constant, which is also what
keeps their twin tests honest.

---

## Auth

`identity.rs` is reused unchanged. The token carries two claims:

1. **Device.** An admin mints a claim link per tablet — `scripts/bootstrap-link.mjs` for
   the first one, the backoffice for the rest — and opening it on the tablet redeems the
   nonce and sets the 90-day cookie. The nonce is a DB row, not a signed token, for the
   reasons futsal's migration 0004 gives: single-use is a delete, and minting one needs
   no secret.
2. **Staff.** `POST /staff/switch { pin }` on an already-claimed device re-mints the
   token with `staff_id` added. Routes read both claims. The waiter's name on the ticket
   comes from `staff_id`, not from the device.

PINs are 4 digits, stored as `HMAC-SHA256(AUTH_SECRET, staff_id || pin)` — a keyed hash,
so a leaked database is not a list of 10,000 guesses per member of staff. RustCrypto's
`hmac`/`sha2` are already in the dependency tree for `identity.rs`, so this adds nothing.

**A 4-digit PIN is not a security boundary against outsiders and must not be described as
one.** It distinguishes staff on a device that has already been claimed; the device
cookie is what keeps strangers out. Note it under Known limitations in the README.

---

## Realtime, and the free-tier budget

The design is bounded by one number: `@upstash/realtime`'s SSE handler publishes a
keepalive **every 10 seconds per open connection** — 360 Redis commands per
connection-hour, not configurable from outside the library. (futsal README, *Upstash
Redis — the tight one*; the interval is `KEEPALIVE_INTERVAL_MS` in
`api/src/realtime.rs`.) Upstash's free tier is 500,000 commands a month.

So:

- **Only the cashier page subscribes.** One channel: `restaurant`.
- **Waiter tablets never subscribe.** They fetch the table's check when the table is
  opened. A waiter is looking at one table at a time and has just caused the change they
  are looking at.
- **The printer agent never subscribes.** It polls `GET /print-jobs?status=pending`
  and acks with `POST /print-jobs/:id/{printed|failed}`. Unacked jobs stay
  pending, which is what makes an agent restart or a power cut self-healing.
  The cadence is a ladder, not a constant: 3 s while tickets are moving, 10 s
  after five minutes of nothing, 30 s after thirty, and back to 3 s on any job.
  Subscribing would move the cost from Worker requests (100,000 a *day*) to
  Upstash commands (500,000 a *month*, billed 360/hour for silence), which is
  spending the scarce budget to save the abundant one.
- **Cashier polling fallback is 5 s**, not the reference's 30. A cashier waiting on a
  table's total is a person standing still.
- **Cashier stream idle timeout is 4 h**, not the reference's 5 minutes. Page-hidden still
  closes the stream immediately, which is the rule that actually matters: a locked tablet
  or a switched app costs nothing.

Where that lands, for a 12-hour service day:

| | Commands |
| --- | --- |
| Cashier stream open all service | 12 × 360 = 4,320 / day ≈ 130,000 / month |
| 60 checks × (opened + 3 rounds + paid) × 3 commands | 900 / day ≈ 27,000 / month |
| 180 print-job events × 3 commands | 540 / day ≈ 16,200 / month |
| **Total** | **≈ 173,000 / month, ~35% of the free tier** |

One event costs 3 commands (`XADD` + `EXPIRE` + `PUBLISH`); a client connecting costs 1
(`XREVRANGE` replay). The 4-hour idle timeout is worth 1,440 commands before it gives up,
which is the price of not making the cashier reconnect during a quiet afternoon.

Workers' 100,000 requests/day is not a constraint: the agent is about 17,000 a day on
the ladder above (28,800 if it ever went flat out at 3 s around the clock), the
cashier's fallback is 8,640 and its stuck-queue check 2,880, with the waiter tablets in
the hundreds. D1's
100,000 rows written/day is not either — a whole check is about 20 rows.

> Free-tier limits change. These were correct when written; check the current Cloudflare
> and Upstash pricing pages before relying on them.

### Seam rules — do not lose these

- **`emit` never fails.** The D1 write has already committed and clients poll as a
  backstop, so a Redis failure is logged and swallowed, never turned into a 500.
- **`subscribe` gets the original `Request`.** Teardown hangs off `request.signal`;
  rebuilding the request leaks a Redis subscription every time a client navigates away.
- **No Upstash credentials means polling**, not an error. `wrangler dev` works with no
  cloud resources at all, and that is not an accident to be optimised away.

### Events

`shared/src/events.ts`. Payloads are **self-sufficient**: a client applies one to local
state without a follow-up request. That is the whole point — a round trip per event would
spend the budget this design exists to protect.

```
check.opened      { checkId, tableId, staffName, at }
round.sent        { checkId, roundId, seq, items[], checkTotal, at }
round.delivered   { checkId, roundId, at, outstandingRounds, oldestOutstandingAt,
                    oldestOutstandingTargetMinutes }
item.voided       { checkId, itemId, checkTotal, at }
check.paid        { checkId, tableId, method, at }
print_job.failed  { jobId, roundId, tableId, error, at }
print_job.printed { jobId, roundId, at }
```

It was six and is now seven. `round.delivered` is the only one recorded by a person
rather than caused by one — every other event here is the consequence of a tap that
also did something else — and it earns its place because the cashier's board counts
what is still out, which without it would only correct itself on a reconnect. Its
payload carries **absolute** state rather than a decrement, which is also what
self-heals a count that drifted while a stream was down.

The channel allowlist in `routes/realtime.rs` is exactly `restaurant` — the reference's
`is_subscribable` exists to stop a crafted `channels` value naming an arbitrary Redis
key, and that reason does not go away just because there is only one channel.

---

## Printer agent

One TypeScript file plus a config. It polls the Worker with the device token and prints
ESC/POS to a network printer on TCP 9100 (host from config).

- **Ticket:** round number, table, time, waiter, items with qty and note. Large font.
- **Void ticket:** a `VOID` header, then the items.
- Exponential backoff on failure; `failed` after 3 attempts, with `last_error` recorded
  so the cashier's banner can say what went wrong.

What a ticket *says* is pure logic and therefore lives twice — `shared/src/ticket.ts` and
`api/core/src/ticket.rs`, same cases both sides. What it *is* on the wire (ESC/POS bytes)
belongs to the agent alone.

### Printing by hand

The agent is the normal path, but a shop can open before it is set up, so every **sent
round** carries a Print ticket control on both the waiter's table view and the cashier's
check. It renders the same `renderTicket` output into a hidden `<Portal>`
(`web/src/components/PrintSheet.tsx`) and calls `platform.print()`; `@media print` in
`styles.css` hides `.app` and shows `.print-sheet`. The ESC/POS path is untouched.

Three rules, and they are the same rules the agent obeys:

- **Per round, never per check.** The kitchen has already cooked the earlier rounds.
- **No auto-print on Send.** A browser print dialog cannot be suppressed, and one that
  opens by itself mid-order is worse than no printing. Send, then Print, as two taps.
- **A hand print acks the queued job** — `POST /print-jobs/by-round/:id/printed`, which
  matches only a `pending` `ticket` job for that round. Printing twice, or printing one
  the agent already took, is a no-op and not an error, so the two paths can coexist
  without the kitchen getting the same ticket on paper twice.

`PrintSheet`'s `WORDS` is the browser's copy of the agent's `WORDS` in `agent/src/index.ts`
— English only, because a kitchen ticket is read by the kitchen and not by the tablet's
owner. Changing one means changing the other.

Void slips have no manual path. They exist to tell a kitchen that already has paper in
hand, so a slip nobody is standing at the printer to receive is not worth the control.

---

## UX requirements

These are requirements, not suggestions.

### Waiter — landscape tablet first, portrait supported

- **Two panes**: tables grid left, current table right.
- Right pane: category chips, then product tiles — **minimum 100×100 px**, name and
  price, the **whole tile tappable**, with a pressed state.
- A **persistent cart below**, not behind an icon: `−  qty  +` per line, an optional note
  per line, the total, and one **Send to kitchen** button. No cart icon, no separate
  review screen, **no "are you sure" on send**.
- An occupied table shows its open check — rounds and total — with **Add items**.
- Every round that is still out shows **how long is left of what was promised**, so a
  waiter can answer "how long will it be" without guessing, and a **Delivered** button
  that stops that round's clock. A table's tile carries the oldest outstanding round's
  countdown, and goes **red** once it is five minutes past — which is the one thing on
  that grid a waiter has to see from across a room without looking for it.
- The draft cart persists in `localStorage` **per table**. On connection loss, show a
  banner with Retry and never lose the draft. No offline sync in V1.
- Touch targets ≥ 48 px. Nothing hover-only. No drag-and-drop. Confirmation only for
  clear-cart and void.

### Cashier

Open checks as large cards by table with totals. Opening a check shows its items; from
there: void an item, take payment (cash/card/other), close. A **red banner when print
jobs fail**, with a Retry that re-queues them, and an **amber one when nothing has
printed for two minutes** — a job is only `failed` once the agent has *tried* it, so an
agent whose machine is switched off leaves every ticket `pending` and the red banner
silent.

It is also the **one screen in the app that makes a noise**: a short ping on
`round.sent`, from `/sounds/new-order.mp3`, with an on/off remembered per device. The
till is always on and at a counter; waiter tablets are carried between tables and stay
silent, which is what the platform seam's note about a dining room was really about.

### Backoffice

Products, categories, tables, staff and PINs, device claim links, and today's sales
total. Desktop width is fine here, but it must still work by touch.

---

## The twin-logic rule

Rust cannot import a TypeScript module, so every pure rule is written **twice** —
`shared/` for the browser, `api/core/` for the Worker — and the two are kept in step by
**the same test cases on both sides**. A rule that changes has to change in two places and
prove itself twice.

Today that covers money, the fixed-offset clock, check totals, ticket rendering and how
long a round should take — `money.rs`/`money.ts`, `clock.rs`/`time.ts`,
`totals.rs`/`totals.ts`, `ticket.rs`/`ticket.ts` and `timing.rs`/`timing.ts`. Anything
else that is a rule rather than plumbing joins them.

The timing pair is the one **partial** twin, and deliberately: only
`round_target_minutes` exists on both sides, because only both sides compute it. The
"is it late" half is a function of the current second, evaluated in a browser on a
timer, and a Rust copy nothing called would be dead code in a crate whose whole
discipline is that it holds rules somebody could be shown on paper. Both files say so
where the seam is.

`api/core/` must not depend on `worker`, `wasm-bindgen` or the host, so `cargo test` runs
it natively.

---

## Conventions

Match the reference's code style, comment style and naming. Concretely:

- **Comments explain *why*, at length, and are part of the deliverable.** The reference
  spends a paragraph on a non-obvious choice and one line on an obvious one. A file that
  reads like generated code is wrong even if it works.
- **SQL text is copied character for character** where it is ported, and formatted the
  same way where it is new: the queries are the contract with the database, and a
  reformatted one is a different thing to read against a `wrangler d1` console at
  midnight.
- **Field order is output order.** A mapped struct's fields are declared in the order the
  JSON should have, not the order the columns came in.
- **One error envelope**: `{"error":{"code":"…","message":"…"}}`, `code` before
  `message`, from `http.rs`. Nothing leaves the Worker with an error status any other
  way.
- **Ids** are `new_id(prefix)` — a prefix, one underscore, 20 hex characters. Prefixes
  here: `stf_`, `dev_`, `tbl_`, `cat_`, `prd_`, `chk_`, `rnd_`, `itm_`, `pay_`, `job_`.
- **Deleting is soft.** `active = 0` on products, categories, tables and staff; past
  checks keep their meaning. Voiding an item is likewise a flag, never a delete.
- **English is the source of truth** in `i18n/`. Other catalogues are typed as
  `typeof en`, so a missing key is a build error. Strings that need values are functions,
  not templates with placeholders.
- **Every browser-only API goes through `platform/`.** Components never touch `window`,
  `document`, `localStorage`, `navigator` or `EventSource` directly.
- **Every network call goes through `web/src/api/`.** No component builds a URL.
- **Destructive actions go through a confirm dialog naming the consequence.** That was
  clear-cart and void when this was written; it is now five, all through the same
  `ConfirmButton`, because a screen where one control asks and the one beside it does
  not is a screen where nobody learns which taps are safe. The other three are
  discarding an unconfirmed send, retiring a catalogue row, and signing a tablet out
  from the backoffice.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + frontend together |
| `npm run typecheck` | `shared/`, `web/`, `agent/` |
| `npm run check` | the above, then `cargo check` the Worker for wasm32 |
| `npm test` | pure-logic tests both sides, TypeScript and Rust; no servers |
| `npm run db:migrate:local` | apply migrations locally |
| `npm run db:seed:local -w @pos/api` | the bootstrap rows |
| `npm run claim:bootstrap -w @pos/api -- <deviceId> --local` | mint a device claim link |

`npm run check` and `npm test` **must pass at the end of every milestone.**

Local development needs no cloud resources: `wrangler dev` runs D1 on the machine, and
without Upstash credentials realtime falls back to polling.

---

## V1 scope

Nothing beyond this.

- **Waiter:** claim device → PIN → tables → cart → send → ticket prints.
- **Cashier:** live open checks → void → pay → close → printer failure banner.
- **Backoffice:** the six lists above.

**Out of scope:** split payments, discounts, modifiers beyond free-text notes, table
transfer/merge, kitchen display, offline sync, reports beyond the daily total,
multi-restaurant.

---

## Milestones

Each one ends with `npm run check` and `npm test` passing, and with a stop for review.

0. **Scaffold.** Monorepo, copied skeleton, `0001_init.sql`, seed, device claim, staff PIN
   switch, `npm run dev` working end to end against `wrangler dev` with no cloud
   resources.
1. **Catalogue.** Products / categories / tables API, plus the backoffice screens for
   them.
2. **Waiter.** The waiter page, rounds, and print jobs.
3. **Cashier.** The cashier page, realtime, payments.
4. **Agent.** The printer agent.
5. **PWA polish.** Manifest, icons, service worker, install.
