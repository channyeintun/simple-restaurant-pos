/**
 * JSX types for the `@material/web` custom elements used in this app.
 *
 * Material Web ships web components, not Solid components, so TypeScript has to
 * be told the tags exist before `<md-filled-button>` will compile. That is all
 * this file does — it declares the tags and the attributes each one takes.
 *
 * ## What Solid does with what you write, which is not what React does
 *
 * Read this before adding a page. The rules are short and getting them wrong
 * fails silently — the element renders, it just never sees the value.
 *
 *   * **A plain attribute is set with `setAttribute`.** Solid compiles unknown
 *     JSX attributes on an unknown tag into attributes, and an attribute is a
 *     string. `label="Send"` is fine; `value={cart}` would stringify an object
 *     to `[object Object]`. React 19 guesses for you by looking at the value's
 *     type. Solid does not guess, which is why the next rule exists.
 *   * **`prop:` sets a property.** `prop:value={total()}`, `prop:selected={on()}`,
 *     `prop:disabled={busy()}`. Anything that is not a string wants this, and
 *     so does anything the component reflects rather than reads — a Material
 *     text field holds its value as a property, and writing the attribute after
 *     somebody has typed into it does nothing at all.
 *   * **`on:` listens for the element's own events.** Solid's `onInput` and
 *     friends are delegated at the document and only cover the events it knows
 *     about; a custom element firing its own `close`, or firing `input` from
 *     inside a shadow root, needs `on:close={...}` / `on:input={...}`, which
 *     attaches a real listener to the element. When in doubt use `on:` — it is
 *     never wrong, only occasionally unnecessary.
 *   * **`class`, not `className`** — and a custom element ignores both for its
 *     internals, so per-instance theming goes through the component's own
 *     custom properties in a `style` object, the same way `styles.css` sets
 *     them globally.
 *
 * ## Why the two interfaces at the bottom of this file exist
 *
 * `prop:`, `attr:` and `on:` are *not* index signatures on `JSX.HTMLAttributes`,
 * which is the obvious guess and is wrong. Solid builds them as mapped types
 * over three interfaces it declares empty and expects the application to
 * augment — `ExplicitProperties`, `ExplicitAttributes` and `CustomEvents` (see
 * `solid-js/types/jsx.d.ts`). An empty interface maps to no keys at all, so
 * before those augmentations `prop:value` was not a loose type, it was a
 * compile error on every element in the app.
 *
 * The practical consequence is that this file has to know every property and
 * event name the app sets through those prefixes. That sounds like a chore and
 * is actually the point: a typo in `prop:seleted` is caught here rather than
 * silently doing nothing at runtime, which is exactly the failure mode the
 * prefixes exist to avoid. Adding a name to one of those two interfaces is the
 * price of using it, and it is one line.
 */
import type { JSX } from 'solid-js';

type Base = JSX.HTMLAttributes<HTMLElement>;

interface ButtonAttrs extends Base {
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  value?: string;
  name?: string;
  'trailing-icon'?: boolean;
  'has-icon'?: boolean;
}

interface TextFieldAttrs extends Base {
  label?: string;
  value?: string;
  type?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  rows?: number;
  /* `inputmode="numeric"` on the PIN field and on a price is what decides
     whether a tablet shows a keyboard somebody can type a number on. */
  inputmode?: string;
  'error-text'?: string;
  'supporting-text'?: string;
  error?: boolean;
  autocomplete?: string;
  maxlength?: number;
}

interface SelectAttrs extends Base {
  label?: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  'supporting-text'?: string;
}

interface OptionAttrs extends Base {
  value?: string;
  selected?: boolean;
  disabled?: boolean;
}

interface ListItemAttrs extends Base {
  type?: 'text' | 'button' | 'link';
  href?: string;
  target?: string;
  disabled?: boolean;
}

interface DialogAttrs extends Base {
  open?: boolean;
  type?: 'alert';
}

interface ProgressAttrs extends Base {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  'four-color'?: boolean;
}

interface ChipAttrs extends Base {
  label?: string;
  disabled?: boolean;
  selected?: boolean;
  elevated?: boolean;
  href?: string;
  target?: string;
}

interface SwitchAttrs extends Base {
  selected?: boolean;
  disabled?: boolean;
  icons?: boolean;
}

interface IconButtonAttrs extends Base {
  disabled?: boolean;
  href?: string;
  target?: string;
  toggle?: boolean;
  selected?: boolean;
  'aria-label'?: string;
}

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'md-filled-button': ButtonAttrs;
      'md-filled-tonal-button': ButtonAttrs;
      'md-outlined-button': ButtonAttrs;
      'md-text-button': ButtonAttrs;
      'md-elevated-button': ButtonAttrs;

      'md-filled-text-field': TextFieldAttrs;
      'md-outlined-text-field': TextFieldAttrs;

      'md-outlined-select': SelectAttrs;
      'md-filled-select': SelectAttrs;
      'md-select-option': OptionAttrs;

      'md-list': Base;
      'md-list-item': ListItemAttrs;
      'md-divider': Base & { inset?: boolean };

      'md-dialog': DialogAttrs;
      'md-circular-progress': ProgressAttrs;
      'md-linear-progress': ProgressAttrs;

      'md-assist-chip': ChipAttrs;
      'md-filter-chip': ChipAttrs;
      'md-suggestion-chip': ChipAttrs;
      'md-chip-set': Base;

      'md-switch': SwitchAttrs;
      'md-icon': Base;
      'md-icon-button': IconButtonAttrs;
      'md-filled-icon-button': IconButtonAttrs;
      'md-filled-tonal-icon-button': IconButtonAttrs;
      'md-outlined-icon-button': IconButtonAttrs;
    }
  }
}

/**
 * The names this app may write after `prop:` and `on:`.
 *
 * Solid maps these two interfaces into `prop:${K}` and `on:${K}` attributes on
 * every element; they ship empty, so a name that is not listed here does not
 * compile. See the note at the top of this file for why that is deliberate.
 */
declare module 'solid-js' {
  namespace JSX {
    interface ExplicitProperties {
      /* Material's controls hold their state as properties and reflect it, so
         writing the attribute after somebody has typed into the field does
         nothing. Every one of these is a property for that reason. */
      value: string;
      disabled: boolean;
      selected: boolean;
      required: boolean;
      error: boolean;
    }

    interface CustomEvents {
      /* `input` and `click` are fired from inside a shadow root, where Solid's
         delegated `onInput` / `onClick` do not reach. `close` is the dialog
         starting to go away and `closed` is it having gone — the confirm
         dialog waits for the second, because acting on the first runs the
         consequence while the animation is still on screen. */
      input: InputEvent;
      click: MouseEvent;
      close: Event;
      closed: Event;
    }
  }
}
