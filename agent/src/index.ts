import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The printer agent: the only part of this system that runs inside the
 * restaurant.
 *
 * Everything else is on Cloudflare. The kitchen printer is a box on the shop's
 * own network with an IP address and a raw TCP port, and nothing running in a
 * Worker can open a socket to it — so a small node process sits on a machine in
 * the shop, asks the Worker whether anything needs printing, prints it, and
 * says whether that worked.
 *
 * ## It polls. It does not subscribe
 *
 * The obvious design is the one this deliberately is not: the cashier page
 * already has a live SSE stream carrying `print_job.failed` and
 * `print_job.printed`, and subscribing the agent to the same channel would make
 * a ticket appear the instant it is sent. That stream costs one Upstash command
 * every ten seconds it is open — 360 an hour, per connection, not configurable
 * from outside the library — and the agent's connection would be open for every
 * hour the restaurant is, twelve hours a day, whether or not anybody ordered
 * anything. That is a second cashier-sized bill for a process with no eyes on
 * it.
 *
 * Polling spends the other budget instead. `GET /print-jobs?status=pending`
 * every three seconds is 14,400 Worker requests a day against a free tier of
 * 100,000, and `idx_print_jobs_status` makes the overwhelming majority of them
 * — the ones that answer "nothing" — a probe of an empty index range. Three
 * seconds is also fast enough: it is well under the time it takes a waiter to
 * walk from the table to the pass, so the ticket is waiting when they get
 * there.
 *
 * ## An unacked job is the safe state
 *
 * A job is `pending` until the agent says otherwise. Nothing hands a job out
 * exclusively, nothing leases it, and nothing times it out — if this process is
 * killed mid-print, or the shop loses power with a ticket half-fed through the
 * printer, the row is still `pending` when it comes back and the ticket is
 * printed again. A duplicate ticket is a piece of paper somebody throws away. A
 * missing ticket is food nobody cooks, and the waiter finds out when the table
 * asks where their curry is.
 *
 * So: print first, ack second, and never ack anything the printer has not
 * accepted.
 *
 * ## Failing, and giving up
 *
 * `POST /print-jobs/:id/failed` records what went wrong in `last_error` and
 * counts the attempt. At three attempts the Worker moves the job to `failed`
 * and stops handing it out, and the cashier's screen grows a red banner saying
 * what the printer said — because a printer that is switched off, out of paper
 * or unplugged is not a problem this process can solve by trying harder, and
 * the person who can solve it is standing next to it. Between attempts the
 * agent backs off exponentially, so a dead printer is asked politely rather
 * than sixty times a minute.
 *
 * ## What is in this file
 *
 * All of it: the config, the loop, the intervals, the ESC/POS and the socket.
 * It is one file because it is one job, and because the thing running in a
 * restaurant should be something somebody can open and read from top to bottom
 * when it misbehaves — which is also why there is no build step and no runtime
 * dependency. `renderEscPos` is exported for `test/ticket.test.ts`; nothing
 * else here is imported by anything.
 *
 * Running it needs node 22.6 or newer, because `npm start` strips the types and
 * runs this file directly. There is no build step on purpose: the thing that
 * runs in the restaurant should be the thing somebody can open and read when it
 * misbehaves, on a machine where nobody is going to run a bundler.
 */

/* ------------------------------------------------------------------ config */

/**
 * What the agent has to be told. Four values, no defaults worth guessing, and
 * one file that lives next to the process rather than in this repo — it holds a
 * credential. `agent.config.example.json` is the copy that is committed.
 *
 * Field order is the order the example file writes them, which is the order a
 * person fills them in: where the API is, who I am, where the printer is.
 */
export interface AgentConfig {
  /** Base URL of the Worker, e.g. `https://restaurant-pos-api.example.workers.dev`. */
  apiUrl: string;
  /**
   * A device session token, the same credential a tablet holds.
   *
   * Getting one is the ordinary claim flow, pointed at a device row that stands
   * for the kitchen rather than for a tablet: add `dev_kitchen` in the
   * backoffice, mint its claim link, redeem it, and copy the token out. There
   * is no separate machine credential, because a printer agent is exactly what
   * a device is — something in the building that the restaurant trusts and can
   * cut off in one place. Bumping `devices.token_version` stops this process
   * dead, the same way it stops a lost tablet.
   */
  deviceToken: string;
  /** The printer's address on the restaurant LAN. An IP, usually static. */
  printerHost: string;
  /**
   * Raw printing port. 9100 is the de-facto standard for ESC/POS over TCP and
   * is what the field defaults to; it exists for the one printer that
   * disagrees.
   */
  printerPort: number;
}

