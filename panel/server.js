'use strict';
/* ═══ MISSION CONTROL — THE SELLER'S PANEL ══════════════════════════════════
   The seller's view across every customer: who is live, who is on trial,
   whose tills have gone quiet, what today took. A SEPARATE app in the same
   repository, run as its own service (`node panel/server.js`).

   IT READS THE REGISTRY NOW, and that is a change of premise rather than of
   plumbing. This panel was built for a product sold ONE INSTALL PER CUSTOMER:
   each customer had their own app service and their own database, the seller
   could reach neither, and so everything the panel knew arrived over HTTPS
   from each install's own `/api/platform/summary` with a per-install
   PLATFORM_KEY.

   That premise is gone. One app serves every customer, one Postgres cluster
   holds a database per business, and this panel runs beside them:
   `chain.business` IS the customer list. Probing over HTTP for figures that
   are one query away was not merely redundant, it was a control describing a
   world that no longer exists — the defect class this codebase has spent
   months removing. `panel/registry.js` is the reader.

   THE LICENCE IS ONE COPY, not two. The old design had the seller's registry
   authoritative and the install holding a copy, reconciled by a push on every
   dashboard load — necessary only because they were different databases the
   seller could not both reach. They are both reachable now, so `chain.licence`
   in the business's own database is the record, written directly, and there is
   nothing left to reconcile or to drift.

   WHAT THE PANEL TOUCHES IS UNCHANGED: company name, outlets, device
   staleness, fourteen days of takings, the licence. Never a member, never a
   staff row, never a line item — and every read lands on that business's own
   trail, exactly as the platform door's did. A seller looking in is never
   invisible.

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
    -- WHAT THIS PANEL CREATED, so an orphan is impossible to create silently.
    -- Written BEFORE the infrastructure it names, and updated as each piece
    -- lands: a crash halfway through leaves a row saying exactly how far it
    -- got, which is the difference between a cleanup and an archaeology dig.
    -- Null everywhere = provisioned by hand, which stays a supported path.
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS provisioned boolean NOT NULL DEFAULT false;
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS provision_state text NOT NULL DEFAULT '';
    ALTER TABLE panel.install ADD COLUMN IF NOT EXISTS railway jsonb;
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
    -- ── the admin account, hardened ────────────────────────────────────────
    -- One password standing between the internet and every licence and
    -- provision button is the panel's weakest wall. totp_secret is the second
    -- factor once CONFIRMED; totp_pending holds a freshly minted secret until
    -- the admin proves their authenticator has it, because enabling 2FA on a
    -- secret nobody scanned locks the only admin out of their own panel.
    ALTER TABLE panel.admin ADD COLUMN IF NOT EXISTS totp_secret text;
    ALTER TABLE panel.admin ADD COLUMN IF NOT EXISTS totp_pending text;
    -- Every issued token carries the epoch it was signed under; bumping it is
    -- "sign out everywhere" — stateless tokens, one integer of server state.
    ALTER TABLE panel.admin ADD COLUMN IF NOT EXISTS token_epoch int NOT NULL DEFAULT 0;
    -- ── health history ─────────────────────────────────────────────────────
    -- The /readyz probe used to be point-in-time: right during an incident,
    -- useless the morning after. Every sweep is a row; 14 days are kept; a
    -- TRANSITION (ok→down, down→ok) is an event — the timeline an operator
    -- actually reads.
    CREATE TABLE IF NOT EXISTS panel.pulse (
      at timestamptz NOT NULL DEFAULT now(),
      ok boolean NOT NULL,
      ms int,
      status int,
      detail text
    );
    CREATE INDEX IF NOT EXISTS pulse_at ON panel.pulse(at DESC);
    CREATE TABLE IF NOT EXISTS panel.event (
      at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL,
      detail text NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS event_at ON panel.event(at DESC);
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
/* ── TOTP, RFC 6238 over node's own crypto ──────────────────────────────────
   SHA-1, 30-second step, six digits — what every authenticator app speaks.
   Thirty lines beat a dependency: the two-runtime-dependency rule holds, and
   there is nothing here to go stale. The secret is stored as hex; the
   otpauth: URL carries it base32, because that is the only encoding the apps
   accept. */
