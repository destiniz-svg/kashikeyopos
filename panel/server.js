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
const { Pool, types } = require('pg');

/* THE SAME RULE THE APP KEEPS, and it has to be kept here too or the two
   services disagree about what a date IS. Left to the driver, a Postgres
   `date` arrives as a JavaScript Date, and `String(d).slice(0, 10)` — the
   obvious way to get a YYYY-MM-DD back out of it — yields "Tue Sep 08".
   That is what made the first licence push fail: the panel sent a trial
   ending "Tue Sep 08" and the install refused it, correctly, as not a date.
   Read them as the text they are. (1082 = DATE.) See src/db.js. */
types.setTypeParser(1082, (v) => v);
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
  /* The panel and the website boot together against one registry, and two
     concurrent CREATE IF NOT EXISTS still race inside Postgres's catalogs
     (pg_type unique violation — seen in anger). One advisory lock, held by
     whoever gets there first, and the race is gone. */
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(881234)');
    await c.query(`
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
    -- The setup code the customer types into their own /onboarding to claim
    -- the install. It is NOT a key this panel uses — the panel never calls the
    -- install with it — it is a string the seller has to be able to read back
    -- when a customer says they have lost it. Which is exactly why it is here
    -- and not only in a Railway variable nobody can find at nine on a Sunday.
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS claim_code text NOT NULL DEFAULT '';
    -- What the CUSTOMER reads on their own Settings screen beside the trial
    -- countdown, in the seller's own words. Deliberately separate from the
    -- notes column, which is the seller's private file on the account: pushing
    -- "chased twice, no answer" onto the owner's screen is the kind of
    -- mistake one shared column makes inevitable.
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS customer_note text NOT NULL DEFAULT '';
    -- Who to write to when the install is provisioned, and whether that has
    -- been done. Null email = provisioned by hand for somebody already in
    -- the room, which is a real case and not a missing field.
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS contact_email text NOT NULL DEFAULT '';
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS handed_over_at timestamptz;
    -- Written by the public website (site/server.js), decided here. The same
    -- CREATE IF NOT EXISTS lives on both sides so either service may boot first.
    CREATE TABLE IF NOT EXISTS panel.signup (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      store_name text NOT NULL,
      contact_name text NOT NULL,
      email text NOT NULL,
      phone text NOT NULL DEFAULT '',
      island text NOT NULL DEFAULT '',
      note text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','contacted','provisioned','declined')),
      install_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      decided_at timestamptz
    );
  `);
  } finally {
    await c.query('SELECT pg_advisory_unlock(881234)').catch(() => {});
    c.release();
  }
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

/* ── handing an install over ────────────────────────────────────────────────
   The customer needs two things and neither of them is a password: the
   ADDRESS of their install, and the CLAIM CODE that lets them create the first
   owner on it. They set their own credentials themselves, on their own
   install's /account — which is why this message carries no password and never
   will.

   It goes through the app's own email seam (src/email.js), because a second
   transport is a second thing to keep configured and a second place for a
   send to fail silently. With no transport configured it does not pretend:
   `sent` says which of the two happened and the panel shows the message so
   the seller can send it themselves.

   THE CLAIM CODE IS IN THE MESSAGE ON PURPOSE, and it is why the message is
   worth sending rather than reading down a phone. What it grants is the right
   to claim an install nobody has claimed yet — the one window in an install's
   life where that matters — and it is spent the moment they do. */
const EMAIL = require('../src/email');

