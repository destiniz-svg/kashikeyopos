'use strict';
/* ═══ SENDING A PUSH, AFTER THE OP THAT EARNED IT HAS COMMITTED ═════════════
   Same doctrine as src/watch.js and src/email.js: a send is best-effort and
   never blocks or slows the request that triggered it. The caller fires this
   and moves on — nothing here is awaited by a sync push response or a guest
   order's 201.

   Every notify function opens its OWN read (for the subscription rows) and,
   on a 404/410, its own write (to delete the dead subscription) — never
   inside the triggering op's own transaction, which may already have
   committed by the time a push service answers.

   A payload here is what a lock screen may show: what happened and where —
   never a total, a name or a phone number. See the call sites in
   src/routes/guest.js and src/routes/sync.js for what each event actually
   sends. */
const { withOutletRead, withOutlet, control } = require('./db');
const push = require('./push');

// Absent, not broken (the AI seam's own doctrine): no CONTROL_DB and no
// VAPID_* override means push sends fail, once, quietly logged — never a
// thrown error that could reach a caller who did not ask to wait for this.
function controlPoolOrNull() {
  try { return control(); } catch (e) { return null; }
}

const loggedOnce = {};
function logOnce(outletId, message) {
  const key = outletId + '|' + message;
  if (loggedOnce[key]) return;
  loggedOnce[key] = 1;
  console.error('[push] outlet ' + outletId + ': ' + message);
}

async function deliverAll(outletId, subs, payload) {
  const pool = controlPoolOrNull();
  for (const sub of subs) {
    try {
      const result = await push.sendPush(pool, sub, payload, { timeoutMs: 5000 });
      if (result.gone) {
        await withOutlet({ outletId, rank: 5, actor: null }, (c) =>
          c.query('DELETE FROM push_subscription WHERE endpoint = $1', [sub.endpoint]));
      } else if (result.ok) {
        await withOutlet({ outletId, rank: 5, actor: null }, (c) =>
          c.query('UPDATE push_subscription SET last_ok_at = now() WHERE endpoint = $1', [sub.endpoint]));
      } else {
        logOnce(outletId, 'push service answered ' + result.status);
      }
    } catch (e) {
      logOnce(outletId, (e && e.message) || 'send failed');
    }
  }
}

// Order ready — the staff member who took/owns the ticket, and nobody else.
async function notifyStaff(outletId, staffId, payload) {
  if (!staffId) return;
  try {
    const subs = await withOutletRead({ outletId, rank: 5, actor: null }, (c) =>
      c.query('SELECT endpoint, p256dh, auth FROM push_subscription WHERE staff_id = $1',
        [staffId]).then((q) => q.rows));
    if (subs.length) await deliverAll(outletId, subs, payload);
  } catch (e) { logOnce(outletId, (e && e.message) || 'notifyStaff failed'); }
}

// Bill asked, a QR order to accept, sold out — every till device, rank >= 2.
// Read at SEND time from chain.staff, never cached at subscribe time, so a
// promotion or a demotion takes effect on the next alert. No outlet_id filter:
// push_subscription already lives in THIS outlet's schema, and someone granted
// this outlet through staff.outlets (homed elsewhere) must be woken too.
async function notifyTill(outletId, payload) {
  try {
    const subs = await withOutletRead({ outletId, rank: 5, actor: null }, (c) =>
      c.query('SELECT ps.endpoint, ps.p256dh, ps.auth FROM push_subscription ps'
        + ' JOIN chain.staff s ON s.id = ps.staff_id'
        + ' WHERE s.rank >= 2 AND s.active').then((q) => q.rows));
    if (subs.length) await deliverAll(outletId, subs, payload);
  } catch (e) { logOnce(outletId, (e && e.message) || 'notifyTill failed'); }
}

module.exports = { notifyStaff, notifyTill };
