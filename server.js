'use strict';
const path = require('path');
const express = require('express');
const { owner, shutdown } = require('./src/db');
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
const origins = (process.env.ALLOWED_ORIGINS || '').split(',')
  .map((s) => s.trim()).filter(Boolean);

app.use(function (req, res, next) {
  const o = req.get('origin');
  if (o && (origins.indexOf('*') >= 0 || origins.indexOf(o) >= 0)) {
    res.set('access-control-allow-origin', o);
    res.set('vary', 'origin');
    res.set('access-control-allow-headers', 'authorization,content-type,x-table-token');
    res.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.set('access-control-max-age', '600');
  }
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

// Railway's healthcheck hits this: the service is only ready when the control
// plane answers, otherwise a deploy that cannot see its database goes live.
app.get('/readyz', async function (req, res) {
  if (bootError) return res.status(503).json({ ok: false, migration: bootError });
  try {
    await owner().query('SELECT 1 FROM chain.outlet LIMIT 1');
    res.json({ ok: true, at: new Date().toISOString() });
  } catch (e) {
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
  res.status(status).json({ error: status >= 500 ? 'server error' : err.message });
});

const port = Number(process.env.PORT || 8080);

async function boot() {
  if (process.env.SKIP_MIGRATE !== '1') {
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
