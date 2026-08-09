/* Offline shell for /v2 — kashikeyo-v2-1.
 *
 * Why this exists: /v2's HTML is server-rendered per request with the real
 * store's menu, staff, tax and orders baked directly into it
 * (window.KPOS_REAL) — a plain cache-the-navigation-response worker would
 * either go stale (an old menu, wrong prices, yesterday's orders frozen in
 * the cache) or, worse, could serve one store's live data to a different
 * device that later loads from the same cache. So this worker NEVER caches
 * the live injected response. On every successful fetch of a /v2 navigation
 * it strips the injected <script>window.KPOS_REAL=...</script> block (the
 * exact block index.js inserts right after <base href="/v2/">) before
 * storing it, and only that sanitized, data-free shell is ever served from
 * cache. The real data comes back through v2-offline-cache.js (an IndexedDB
 * snapshot banked on every online load) once the JS boots — see
 * index.html's componentDidMount() / _loadOfflineCache().
 *
 * NETWORK-FIRST for navigations, same reasoning as /app's worker
 * (web2/proto/sw.js): it must never pin a stale bundle across a fleet, so
 * it only serves the cached shell when the network genuinely fails.
 *
 * It never touches /api/ — the outbox (v2-bridge.js), the live-order polls
 * and the connectivity indicator all depend on seeing the true network
 * result, never a cached answer.
 */
const CACHE = 'kashikeyo-v2-1';
/* /app now serves this same terminal (see index.js's combined /v2|/app
   route), so this worker has to cover navigations to either prefix — hence
   the root registration scope in index.html. Everything outside these two
   prefixes (login, signup, the guest/member portals) falls through
   untouched below; this worker never interposes on them. */
const SCOPES = ['/v2', '/app'];
function inScope(pathname) { return SCOPES.some((p) => pathname === p || pathname.startsWith(p + '/')); }
// The sanitized shell is stored under this fixed synthetic key, independent
// of which /v2/... sub-path was actually visited — one clean shell serves
// any of them, the same way the register's worker keys everything on SHELL.
const SHELL_KEY = '/v2/__shell__';

/* Everything the terminal needs to boot with no network. babel.min.js is
   large (~3MB) but required — support.js transpiles the page's own inline
   dc-template script with it, so without it the shell can render markup but
   never actually run. */
const PRECACHE = [
  '/v2/support.js',
  '/v2/v2-bridge.js',
  '/v2/v2-offline-cache.js',
  '/v2/menu-art.js',
  '/v2/kashikeyo-raw.js',
  '/v2/kashikeyo-data.js',
  '/v2/react.production.min.js',
  '/v2/react-dom.production.min.js',
  '/v2/babel.min.js',
  '/v2/fonts.css',
  '/v2/fonts/inter-400.woff2',
  '/v2/fonts/inter-500.woff2',
  '/v2/fonts/inter-600.woff2',
  '/v2/fonts/inter-700.woff2',
  '/v2/fonts/inter-800.woff2',
  '/v2/fonts/jbmono-400.woff2',
  '/v2/fonts/jbmono-500.woff2',
  '/v2/fonts/jbmono-600.woff2',
  '/v2/fonts/jbmono-700.woff2',
  '/v2/brand/kashikeyo-mark.png',
  '/icon-192.png',
  '/icon-180.png',
];

// The exact marker index.js's /v2 route inserts the injected data after (see
// buildV2Real's html.replace('<base href="/v2/">', '<base href="/v2/">' +
// inject)). Stripping between the injected <script>'s open and close tags
// removes window.KPOS_REAL and window.KPOS_BUILD together — they are one
// script block, and JSON.stringify's own </script>-escaping in index.js
// guarantees no embedded literal "</script>" can break this match early.
function stripInjectedData(html) {
  return html.replace(/<script>window\.KPOS_REAL=[\s\S]*?<\/script>/, '');
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      /* Individually, so one missing asset can't fail the whole install and
         leave the terminal with no shell at all. */
      await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    } catch (e) { /* install anyway; the shell is cached on the next real navigation */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('kashikeyo-v2')).map((k) => caches.delete(k)));
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
  /* Never interpose on the API — real data, the outbox and the connectivity
     indicator must always see the true network result. */
  if (url.pathname.startsWith('/api/')) return;

  /* Navigations anywhere under /v2 or /app: network-first, sanitized-shell
     fallback. */
  if (req.mode === 'navigate' && inScope(url.pathname)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type !== 'opaqueredirect') {
          /* Clone immediately, before the browser starts consuming `fresh`'s
             body, and cache the sanitized copy in the background — never
             delay the real page paint waiting for this. */
          const forCache = fresh.clone();
          event.waitUntil((async () => {
            try {
              const text = await forCache.text();
              const sanitized = stripInjectedData(text);
              const shellRes = new Response(sanitized, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
              const cache = await caches.open(CACHE);
              await cache.put(SHELL_KEY, shellRes);
            } catch (e) { /* caching the shell is best-effort */ }
          })());
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(SHELL_KEY);
        if (cached) {
          /* Tell the boot script this came from the offline shell, not a
             live fetch, so it knows to try rebuilding window.KPOS_REAL from
             the IndexedDB snapshot instead of assuming the demo/no-session
             case (which never sets this flag). */
          const text = await cached.text();
          const marked = text.replace('<base href="/v2/">', '<base href="/v2/"><script>window.__v2FromCache=true;</script>');
          return new Response(marked, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        throw e;
      }
    })());
    return;
  }

  /* Static assets under /v2 (and the shared root icons): serve from cache
     when we have it, and refresh it in the background so a deploy lands on
     the next load. */
  if (url.pathname.startsWith('/v2/') || /^\/(icon-\d+)\.png$/.test(url.pathname)) {
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
