'use strict';
const path = require('path');
const express = require('express');
const { owner, withOutletRead, shutdown, peerCaPem } = require('./src/db');
const { migrate } = require('./src/scripts/migrate');
const { hostHandle, baseDomain } = require('./src/handle');
const directory = require('./src/directory');

// Set when a migration could not finish, and reported by both health
// endpoints so a half-migrated schema cannot pass for a healthy one.
let bootError = null;

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
const EVAL_FREE = /^\/(account|onboarding)(\/|$)/;

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

async function readiness() {
  const outlets = await owner().query(
    'SELECT id, code FROM chain.outlet WHERE active ORDER BY id');
  const unreachable = [];
  for (const o of outlets.rows) {
    try {
      // The outlet's own role, its own schema, its own grants — every belt a
      // real request crosses, and nothing the owner connection could stand in
      // for.
      await withOutletRead({ outletId: o.id, rank: 0, scope: 'outlet' },
        (c) => c.query('SELECT 1 FROM item LIMIT 1'));
    } catch (e) {
      unreachable.push({ outlet: o.id, code: o.code, error: e.message });
    }
  }
  return { outlets: outlets.rowCount, unreachable: unreachable };
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
      readyChecked = now.unreachable.length ? 0 : Date.now();
    }
    const bad = readyAnswer.unreachable;
    if (bad.length) {
      return res.status(503).json({
        ok: false,
        error: 'the control plane answers but ' + bad.length + ' of '
          + readyAnswer.outlets + ' outlet(s) cannot be reached with their own'
          + ' login role — no request for them can be served',
        unreachable: bad,
        remedy: 'npm run provision:outlet -- --all, with the install\'s own'
          + ' OUTLET_ROLE_SECRET. Outlet login roles are cluster-wide and a'
          + ' pg_dump of one database does not carry them.'
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
async function pruneHistory() {
  const opD = Number(process.env.RETAIN_OP_LOG_DAYS || 90);
  const grD = Number(process.env.RETAIN_GUEST_REQUEST_DAYS || 30);
  if (!opD || !grD) return;
  try {
    const q = await owner().query('SELECT * FROM chain.prune_history($1,$2)', [opD, grD]);
    const op = q.rows.reduce((a, r) => a + Number(r.op_rows), 0);
    const gr = q.rows.reduce((a, r) => a + Number(r.guest_rows), 0);
    if (op || gr) {
      console.log('[retention] pruned ' + op + ' op_log and ' + gr
        + ' guest_request rows past ' + opD + '/' + grD + ' days');
    }
  } catch (e) { console.error('[retention] ' + e.message); }
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

async function boot() {
  if (process.env.SKIP_MIGRATE !== '1') {
    if (!(await awaitDatabase())) {
      bootError = 'the database is unreachable';
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }
    try { await migrate(); }
    catch (e) {
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
  /* What install did this boot land on? One line, because "is production
     clean" must never require a database client to answer. It also catches
     the surprise the promote just met: a database everyone believed empty
     that an earlier build had already migrated. */
  owner().query('SELECT legal_name FROM chain.company LIMIT 1').then(async (co) => {
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
  }).catch((e) => console.error('[install] state unreadable: ' + e.message));
  pruneHistory();
  setInterval(pruneHistory, 24 * 3600e3).unref();
  ['SIGTERM', 'SIGINT'].forEach(function (sig) {
    process.on(sig, function () {
      server.close(function () { shutdown().then(() => process.exit(0)); });
      setTimeout(() => process.exit(0), 10000).unref();
    });
  });
  return server;
}

if (require.main === module) boot();

module.exports = { app, boot };
