import { type CheckDetail, type RoundDetail, type TicketDoc, renderTicket } from '@pos/shared';
import { For, Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { platform } from '../platform/index.js';

/**
 * A kitchen ticket, on paper, from a browser.
 *
 * This is the interim path while there is no printer agent in the building: a
 * waiter or a cashier taps Print and the operating system's dialog puts a slip
 * on whatever the tablet can reach. It is deliberately the *same ticket* the
 * agent would have printed — `renderTicket` from `shared/` is the TypeScript
 * twin of the `pos_core::ticket` the Worker hands the agent, so a slip printed
 * by hand and a slip printed by a machine say the same thing in the same order.
 *
 * ## The words are English, like the agent's
 *
 * A browser could render Burmese perfectly well, and the agent cannot — a
 * thermal printer's built-in font has no Myanmar glyphs. It would be easy to
 * take these from the i18n catalogue and have the browser print Burmese, and it
 * would be a mistake: the kitchen would then get two different-looking slips
 * for the same thing depending on which route the ticket took, and would have
 * to learn both. One format, whoever printed it. The labels below must stay in
 * step with `WORDS` in `agent/src/index.ts`, which is the same five strings for
 * the same reason.
 *
 * ## Why the sheet is always in the document
 *
 * `window.print()` is synchronous and blocks. A sheet built when the button was
 * pressed would be racing the dialog for a layout pass. So it lives in a
 * `Portal` — outside `.app`, which the print stylesheet hides — holding either
 * nothing or the one ticket about to be printed.
 */

/** In step with `WORDS` in `agent/src/index.ts`. See the note above. */
const WORDS = {
  round: (seq: number) => `ROUND ${seq}`,
  voidHeader: 'VOID',
  takeaway: 'TAKEAWAY',
  table: (name: string) => `TABLE ${name}`,
  staff: (name: string) => `Waiter: ${name}`,
};

/**
 * Hold the ticket that is about to print, and hand the page to the dialog.
 *
 * The `setTimeout` is the whole subtlety and it is not a guess at a duration —
 * zero is enough. Solid writes the DOM synchronously, but the print dialog must
 * not open in the same task as the signal that filled the sheet, or a browser
 * can capture the page before the portal's nodes are laid out. Yielding once is
 * what guarantees the sheet exists by the time the dialog reads it.
 *
 * Nothing is awaited and nothing is reported back, because there is nothing to
 * report: `print()` returns identically whether the person printed, saved a PDF
 * or cancelled. The caller decides what to do about that; see the Print button.
 */
export function createTicketPrinter() {
  const [doc, setDoc] = createSignal<TicketDoc | null>(null);

  const print = (next: TicketDoc) => {
    setDoc(next);
    setTimeout(() => {
      platform.print();
      // Cleared afterwards so a stray Ctrl+P later prints the app rather than
      // whatever slip happened to have been printed last.
      setDoc(null);
    }, 0);
  };

  return { doc, print };
}

/**
 * Turn a round on a check into the ticket for it.
 *
 * Everything `renderTicket` needs is already on the tablet — the round carries
 * its number, its time, who sent it and its lines; the check carries the table.
 * So this costs no request, which matters on the screen where a waiter is
 * standing at a table.
 */
export function ticketForRound(
  check: CheckDetail,
  round: RoundDetail,
  tzOffsetMinutes: number,
): TicketDoc {
  return renderTicket(
    {
      kind: 'ticket',
      seq: round.seq,
      tableName: check.tableName,
      staffName: round.sentByName,
      atMs: Date.parse(round.sentAt),
      /*
       * Every line of the round, including any since voided — the same rule the
       * Worker follows when it renders for the agent. A void notice refers to a
       * slip the kitchen is holding, so a ticket that quietly omitted the line
       * would be a strike-off for something they were never told to cook.
       */
      lines: round.items.map((item) => ({
        name: item.nameSnapshot,
        qty: item.qty,
        note: item.note,
      })),
    },
    tzOffsetMinutes,
  );
}

export function PrintSheet(props: { doc: TicketDoc | null }) {
  return (
    <Portal>
      <div class="print-sheet">
        <Show when={props.doc}>
          {(doc) => (
            <div class="ticket">
              <div class="ticket-head">
                <Show when={doc().kind === 'void'}>
                  <div class="ticket-table">{WORDS.voidHeader}</div>
                </Show>
                <div class="ticket-table">
                  {doc().table === null ? WORDS.takeaway : WORDS.table(doc().table as string)}
                </div>
                <div class="ticket-round">{WORDS.round(doc().seq)}</div>
                <div class="ticket-meta">
                  {doc().time} {WORDS.staff(doc().staff)}
                </div>
              </div>

              <hr class="ticket-rule" />

              <For each={doc().lines}>
                {(line) => (
                  <div class="ticket-line">
                    <span class="ticket-qty">{line.qty}</span>
                    <span>{line.name}</span>
                    <Show when={line.note}>
                      {(note) => <span class="ticket-note">* {note()}</span>}
                    </Show>
                  </div>
                )}
              </For>

              <hr class="ticket-rule" />
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}
