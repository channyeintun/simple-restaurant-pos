import { LOCALES, LOCALE_LABELS } from '@pos/shared';
import { For } from 'solid-js';
import { useLocale } from '../state/locale.js';
import { Button } from './ui.js';

/**
 * English or မြန်မာ, in one press each.
 *
 * ## Why it is two buttons and not a dropdown
 *
 * There are two languages and there is never going to be a third, so a select
 * costs a press to open, a press to choose, and a moment spent reading a list
 * of two. Both labels are written in their own script and never translated —
 * somebody looking for Burmese is looking for the word မြန်မာ, and "Burmese" is
 * no help at all to the person who needs that button. Each option carries
 * `lang`, so the Burmese one gets a Myanmar face and the line height that
 * script needs even while the rest of the screen is still English.
 *
 * ## Where it belongs
 *
 * On the screens somebody reaches *before* a shift starts: the PIN pad, and the
 * shell's unclaimed-device screen. That is not a stylistic choice. A tablet
 * that has not been claimed shows nothing but shell, and a manager who cannot
 * read English has to be able to change the language from the very screen that
 * is telling them, in English, that the tablet is not set up yet. Once service
 * is running the control would only be in the way — a waiter mid-order is not
 * changing language, and the choice is remembered anyway.
 *
 * ## Why the preference is per device and not per person
 *
 * It lives in `platform.storage`, not on the staff row. The tablet by the
 * kitchen door is read by whoever is nearest it, and hanging the language off a
 * four-digit PIN would mean the screen changing script under somebody's hand
 * every time a shift changed.
 */
export function LanguageToggle() {
  const { locale, setLocale } = useLocale();

  return (
    <div class="language-toggle" role="group" aria-label="Language">
      <For each={LOCALES}>
        {(option) => (
          <Button
            lang={option}
            /* The current language is the filled one. `aria-pressed` would say
               it better, but `Button` wraps a Material element that owns its
               own internals, so the selected state is carried by the variant —
               which is at least visible to everyone rather than only to a
               screen reader. */
            variant={option === locale() ? 'tonal' : 'text'}
            onClick={() => setLocale(option)}
          >
            {LOCALE_LABELS[option]}
          </Button>
        )}
      </For>
    </div>
  );
}
