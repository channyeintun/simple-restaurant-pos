import { type CheckDetail, type Product, roundTiming } from '@pos/shared';
import { useNavigate, useParams } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { ApiError } from '../../api/client.js';
import { deliverRound, markRoundPrinted, sendRound, voidItem } from '../../api/orders.js';
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
  TextField,
} from '../../components/ui.js';
import { createNow } from '../../lib/clock.js';
import { queryKeys, useCategories, useCheck, useProducts, useTableCheck, useTables } from '../../lib/queries.js';
import { useApp } from '../../state/app.js';
import {
  type Slot,
  addProduct,
  adoptCheckSlot,
  beginSend,
  changeQty,
  clearDraft,
  discardPending,
  draftFor,
  draftTotalMinor,
  sendSucceeded,
  setNote,
} from '../../state/cart.js';
import { useLocale } from '../../state/locale.js';

/**
 * The right pane: what this table has already eaten, what is being added, and
 * one button.
 *
 * The layout is the brief's and is not negotiable. Category chips, then product
 * tiles at least 100×100 with the whole tile tappable, then a cart that is
 * **always visible below them** — not behind an icon, not on a review screen,
 * and with no "are you sure" between it and the kitchen. A waiter is standing
 * at a table with somebody waiting; every screen between the tap and the
 * printer is a screen they have to get past forty times a shift.
 *
 * ## Three ways to be here
 *
 * A table, an open takeaway check, or a new takeaway. They differ in exactly
 * two places — what the check panel reads, and what `sendRound` is told — so
 * the {@link Slot} is resolved once at the top and everything below it is the
 * same screen.
 *
 * ## What happens when a send is not confirmed
 *
 * The hard case, and the one the whole cart store is shaped around. If the
 * request commits and the reply is lost, this tablet cannot tell that from a
 * request that never arrived — and the two need opposite responses. So the cart
 * freezes, a banner appears that says *could not confirm* rather than *failed*,
 * and Try again re-sends **the same key**, which the Worker recognises as the
 * same tap and answers with the round it already has. Discard is behind a
 * confirmation that says the kitchen may already have it, because that is the
 * one thing the person pressing it needs to know.
 */
const ORDER_PANE_TITLE_ID = 'waiter-order-pane-title';

