import {
  type CheckDetail,
  type PaymentMethod,
  paymentMethodSchema,
  pickedTotalMinor,
} from '@pos/shared';
import { useNavigate, useParams } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createMemo, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { ApiError } from '../../api/client.js';
import { markRoundPrinted, payCheck, payItems, voidItem } from '../../api/orders.js';
import { PrintSheet, createTicketPrinter, ticketForRound } from '../../components/PrintSheet.js';
import {
  Button,
  Chip,
  ChipSet,
  ConfirmButton,
  Dialog,
  ErrorBanner,
  PaneHead,
  Spinner,
} from '../../components/ui.js';
import { queryKeys, useCheck } from '../../lib/queries.js';
import { useApp } from '../../state/app.js';
import { forgetSlot } from '../../state/cart.js';
import { beginPayment, paymentSucceeded } from '../../state/payment.js';
import { useLocale } from '../../state/locale.js';

const METHODS: PaymentMethod[] = paymentMethodSchema.options;

/**
 * One check, opened from the board: what is on it, and how it gets settled.
 *
 * Three things can happen here and the brief names all three — void a line,
 * take payment, close — and the second and third are one act, because a check
 * closes *because* it was paid. There is no separate Close button and there
 * should not be one: a check that could be closed without a payment is a way
 * for a table's food to leave the building with nothing recorded against it.
 *
 * That paragraph was false for as long as this screen carried a button saying
 * **Close** in its top corner. It only ever went back to the board, but it was
 * the product's own word for settling a check, in the same card as Take
 * payment, on the one screen where closing a check moves money. It now says
 * where it goes — Back to checks — and the paragraph above is true again.
 *
 * ## Why the payment carries a total the cashier has already seen
 *
 * Because they are holding the money. A cashier reads a figure off this screen,
 * counts out change, and taps — and in between, a waiter at the table can send
 * another round or strike a line off. `expectedTotalMinor` is what was on
 * screen when the button was pressed, and the Worker refuses to charge anything
 * else: the 409 comes back with the new figure in it, this screen shows it, and
 * the person with the cash gets to agree to the new number rather than discover
 * it on the receipt.
 */
const CHECK_PANE_TITLE_ID = 'cashier-check-pane-title';

/**
 * Is there anything on this check worth splitting?
 *
 * Two or more unpaid **units**, not two or more lines: a single line of four
 * beers is the case this whole feature exists for, and a check with one dish
 * left on it has nothing to divide. Offering the control there would be a
 * button that leads to a screen where the only possible pick is the one the
 * other button already makes.
 */
function splittable(detail: CheckDetail): boolean {
  let units = 0;
  for (const round of detail.rounds) {
    for (const item of round.items) {
      if (item.voidedAt) continue;
      units += item.qty - item.qtyPaid;
      if (units > 1) return true;
    }
  }
  return false;
}