function handoverMessage(o) {
  const days = o.trialEnds
    ? Math.max(0, Math.round((Date.parse(o.trialEnds + 'T00:00:00Z') - Date.now()) / 86400000))
    : null;
  const lines = [
    'Hello ' + (o.contactName || 'there') + ',',
    '',
    (o.storeName ? o.storeName + ' is' : 'Your KashikeyoPOS install is') + ' ready.',
    '',
    'Your address:  ' + o.baseUrl,
    'Your setup code:  ' + o.claimCode,
    '',
    'Open the address, choose Create an account, and the setup code is asked for',
    'once at the start. You pick your own password — nobody here has it, and',
    'this message deliberately does not contain one.',
    '',
    'From there the panel walks you through fourteen steps: your company, your',
    'first outlet, your menu, your staff. You can stop and come back.',
    ''
  ];
  if (days !== null) {
    lines.push('Your free trial runs for ' + days + ' day' + (days === 1 ? '' : 's')
      + ', until ' + o.trialEnds + '. The till will remind you twice before then.');
    lines.push('Nothing switches off when it ends — you ask for a plan from inside');
    lines.push('the app and we set one up. There is nothing to pay online.');
    lines.push('');
  }
  lines.push('Anything at all, just reply to this message.');
  return {
    to: o.to,
    subject: (o.storeName || 'Your KashikeyoPOS install') + ' is ready',
    text: lines.join('\n')
  };
}

/* ── pushing the licence ────────────────────────────────────────────────────
   THIS REGISTRY IS AUTHORITATIVE about what a customer is on. The install
   holds a copy so its till can render the countdown without reaching out to
   anything — an install whose seller is unreachable must keep working and
   keep saying the last true thing it was told, which is exactly what a cached
   copy does and a live check does not.

   The copy is kept fresh by pushing it whenever the two disagree, on the same
   key and the same connection the health probe already uses. That makes it
   SELF-HEALING rather than scheduled: every dashboard load reconciles every
   install, a push that fails is retried by the next one, and an install
   restored from a backup is corrected the first time anybody looks at it.

   A push is idempotent by design — the install only writes its trail when
   something actually moved — so reconciling on every load costs a request and
   never a row. */
function licenceOf(row) {
  return { kind: row.kind,
    trialEnds: row.trial_ends ? String(row.trial_ends).slice(0, 10) : null,
    // `customer_note`, never `notes`: one is written FOR the customer and the
    // other is written ABOUT them.
    note: String(row.customer_note || '').slice(0, 400) };
}

function licenceDiffers(want, got) {
  if (!got) return true;                               // never pushed
  return got.kind !== want.kind
    || (got.trialEnds || null) !== (want.trialEnds || null)
    || (got.note || '') !== (want.note || '');
}

async function pushLicence(inst, want) {
  const base = String(inst.base_url || '').replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/api/platform/licence', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + inst.platform_key,
        'content-type': 'application/json' },
      body: JSON.stringify(want),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return { pushed: false, note: 'HTTP ' + r.status };
    return { pushed: true };
  } catch (e) {
    // A push that could not be made is not an error the seller has to act on:
    // the install keeps the licence it already had, and the next dashboard
    // load tries again. Reported, never thrown.
    return { pushed: false, note: e.name === 'TimeoutError' ? 'no answer in 6s'
      : (e.cause && e.cause.code) || e.message };
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
      'SELECT id, name, base_url, kind, trial_ends, notes, customer_note,'
      + ' contact_email, handed_over_at, archived, created_at'
      + ' FROM panel.install ORDER BY archived, created_at');
    const keys = await pool.query('SELECT id, platform_key FROM panel.install');
    const keyOf = Object.fromEntries(keys.rows.map((r) => [r.id, r.platform_key]));
    const probes = await Promise.all(q.rows.map((r) =>
      r.archived ? Promise.resolve({ state: 'archived' })
        : probe({ base_url: r.base_url, platform_key: keyOf[r.id] })));

    /* Reconcile what each install believes with what this registry says. Only
       a LIVE install is worth pushing to — a dead one would just time out
       twice — and only one that actually disagrees. */
    await Promise.all(q.rows.map(async (r, i) => {
      const p = probes[i];
      if (p.state !== 'live') return;
      const want = licenceOf(r);
      if (!licenceDiffers(want, (p.summary || {}).licence)) return;
      const out = await pushLicence({ base_url: r.base_url, platform_key: keyOf[r.id] }, want);
      p.licencePush = out;
      if (out.pushed) p.summary = Object.assign({}, p.summary, { licence: want });
    }));

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

/* ── store requests from the website ────────────────────────────────────────
   The website records them; the seller decides here. "Provisioned" links the
   request to the install it became, so a request's story stays answerable. */