export function OrderPane() {
  const { m } = useLocale();
  const app = useApp();
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /* ------------------------------------------------------------ the slot */

  /**
   * Which of the three this is.
   *
   * Read from the route rather than passed in, so that the left pane can
   * navigate and this pane simply follows — and so a waiter who reloads on
   * `/waiter/table/tbl_4` lands back where they were, with the draft that is
   * already in storage.
   */
  const slot = createMemo<Slot>(() => {
    if (params.tableId) return { kind: 'table', tableId: params.tableId };
    if (params.checkId) return { kind: 'check', checkId: params.checkId };
    return { kind: 'takeaway' };
  });

  /* ----------------------------------------------------------- the check */

  const tableCheck = useTableCheck(() => params.tableId ?? null);
  const namedCheck = useCheck(() => params.checkId ?? null);

  /**
   * The check on screen, whichever way we got here.
   *
   * Two queries rather than one, because the two routes ask different
   * questions: a table's check is looked up *by table* and may legitimately be
   * nothing, while a takeaway check is named and must exist. Only one of them
   * is ever enabled — each is gated on the parameter that selects it — so this
   * is one request, not two.
   *
   * A new takeaway has no check at all until the first round is sent, which is
   * the `null` below and the reason the panel above the cart is behind a
   * `Show`.
   */
  const check = createMemo<CheckDetail | null>(() => {
    if (params.tableId) return tableCheck.data ?? null;
    if (params.checkId) return namedCheck.data ?? null;
    return null;
  });

  const draft = () => draftFor(slot());
  const pending = () => draft().pending;

  /* ------------------------------------------------------------- the name */

  /**
   * What this pane is about, in the fewest words that are true.
   *
   * Three sources because there are three ways to be here and they do not all
   * have the same thing to hand. A table with a check open gets its name off
   * the check, which is already loaded; a table with no check yet has no check
   * to read, so the floor is consulted — `useTables` is cached for five
   * minutes and every screen in this tree already holds it, so this is a cache
   * hit rather than a request. A takeaway has no table at all and says so.
   *
   * The fallback is the word "Order" rather than an empty string. An empty
   * heading is worse than a vague one: it is what `aria-labelledby` would then
   * be pointing at, and a pane labelled by nothing is a pane a screen reader
   * announces as nothing at all.
   */
  const tables = useTables();
  const paneTitle = createMemo(() => {
    if (slot().kind === 'takeaway') return m().waiter.takeaway;
    // A check that has loaded already knows: a null `tableName` is what a
    // counter sale looks like on the wire, which is the same reading the
    // cashier's check view takes of the same field.
    const current = check();
    if (current) return current.tableName ?? m().waiter.takeaway;
    const tableId = params.tableId;
    if (tableId) {
      const match = (tables.data ?? []).find((table) => table.id === tableId);
      if (match) return match.name;
    }
    return m().waiter.order;
  });

  /* ------------------------------------------------------------ the menu */

  const categories = useCategories();
  const products = useProducts();
  const [category, setCategory] = createSignal<string | null>(null);

  /*
   * Open on the first category rather than on "all".
   *
   * The brief asks for chips *then* tiles, which means the tiles are always a
   * category's worth — and "all" on a hundred-item menu is a grid nobody can
   * find anything in. `on(..., { defer: false })` so it lands before the first
   * paint of the grid rather than after it.
   */
  createEffect(
    on(
      () => categories.data,
      (loaded) => {
        if (category() === null && loaded && loaded.length > 0) setCategory(loaded[0]!.id);
      },
    ),
  );

  const visible = createMemo(() => {
    const chosen = category();
    return (products.data ?? []).filter((product) => product.categoryId === chosen);
  });

  /** How many of each product are in the cart, for the badge on the tile. */
  const counts = createMemo(() => {
    const map = new Map<string, number>();
    for (const line of draft().lines) {
      map.set(line.productId, (map.get(line.productId) ?? 0) + line.qty);
    }
    return map;
  });

  /* ------------------------------------------------------------- sending */

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /**
   * True once a send has gone out and not come back with an answer.
   *
   * Seeded from the draft rather than from `false`, and re-seeded whenever the
   * slot changes, because this screen can now be left. A pane head with a way
   * out means a waiter can walk away from an unconfirmed send and come back to
   * it — and a bare `createSignal(false)` would have lost the banner on the
   * way, leaving the frozen cart with no explanation and the Send button
   * reading "Send to kitchen" for a round that may already be cooking.
   *
   * The draft is where the truth was all along: `beginSend` puts the client
   * key on it and only a confirmed send or an explicit discard takes it off,
   * and it is in this tablet's storage, so it survives the unmount that the
   * signal does not.
   */
  const [unconfirmed, setUnconfirmed] = createSignal(draftFor(slot()).pending !== null);
  createEffect(
    on(slot, (current) => setUnconfirmed(draftFor(current).pending !== null), { defer: true }),
  );

  const send = async () => {
    const current = slot();
    const lines = draft().lines;
    if (lines.length === 0 || busy()) return;

    setBusy(true);
    setError(null);
    // Minted here, once, and re-used by every retry: `beginSend` keeps whatever
    // key is already on the draft. This is the line that decides whether a
    // retry is a retry or a second dinner.
    const clientKey = beginSend(current);

    try {
      const detail = await sendRound({
        tableId: current.kind === 'table' ? current.tableId : null,
        checkId: current.kind === 'check' ? current.checkId : null,
        clientKey,
        items: lines.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          note: line.note,
        })),
      });

      sendSucceeded(current);
      setUnconfirmed(false);
      adopt(detail);

      // A new takeaway has become a check with an id, so the pane and the draft
      // both move onto it. Without this the waiter would tap `New takeaway`
      // again to add a drink and open a second bill for one customer.
      if (current.kind === 'takeaway') {
        adoptCheckSlot(detail.id);
        /*
         * Only if the waiter is still here.
         *
         * `useNavigate`'s navigator belongs to the router, not to this
         * component, and Solid does not cancel an async continuation when a
         * component goes away — so without this guard, walking out of a
         * takeaway mid-send drags the waiter back into the pane they just
         * left, seconds later, with no idea why. Everything above this line
         * still runs either way: the draft and the cache should settle whether
         * or not anybody is looking at them.
         */
        if (slot().kind === 'takeaway') {
          navigate(`/waiter/check/${detail.id}`, { replace: true });
        }
      }
    } catch (thrown) {
      /*
       * The fork this whole flow exists for.
       *
       * A 4xx is the Worker having read the request and refused it: the round
       * did not land, the message says why, and the key can go. Anything else —
       * a dropped connection, a 5xx, a timeout — means we do not know, and the
       * only safe assumption is that it might have worked. Those keep the key
       * and raise the banner.
       */
      const refused =
        thrown instanceof ApiError && thrown.status >= 400 && thrown.status < 500;
      if (refused) {
        discardPending(current);
        setError(thrown.message);
      } else {
        setUnconfirmed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Put a check the server has just handed us into every place that shows one.
   *
   * Never an invalidation. The response is the check, complete and current, so
   * refetching it would be a second request for something already in hand — on
   * the screen where somebody is waiting to walk to the next table. The board
   * is patched in the same breath, because the tables grid is drawn from it.
   */
  const adopt = (detail: CheckDetail) => {
    queryClient.setQueryData(queryKeys.check(detail.id), detail);
    if (detail.tableId) queryClient.setQueryData(queryKeys.tableCheck(detail.tableId), detail);
    void queryClient.invalidateQueries({ queryKey: queryKeys.openChecks });
  };

  /**
   * Mark a round as carried to the table.
   *
   * Goes through the same `adopt` as everything else, so the round's clock
   * stops on this screen and the table's tile in the pane beside it loses its
   * timer in the same frame — they are two views of one cached check.
   */
  const deliver = async (roundId: string) => {
    const current = check();
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      adopt(await deliverRound(current.id, roundId));
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : m().errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const strike = async (itemId: string) => {
    const current = check();
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

  /* -------------------------------------------------------------- notes */

  const [noteIndex, setNoteIndex] = createSignal<number | null>(null);
  const [noteText, setNoteText] = createSignal('');

  const openNote = (index: number) => {
    setNoteText(draft().lines[index]?.note ?? '');
    setNoteIndex(index);
  };

  const saveNote = () => {
    const index = noteIndex();
    if (index !== null) setNote(slot(), index, noteText());
    setNoteIndex(null);
  };

  /* --------------------------------------------------------------- view */

  const frozen = () => busy() || unconfirmed();

  return (
    <section
      class="card"
      aria-labelledby={ORDER_PANE_TITLE_ID}
      style={{
        flex: '3 1 22rem',
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--pos-gap)',
        'min-height': '0',
      }}
    >
      {/*
        The way out, and the answer to "which table is this".

        Both were missing, and the second is the one that could cost money: the
        brief forbids a confirmation on Send, so the moment the tables grid is
        not on screen — which is the whole stacked layout — a waiter taps Send
        with nothing in front of them naming the destination.

        `navigate` rather than the history back the tablet does not have. An
        installed app in standalone mode has no browser chrome, and iPadOS has
        no system back gesture either, so going back has to be something this
        screen draws. Going to `/waiter` is also the honest thing rather than
        the convenient one: a waiter may have arrived here from another table,
        from a reload, or from a link, and stepping back through that history
        would land them somewhere different each time.
      */}
      <PaneHead
        backLabel={m().waiter.backToTables}
        onBack={() => navigate('/waiter')}
        title={paneTitle()}
        titleId={ORDER_PANE_TITLE_ID}
      />
      {/* What has already gone to the kitchen. Collapses to a single total line
          once the cart has something in it, so the thing being built is what is
          on screen — but it never disappears, because a waiter adding a second
          round has to be able to see the first. */}
      <Show when={check()}>
        {(current) => (
          <SentRounds
            check={current()}
            busy={busy()}
            onVoid={strike}
            onDeliver={(roundId) => void deliver(roundId)}
          />
        )}
      </Show>

      <Show when={!categories.isPending} fallback={<Spinner />}>
        <ChipSet ariaLabel={m().backoffice.fields.category}>
          <For each={categories.data ?? []}>
            {(entry) => (
              <Chip
                label={entry.name}
                selected={category() === entry.id}
                onClick={() => setCategory(entry.id)}
              />
            )}
          </For>
        </ChipSet>
      </Show>

      {/* The product grid scrolls; the cart below does not move with it. */}
      <div style={{ flex: '1 1 auto', 'min-height': '4rem', overflow: 'auto' }}>
        <Show
          when={visible().length > 0}
          fallback={
            <p class="screen-body" style={{ margin: '0' }}>
              {m().waiter.noProducts}
            </p>
          }
        >
          {/* `--pos-tile-lg`, not the 100px floor: see the token for why the
              brief's minimum is the wrong number to lay a grid out on. */}
          <div class="grid" style={{ '--pos-grid-min': 'var(--pos-tile-lg)' }}>
            <For each={visible()}>
              {(product: Product) => (
                <button
                  type="button"
                  class="tile product-tile"
                  style={{ position: 'relative' }}
                  disabled={frozen()}
                  onClick={() => addProduct(slot(), product)}
                >
                  <span class="product-tile-name">{product.name}</span>
                  <span class="product-tile-price money">{app.money(product.priceMinor)}</span>
                  <Show when={counts().get(product.id)}>
                    {(count) => <span class="product-tile-count">{count()}</span>}
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/*
        The cart. `margin-top: auto` pins it to the bottom of the pane as a row
        in the column rather than positioning it over one, so it cannot overlap
        the tiles and cannot be scrolled away from.
      */}
      <div
        style={{
          'margin-top': 'auto',
          'min-height': 'var(--pos-cart-min-h)',
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          padding: 'var(--pos-gap)',
          'border-radius': 'var(--pos-radius-row)',
          background: 'var(--md-sys-color-surface-container)',
        }}
      >
        <Show when={error()}>{(message) => <ErrorBanner>{message()}</ErrorBanner>}</Show>

        <Show when={unconfirmed()}>
          <div class="error-banner" role="alert">
            <strong>{m().waiter.unconfirmed}</strong>
            <br />
            {m().waiter.unconfirmedBody}
          </div>
        </Show>

        <div style={{ flex: '1 1 auto', 'min-height': '0', overflow: 'auto' }}>
          <Show
            when={draft().lines.length > 0}
            fallback={
              <p class="screen-body" style={{ margin: '8px 0' }}>
                {m().waiter.orderEmpty}
              </p>
            }
          >
            {/*
              Keyed by the line object's identity, which is what `For` does by
              default. Keying by product id plus note would remount a row when
              its note changed and take the focus with it, which is exactly the
              moment somebody is typing.
            */}
            <For each={draft().lines}>
              {(line, index) => (
                <div class="cart-line">
                  <div class="cart-stepper">
                    <button
                      type="button"
                      class="cart-step"
                      disabled={frozen()}
                      aria-label="−"
                      onClick={() => changeQty(slot(), index(), -1)}
                    >
                      −
                    </button>
                    <span class="cart-qty">{line.qty}</span>
                    <button
                      type="button"
                      class="cart-step"
                      disabled={frozen()}
                      aria-label="+"
                      onClick={() => changeQty(slot(), index(), 1)}
                    >
                      +
                    </button>
                  </div>

                  <div style={{ display: 'flex', 'flex-direction': 'column', 'min-width': '0' }}>
                    <span class="cart-line-name">{line.name}</span>
                    <button
                      type="button"
                      class="cart-note"
                      disabled={frozen()}
                      onClick={() => openNote(index())}
                    >
                      {line.note ?? `+ ${m().waiter.note}`}
                    </button>
                  </div>

                  <span class="cart-line-total money">
                    {app.money(line.priceMinor * line.qty)}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="send-bar">
          <div class="send-total">
            <span class="send-total-value">{app.money(draftTotalMinor(slot()))}</span>
            <span class="stat-label">{m().waiter.total}</span>
          </div>

          <div style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
            <Show when={pending() && !busy()}>
              <ConfirmButton
                headline={m().waiter.discardHeadline}
                body={m().waiter.discardBody}
                confirmLabel={m().waiter.discard}
                onConfirm={() => {
                  discardPending(slot());
                  setUnconfirmed(false);
                }}
              >
                {m().waiter.discard}
              </ConfirmButton>
            </Show>

            {/*
              Gated on the **draft**, not on the banner.

              `unconfirmed()` is this component's memory of an unanswered send;
              `pending()` is the client key sitting on the draft in storage,
              which is the thing that actually decides what the next Send
              means. The two agree until somebody leaves the pane and comes
              back, and the gap between them was a way to send the wrong food:
              clear the cart, tap in something different, press Send, and the
              key from the *first* order goes out with it — so the Worker
              recognises the repeat and cheerfully answers with the round it
              already has, while the new items are never cooked and nothing on
              screen says so.

              Reading the persisted fact closes that, and it closes it whether
              or not the banner survived the trip.
            */}
            <Show when={draft().lines.length > 0 && !pending()}>
              <ConfirmButton
                headline={m().waiter.clearHeadline}
                body={m().waiter.clearBody}
                confirmLabel={m().waiter.clear}
                disabled={busy()}
                onConfirm={() => clearDraft(slot())}
              >
                {m().waiter.clear}
              </ConfirmButton>
            </Show>

            {/*
              One button, and no confirmation on it — the brief says so in as
              many words.

              It says **Try again** while a send is unconfirmed, because that is
              what pressing it does: the key on the draft is unchanged, so the
              Worker recognises the repeat and answers with the round it already
              has. Leaving it reading "Send to kitchen" under a banner that says
              to try again would make the two disagree about whether this is a
              second order, which is the one thing the person pressing it needs
              to be sure about.
            */}
            <Button
              disabled={draft().lines.length === 0 || busy()}
              onClick={() => void send()}
            >
              {busy()
                ? m().waiter.sending
                : unconfirmed()
                  ? m().app.retry
                  : m().waiter.send}
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={noteIndex() !== null}
        onClose={() => setNoteIndex(null)}
        headline={m().waiter.note}
        actions={
          <>
            <Button variant="text" onClick={() => setNoteIndex(null)}>
              {m().app.cancel}
            </Button>
            <Button onClick={saveNote}>{m().backoffice.save}</Button>
          </>
        }
      >
        <div class="form">
          <TextField
            label={m().waiter.note}
            value={noteText()}
            onChange={setNoteText}
            supportingText={m().waiter.noteHint}
            maxLength={120}
          />
        </div>
      </Dialog>
    </section>
  );
}

/**
 * What this check has already sent to the kitchen.
 *
 * Every round, in order, with its lines — and a Void on each live one. Voiding
 * is the second of the app's two confirmed actions and the dialog names the
 * consequence rather than restating the button: the line comes off the bill and
 * the kitchen gets a slip saying so, because they are currently holding one
 * that says to cook it.
 *
 * A voided line stays on screen, struck through. It is on the bill's paper
 * trail and removing it would make the check disagree with the piece of paper
 * the kitchen has.
 */
function SentRounds(props: {
  check: CheckDetail;
  busy: boolean;
  onVoid(itemId: string): void;
  onDeliver(roundId: string): void;
}) {
  const { m } = useLocale();
  const app = useApp();
  const now = createNow();
  const printer = createTicketPrinter();

  /**
   * Put this round's ticket on paper, then tell the Worker it happened.
   *
   * The ack is fired and forgotten on purpose. It is bookkeeping — it stops the
   * cashier's stuck-queue banner sitting amber and stops an agent reprinting
   * the backlog later — and a waiter standing at a table with a slip in their
   * hand should not be shown an error about it. If it fails the job stays
   * pending, which is the state it was already in.
   */
  const printRound = (round: CheckDetail['rounds'][number]) => {
    printer.print(ticketForRound(props.check, round, app.config().tzOffsetMinutes));
    void markRoundPrinted(round.id).catch(() => {});
  };

  /**
   * Where this round stands, recomputed as the clock ticks.
   *
   * The target came from the Worker, which built it with the Rust twin of
   * `roundTargetMinutes` — so the number the waiter reads out and the number
   * the server believes are one value rather than two that agree today.
   */
  const timing = (round: CheckDetail['rounds'][number]) =>
    roundTiming({
      sentAtMs: Date.parse(round.sentAt),
      deliveredAtMs: round.deliveredAt === null ? null : Date.parse(round.deliveredAt),
      targetMinutes: round.targetMinutes,
      nowMs: now(),
    });

  return (
    <div style={{ 'max-height': '45%', overflow: 'auto' }}>
      <PrintSheet doc={printer.doc()} />
      <For each={props.check.rounds}>
        {(round) => (
          <div class="sent-round" data-state={timing(round).state}>
            <div class="sent-round-head">
              <span>{m().waiter.round(round.seq)}</span>
              <span>{m().waiter.sentAt(app.clock(round.sentAt))}</span>
              <span>{round.sentByName}</span>
            </div>

            {/*
              The line the waiter reads out loud, and the button that ends it.

              A delivered round says how long it took and stops there — there is
              nothing left to do about it, and the elapsed number is what a
              manager would want later. One that is still out counts down to
              what was promised, then up past it.
            */}
            <div class="round-timing" data-state={timing(round).state}>
              <Show
                when={round.deliveredAt === null}
                fallback={
                  <>
                    <span class="badge" data-tone="ok">
                      {m().timing.delivered}
                    </span>
                    <span>{m().timing.took(timing(round).elapsedMinutes)}</span>
                    <Show when={round.deliveredByName}>
                      {(carrier) => <span>{carrier()}</span>}
                    </Show>
                    <Button variant="text" onClick={() => printRound(round)}>
                      {m().timing.print}
                    </Button>
                  </>
                }
              >
                <span>
                  {timing(round).remainingMinutes > 0
                    ? m().timing.readyIn(timing(round).remainingMinutes)
                    : timing(round).remainingMinutes === 0
                      ? m().timing.readyNow
                      : m().timing.overdueBy(Math.abs(timing(round).remainingMinutes))}
                </span>
                <Show when={timing(round).state === 'late'}>
                  <span class="badge" data-tone="warn">
                    {m().timing.late}
                  </span>
                </Show>
                {/*
                  Print sits before Delivered, in the order the two things
                  happen: the slip goes to the kitchen, the food comes back.
                  It stays available after delivery too — a round whose ticket
                  was lost is exactly the one somebody needs to print again.
                */}
                <Button variant="text" onClick={() => printRound(round)}>
                  {m().timing.print}
                </Button>
                <Button
                  variant="tonal"
                  disabled={props.busy}
                  onClick={() => props.onDeliver(round.id)}
                >
                  {m().timing.delivered}
                </Button>
              </Show>
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
                    when={!item.voidedAt}
                    fallback={<span class="badge">{m().waiter.voided}</span>}
                  >
                    <ConfirmButton
                      headline={m().waiter.voidHeadline}
                      body={m().waiter.voidBody(item.nameSnapshot)}
                      confirmLabel={m().waiter.void}
                      disabled={props.busy}
                      onConfirm={() => props.onVoid(item.id)}
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
  );
}
