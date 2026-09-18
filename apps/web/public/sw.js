// Keeps the app shell available while the single server instance restarts during a deploy (a few seconds).
// - Pages (navigations): network first; if the server does not answer, the last good index.html from the cache.
// - /assets/*: file names carry a content hash, so they never change: cache first. Old chunks stay available to pages
//   that were opened before a deploy.
// - The API is never cached: answers and events have their own retry queues in the page.
const CACHE = 'funnel-shell-v1';
const SHELL = '/index.html';

// Install: cache the current page shell and the assets it references, so even the very first reload during a
// restart works (the first page load happened before this worker was in control).
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch(SHELL, { cache: 'no-cache' });
      if (response.ok) {
        const html = await response.clone().text();
        const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
        await cache.put(SHELL, response);
        await cache.addAll(assets);
      }
      await self.skipWaiting();
    })().catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          }
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
