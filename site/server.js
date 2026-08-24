'use strict';
/* ═══ THE WEBSITE — WHERE A CUSTOMER ASKS FOR A STORE ═══════════════════════
   The public face of the product: the landing page, the docs, the legal
   pages, and the signup. Recovered from the original site the seller built,
   with one deliberate change of meaning: the product is sold ONE INSTALL PER
   CUSTOMER, so the signup no longer creates credentials on a shared backend
   (the flow the old multi-tenant app had). It records a STORE REQUEST in
   Mission Control's registry, the seller provisions the install — their own
   service, their own database — and the customer receives their own address,
   where the real onboarding (and their real password) happens. A 14-day
   trial starts when the install is provisioned, extendable from the panel.

   Why not automatic provisioning: a signup form anyone on the internet can
   post spins up REAL infrastructure that costs real money per install. A
   person deciding "this is a customer" is the fence — the same judgement
   this codebase applies to trial enforcement.

   Runs as its own service from the same image (`node site/server.js`),
   sharing the panel's registry database — it writes signup rows and reads
   nothing. */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { gate } = require('../src/limit');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  max: 3,
  application_name: 'kashikeyo-site',
  ssl: process.env.PGSSL_CA
    ? { ca: process.env.PGSSL_CA, rejectUnauthorized: true, checkServerIdentity: () => undefined }
    : (process.env.DATABASE_URL && /railway|proxy\.rlwy/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false } : undefined)
});
pool.on('error', (e) => console.error('[site] idle connection lost:', e.message));

/* The site owns only its own table; the panel reads it. CREATE IF NOT EXISTS
   on both sides, so whichever service boots first wins and the other agrees. */
async function migrate() {
  /* The website and the panel boot together against one registry; concurrent
     CREATE IF NOT EXISTS still races in Postgres's catalogs. Same advisory
     lock as panel/server.js, so whoever boots second waits instead of dying. */
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(881234)');
    await c.query(`
    CREATE SCHEMA IF NOT EXISTS panel;
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

/* ── CSP: hash the pages' own inline scripts, allow nothing foreign ─────── */
function inlineHashes() {
  const hashes = [];
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      hashes.push("'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'");
    }
  }
  return Array.from(new Set(hashes)).join(' ');
}
let CSP = '';
function buildCsp() {
  CSP = "default-src 'self'; script-src 'self' " + inlineHashes() + ';'
    + " style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';"
    + " connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
}
buildCsp();
if (process.env.NODE_ENV !== 'production') setInterval(buildCsp, 2000).unref();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('content-security-policy', CSP);
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'no-referrer');
  next();
});

/* ── the apex belongs to this website; the till lives at APP_URL ────────────
   The bare domain used to serve the terminal, so its paths are typed,
   bookmarked and printed. They forward permanently to the till's own home
   (app.kashikeyopos.com), path and query intact — a moved address answers,
   it never 404s. `/g/<slug>`, `/m/<slug>` and `/join/<token>` are the PRINTED
   path forms: a QR card made before a store took its handle keeps working
   for as long as it is stuck to the table. `/signup` deliberately stays here —
   on the product's website, signing up means asking for a store.
   `www.` is the site under another name and 301s to the bare domain. */
const APP_URL = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
const CANONICAL = String(process.env.CANONICAL_HOST || '').trim().toLowerCase();
const TILL_PATHS = /^\/(pos|kds|admin|onboarding|account|signin|member|card)(\/|$)|^\/(g|m|join)\//;
app.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  if (CANONICAL && host === 'www.' + CANONICAL) {
    return res.redirect(301, 'https://' + CANONICAL + req.originalUrl);
  }
  if (APP_URL && TILL_PATHS.test(req.path)) {
    return res.redirect(308, APP_URL + req.originalUrl);
  }
  next();
});

/* The landing page's footer pill asks; answer for THIS site honestly. */
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});
app.get('/readyz', (req, res) => res.redirect(307, '/api/health'));

/* One door, two buckets — the same doorman as every open door in the
   product. The identity is the email the request is about. */
app.post('/api/site/signup',
  gate('site-signup', { ip: [12, 3600e3], id: [4, 3600e3] }, (req) => (req.body || {}).email),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const store = String(b.storeName || '').trim().slice(0, 120);
      const name = String(b.contactName || '').trim().slice(0, 120);
      const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
      const phone = String(b.phone || '').trim().slice(0, 40);
      const island = String(b.island || '').trim().slice(0, 120);
      const note = String(b.note || '').trim().slice(0, 1000);
      if (!store) return res.status(400).json({ error: 'What is your store called?' });
      if (!name) return res.status(400).json({ error: 'Your name is required.' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!phone) return res.status(400).json({ error: 'A contact number is required.' });
      /* One open request per address: pressing the button twice, or asking
         again a day later, must not stack five rows in front of the seller.
         The answer is byte-identical either way — this door keeps the same
         enumeration promise as every other. */
      const dup = await pool.query(
        "SELECT 1 FROM panel.signup WHERE email = $1 AND status IN ('new','contacted')", [email]);
      if (!dup.rows.length) {
        await pool.query(
          'INSERT INTO panel.signup (store_name, contact_name, email, phone, island, note)'
          + ' VALUES ($1,$2,$3,$4,$5,$6)', [store, name, email, phone, island, note]);
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* The same faces the terminal wears — served from the app's own font dir. */
app.use('/fonts', express.static(path.join(__dirname, '..', 'app', 'fonts'), { maxAge: '30d' }));

/* Clean URLs onto the flat files, the way the pages link each other. */
const PAGES = { '/': 'landing.html', '/signup': 'signup.html', '/login': 'login.html',
  '/docs': 'docs.html', '/status': 'status.html', '/terms': 'terms.html', '/privacy': 'privacy.html' };
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}
app.use(express.static(__dirname, { index: false, maxAge: '1h' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'landing.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[site]', err.message);
  res.status(500).json({ error: 'something failed — try again' });
});

if (require.main === module) {
  migrate().then(() => {
    const port = Number(process.env.PORT) || 4096;
    app.listen(port, () => console.log('[site] listening on ' + port));
  }).catch((e) => {
    console.error('[site] could not reach the registry:', e.message);
    process.exit(1);
  });
}

module.exports = { app, migrate, pool };
