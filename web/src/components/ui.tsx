import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/dialog/dialog.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/chips/chip-set.js';
import '@material/web/chips/assist-chip.js';
import '@material/web/chips/filter-chip.js';

import type { Identity } from '@pos/shared';
import { type JSX, Match, Show, Switch, createEffect, createSignal } from 'solid-js';
import { useLocale } from '../state/locale.js';

/**
 * The Material control kit: thin Solid wrappers over the `@material/web`
 * custom elements, and the two composites every screen after this one needs.
 *
 * This is the file the rest of `pages/` copies from, so the awkward parts are
 * solved once here and explained rather than repeated. Read this before adding
 * a control anywhere else.
 *
 * ## Why a wrapper at all, when a custom element is already a tag
 *
 * Two reasons, and neither is "it looks nicer".
 *
 * The first is the side-effect imports at the top. A Material component is
 * registered by importing its module for effect; a page that draws
 * `<md-dialog>` without having imported `dialog.js` gets an unupgraded element,
 * which is a blank rectangle with no error anywhere. Importing them here means
 * a page cannot half-register a control: if it can see `Dialog`, the element
 * behind it is defined.
 *
 * The second is that these elements own their own state. A Material text field
 * holds its value as a property and re-renders itself from it; a filter chip
 * flips its own `selected` before it tells anybody. So "the value the app
 * thinks it has" and "the value on screen" are two different things that have
 * to be pushed back together, and doing that per call site is how a field ends
 * up showing what the app rejected.
 *
 * ## The three Solid rules these wrappers exist to apply
 *
 * `types/material.d.ts` sets them out in full. The short version:
 *
 *   * **`prop:` for anything that is not a string.** Solid compiles a plain
 *     JSX attribute on an unknown tag into `setAttribute`, and an attribute is
 *     text. `prop:disabled={busy()}` sets the property; `disabled={busy()}`
 *     sets the *string* `"false"`, which is a perfectly truthy attribute.
 *   * **`on:` for the element's own events.** Solid's `onInput` is delegated at
 *     the document and only covers events it knows; an event dispatched from
 *     inside a shadow root, or a custom one like `closed`, needs a real
 *     listener. `on:` attaches one.
 *   * **Bind the value both ways.** Setting the property on the way in is half
 *     of it. The other half is the two lines below in `TextField` and `Chip`
 *     that write the app's value back over the element's after every edit —
 *     see the comment there, because it is the one piece of this that is not
 *     obvious and the one that bites.
 *
 * ## Size
 *
 * Nothing here sets a height. `styles.css` sets the Material container-height
 * tokens to `--pos-touch` (48px) globally, which is the rule from the brief and
 * applies to every button in the app whether or not it came through this file.
 * A control added here must not undo it with a height of its own — theme it
 * with the component's published custom properties, the way `DANGER_TOKENS`
 * below does, so the ripple and the state layer stay the size of the thing that
 * was pressed.
 */

/*
 * The shapes these wrappers reach for on the elements they hold.
 *
 * Deliberately structural rather than the real classes from `@material/web`:
 * importing `MdOutlinedTextField` as a type pulls the component's whole module
 * graph into the type layer for the sake of one property, and the property is
 * all any of this needs.
 */
type ValueElement = HTMLElement & { value: string };
type SelectableElement = HTMLElement & { selected: boolean };
type DialogElement = HTMLElement & { open: boolean; show(): void; close(): void };

/* --------------------------------------------------------------- buttons */

interface ButtonProps {
  children: JSX.Element;
  onClick?(): void;
  disabled?: boolean;
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  type?: 'button' | 'submit';
  /**
   * Colours the control with the error tone. Purely visual — an action that
   * takes something away should not look as inviting as one that adds. In this
   * app that is exactly two things, clearing a cart and voiding a sent item,
   * and both of them go through {@link ConfirmButton} rather than here.
   */
  danger?: boolean;
  /**
   * The language of the *label*, when it differs from the app's. The language
   * switcher offers each language in its own script, so its Burmese option is
   * Burmese while everything around it is English — and Burmese needs more room
   * under the baseline than Latin does, which is what the `:lang(my)` rule in
   * `styles.css` gives it.
   */
  lang?: string;
  /** For a control whose visible content is a glyph rather than words. */
  ariaLabel?: string;
}

