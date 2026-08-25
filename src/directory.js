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

   It reads the REGISTRY, because a handle is one name on the internet and a
   business database only knows its own outlets. Asking a business database
   "who holds seaside" gets the answer "nobody" from every business that does
   not, which is how two customers both get told a name is free and only one
   gets the traffic. One registry, one answer.

   No outlet context is involved: a request arriving on a subdomain has not
   established which outlet it belongs to yet — that is the whole job.
   ═══════════════════════════════════════════════════════════════════════ */

const { control } = require('./db');

const TTL_MS = 30000;

let entries = null;        // Map handle -> { outletId, current, retired }
let loadedAt = 0;
let inflight = null;

async function refresh() {
  const q = await control().query(
    'SELECT h.name AS handle, h.outlet_id, h.business_id, h.name AS current,'
    + ' false AS retired FROM chain.handle h'
    + '  JOIN chain.outlet_directory d ON d.outlet_id = h.outlet_id AND d.active'
    + ' UNION ALL '
    + 'SELECT y.name, y.outlet_id, y.business_id, c.name, true'
    + '  FROM chain.handle_history y'
    + '  JOIN chain.outlet_directory d ON d.outlet_id = y.outlet_id AND d.active'
    + '  LEFT JOIN chain.handle c ON c.outlet_id = y.outlet_id');
  const next = new Map();
  // A live address always wins a retired one of the same spelling: an outlet
  // that took its own former name back is at that name, not redirecting to it.
  q.rows.forEach((r) => {
    const have = next.get(r.handle);
    if (have && !have.retired) return;
    next.set(r.handle, { outletId: r.outlet_id, businessId: r.business_id,
      current: r.current, retired: r.retired });
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
