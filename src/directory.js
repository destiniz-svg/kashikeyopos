'use strict';
/* ═══ WHERE AN ADDRESS POINTS ═══════════════════════════════════════════════
   Every request on <handle>.kashikeyopos.com has to know, before it routes,
   whether that handle is a store's current address or one it gave up. A
   retired address must 301 to the current one — the card is already stuck to
   the table, and the guest holding it should end up at the right menu with the
   right thing in their address bar, not at a 404 and not at the old name.

   That is a database question on the hot path of every guest request, so the
   directory is held in memory and refreshed wholesale: an install has tens of
   outlets, not thousands, and one query loads all of them.

   Two rules it follows so a refresh can never hurt a guest:

     · a failed refresh keeps serving the previous answer. A directory that
       cannot reach the database is stale; a guest who gets a 500 is stuck;
     · the cache only ever decides whether to REDIRECT. Every endpoint that
       actually resolves a store asks the database, so a stale entry costs one
       extra hop and never serves the wrong outlet's menu.

   It reads through the owner connection, like the table-token mint in
   src/routes/guest.js and for the same reason: a request arriving on a
   subdomain has no outlet context yet — establishing which outlet it belongs
   to is the whole job.
   ═══════════════════════════════════════════════════════════════════════ */

const { owner } = require('./db');

const TTL_MS = 30000;

let entries = null;        // Map handle -> { outletId, current, retired }
let loadedAt = 0;
let inflight = null;

async function refresh() {
  const q = await owner().query(
    'SELECT o.slug AS handle, o.id AS outlet_id, o.slug AS current, false AS retired'
    + '  FROM chain.outlet o WHERE o.active'
    + ' UNION ALL '
    + 'SELECT x.handle, o.id, o.slug, true'
    + '  FROM chain.outlet_handle_history x'
    + '  JOIN chain.outlet o ON o.id = x.outlet_id WHERE o.active');
  const next = new Map();
  // A live address always wins a retired one of the same spelling: an outlet
  // that took its own former name back is at that name, not redirecting to it.
  q.rows.forEach((r) => {
    const have = next.get(r.handle);
    if (have && !have.retired) return;
    next.set(r.handle, { outletId: r.outlet_id, current: r.current, retired: r.retired });
  });
  entries = next;
  loadedAt = Date.now();
  return entries;
}

async function ensure() {
  if (entries && Date.now() - loadedAt < TTL_MS) return entries;
  if (!inflight) {
    inflight = refresh()
      .catch(function (e) {
        // Stale beats broken. Say it once per refresh, not once per request.
        console.error('[directory] could not refresh: ' + e.message);
        return entries;
      })
      .then(function (v) { inflight = null; return v; });
  }
  return inflight;
}

/* The store this address belongs to, or null when nothing answers to it. */
async function lookup(handle) {
  if (!handle) return null;
  const map = await ensure();
  return (map && map.get(handle)) || null;
}

/* The handle this one should redirect to, or null to stay where it is. A
   handle nobody answers to does NOT redirect: the portal says the address
   names no store, which is the truth, where a redirect to the apex would hand
   a guest the till. */
async function movedTo(handle) {
  const hit = await lookup(handle);
  if (!hit || !hit.retired || hit.current === handle) return null;
  return hit.current;
}

// After a rename, the next request should see it rather than wait out the TTL.
function forget() { loadedAt = 0; }

module.exports = { lookup, movedTo, forget, refresh, TTL_MS };
