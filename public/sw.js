// Offline-first strategy:
// - App shell (the page itself, manifest, icons) — cache-first, so the
//   dashboard still *opens* with zero connectivity.
// - /api/summary and /api/insights — network-first, falling back to the
//   last successful response when offline. A custom header tells the page
//   whether what it's looking at is live or cached, so it can show a
//   "last synced X ago" indicator instead of silently pretending stale
//   data is current.
const CACHE_NAME = 'soma-shell-v2';
const SHELL_URLS = ['/', '/report.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

async function withCacheHeader(response, fromCache) {
  const body = await response.blob();
  const headers = new Headers(response.headers);
  headers.set('X-Soma-Cache', fromCache ? 'hit' : 'miss');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === '/api/summary' || url.pathname === '/api/insights') {
    event.respondWith(
      fetch(event.request)
        .then(async (resp) => {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, resp.clone());
          return withCacheHeader(resp, false);
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return withCacheHeader(cached, true);
          return Response.json({ status: 'offline_no_cache' }, { status: 503 });
        })
    );
    return;
  }

  if (event.request.method === 'GET' && url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
