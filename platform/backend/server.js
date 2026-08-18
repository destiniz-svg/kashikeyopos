'use strict';
const express = require('express');
const { owner, shutdown } = require('./src/db');
const routes = require('./src/routes');
const { allowOrigin } = require('./src/cors');

const app = express();
app.set('trust proxy', 1);              // Railway terminates TLS at the edge
app.use(express.json({ limit: '2mb' }));

/* Who may call this from a browser — see src/cors.js. A literal '*' means any
   origin there, which it did not used to. */
app.use(function (req, res, next) {
  const o = allowOrigin(process.env.ALLOWED_ORIGINS, req.get('origin'));
  if (o) {
    res.set('access-control-allow-origin', o);
    res.set('vary', 'origin');
    res.set('access-control-allow-headers', 'authorization,content-type');
    res.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    /* A browser can only read the headers a cross-origin response says it may,
       and everything here IS cross-origin in the deployed shape: the POS is a
       static site on its own domain and the API is somewhere else. Without
       this, an export downloads as whatever fallback name the client invented
       instead of the one the server chose — which is how a file called
       `export.csv` ends up in an accountant's folder beside four others. */
    res.set('access-control-expose-headers', 'content-disposition');
    res.set('access-control-max-age', '600');
  }
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', function (req, res) { res.json({ ok: true }); });

// Railway's healthcheck hits this: the service is only ready when the control
// plane answers, otherwise a deploy that cannot see its database goes live.
app.get('/readyz', async function (req, res) {
  try {
    await owner().query('SELECT 1 FROM chain.outlet LIMIT 1');
    res.json({ ok: true, at: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/api', routes);

app.use(function (req, res) { res.status(404).json({ error: 'not found' }); });
app.use(function (err, req, res, next) {
  const status = err.status || 500;
  // Never return a database message to a client: it names schemas and roles.
  if (status >= 500) console.error('[error]', err.stack || err.message);
  res.status(status).json({ error: status >= 500 ? 'server error' : err.message });
});

const port = Number(process.env.PORT || 8080);
const server = app.listen(port, function () {
  console.log('kashikeyo-server listening on ' + port);
});

['SIGTERM', 'SIGINT'].forEach(function (sig) {
  process.on(sig, function () {
    server.close(function () { shutdown().then(function () { process.exit(0); }); });
    setTimeout(function () { process.exit(0); }, 10000).unref();
  });
});
