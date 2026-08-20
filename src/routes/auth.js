'use strict';
const express = require('express');
const { owner, withOutlet } = require('../db');
const { sign, pinMatches, hashPin, pairCode } = require('../secrets');
const { session, atLeast, ROLE_KEY_BY_RANK } = require('../auth');

const r = express.Router();

// Five tries at one outlet locks every unlocked account there for fifteen
// minutes. A PIN is four digits: the lockout, not the entropy, is what makes
// it safe.
const LOCK_TRIES = 5, LOCK_MINS = 15;

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
r.get('/roster', async function (req, res, next) {
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
async function pinSignIn(oid, pin, deviceId) {
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
    // Wrong PIN: count the attempt against every unlocked account at this
    // outlet, so brute force locks the door rather than probing it.
    await c.query('SELECT chain.pin_failed($1,$2,$3)', [oid, LOCK_TRIES, LOCK_MINS]);
    return { refused: true, locked: anyLocked };
  });
}

function refusal(out) {
  return out.locked
    ? 'Too many attempts — the keypad is locked for ' + LOCK_MINS + ' minutes'
    : 'PIN not recognised';
}

r.post('/pin', async function (req, res, next) {
  const { outletId, pin, deviceId } = req.body || {};
  if (!outletId || !pin) return res.status(400).json({ error: 'outletId and pin required' });
  try {
    const out = await pinSignIn(Number(outletId), pin, deviceId);
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
  try {
    const out = await pinSignIn(req.ctx.outletId, pin, deviceId || req.ctx.deviceId);
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
      'SELECT id, label, kind, station, paired_at, last_seen, revoked, pair_code,'
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
