/* KILL SWITCH — kashikeyo-4.0.0-unregister.
   The register/till used to be a baked, offline-first bundle served at /app,
   and this worker cached its app shell. /app (and /admin, and the guest
   portal) are now live, server-rendered pages with no service worker and
   Cache-Control:no-cache. Any browser still running the OLD worker keeps
   serving that frozen shell from cache — the sample menu and demo staff
   (Abdulla/Shifna/Ahmed) users saw after "Go to dashboard" / sign-out.

   This build replaces the worker with one that removes itself: it purges
   every cache, unregisters, and reloads any open page so it loads the live
   app from the network. Because browsers fetch the worker script itself over
   the network (bypassing any fetch handler) on each navigation, even a stale
   cache-first worker will pick this up and self-destruct. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* nothing to purge */ }
    try { await self.clients.claim(); } catch (e) {}
    let clients = [];
    try { clients = await self.clients.matchAll({ type: 'window' }); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    // Reload open pages so they re-fetch the live app instead of the cache.
    clients.forEach((c) => { try { c.navigate(c.url); } catch (e) {} });
  })());
});

/* Deliberately no fetch handler: with none registered every request goes
   straight to the network, so even in the brief window before this worker
   finishes unregistering nothing is served from the old cache. */
