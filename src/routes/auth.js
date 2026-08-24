'use strict';
const express = require('express');
const { owner, withOutlet } = require('../db');
const { sign, pinMatches, hashPin, pairCode } = require('../secrets');
const { session, atLeast, ROLE_KEY_BY_RANK } = require('../auth');
const { take, room, gate } = require('../limit');

const r = express.Router();

/* ── WHO A WRONG PIN COSTS ──────────────────────────────────────────────────
   A PIN is four digits, so the lockout — not the entropy — is what makes it
   safe. The lockout that shipped was outlet-wide and reachable by anyone who
   could reach the endpoint: five POSTs, no credential, no device, and every
   keypad on the floor is dead for fifteen minutes, at seven on a Friday,
   repeatable for as long as the attacker cares to keep going. It was a
   security guard that doubled as a denial-of-service lever, and the lever was
   cheaper to pull than the attack it defended against.

   Two tiers now, and the difference between them is what the failures PROVE.

   TIER ONE — the caller. Six wrong PINs and THIS caller is refused for fifteen
   minutes: the till it was keyed on, or the connection when the caller is not
   a paired till. Somebody standing at a keypad fat-fingering their own PIN
   slows down; nobody else on the floor notices. An attacker can lock exactly
   one thing, and it is themselves.

   TIER TWO — the outlet. Forty wrong PINs at one outlet inside the same window
   is no longer somebody mistyping. It is a distributed attempt on a four-digit
   space, the accounts themselves are now at risk, and the original outlet-wide
   lockout engages exactly as it always did. Getting there costs an attacker
   seven distinct callers rather than one request.

   The budget is spent only on FAILURE. A counter signing its staff in
   correctly all evening never touches it. */
const LOCK_MINS = 15;
const CALLER_TRIES = 6;          // tier one: what one caller may get wrong
const OUTLET_FAILS = 40;         // tier two: what an outlet may get wrong

/* A paired till names itself; an unpaired caller is its connection. A device
   id is client-supplied and therefore forgeable — which only ever buys the
   forger more tier-one budget, and tier two is the wall that stands behind
   it. What it buys everyone else is that one till's mistakes are never
   charged to the till beside it. */
function callerKey(req, deviceId) {
  return deviceId ? 'pin-dev:' + deviceId : 'pin-ip:' + (req.ip || 'unknown');
}

/* ── is this installation still empty? ──────────────────────────────────────
   The front door asks before deciding between onboarding and the PIN pad, and
   it asks anonymously, because at that moment nobody can sign in yet. It
   returns counts and the outlet list — never a staff name, never a PIN. */
r.get('/install', async function (req, res, next) {
  try {
    const st = await owner().query('SELECT * FROM chain.install_state()');
    const s = st.rows[0] || { outlets: 0, staff: 0, company: 0 };
    const outlets = Number(s.outlets) > 0
      ? await owner().query(
        // The rate in force today, resolved here rather than defaulted on the
        // client: a lock screen that says "GGST 0%" at an outlet charging 8%
        // is the first thing a manager will not trust.
        'SELECT o.id, o.code, o.name, o.tax_code, o.service_pct, o.currency, o.active,'
        + ' coalesce((SELECT tv.rate FROM chain.tax_version tv'
        + '   WHERE tv.outlet_id = o.id AND tv.effective_from <= current_date'
        + '     AND (tv.effective_to IS NULL OR tv.effective_to >= current_date)'
        + '   ORDER BY tv.effective_from DESC LIMIT 1), 0) AS rate'
        + ' FROM chain.outlet o WHERE o.active ORDER BY o.id').then((q) => q.rows)
      : [];
    // The trading name and the brand mark are on the shopfront: a lock screen
    // that cannot name the business it belongs to is a lock screen nobody
    // trusts. The registration number, the TIN and the address are NOT here —
    // those go out only to a signed-in session.
    const co = Number(s.company) > 0
      ? await owner().query('SELECT legal_name, country, base_currency, brand'
        + ' FROM chain.company WHERE id = 1').then((q) => q.rows[0])
      : null;
    res.set('cache-control', 'no-store').json({
      ready: Number(s.outlets) > 0 && Number(s.staff) > 0 && Number(s.company) > 0,
      outlets: outlets,
      merchant: co ? {
        name: (co.brand && co.brand.name) || co.legal_name,
        country: co.country === 'Maldives' ? 'MV' : co.country,
        currency: co.base_currency,
        colour: (co.brand && co.brand.colour) || null,
        tagline: (co.brand && co.brand.tagline) || ''
      } : null,
      hasCompany: Number(s.company) > 0,
      hasStaff: Number(s.staff) > 0
    });
  } catch (e) { next(e); }
});