app.get('/api/signups', authed, async (req, res, next) => {
  try {
    const q = await pool.query(
      'SELECT id, store_name, contact_name, email, phone, island, note, status,'
      + ' install_id, created_at, decided_at FROM panel.signup'
      + " ORDER BY (status IN ('new','contacted')) DESC, created_at DESC LIMIT 200");
    res.set('cache-control', 'no-store').json({ signups: q.rows });
  } catch (e) { next(e); }
});

app.patch('/api/signups/:id', authed, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!['new', 'contacted', 'provisioned', 'declined'].includes(b.status)) {
      return res.status(400).json({ error: 'status is new, contacted, provisioned or declined' });
    }
    const q = await pool.query(
      'UPDATE panel.signup SET status = $1, install_id = $2,'
      + " decided_at = CASE WHEN $1 IN ('provisioned','declined') THEN now() ELSE decided_at END"
      + ' WHERE id = $3 RETURNING id',
      [b.status, b.installId || null, req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'no such request' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/installs', authed, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'the install needs a name' });
    if (!urlOk(String(b.baseUrl || ''))) return res.status(400).json({ error: 'the base URL must be https://…' });
    if (String(b.platformKey || '').length < 32) return res.status(400).json({ error: 'the platform key is at least 32 characters — the same value set as PLATFORM_KEY on the install' });
    const kind = ['trial', 'paid', 'internal'].includes(b.kind) ? b.kind : 'trial';
    const baseUrl = String(b.baseUrl).replace(/\/+$/, '');
    const ins = await pool.query(
      'INSERT INTO panel.install (name, base_url, platform_key, kind, trial_ends,'
      + ' notes, claim_code, customer_note, contact_email)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [String(b.name).trim(), baseUrl, String(b.platformKey),
        kind, kind === 'trial' ? (b.trialEnds || null) : null,
        String(b.notes || ''), String(b.claimCode || ''),
        String(b.customerNote || '').slice(0, 400),
        String(b.contactEmail || '').trim().toLowerCase()]);
    const id = ins.rows[0].id;

    /* Link the request this install came from, and close it in the same
       breath. A signup marked provisioned that points at nothing is a story
       nobody can finish six weeks later. */
    if (b.signupId) {
      await pool.query(
        "UPDATE panel.signup SET status = 'provisioned', install_id = $1,"
        + ' decided_at = now() WHERE id = $2', [id, b.signupId]).catch(() => {});
    }

    /* Hand it over, if there is somebody to hand it to. The response carries
       both the outcome and the message itself, so a seller with no transport
       configured can copy it rather than being told nothing happened. */
    let handover = null;
    if (b.contactEmail) {
      const msg = handoverMessage({
        to: String(b.contactEmail).trim(),
        contactName: String(b.contactName || '').trim(),
        storeName: String(b.name).trim(),
        baseUrl: baseUrl,
        claimCode: String(b.claimCode || ''),
        trialEnds: kind === 'trial' ? (b.trialEnds || null) : null
      });
      try {
        const out = await EMAIL.send(msg);
        handover = { sent: !!out.sent, via: out.via, reason: out.reason || null, message: msg.text };
      } catch (e) {
        handover = { sent: false, via: 'none', reason: e.message, message: msg.text };
      }
      if (handover.sent) {
        await pool.query('UPDATE panel.install SET handed_over_at = now() WHERE id = $1',
          [id]).catch(() => {});
      }
    }
    res.json({ id: id, handover: handover });
  } catch (e) { next(e); }
});

/* The setup code, read back on purpose and on its own request. It is NOT in
   the dashboard payload: everything else there is a figure, and a credential
   that grants ownership of an unclaimed install should have to be ASKED for,
   once, by a person who came looking — not ride along in a poll that refreshes
   every thirty seconds into a browser left open on a desk. */
