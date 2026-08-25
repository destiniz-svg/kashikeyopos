'use strict';
/* ═══ A REVOKED TOKEN IS REFUSED, NOT MERELY RECORDED ═══════════════════════
   Two columns existed and nothing ever read either of them.

   `chain.session.revoked_at` is set by "Sign out other sessions". `session()`
   in src/auth.js verifies the JWT and touches no database, so a revoked
   session kept working until its token expired — twelve hours. The screen said
   the other terminals had been signed out; they had not.

   `chain.device.revoked` is set by deregistering a device. Nothing consulted
   it either, so a device taken off the estate kept signing in and kept
   writing. That is the exact scenario the card's own copy invokes: "a lost
   tablet stops being a way into the till the moment you press it."

   So both are checked here, on every authenticated request. The cost is
   bounded by a POSITIVE cache: a session known good is not asked about again
   for thirty seconds. Two things make that honest rather than a compromise:

     · revocation is one-way, so a cached "good" can only ever be stale, never
       wrong in the dangerous direction — and only for that window;
     · this product is sold ONE INSTALL PER CUSTOMER, so there is a single
       process. `forget()` is called by the endpoints that revoke, which means
       revocation is IMMEDIATE here and the thirty seconds is the bound for a
       replica set that does not exist yet. If this ever runs as replicas, this
       file is the one seam to move onto something shared — same note as
       src/limit.js.

   It reads under the OUTLET role, not the owner connection: the token names
   its own outlet, and `session_scoped` / `device_scoped` both let an outlet
   read its own rows. There is no seventh owner exception here.
   ═══════════════════════════════════════════════════════════════════════ */

const { withOutletRead } = require('./db');

const TTL_MS = 30000;
const CAP = 5000;            // a bound, not a tuning knob: one till per key

const good = new Map();      // sid -> expires at (ms)

function forget(sid) {
  if (sid) good.delete(sid);
  else good.clear();
}

/* Whether this token may still act. `null` sid is a token minted before
   sessions were recorded, and a device-less token is a browser that never
   paired — neither can be revoked, so neither is refused. */
async function stillGood(ctx) {
  const sid = ctx.sessionId;
  if (!sid) return { ok: true };

  const hit = good.get(sid);
  if (hit && hit > Date.now()) return { ok: true };

  let row;
  try {
    row = await withOutletRead(ctx, async function (c) {
      const s = await c.query('SELECT revoked_at, expires_at FROM chain.session'
        + ' WHERE id = $1', [sid]);
      const d = ctx.deviceId
        ? await c.query('SELECT revoked FROM chain.device WHERE id = $1', [ctx.deviceId])
        : { rows: [] };
      return { s: s.rows[0] || null, d: d.rows[0] || null };
    });
  } catch (e) {
    /* The database is unreachable or the row is unreadable. Refusing here
       would sign the whole floor out over a blip, which is a worse failure
       than a revocation taking effect a moment late — the same "fails open"
       call src/limit.js makes, and for the same reason. */
    return { ok: true };
  }

  if (row.d && row.d.revoked) return { ok: false, why: 'device' };
  /* A session row that is simply ABSENT is not a refusal: op_log-style pruning
     and a restored backup can both outlive a row while the token is honest,
     and the token carries its own expiry, which `verify()` already enforced. */
  if (row.s && row.s.revoked_at) return { ok: false, why: 'session' };

  if (good.size >= CAP) good.clear();
  good.set(sid, Date.now() + TTL_MS);
  return { ok: true };
}

module.exports = { stillGood, forget, TTL_MS };
