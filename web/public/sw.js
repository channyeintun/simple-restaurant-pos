/**
 * Service worker: the offline app shell.
 *
 * Deliberately hand-written and dependency-free. Vite hashes asset filenames,
 * so rather than generating a precache manifest at build time this caches at
 * runtime: static assets are immutable once hashed, and navigations always try
 * the network first so a deploy is picked up on the next launch.
 *
 * There are no push handlers here and there is nothing to add them for. The one
 * thing this app would ever want to interrupt somebody about — a kitchen ticket
 * that did not print — is a red banner on the cashier's screen, which is a
 * screen that is already in front of somebody and already has the live stream
 * open. A notification would be a second, slower copy of it.
 *
 * API responses are never cached. They are per-device and authenticated, and a
 * cached one is a lie a till cannot afford: a table that shows as free because
 * the answer is four minutes old is a table that gets seated twice.
 */

const VERSION = 'v1';
const SHELL_CACHE = `pos-shell-${VERSION}`;
const ASSET_CACHE = `pos-assets-${VERSION}`;

/*
 * The document and the manifest, and nothing else.
 *
 * The icons are deliberately not in here even though they are part of the
 * installed app. `addAll` is all-or-nothing — one 404 rejects the whole
 * promise, `install` fails, and the worker never activates, so a missing 180px
 * icon would cost the offline shell entirely. They cost nothing to leave out
 * either: `/icons/` is cache-first in the fetch handler below, so the first
 * launch that renders one keeps it.
 */
const SHELL_URLS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      // Take over as soon as possible so the first visit is already covered.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, falling back to the cached shell so a tablet
  // still opens when the restaurant's line is down — the shell is not much use
  // without the API behind it, but it is the difference between a screen that
  // says what is wrong and a browser error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Hashed build output is immutable, so cache-first is safe and fast.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
