'use strict';
const path = require('path');
const express = require('express');
const { owner, canConnect, withOutletRead, shutdown, peerCaPem } = require('./src/db');
const { migrate, migrateControl, fleet } = require('./src/scripts/migrate');
const { hostHandle, baseDomain } = require('./src/handle');
const watch = require('./src/watch');
const directory = require('./src/directory');

// Set when a migration could not finish, and reported by both health
// endpoints so a half-migrated schema cannot pass for a healthy one.
let bootError = null;
/* The last device sweep's count, so a /metrics scrape reports what the
   watchdog last actually saw rather than opening every business database on
   somebody else's polling interval. */
let lastQuiet = 0;

const app = express();
app.set('trust proxy', 1);              // Railway terminates TLS at the edge
app.set('x-powered-by', false);
app.use(express.json({ limit: '4mb' }));

/* ── headers ────────────────────────────────────────────────────────────────
   A till runs for months on the same tab in a browser nobody updates. The
   headers are therefore strict by default and the app is written to live
   inside them: no inline event handlers, no remote script, no remote font. */
/* CROSS-ORIGIN IS A LIST, and in production it is never a wildcard. The apps
   are same-origin — the till, both phone apps and the panel each serve their
   own pages — so `*` buys nothing and hands every website on the internet the
   ability to read the answers to this install's anonymous endpoints for any
   store it can name. It is convenient in development and a mistake in
   production, so production refuses the value BY NAME rather than honouring
   it: the wildcard is dropped, same-origin still works, and the boot log says
   what happened. Refusing to start would be disproportionate — a wildcard is
   not a half-migrated schema, and taking a restaurant off the air over a CORS
   setting is worse than the setting. */
const origins = (function () {
  const raw = (process.env.ALLOWED_ORIGINS || '').split(',')
    .map((s) => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && raw.indexOf('*') >= 0) {
    console.warn('[cors] ALLOWED_ORIGINS contains "*" — refused in production.'
      + ' Same-origin requests are unaffected; name the origins you actually'
      + ' need instead.');
    return raw.filter((o) => o !== '*');
  }
  return raw;
})();

/* ── Content-Security-Policy ─────────────────────────────────────────────
   The apps are deliberately self-contained — local scripts, local fonts, no
   CDN — so the policy can say so and make it enforceable: a script injected
   into a page has nowhere to run and nowhere to send anything. The two front
   doors carry their app inline (the theme snippet must run before first
   paint), so those exact blocks are allowlisted BY HASH, computed from the
   files on disk — edit the page and the hash follows at the next boot,
   where 'unsafe-inline' would have allowlisted the attacker's script too.
   'unsafe-eval' stays: the DC runtime compiles its templates with
   new Function, which is the price of shipping hand-written HTML with no
   build step. Styles are inline throughout the apps, so style-src keeps
   'unsafe-inline' — style attributes cannot exfiltrate or execute. */
