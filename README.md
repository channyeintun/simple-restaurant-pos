# Simple Restaurant POS

A point-of-sale for **one** restaurant: a few waiter tablets, one cashier
tablet, one kitchen printer, one backoffice screen. A waiter takes an order at
the table, taps **Send to kitchen**, and a ticket comes out of the printer by
the pass. The cashier sees the open checks fill up, voids what was sent by
mistake, takes the money and closes the table.

It runs entirely on free tiers — Cloudflare Workers, D1, Pages, and Upstash
Redis — so the running cost of the whole thing is zero. That is not a boast; it
is the constraint the design is bounded by, and most of the interesting
decisions in here are downstream of one number. See
[Staying inside the free tiers](#staying-inside-the-free-tiers).

Prices are in kyat and the clock is Myanmar time, both read from the Worker
rather than compiled into the app. The interface is English and Burmese
(မြန်မာ).

**What it expects to be called**

| | |
| --- | --- |
| App | Cloudflare Pages project `restaurant-pos` |
| API | Worker `restaurant-pos-api` |
| Database | D1 `restaurant-pos` |
| Realtime | Upstash Redis, optional — without it everything polls |
| Currency | `MMK` / `Ks` / 0 minor digits, from `wrangler.jsonc` `vars` |
| Clock | `TZ_OFFSET_MINUTES=390` — UTC+06:30, no DST |
| Printer | ESC/POS on TCP 9100, on the restaurant's own LAN |

Getting in is by device claim link, then a staff PIN. See
[Getting in](#getting-in).

---

## What it is

- **Waiter tablets.** Tables on the left, the current table on the right:
  category chips, product tiles big enough to hit without looking, and a cart
  that is always on screen rather than behind an icon. One button sends it to
  the kitchen. The draft cart is kept per table in the tablet's own storage, so
  a dropped connection is a banner with a Retry on it and not a lost order.
- **One cashier tablet.** Every open check as a card with its total, updating
  live. Open one to void a line, take cash, card or other, and close the table.
  A red banner when a ticket fails to print, with a Retry that re-queues it.
- **One kitchen printer.** A round — one tap of Send — is exactly one ticket,
  printing only that round's items. Nothing ever reprints the whole check: the
  kitchen has already cooked the first half of it.
- **A backoffice screen.** Products, categories, tables, staff and their PINs,
  device claim links, and today's takings.
- **A printer agent** on a PC in the shop. Cloudflare cannot open a socket to a
  printer on somebody's LAN, so a small node process asks the Worker every three
  seconds whether anything needs printing.

Milestone 0 is the scaffold: the schema, the auth, and `npm run dev` working end
to end. [Status](#status) says what is actually built.

---

## Layout

```
simple-restaurant-pos/
├── shared/      types, zod schemas, and pure helpers the web app is built on
│   ├── models.ts     domain models + request validation
│   ├── events.ts     the six realtime events, defined once
│   ├── money.ts      integer minor units, no floats
│   ├── time.ts       fixed-offset local time
│   ├── ticket.ts     what a kitchen ticket says, as data
│   └── i18n/         message catalogues; English is the source of truth
├── api/         Rust on Cloudflare Workers
│   ├── core/         the pure crate: money, ticket, totals, clock
│   ├── migrations/   versioned D1 SQL
│   └── src/routes/
├── web/         Solid + Vite + Material Design 3, on Cloudflare Pages
│   ├── api/          every fetch call in the app
│   ├── platform/     every browser-only API in the app
│   ├── public/       manifest, service worker, icons
│   └── pages/        /waiter/*, /cashier/*, /backoffice/*
└── agent/       the printer agent: Node + TypeScript, runs on the restaurant LAN
```

The Worker is Rust; the web app is TypeScript. Rust cannot import a TypeScript
module, so every pure rule the two sides share — how money is written, what a
check adds up to, what a ticket says — is written twice: `shared/` for the
browser, `api/core/` for the Worker. They are kept in step by the same test
cases run on both sides, so a rule that changes has to change in two places and
prove itself twice. `api/core/` does not depend on `worker` or `wasm-bindgen`,
which is what lets `cargo test` run it natively.

`web/src/platform/` is where every browser-only API lives — storage, the event
stream, navigation, visibility. Components never touch `window`, `localStorage`
or `EventSource` directly, which keeps the awkward parts in one reviewable file
and makes the tablet-specific behaviour testable.

---

## Local development

Prerequisites: Node 20+ and a Rust toolchain with the `wasm32-unknown-unknown`
target. **Local development needs no cloud resources at all** — `wrangler dev`
runs D1 on your machine, and without Upstash credentials realtime simply is not
there.

```bash
rustup target add wasm32-unknown-unknown
```

`worker-build` is fetched by `wrangler dev` and `wrangler deploy` on the first
run; nothing else is needed to compile the Worker.

```bash
npm install
```

```bash
cp api/.dev.vars.example api/.dev.vars
```

Create the local database and put a floor in it — one manager, one tablet, five
tables, three categories and eight products:

```bash
npm run db:migrate:local
```

```bash
npm run db:seed:local -w @pos/api
```

Run both halves:

```bash
npm run dev
```

The API is on `http://localhost:8787` and the app on `http://localhost:5173`.
Vite proxies `/api` to the Worker, so everything is same-origin in development
and there is no CORS to think about.

A tablet gets in by redeeming a claim link, so mint one against the seeded
device:

```bash
npm run claim:bootstrap -w @pos/api -- dev_counter --local
```

Open the URL it prints. That claims the device and leaves you on the PIN screen.

**The seeded manager has no PIN yet**, and cannot be given one from here: the
hash is keyed with `AUTH_SECRET`, which lives in the Worker's secrets and
deliberately never leaves them, so `seed.sql` stores `NULL` rather than a digest
it would have to guess the encoding of. Setting a PIN is a backoffice screen, in
milestone 1. Until then a claimed device is as far as this goes.

Realtime is **off** by default locally. Without `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` the cashier page polls every 5 seconds instead, which
is a perfectly good way to develop and costs nothing but Worker requests.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + frontend together |
| `npm run typecheck` | `shared/`, `web/`, `agent/` |
| `npm run check` | The above, then `cargo check` the Worker for wasm32 |
| `npm test` | Pure-logic tests both sides, TypeScript and Rust (no servers needed) |
| `npm run db:migrate:local` | Apply migrations locally |
| `npm run db:migrate:remote` | Apply migrations to the deployed D1 |
| `npm run db:seed:local -w @pos/api` | The bootstrap rows |
| `npm run claim:bootstrap -w @pos/api -- <deviceId> --local` | Mint a device claim link |

---

## Deployment

### 1. Create the database

```bash
npx wrangler d1 create restaurant-pos
```

Copy the `database_id` it prints into `api/wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 2. Apply migrations to the real database

```bash
npm run db:migrate:remote
```

Then put something in it. The seed is `INSERT OR IGNORE` throughout and safe to
run twice, but read it first — it creates a manager called "Manager" and a
tablet called "Counter tablet", and you probably want your own names. From
`api/`:

```bash
npx wrangler d1 execute restaurant-pos --remote --file=./seed.sql
```

### 3. Set the secrets

```bash
npx wrangler secret put AUTH_SECRET
```

Something long and random — `openssl rand -base64 32`. This one key signs the
identity tokens **and** keys the staff PIN hashes, so changing it later signs
every tablet out and stops every PIN matching. Set it once per environment and
leave it alone.

Optional, for realtime. Create a free Redis database at
[console.upstash.com](https://console.upstash.com) and set both:

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
```

```bash
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Leave them unset and the cashier page polls instead. Nothing else changes, and
nothing else in the app notices.

### 4. Deploy the Worker

```bash
npm run deploy:api
```

Note the URL it prints (`https://restaurant-pos-api.<subdomain>.workers.dev`).

### 5. Deploy the frontend

```bash
cp web/.env.example web/.env.production
```

Set `VITE_API_URL` to the Worker URL, then:

```bash
npm run deploy:web
```

Use `.env.production`, not `.env.local`. Vite reads `.env.local` in *every* mode
including `vite dev`, which would quietly point your local dev server at the
deployed API — which here means a laptop typing orders into the real
restaurant's database.

That is the only build-time value the frontend has. The currency and the
timezone are **not** mirrored as `VITE_*` vars: the app reads them from
`GET /auth/me` once per session, so there is one copy of them and it lives in
`wrangler.jsonc`.

### 6. Close the loop on CORS

Set `WEB_ORIGIN` and `APP_URL` in `api/wrangler.jsonc` to the deployed Pages URL
and redeploy the Worker. Until you do, the browser refuses the cross-origin
requests and every claim link points at the wrong host.

### Same-origin (recommended if you have a domain)

Put both behind one hostname — Pages on `pos.example.com` and a Worker route on
`pos.example.com/api/*` — and you avoid CORS entirely and the auth cookie
becomes first-party, which is strictly better on an iPad. Set
`VITE_API_URL=/api` in that case.

### The printer agent

Nothing deploys the agent; it runs inside the restaurant, on the same network as
the printer. Copy `agent/agent.config.example.json` to `agent.config.json` —
git-ignored, because it holds a device token and the address of a printer on
somebody's LAN — fill in the Worker URL, a token and the printer's address, and
run `npm start -w @pos/agent`. The token is an ordinary device credential: add a
device for the kitchen in the backoffice, mint its claim link, redeem it, and
copy the token out.

It needs Node 22.6+ there, because it runs its TypeScript directly rather than
building anything — the process in the restaurant should be a file somebody can
open and read when it misbehaves. It is milestone 4, so today it validates its
config, says what is missing and exits rather than pretending to print.

---

## Staying inside the free tiers

The design is bounded by one number: **the realtime keepalive**.
`@upstash/realtime`'s SSE handler publishes a keepalive **every 10 seconds per
open connection** — 6 a minute, 360 Redis commands per connection-hour — and it
is not configurable from outside the library. (It is `KEEPALIVE_INTERVAL_MS` in
`api/src/realtime.rs`, and the reference app's README covers it under *Upstash
Redis — the tight one*.) Upstash's free tier is 500,000 commands a month.

360 an hour is affordable once and ruinous four times over, so:

- **Only the cashier page subscribes.** One channel, named `restaurant`.
- **Waiter tablets never subscribe.** A waiter is looking at one table at a
  time, and has just caused the change they are looking at. Opening a table
  fetches its check.
- **The printer agent never subscribes.** It polls every 3 seconds, which costs
  Worker requests — a tier with enormous headroom — and zero Redis commands.
- **The cashier's polling fallback is 5 seconds.** A cashier waiting on a
  table's total is a person standing still.
- **The cashier's stream idles out after 4 hours**, not the reference's 5
  minutes. The rule that actually matters is the other one: page hidden closes
  the stream immediately, so a locked tablet or a switched app costs nothing.

Where that lands, for a 12-hour service day:

| | Commands |
| --- | --- |
| Cashier stream open all service | 12 × 360 = 4,320 / day ≈ 130,000 / month |
| 60 checks × (opened + 3 rounds + paid) × 3 commands | 900 / day ≈ 27,000 / month |
| 180 print-job events × 3 commands | 540 / day ≈ 16,200 / month |
| **Total** | **≈ 173,000 / month, ~35% of the free tier** |

One event costs 3 commands (`XADD` + `EXPIRE` + `PUBLISH`); a client connecting
costs 1 (`XREVRANGE` replay). The 4-hour idle timeout is worth 1,440 commands
before it gives up, which is the price of not making the cashier reconnect
during a quiet afternoon.

**Workers — 100,000 requests/day.** Not a constraint. The agent's 3-second poll
is 14,400 over a service day and the cashier's fallback is 8,640, with the
waiter tablets in the hundreds.

**D1 — 5 GB, 5M rows read/day, 100k rows written/day.** Not a constraint either:
a whole check — opened, three rounds, a dozen items, a payment, the print jobs —
is about 20 rows.

**Pages — 500 builds/month.** Only relevant if CI deploys on every push.

If usage ever did approach the Upstash limit, the cheapest lever is the
cashier's idle timeout, and the next is swapping the pub/sub module for Durable
Object WebSockets, which the `PubSub` seam is shaped for.

> Free-tier limits change. These were correct when written; check the current
> Cloudflare and Upstash pricing pages before relying on the numbers.

---

## How a few things work

### Checks and rounds

A **check** is one table seating. It opens on the first send and closes when it
is paid; `table_id` is NULL for takeaway and the counter. A table may have at
most one open check, and that rule lives in the database as a partial unique
index rather than in a route — two waiters tapping Send on the same table at the
same instant is a race a `SELECT` then `INSERT` loses.

A **round** is one tap of Send to kitchen, and one round is exactly one kitchen
ticket printing **only that round's items**. The alternative — reprinting the
check each time — hands the kitchen a piece of paper that is half things they
already cooked, and the first time somebody works to it twice you have paid for
the convenience in food.

Items **snapshot** their name and price at send time. The bill and the ticket
must not change because somebody edited a product in the backoffice while the
table was eating.

Voiding is never a delete: `voided_at` and `voided_by` are set, the row stays,
and if the round had already been sent a `void` print job goes to the kitchen —
because the last piece of paper they were handed says to cook it, and they need
telling in the same physical way.

### Money

Amounts are **integer minor units**, everywhere, on both sides. There are no
floats in this repo and adding one would be a defect rather than a shortcut: a
float is a rounding error looking for a bill to land on.

For MMK, `CURRENCY_MINOR_DIGITS` is 0, so a minor unit *is* a kyat and the
integers in the database are the numbers on the bill. The currency's code,
symbol and digits are wrangler `vars`, and `formatMoney` in `shared/` and
`format_money` in `api/core/` take them as a parameter rather than closing over
a constant — which is what keeps the twin tests honest, and what makes moving
this POS to a two-decimal currency a config change rather than an audit.

### Time

Every timestamp crossing the API is an ISO-8601 UTC instant. Display and the
service-day arithmetic use a **fixed offset** from `TZ_OFFSET_MINUTES`, not a
timezone database: one restaurant, one offset, no DST within a thousand miles of
it. The var is in **minutes** because Myanmar is UTC+06:30 and half an hour does
not fit in a count of hours — the same reason it is not called `TZ_OFFSET_HOURS`
anywhere in the codebase.

### Getting in

Two credentials, and they protect different things.

**The device claim link** is what keeps strangers out. An admin mints one per
tablet — `scripts/bootstrap-link.mjs` for the first one, the backoffice for the
rest — and opening it on the tablet redeems the nonce and sets a 90-day cookie.
The nonce is a random value looked up in the `devices` table rather than a signed
token: single-use is then a delete, minting one needs no secret, and the
bootstrap script can therefore live on a laptop without `AUTH_SECRET` on it. It
travels in the URL fragment, which browsers never send to a server, so it stays
out of access logs and `Referer` headers.

**The staff PIN** is what tells Aung from Su on a tablet they share. `POST
/staff/switch { pin }` on an already-claimed device re-mints the token with the
staff id added, so the waiter's name on the ticket and the staff id on the
payment are the right ones. PINs are stored as `HMAC-SHA256(AUTH_SECRET,
staff_id || pin)` — keyed, so a leaked database is not a list of 10,000 guesses
per member of staff, and salted by the staff id, so two people who pick the same
four digits do not collide.

A tablet is cut off by bumping `devices.token_version`, which invalidates every
token it holds; that deliberately does not stop a new claim link working, because
the tablet you just cut off is usually the one you are about to re-issue.

`EventSource` cannot send an `Authorization` header, so the cashier's stream
takes a two-minute, stream-only ticket in its query string instead of the
long-lived token.

---

## Known limitations

- **A claim link is a bearer credential.** Whoever opens it first becomes that
  tablet. Read it out to the person holding the tablet, not to a group chat. It
  works once and expires in 7 days.
- **A 4-digit PIN is not a security boundary against outsiders**, and nothing
  here should describe it as one. Ten thousand possibilities is a lunchtime's
  work. It distinguishes staff on a device that has already been claimed; the
  device credential is what keeps strangers out, and the PIN screen is not
  reachable without it.
- **No offline sync in V1.** A tablet that loses its connection keeps its draft
  cart — per table, in the tablet's own storage — and shows a banner with a
  Retry. It does not queue sends to replay later: an order accepted by a tablet
  that cannot reach the kitchen is a promise the software cannot keep.
- **Deleting is always soft.** Products, categories, tables and staff are
  deactivated, never removed, so last month's checks keep meaning what they
  said.
- **The realtime keepalive is the library's, not ours.** If Upstash usage ever
  becomes a problem, the cashier's idle timeout is the first knob and the
  `PubSub` interface is the escape hatch.
- **A kitchen ticket is printed in English, whatever the tablets are set to.**
  The five words on a slip — ROUND, VOID, TAKEAWAY, TABLE and the waiter's line
  — live in `agent/src/index.ts` rather than in `shared/src/i18n/`, and they are
  English because a thermal printer's built-in character set has no Myanmar
  glyphs: a Burmese header prints as a row of boxes. Dish names come from the
  menu and are printed exactly as the manager typed them, so a Burmese menu will
  print as boxes too. The fix is a printer that can be driven in raster mode,
  which is a different agent and not V1.
- **The Burmese is unreviewed by a native speaker.** English is the source of
  truth in `shared/src/i18n/`, and every other catalogue is typed as `typeof en`
  so a missing key is a build error — but a key that is present and awkward is
  not something a compiler can catch.

---

## Status

**Milestone 0 is done**: the monorepo, the copied skeleton, `0001_init.sql` and
the seed, device claim, staff PIN switch, and `npm run dev` working end to end
against `wrangler dev` with no cloud resources. The API surface is `/health`,
`/auth/*`, `/staff/*` and `/realtime/*`, and nothing else yet.

What is still to come:

| | |
| --- | --- |
| 1 | Catalogue — products, categories and tables, and the backoffice screens for them |
| 2 | Waiter — the two-pane page, the cart, rounds, and print jobs |
| 3 | Cashier — live open checks, voids, payments, the printer failure banner |
| 4 | Agent — ESC/POS on the LAN, and the ticket it prints |
| 5 | PWA polish — manifest, icons, service worker, install |

`npm run check` and `npm test` pass at the end of every one of them.