/* ── who can sign in at this terminal ───────────────────────────────────────
   A shared till never asks for a password: staff tap their own face and key
   four digits, which is what makes a void or a drawer opening attributable to
   a person rather than to "the till".

   That means the roster has to be readable before anyone is signed in. It
   returns a display name, a role label and an initial — and nothing else. No
   id that grants anything, no PIN, no hash, no employment record. The people
   on this list are standing in front of the terminal; their names are not the
   secret. The PIN is, and it is checked server-side against a scrypt hash
   this terminal never receives.
*/
r.get('/roster',
  /* Anonymous by design — the people on it are standing in front of the
     terminal — but "not a secret" is not the same as "free to harvest". One
     connection asking for a roster four hundred times an hour is building a
     staff list, not opening a till. The ceiling is wide enough that a whole
     restaurant behind one address never reaches it. */
  gate('roster', { ip: [120, 600e3] }, null),
  async function (req, res, next) {
  const oid = Number(req.query.outletId);
  if (!oid) return res.status(400).json({ error: 'outletId required' });
  try {
    const rows = await withOutlet({ outletId: oid, rank: 0 }, (c) =>
      c.query('SELECT id, name, rank, role_key, locked_until FROM chain.pin_candidates($1)',
        [oid]).then((q) => q.rows));
    res.set('cache-control', 'no-store').json({
      staff: rows.map((s) => ({
        id: s.id, name: s.name, rank: s.rank, roleKey: s.role_key,
        user: String(s.name || '').split(' ').pop().toLowerCase(),
        initials: String(s.name || '').split(/\s+/).map((w) => w[0] || '')
          .join('').slice(0, 2).toUpperCase(),
        locked: !!(s.locked_until && new Date(s.locked_until) > new Date())
      }))
    });
  } catch (e) { next(e); }
});

/* ── sign in with a PIN, at one outlet, on one device ───────────────────────
   One implementation, used by both the keypad and the hand-over sheet, so
   there is one lockout, one audit record and one token shape. */
async function pinSignIn(oid, pin, deviceId, caller) {
  return withOutlet({ outletId: oid, rank: 0 }, async function (c) {
    const q = await c.query('SELECT * FROM chain.pin_candidates($1)', [oid]);
    const now = Date.now();
    let anyLocked = false;
    for (const s of q.rows) {
      if (s.locked_until && new Date(s.locked_until).getTime() > now) { anyLocked = true; continue; }
      if (!pinMatches(pin, s.pin_hash, s.pin_salt)) continue;

      await c.query('SELECT chain.pin_ok($1)', [s.id]);
      const hours = Number(process.env.SESSION_TTL_HOURS || 12);
      const sess = await c.query(
        'INSERT INTO chain.session (staff_id, outlet_id, device_id, rank, expires_at)'
        + " VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval) RETURNING id",
        [s.id, oid, deviceId || null, s.rank, String(hours)]);
      if (deviceId) {
        await c.query('UPDATE chain.device SET last_seen = now() WHERE id = $1', [deviceId]);
      }
      await c.query("SELECT chain.log_anon($1,'sign_in','staff',$2,$3)",
        [oid, s.id, JSON.stringify({ rank: s.rank, device: deviceId || null })]);
      return {
        token: sign({
          o: oid, r: s.rank, s: s.id, n: s.name,
          rk: s.role_key || ROLE_KEY_BY_RANK[s.rank],
          d: deviceId || null, sid: sess.rows[0].id,
          exp: now + hours * 3600e3
        }),
        name: s.name, rank: s.rank, roleKey: s.role_key || ROLE_KEY_BY_RANK[s.rank],
        staffId: s.id, outletId: oid, expiresAt: now + hours * 3600e3
      };
    }
    /* Wrong PIN. Tier one first — this caller pays for its own mistake — and
       then tier two, which only engages once the outlet's whole allowance is
       gone. pin_failed() keeps its contract; the DECISION moved up here, where
       both tiers can be seen together. */
    if (caller) take(caller, CALLER_TRIES, LOCK_MINS * 60e3);
    const wide = take('pin-outlet:' + oid, OUTLET_FAILS, LOCK_MINS * 60e3);
    if (!wide.ok) {
      await c.query('SELECT chain.pin_failed($1,$2,$3)', [oid, 1, LOCK_MINS]);
      return { refused: true, locked: true, wide: true };
    }
    return { refused: true, locked: anyLocked };
  });
}

