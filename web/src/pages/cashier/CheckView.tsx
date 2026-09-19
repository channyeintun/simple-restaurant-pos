import { type CheckDetail, type PaymentMethod, paymentMethodSchema } from '@pos/shared';
import { useNavigate, useParams } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createSignal } from 'solid-js';
import { ApiError } from '../../api/client.js';
import { markRoundPrinted, payCheck, voidItem } from '../../api/orders.js';
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

  const settle = async () => {
    const current = check.data;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const paid = await payCheck(current.id, method(), current.totalMinor);
      adopt(paid);
      setPaying(false);
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
                        <div class="sent-line" data-voided={item.voidedAt ? 'true' : 'false'}>
                          <span class="sent-line-qty">{item.qty}</span>
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
                          </span>
                          <span class="money">
                            {app.money(item.priceMinorSnapshot * item.qty)}
                          </span>
                          <Show
                            when={!item.voidedAt && detail().status === 'open'}
                            fallback={
                              <Show when={item.voidedAt}>
                                <span class="badge">{m().waiter.voided}</span>
                              </Show>
                            }
                          >
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
              <div class="send-total">
                <span class="send-total-value">{app.money(detail().totalMinor)}</span>
                <span class="stat-label">{m().waiter.total}</span>
              </div>
              <Show
                when={detail().status === 'open'}
                fallback={<span class="badge" data-tone="ok">{m().cashier.paid}</span>}
              >
                <Button disabled={busy()} onClick={() => setPaying(true)}>
                  {m().cashier.takePayment}
                </Button>
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
                  <span class="stat-value money">{app.money(detail().totalMinor)}</span>
                  <span class="stat-label">{m().waiter.total}</span>
                </div>
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
