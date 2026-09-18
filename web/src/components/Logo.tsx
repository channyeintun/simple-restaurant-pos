/**
 * The app's mark, for the screens that introduce the app.
 *
 * ## Why it is drawn here rather than loaded
 *
 * `web/scripts/icon.svg` is the source art and `public/icons/` holds it as
 * PNGs, so an `<img src="/icons/icon-192.png">` would have been the short way
 * to put it on a screen. It is the wrong way twice over. The PNGs are sized for
 * a launcher, so the one that is sharp on a 2x tablet is four times the bytes
 * this needs; and both of the screens that show this mark are screens where
 * something has already gone quiet — a tablet nobody has claimed, a claim link
 * being redeemed on a restaurant's wifi — which is exactly when a second
 * network request is least likely to finish. Inline, it is part of the document
 * that is already on the screen.
 *
 * It is a copy of the artwork rather than a shared file because there is no
 * mechanism here that could share it: Vite would inline an imported SVG as a
 * data URI or a URL, neither of which lets the field colour be a token, and the
 * mark is twelve numbers. `scripts/icon.svg` is the one to change first; this
 * follows it, and the comment there lists everywhere else that has to.
 *
 * ## Why this copy rounds its own corners
 *
 * The launcher icon is full bleed because Android and iOS mask it themselves.
 * Nothing masks it here, so a full-bleed square would be a blue rectangle in
 * the middle of a screen rather than an app icon. `rx` is 112 of 512, near
 * enough 22%, which is what both platforms use and therefore what people have
 * been looking at all day on their home screen.
 *
 * ## Why it says nothing
 *
 * `aria-hidden`, and no `<title>`. Both screens that use it print the app's
 * name in the reader's own language directly underneath, so a label here would
 * announce the same name twice — once in whatever language this file was
 * written in, which is the one thing a mark in a bilingual app must not do.
 */
export function Logo() {
  return (
    <svg
      class="app-logo"
      viewBox="0 0 512 512"
      role="presentation"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="112" fill="var(--md-sys-color-primary)" />
      <path
        d="M166 115 H346 a10 10 0 0 1 10 10 V397
           l-33.33 -26 l-33.34 26 l-33.33 -26 l-33.33 26 l-33.34 -26 l-33.33 26
           V125 a10 10 0 0 1 10 -10 Z"
        fill="var(--md-sys-color-surface-container-low)"
      />
      {/* The ink is the field colour exactly, so the ruled lines read as holes
          in one object rather than as marks lying on top of it. */}
      <g
        stroke="var(--md-sys-color-primary)"
        stroke-width="18"
        stroke-linecap="round"
      >
        <path d="M206 206 H306" />
        <path d="M206 260 H306" />
        <path d="M206 315 H270" />
      </g>
    </svg>
  );
}
