import { type JSX, Show, createSignal } from 'solid-js';
import { ApiError } from '../../api/client.js';
import { Button, Dialog, ErrorBanner, Spinner } from '../../components/ui.js';
import { useLocale } from '../../state/locale.js';

/**
 * The pieces every backoffice panel is built from.
 *
 * Six lists with one shape between them — a heading with one action on the
 * right, rows that can be edited and retired, a dialog to edit them in — so the
 * shape is written once here and the panels are about their own fields. The
 * alternative is six screens that drift: one where Retire is a text button and
 * one where it is outlined, one that shows a spinner and one that shows nothing,
 * and a manager who has to re-learn the screen every time they change tab.
 *
 * Nothing in this file knows what a product is. It is deliberately all layout
 * and state, which is what makes it safe for the panels to share.
 */

/* --------------------------------------------------------------- feedback */

/**
 * Turn whatever was thrown into something a person can read.
 *
 * `ApiError` already carries a message written for a person — the Worker's
 * envelope is one sentence of plain English — so it is used as it stands. Any
 * other throw is a bug in this repository or a response that did not match its
 * schema, and neither is something the manager standing at the screen can act
 * on, so it gets the catalogue's generic line rather than a stack trace.
 */
function readable(error: unknown, generic: string): string {
  return error instanceof ApiError ? error.message : generic;
}

/**
 * One in-flight write, with its busy flag and its error.
 *
 * Every editor in the backoffice does the same three things — disable the
 * control, send, and either close or show what went wrong — and this is that,
 * once. It is not `useMutation`: there is no cache entry to optimistically
 * update and no retry policy worth having on a button somebody pressed on
 * purpose, so a signal pair is the whole of what is needed and is a great deal
 * easier to read than the alternative.
 *
 * `run` resolving is what counts as success. The caller closes its dialog on
 * `true` and keeps it open on `false`, so the text somebody typed is still
 * there to be corrected — closing a form on failure and making them type it
 * again is the single most annoying thing a form can do.
 */
export function createAction() {
  const { m } = useLocale();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (thrown) {
      setError(readable(thrown, m().errors.generic));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, setError, run };
}

/**
 * What a panel shows while its list is on its way, and if it never arrives.
 *
 * `isPending` and not `isFetching`: the first means "there is nothing to show",
 * the second is also true during the background refresh of a list already on
 * screen, and swapping a list a manager is reading for a spinner because a
 * five-minute timer elapsed is the bug this distinction exists to prevent.
 */
export function QueryView<T>(props: {
  pending: boolean;
  error: Error | null;
  data: T | undefined;
  children: (data: T) => JSX.Element;
}) {
  const { m } = useLocale();

  return (
    <Show when={!props.pending} fallback={<Spinner />}>
      <Show
        when={props.data !== undefined}
        fallback={<ErrorBanner>{readable(props.error, m().errors.generic)}</ErrorBanner>}
      >
        {props.children(props.data as T)}
      </Show>
    </Show>
  );
}

/* ---------------------------------------------------------------- surfaces */

/** The card a panel lives on. */
export function Panel(props: { children: JSX.Element }) {
  return (
    <section
      class="card"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--pos-pane-gap)',
        /* The card is the scroll container, not the page: the tab bar and the
           staff bar stay put while a long product list moves under them. */
        'min-height': '0',
        overflow: 'auto',
      }}
    >
      {props.children}
    </section>
  );
}

export function SectionHead(props: { title: string; actions?: JSX.Element }) {
  return (
    <div class="section-head">
      <h2>{props.title}</h2>
      <Show when={props.actions}>{props.actions}</Show>
    </div>
  );
}

/**
 * A row in an editable list.
 *
 * `data-retired` rather than a class, because it is a state of the row and not
 * a kind of row — the same element, dimmed, with the rest of it (the controls
 * that bring it back) at full contrast. The stylesheet fades only the text for
 * exactly that reason.
 */
export function ListRow(props: {
  title: string;
  retired?: boolean;
  meta?: JSX.Element;
  actions: JSX.Element;
}) {
  return (
    <div class="list-row" data-retired={props.retired === true ? 'true' : 'false'}>
      <div class="list-row-text">
        <span class="list-row-title">{props.title}</span>
        <Show when={props.meta}>
          <span class="list-row-meta">{props.meta}</span>
        </Show>
      </div>
      <div class="list-row-actions">{props.actions}</div>
    </div>
  );
}

export function Badge(props: { children: JSX.Element; tone?: 'warn' | 'ok' }) {
  return (
    <span class="badge" data-tone={props.tone}>
      {props.children}
    </span>
  );
}

/** What a list says when there is nothing in it yet. */
export function Empty() {
  const { m } = useLocale();
  return (
    <p class="screen-body" style={{ margin: '0', padding: '12px 0' }}>
      {m().backoffice.empty}
    </p>
  );
}

/* ------------------------------------------------------------------ forms */

/**
 * The dialog every editor opens: a form, a Cancel, and one affirmative button.
 *
 * The error goes *inside* the dialog rather than behind it, because the dialog
 * is modal and a banner on the page under it would be invisible to the person
 * who caused it. It sits above the fields rather than below the buttons so it
 * is read before the next attempt rather than after it.
 *
 * `onSubmit` fires from the button and from `Enter` in the form, which is the
 * one keyboard affordance this screen genuinely needs: the backoffice is the
 * only place in the app somebody is typing rather than tapping.
 */
export function FormDialog(props: {
  open: boolean;
  onClose(): void;
  headline: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit(): void;
  children: JSX.Element;
}) {
  const { m } = useLocale();

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      headline={props.headline}
      actions={
        <>
          <Button variant="text" disabled={props.busy} onClick={props.onClose}>
            {m().app.cancel}
          </Button>
          <Button disabled={props.busy} onClick={props.onSubmit}>
            {props.busy ? m().backoffice.saving : props.submitLabel}
          </Button>
        </>
      }
    >
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.busy) props.onSubmit();
        }}
      >
        <Show when={props.error}>{(message) => <ErrorBanner>{message()}</ErrorBanner>}</Show>
        {props.children}
        {/*
          A submit button the form needs and nobody should see: without one,
          `Enter` in a single-field form does nothing in most browsers, and the
          dialog's own affirmative button is outside the form element and so
          cannot be it.
        */}
        <button type="submit" class="sr-only" tabindex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  );
}