/** 9100 is JetDirect/raw printing, and every thermal printer worth buying speaks it. */
const DEFAULT_PRINTER_PORT = 9100;

/**
 * A bad config file, reported all at once.
 *
 * Every problem is collected before anything is thrown, rather than failing on
 * the first one. The person editing this file is typing JSON by hand into a
 * back-office PC, probably over the phone to whoever set the restaurant up, and
 * making them discover their four mistakes one restart at a time is a way of
 * wasting somebody's evening.
 */
export class ConfigError extends Error {
  /**
   * Written out as a field and assigned by hand rather than declared as a
   * `readonly` constructor parameter. A parameter property is one of the few
   * pieces of TypeScript that cannot be erased — it *generates* an assignment —
   * and `npm start` runs this file through node's strip-only type stripping,
   * which refuses it outright. `erasableSyntaxOnly` in `tsconfig.json` is what
   * turns that into a compile error instead of a crash on the first line.
   */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`agent config is not usable:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whatever a thrown thing has to say for itself. Everything logged by this
 * process, and everything written into `last_error` for the cashier to read,
 * goes through here — `catch` hands you `unknown`, and "[object Object]" on a
 * banner at eight in the evening helps nobody.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireText(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`"${field}" must be a non-empty string`);
    return '';
  }
  return value.trim();
}

function requireUrl(value: unknown, field: string, problems: string[]): string {
  const text = requireText(value, field, problems);
  if (text === '') return '';
  if (!URL.canParse(text)) {
    problems.push(`"${field}" is not a URL: ${text}`);
    return '';
  }
  // Normalise away a trailing slash once, here, so that every path this file
  // builds can be written with a leading slash and read like the route it
  // calls. A config with `https://api.example.com/` in it should not produce
  // `//print-jobs`.
  return text.replace(/\/$/, '');
}

function optionalPort(value: unknown, field: string, problems: string[]): number {
  if (value === undefined) return DEFAULT_PRINTER_PORT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    problems.push(`"${field}" must be a whole number between 1 and 65535`);
    return DEFAULT_PRINTER_PORT;
  }
  return value;
}