const cspCrypto = require('crypto');
const cspFs = require('fs');
let cspHeader = null;
let cspBuiltAt = 0;
function csp() {
  // Development edits HTML without restarting; production computes once.
  const ttl = process.env.NODE_ENV === 'production' ? Infinity : 2000;
  if (cspHeader && Date.now() - cspBuiltAt < ttl) return cspHeader;
  const hashes = new Set();
  const dir = path.join(__dirname, 'app');
  try {
    for (const f of cspFs.readdirSync(dir)) {
      if (!/\.html$/.test(f)) continue;
      const src = cspFs.readFileSync(path.join(dir, f), 'utf8');
      const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
      let m;
      while ((m = re.exec(src))) {
        const type = ((m[1] || '').match(/type="([^"]+)"/) || [])[1];
        // text/x-dc templates are data to the browser, not scripts.
        if (type && type !== 'module'
          && !/^(text|application)\/(java|ecma)script$/i.test(type)) continue;
        hashes.add("'sha256-"
          + cspCrypto.createHash('sha256').update(m[2]).digest('base64') + "'");
      }
    }
  } catch (e) { /* an unreadable app dir already fails louder elsewhere */ }
  const build = (evalOk) => [
    "default-src 'self'",
    "script-src 'self'" + (evalOk ? " 'unsafe-eval'" : '') + ' '
      + Array.from(hashes).join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ');
  cspHeader = { eval: build(true), strict: build(false) };
  cspBuiltAt = Date.now();
  return cspHeader;
}

/* 'unsafe-eval' IS NOT A PROPERTY OF THE PRODUCT, IT IS A PROPERTY OF THREE
   PAGES. The template runtime compiles with `new Function`, so the till and
   both phone apps need it and shipping hand-written HTML with no build step is
   what buys. The two FRONT DOORS — /account and /onboarding — are vanilla DOM
   and have never needed it, and they are the pages a stranger reaches first:
   the sign-up form and the panel that claims an install. Handing them the
   weakest directive in the policy for a runtime they do not load was a habit,
   not a decision. They get the strict header. */
/* And the two DOCUMENT pages, for the same reason: /r and /st are vanilla DOM
   opened by a stranger from a link in a message, and a page that has never
   needed `new Function` should not be handed the permission to use it. */
const EVAL_FREE = /^\/(account|onboarding|r|st)(\/|$)/;

app.use(function (req, res, next) {
  const o = req.get('origin');
  if (o && (origins.indexOf('*') >= 0 || origins.indexOf(o) >= 0)) {
    res.set('access-control-allow-origin', o);
    res.set('vary', 'origin');
    res.set('access-control-allow-headers', 'authorization,content-type,x-table-token');
    res.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.set('access-control-max-age', '600');
  }
  res.set('content-security-policy',
    EVAL_FREE.test(req.path) ? csp().strict : csp().eval);
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'no-referrer');
  res.set('x-frame-options', 'SAMEORIGIN');
  res.set('permissions-policy', 'geolocation=(), microphone=(), payment=()');
  if (process.env.NODE_ENV === 'production') {
    res.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* COUNTED BEFORE ANYTHING ROUTES, so a 404 and a refusal are counted too —
   those are exactly the requests an operator wants a number for. */
app.use(watch.meter());

/* ── /metrics ──────────────────────────────────────────────────────────────
   Guarded, and a 404 until it is. What this returns is the shape of the
   install — how many businesses, how many outlets, how much traffic — which is
   nobody's business but the operator's, and an unguarded metrics endpoint is a
   reconnaissance gift. Same doctrine as the platform door: unset, it does not
   exist; set, it is compared in constant time. */
app.get('/metrics', async function (req, res) {
  const want = String(process.env.METRICS_KEY || '');
  if (want.length < 16) return res.status(404).end();
  const got = String(req.get('x-metrics-key') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !cspCrypto.timingSafeEqual(a, b)) return res.status(404).end();
  try {
    const [r, f] = await Promise.all([readiness(), fleetState()]);
    res.type('text/plain; version=0.0.4').send(watch.render({
      ready: !r.unreachable.length, outlets: r.outlets,
      unreachable: r.unreachable.length,
      businesses: f.live, behind: f.behind.length, failed: f.failed.length,
      quiet: lastQuiet
    }));
  } catch (e) {
    // A scrape must never be the thing that pages you. Serve what is knowable.
    res.type('text/plain; version=0.0.4').send(watch.render({ ready: false }));
  }
});

app.get('/healthz', function (req, res) {
  if (bootError) return res.status(503).json({ ok: false, migration: bootError });
  res.json({ ok: true });
});

/* READY MEANS AN OUTLET REQUEST CAN BE SERVED.

   This asked the OWNER connection whether `chain.outlet` had a row, and the
   owner connection bypasses both isolation belts — so it could never detect
   the one failure that actually takes an install off the air. Found by running
   the restore drill DEPLOYMENT.md asks for: `pg_dump` of one database carries
   no roles, so restoring into a fresh cluster leaves every `outlet_<n>_app`
   missing. The app booted, this endpoint answered 200, Railway switched
   traffic to it, and every single outlet request failed with
   `role "outlet_1_app" does not exist`. A drill that stops at the health check
   reports green on an install that cannot take an order.

   So it checks out each active outlet's OWN login role and reads a table in
   that outlet's own schema — which is the whole path a real request takes:
   the derived password, the login, the pinned search_path and the grants. An
   outlet that cannot be reached is NAMED, with the command that fixes it,
   because a 503 saying "not ready" would leave whoever is holding the pager
   exactly where the old 200 left them.

   Two things it deliberately does not do:

     · it does not fail an install with NO outlets. That is a fresh install on
       its way to onboarding, and a probe that never goes green there is a
       fresh install that can never be set up;
     · it does not re-run on every probe while the answer is good. A healthy
       answer is held for ten seconds (`READY_TTL_MS`, a test knob like
       RATE_LIMIT_SCALE), so a health check every few seconds costs one round
       of connections rather than one per request. A FAILING answer is never
       cached, so an install goes green the moment the remedy is run.

   A failing outlet takes the instance out of rotation, deliberately, in the
   same spirit as production exiting rather than serving on a schema it could
   not migrate: this is not a state a restart fixes, and it is not a state to
   serve traffic in either. It should be loud. */
// Read per probe rather than at load, so a test can turn the cache off
// without a second process. `|| 10000` would read 0 as unset, which is the
// trap: an explicit zero is a real setting.
function readyTtl() {
  const v = process.env.READY_TTL_MS;
  return v === undefined || v === '' ? 10000 : Number(v);
}
let readyChecked = 0;
let readyAnswer = null;

/* Every outlet, wherever it lives. With a registry the outlets are spread
   across business databases, so asking the connection's own database for
   "chain.outlet" reports on one customer and calls the install healthy — which
   is the same class of defect as the probe that answered 200 while every
   outlet request failed. The registry is the list; each outlet is then checked
   through its own login role, which is the whole path a real request takes. */
async function everyOutlet() {
  const { control, CONTROL_DB, ownerFor } = require('./src/db');
  if (!CONTROL_DB()) {
    const q = await owner().query(
      'SELECT id, code FROM chain.outlet WHERE active ORDER BY id');
    return q.rows;
  }
  const biz = await control().query(
    "SELECT db_name FROM chain.business WHERE status = 'live' ORDER BY id");
  const out = [];
  for (const b of biz.rows) {
    try {
      const q = await ownerFor(b.db_name).query(
        'SELECT id, code FROM chain.outlet WHERE active ORDER BY id');
      // Which database this outlet lives in, so the probe can open a
      // connection to it rather than to whatever the process happens to be on.
      q.rows.forEach((r) => out.push(Object.assign({ db: b.db_name }, r)));
    } catch (e) {
      // A business whose database cannot be opened is itself unreachable, and
      // saying nothing about it is how the old probe reported green.
      out.push({ id: null, code: b.db_name, dead: e.message });
    }
  }
  return out;
}

/* ── what the watchdog asks ────────────────────────────────────────────────
   Injected into src/watch.js rather than reimplemented there, so an alert can
   never disagree with the endpoint it is watching about the same fact. */

// Every live business and how far its schema has actually got.
async function fleetState() {
  const { control, CONTROL_DB } = require('./src/db');
  const head = require('./src/scripts/migrate').headCount();
  if (!CONTROL_DB()) return { head: head, live: 1, behind: [], failed: [] };
  const q = await control().query(
    'SELECT id, db_name, status, schema_version, build_state FROM chain.business'
    + " WHERE status IN ('live','failed') ORDER BY id");
  const behind = [];
  const failed = [];
  q.rows.forEach((b) => {
    const at = Number(b.schema_version || 0);
    if (b.status === 'failed') {
      failed.push({ db: b.db_name, at: at, error: b.build_state || 'unknown' });
    } else if (at < head) {
      behind.push({ db: b.db_name, at: at });
    }
  });
  return {
    head: head,
    live: q.rows.filter((b) => b.status === 'live').length,
    behind: behind, failed: failed
  };
}

/* A DEVICE THAT CANNOT DELIVER ITS WRITES. chain.device.last_push_at answers
   "when did it last get its writes out", which is a different question from
   last_seen ("when was somebody standing at it") and the one that matters when
   a signed-in till is holding the only copy of an evening. Printers and
   displays never push, so they are not counted — a warning that fires on every
   printer in the shop is one nobody reads. */
async function quietDevices(mins) {
  const { control, CONTROL_DB, ownerFor, owner } = require('./src/db');
  const dbs = [];
  if (CONTROL_DB()) {
    const q = await control().query(
      "SELECT db_name FROM chain.business WHERE status = 'live' ORDER BY id");
    q.rows.forEach((b) => dbs.push({ name: b.db_name, pool: ownerFor(b.db_name) }));
  } else {
    dbs.push({ name: 'this database', pool: owner() });
  }
  const out = [];
  for (const d of dbs) {
    try {
      /* A DEVICE THAT HAS NEVER PUSHED IS NOT A DEVICE THAT HAS STOPPED.
         `last_push_at IS NULL` fired the moment a till first signed in — so
         every newly enrolled terminal, and the only till on every brand-new
         store, was reported as having gone quiet before anybody had rung
         anything. A warning that fires on every new install is one nobody
         reads by the second one, which is the rule this file already keeps for
         printers and for the tax sweep.

         So the clock starts when the device BECAME one that should be
         pushing — it paired, or failing that it was first seen — and only
         then does silence mean anything. A till paired three hours ago that
         has delivered nothing is still named; a till paired two minutes ago
         is not. */
      const q = await d.pool.query(
        'SELECT outlet_id, label, last_push_at,'
        + ' coalesce(last_push_at, paired_at, last_seen) AS quiet_since'
        + ' FROM chain.device'
        + " WHERE NOT revoked AND kind NOT IN ('printer','display')"
        + '   AND coalesce(last_push_at, paired_at, last_seen)'
        + '       < now() - ($1 || \' minutes\')::interval'
        + '   AND last_seen > now() - interval \'7 days\''
        + ' ORDER BY outlet_id', [String(mins)]);
      q.rows.forEach((r) => out.push({
        db: d.name, outlet: r.outlet_id, name: r.label,
        // How long it has been silent, measured from whichever of those the
        // row actually has. `mins: null` still means it has never delivered.
        mins: r.last_push_at
          ? Math.round((Date.now() - new Date(r.last_push_at).getTime()) / 60000)
          : null,
        since: r.quiet_since
          ? Math.round((Date.now() - new Date(r.quiet_since).getTime()) / 60000)
          : null
      }));
    } catch (e) {
      // A business that cannot be opened is already the readiness probe's
      // problem; saying it twice is two pages for one fault.
    }
  }
  return out;
}

/* TWO FAULTS, TWO SENTENCES, TWO REMEDIES — and they were one.

   A business whose DATABASE cannot be opened was pushed into the outlet list
   and reported as "an outlet that cannot be reached with its own login role",
   under a remedy that recreates login roles. That remedy cannot fix a missing
   database, so whoever read the 503 would run it, watch it change nothing, and
   still be holding the pager. It is the same defect the restore drill found in
   this endpoint's own remedy, one level up: a message naming a fix that does
   not fit the fault.

   So they are counted apart. An unreachable DATABASE is one customer's whole
   install; an unreachable OUTLET is one store inside a database that opened
   fine. */
async function readiness() {
  const rows = await everyOutlet();
  const unreachable = [];
  const businesses = [];
  for (const o of rows) {
    if (o.dead) { businesses.push({ db: o.code, error: o.dead }); continue; }
    try {
      /* TWO HALVES, AND ONE OF THEM A POOL CANNOT TEST.

         The grants: the outlet's own role, its own schema, its own privileges —
         every belt a real request crosses, and nothing the owner connection
         could stand in for.

         And the credential: a pool authenticates once and then serves for as
         long as it holds the connection, so a revoked CONNECT, a dropped role
         or a rotated OUTLET_ROLE_SECRET stayed invisible here. Measured on a
         live outlet — CONNECT revoked, this endpoint green for three minutes,
         a fresh connection refused the whole time. canConnect() opens one
         outside the pool and closes it, which is the only way to ask. */
      await canConnect(o.id, o.db);
      await withOutletRead({ outletId: o.id, rank: 0, scope: 'outlet' },
        (c) => c.query('SELECT 1 FROM item LIMIT 1'));
    } catch (e) {
      unreachable.push({ outlet: o.id, code: o.code, error: e.message });
    }
  }
  // Only the real ones are counted as outlets — a placeholder standing in for
  // a database that would not open is not a store, and counting it as one is
  // how "4 of 5 outlets" described an install with no such outlets in it.
  return { outlets: rows.length - businesses.length,
    unreachable: unreachable, businesses: businesses };
}

app.get('/readyz', async function (req, res) {
  if (bootError) return res.status(503).json({ ok: false, migration: bootError });
  try {
    /* Only a GOOD answer is held. Fail slow and recover fast: a healthy
       instance is not re-probed for ten seconds, so a blip does not flap it;
       a failing one is re-asked every time, so the moment somebody runs the
       remedy the probe goes green without waiting out a cache. */
    if (!readyAnswer || Date.now() - readyChecked > readyTtl()) {
      const now = await readiness();
      readyAnswer = now;
      readyChecked = (now.unreachable.length || now.businesses.length)
        ? 0 : Date.now();
    }
    const bad = readyAnswer.unreachable;
    const dead = readyAnswer.businesses || [];
    if (bad.length || dead.length) {
      const said = [];
      const fix = [];
      if (dead.length) {
        said.push(dead.length + ' business database(s) cannot be opened');
        fix.push('For a database that cannot be opened: restore it, or — if it'
          + ' is gone deliberately — take its row out of the live set'
          + " (chain.business.status) so the fleet stops counting it."
          + ' Recreating login roles does nothing for this one.');
      }
      if (bad.length) {
        said.push(bad.length + ' of ' + readyAnswer.outlets + ' outlet(s)'
          + ' cannot be reached with their own login role');
        fix.push('For an outlet whose own role cannot serve it:'
          + " npm run provision:outlet -- --all, with the install's own"
          + ' OUTLET_ROLE_SECRET. Outlet login roles are cluster-wide and a'
          + ' pg_dump of one database does not carry them.');
      }
      return res.status(503).json({
        ok: false,
        error: 'the control plane answers but ' + said.join(', and ')
          + ' — no request for them can be served',
        unreachable: bad,
        businesses: dead,
        remedy: fix.join(' ')
      });
    }
    res.json({ ok: true, outlets: readyAnswer.outlets, at: new Date().toISOString() });
  } catch (e) {
    readyAnswer = null;
    res.status(503).json({ ok: false, error: 'database not ready' });
  }
});

/* Which store this request is addressed to — <handle>.kashikeyopos.com — or
   null for the apex app. Resolved once, before anything routes on it, so the
   API, the pages and the 404 all read the same answer.

   A store may change its address, and the one it gave up is already printed on
   the tables. So a retired handle is sent on, permanently, with the path it was
   asked for — the guest ends up at the right menu with the right thing in their
   address bar. A directory failure never blocks a guest: the request simply
   carries on to the store it named. */
app.use(function (req, res, next) {
  req.storeHandle = hostHandle(req.hostname || req.get('host') || '');
  if (!req.storeHandle) return next();
  directory.movedTo(req.storeHandle).then(function (to) {
    const base = baseDomain();
    if (!to || !base) return next();
    res.redirect(301, 'https://' + to + '.' + base + req.originalUrl);
  }).catch(function () { next(); });
});

app.use('/api', require('./src/routes'));

/* ── the app itself, served from disk. There is no build step: the terminal is
      hand-written HTML and the DC runtime, so what ships is what was read. ── */
const APP = path.join(__dirname, 'app');
app.use(express.static(APP, {
  etag: true,
  maxAge: '5m',
  // "/" is not a file here: on the apex it is the terminal and on a store's
  // own address it is that store's ordering portal. Letting static answer it
  // would hand a guest the till.
  index: false,
  setHeaders: function (res, file) {
    // The shell must never be cached hard: a stale terminal is a terminal
    // running last month's tax rate.
    if (/\.(html|webmanifest)$/.test(file)) res.set('cache-control', 'no-cache');
    if (/sw\.js$/.test(file)) {
      res.set('cache-control', 'no-cache');
      res.set('service-worker-allowed', '/');
    }
    if (/\.(woff2|png|jpg|svg)$/.test(file)) res.set('cache-control', 'public, max-age=604800');
  }
}));

/* ── /.well-known ────────────────────────────────────────────────────────
   express.static ignores dotfiles, so anything under /.well-known/ 404s — and
   that is exactly where the world expects to find proof you control this
   domain. Apple will not enable Sign in with Apple until it can fetch
   /.well-known/apple-developer-domain-association.txt from here.

   Mapped from a directory WITHOUT a leading dot, so turning this on cannot
   also start serving .env or .git by accident. Drop the verification files
   into app/well-known/ and they answer at /.well-known/. */
app.use('/.well-known', express.static(path.join(APP, 'well-known'), {
  dotfiles: 'ignore',
  setHeaders: function (res) { res.set('cache-control', 'public, max-age=300'); }
}));

require('./src/routes/pages')(app, APP);

app.use(function (req, res) {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  // An unknown path falls back to whichever app owns this hostname. A guest on
  // a store's address who mistypes one must not land on the back office.
  res.status(404).sendFile(path.join(APP, req.storeHandle ? 'guest.html' : 'index.html'));
});

app.use(function (err, req, res, next) {          // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  // Never return a database message to a client: it names schemas and roles.
  if (status >= 500) console.error('[error]', err.stack || err.message);
  /* Backpressure is the exception: a pool that ran out of connections is a
     BUSY outlet, not a broken one, and the caller needs to know it may simply
     go again. The message is ours, written for an operator, and names nothing
     about the schema. */
  if (err.retryable) res.set('retry-after', '1');
  const speak = status < 500 || err.retryable;
  res.status(status).json({ error: speak ? err.message : 'server error' });
});

const port = Number(process.env.PORT || 8080);

/* History has a horizon (migration 025): op_log is a replay window, not an
   archive, and the floor board is not a record. Daily, and once at boot —
   in-process because this build is one process, like the doorman. chain.audit
   is never pruned; setting either knob to 0 disables that table's pruning. */
/* EVERY BUSINESS, NOT THE ONE THIS PROCESS DIALLED. /readyz was generalised
   to walk the fleet when the tenancy boundary moved; this was not, and it took
   an audit to notice, because a prune that removes nothing logs nothing —
   there is no failure to see, only silence that looks exactly like "nothing
   was old enough yet".

   The connected database has no job in a registry install. op_log is a replay
   window and guest_request is a floor board; left unpruned in every real
   customer's database they grow for ever, a row per op and a row per guest
   signal, on tables that are only ever appended to.

   One business failing does not stop the others, for the same reason a
   business behind head does not stop the fleet: one customer's disk is not
   every customer's. */
async function eachBusinessDb() {
  const { control, CONTROL_DB, ownerFor } = require('./src/db');
  if (!CONTROL_DB()) return [{ db: null, pool: owner() }];
  const biz = await control().query(
    "SELECT db_name FROM chain.business WHERE status = 'live' ORDER BY id");
  return biz.rows.map((b) => ({ db: b.db_name, pool: ownerFor(b.db_name) }));
}

/* WHEN DID A COPY LAST LAND? One question, asked by the watchdog and by
   `npm run backup -- --check`, so the alert and the command a person runs
   after reading it cannot disagree.

   `configured: false` is a real answer and the watchdog stays silent on it:
   an install with no destination has made a choice, and paging somebody every
   six hours about their own decision is how an alert channel gets muted. */
async function backupState() {
  const backup = require('./src/backup');
  const h = await backup.health();
  const windowHours = Number(process.env.BACKUP_STALE_HOURS
    || (Number(process.env.BACKUP_EVERY_HOURS || 24) * 2));
  const at = h.lastGood && h.lastGood.finished_at
    ? new Date(h.lastGood.finished_at).getTime() : null;
  return {
    configured: !!h.configured,
    where: h.where,
    windowHours: windowHours,
    ageHours: at === null ? null : (Date.now() - at) / 3600e3,
    recentFailures: h.recentFailures || 0,
    lastWhy: h.last && !h.last.ok ? h.last.why : null
  };
}

async function pruneHistory() {
  const opD = Number(process.env.RETAIN_OP_LOG_DAYS || 90);
  const grD = Number(process.env.RETAIN_GUEST_REQUEST_DAYS || 30);
  if (!opD || !grD) return;
  let targets;
  try { targets = await eachBusinessDb(); }
  catch (e) { return console.error('[retention] could not list the fleet: ' + e.message); }
  for (const t of targets) {
    try {
      const q = await t.pool.query('SELECT * FROM chain.prune_history($1,$2)', [opD, grD]);
      const op = q.rows.reduce((a, r) => a + Number(r.op_rows), 0);
      const gr = q.rows.reduce((a, r) => a + Number(r.guest_rows), 0);
      if (op || gr) {
        console.log('[retention] ' + (t.db || 'this database') + ': pruned ' + op
          + ' op_log and ' + gr + ' guest_request rows past ' + opD + '/' + grD + ' days');
      }
    } catch (e) {
      console.error('[retention] ' + (t.db || 'this database') + ': ' + e.message);
    }
  }
}

/* A database that has not come up yet is not a broken schema, and saying so is
   not a detail: the second live install printed "the schema is not what this
   build expects: getaddrinfo ENOTFOUND postgres.railway.internal" — a sentence
   that sends whoever reads it to look at migrations, which were fine. The
   database simply was not there yet.

   Worse than the wording, the process exited on it immediately. In production
   that is correct for a schema it could not finish; for a database that is
   thirty seconds behind it is a crash loop that a platform's restart budget
   outlives, and the app stays down after the database comes up. That is not
   only a provisioning race — it is every Postgres restart and every failover on
   a live install.

   So connectivity is waited for, separately and out loud, and only what is left
   is a migration failure. Bounded, because waiting for ever is its own outage
   with no message. */
async function awaitDatabase() {
  const limit = Number(process.env.DB_WAIT_MS || 90000);
  const started = Date.now();
  let said = false;
  for (;;) {
    try { await owner().query('SELECT 1'); return true; }
    catch (e) {
      if (Date.now() - started > limit) {
        console.error('[boot] NO DATABASE — could not reach it in '
          + Math.round(limit / 1000) + 's: ' + e.message);
        return false;
      }
      if (!said) {
        console.log('[boot] waiting for the database: ' + e.message);
        said = true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/* THE REGISTRY IS NOT OPTIONAL, AND SAYING SO AT BOOT IS THE CHEAP PLACE.

   Three comments in this repo — here, in src/business.js and in
   src/routes/onboarding.js — used to say that without CONTROL_DB this is
   simply a single-database install behaving as it always did. That stopped
   being true when outlet ids and handles moved to the registry, and nothing
   noticed, because every test suite names a registry of its own: there has
   never been a run without one.

   What actually happens is worse than a refusal. The app boots, answers
   /readyz 200, serves the onboarding panel, accepts step 1 — and then step 2
   throws `CONTROL_DB is not set` four calls deep in provisionOutlet and comes
   back as a bare 500. The same throw is behind handle_points_at(), so a store
   that somehow existed would have a dead guest portal, and behind the handle
   check and rename on the outlet route. An install that can create a company
   and never an outlet is not a working single-database install; it is a
   half-configured one that looks fine until somebody tries to trade.

   So it is named here, at the one moment somebody is reading the log, with
   the remedy in the message. The cost to a self-hosted install is a single
   variable: the database itself does not have to exist, because
   ensureControlDb() creates it on the next boot. What is NOT done is picking
   a default — control() refuses to guess for a reason, and a guess would make
   a business's own database its registry on a misconfigured deploy, with the
   accounts landing in the wrong place and nothing saying so. */
function registryNamed() {
  if (String(process.env.CONTROL_DB || '').trim()) return true;
  bootError = 'CONTROL_DB is not set — this install has no registry, so it'
    + ' cannot allocate an outlet id, claim a store address, or route a'
    + ' request to a business. Set CONTROL_DB to the name you want the'
    + ' registry database to have (kashikeyo_control is the usual one); it is'
    + ' created on the next boot if it does not exist.';
  console.error('[boot] ' + bootError);
  return false;
}

async function boot() {
  if (!registryNamed() && process.env.NODE_ENV === 'production') process.exit(1);
  if (process.env.SKIP_MIGRATE !== '1') {
    if (!(await awaitDatabase())) {
      bootError = 'the database is unreachable';
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }
    try {
      /* THE REGISTRY FIRST, THEN THE FLEET. With CONTROL_DB set this install is
         a multi-business one: the registry lists the fleet, so migrating
         businesses before it would work from yesterday's list. Without it
         there is nothing this app can do beyond migrate the one database it
         is connected to — registryNamed() above has already said so and, in
         production, already exited. */
      if (String(process.env.CONTROL_DB || '').trim()) {
        await migrateControl();
        const out = await fleet({});
        console.log('[migrate] ' + out.checked + ' business database(s) at head '
          + out.head + ', ' + out.moved + ' moved'
          + (out.failed.length ? ', ' + out.failed.length + ' FAILED: '
            + out.failed.map((f) => f.db).join(', ') : ''));
        /* A failed business does NOT stop the boot. The other shops are fine
           and the failed one is refused by name on its own requests, which is
           strictly better than taking every customer down for one broken
           schema. */
      } else {
        await migrate();
      }
    } catch (e) {
      // Production refuses to go live on a schema it could not finish. Every
      // other environment keeps serving so the fault can be fixed from the
      // same shell — but it says so on every health check, because a silent
      // half-migrated schema is how you spend an afternoon debugging code
      // that was never the problem.
      bootError = e.message;
      console.error('[boot] MIGRATION FAILED — the schema is not what this'
        + ' build expects: ' + e.message);
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }
  }
  const server = app.listen(port, function () {
    console.log('KashikeyoPOS listening on ' + port);
  });
  // The unpinned-TLS warning names the fix; this hands over the ingredient.
  // Prints only while nothing is pinned, so it silences itself once acted on.
  peerCaPem().then(function (ca) {
    if (!ca) return;
    /* The ADVICE is a warning; the certificate is not. console.warn goes to
       stderr, which a hosting platform classifies as an error — so printing
       both together painted ~25 red lines across every healthy first boot,
       which is how an operator learns to ignore red in that log. One warning
       line, then the ingredient at ordinary level. */
    console.warn('[db] to pin this database, set PGSSL_CA to the certificate'
      + ' below (then PGSSL=verify):');
    console.log(ca);
  }).catch(function () {});
  /* WHAT DID THIS BOOT LAND ON? One line, because "is production clean" must
     never require a database client to answer.

     It used to ask the CONNECTED database for a company and an outlet count.
     In a registry install that database has no job — no business keeps its
     books there — so on a correctly configured one the line read "no company
     yet, onboarding is open" for ever, and on an install pointed straight at
     its registry it read "state unreadable: relation chain.company does not
     exist" on every boot. Both describe a database nobody trades in.

     The fleet is the answer now, and the claim fence is only mentioned where
     it still means something: a single-database install, where the first
     caller really does become the owner. */
  (async function sayWhereWeAre() {
    const { CONTROL_DB } = require('./src/db');
    if (CONTROL_DB()) {
      const b = await require('./src/db').control().query(
        "SELECT count(*)::int AS live FROM chain.business WHERE status = 'live'");
      const n = Number(b.rows[0].live);
      console.log('[install] registry "' + CONTROL_DB() + '" \u00b7 ' + n
        + ' business database(s)'
        + (n ? '' : ' \u2014 the first signup creates one'));
      return;
    }
    const co = await owner().query('SELECT legal_name FROM chain.company LIMIT 1');
    const ou = await owner().query('SELECT count(*)::int AS n FROM chain.outlet');
    console.log(co.rows.length
      ? '[install] company "' + co.rows[0].legal_name + '" \u00b7 ' + ou.rows[0].n + ' outlet(s)'
      : '[install] no company yet \u2014 onboarding is open');
    /* Whoever POSTs the first owner OWNS the business, and that call cannot be
       behind a staff session because it is what creates one. So on an install
       that is still unclaimed, the boot says in one line whether the claim is
       fenced — a fence that is silently absent is worse than no fence, because
       somebody believes in it. */
    if (!co.rows.length || !ou.rows[0].n) {
      const st = await owner().query('SELECT * FROM chain.install_state()');
      if (!Number((st.rows[0] || {}).staff)) {
        console.log((process.env.ONBOARDING_CLAIM_TOKEN || '').length >= 8
          ? '[install] unclaimed \u2014 a setup code is required (ONBOARDING_CLAIM_TOKEN)'
          : '[install] unclaimed and OPEN \u2014 the first caller becomes the owner.'
            + ' Set ONBOARDING_CLAIM_TOKEN to require a setup code.');
      }
    }
  }()).catch((e) => console.error('[install] state unreadable: ' + e.message));
  pruneHistory();
  setInterval(pruneHistory, 24 * 3600e3).unref();

  /* ── THE NIGHTLY COPY ────────────────────────────────────────────────────
     The registry, then every live business, each to its own archive. In
     process and on an interval like the retention sweep, and for the same
     reason: one app, one process, and a cron container that has to hold the
     database credentials is a second place to leak them from.

     OFF UNLESS A DESTINATION IS CONFIGURED, and it says which of the two it
     is at boot. A schedule that runs against nowhere is the defect this whole
     feature exists to end — an install believing it has backups because
     something is scheduled. The first run is delayed past boot so a deploy
     does not dump every customer while the pools are still opening, and it is
     staggered off the hour because a fleet all dumping at 03:00 is a fleet
     competing with itself for the same cluster.

     A failure does not stop the others and does not stop the process: each
     database's run is its own row in chain.backup, and the watchdog reads
     them. */
  (function scheduleBackups() {
    const backup = require('./src/backup');
    const hours = Number(process.env.BACKUP_EVERY_HOURS || 24);
    backup.health().then((h) => {
      if (!h.driver) {
        return console.log('[backup] no destination configured \u2014 this install'
          + ' takes NO backups of its own. ' + h.reason);
      }
      if (!h.configured) {
        return console.error('[backup] a destination is configured (' + h.where
          + ') but backups cannot run: ' + h.reason);
      }
      if (!(hours > 0)) {
        return console.log('[backup] destination ' + h.where
          + ' \u2014 scheduled runs are OFF (BACKUP_EVERY_HOURS=0); `npm run'
          + ' backup` still works');
      }
      console.log('[backup] ' + h.driver + ' \u2192 ' + h.where + ' \u00b7 every '
        + hours + 'h \u00b7 keeping ' + (process.env.BACKUP_RETAIN_DAYS || 30)
        + ' days \u00b7 ' + h.tool);
      const run = () => backup.backupAll({ by: 'schedule', log: console.log })
        .then((r) => backup.prune(null, console.log).then(() => r))
        .then((r) => {
          if (!r.ok) {
            console.error('[backup] ' + (r.failed || []).length + ' of '
              + (r.runs || []).length + ' failed');
          }
        })
        .catch((e) => console.error('[backup] run failed: ' + (e.message || e)));
      setTimeout(run, Number(process.env.BACKUP_FIRST_DELAY_MS || 120000)).unref();
      setInterval(run, hours * 3600e3).unref();
    }).catch((e) => console.error('[backup] could not read its own state: '
      + (e.message || e)));
  }());

  /* ── THE WATCHDOG ────────────────────────────────────────────────────────
     Nothing in this build could tell anybody it had gone wrong: no metrics,
     no alerts, no error aggregation. A store that stopped syncing would be
     discovered by the shop ringing up.

     In-process and on an interval, like the doorman and the retention sweep,
     for the same reason: this product is sold one install per customer, so
     there is one process. Sixty seconds by default — long enough that the
     sweep's own cost is nothing, short enough that a dead outlet is named
     within the minute. The FIRST sweep is deliberately delayed: a probe run
     during boot reports on pools that have not opened yet, which is how a
     watchdog earns a reputation for crying wolf on every deploy. */
  console.log(watch.bootLine());
  const probes = {
    readiness: readiness,
    fleet: fleetState,
    quietDevices: async (mins) => {
      const q = await quietDevices(mins);
      lastQuiet = q.length;
      return q;
    },
    /* Injected like the other three so the alert and the CLI can never
       disagree about the same fact — `npm run backup -- --check` reads
       exactly this. */
    backups: backupState
  };
  const everySec = Math.max(15, Number(process.env.WATCH_INTERVAL_SECONDS || 60));
  const tick = () => watch.sweep(probes).catch(
    (e) => console.error('[watch] sweep failed: ' + e.message));
  setTimeout(tick, 20000).unref();
  setInterval(tick, everySec * 1000).unref();
  ['SIGTERM', 'SIGINT'].forEach(function (sig) {
    process.on(sig, function () {
      server.close(function () { shutdown().then(() => process.exit(0)); });
      setTimeout(() => process.exit(0), 10000).unref();
    });
  });
  return server;
}

if (require.main === module) boot();

// pruneHistory is exported so the fleet sweep can be PROVED rather than
// asserted from its source: a prune that removes nothing logs nothing, which
// is exactly how it went unnoticed that it was pruning the wrong database.
module.exports = { app, boot, pruneHistory, readiness, fleetState, quietDevices,
  backupState };
