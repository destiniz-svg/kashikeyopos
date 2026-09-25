'use strict';
/* KashikeyoPOS service worker — Web Push only. No caching, no offline shell:
   the durable outbox and the offline pill are app/kashikeyo-api.js's job,
   done in the page. This file exists for one reason — a push can reach a
   till even while the tab is not the foreground window (a locked Android
   phone, an iPhone PWA that has been backgrounded) — and it does nothing
   else. Registered from Settings, on a user gesture, never on load. */

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

/* A LOCK SCREEN IS A PUBLIC SURFACE. The payload is whatever src/notify.js
   composed server-side — never a total, a name or a phone number (see the
   call sites in src/routes/guest.js and src/routes/sync.js) — so nothing
   read here needs to be treated as sensitive, but the notification is still
   built defensively: a payload that fails to parse shows a generic line
   rather than throwing and showing nothing at all. */
self.addEventListener('push', function (event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = String(data.title || 'KashikeyoPOS').slice(0, 60);
  const body = String(data.body || '').slice(0, 160);
  const action = String(data.action || '');

  // One action, named for what it opens — never a generic "View". A second
  // action button is a second decision on a lock screen, which is the
  // opposite of what an alert like this needs to be.
  const actionLabel = action === 'ticket' ? 'Open the table'
    : action === 'qr_order' ? 'Open the round'
    : action === 'bill' ? 'Open the bill'
    : 'Open';

  event.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: '/brand/kashikeyo-mark.png',
    badge: '/brand/kashikeyo-mark.png',
    // Same tag + renotify: a second "bill asked" for a table that is still
    // waiting replaces the first rather than stacking a pile of identical
    // alerts — the noise budget this control was critiqued against.
    tag: action + ':' + (data.ticketId || data.table || ''),
    renotify: true,
    requireInteraction: false,
    data: data,
    actions: [{ action: 'open', title: actionLabel }]
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'kpos-push-open', data: data });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