export function CashierCheck() {
  const { m } = useLocale();
  const app = useApp();
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const check = useCheck(() => params.checkId ?? null);

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [paying, setPaying] = createSignal(false);
  const [method, setMethod] = createSignal<PaymentMethod>('cash');
  const printer = createTicketPrinter();

  /* ------------------------------------------------------- picking lines */

  /**
   * Whether the bill is being read or picked from, and what has been picked.
   *
   * A mode rather than a control on every row, because the bill is read far
   * more often than it is split: a cashier settling a whole table should not
   * have to look past four checkboxes to find the total. Tapping Pay some items
   * turns the lines into buttons; Cancel turns them back.
   *
   * The picks are quantities, keyed by item id — `{ itm_x: 2 }` — because a
   * line can be settled two now and two later. A line missing from the record
   * is a line nobody has picked, which is the same thing as zero and avoids a
   * map full of zeroes after somebody changes their mind.
   */
  const [picking, setPicking] = createSignal(false);
  const [picks, setPicks] = createStore<Record<string, number>>({});

  const unpaidQty = (item: CheckDetail['rounds'][number]['items'][number]) =>
    item.voidedAt ? 0 : item.qty - item.qtyPaid;

  /**
   * One tap on a line: take the whole thing, then give it back a unit at a
   * time.
   *
   * The first tap picks **all** of the line's unpaid units, because "this
   * dish is mine" is what almost every tap means. Tapping again hands one back,
   * so a four-beer line a table wants to split three-one is four taps rather
   * than a stepper on every row of every bill — and the last tap drops it to
   * nothing, which is also how somebody undoes a mis-tap.
   *
   * A stepper per line would be two more controls on a row that already has a
   * quantity, a name, a price and a Void, on the narrowest pane in the app.
   */
  const tapLine = (item: CheckDetail['rounds'][number]['items'][number]) => {
    const available = unpaidQty(item);
    if (available <= 0) return;
    const current = picks[item.id] ?? 0;
    const next = current === 0 ? available : current - 1;
    setPicks(item.id, next);
  };

  const pickedLines = createMemo(() => {
    const current = check.data;
    if (!current) return [];
    return current.rounds
      .flatMap((round) => round.items)
      .filter((item) => (picks[item.id] ?? 0) > 0)
      .map((item) => ({ item, qty: picks[item.id] ?? 0 }));
  });

  /**
   * What the picked units come to.
   *
   * `pickedTotalMinor` — the twin of the Worker's own `picked_total_minor`, so
   * the figure on the button and the figure charged are the same rule applied
   * twice rather than two opinions. The Worker prices it again from its own
   * snapshots and refuses if the two disagree.
   */
  const pickedTotal = createMemo(() =>
    pickedTotalMinor(
      pickedLines().map(({ item, qty }) => ({
        priceMinorSnapshot: item.priceMinorSnapshot,
        qty,
      })),
    ),
  );

  const stopPicking = () => {
    setPicks(reconcile({}));
    setPicking(false);
  };

  /** What this dialog is about to charge: the picks, or everything still owed. */
  const amountDue = () => (picking() ? pickedTotal() : (check.data?.outstandingMinor ?? 0));

  /**
   * Print a round's kitchen ticket from the till.
   *
   * The same button the waiter has, on the screen that is actually next to a
   * printer. While there is no agent, this is how a round that the waiter could
   * not print — a tablet with nothing to print to, a slip that jammed — still
   * reaches the kitchen: the cashier opens the check and prints it.
   *
   * The ack is fired and forgotten for the same reason as on the waiter's pane:
   * it is bookkeeping, and somebody holding a slip should not be shown an error
   * about it.
   */
  const printRound = (round: CheckDetail['rounds'][number]) => {
    const current = check.data;
    if (!current) return;
    printer.print(ticketForRound(current, round, app.config().tzOffsetMinutes));
    void markRoundPrinted(round.id).catch(() => {});
  };

  /**
   * Adopt a check the server has just handed back.
   *
   * The response *is* the check — every route that changes one answers with the
   * whole thing — so this is a write rather than a refetch. The board is
   * invalidated rather than patched because a payment removes a card from it
   * and a void changes a total on it, and the board is one list read by two
   * screens; letting it refetch once is simpler than reproducing the reducer
   * here.
   */
  const adopt = (detail: CheckDetail) => {
    queryClient.setQueryData(queryKeys.check(detail.id), detail);
    if (detail.tableId) queryClient.setQueryData(queryKeys.tableCheck(detail.tableId), detail);
    void queryClient.invalidateQueries({ queryKey: queryKeys.openChecks });
  };

  const strike = async (itemId: string) => {
    const current = check.data;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      adopt(await voidItem(current.id, itemId));
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : m().errors.generic);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Take the money, for the picks or for the rest of the table.
   *
   * One function for both, because everything around the request is identical
   * and the two differing in their error handling is how one of them ends up
   * with a bug the other does not have.
   *
   * The whole-check path still sends the check's own figure and gets a 409 if
   * it has moved. The per-item path sends a **client key** as well, taken from
   * this tablet's storage rather than minted here, so that a retry after a lost
   * reply is recognised as the same tap instead of charging the table twice.
   */
  const settle = async () => {
    const current = check.data;
    if (!current) return;
    if (picking() && pickedLines().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const paid = picking()
        ? await payItems(
            current.id,
            method(),
            pickedLines().map(({ item, qty }) => ({ itemId: item.id, qty })),
            pickedTotal(),
            beginPayment(current.id),
          )
        : await payCheck(current.id, method(), current.outstandingMinor);
      // Both at once and only here. A key let go while the picks survive
      // re-charges the same dishes; picks dropped while the key survives take
      // nothing at all on the next tap, because the Worker answers the repeat
      // with the check it already settled.
      paymentSucceeded(current.id);
      adopt(paid);
      setPaying(false);
      stopPicking();

      // Still open: somebody at this table has not paid yet. Stay on the check
      // — the cashier is very often about to take the next person's money, and
      // bouncing them to the board to walk straight back in is two taps for
      // nothing.
      if (paid.status === 'open') {
        setBusy(false);
        return;
      }
      /*
       * Any draft still attached to this check is gone with it. A waiter who
       * had a half-tapped second round open on a table that has just been paid
       * would otherwise send it onto a settled check and be told, correctly but
       * uselessly, that it is no longer open.
       */
      forgetSlot({ kind: 'check', checkId: current.id });
      navigate('/cashier', { replace: true });
    } catch (thrown) {
      /*
       * The 409 is the interesting one and its message carries the new total,
       * so it is shown as it stands. The check is refetched underneath it, so
       * the figure on screen catches up with the figure in the message before
       * the cashier presses anything again.
       */
      setError(thrown instanceof ApiError ? thrown.message : m().errors.generic);
      void queryClient.invalidateQueries({ queryKey: queryKeys.check(current.id) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      class="card"
      aria-labelledby={CHECK_PANE_TITLE_ID}
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--pos-gap)',
        'min-height': '0',
      }}
    >
      {/*
        Outside the fetch guard, deliberately.

        A back control that only exists once the request has resolved is
        missing from the one moment it is most wanted: a check that is slow to
        load, or that failed to, on a till with a queue at it. The title says
        so instead — it is the only part of this row that has to wait for data.
      */}
      <PaneHead
        backLabel={m().cashier.backToChecks}
        onBack={() => navigate('/cashier')}
        title={
          check.data ? (check.data.tableName ?? m().waiter.takeaway) : m().app.loading
        }
        titleId={CHECK_PANE_TITLE_ID}
      >
        <Show when={check.data}>
          {(detail) => (
            <p class="stat-label" style={{ margin: '0', 'white-space': 'nowrap' }}>
              {detail().openedByName} · {app.clock(detail().openedAt)}
            </p>
          )}
        </Show>
      </PaneHead>

      <Show when={check.data} fallback={<Spinner />}>
        {(detail) => (
          <>
            <Show when={error()}>{(message) => <ErrorBanner>{message()}</ErrorBanner>}</Show>

            <div style={{ flex: '1 1 auto', 'min-height': '0', overflow: 'auto' }}>
              <PrintSheet doc={printer.doc()} />
              <For each={detail().rounds}>
                {(round) => (
                  <div class="sent-round">
                    <div class="sent-round-head">
                      <span>{m().waiter.round(round.seq)}</span>
                      <span>{m().waiter.sentAt(app.clock(round.sentAt))}</span>
                      <span>{round.sentByName}</span>
                      {/*
                        In the header rather than beside the lines: on this
                        screen the rounds are history the cashier is reading,
                        and Print is about the round as a whole rather than
                        about any line on it.
                      */}
                      <Button variant="text" onClick={() => printRound(round)}>
                        {m().timing.print}
                      </Button>
                    </div>
                    <For each={round.items}>
                      {(item) => (
                        <div
                          class="sent-line"
                          data-voided={item.voidedAt ? 'true' : 'false'}
                          data-picked={(picks[item.id] ?? 0) > 0 ? 'true' : 'false'}
                        >
                          {/*
                            The quantity cell doubles as the pick control while
                            the bill is being split, so a row gains a target
                            rather than a control: it is already the leftmost
                            thing on the line, it is already where the eye goes
                            to count, and `--pos-touch` sizes it past 48px.

                            A `<button>` and not a click handler on the row.
                            The row carries a Void beside it, and a tap that
                            could mean either depending on where it landed is
                            the kind of screen where somebody eventually voids
                            a dish they meant to charge for.
                          */}
                          <Show
                            when={picking() && unpaidQty(item) > 0}
                            fallback={<span class="sent-line-qty">{item.qty}</span>}
                          >
                            <button
                              type="button"
                              class="sent-line-qty pick"
                              aria-pressed={(picks[item.id] ?? 0) > 0}
                              aria-label={m().cashier.pickLine(item.nameSnapshot)}
                              disabled={busy()}
                              onClick={() => tapLine(item)}
                            >
                              {picks[item.id] ?? 0}
                            </button>
                          </Show>
                          <span>
                            {item.nameSnapshot}
                            <Show when={item.note}>
                              {(note) => (
                                <>
                                  {' '}
                                  <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                                    · {note()}
                                  </span>
                                </>
                              )}
                            </Show>
                            {/*
                              What is already settled on this line, said on the
                              line itself. A cashier taking the third person's
                              money has to be able to see which dishes the first
                              two paid for without keeping it in their head.
                            */}
                            <Show when={item.qtyPaid > 0 && !item.voidedAt}>
                              {' '}
                              <span class="badge" data-tone="ok">
                                {item.qtyPaid >= item.qty
                                  ? m().cashier.paid
                                  : m().cashier.paidSome(item.qtyPaid, item.qty)}
                              </span>
                            </Show>
                          </span>
                          <span class="money">
                            {app.money(item.priceMinorSnapshot * item.qty)}
                          </span>
                          {/*
                            Void is hidden while picking. Two controls on one
                            row, one of which takes money and one of which
                            destroys a line, is the arrangement the brief's
                            confirm rule exists to keep apart — and there is
                            nothing to void in the middle of settling anyway.
                          */}
                          <Show
                            when={!item.voidedAt && detail().status === 'open' && !picking()}
                            fallback={
                              <Show when={item.voidedAt}>
                                <span class="badge">{m().waiter.voided}</span>
                              </Show>
                            }
                          >
                            {/*
                              A line with money against it cannot be struck off
                              — there is no refund in this API to undo it with —
                              so the control goes rather than failing on tap.
                            */}
                            <Show when={item.qtyPaid === 0}>
                              <ConfirmButton
                                headline={m().waiter.voidHeadline}
                                body={m().waiter.voidBody(item.nameSnapshot)}
                                confirmLabel={m().waiter.void}
                                disabled={busy()}
                                onConfirm={() => void strike(item.id)}
                              >
                                {m().waiter.void}
                              </ConfirmButton>
                            </Show>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>

            {/*
              The bill, and the one button that ends the task. Same shape as the
              waiter's send bar and the same `--pos-touch-lg` on the button, for
              the same reason: it is pressed while looking at a customer rather
              than at the screen.
            */}
            <div class="send-bar">
              {/*
                What is owed, not what the meal cost.

                The two are the same number on every check nobody has split, and
                the day they differ is the day this figure matters: a cashier
                counting notes against the gross total of a table two of whose
                four diners have already paid takes their money a second time.
                The gross is still on the bill above, where it belongs.
              */}
              <div class="send-total">
                <span class="send-total-value">{app.money(amountDue())}</span>
                <span class="stat-label">
                  {picking()
                    ? m().cashier.picked
                    : detail().outstandingMinor === detail().totalMinor
                      ? m().waiter.total
                      : m().cashier.stillOwed}
                </span>
              </div>
              <Show
                when={detail().status === 'open'}
                fallback={<span class="badge" data-tone="ok">{m().cashier.paid}</span>}
              >
                <Show
                  when={picking()}
                  fallback={
                    <>
                      {/*
                        Offered only when there is more than one thing to
                        divide. A table with a single dish on it has nothing to
                        split, and a control that does nothing is a control
                        somebody has to learn to ignore.
                      */}
                      <Show when={splittable(detail())}>
                        <Button
                          variant="outlined"
                          disabled={busy()}
                          onClick={() => setPicking(true)}
                        >
                          {m().cashier.paySome}
                        </Button>
                      </Show>
                      <Button disabled={busy()} onClick={() => setPaying(true)}>
                        {m().cashier.takePayment}
                      </Button>
                    </>
                  }
                >
                  {/*
                    Cancel is a plain button and not a ConfirmButton: nothing
                    has been taken yet and the picks are a selection, not work.
                  */}
                  <Button variant="text" disabled={busy()} onClick={stopPicking}>
                    {m().app.cancel}
                  </Button>
                  <Button
                    disabled={busy() || pickedLines().length === 0}
                    onClick={() => setPaying(true)}
                  >
                    {m().cashier.paySelected}
                  </Button>
                </Show>
              </Show>
            </div>

            <Dialog
              open={paying()}
              onClose={() => setPaying(false)}
              headline={m().cashier.paymentHeadline(detail().tableName ?? m().waiter.takeaway)}
              actions={
                <>
                  <Button variant="text" disabled={busy()} onClick={() => setPaying(false)}>
                    {m().app.cancel}
                  </Button>
                  <Button disabled={busy()} onClick={() => void settle()}>
                    {busy() ? m().cashier.paying : m().cashier.takePayment}
                  </Button>
                </>
              }
            >
              <div class="form">
                {/*
                  The amount is shown and never typed. It is the check's own
                  total, computed by the Worker; there is deliberately no field
                  here, because a field would be a way for the till to charge a
                  number nobody added up.
                */}
                <div class="stat">
                  <span class="stat-value money">{app.money(amountDue())}</span>
                  <span class="stat-label">
                    {picking()
                      ? m().cashier.picked
                      : detail().outstandingMinor === detail().totalMinor
                        ? m().waiter.total
                        : m().cashier.stillOwed}
                  </span>
                </div>
                {/*
                  What is being paid for, listed. The modal is the only thing on
                  screen while the cash is counted, so the bill behind it cannot
                  be the thing that says which dishes this covers.
                */}
                <Show when={picking()}>
                  <div class="picked-lines">
                    <For each={pickedLines()}>
                      {({ item, qty }) => (
                        <div class="picked-line">
                          <span class="sent-line-qty">{qty}</span>
                          <span>{item.nameSnapshot}</span>
                          <span class="money">
                            {app.money(item.priceMinorSnapshot * qty)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <ChipSet ariaLabel={m().cashier.takePayment}>
                  <For each={METHODS}>
                    {(option) => (
                      <Chip
                        label={m().today[option]}
                        selected={method() === option}
                        onClick={() => setMethod(option)}
                      />
                    )}
                  </For>
                </ChipSet>
              </div>
            </Dialog>
          </>
        )}
      </Show>
    </section>
  );
}
