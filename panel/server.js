'use strict';
/* ═══ MISSION CONTROL — THE SELLER'S PANEL ══════════════════════════════════
   The product is sold ONE INSTALL PER CUSTOMER: each customer gets their own
   app service and their own database, which is what keeps every isolation
   guarantee in this repository true per-customer by construction. This panel
   is the seller's view across those installs — who is live, who is on trial,
   whose tills have gone quiet, what today took — and it is a SEPARATE app in
   the same repository, run as its own service (`node panel/server.js`) with
   its own small registry database. It never touches a customer's database:
   everything it knows arrives through each install's own
   `/api/platform/summary`, which serves aggregates and refuses the rest.

   THE KEYS LIVE HERE AND ONLY HERE. Each install's PLATFORM_KEY is held in
   the registry and used server-side; the browser gets figures, never keys.
   A panel page that carried the keys would make every seller's laptop a
   master key to every customer.

   Same doctrine as the rest: Node, Express, pg, hand-written HTML, no build
   step. Same discipline too — scrypt passwords, HMAC tokens, a doorman on
   the sign-in, honest states ("unreachable" is an answer, not an error).

   First run: no admin exists, so /api/setup accepts ONE admin creation,
   gated on PANEL_SETUP_TOKEN — a value set in the environment by the person
   deploying, spent by use. An open first-run form is a race anybody on the
   internet can win.
   ═══════════════════════════════════════════════════════════════════════ */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { gate } = require('../src/limit');

const SECRET = process.env.PANEL_SECRET || '';
if (SECRET.length < 32) {
  console.error('[panel] PANEL_SECRET must be at least 32 characters');
  process.exit(1);
}

/* One pool, guarded like the POS pools: a pg pool EMITS 'error' when an idle
   connection dies under it, and an unhandled 'error' event kills the process. */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  max: 5,
  application_name: 'kashikeyo-panel',
  ssl: process.env.PGSSL_CA
    ? { ca: process.env.PGSSL_CA, rejectUnauthorized: true, checkServerIdentity: () => undefined }
    : (process.env.DATABASE_URL && /railway|proxy\.rlwy/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false } : undefined)
});
pool.on('error', (e) => console.error('[panel] idle connection lost:', e.message));

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS panel;
    CREATE TABLE IF NOT EXISTS panel.admin (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      pass text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS panel.install (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      base_url text NOT NULL,
      platform_key text NOT NULL,
      kind text NOT NULL DEFAULT 'trial' CHECK (kind IN ('trial','paid','internal')),
      trial_ends date,
      notes text NOT NULL DEFAULT '',
      archived boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/* ── credentials, the same discipline as the POS ────────────────────────── */
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function checkPass(pw, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const a = crypto.scryptSync(String(pw), salt, 64);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sign(adminId) {
  const body = Buffer.from(JSON.stringify({ a: adminId, exp: Date.now() + 12 * 3600e3 }))
    .toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function authed(req, res, next) {
  const p = verify(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!p) return res.status(401).json({ error: 'sign in again' });
  req.adminId = p.a;
  next();
}

/* ── probing an install ─────────────────────────────────────────────────────
   Server-side, in parallel, bounded — a dead install must cost six seconds,
   not hang the whole overview. The states are the honest vocabulary the
   panel renders; "down" carries the reason it observed, never a guess. */
async function probe(inst) {
  const base = String(inst.base_url || '').replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/api/platform/summary', {
      headers: { authorization: 'Bearer ' + inst.platform_key },
      signal: AbortSignal.timeout(6000)
    });
    if (r.status === 401) return { state: 'refused', note: 'the install refused this platform key' };
    if (r.status === 404) return { state: 'nokey', note: 'no PLATFORM_KEY is set on the install' };
    if (!r.ok) return { state: 'down', note: 'HTTP ' + r.status };
    return { state: 'live', summary: await r.json() };
  } catch (e) {
    return { state: 'down', note: e.name === 'TimeoutError' ? 'no answer in 6s' : (e.cause && e.cause.code) || e.message };
  }
}

/* ── the app ────────────────────────────────────────────────────────────── */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.set('content-security-policy', "default-src 'self'; script-src 'self';"
    + " style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';"
    + " connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'no-referrer');
  next();
});

app.get('/readyz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

/* Whether the panel is virgin decides which screen the page opens on. */
app.get('/api/state', async (req, res, next) => {
  try {
    const q = await pool.query('SELECT count(*)::int AS n FROM panel.admin');
    res.json({ setup: q.rows[0].n === 0 });
  } catch (e) { next(e); }
});

app.post('/api/setup', gate('panel-setup', { ip: [10, 3600e3] }), async (req, res, next) => {
  try {
    const want = process.env.PANEL_SETUP_TOKEN || '';
    const { token, email, password } = req.body || {};
    const q = await pool.query('SELECT count(*)::int AS n FROM panel.admin');
    if (q.rows[0].n > 0) return res.status(409).json({ error: 'the panel is already set up' });
    if (want.length < 16) {
      return res.status(503).json({ error: 'PANEL_SETUP_TOKEN is not set in the environment — set it, redeploy, and try again' });
    }
    const a = Buffer.from(String(token || '')), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'that setup token is not the one in the environment' });
    }
    if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) return res.status(400).json({ error: 'a real email address is required' });
    if (String(password || '').length < 12) return res.status(400).json({ error: 'the password needs at least 12 characters' });
    const ins = await pool.query('INSERT INTO panel.admin (email, pass) VALUES ($1, $2) RETURNING id',
      [String(email).toLowerCase(), hashPass(password)]);
    res.json({ token: sign(ins.rows[0].id) });
  } catch (e) { next(e); }
});