/*
 * Set as inline custom properties rather than as a class.
 *
 * Solid does forward `class` to a custom element — unlike React, which drops it
 * — but that only gets as far as the host. A `.danger` rule in the stylesheet
 * still cannot reach the button's label inside its shadow root, and the
 * component's published custom properties can, which is how `styles.css` themes
 * every one of these already.
 *
 * The filled tokens are here and were not in the app this is descended from,
 * where a destructive confirmation ended up with a default-blue affirmative
 * button. The last control somebody presses before a round is voided should be
 * the colour of the thing it is about to do.
 */
const DANGER_TOKENS: JSX.CSSProperties = {
  '--md-filled-button-container-color': 'var(--md-sys-color-error)',
  '--md-filled-button-label-text-color': 'var(--md-sys-color-on-error)',
  '--md-text-button-label-text-color': 'var(--md-sys-color-error)',
  '--md-outlined-button-label-text-color': 'var(--md-sys-color-error)',
  '--md-outlined-button-outline-color': 'var(--md-sys-color-error)',
};

/**
 * The app's button, in the four Material variants.
 *
 * Written out four times rather than picking a tag name and spreading props
 * into it. `<Dynamic component={tag}>` would compile, but a spread goes through
 * Solid's generic attribute path and loses the `prop:`/`on:` namespaces that
 * the rules above are built on — so the one thing the wrapper exists to get
 * right would be the thing it quietly stopped doing.
 */
export function Button(props: ButtonProps) {
  const variant = () => props.variant ?? 'filled';
  const style = () => (props.danger ? DANGER_TOKENS : undefined);

  return (
    <Switch
      fallback={
        <md-filled-button
          type={props.type ?? 'button'}
          lang={props.lang}
          aria-label={props.ariaLabel}
          style={style()}
          prop:disabled={props.disabled ?? false}
          on:click={() => props.onClick?.()}
        >
          {props.children}
        </md-filled-button>
      }
    >
      <Match when={variant() === 'tonal'}>
        <md-filled-tonal-button
          type={props.type ?? 'button'}
          lang={props.lang}
          aria-label={props.ariaLabel}
          style={style()}
          prop:disabled={props.disabled ?? false}
          on:click={() => props.onClick?.()}
        >
          {props.children}
        </md-filled-tonal-button>
      </Match>

      <Match when={variant() === 'outlined'}>
        <md-outlined-button
          type={props.type ?? 'button'}
          lang={props.lang}
          aria-label={props.ariaLabel}
          style={style()}
          prop:disabled={props.disabled ?? false}
          on:click={() => props.onClick?.()}
        >
          {props.children}
        </md-outlined-button>
      </Match>

      <Match when={variant() === 'text'}>
        <md-text-button
          type={props.type ?? 'button'}
          lang={props.lang}
          aria-label={props.ariaLabel}
          style={style()}
          prop:disabled={props.disabled ?? false}
          on:click={() => props.onClick?.()}
        >
          {props.children}
        </md-text-button>
      </Match>
    </Switch>
  );
}

/* ----------------------------------------------------------------- fields */

interface TextFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  type?: 'text' | 'number' | 'textarea';
  placeholder?: string;
  supportingText?: string;
  errorText?: string;
  required?: boolean;
  disabled?: boolean;
  /** `numeric` is what decides whether a tablet offers digits or a keyboard. */
  inputMode?: string;
  maxLength?: number;
}

export function TextField(props: TextFieldProps) {
  let element!: ValueElement;

  return (
    <md-outlined-text-field
      ref={(el) => (element = el as ValueElement)}
      style={{ width: '100%' }}
      label={props.label}
      type={props.type ?? 'text'}
      placeholder={props.placeholder}
      supporting-text={props.supportingText}
      error-text={props.errorText}
      inputmode={props.inputMode}
      maxlength={props.maxLength}
      rows={props.type === 'textarea' ? 3 : undefined}
      prop:value={props.value}
      prop:error={props.errorText != null}
      prop:required={props.required ?? false}
      prop:disabled={props.disabled ?? false}
      on:input={() => {
        props.onChange(element.value);
        /*
         * And then write the app's value straight back over the element's.
         *
         * `prop:value` above is the binding on the way in, and it only fires
         * when the value actually changes — which is exactly the case that
         * breaks. Somebody types a letter into a price field, the page refuses
         * it and keeps the value it had, nothing changed, so nothing re-runs,
         * and the letter sits on screen over a state that does not contain it.
         * Solid applies the change synchronously, so by this line `props.value`
         * is already whatever the page decided to keep; one comparison makes
         * the element show it.
         */
        if (element.value !== props.value) element.value = props.value;
      }}
    />
  );
}

/* ------------------------------------------------------------------ chips */

