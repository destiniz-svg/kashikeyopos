'use strict';
/* ═══ THE WAKE-UP ═══════════════════════════════════════════════════════════
   One outlet's changes, told to whichever of its own devices are listening.
   This is deliberately not a second sync protocol: the message says only
   "outlet X changed, pull now" and carries no data of its own — the client's
   existing pull() already knows how to read what changed, exactly as the
   5-second poll does today. Duplicating that here would be a second place
   for the two to drift.

   In-process, in memory — the same doctrine src/limit.js and src/watch.js
   already keep, and for the same reason: this product is sold one install
   per customer (see CLAUDE.md), so there is one process, and a registry that
   forgets on restart is the correct failure. If this build ever runs as
   replicas, this is the seam to move onto something shared.
   ═══════════════════════════════════════════════════════════════════════ */
const clients = new Map(); // outletId -> Set<res>

function add(outletId, res) {
  let set = clients.get(outletId);
  if (!set) { set = new Set(); clients.set(outletId, set); }
  set.add(res);
  return function remove() {
    const s = clients.get(outletId);
    if (!s) return;
    s.delete(res);
    if (!s.size) clients.delete(outletId);
  };
}

// Told to every stream open on this outlet. A write that fails (a socket
// that died between the heartbeat and this) is swallowed here — req.on
// ('close') is what cleans the registry, not a failed write.
function changed(outletId) {
  const set = clients.get(outletId);
  if (!set || !set.size) return;
  const line = 'event: changed\ndata: ' + JSON.stringify({ at: Date.now() }) + '\n\n';
  for (const res of set) { try { res.write(line); } catch (e) {} }
}

function count(outletId) {
  const set = clients.get(outletId);
  return set ? set.size : 0;
}

module.exports = { add, changed, count };
