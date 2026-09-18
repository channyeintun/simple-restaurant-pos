import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

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
 * ## Milestone 0: what is here and what is not
 *
 * This file is the skeleton — the config, the loop, the intervals and the
 * reasoning. The printing itself is milestone 4 and is marked as a gap below:
 * it exits with a message instead of pretending to work, and `main` stops
 * before starting the loop for the same reason. An agent that polled, failed
 * every ticket it was handed and burned each one through three attempts would
 * be strictly worse than no agent at all — it would fill the cashier's banner
 * with "not implemented" and leave real orders marked `failed` in the database.
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
 * machine in a restaurant to validate four fields. The fewer moving parts
 * between the kitchen and a printed ticket, the better — and this file only
 * reads the fields below.
 *
 * What a ticket *says* is not here either. That is `shared/src/ticket.ts` and
 * its Rust twin, and milestone 2 decides whether this payload carries it or the
 * agent asks for the round separately; either way the agent renders what it is
 * given and does not compose a ticket out of its own opinions.
 */
export interface PendingJob {
  id: string;
  roundId: string;
  /** `ticket` is a round to cook. `void` is a strike-off, printed the same way. */
  kind: 'ticket' | 'void';
  /** How many times this one has already been tried. Three is the end of it. */
  attempts: number;
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

/** Every three seconds, all day: 14,400 requests against a 100,000/day tier. */
const POLL_INTERVAL_MS = 3_000;

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
      if (jobs.length === 0) backoffMs = 0;
    } catch (error) {
      if (error instanceof FatalError) throw error;
      // Everything else — the Worker down, the line down, a 500 — is weather.
      // Say so once per tick and keep going, more slowly.
      backoffMs = nextBackoff(backoffMs);
      console.error(`[agent] poll failed: ${describe(error)}`);
    }

    await sleep(backoffMs === 0 ? POLL_INTERVAL_MS : backoffMs);
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

/* ------------------------------------------------- MILESTONE 4: the gap --- */

/**
 * Put one job on paper. **Not implemented — this is milestone 4.**
 *
 * What goes here: open a TCP socket to `printerHost:printerPort`, write the
 * ESC/POS byte stream for the ticket, and resolve only once the socket has
 * flushed and closed cleanly. The bytes are the agent's business alone — what a
 * ticket *says* is `shared/src/ticket.ts` and its Rust twin, tested on both
 * sides; what it *is* on the wire is an escape code for double-height text and
 * a cut command, and belongs nowhere near either.
 *
 * It throws rather than returning, so that the day it is written it slots into
 * `attempt` above with the failure path already correct.
 */
function print(_config: AgentConfig, _job: PendingJob): Promise<void> {
  return Promise.reject(new Error('printing is not implemented yet (milestone 4)'));
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

  // The milestone-4 stop.
  //
  // Everything above this line is real: the config was read and validated, and
  // the loop below it is the shape the finished agent runs. What is missing is
  // `print`, and starting the loop without it would not be a harmless no-op —
  // it would poll the real queue, fail every ticket it was handed, spend all
  // three attempts on each one, and leave the cashier looking at a red banner
  // that says "printing is not implemented yet" about food a table is waiting
  // for. Exiting non-zero is the honest version of that: a supervisor sees a
  // process that will not start, which is what is true.
  console.error(
    '\n[agent] not started: ESC/POS printing arrives in milestone 4.\n' +
      '        The config above is valid, so nothing here needs changing when it does.\n',
  );
  process.exit(1);

  // Unreachable until milestone 4 deletes the block above:
  // await run(config);
}

await main();