/**
 * The container, which is not decoration: `md-chip-set` is what makes a row of
 * chips one stop for the keyboard with the arrow keys moving between them,
 * instead of a dozen separate tab stops.
 */
export function ChipSet(props: { children: JSX.Element; ariaLabel?: string }) {
  return <md-chip-set aria-label={props.ariaLabel}>{props.children}</md-chip-set>;
}

/**
 * One chip, in the two kinds this app has a use for.
 *
 * `selected` decides which element gets drawn, and the distinction is the
 * accessible one rather than a style: a filter chip reports a pressed state to
 * assistive technology and an assist chip reports a plain button. The waiter's
 * category row is a filter — one of several, and which one is on matters — so
 * it passes `selected`. Anything that just does something when pressed leaves
 * it off.
 */
export function Chip(props: {
  label: string;
  selected?: boolean;
  onClick?(): void;
  disabled?: boolean;
}) {
  let element!: SelectableElement;

  return (
    <Show
      when={props.selected !== undefined}
      fallback={
        <md-assist-chip
          label={props.label}
          prop:disabled={props.disabled ?? false}
          on:click={() => props.onClick?.()}
        />
      }
    >
      <md-filter-chip
        ref={(el) => (element = el as SelectableElement)}
        label={props.label}
        prop:selected={props.selected ?? false}
        prop:disabled={props.disabled ?? false}
        on:click={() => {
          props.onClick?.();
          /*
           * A filter chip toggles itself before it dispatches the click, so by
           * the time anybody hears about it the element has already decided it
           * is selected. If the page does not agree — the category the waiter
           * tapped is the one already open, say — nothing in the JSX re-runs,
           * because the app's value never changed. Same bind-both-ways problem
           * as the text field, same one-line answer.
           */
          element.selected = props.selected ?? false;
        }}
      />
    </Show>
  );
}

/* ----------------------------------------------------------------- dialog */

interface DialogProps {
  open: boolean;
  onClose(): void;
  headline: string;
  children: JSX.Element;
  actions?: JSX.Element;
}

/**
 * A modal panel, driven by a boolean instead of by `show()` and `close()`.
 *
 * The element's API is imperative and its state is its own, so this is the one
 * wrapper that has to keep a two-way binding rather than a value: the effect
 * opens and closes it to match the prop, and `closed` reports the ways it can
 * shut without being asked — Escape, the scrim, the browser's own dismiss — so
 * that a page holding `open` in a signal is never left holding `true` for a
 * dialog that is no longer on screen.
 *
 * `closed` rather than `close`: the former fires after the exit animation and
 * covers every one of those routes, while the latter is the element telling us
 * it has begun.
 */
export function Dialog(props: DialogProps) {
  let element!: DialogElement;

  createEffect(() => {
    if (props.open && !element.open) element.show();
    else if (!props.open && element.open) element.close();
  });

  return (
    <md-dialog
      ref={(el) => (element = el as DialogElement)}
      on:closed={() => {
        if (props.open) props.onClose();
      }}
    >
      <div slot="headline">{props.headline}</div>
      {/*
        `method="dialog"` is the element's own convention for its content slot
        and is what lets a control inside it close the panel without script.
      */}
      <form slot="content" method="dialog">
        {props.children}
      </form>
      <div slot="actions">{props.actions}</div>
    </md-dialog>
  );
}

/**
 * A control that asks first.
 *
 * `CLAUDE.md` names exactly two actions in this app that get a confirmation —
 * clearing a cart and voiding an item that has already gone to the kitchen —
 * and retiring a catalogue row has since earned a third, for the same reason.
 * They share a component because the hazard is inconsistency rather than any
 * one dialog: a screen where one control asks and the control next to it does
 * not is a screen where nobody can learn which taps are safe to try. Every
 * destructive action in this app goes through here, and nothing else in it gets
 * a confirmation at all —
 * sending a round to the kitchen does not, by explicit instruction, because a
 * waiter standing at a table taps Send thirty times a service.
 *
 * Neither of those two actions is undoable from inside the app. A voided item
 * stays voided and the kitchen has already been sent a slip saying so, so the
 * dialog is the only recovery there is, and its body says what happens rather
 * than restating the button.
 */
