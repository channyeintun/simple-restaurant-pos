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
| App | Cloudflare Pages project `pannuyaung` |
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
- **Print ticket**, on every sent round, on both the waiter and the cashier.
  The agent is the normal path and this is not a replacement for it, but a shop
  that has not set the agent up yet — or has, and it is down — can still get
  paper to the pass from whatever the tablet can print to. See
  [Printing by hand](#printing-by-hand).

All six milestones are in: a waiter sends rounds, the cashier settles them over
a live stream, the agent prints them, and the whole thing installs on a tablet.
[Status](#status) has the route table, and says what the tests cover and what is
only ever exercised by hand.

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

Prerequisites: Node 22.6+ and a Rust toolchain with the `wasm32-unknown-unknown`
target. 22.6 rather than 20 because the printer agent runs its TypeScript
directly — `node --experimental-strip-types`, no build step — and `npm test`
runs the agent's suite the same way, so an older Node fails the tests rather
than the app. **Local development needs no cloud resources at all** — `wrangler dev`
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
it would have to guess the encoding of.

Setting a PIN is a backoffice screen — but the backoffice is behind the admin
role, and the only admin on a fresh database is the one with no PIN. That door
is locked from the inside, so there is a script for it:

```bash
npm run pin:set -w @pos/api -- stf_admin 1234 --local
```

It reads `AUTH_SECRET` out of `api/.dev.vars` and writes the hash exactly the
way `identity::pin_hash` does — whatever writes a PIN has to build it the way
the keypad checks it, or the right four digits are wrong forever. After that the
seeded owner signs in on the PIN screen and everything else is set from the
backoffice.

With a PIN set the whole loop runs locally: tables, cart, Send, the cashier's
board, the backoffice lists. The one thing the dev server cannot do by itself is
print — a Send writes a `print_jobs` row and leaves it `pending`, and nothing
drains that queue until the agent is running. See
[Checking it without a printer](#checking-it-without-a-printer) for doing that
with `nc` instead of a printer.

Realtime is **off** by default locally. Without `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` the cashier page polls every 5 seconds instead, which
is a perfectly good way to develop and costs nothing but Worker requests.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + frontend together |
| `npm run typecheck` | `shared/`, `web/`, `agent/` |
| `npm run check` | The above, then `cargo check` the Worker for wasm32 **and** `cargo test` both Rust crates |
| `npm test` | All four suites — shared, web, agent, Rust. No servers needed |
| `npm run db:migrate:local` | Apply migrations locally |
| `npm run db:migrate:remote` | Apply migrations to the deployed D1 |
| `npm run db:seed:local -w @pos/api` | The bootstrap rows |
| `npm run claim:bootstrap -w @pos/api -- <deviceId> --local` | Mint a device claim link |
| `npm run pin:set -w @pos/api -- <staffId> <pin> --local` | Set a PIN — the only way to give the seeded admin one |

---

## Deployment

### 1. Create the database

```bash
npx wrangler d1 create restaurant-pos
```

Copy the `database_id` it prints into `api/wrangler.jsonc`, over the
`database_id` already in the `d1_databases` block — it holds the id of the
database this repo was developed against, which is not yours.

### 2. Apply migrations to the real database

```bash
npm run db:migrate:remote
```

Then put something in it. The seed is `INSERT OR IGNORE` throughout and safe to
run twice, but read it first — it creates an admin called "Owner" and a tablet
called "Counter tablet", and you probably want your own names. From
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

Nothing deploys this one. It runs **inside the restaurant**, on the same network
as the printer, and it is the only part of the system that does — which is the
whole reason it exists. Cloudflare cannot open a socket to a printer behind
somebody's router and the printer cannot call Cloudflare, so the direction is
reversed: the agent polls the Worker for pending jobs and prints what it is
given.

Deploying the Worker and the frontend therefore does **not** get the kitchen
printing. Five things have to be true in the building.

**1. A printer that speaks ESC/POS over TCP 9100.** An Ethernet or Wi-Fi model —
Epson TM-T20/TM-T88, Xprinter, Rongta and most units sold as a "network POS
printer" all do. A **USB-only printer will not work**, because the agent opens a
socket rather than driving a print queue; there is no fallback path for one.

The ticket layout assumes **80mm paper**, which is 42 characters across. 58mm
paper is 32, so long dish names wrap more; nothing breaks, it is just tighter.

**2. A fixed address for it.** Give the printer a static IP, or a DHCP
reservation on the router. Most printers print their current address on a
self-test page if you hold FEED while switching them on. A printer whose address
moves is a kitchen that stops printing on a Tuesday for no visible reason.

**3. A machine to run the agent on.** Anything always-on and on the same LAN: a
mini PC, a Raspberry Pi, the backoffice computer. It needs **Node 22.6+**,
because the agent runs its TypeScript directly rather than building anything —
the process in a restaurant should be a file somebody can open and read when it
misbehaves.

If that machine is off, nothing is lost: an unacked job stays `pending`, and the
agent prints the backlog when it comes back. But nothing prints while it is off,
and a job nobody has *tried* to print is not a failed job, so the red banner
stays quiet. The cashier's screen has a second, quieter warning for exactly this
— an amber line once the oldest unprinted ticket has been waiting two minutes,
which with the agent running never happens, because a dead printer resolves to
`failed` in about twenty seconds. It still wants to be a machine nobody switches
off at night.

**4. A device token.** The agent holds an ordinary device credential, exactly
like a tablet's — there is no separate machine identity, because a printer agent
*is* a device: something in the building the restaurant trusts and can cut off in
one place. Bumping `token_version` from the backoffice stops it dead, the same
way it stops a lost tablet.

Add a device for the kitchen in the backoffice and mint its claim link. A tablet
would open that link in a browser; the agent has no browser, so redeem it for a
token directly:

```sh
# The nonce is the part of the claim URL after the '#'.
curl -sX POST https://<your-worker>.workers.dev/auth/claim \
  -H 'Content-Type: application/json' \
  -d '{"nonce":"PASTE_THE_NONCE_HERE"}'
```

The reply is `{"token":"…","identity":{…}}`. Take the `token`. The link is
single-use and is spent by that call, so if you also open it in a browser one of
the two will fail — mint a second link if you need both.

**5. Put the agent on it.** You do **not** need to clone this repo, and you do
not need `npm install`. The agent is one TypeScript file that imports nothing
but `node:` builtins — `fs`, `net`, `timers`, `path`, `url` — so the whole
install is a file, a config beside it, and node.

```sh
# On the machine that will drive the printer. Node 22.6+ is the only prerequisite.
mkdir -p ~/pos-printer && cd ~/pos-printer

curl -O https://raw.githubusercontent.com/channyeintun/simple-restaurant-pos/main/agent/src/index.ts

cat > agent.config.json <<'JSON'
{
  "apiUrl": "https://restaurant-pos-api.chanyeintun.workers.dev",
  "deviceToken": "PASTE_THE_TOKEN_FROM_STEP_4",
  "printerHost": "192.168.1.50",
  "printerPort": 9100
}
JSON

node --experimental-strip-types index.ts
```

That is the whole of it. It prints what it is configured with, then polls: a
ticket logs one line, a failure logs the printer's own words.

Cloning the repo works too and is the better choice if you want `git pull` to
update it — but it brings a Rust toolchain's worth of workspace onto a machine
whose only job is to copy bytes to a socket. Two files is the smaller thing to
go wrong at eight in the evening, and updating is the same `curl` again.

The config is not in this repository and must not be: it holds a device token
and the address of a printer on somebody's LAN. `agent/agent.config.example.json`
is the committed copy of its shape, and `agent/agent.config.json` is git-ignored
if you do work inside a clone.

**Keeping it running.** In service it wants a supervisor, because the agent
exits non-zero on a fatal error — a revoked or expired token — and retries
everything else forever. On a Linux box, a unit like this is enough:

```ini
[Unit]
Description=Restaurant POS printer agent
After=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/pos-printer
ExecStart=/usr/bin/node --experimental-strip-types index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Save it as `/etc/systemd/system/pos-printer.service`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pos-printer
journalctl -u pos-printer -f
```

`Restart=always` rather than `on-failure`: the two ways this process ends are a
fatal credential problem, which restarting will not fix but which is harmless to
retry every ten seconds while somebody reads the log, and a `SIGTERM` from you,
which systemd does not treat as a failure anyway.

#### On Windows

It runs on Windows unchanged — nothing in the agent is POSIX-specific, and
`pathToFileURL` is already used for the entry-point check precisely because of
drive letters. What changes is the shell and the supervisor, and there are four
traps, every one of which produces an error that does not name its own cause.

**Node.** `winget install OpenJS.NodeJS` or the installer from nodejs.org, then
**open a new terminal** — the one you installed from still has the old `PATH`
and will say `node is not recognized`, which is where most people stop.

Node 22.6+ is the floor. From **22.18** type stripping is on by default, so the
`--experimental-strip-types` flag below is unnecessary there — it is kept in
these instructions because it is harmless (it survives as an alias) and it is
the one command that works on every version from 22.6 up.

**Getting the file.** In PowerShell, `curl` is an alias for `Invoke-WebRequest`,
so `curl -O <url>` does not download anything — `-O` is ambiguous between
`-OutFile`, `-OutVariable` and `-OutBuffer`, and it fails at argument binding
with a message that never mentions curl. It *works* in `cmd.exe` and in
PowerShell 7, which is how the instruction survives being tested. Write the
extension:

```powershell
mkdir C:\pos-printer; cd C:\pos-printer
curl.exe -O https://raw.githubusercontent.com/channyeintun/simple-restaurant-pos/main/agent/src/index.ts
```

**The config.** Write it with Notepad and *Save as → UTF-8*, or with
`Set-Content`. Do **not** use `>` or bare `Out-File`: Windows PowerShell 5.1 —
still the default `powershell` — writes UTF-16LE, which `readFile(…, 'utf8')`
reads as mojibake. A UTF-8 byte-order mark is handled, because `loadConfig`
strips one; that was a three-byte fix against a failure that reports an
"unexpected token" for a character invisible in Notepad.

**Running it — pass the config path absolutely.** The agent resolves
`agent.config.json` against the working directory, and a scheduled task with
"Start in" blank runs in `C:\Windows\System32`. It then exits 2, and Task
Scheduler shows `0x2`, which Windows documents as "the system cannot find the
file specified" — true, and about a file nobody mentioned. Naming the config on
the command line sidesteps the whole thing:

```powershell
node --experimental-strip-types C:\pos-printer\index.ts C:\pos-printer\agent.config.json
```

Run that by hand once and confirm you see the four `[agent]` startup lines
before going any further.

**Keeping it running.** There is no systemd. Task Scheduler is the built-in
answer, with two caveats that matter more than the setup:

*Its "restart on failure" is not `Restart=always`.* The interval has a hard
minimum of one minute and the count is a byte, so it cannot mean "forever, every
ten seconds". Put the loop in a wrapper instead, which also solves the other
problem — Task Scheduler discards stdout, so the agent's log goes nowhere unless
you redirect it. Save this as `C:\pos-printer\run-agent.cmd`:

```bat
@echo off
:loop
node --experimental-strip-types C:\pos-printer\index.ts C:\pos-printer\agent.config.json >> C:\pos-printer\agent.log 2>&1
timeout /t 10 /nobreak > nul
goto loop
```

*And it kills long-running tasks after three days.* "Stop the task if it runs
longer than: 3 days" is **ticked by default**, there is no `schtasks.exe`
parameter for it, and a POS installed on Monday goes quiet on Thursday lunchtime
with nobody connecting the two. Register the task from PowerShell as
Administrator, which lets you set it:

```powershell
$action  = New-ScheduledTaskAction -Execute 'C:\pos-printer\run-agent.cmd'
$trigger = New-ScheduledTaskTrigger -AtStartup
$set     = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
             -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'POS printer agent' -Action $action -Trigger $trigger `
  -Settings $set -User 'SYSTEM' -RunLevel Highest
```

Then open Task Scheduler, find the task, and **confirm on the Settings tab that
"Stop the task if it runs longer than" is unticked**. It is the one setting that
fails silently and days later.

Start it without rebooting with `Start-ScheduledTask -TaskName 'POS printer
agent'`, and read the log with `Get-Content C:\pos-printer\agent.log -Wait`.

**What you lose, and why it does not matter.** Windows never delivers `SIGTERM`
— Node's documentation says so outright — and Task Scheduler terminates the
process rather than asking, so the agent's "stopping, anything unprinted stays
queued" line never prints there. That costs the log line and nothing else: a job
killed mid-write was never acked, so it is still `pending` and prints again on
the next poll. A duplicate ticket is the trade this design already made.

**Firewall.** Nothing to configure. The agent listens on nothing; it makes only
outbound connections — HTTPS to the Worker and TCP 9100 to the printer — and
Windows Defender Firewall blocks inbound by default only.

#### Checking it without a printer

The printing path can be exercised with any TCP listener, which is worth doing
once before trusting it in a kitchen:

```sh
# On the agent's machine, in place of the printer:
nc -l 9100 | cat -v
```

Point `printerHost` at `127.0.0.1`, send a round from a tablet, and the ESC/POS
bytes appear — `^[` is ESC, `^]VB^C` is the cut. If they do, the only thing
between that and paper is the printer's own address.

### Printing by hand

Every sent round carries a **Print ticket** link, on the waiter's table view and
on the cashier's check. It opens the tablet's own print dialog with that round's
ticket in it — the same ticket the agent would have produced, from the same
`renderTicket` in `shared/`, laid out for paper by `@media print` instead of
ESC/POS. Whatever the tablet can print to, it can now print a ticket to: an
AirPrint or Mopria printer on the Wi-Fi, a laptop over a share, a PDF to hand to
somebody.

It exists because the agent is a machine that has to be set up and left running,
and a shop can open before that is true. Two rules kept it honest:

- **It is per round, never per check**, exactly as the agent is. Reprinting a
  whole check would send the kitchen food it cooked an hour ago.
- **There is no auto-print on Send.** A browser cannot print without a dialog,
  and a dialog that appears on its own in the middle of taking an order is worse
  than no printing at all. The waiter taps Send, then taps Print.

A successful tap also acks the round's queued ticket — `POST
/print-jobs/by-round/:id/printed` — so a job printed by hand does not sit
`pending` waiting for an agent that may never come, and does not print a second
time on paper if one arrives later. The ack is deliberately forgiving: it
matches only a `pending` ticket job for that round, so printing a round twice by
hand, or printing one the agent already handled, is a no-op rather than an
error. Void slips have no manual path; they are the agent's alone.

The one thing it does not give you is *unattended* printing. Somebody has to be
looking at a tablet and tap the link, which is why this is the fallback and the
agent is the system.

---

## Staying inside the free tiers

The design is bounded by one number: **the realtime keepalive**. The SSE handler
publishes one **every 10 seconds per open connection** — 6 a minute, 360 Redis
commands per connection-hour, because the ping goes out through Redis and comes
back on the subscription. Upstash's free tier is 500,000 commands a month.

That interval is ours, not a library's. `api/src/realtime.rs` is a hand-written
port of `@upstash/realtime`'s wire protocol — the npm package is not a
dependency of anything here — so `KEEPALIVE_INTERVAL_MS` is a constant in this
repo that could be raised tomorrow. It has not been, and the reason is worth
writing down rather than rediscovering:

- **The budget is not tight enough to spend risk on.** The table below lands at
  ~35% of the free tier. Lengthening the interval would buy back maybe 90,000
  commands a month that nothing is asking for.
- **What it would cost is the thing nothing else provides.** A ping is the only
  traffic that proves the *whole* path — browser to Worker to Redis and back —
  is still carrying bytes. Idle-connection timeouts in the middle of that path
  are exactly the kind of thing that is fine on a desk and not fine on a shop's
  Wi-Fi through a router somebody else configured, and 10 s is comfortably under
  every common one.

Probing settled the half of this that could be settled: Upstash does **not**
reap an idle subscription (verified quiet for 5 minutes), so the ping is not
holding the Redis end open. The client ignores `ping` frames entirely. What
remains unverified is every hop in between, and localhost cannot answer it.

360 an hour is affordable once and ruinous four times over, so:

- **Only the cashier page subscribes.** One channel, named `restaurant`.
- **Waiter tablets never subscribe.** A waiter is looking at one table at a
  time, and has just caused the change they are looking at. Opening a table
  fetches its check.
- **The printer agent never subscribes.** It polls, which costs Worker requests
  — a tier with enormous headroom — and zero Redis commands.

  This is the decision most often argued with, and the argument is usually
  "realtime is already wired up, why poll?". Because the two budgets are not the
  same size. Worker requests are 100,000 a *day*; Upstash commands are 500,000 a
  *month*, and the keepalive bills 360 an hour **for silence** — a subscribed
  agent costs the same at four in the morning as it does at dinner. A second
  always-on connection would take the month from ~173,000 to ~432,000, which is
  86% of the tier for a process nobody is looking at. Polling spends the
  abundant resource instead of the scarce one.

  It polls on a ladder rather than flat out: **3 seconds** while tickets are
  moving, **10 seconds** after five minutes of nothing, **30 seconds** after
  thirty. Any job resets it immediately. The three-second figure is set against
  how long a waiter takes to walk from the table to the pass, and the steps only
  engage when there is nobody making that walk.
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

**Workers — 100,000 requests/day.** Not a constraint. The agent is about 17,000
across a twelve-hour service and the closed half of the day — 14,400 of them in
service at three seconds, the rest on the idle ladder. (Flat-out at three
seconds around the clock it would be 28,800, which is what it used to be and
what the systemd unit in *Deployment* would otherwise give you: `Restart=always`
means the agent is up whether the restaurant is or not.) The cashier's fallback
is 8,640, the stuck-queue check is 2,880, and the waiter tablets are in the
hundreds.

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
- **A prep time is an estimate a manager typed, not a measurement.** `prep_minutes`
  is what the waiter quotes and what "late" is measured against, and the software
  never adjusts it — a kitchen that is consistently five minutes over will go on
  being flagged late until somebody changes the number. Delivered times are recorded
  (`rounds.delivered_at`), so the data to tune it with is there; using it
  automatically would be a report, and reports beyond the daily total are out of
  scope.
- **A round nobody marks delivered stays outstanding forever**, and goes on showing
  as late on the waiter's grid. That is deliberate: the alternative is software
  quietly deciding that food arrived. It also means the timing is only as good as the
  habit of tapping the button.
- **The new-order sound plays on the till and nowhere else.** Waiter tablets do not
  subscribe to anything — 360 Upstash commands an hour each would not fit the budget
  — so there is no push for them to ping on. The kitchen hears its printer.
- **The Burmese is unreviewed by a native speaker.** English is the source of
  truth in `shared/src/i18n/`, and every other catalogue is typed as `typeof en`
  so a missing key is a build error — but a key that is present and awkward is
  not something a compiler can catch.

---

## Status

**V1 is complete.** All six milestones are in, and `npm run check` and
`npm test` pass.

| | | |
| --- | --- | --- |
| 0 | Scaffold | monorepo, `0001_init.sql`, seed, device claim, staff PIN switch |
| 1 | Catalogue | products, categories, tables, staff, devices, the day's takings |
| 2 | Waiter | two panes, product tiles, the persistent cart, rounds, print jobs |
| 3 | Cashier | live open checks, voids, payments, the printer failure banner |
| 4 | Agent | ESC/POS over TCP 9100, and the ticket it prints |
| 5 | PWA | manifest, icons, service worker, add-to-home-screen, update prompt |
| — | Timing | per-dish prep times, a countdown per round, Delivered, and a ping on the till |

### The API, whole

Everything behind the device gate needs a claimed tablet; the middle column is
what it needs on top of that.

| Route | Needs | |
| --- | --- | --- |
| `GET /health` | — | is the Worker up, and is realtime configured |
| `POST /auth/claim` | — | redeem a device link |
| `GET /auth/me` | device | the session bootstrap: identity **and** currency and offset |
| `POST /auth/logout` | — | throw the credential away |
| `POST /realtime/ticket` | device | two-minute ticket for the stream |
| `GET /realtime/stream` | ticket | the SSE stream, channel `restaurant` |
| `GET /staff` | device | the names on the PIN screen |
| `POST /staff/switch` · `/signout` | device | four digits in, a re-minted token out |
| `GET /staff/roster` · `POST /staff` · `PATCH /staff/:id` · `PUT /staff/:id/pin` | admin | the roster |
| `GET /tables` · `/categories` · `/products` | staff | the live menu and floor; `?include=all` needs admin |
| `POST`/`PATCH` on those three | admin | edit them — there is no `DELETE` anywhere |
| `GET /checks` | staff | every open check, for the board and the tables grid |
| `GET /checks/:id` · `GET /checks/by-table/:id` | staff | one check, whole |
| `POST /rounds` | staff | **send to kitchen** — find-or-open, in one batch |
| `POST /checks/:id/items/:itemId/void` | staff | strike a line off, and tell the kitchen |
| `POST /checks/:id/rounds/:roundId/delivered` | staff | the waiter carried it out; stops that round's clock |
| `POST /checks/:id/pay` | cashier/admin | settle and close, at a total the cashier agreed to |
| `GET /print-jobs` | device | the queue, with each ticket already rendered |
| `POST /print-jobs/:id/printed` · `/failed` | device | the agent's acks |
| `POST /print-jobs/:id/retry` | cashier/admin | the banner's Retry |
| `POST /print-jobs/by-round/:id/printed` | staff | the ack for a ticket printed by hand |
| `GET /devices` · `POST /devices` · `/:id/claim-link` · `/:id/revoke` | admin | the tablets |
| `GET /reports/sales/today` | admin | the one report there is |

### What is tested, and what that means

`npm test` runs four suites and needs no server, no socket and no Redis:

- **`shared/test/logic.test.ts`** and **`cargo test -p pos-core`** — the twin
  rules, case for case. Money, the fixed-offset clock, check totals and what a
  kitchen ticket says, written twice and held to the same numbers.
- **`web/test/board.test.ts`** — the cashier's event reducer. It exists because
  local development runs with no Upstash credentials, so the stream never fires
  on a developer's machine and these cases would otherwise first be tried on a
  Saturday night by a cashier.
- **`agent/test/ticket.test.ts`** — the ESC/POS bytes. The only part of the
  printing path checkable without a printer, and the part where a mistake is
  silent.
- **`cargo test -p pos-api`** — the Worker's own: the token format, the channel
  allowlist, and every request body refused in the exact words zod would use.

What is *not* covered by any of them is the wiring: routes, D1 and the browser.
That is checked by hand against `wrangler dev` at the end of each milestone, and
the commit that closes one says what was exercised.