/** Validates a parsed JSON value into an `AgentConfig`, or explains why not. */
export function parseConfig(source: unknown): AgentConfig {
  if (!isRecord(source)) {
    throw new ConfigError(['the file does not contain a JSON object']);
  }

  const problems: string[] = [];
  const config: AgentConfig = {
    apiUrl: requireUrl(source.apiUrl, 'apiUrl', problems),
    deviceToken: requireText(source.deviceToken, 'deviceToken', problems),
    printerHost: requireText(source.printerHost, 'printerHost', problems),
    printerPort: optionalPort(source.printerPort, 'printerPort', problems),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Reads and validates the config file. Both failures read the same way. */
export async function loadConfig(path: string): Promise<AgentConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError([`cannot read ${path} — copy agent.config.example.json to it`]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    // JSON's own message ("Unexpected token } in JSON at position 214") is
    // more use than anything this file could say instead: it names the
    // character. A hand-edited config fails here on a trailing comma far more
    // often than it fails validation.
    throw new ConfigError([`${path} is not valid JSON: ${describe(error)}`]);
  }

  return parseConfig(parsed);
}

/* --------------------------------------------------------------- the wire */

/**
 * A pending print job, as the poll answers it.
 *
 * Deliberately not imported from `@pos/shared`: this workspace has no runtime
 * dependencies at all, and pulling the shared package in would pull zod onto a
 * machine in a restaurant to validate five fields. The fewer moving parts
 * between the kitchen and a printed ticket, the better — and this file only
 * reads the fields below.
 *
 * What a ticket *says* is not worked out here either. It arrives already
 * rendered, in `ticket`, from `pos_core::ticket` — whose TypeScript twin is
 * `shared/src/ticket.ts` and which is held to the same test cases. The agent
 * draws what it is given and composes nothing out of its own opinions.
 */
export interface PendingJob {
  id: string;
  roundId: string;
  /** `ticket` is a round to cook. `void` is a strike-off, printed the same way. */
  kind: 'ticket' | 'void';
  /** How many times this one has already been tried. Three is the end of it. */
  attempts: number;
  /**
   * What this slip says, rendered by the Worker.
   *
   * This is what keeps the agent free of rules entirely. It does not know what
   * a round is, which lines belong on a void, how a check is totalled or what
   * time zone the restaurant is in; a doc comes in and ESC/POS bytes go out.
   * The rendering is `pos_core::ticket::render_ticket`, twinned with
   * `shared/src/ticket.ts` and held to the same test cases, so what the kitchen
   * is handed and what a screen would show are the same thing by construction.
   */
  ticket: TicketDoc;
}

/**
 * The ticket, exactly as `ticketDocSchema` declares it.
 *
 * Declared here rather than imported, like {@link PendingJob} above, and for a
 * reason that is worth stating once: this workspace has **no runtime
 * dependencies**, deliberately. Pulling `@pos/shared` in would put zod on a
 * machine in a restaurant to validate seven fields, and would not work anyway —
 * `agent/` has no build step, node's type stripping does not rewrite the `.js`
 * specifiers that package imports itself with, and giving it one would mean the
 * thing running in the shop is no longer the thing somebody can open and read
 * when it misbehaves.
 *
 * What that costs is that a change to the doc's shape has to be made twice. It
 * is a flat object of seven fields that has not changed since it was written,
 * and `tsc` here would not have caught a change on the Rust side anyway.
 */
export interface TicketDoc {
  kind: 'ticket' | 'void';
  /** The round's number within its check. How the kitchen finds the original. */
  seq: number;
  /** The table's name, or null for takeaway and the counter. */
  table: string | null;
  /** `19:30`, already in the restaurant's own offset. */
  time: string;
  staff: string;
  lines: { qty: number; name: string; note: string | null }[];
}

/**
 * A failure that more patience will not fix: a rejected credential, a config
 * the Worker refuses. The loop rethrows these instead of retrying, because the
 * only thing that resolves them is a person reading the log.
 */
class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

/** A JSON call that has not answered in ten seconds is not going to. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One request to the Worker, with the device token attached.
 *
 * The error envelope is the API's single one — `{"error":{"code","message"}}` —
 * and the message inside it is written for a person, so it is what gets
 * surfaced rather than a status code. 401 and 403 are separated out as fatal: a
 * token that has been revoked or has expired will be revoked and expired on
 * every subsequent poll too, and an agent that spins on it is a process that
 * looks alive in `ps` while printing nothing.
 */
async function call<T>(
  config: AgentConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.deviceToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Without this a hung connection parks the loop forever and the agent stops
    // polling without ever saying so. Ten seconds is generous for a JSON call
    // that normally answers "nothing".
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const envelope = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    const message = envelope?.error?.message ?? `${response.status} ${response.statusText}`;

    if (response.status === 401 || response.status === 403) {
      throw new FatalError(
        `the Worker rejected this agent's device token (${message}). ` +
          'Mint a new claim link for the printer device and put the token in the config.',
      );
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/* ---------------------------------------------------------------- the loop */

/**
 * How often to ask, when the restaurant is busy.
 *
 * Three seconds is chosen against one number: how long a waiter takes to walk
 * from the table to the pass. It is comfortably under that, so the ticket is
 * waiting when they arrive, and there is nothing to gain by going faster.
 */
const POLL_INTERVAL_MS = 3_000;

/**
 * How often to ask when nothing has been printing, and how long it takes to
 * decide that.
 *
 * Polling at three seconds around the clock is 28,800 requests a day, and more
 * than half of them happen while the building is empty. The tier is 100,000 a
 * day so this was never going to break anything — but a third of a budget spent
 * asking an empty restaurant whether it has any orders is the kind of thing
 * that is fine until the day it is load-bearing, and it costs ten lines to not
 * do it.
 *
 * Two steps down rather than a smooth curve, because the two cases are
 * genuinely different and a curve would blur them:
 *
 *   * **Five minutes of nothing → ten seconds.** A lull mid-service. The
 *     penalty is that the first ticket after the lull can be up to ten seconds
 *     late instead of three — and a kitchen that has had no orders for five
 *     minutes is a kitchen with nothing queued behind it, which is exactly when
 *     seven seconds costs nothing.
 *   * **Thirty minutes of nothing → thirty seconds.** Closed, or between
 *     services. By the time this engages the restaurant has been quiet for half
 *     an hour; nobody is standing at a pass waiting.
 *
 * Any job at all resets it to three seconds immediately, so the *second* ticket
 * of an evening is always fast even if the first one waited. There is no state
 * to get wrong: the ladder is a function of how many empty polls have happened
 * in a row.
 */
const IDLE_STEPS = [
  { afterEmptyPolls: (5 * 60) / 3, intervalMs: 10_000 },
  { afterEmptyPolls: (30 * 60) / 3, intervalMs: 30_000 },
];

/**
 * The gap before the next poll, given how long it has been quiet.
 *
 * Exported for `test/ticket.test.ts` — it is the one other piece of this file
 * that is pure and worth pinning down, because an off-by-one in the ladder is
 * invisible until somebody notices the kitchen is slow on a Friday.
 */
export function pollIntervalFor(consecutiveEmptyPolls: number): number {
  let interval = POLL_INTERVAL_MS;
  for (const step of IDLE_STEPS) {
    if (consecutiveEmptyPolls >= step.afterEmptyPolls) interval = step.intervalMs;
  }
  return interval;
}

/**
 * The first pause after a failure, doubling from there. It starts at the poll
 * interval because backing off to something *shorter* than the ordinary cadence
 * would be a strange kind of restraint.
 */
const BACKOFF_BASE_MS = POLL_INTERVAL_MS;

/**
 * The ceiling. A job of its own is dead after three attempts long before this
 * matters; the cap is for the other case — the Worker unreachable because the
 * restaurant's line is down — where the agent must neither hammer a dead
 * network nor take ten minutes to notice it came back.
 */
const BACKOFF_MAX_MS = 60_000;

function nextBackoff(current: number): number {
  return Math.min(current === 0 ? BACKOFF_BASE_MS : current * 2, BACKOFF_MAX_MS);
}

/** The pending queue, oldest first — the order the kitchen should receive it. */
async function fetchPendingJobs(config: AgentConfig): Promise<PendingJob[]> {
  return call<PendingJob[]>(config, 'GET', '/print-jobs?status=pending');
}

/**
 * Tell the Worker what happened. `printed` stamps `printed_at`; `failed`
 * records the message in `last_error`, counts the attempt, and gives up at
 * three.
 *
 * An ack that itself fails is never retried on the spot — it bubbles up to the
 * loop, which logs it and slows down. The job stays `pending`, the next poll
 * picks it up, and the ticket prints twice, which is the trade this whole
 * design already made and the reason it is safe to leave an ack to the
 * network's mercy.
 */
async function ack(
  config: AgentConfig,
  jobId: string,
  outcome: 'printed' | 'failed',
  error?: string,
): Promise<void> {
  await call<unknown>(
    config,
    'POST',
    `/print-jobs/${jobId}/${outcome}`,
    outcome === 'failed' ? { error } : undefined,
  );
}

/**
 * The loop. Poll, print what came back, sleep, again — forever, until something
 * fatal or a `SIGTERM`.
 *
 * Two things about it that are decisions rather than accidents:
 *
 *   * A failed job **stops the batch**. There is one printer, so a ticket it
 *     just refused tells you what it will do with the next four; the rest stay
 *     `pending` and come back on the next tick, having spent no attempts on a
 *     printer that was never going to take them.
 *   * The backoff is the *agent's*, not the job's. `attempts` lives in the
 *     database and survives a restart; this timer is only about how hard this
 *     process is currently pushing, and it resets the moment anything succeeds.
 */
export async function run(config: AgentConfig): Promise<void> {
  let backoffMs = 0;
  /*
   * How long it has been quiet, counted in polls rather than in milliseconds.
   *
   * Separate from `backoffMs` and deliberately so: that one is about this
   * process being in trouble and having to push less hard, and this one is
   * about the restaurant being empty. They answer different questions and a
   * single counter doing both would reset the wrong one — a printer failure
   * would look like a busy evening and undo the idle ladder.
   */
  let emptyPolls = 0;

  for (;;) {
    try {
      const jobs = await fetchPendingJobs(config);
      for (const job of jobs) {
        const printed = await attempt(config, job);
        if (!printed) {
          backoffMs = nextBackoff(backoffMs);
          break;
        }
        backoffMs = 0;
      }
      if (jobs.length === 0) {
        backoffMs = 0;
        emptyPolls += 1;
      } else {
        // Anything at all means the restaurant is awake. Back to three seconds
        // before the next ticket rather than after it.
        emptyPolls = 0;
      }
    } catch (error) {
      if (error instanceof FatalError) throw error;
      // Everything else — the Worker down, the line down, a 500 — is weather.
      // Say so once per tick and keep going, more slowly.
      backoffMs = nextBackoff(backoffMs);
      console.error(`[agent] poll failed: ${describe(error)}`);
      // A failed poll is not an idle one: we do not know whether there was
      // anything there. Leaving the counter alone means a long outage does not
      // also slow the recovery down.
    }

    // A failure backoff always wins over the idle ladder: it is about this
    // process being in trouble, which is the more urgent of the two things to
    // respect.
    await sleep(backoffMs === 0 ? pollIntervalFor(emptyPolls) : backoffMs);
  }
}

/** Prints one job and acks it. Returns false when the printer refused it. */
async function attempt(config: AgentConfig, job: PendingJob): Promise<boolean> {
  try {
    await print(config, job);
  } catch (error) {
    const message = describe(error);
    console.error(`[agent] ${job.kind} ${job.id} failed (attempt ${job.attempts + 1}): ${message}`);
    // `last_error` is read by a person off the cashier's banner, so it is the
    // printer's own words — ECONNREFUSED, ETIMEDOUT — trimmed to what the
    // column holds rather than summarised into something tidier and less
    // useful.
    await ack(config, job.id, 'failed', message.slice(0, 300));
    return false;
  }

  await ack(config, job.id, 'printed');
  console.log(`[agent] printed ${job.kind} ${job.id}`);
  return true;
}

/* ------------------------------------------------------------------ ESC/POS */

/*
 * The bytes.
 *
 * This is the agent's own business and nobody else's: what a ticket *says* is
 * `shared/src/ticket.ts` and its Rust twin, held to the same test cases on both
 * sides, and what it *is* on the wire is an escape code for double-height text
 * and a knife. Keeping them apart is what lets the rules be tested without a
 * printer and the printer be changed without touching the rules.
 *
 * ESC/POS is a 1980s command set that every thermal printer worth buying still
 * speaks. The handful of sequences below are the ones with no plausible
 * alternative, and each is named because `\x1b\x21\x30` means nothing to
 * anybody reading this at midnight.
 */

/** `ESC @` — reset. Undoes whatever the last job left the printer in. */
const INIT = '\x1b@';
/** `ESC a n` — 0 left, 1 centre. */
const ALIGN_LEFT = '\x1ba\x00';
const ALIGN_CENTRE = '\x1ba\x01';
/**
 * `ESC ! n` — the character style, as a bit field. 0x10 is double height and
 * 0x20 is double width, so 0x30 is both: the size a header has to be to be read
 * off a rail above a hot stove, at arm's length, by somebody who is not
 * standing still.
 */
const SIZE_NORMAL = '\x1b!\x00';
const SIZE_LARGE = '\x1b!\x30';
const SIZE_TALL = '\x1b!\x10';
/** `ESC E n` — emphasis on and off. */
const BOLD_ON = '\x1bE\x01';
const BOLD_OFF = '\x1bE\x00';
/**
 * `GS V 66 n` — partial cut after feeding `n` dots.
 *
 * Partial rather than full, because a full cut drops the slip on the floor and
 * a partial one leaves it hanging for somebody to tear off. The feed is what
 * gets the last line clear of the blade; printers vary, and 3 is the value that
 * works on the cheap ones without wasting a centimetre on the good ones.
 */
const CUT = '\x1dV\x42\x03';

/**
 * The words on the paper.
 *
 * Five strings, in English, and they live here rather than in
 * `shared/src/i18n/` — which is where the rest of this app's words are — for
 * two reasons that both point the same way. `agent/` has no build step, so it
 * cannot import that package at all (node's type stripping does not rewrite the
 * `.js` specifiers it uses internally). And a thermal printer's built-in
 * character set has no Myanmar glyphs, so a Burmese header would print as a row
 * of boxes: the choice is not between two languages, it is between English and
 * nothing.
 *
 * Dish names are a different matter and are printed exactly as the manager
 * typed them. If the menu is in Burmese they will be boxes too, and that is a
 * property of the hardware rather than of this decision — the README says so
 * under Known limitations, and the fix is a printer that rasterises.
 */
const WORDS = {
  round: (seq: number) => `ROUND ${seq}`,
  voidHeader: 'VOID',
  takeaway: 'TAKEAWAY',
  table: (name: string) => `TABLE ${name}`,
  staff: (name: string) => `Waiter: ${name}`,
};

/**
 * How many characters fit across the paper.
 *
 * 42 is 80mm at the usual font; 58mm paper gives 32. It is a constant rather
 * than a config field because wrapping is the only thing that reads it and
 * wrapping degrades gracefully — a line that is too long for 58mm paper wraps
 * itself in the printer rather than being lost. Making it a setting would be a
 * fifth thing for somebody to get wrong over the phone.
 */
const COLUMNS = 42;

/**
 * Wrap a dish name under its quantity.
 *
 * The quantity column is three characters and a space, so a name that runs past
 * the edge continues indented under itself rather than starting again at the
 * margin — which would read as a second dish. Breaking on spaces where there
 * are any and mid-word where there are not, because a 40-character word with no
 * spaces in it still has to end up on the paper.
 */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/**
 * One ticket, as the byte string that draws it.
 *
 * Exported because it is the only part of the printing path that can be checked
 * without a printer, and `agent/test/ticket.test.ts` checks it.
 *
 * The layout is dictated by where it is read: pinned to a rail in a kitchen,
 * glanced at while doing something else. So the table is the biggest thing on
 * it, the round number is next, and the quantity is bold at the left margin of
 * every line — a cook scanning a slip is counting portions, not reading prose.
 * A void reverses only the header, because everything else about it is the same
 * question ("what, and how many") asked backwards.
 */
export function renderEscPos(doc: TicketDoc): string {
  const out: string[] = [INIT, ALIGN_CENTRE];

  // The header. A void says so first and in the largest type on the slip: the
  // kitchen is holding a piece of paper that says to cook this, and the whole
  // job of this one is to be unmistakably not that.
  if (doc.kind === 'void') {
    out.push(SIZE_LARGE, BOLD_ON, `${WORDS.voidHeader}\n`, BOLD_OFF, SIZE_NORMAL);
  }

  out.push(SIZE_LARGE, BOLD_ON);
  out.push(`${doc.table === null ? WORDS.takeaway : WORDS.table(doc.table)}\n`);
  out.push(BOLD_OFF, SIZE_NORMAL);

  out.push(SIZE_TALL, `${WORDS.round(doc.seq)}\n`, SIZE_NORMAL);
  out.push(`${doc.time}  ${WORDS.staff(doc.staff)}\n`);
  out.push(ALIGN_LEFT, `${'-'.repeat(COLUMNS)}\n`);

  // The lines. Double height throughout, which halves how many fit on a slip
  // and is worth it every time: this is the part somebody reads at a distance
  // while their hands are full.
  for (const line of doc.lines) {
    const qty = String(line.qty).padStart(2, ' ');
    const wrapped = wrap(line.name, COLUMNS / 2 - 4);
    out.push(SIZE_TALL, BOLD_ON, `${qty}  ${wrapped[0] ?? ''}\n`, BOLD_OFF);
    for (const continuation of wrapped.slice(1)) out.push(`    ${continuation}\n`);
    out.push(SIZE_NORMAL);

    // The note is the one modifier this app has, and it is the one thing on the
    // slip that changes what the kitchen *does* rather than how much of it. It
    // is indented under its dish and marked, so it cannot be read as another
    // line of the order.
    if (line.note !== null) {
      for (const noteLine of wrap(line.note, COLUMNS - 6)) {
        out.push(`    * ${noteLine}\n`);
      }
    }
  }

  // Feed past the blade, then cut. Without the feed the last line is inside the
  // mechanism and comes off on the next ticket.
  out.push(`${'-'.repeat(COLUMNS)}\n\n\n`, CUT);
  return out.join('');
}

/**
 * Put one job on paper.
 *
 * Opens a socket, writes the bytes, and resolves **only once the printer has
 * taken them and the connection has closed cleanly**. Every part of that
 * sentence is load-bearing: `socket.write` resolving means the bytes left this
 * process, not that anything printed them, and a promise that settled there
 * would ack a ticket that is still sitting in a TCP buffer on a printer that is
 * switched off. Waiting for `close` after `end` is the closest thing raw 9100
 * offers to an acknowledgement — there is no protocol here, just a pipe.
 *
 * The timeout is the other half. A printer that is powered but wedged accepts a
 * connection and then never reads, which without this would park the agent
 * forever on one ticket while the rest of the evening's orders queue up behind
 * it. Fifteen seconds is far longer than a slip takes and far shorter than a
 * service.
 */
const PRINT_TIMEOUT_MS = 15_000;

function print(config: AgentConfig, job: PendingJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: config.printerHost, port: config.printerPort });
    // `settled` rather than trusting the event order: a socket can emit `error`
    // after `close`, and a promise that rejects after resolving is a crash in
    // node rather than a no-op.
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setTimeout(PRINT_TIMEOUT_MS, () => {
      finish(new Error(`printer ${config.printerHost}:${config.printerPort} stopped responding`));
    });
    socket.on('error', (error) => finish(error));
    // `close` and not `end`: `end` is the printer saying it is finished
    // talking, which it never does, whereas `close` fires when our own `end`
    // has flushed and the socket is down.
    socket.on('close', (hadError) => {
      finish(hadError ? new Error('the connection to the printer failed') : undefined);
    });

    socket.on('connect', () => {
      // `binary`, not `utf8`. Every byte in a ticket is either an ESC/POS
      // command or a character in the printer's own code page, and encoding a
      // command byte as UTF-8 would turn `\x1b!` into two bytes and the rest of
      // the slip into noise. It also means a non-ASCII dish name is sent as
      // whatever the low byte is and prints as the printer's own glyph for it,
      // which is the honest behaviour: this is a device with one font.
      socket.end(Buffer.from(renderEscPos(job.ticket), 'binary'));
    });
  });
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  // A path argument, defaulting to the file beside wherever the agent was
  // started from. The config is not in the repo — it holds a device token — so
  // there is nothing sensible to resolve it against but the working directory.
  const path = resolve(process.argv[2] ?? 'agent.config.json');

  let config: AgentConfig;
  try {
    config = await loadConfig(path);
  } catch (error) {
    console.error(`[agent] ${describe(error)}`);
    process.exit(2);
  }

  console.log(`[agent] config ${path}`);
  console.log(`[agent] api    ${config.apiUrl}`);
  console.log(`[agent] printer ${config.printerHost}:${config.printerPort}`);
  console.log(`[agent] poll   every ${POLL_INTERVAL_MS / 1000}s, give up on a job after 3 attempts`);

  /*
   * Stop politely.
   *
   * `SIGTERM` is what a supervisor sends on `systemctl stop` and what Docker
   * sends on `docker stop`, and the useful thing to do with it is finish the
   * ticket currently being written and then go. There is nothing to flush and
   * no state to save — an unacked job stays `pending`, which is the whole
   * design — so this is really just a log line that distinguishes "somebody
   * stopped it" from "it fell over", in a log somebody will read tomorrow
   * morning wondering why the kitchen went quiet.
   */
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[agent] ${signal} — stopping. Anything unprinted stays queued.`);
      process.exit(0);
    });
  }

  try {
    await run(config);
  } catch (error) {
    // Only `FatalError` reaches here — everything else is weather and the loop
    // keeps going. A non-zero exit is what tells a supervisor to stop
    // restarting this and what puts the reason in front of a person, which is
    // the only thing that resolves a revoked token.
    console.error(`[agent] ${describe(error)}`);
    process.exit(1);
  }
}

/*
 * Run only when this file is what node was pointed at.
 *
 * Without the guard, `main()` runs on *import* — and `agent/test/ticket.test.ts`
 * imports this module to check the ESC/POS bytes, so the test suite would try
 * to read a config file, fail to find one, and exit 2 before asserting
 * anything. A module that cannot be imported without starting a process is a
 * module that cannot be tested.
 *
 * `pathToFileURL(process.argv[1])` rather than `import.meta.main`, which only
 * arrived in node 24. This runs on a machine in a restaurant, chosen by
 * whoever set it up, and the type stripping it needs has been there since 22.6
 * — there is no reason for the entry-point check to be the thing that raises
 * the floor.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
