// Minimal service worker — its only real job is to exist and register, which
// is what Android Chrome (and skins like Infinix's XOS) require to treat this
// as a fully installable PWA using the manifest icon, instead of falling back
// to a basic bookmark shortcut with a generic/screenshot icon. No caching
// logic here on purpose — the dashboard should always show live data, never
// a stale cached copy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // presence alone satisfies installability checks