export function ConfirmButton(props: {
  headline: string;
  /** What actually happens, in plain terms. Not a restatement of the button. */
  body: string;
  confirmLabel: string;
  onConfirm(): void | Promise<void>;
  children: JSX.Element;
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  danger?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { m } = useLocale();
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await props.onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant={props.variant ?? 'text'}
        danger={props.danger ?? true}
        ariaLabel={props.ariaLabel}
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        {props.children}
      </Button>

      <Dialog
        open={open()}
        onClose={() => setOpen(false)}
        headline={props.headline}
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              {m().app.cancel}
            </Button>
            {/*
              The affirmative button carries the destructive wording, so the
              last thing read before committing names the consequence. It keeps
              that label while the request is in flight rather than swapping to
              a "working" string — the label is what somebody is still reading
              when they let go, and the disabled state is the feedback.
            */}
            <Button danger={props.danger ?? true} disabled={busy()} onClick={() => void confirm()}>
              {props.confirmLabel}
            </Button>
          </>
        }
      >
        <p style={{ margin: '0' }}>{props.body}</p>
      </Dialog>
    </>
  );
}

/* --------------------------------------------------------------- feedback */

/**
 * The wait, with a label.
 *
 * The label is not optional to the screen reader even where it is optional to
 * the caller: a bare indeterminate progress ring announces nothing at all, so
 * an unlabelled one falls back to the catalogue's own "just a moment" rather
 * than to an English constant compiled into a component.
 */
export function Spinner(props: { label?: string }) {
  const { m } = useLocale();

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        gap: 'var(--pos-gap)',
      }}
    >
      <md-circular-progress indeterminate aria-label={props.label ?? m().app.loading} />
      <Show when={props.label}>{(label) => <span>{label()}</span>}</Show>
    </div>
  );
}

/**
 * Something went wrong and the person reading it may be able to act on it.
 *
 * `role="alert"` rather than a live region with a politeness setting: every use
 * of this in the app follows something somebody just pressed, so interrupting
 * is correct — they are waiting for the answer and the answer is this.
 */
export function ErrorBanner(props: { children: JSX.Element }) {
  return (
    <div class="error-banner" role="alert">
      {props.children}
    </div>
  );
}

/* ------------------------------------------------------------------ chrome */

/**
 * The strip along the top of every screen a signed-in person sees: what this
 * screen is, who is on, which tablet this is, and the way off.
 *
 * It lives in the control kit rather than in a page because all three trees —
 * waiter, cashier, backoffice — need exactly the same one, and the alternative
 * is three copies that drift. It takes an identity rather than reading the
 * session itself, which keeps this file free of app state and means the same
 * bar can be shown for somebody other than the current user when the backoffice
 * eventually needs to.
 *
 * The device name is on screen and is not decoration. Every tablet in the
 * building runs the same app against the same data, so "which one am I holding"
 * is the question behind half of what goes wrong with a set of them — a
 * manager mints a claim link for the till and opens it on a waiter's tablet,
 * and this line is where that becomes visible instead of mysterious.
 *
 * Signing out is a plain button and not a {@link ConfirmButton}. It takes
 * nothing away — the token is re-minted without the staff claim and the tablet
 * stays claimed — and the brief is explicit that confirmation is for exactly
 * two actions, neither of which is this one.
 */
export function StaffBar(props: {
  /** What this screen is, in the app's language. */
  title: string;
  identity: Identity;
  onSignOut(): void;
  busy?: boolean;
}) {
  const { m } = useLocale();

  return (
    <header
      style={{
        display: 'flex',
        'flex-wrap': 'wrap',
        'align-items': 'center',
        'justify-content': 'space-between',
        gap: 'var(--pos-gap)',
        padding: 'var(--pos-gap) var(--pos-pane-gap)',
        background: 'var(--md-sys-color-surface)',
        'border-radius': 'var(--pos-radius-card)',
        'box-shadow': 'var(--pos-shadow-card)',
      }}
    >
      <div>
        <h1 style={{ margin: '0', 'font-size': '1.35rem', 'font-weight': '800' }}>{props.title}</h1>
        <p
          style={{
            margin: '0',
            'font-size': '0.95rem',
            color: 'var(--md-sys-color-on-surface-variant)',
          }}
        >
          <Show
            when={props.identity.staffName}
            fallback={props.identity.deviceName}
          >
            {(staffName) => (
              <>
                {m().pin.signedInAs(staffName())}
                <Show when={props.identity.role}>
                  {(role) => <> · {m().roles[role()]}</>}
                </Show>
                {' '}· {props.identity.deviceName}
              </>
            )}
          </Show>
        </p>
      </div>

      <Button variant="outlined" disabled={props.busy} onClick={() => props.onSignOut()}>
        {m().pin.signOut}
      </Button>
    </header>
  );
}
