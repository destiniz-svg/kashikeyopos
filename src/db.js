'use strict';
const { Pool, types } = require('pg');
const { outletPassword } = require('./secrets');

/* A business date is a DATE, not an instant. Left to the driver, Postgres
   `date` columns arrive as JavaScript Date objects, are serialised to JSON as
   "2026-08-20T00:00:00.000Z", and every downstream comparison against a
   "2026-08-20" business date silently fails — the trading day stops matching
   itself, and a sale lands on no day at all. Read them as the text they are.
   (1082 = DATE.) */
types.setTypeParser(1082, (v) => v);

/* ═══ CONNECTIONS ═══════════════════════════════════════════════════════════
   Two belts of isolation, and this file is where the first one is fastened.

   1. Each outlet connects as its OWN database login role, granted USAGE on its
      own schema alone. Another outlet's tables are unreachable, not merely
      filtered — a forgotten WHERE clause cannot leak, because the rows are not
      in this role's search_path and the schema was never granted.
   2. RLS with FORCE ROW LEVEL SECURITY guards the shared `chain` schema, which
      is by definition visible to every outlet role.

   The owner connection runs migrations and provisioning. No route imports it:
   `ownerOnly()` throws if it is reached while a request context is open.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── TLS to the database ─────────────────────────────────────────────────
   Three states, in order of preference:

     a CA is pinned      PGSSL_CA holds the PEM (or PGSSLROOTCERT names a
                         file), and the certificate is VERIFIED — a
                         man-in-the-middle gets a refusal, not the books.
                         Railway's managed Postgres signs with its own CA;
                         copy it from the service's Connect tab.
     TLS, no CA          the link is encrypted but the server unauthenticated
                         (rejectUnauthorized: false). Warned about at boot,
                         once, because silent is how this setting survived
                         three audits.
     no TLS              local development against loopback.

   PGSSL=verify REQUIRES the pin and refuses to boot without one, so an
   environment that promises verification cannot quietly degrade when the
   variable carrying the certificate is lost. A pinned CA that cannot be read
   fails loudly for the same reason. */
function sslConfig() {
  const mode = process.env.PGSSL || '';
  const on = /^(1|true|require|verify)$/i.test(mode)
    || (process.env.NODE_ENV === 'production' && !!process.env.DATABASE_URL);
  if (!on) return false;
  let ca = process.env.PGSSL_CA || '';
  if (!ca && process.env.PGSSLROOTCERT) {
    ca = require('fs').readFileSync(process.env.PGSSLROOTCERT, 'utf8');
  }
  if (ca) return { ca: ca, rejectUnauthorized: true };
  if (/^verify$/i.test(mode)) {
    throw new Error('PGSSL=verify needs a CA to verify against —'
      + ' set PGSSL_CA (PEM) or PGSSLROOTCERT (path)');
  }
  console.warn('[db] TLS is on but no CA is pinned: the link is encrypted but'
    + ' the server is UNAUTHENTICATED. Set PGSSL_CA or PGSSLROOTCERT to pin it.');
  return { rejectUnauthorized: false };
}
const ssl = sslConfig();

function baseConn() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      database: decodeURIComponent((u.pathname || '/postgres').slice(1))
    };
  }
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'postgres'
  };
}

/* A pool EMITS 'error' when an idle connection dies under it — a Postgres
   restart, a failover, a dropped link — and an 'error' event nobody listens
   to KILLS THE PROCESS. That turns a database blip the pool would have healed
   on the next checkout into a full outage of every till in every outlet. So
   every pool this file makes gets the listener: log it, let the pool discard
   the corpse, and the next query gets a fresh connection. */
function guarded(pool, name) {
  pool.on('error', function (e) {
    console.error('[db] idle connection lost on ' + name + ': ' + e.message);
  });
  return pool;
}