app.post('/api/signin',
  gate('panel-signin', { ip: [30, 3600e3], id: [8, 3600e3] }, (req) => (req.body || {}).email),
  async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const q = await pool.query('SELECT id, pass FROM panel.admin WHERE email = $1',
        [String(email || '').toLowerCase()]);
      // One sentence either way: whether an address is an admin here is not a
      // question a stranger gets to ask.
      if (!q.rows.length || !checkPass(password, q.rows[0].pass)) {
        return res.status(401).json({ error: 'that email and password do not match' });
      }
      res.json({ token: sign(q.rows[0].id) });
    } catch (e) { next(e); }
  });

/* The whole dashboard in one answer: the registry rows (keys withheld) with
   each install's live probe beside them. */
app.get('/api/overview', authed, async (req, res, next) => {
  try {
    const q = await pool.query(
      'SELECT id, name, base_url, kind, trial_ends, notes, archived, created_at'
      + ' FROM panel.install ORDER BY archived, created_at');
    const keys = await pool.query('SELECT id, platform_key FROM panel.install');
    const keyOf = Object.fromEntries(keys.rows.map((r) => [r.id, r.platform_key]));
    const probes = await Promise.all(q.rows.map((r) =>
      r.archived ? Promise.resolve({ state: 'archived' })
        : probe({ base_url: r.base_url, platform_key: keyOf[r.id] })));
    res.set('cache-control', 'no-store').json({
      installs: q.rows.map((r, i) => Object.assign({}, r, { live: probes[i] })),
      at: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

/* https in production, always — a platform key over plain http is a key on a
   postcard. http is allowed only where production is not, for local work. */
function urlOk(u) {
  return /^https:\/\/\S+$/.test(u)
    || (process.env.NODE_ENV !== 'production' && /^http:\/\/\S+$/.test(u));
}

app.post('/api/installs', authed, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'the install needs a name' });
    if (!urlOk(String(b.baseUrl || ''))) return res.status(400).json({ error: 'the base URL must be https://…' });
    if (String(b.platformKey || '').length < 32) return res.status(400).json({ error: 'the platform key is at least 32 characters — the same value set as PLATFORM_KEY on the install' });
    const kind = ['trial', 'paid', 'internal'].includes(b.kind) ? b.kind : 'trial';
    const ins = await pool.query(
      'INSERT INTO panel.install (name, base_url, platform_key, kind, trial_ends, notes)'
      + ' VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.name).trim(), String(b.baseUrl).replace(/\/+$/, ''), String(b.platformKey),
        kind, b.trialEnds || null, String(b.notes || '')]);
    res.json({ id: ins.rows[0].id });
  } catch (e) { next(e); }
});

app.patch('/api/installs/:id', authed, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const put = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
    if (b.name !== undefined) put('name', String(b.name).trim());
    if (b.baseUrl !== undefined) {
      if (!urlOk(String(b.baseUrl))) return res.status(400).json({ error: 'the base URL must be https://…' });
      put('base_url', String(b.baseUrl).replace(/\/+$/, ''));
    }
    if (b.platformKey !== undefined) {
      if (String(b.platformKey).length < 32) return res.status(400).json({ error: 'the platform key is at least 32 characters' });
      put('platform_key', String(b.platformKey));
    }
    if (b.kind !== undefined) {
      if (!['trial', 'paid', 'internal'].includes(b.kind)) return res.status(400).json({ error: 'kind is trial, paid or internal' });
      put('kind', b.kind);
    }
    if (b.trialEnds !== undefined) put('trial_ends', b.trialEnds || null);
    if (b.notes !== undefined) put('notes', String(b.notes));
    if (b.archived !== undefined) put('archived', !!b.archived);
    if (!sets.length) return res.status(400).json({ error: 'nothing to change' });
    vals.push(req.params.id);
    const q = await pool.query('UPDATE panel.install SET ' + sets.join(', ')
      + ' WHERE id = $' + vals.length + ' RETURNING id', vals);
    if (!q.rows.length) return res.status(404).json({ error: 'no such install' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Static last: the page, its script, and the same fonts the terminal wears. */
app.use('/fonts', express.static(path.join(__dirname, '..', 'app', 'fonts'), { maxAge: '30d' }));
app.use(express.static(__dirname, { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[panel]', err.message);
  res.status(500).json({ error: 'something failed on the panel — try again' });
});

if (require.main === module) {
  migrate().then(() => {
    const port = Number(process.env.PORT) || 4095;
    app.listen(port, () => console.log('[panel] listening on ' + port));
  }).catch((e) => {
    console.error('[panel] could not migrate its registry:', e.message);
    process.exit(1);
  });
}

module.exports = { app, migrate, pool, _sign: sign, _verify: verify };