function refusal(out) {
  return out.locked
    ? 'Too many attempts — the keypad is locked for ' + LOCK_MINS + ' minutes'
    : 'PIN not recognised';
}

/* The tier-one refusal names the terminal rather than the floor, because that
   is what is actually locked. An operator told "the keypad is locked" while
   the till beside them is taking money learns the app is lying to them. */
function tooMany(res, retry) {
  res.set('retry-after', String(Math.max(1, retry)));
  return res.status(429).json({
    error: 'Too many wrong PINs on this terminal — try again in '
      + (retry > 90 ? Math.ceil(retry / 60) + ' minutes' : 'a minute')
      + '. Other terminals are unaffected.'
  });
}

r.post('/pin', async function (req, res, next) {
  const { outletId, pin, deviceId } = req.body || {};
  if (!outletId || !pin) return res.status(400).json({ error: 'outletId and pin required' });
  const caller = callerKey(req, deviceId);
  const left = room(caller, CALLER_TRIES, LOCK_MINS * 60e3);
  if (!left.ok) return tooMany(res, left.retry);
  try {
    const out = await pinSignIn(Number(outletId), pin, deviceId, caller);
    if (out.refused) return res.status(401).json({ error: refusal(out) });
    res.json(out);
  } catch (e) { next(e); }
});

r.use(session);

r.get('/me', function (req, res) {
  res.set('cache-control', 'no-store').json(req.ctx);
});