/* When TLS is on but nothing is pinned, the warning used to name the fix and
   keep the one ingredient to itself — the certificate. The app is already
   holding the live TLS socket, so it can READ the server's certificate and
   put the PEM in the boot log, where an operator (or the agent driving the
   deploy) copies it straight into PGSSL_CA. Public material only: a
   certificate is the half the server shows everyone; the private key never
   leaves the database. Walks to the ROOT of the chain, because the root is
   what a pin verifies against — for Railway's self-signed Postgres the leaf
   IS the root. */
function pem(der) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----';
}
async function peerCaPem() {
  if (!ssl || ssl.rejectUnauthorized !== false) return null;
  let client = null;
  try {
    client = await owner().connect();
    const sock = client.connection && client.connection.stream;
    if (!sock || typeof sock.getPeerCertificate !== 'function') return null;
    let cert = sock.getPeerCertificate(true);
    if (!cert || !cert.raw) return null;
    const seen = new Set();
    while (cert.issuerCertificate && cert.issuerCertificate !== cert
      && !seen.has(cert.issuerCertificate.fingerprint256)) {
      seen.add(cert.fingerprint256);
      cert = cert.issuerCertificate;
    }
    return pem(cert.raw);
  } catch (e) {
    return null;
  } finally {
    if (client) client.release();
  }
}

let ownerPool = null;
function owner() {
  if (!ownerPool) {
    const cfg = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl }
      : Object.assign(baseConn(), {
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        ssl
      });
    ownerPool = guarded(new Pool(Object.assign(cfg, { max: 3, application_name: 'kashikeyo-owner' })), 'owner');
  }
  return ownerPool;
}

// ── one pool per outlet, each authenticating as that outlet's own role ───────
const pools = new Map();
function poolFor(outletId) {
  const id = Number(outletId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('bad outlet id'), { status: 400 });
  if (!pools.has(id)) {
    pools.set(id, guarded(new Pool(Object.assign(baseConn(), {
      user: 'outlet_' + id + '_app',
      password: outletPassword(id),
      ssl,
      max: Number(process.env.PGPOOL_MAX || 6),
      idleTimeoutMillis: 30000,
      statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT || 15000),
      application_name: 'kashikeyo-outlet-' + id
    })), 'outlet-' + id));
  }
  return pools.get(id);
}

/* Every request query runs inside a transaction that first declares who is
   asking. SET LOCAL is transaction-scoped: it cannot survive back into the
   pool and carry one outlet's context into the next request. This is not a
   style preference — `SET` without `LOCAL` is a cross-tenant leak waiting for
   load. */
/* ── THE BUSINESS DATE BELONGS TO THE OUTLET ───────────────────────────────
   `current_date` is whatever timezone the SESSION is in, and a Railway
   container is in UTC. Malé is UTC+5, so from 19:00 local — most of a
   restaurant's trading — every document number, business date and settlement
   key was being filed under YESTERDAY while the clock in the header said
   tonight.

   The outlet has always carried its own zone (`chain.outlet.tz`, default
   Indian/Maldives) and nothing read it. Setting it on the TRANSACTION makes
   every `current_date` and `now()::date` inside a request the outlet's own
   local date, in one place, for every handler at once — and because it is
   `SET LOCAL` it dies at COMMIT, so a pooled connection cannot carry one
   outlet's midnight into another's request.

   Cached because a timezone changes approximately never, and the cache only
   ever decides which zone to declare — every date is still computed by
   Postgres against the zone it was told. */
const OUTLET_TZ = new Map();
const TZ_FALLBACK = 'Indian/Maldives';

