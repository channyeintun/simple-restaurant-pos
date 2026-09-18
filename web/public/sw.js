/**
 * Service worker: offline app shell + Web Push.
 *
 * Deliberately hand-written and dependency-free. Vite hashes asset filenames,
 * so rather than generating a precache manifest at build time this caches at
 * runtime: static assets are immutable once hashed, and navigations always try
 * the network first so a deploy is picked up on the next launch.
 *
 * API responses are never cached — they are per-member and authenticated, and
 * a stale registration list is worse than a spinner.
 */

/*
 * Bump this to drop every cache on the next launch.
 *
 * Navigations are network-first, so an ordinary reload picks a deploy up on
 * its own. The case that does not is an installed app opened from the Home
 * Screen with no usable network: it falls back to the cached shell, that shell
 * names the *previous* hashed bundle, and the bundle is cache-first — so the
 * old app keeps starting until a navigation reaches the network. Changing this
 * string makes `activate` delete both caches, which turns "eventually" into
 * "next time it opens".
 */
const VERSION = 'v2';
const SHELL_CACHE = `futsal-shell-${VERSION}`;
const ASSET_CACHE = `futsal-assets-${VERSION}`;

const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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

  // Navigations: network first, falling back to the cached shell so the app
  // still opens on a train with no signal.
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

/* ------------------------------------------------------------------- push */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Futsal Friday';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-32.png',
    tag: payload.tag || 'futsal',
    // Replacing a same-tag notification should still buzz — an updated
    // reminder that arrives silently is a reminder nobody sees.
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/' },
  };

  // iOS will show "This site has been updated in the background" if a push is
  // received and no notification is displayed, so always show one.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer focusing a tab that is already open rather than stacking windows.
      for (const client of clients) {
        if (new URL(client.url).origin === target.origin && 'focus' in client) {
          client.navigate(target.href).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});

/**
 * Push services rotate subscriptions occasionally. Tell any open tab so it can
 * re-register with the API; if none is open, the next launch resubscribes.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'push-subscription-change' });
    }),
  );
});
