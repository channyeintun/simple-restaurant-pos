import type { PrintJobKind } from './models.js';
import { formatClock } from './time.js';

/**
 * What a kitchen ticket says, as data.
 *
 * Written twice — here and in `api/core/src/ticket.rs` — and held to the same
 * test cases, because the Worker renders this for the printer agent to fetch
 * and the browser renders it for anybody who wants to see what was sent.
 *
 * ## The doc carries no words
 *
 * Not a line of prose, and that is the design rather than an omission. A
 * {@link TicketDoc} is a round number, a table, a time, a name and some lines.
 * The labels around them — "ROUND", "VOID", "TAKEAWAY", "TABLE" and the
 * waiter's line — belong to the **agent**, in `agent/src/index.ts`, next to the
 * ESC/POS bytes that draw them.
 *
 * That draws the line in the right place. What a ticket *says* is a rule and
 * lives twice, here and in Rust; what it *is* on the wire — the bytes, the font
 * size, where the paper is cut, and the words themselves — belongs to the one
 * thing that knows what a printer can render.
 *
 * Which is not much. A thermal printer's built-in character set has no Myanmar
 * glyphs, so those five labels are English and a Burmese one would print as
 * boxes. They are deliberately *not* in `shared/src/i18n/`: the agent has no
 * build step and cannot import that package at all — node's type stripping does
 * not rewrite the `.js` specifiers it uses internally — and there would be
 * nothing to gain if it could. The README covers it under Known limitations,
 * along with the harder half, which is that dish names come from the menu and
 * are printed exactly as the manager typed them.
 *
 * ## The time is the restaurant's
 *
 * `formatClock` with the offset from the Worker's vars, so the ticket says the
 * time the kitchen clock says. A UTC stamp on a slip of paper in Yangon is six
 * and a half hours of confusion for no benefit at all.
 */

/** One line on a ticket: how many, of what, with what note. */
export interface TicketLine {
  qty: number;
  name: string;
  /** Free text from the waiter — "no chilli". Null when there was none. */
  note: string | null;
}

/** The rows a ticket is rendered from, as they come out of the database. */
export interface TicketInput {
  kind: PrintJobKind;
  /** The round's number within its check. What the ticket calls itself. */
  seq: number;
  /** The table's name, or null for takeaway and the counter. */
  tableName: string | null;
  /**
   * Who is answerable for this slip: the waiter who sent the round, or — on a
   * void — whoever struck the line off. The kitchen needs somebody to ask about
   * the "no chilli", and on a void they need to know who decided.
   */
  staffName: string;
  /**
   * When the round was sent, or the line struck off, as **epoch milliseconds**.
   *
   * A number rather than the ISO string the column holds, so that this and
   * `api/core/src/ticket.rs` take the same value: that crate may not depend on
   * the host and therefore has no date parser, and a twin whose two halves are
   * handed different-looking input is a twin whose test cases are not really
   * the same cases. `Date.parse(iso)` at the call site is the conversion.
   */
  atMs: number;
  lines: readonly { name: string; qty: number; note: string | null }[];
}

/** What the agent is handed, and all it is handed. */
export interface TicketDoc {
  kind: PrintJobKind;
  seq: number;
  table: string | null;
  /** `19:30`, in the restaurant's own offset. */
  time: string;
  staff: string;
  lines: TicketLine[];
}

/**
 * Turn the rows behind a print job into the ticket they say.
 *
 * Which lines arrive is the caller's business and is not the same question for
 * the two kinds: a `ticket` is the round entire, as it was sent — including any
 * line that has since been voided, because the void notice that follows refers
 * to a slip the kitchen is holding — and a `void` is the one line that was
 * struck off. This function renders what it is handed.
 *
 * What it does decide is the two normalisations that would otherwise be got
 * slightly differently in each of the two languages:
 *
 *   * an empty or all-whitespace note is **null**, not an empty line under the
 *     dish. A waiter who opened the note field and typed nothing has not said
 *     anything, and a ticket with a blank line in it wastes paper and reads
 *     like something went missing.
 *   * an empty or all-whitespace table name is **null**, which is takeaway. It
 *     cannot happen through the API — `createTableSchema` trims and requires a
 *     character — and it is handled because the alternative is a ticket headed
 *     with a space, which nobody in the kitchen can act on.
 */
export function renderTicket(input: TicketInput, tzOffsetMinutes: number): TicketDoc {
  return {
    kind: input.kind,
    seq: input.seq,
    table: blankToNull(input.tableName),
    time: formatClock(input.atMs, tzOffsetMinutes),
    staff: input.staffName,
    lines: input.lines.map((line) => ({
      qty: line.qty,
      name: line.name,
      note: blankToNull(line.note),
    })),
  };
}

/** `null`, `''` and `'   '` all mean "nothing was said". */
function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