async function setContext(client, ctx) {
  const known = ctx.outletId ? OUTLET_TZ.get(ctx.outletId) : null;
  await client.query(
    "SELECT set_config('app.outlet_id', $1, true),"
    + " set_config('app.user_rank', $2, true),"
    + " set_config('app.actor', $3, true),"
    + " set_config('app.scope', $4, true),"
    + " set_config('app.device', $5, true),"
    + " set_config('timezone', $6, true)",
    [String(ctx.outletId || ''), String(ctx.rank || 0), ctx.actor || '',
      ctx.scope === 'group' ? 'group' : 'outlet', ctx.deviceId || '',
      known || TZ_FALLBACK]
  );
  // Cold cache: the row is only readable once the context above is set, so it
  // is a second statement rather than a subquery in the first — the order the
  // target list is evaluated in is not something to bet a tenant boundary on.
  if (ctx.outletId && !known) {
    const q = await client.query('SELECT tz FROM chain.outlet WHERE id = $1',
      [ctx.outletId]);
    const tz = ((q.rows[0] || {}).tz || TZ_FALLBACK);
    OUTLET_TZ.set(ctx.outletId, tz);
    if (tz !== TZ_FALLBACK) {
      await client.query("SELECT set_config('timezone', $1, true)", [tz]);
    }
  }
  // Stamped on the context so a handler that has to compute a date in Node
  // computes it on the same clock Postgres just adopted.
  ctx.tz = (ctx.outletId ? OUTLET_TZ.get(ctx.outletId) : null) || TZ_FALLBACK;
}

/* A caught query error inside a transaction is a landmine: Postgres poisons
   the transaction, and the COMMIT that follows silently becomes a ROLLBACK
   with no error raised. The caller then reports success on work that was
   discarded. Every commit is therefore checked — if the server said ROLLBACK,
   so do we, loudly. */
async function commit(client) {
  const q = await client.query('COMMIT');
  if (q && q.command === 'ROLLBACK') {
    throw Object.assign(
      new Error('transaction was aborted by an earlier error and did not commit'),
      { status: 500, aborted: true });
  }
}

async function withOutlet(ctx, fn) {
  const client = await poolFor(ctx.outletId).connect();
  try {
    await client.query('BEGIN');
    await setContext(client, ctx);
    const out = await fn(client);
    await commit(client);
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Read-only variant: a report can never be the thing that changed the books.
async function withOutletRead(ctx, fn) {
  const client = await poolFor(ctx.outletId).connect();
  try {
    await client.query('BEGIN READ ONLY');
    await setContext(client, ctx);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* The ONE cross-outlet read in the system: aggregates only, rank 5 only,
   through a dedicated read-only role that can execute the aggregate function
   and nothing else, and stamped in the audit trail as group scope. */
let reportPool = null;
async function withEstate(ctx, fn) {
  if ((ctx.rank || 0) < 5) throw Object.assign(new Error('rank 5 required'), { status: 403 });
  if (!reportPool) {
    reportPool = guarded(new Pool(Object.assign(baseConn(), {
      user: 'kashikeyo_report',
      password: process.env.REPORT_ROLE_PASSWORD || outletPassword('report'),
      ssl, max: 2, application_name: 'kashikeyo-report'
    })), 'report');
  }
  const client = await reportPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await setContext(client, { outletId: ctx.outletId || 0, rank: 5, actor: ctx.actor, scope: 'group' });
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

/* Provisioning and migrations only. A route that needs this is a route with a
   design fault: the owner role bypasses both belts. */
async function withOwner(fn) {
  const client = await owner().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await commit(client);
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function shutdown() {
  const all = Array.from(pools.values());
  if (ownerPool) all.push(ownerPool);
  if (reportPool) all.push(reportPool);
  pools.clear(); ownerPool = null; reportPool = null;
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}

// Drop a cached pool — used after a role password rotation or a re-provision.
function forget(outletId) {
  const id = Number(outletId);
  const p = pools.get(id);
  if (p) { pools.delete(id); p.end().catch(() => {}); }
}

module.exports = { _sslConfig: sslConfig, peerCaPem,
  owner, poolFor, withOutlet, withOutletRead, withEstate, withOwner,
  setContext, commit, shutdown, forget
};