app.get('/api/installs/:id/claim', authed, async (req, res, next) => {
  try {
    const q = await pool.query('SELECT name, claim_code FROM panel.install WHERE id = $1',
      [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'no such install' });
    res.set('cache-control', 'no-store').json({
      name: q.rows[0].name,
      claimCode: q.rows[0].claim_code || '',
      // An empty code is not the same as a code nobody has looked at yet: it
      // means this install was recorded without one, so its onboarding is open
      // unless ONBOARDING_CLAIM_TOKEN was set on it by hand.
      set: !!q.rows[0].claim_code
    });
  } catch (e) { next(e); }
});

/* SENDING IT AGAIN. The commonest support call on a handover is "I never got
   it" or "I have lost the code", and both are answered by this. It re-sends
   the same message rather than minting anything: the claim code is still the
   one that was recorded, so a customer who half-typed it from a phone call
   gets the same string and not a second one that invalidates the first. */
app.post('/api/installs/:id/handover', authed, async (req, res, next) => {
  try {
    const b = req.body || {};
    const q = await pool.query(
      'SELECT name, base_url, claim_code, contact_email, kind, trial_ends'
      + ' FROM panel.install WHERE id = $1', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'no such install' });
    const r0 = q.rows[0];
    const to = String(b.email || r0.contact_email || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) {
      return res.status(400).json({ error: 'no email address on this install — add one, or pass it here' });
    }
    if (!r0.claim_code) {
      return res.status(400).json({ error: 'this install has no setup code recorded, so the message would be missing the one thing it exists to carry' });
    }
    const msg = handoverMessage({
      to: to, contactName: String(b.contactName || '').trim(), storeName: r0.name,
      baseUrl: r0.base_url, claimCode: r0.claim_code,
      trialEnds: r0.kind === 'trial' && r0.trial_ends
        ? String(r0.trial_ends).slice(0, 10) : null
    });
    let out;
    try { out = await EMAIL.send(msg); }
    catch (e) { out = { sent: false, via: 'none', reason: e.message }; }
    if (out.sent) {
      await pool.query('UPDATE panel.install SET handed_over_at = now(),'
        + ' contact_email = $2 WHERE id = $1', [req.params.id, to.toLowerCase()]).catch(() => {});
    }
    res.set('cache-control', 'no-store').json({
      sent: !!out.sent, via: out.via, reason: out.reason || null, message: msg.text, to: to });
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
    if (b.claimCode !== undefined) put('claim_code', String(b.claimCode));
    if (b.customerNote !== undefined) put('customer_note', String(b.customerNote).slice(0, 400));
    if (b.contactEmail !== undefined) put('contact_email', String(b.contactEmail).trim().toLowerCase());
    /* EXTENDING A TRIAL is the seller's one routine act, and doing it by
       typing a date is how a trial gets extended to a day in the past. `days`
       moves the deadline forward from whichever is later — today, or where it
       already stood — so extending an expired trial gives the customer the
       days rather than back-dating them into nothing. */
    if (b.extendDays !== undefined) {
      const n = Math.round(Number(b.extendDays));
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        return res.status(400).json({ error: 'extend by 1 to 365 days' });
      }
      const cur = await pool.query(
        'SELECT kind, trial_ends FROM panel.install WHERE id = $1', [req.params.id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'no such install' });
      if (cur.rows[0].kind !== 'trial') {
        return res.status(400).json({ error: 'only a trial has an end date to extend' });
      }
      const from = new Date();
      const had = cur.rows[0].trial_ends ? new Date(cur.rows[0].trial_ends) : null;
      const base = had && had > from ? had : from;
      base.setDate(base.getDate() + n);
      put('trial_ends', base.toISOString().slice(0, 10));
    }
    if (b.kind !== undefined) {
      if (!['trial', 'paid', 'internal'].includes(b.kind)) return res.status(400).json({ error: 'kind is trial, paid or internal' });
      put('kind', b.kind);
    }
    if (b.trialEnds !== undefined && b.extendDays === undefined) {
      put('trial_ends', b.trialEnds || null);
    }
    /* A paid or internal install with a countdown on it is a contradiction the
       customer's own screen would have to render, and the install refuses it
       outright — so it is cleared here rather than pushed and rejected. */
    if (b.kind !== undefined && b.kind !== 'trial') put('trial_ends', null);
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
