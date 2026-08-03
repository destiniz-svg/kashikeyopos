/* Register offline shell — kashikeyo-app-2.
 *
 * Why this exists: /app was a network-only page. A cold load during an outage
 * gave the browser's error page, and there was no path back to selling — a
 * screensaver wake, a pull-to-refresh, a low-memory tab eviction or a battery
 * swap during a Friday-evening ISP drop took the till away entirely.
 *
 * Why it is NETWORK-FIRST for navigations: a cache-first worker on a fleet of
 * counter tablets can pin a stale bundle across every outlet, which is worse
 * than having no worker at all (it is why the previous worker had to be
 * replaced with a kill switch). This one always tries the network and only
 * serves the cached shell when the network genuinely fails, so a deploy is
 * picked up on the very next load.
 *
 * It never touches /api/ — sync, ops and the outbox must always see the real
 * network state, never a cached answer.
 */
const CACHE = 'kashikeyo-app-2';
/* The register is served at /app and at /app/... alike; one cached shell
 * serves both, keyed on the canonical path. */
const SHELL = '/app/';
/* Everything the register needs to boot with no network. All the fonts are
 * self-hosted under /app/ now — the latin faces used to come from
 * fonts.googleapis.com, so an outage cost the till its typography on the one
 * product whose whole promise is that it keeps working without a link. */
const PRECACHE = [
  '/app/support.js',
  '/app/vendor/react.production.min.js',
  '/app/vendor/react-dom.production.min.js',
  '/app/fonts/MV_A_Waheed_Bold.ttf',
  '/app/fonts/MV_Randhoo_Regular.ttf',
  '/app/fonts/bricolage-grotesque-latin-200-800.woff2',
  '/app/fonts/bricolage-grotesque-latin-ext-200-800.woff2',
  '/app/fonts/inter-latin-100-900.woff2',
  '/app/fonts/inter-latin-ext-100-900.woff2',
  '/app/fonts/jetbrains-mono-latin-100-800.woff2',
  '/app/fonts/jetbrains-mono-latin-ext-100-800.woff2',
  '/logo-mark.png',
  '/icon-192.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      /* Individually, so one missing asset can't fail the whole install and
         leave the till with no shell at all. */
      await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    } catch (e) { /* install anyway; the shell is cached on first load */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('kashikeyo-app')).map((k) => caches.delete(k)));
    } catch (e) { /* nothing to prune */ }
    try { await self.clients.claim(); } catch (e) {}
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  /* Never interpose on the API. The outbox, the pull loop and the connectivity
     indicator all depend on seeing the true network result. */
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/')) return;

  /* Navigations: network first, cached shell as the fallback. The register is
     the same document whatever the path under /app, so any cached /app/ shell
     will do — it rehydrates from /api/app2/pull the moment the link returns. */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        /* Only a real page is worth keeping — a redirect to /login is not. */
        if (fresh && fresh.ok && fresh.type !== 'opaqueredirect') {
          try { const c = await caches.open(CACHE); await c.put(SHELL, fresh.clone()); } catch (e) {}
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(SHELL);
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  /* Static assets under /app (and the icons): serve from cache when we have it,
     and refresh it in the background so a deploy lands on the next load. */
  if (url.pathname.startsWith('/app/') || /^\/(logo-mark|icon-\d+)\.png$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) { caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {}); }
        return res;
      }).catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const fresh = await network;
      if (fresh) return fresh;
      return new Response('', { status: 504, statusText: 'offline' });
    })());
  }
});
