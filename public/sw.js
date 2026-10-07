// Offline-first strategy:
// - App shell HTML (/ and /report) — NETWORK-first with a short timeout,
//   falling back to the cached copy. It used to be cache-first, which meant
//   a phone that had cached index.html never asked for a new one unless
//   sw.js itself changed byte-for-byte — so a page fix deployed without a
//   sw.js edit (e.g. the loading-spinner fix) never reached phones that had
//   already installed the worker, and they sat on the old broken page.
// - Icons / manifest — cache-first (they almost never change).
// - /api/summary and /api/insights — network-first, falling back to the
//   last successful response when offline. A custom header tells the page
//   whether what it's looking at is live or cached, so it can show a
//   "last synced X ago" indicator instead of silently pretending stale
//   data is current.
const CACHE_NAME = 'soma-shell-v5';
// On flaky mobile data, a request can sit neither resolved nor rejected for
// a very long time — the page's own AbortSignal isn't guaranteed to reach
// this network call on every mobile browser, so these fetches give up on
// their own and fall back to cache rather than leaving the page stuck.
const NETWORK_TIMEOUT_MS = 8000;
const SHELL_TIMEOUT_MS = 4000;
function fetchTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || NETWORK_TIMEOUT_MS);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
// '/report.html' is intentionally excluded: the Worker 307-redirects it to
// '/report' (clean-URL asset handling), and the Cache API refuses to store a
// redirected response via addAll — that one entry failing used to abort the
// whole batch silently, leaving the shell cache empty.
const SHELL_URLS = ['/', '/report', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const SHELL_PATHS = ['/', '/report', '/report.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each URL independently so one bad entry can't blank the whole
      // shell cache the way a single addAll() failure would.
      Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (names) => {
      const old = names.filter((n) => n !== CACHE_NAME);
      await Promise.all(old.map((n) => caches.delete(n)));
      self.clients.claim();
      // Replacing an older worker: any page already open is still running
      // whatever HTML the old worker served (possibly a stale, broken one),
      // so reload it once onto the fresh version. Skipped on a first-ever
      // install (no old caches) to avoid a pointless flicker.
      if (old.length) {
        const wins = await self.clients.matchAll({ type: 'window' });
        wins.forEach((c) => { try { c.navigate(c.url); } catch (e) {} });
      }
    })
  );
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
      fetchTimeout(event.request)
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

  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  if (event.request.mode === 'navigate' || SHELL_PATHS.includes(url.pathname)) {
    event.respondWith(
      fetchTimeout(event.request, SHELL_TIMEOUT_MS)
        .then(async (resp) => {
          if (resp && resp.ok && !resp.redirected) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, resp.clone());
          }
          return resp;
        })
        .catch(async () => {
          const cached = await caches.match(event.request, { ignoreSearch: true });
          return cached || Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetchTimeout(event.request))
  );
});