r.post('/signout', async function (req, res, next) {
  try {
    await withOutlet(req.ctx, async function (c) {
      if (req.ctx.sessionId) {
        await c.query('UPDATE chain.session SET revoked_at = now() WHERE id = $1',
          [req.ctx.sessionId]);
      }
      await c.query("SELECT chain.log('sign_out','staff',$1,NULL,NULL)", [req.ctx.actor]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ── hand over the terminal: a second PIN swaps the actor without closing the
      shift. Every subsequent action is attributable to the new person. ────── */
r.post('/switch', async function (req, res, next) {
  const { pin, deviceId } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin required' });
  // A hand-over is a PIN attempt like any other and pays into the same two
  // tiers — it is behind a session, but the session belongs to the person
  // handing OVER, which is exactly who a shoulder-surfer already is.
  const dev = deviceId || req.ctx.deviceId;
  const caller = callerKey(req, dev);
  const left = room(caller, CALLER_TRIES, LOCK_MINS * 60e3);
  if (!left.ok) return tooMany(res, left.retry);
  try {
    const out = await pinSignIn(req.ctx.outletId, pin, dev, caller);
    if (out.refused) return res.status(401).json({ error: refusal(out) });
    res.json(out);
  } catch (e) { next(e); }
});

/* ── revoke every session for this outlet: the "lost terminal" button ─────── */
r.post('/revoke', atLeast('admin'), async function (req, res, next) {
  try {
    const n = await withOutlet(req.ctx, async function (c) {
      const q = await c.query('UPDATE chain.session SET revoked_at = now()'
        + ' WHERE outlet_id = $1 AND revoked_at IS NULL AND expires_at > now()'
        + ' AND id <> coalesce($2, id)', [req.ctx.outletId, req.ctx.sessionId]);
      await c.query("SELECT chain.log('revoke_sessions','session',NULL,NULL,$1)",
        [JSON.stringify({ count: q.rowCount })]);
      return q.rowCount;
    });
    res.json({ revoked: n });
  } catch (e) { next(e); }
});

/* ── devices. A device is attributable or it is not allowed to take money. ── */
r.get('/devices', atLeast('manager'), async function (req, res, next) {
  try {
    const rows = await withOutlet(req.ctx, (c) => c.query(
      'SELECT id, label, kind, station, paired_at, last_seen, last_push_at, revoked, pair_code,'
      + ' pair_expires FROM chain.device WHERE outlet_id = $1 ORDER BY label',
      [req.ctx.outletId]).then((q) => q.rows));
    res.json({ devices: rows });
  } catch (e) { next(e); }
});

r.post('/devices', atLeast('manager'), async function (req, res, next) {
  const { label, kind, station } = req.body || {};
  if (!label || !kind) return res.status(400).json({ error: 'label and kind required' });
  try {
    const row = await withOutlet(req.ctx, async function (c) {
      const code = pairCode();
      const q = await c.query(
        'INSERT INTO chain.device (outlet_id, label, kind, station, pair_code,'
        + " pair_expires) VALUES ($1,$2,$3,$4,$5, now() + interval '15 minutes')"
        + ' RETURNING id, label, kind, station, pair_code, pair_expires',
        [req.ctx.outletId, label, kind, station || null, code]);
      await c.query("SELECT chain.log('device_paired','device',$1,NULL,$2)",
        [q.rows[0].id, JSON.stringify({ label, kind })]);
      return q.rows[0];
    });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

r.post('/devices/:id/revoke', atLeast('manager'), async function (req, res, next) {
  try {
    await withOutlet(req.ctx, async function (c) {
      await c.query('UPDATE chain.device SET revoked = true WHERE id = $1 AND outlet_id = $2',
        [req.params.id, req.ctx.outletId]);
      await c.query("SELECT chain.log('device_deregister','device',$1,NULL,NULL)", [req.params.id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ── staff accounts. Admin+ only, and never above the writer's own rank —
      the RLS policy enforces that too, so a bug here cannot get past it. ──── */
r.get('/staff', atLeast('manager'), async function (req, res, next) {
  try {
    const rows = await withOutlet(req.ctx, (c) => c.query(
      'SELECT id, name, rank, role_key, outlet_id, outlets, active, locked_until,'
      + ' failed FROM chain.staff ORDER BY rank DESC, name').then((q) => q.rows));
    res.json({ staff: rows });
  } catch (e) { next(e); }
});

r.post('/staff', atLeast('admin'), async function (req, res, next) {
  const { name, rank, roleKey, pin, outlets } = req.body || {};
  if (!name || !rank || !pin) return res.status(400).json({ error: 'name, rank and pin required' });
  if (Number(rank) > req.ctx.rank) {
    return res.status(403).json({ error: 'You cannot create an account above your own rank' });
  }
  if (!/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
  try {
    const h = hashPin(pin);
    const row = await withOutlet(req.ctx, async function (c) {
      const q = await c.query(
        'INSERT INTO chain.staff (name, rank, role_key, outlet_id, outlets, pin_hash, pin_salt)'
        + ' VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, rank, role_key, active',
        [name, Number(rank), roleKey || ROLE_KEY_BY_RANK[Number(rank)], req.ctx.outletId,
          Array.isArray(outlets) ? outlets.map(Number) : [], h.hash, h.salt]);
      await c.query("SELECT chain.log('access_change','staff',$1,NULL,$2)",
        [q.rows[0].id, JSON.stringify({ name, rank: Number(rank) })]);
      return q.rows[0];
    });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

r.patch('/staff/:id', atLeast('admin'), async function (req, res, next) {
  const b = req.body || {};
  if (b.rank != null && Number(b.rank) > req.ctx.rank) {
    return res.status(403).json({ error: 'You cannot set a rank above your own' });
  }
  try {
    const row = await withOutlet(req.ctx, async function (c) {
      const before = await c.query('SELECT name, rank, role_key, active FROM chain.staff'
        + ' WHERE id = $1', [req.params.id]);
      const set = [], vals = [req.params.id];
      const add = (col, v) => { vals.push(v); set.push(col + ' = $' + vals.length); };
      if (b.name != null) add('name', b.name);
      if (b.rank != null) add('rank', Number(b.rank));
      if (b.roleKey != null) add('role_key', b.roleKey);
      if (b.active != null) add('active', !!b.active);
      if (Array.isArray(b.outlets)) add('outlets', b.outlets.map(Number));
      if (b.permOverride) add('perm_override', JSON.stringify(b.permOverride));
      if (b.pin) {
        if (!/^\d{4,8}$/.test(String(b.pin))) throw Object.assign(new Error('PIN must be 4 to 8 digits'), { status: 400 });
        const h = hashPin(b.pin);
        add('pin_hash', h.hash); add('pin_salt', h.salt);
        add('failed', 0); add('locked_until', null);
      }
      if (b.unlock) { add('failed', 0); add('locked_until', null); }
      if (!set.length) throw Object.assign(new Error('nothing to change'), { status: 400 });
      const q = await c.query('UPDATE chain.staff SET ' + set.join(', ')
        + ' WHERE id = $1 RETURNING id, name, rank, role_key, active', vals);
      if (!q.rows.length) throw Object.assign(new Error('not found'), { status: 404 });
      await c.query("SELECT chain.log($1,'staff',$2,$3,$4)",
        [b.pin ? 'pin_reset' : 'permission_change', req.params.id,
          JSON.stringify(before.rows[0] || null), JSON.stringify(q.rows[0])]);
      return q.rows[0];
    });
    res.json(row);
  } catch (e) { next(e); }
});

module.exports = r;