function totpAt(secretHex, tMs) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(tMs / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(secretHex, 'hex')).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
/* One step of drift either side: a phone's clock is not this server's clock,
   and refusing a code that was right twenty seconds ago teaches an operator
   to type faster rather than trust the panel. */
function totpOk(secretHex, code) {
  const given = Buffer.from(String(code || '').trim().padStart(6, '0'));
  if (given.length !== 6) return false;
  for (const d of [-30000, 0, 30000]) {
    const want = Buffer.from(totpAt(secretHex, Date.now() + d));
    if (crypto.timingSafeEqual(given, want)) return true;
  }
  return false;
}
function b32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let val = 0; let out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

/* THE TOKEN CARRIES ITS EPOCH. Tokens are signed blobs with no session table,
   so "sign out everywhere" needs exactly one integer of server state: every
   token is signed under the admin's current token_epoch, and bumping it
   orphans every token signed before — including a stolen one. */
function sign(adminId, epoch) {
  const body = Buffer.from(JSON.stringify({ a: adminId, e: Number(epoch) || 0,
    exp: Date.now() + 12 * 3600e3 })).toString('base64url');
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
/* The epoch check costs one indexed read per request, which is what makes the
   sign-out real rather than recorded. express 4 does not catch a rejected
   async middleware, so the promise is caught by hand. */
function authed(req, res, next) {
  const p = verify(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!p) return res.status(401).json({ error: 'sign in again' });
  pool.query('SELECT token_epoch FROM panel.admin WHERE id = $1', [p.a])
    .then((q) => {
      if (!q.rows.length || Number(q.rows[0].token_epoch) !== (Number(p.e) || 0)) {
        return res.status(401).json({ error: 'sign in again' });
      }
      req.adminId = p.a;
      next();
    })
    .catch(next);
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
const RAILWAY = require('./railway');
const REGISTRY = require('./registry');

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

/* Whether the panel is virgin decides which screen the page opens on, and
   whether provisioning is automated decides which sheet Provision opens. Both
   are facts about this deployment, so both are answered before sign-in — the
   page needs them to render its first screen, and neither is a secret. */
app.get('/api/state', async (req, res, next) => {
  try {
    const q = await pool.query('SELECT count(*)::int AS n FROM panel.admin');
    const auto = RAILWAY.ready();
    res.json({ setup: q.rows[0].n === 0, auto: auto.ok,
      autoWhy: auto.why || null, autoWarn: auto.warn || null });
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
    res.json({ token: sign(ins.rows[0].id, 0) });
  } catch (e) { next(e); }
});

app.post('/api/signin',
  gate('panel-signin', { ip: [30, 3600e3], id: [8, 3600e3] }, (req) => (req.body || {}).email),
  async (req, res, next) => {
    try {
      const { email, password, code } = req.body || {};
      const q = await pool.query(
        'SELECT id, pass, totp_secret, token_epoch FROM panel.admin WHERE email = $1',
        [String(email || '').toLowerCase()]);
      // One sentence either way: whether an address is an admin here is not a
      // question a stranger gets to ask.
      if (!q.rows.length || !checkPass(password, q.rows[0].pass)) {
        return res.status(401).json({ error: 'that email and password do not match' });
      }
      /* The second factor, where one is enrolled. `need: 'totp'` after a
         correct password is the standard shape — the password has already
         been proven, so it reveals nothing a stranger could not learn by
         succeeding — and the guesses ride the same doorman as the password. */
      if (q.rows[0].totp_secret) {
        if (!code) {
          return res.status(401).json({ need: 'totp',
            error: 'this account has two-factor on — add the six-digit code'
              + ' from your authenticator app' });
        }
        if (!totpOk(q.rows[0].totp_secret, code)) {
          return res.status(401).json({ need: 'totp',
            error: 'that code is not right — codes rotate every 30 seconds' });
        }
      }
      res.json({ token: sign(q.rows[0].id, q.rows[0].token_epoch) });
    } catch (e) { next(e); }
  });

/* ── THE ADMIN'S OWN ACCOUNT — the panel's weakest wall, hardened ──────────
   One password between the internet and every licence and provision button
   was the gap a comparison against any serious operator panel names first.
   Three answers: a second factor, a second admin, and a sign-out that means
   it. All of it server-side state this file already owns. */
app.get('/api/account', authed, async (req, res, next) => {
  try {
    const me = await pool.query(
      'SELECT email, totp_secret IS NOT NULL AS totp FROM panel.admin WHERE id = $1',
      [req.adminId]);
    const all = await pool.query(
      'SELECT id, email, totp_secret IS NOT NULL AS totp, created_at'
      + ' FROM panel.admin ORDER BY created_at');
    res.json({
      email: me.rows[0].email,
      totpEnabled: me.rows[0].totp === true,
      admins: all.rows.map((r) => ({ id: r.id, email: r.email,
        totp: r.totp === true, createdAt: r.created_at, me: r.id === req.adminId }))
    });
  } catch (e) { next(e); }
});

/* Enrolling is two steps ON PURPOSE: the secret sits in totp_pending until a
   code from the authenticator proves it was actually scanned. Enabling on an
   unscanned secret locks the only admin out of their own panel — the worst
   possible outcome of a security control. */
app.post('/api/account/totp/start', authed, async (req, res, next) => {
  try {
    const cur = await pool.query(
      'SELECT email, totp_secret FROM panel.admin WHERE id = $1', [req.adminId]);
    if (cur.rows[0].totp_secret) {
      return res.status(409).json({ error: 'two-factor is already on — turn it'
        + ' off first to re-enrol' });
    }
    const secret = crypto.randomBytes(20).toString('hex');
    await pool.query('UPDATE panel.admin SET totp_pending = $1 WHERE id = $2',
      [secret, req.adminId]);
    const label = encodeURIComponent('Mission Control:' + cur.rows[0].email);
    res.json({
      base32: b32(Buffer.from(secret, 'hex')),
      otpauth: 'otpauth://totp/' + label + '?secret=' + b32(Buffer.from(secret, 'hex'))
        + '&issuer=' + encodeURIComponent('KashikeyoPOS')
    });
  } catch (e) { next(e); }
});

app.post('/api/account/totp/confirm', authed,
  gate('panel-totp', { ip: [30, 3600e3] }),
  async (req, res, next) => {
    try {
      const cur = await pool.query(
        'SELECT totp_pending FROM panel.admin WHERE id = $1', [req.adminId]);
      if (!cur.rows[0].totp_pending) {
        return res.status(409).json({ error: 'nothing is pending — start enrolment first' });
      }
      if (!totpOk(cur.rows[0].totp_pending, (req.body || {}).code)) {
        return res.status(401).json({ error: 'that code does not match the secret'
          + ' you just scanned — codes rotate every 30 seconds' });
      }
      await pool.query('UPDATE panel.admin SET totp_secret = totp_pending,'
        + ' totp_pending = NULL WHERE id = $1', [req.adminId]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* Turning it off asks for a current code: possession of a signed-in browser
   tab must not be enough to strip the account's second factor. */
app.post('/api/account/totp/disable', authed,
  gate('panel-totp', { ip: [30, 3600e3] }),
  async (req, res, next) => {
    try {
      const cur = await pool.query(
        'SELECT totp_secret FROM panel.admin WHERE id = $1', [req.adminId]);
      if (!cur.rows[0].totp_secret) return res.status(409).json({ error: 'two-factor is not on' });
      if (!totpOk(cur.rows[0].totp_secret, (req.body || {}).code)) {
        return res.status(401).json({ error: 'the current six-digit code is needed to turn it off' });
      }
      await pool.query('UPDATE panel.admin SET totp_secret = NULL WHERE id = $1',
        [req.adminId]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* Bumping the epoch orphans every token signed before it — a stolen one
   included. The answer carries a FRESH token so the session doing the
   signing-out is the one that survives. */
app.post('/api/account/signout-everywhere', authed, async (req, res, next) => {
  try {
    const q = await pool.query('UPDATE panel.admin SET token_epoch = token_epoch + 1'
      + ' WHERE id = $1 RETURNING token_epoch', [req.adminId]);
    res.json({ ok: true, token: sign(req.adminId, q.rows[0].token_epoch) });
  } catch (e) { next(e); }
});

/* A SECOND ADMIN, because one account is a bus factor as well as a target.
   Only a signed-in admin may add one; the new admin changes their own
   password and enrols their own 2FA once in. */
app.post('/api/admins', authed, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) {
      return res.status(400).json({ error: 'a real email address is required' });
    }
    if (String(password || '').length < 12) {
      return res.status(400).json({ error: 'the password needs at least 12 characters' });
    }
    const ins = await pool.query(
      'INSERT INTO panel.admin (email, pass) VALUES ($1, $2)'
      + ' ON CONFLICT (email) DO NOTHING RETURNING id',
      [String(email).toLowerCase(), hashPass(password)]);
    if (!ins.rows.length) return res.status(409).json({ error: 'that address is already an admin' });
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

/* Removing one refuses the two removals that end in a locked panel: yourself
   (sign out is over there), and the last admin standing. */
app.delete('/api/admins/:id', authed, async (req, res, next) => {
  try {
    if (String(req.params.id) === String(req.adminId)) {
      return res.status(400).json({ error: 'you cannot remove yourself — another admin does that' });
    }
    const n = await pool.query('SELECT count(*)::int AS n FROM panel.admin');
    if (n.rows[0].n <= 1) return res.status(400).json({ error: 'the last admin cannot be removed' });
    const del = await pool.query('DELETE FROM panel.admin WHERE id = $1 RETURNING id',
      [req.params.id]);
    if (!del.rows.length) return res.status(404).json({ error: 'no such admin' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* The whole dashboard in one answer: the registry rows (keys withheld) with
   each install's live probe beside them. */
/* ── the overview ──────────────────────────────────────────────────────────
   In registry mode every row is a BUSINESS, read straight from the cluster
   this panel sits beside. Shaped here into what the card already renders
   rather than in the browser: the page is a textContent-only builder on
   purpose, and a second shape for it to branch on is a second thing to get
   wrong.

   `base_url` is the app's own address for every customer — one till hostname,
   many businesses — so the Open button goes to the terminal rather than to a
   per-install domain that no longer exists. */
function asCard(b) {
  const lic = b.licence || {};
  const summary = b.state === 'live' ? {
    company: b.company, outlets: b.outlets || [], devices: b.devices || {},
    /* `days` is SYNC-OP TRAFFIC per day — system data. This panel carries no
       sales figure anywhere: a customer's takings are their own back
       office's to report. */
    days: b.days || [], licence: b.licence || null, planRequest: b.planRequest || null,
    install: b.db,
    dbBytes: b.dbBytes == null ? null : b.dbBytes,
    sessions: b.sessions == null ? null : b.sessions,
    backup: b.backup || null,
    schema: { version: b.schemaVersion, head: b.schemaHead || null,
      behind: b.behind === true }
  } : null;
  return {
    id: b.id,
    name: (b.company && b.company.name) || b.name,
    base_url: String(process.env.APP_URL || '').replace(/\/+$/, ''),
    kind: lic.kind || 'trial',
    trial_ends: lic.trialEnds || null,
    notes: null,
    customer_note: lic.note || '',
    contact_email: null,
    archived: b.status === 'suspended',
    created_at: b.createdAt,
    db: b.db,
    schema_version: b.schemaVersion,
    live: { state: b.state, note: b.note || null, summary: summary }
  };
}

/* ── HEALTH HISTORY — a probe is point-in-time, an incident is not ──────────
   The /readyz probe on each dashboard load answers "is it up NOW", which is
   the right question during an incident and the wrong one the morning after.
   Every minute the panel writes one pulse row (14 days kept), and a
   TRANSITION — up→down, down→up — is an event. Uptime is computed from the
   rows, so the figure is measured, never asserted. State starts unknown on a
   restart, which is the correct failure: a fresh process re-observes before
   it says anything changed. */
let lastPulseOk = null;
async function sweepPulse() {
  const url = process.env.APP_URL;
  if (!url || !REGISTRY.registryMode()) return null;
  const h = await REGISTRY.appHealth(url);
  try {
    await pool.query('INSERT INTO panel.pulse (ok, ms, status, detail)'
      + ' VALUES ($1, $2, $3, $4)',
      [h.ok === true, h.ms || null, h.status || null,
        (h.detail || h.reason || '').slice(0, 400) || null]);
    await pool.query("DELETE FROM panel.pulse WHERE at < now() - interval '14 days'");
    if (lastPulseOk !== null && lastPulseOk !== h.ok) {
      await pool.query('INSERT INTO panel.event (kind, detail) VALUES ($1, $2)',
        [h.ok ? 'app_recovered' : 'app_down',
          h.ok ? 'up again after ' + (h.ms || '?') + ' ms probe'
            : (h.detail || h.reason || 'no answer').slice(0, 400)]);
      console.error('[panel] ' + (h.ok ? 'app RECOVERED' : 'app DOWN: '
        + (h.reason || h.status || '')));
    }
    lastPulseOk = h.ok;
  } catch (e) { console.error('[panel] pulse not written: ' + e.message); }
  return h;
}

async function uptime() {
  try {
    const q = await pool.query(
      "SELECT count(*) FILTER (WHERE at > now() - interval '24 hours')::int AS n24,"
      + " count(*) FILTER (WHERE ok AND at > now() - interval '24 hours')::int AS ok24,"
      + ' count(*)::int AS n7, count(*) FILTER (WHERE ok)::int AS ok7'
      + " FROM panel.pulse WHERE at > now() - interval '7 days'");
    const r = q.rows[0];
    const pct = (ok, n) => (n ? Math.round((ok / n) * 10000) / 100 : null);
    return { h24: pct(r.ok24, r.n24), d7: pct(r.ok7, r.n7), samples: r.n7 };
  } catch (e) { return null; }
}

app.get('/api/overview', authed, async (req, res, next) => {
  if (REGISTRY.registryMode()) {
    try {
      /* The app's own /readyz rides at the top of every load: it is the one
         health fact the registry cannot answer (it checks out every outlet's
         login role against its own schema), and its latency is the traffic
         figure an operator feels first. Probed beside the registry read, not
         instead of it — an app that is down must not blank the dashboard. */
      const [rows, appH, up, ev] = await Promise.all([
        REGISTRY.overview(),
        REGISTRY.appHealth(process.env.APP_URL),
        uptime(),
        pool.query('SELECT at, kind, detail FROM panel.event ORDER BY at DESC LIMIT 12')
      ]);
      return res.set('cache-control', 'no-store').json({
        mode: 'registry',
        dedicated: dedicatedOn(),
        installs: rows.map(asCard),
        appHealth: appH,
        uptime: up,
        events: ev.rows,
        at: new Date().toISOString()
      });
    } catch (e) { return next(e); }
  }
  try {
    const q = await pool.query(
      'SELECT id, name, base_url, kind, trial_ends, notes, customer_note,'
      + ' contact_email, handed_over_at, archived, created_at,'
      + ' provisioned, provision_state, railway'
      + ' FROM panel.install ORDER BY archived, created_at');
    const keys = await pool.query('SELECT id, platform_key FROM panel.install');
    const keyOf = Object.fromEntries(keys.rows.map((r) => [r.id, r.platform_key]));
    const probes = await Promise.all(q.rows.map((r) =>
      r.archived ? Promise.resolve({ state: 'archived' })
        : (r.provision_state && !r.provisioned)
          ? Promise.resolve({ state: 'building', step: r.provision_state })
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
      mode: 'installs',
      dedicated: true,
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

/* ── THE SYSTEM REPORT, OUTLET BY OUTLET ────────────────────────────────────
   This panel is the developer's, so the drill-in is SYSTEM data — sync-op
   traffic, QR traffic, device sync health, database size, live sessions —
   and never a sale figure: a customer's takings are reported by their own
   back office to the people entitled to read them. Registry mode only — on a
   dedicated deployment the seller has no way into the customer's database.

   `?format=csv` hands back the daily traffic series as a file — one row per
   outlet per day — because the next thing an operator does with a traffic
   report is graph it. */
app.get('/api/installs/:id/usage', authed, async (req, res, next) => {
  if (!REGISTRY.registryMode()) {
    return res.status(409).json({ error: 'system reports read the registry'
      + ' directly — on a dedicated deployment use the install\'s own /metrics' });
  }
  try {
    const u = await REGISTRY.usage(req.params.id);
    if (!u) return res.status(404).json({ error: 'no such business' });
    if (String(req.query.format || '') === 'csv') {
      const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
      const lines = ['business,outlet,date,ops,qrOrders'];
      for (const ot of (u.outlets || [])) {
        for (const d of (ot.days || [])) {
          lines.push([esc(u.company || u.name), esc(ot.name), d.date,
            d.ops, d.qr].join(','));
        }
      }
      res.set('content-type', 'text/csv; charset=utf-8');
      res.set('content-disposition', 'attachment; filename="system-'
        + String(u.name || u.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)
        + '-' + new Date().toISOString().slice(0, 10) + '.csv"');
      return res.send(lines.join('\n') + '\n');
    }
    res.set('cache-control', 'no-store').json(u);
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

/* ── THE DEDICATED-INSTALL PATH, AND WHY IT IS OFF BY DEFAULT ──────────────
   Building a whole Railway project per customer — app service, Postgres,
   volume, domain, five secrets — is what the database-per-business
   restructure exists to replace. A customer signs up on the website now and
   their database is created for them; nobody presses a button.

   The code stays, because an install on somebody else's infrastructure is a
   thing a seller may genuinely still want to sell, and the manual sheet
   underneath it is how such an install gets registered at all. But it is not
   OFFERED, because a button that builds an install the registry has never
   heard of — one that cannot sign a customer up, because signing up is what
   creates a business — is a control that does the wrong thing confidently.

   PANEL_DEDICATED_INSTALLS=1 turns it back on, deliberately, for a seller who
   means it. Off, every one of these doors refuses by name rather than 404ing:
   whoever pressed it deserves to know it was a decision, not a fault. */
function dedicatedOn() {
  return String(process.env.PANEL_DEDICATED_INSTALLS || '') === '1';
}
function dedicatedOnly(req, res, next) {
  if (dedicatedOn()) return next();
  return res.status(409).json({
    error: 'this panel is beside a registry, so customers create their own'
      + ' business by signing up — there is no install to provision or'
      + ' register by hand. Set PANEL_DEDICATED_INSTALLS=1 if you still sell'
      + ' installs on separate infrastructure.',
    dedicated: false
  });
}

app.post('/api/installs', authed, dedicatedOnly, async (req, res, next) => {
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
/* ═══ ONE BUTTON ═══════════════════════════════════════════════════════════
   Creates the project, the database, its disk, the app service, the domain and
   the health check; mints every secret; waits for the first deploy; then
   records the install and hands it over. What used to be six manual acts and
   two hand-copied secrets.

   THE ROW IS WRITTEN FIRST, before any infrastructure exists, and updated at
   every step. That ordering is the whole safety argument: a panel that crashes
   mid-run leaves a row saying how far it got and what it made, rather than
   infrastructure nobody knows about. An orphan costs money quietly for months;
   a half-finished row is visible on the dashboard within thirty seconds.

   It runs in the BACKGROUND. A first deploy can take minutes, and an HTTP
   request held open that long dies to a proxy somewhere and tells the operator
   nothing. The response is the install id; the dashboard already polls, and
   the row is the progress. */
app.post('/api/installs/provision', authed, dedicatedOnly, async (req, res, next) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'the install needs a name' });
  const gate2 = RAILWAY.ready();
  if (!gate2.ok) return res.status(503).json({ error: gate2.why });

  const kind = ['trial', 'paid', 'internal'].includes(b.kind) ? b.kind : 'trial';
  try {
    /* base_url and platform_key are NOT NULL and are not known yet — the
       domain does not exist until step five. They are filled in on success;
       until then the row is marked as building and the dashboard renders it
       that way rather than probing an address that answers nothing. */
    const ins = await pool.query(
      'INSERT INTO panel.install (name, base_url, platform_key, kind, trial_ends,'
      + ' notes, customer_note, contact_email, provision_state)'
      + " VALUES ($1,'','',$2,$3,$4,$5,$6,'starting') RETURNING id",
      [name, kind, kind === 'trial' ? (b.trialEnds || null) : null,
        String(b.notes || ''), String(b.customerNote || '').slice(0, 400),
        String(b.contactEmail || '').trim().toLowerCase()]);
    const id = ins.rows[0].id;

    if (b.signupId) {
      await pool.query(
        "UPDATE panel.signup SET status = 'provisioned', install_id = $1,"
        + ' decided_at = now() WHERE id = $2', [id, b.signupId]).catch(() => {});
    }

    res.status(202).json({ id: id, state: 'starting' });

    /* ── from here nobody is waiting on us ──────────────────────────────── */
    const note = (state, made) => pool.query(
      'UPDATE panel.install SET provision_state = $2, railway = $3 WHERE id = $1',
      [id, state, made ? JSON.stringify(made) : null]).catch(() => {});

    RAILWAY.provision({
      name: name,
      serviceName: b.serviceName || undefined,
      rollback: b.rollback === true,
      onStep: (ev) => {
        note(ev.state === 'failed' ? 'failed: ' + ev.key : ev.key, ev.made);
      }
    }).then(async (out) => {
      await pool.query(
        'UPDATE panel.install SET base_url = $2, platform_key = $3, claim_code = $4,'
        + " provisioned = true, provision_state = 'live', railway = $5 WHERE id = $1",
        [id, out.baseUrl, out.secrets.PLATFORM_KEY, out.secrets.ONBOARDING_CLAIM_TOKEN,
          JSON.stringify(out.made)]);

      /* Telling the customer is part of provisioning, not a second step
         somebody has to remember. It carries the address and the setup code
         and deliberately no password. */
      if (b.contactEmail) {
        const msg = handoverMessage({
          to: String(b.contactEmail).trim(),
          contactName: String(b.contactName || '').trim(),
          storeName: name,
          baseUrl: out.baseUrl,
          claimCode: out.secrets.ONBOARDING_CLAIM_TOKEN,
          trialEnds: kind === 'trial' ? (b.trialEnds || null) : null
        });
        try {
          const sent = await EMAIL.send(msg);
          if (sent && sent.sent) {
            await pool.query('UPDATE panel.install SET handed_over_at = now() WHERE id = $1', [id]);
          }
        } catch (e) { /* the install is live either way; Send again is on the sheet */ }
      }
    }).catch(async (e) => {
      /* Never rounded up to "failed". The message names the step and what
         exists, because the next question is always "what do I have to clean
         up", and the answer must not be "look through the dashboard". */
      const made = e.made || null;
      const why = 'failed at ' + (e.failedAt || 'an unknown step') + ': ' + e.message
        + (e.rolledBack ? ' \u00b7 rolled back'
          : e.rollbackError ? ' \u00b7 rollback also failed: ' + e.rollbackError : '');
      await note(why.slice(0, 500), made);
    });
  } catch (e) { next(e); }
});

/* What the automated path would use, so the sheet can say so before anybody
   presses anything. Never the token itself. */
app.get('/api/provision/config', authed, (req, res) => {
  if (!dedicatedOn()) {
    return res.json({ ok: false, dedicated: false,
      why: 'customers create their own business by signing up — this panel is'
        + ' beside the registry that records them. Set'
        + ' PANEL_DEDICATED_INSTALLS=1 to sell installs on separate'
        + ' infrastructure again.' });
  }
  const gate3 = RAILWAY.ready();
  res.json({
    ok: gate3.ok, dedicated: true,
    why: gate3.why || null,
    warn: gate3.warn || null,
    repo: process.env.INSTALL_REPO || null,
    branch: process.env.INSTALL_BRANCH || 'main',
    region: process.env.INSTALL_REGION || null,
    workspace: process.env.RAILWAY_WORKSPACE_ID ? 'set' : 'account default'
  });
});

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

/* ── the seller's one routine act ──────────────────────────────────────────
   In registry mode this writes chain.licence in that business's own database,
   which is the only copy. There is nothing to push and nothing to reconcile:
   the old two-copy design existed because the seller could not reach the
   install's database, and it can. */
async function editLicence(businessId, body, res) {
  const rows = await REGISTRY.overview();
  const biz = rows.find((r) => Number(r.id) === Number(businessId));
  if (!biz) return res.status(404).json({ error: 'no such business' });
  if (biz.state !== 'live') {
    return res.status(409).json({ error: 'that business is ' + biz.state
      + ' — its database is not open to write a licence into' });
  }
  const cur = biz.licence || { kind: 'trial', trialEnds: null, note: '' };
  const want = { kind: cur.kind, trialEnds: cur.trialEnds, note: cur.note };

  if (body.kind !== undefined) {
    if (!['trial', 'paid', 'internal'].includes(body.kind)) {
      return res.status(400).json({ error: 'kind is trial, paid or internal' });
    }
    want.kind = body.kind;
    /* A paid or internal install with a countdown on it is a contradiction
       the customer's own screen would have to render, and the database
       refuses it outright — so it is cleared here rather than written and
       rejected. */
    if (body.kind !== 'trial') want.trialEnds = null;
  }
  if (body.customerNote !== undefined) want.note = String(body.customerNote).slice(0, 400);
  if (body.trialEnds !== undefined && body.extendDays === undefined) {
    want.trialEnds = body.trialEnds || null;
  }
  /* EXTENDING A TRIAL by typing a date is how a trial gets extended to a day
     in the past. `days` moves the deadline forward from whichever is later —
     today, or where it already stood — so extending an expired trial gives
     the customer the days rather than back-dating them into nothing. */
  if (body.extendDays !== undefined) {
    const n = Math.round(Number(body.extendDays));
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      return res.status(400).json({ error: 'extend by 1 to 365 days' });
    }
    if (want.kind !== 'trial') {
      return res.status(400).json({ error: 'only a trial has an end date to extend' });
    }
    const from = new Date();
    const had = want.trialEnds ? new Date(want.trialEnds + 'T00:00:00Z') : null;
    const base = had && had > from ? had : from;
    base.setDate(base.getDate() + n);
    want.trialEnds = base.toISOString().slice(0, 10);
  }
  const out = await REGISTRY.writeLicence(biz.db, want);
  return res.json({ ok: true, licence: want, wrote: out.pushed === true });
}

app.patch('/api/installs/:id', authed, async (req, res, next) => {
  if (REGISTRY.registryMode()) {
    try { return await editLicence(req.params.id, req.body || {}, res); }
    catch (e) { return next(e); }
  }
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

/* Static last: the page, its script, and the same fonts the terminal wears.
   The QR encoder is the app's own (ISO 18004, jsQR-verified) — the 2FA sheet
   draws the otpauth: secret as a scannable code with it, one file, no
   dependency. */
app.get('/kashikeyo-qr.js', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'app', 'kashikeyo-qr.js')));
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
    app.listen(port, () => {
      console.log('[panel] listening on ' + port);
      /* The pulse: one probe a minute, written down, so uptime is a measured
         figure and a transition is an event on the timeline. Delayed 15 s so
         a deploy does not stamp its own boot window as an outage. */
      if (process.env.APP_URL && REGISTRY.registryMode()) {
        setTimeout(() => { sweepPulse(); setInterval(sweepPulse, 60e3); }, 15e3);
        console.log('[panel] pulsing ' + process.env.APP_URL + '/readyz every 60s');
      } else {
        console.log('[panel] no pulse — '
          + (REGISTRY.registryMode() ? 'APP_URL is not set' : 'not in registry mode'));
      }
      /* WHICH WORLD THIS PANEL IS IN, in one line, because the two behave
         differently and a screen that looks the same either way is how
         somebody spends an afternoon wondering why Provision refuses. */
      console.log(REGISTRY.registryMode()
        ? '[panel] reading the registry "' + process.env.CONTROL_DB + '" directly'
          + (dedicatedOn() ? ' · dedicated installs ALSO enabled'
            : ' · dedicated-install provisioning is off (PANEL_DEDICATED_INSTALLS)')
        : '[panel] no CONTROL_DB — probing dedicated installs over HTTP with'
          + ' their platform keys');
    });
  }).catch((e) => {
    console.error('[panel] could not migrate its registry:', e.message);
    process.exit(1);
  });
}

module.exports = { app, migrate, pool, _sign: sign, _verify: verify,
  _totpAt: totpAt, _sweepPulse: sweepPulse };
