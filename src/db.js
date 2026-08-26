'use strict';
const { Pool, Client, types } = require('pg');
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
  if (ca) {
    return {
      ca: ca, rejectUnauthorized: true,
      /* The chain is verified; the HOSTNAME deliberately is not. Node's
         default identity check also demands the connect hostname appear in
         the certificate's names — and an infra-issued self-signed cert
         (Railway's Postgres among them) does not carry the internal hostname
         the app dials, so the default check fails a connection the pin has
         already authenticated. With a private CA that signed exactly one
         server, the chain IS the identity: a man-in-the-middle would need
         that CA's private key, which never left the database. Skipping the
         hostname comparison gives up only the case where one holder of a
         cert from this CA impersonates another — and this CA signed one. */
      checkServerIdentity: function () { return undefined; }
    };
  }
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

/* ── one cluster, many databases ────────────────────────────────────────────
   A business gets its own DATABASE, not a schema: a sale moves
   chain.member.points and credit_used in the same transaction as its journal,
   and Postgres has no cross-database transaction, so everything one sale
   touches has to sit in one database. The outlets inside a business keep the
   schema-and-role belt they have always had.

   `ownerFor(db)` is the owner credential pointed at a named database. It is
   how the control registry is read, how a new business database is migrated,
   and how a business's own control plane is reached. `owner()` — no argument —
   is the connection's default database and is exactly what it always was, so
   nothing that already worked changes. */
const ownerPools = new Map();

function ownerFor(dbName) {
  const key = dbName || '';
  if (!ownerPools.has(key)) {
    /* A connection string names a database in its path, so an override has to
       replace it rather than sit beside it — pg reads `database` after the
       string, but only when the string is parsed, which it is not. */
    const cfg = process.env.DATABASE_URL && !dbName
      ? { connectionString: process.env.DATABASE_URL, ssl }
      : Object.assign(baseConn(), {
        user: process.env.PGUSER || urlUser() || 'postgres',
        password: process.env.PGPASSWORD || urlPassword() || '',
        ssl
      }, dbName ? { database: dbName } : {});
    ownerPools.set(key, guarded(new Pool(Object.assign(cfg, {
      max: 3, connectionTimeoutMillis: CHECKOUT_MS,
      application_name: 'kashikeyo-owner' + (dbName ? '-' + dbName : '')
    })), 'owner' + (dbName ? ':' + dbName : '')));
  }
  return ownerPools.get(key);
}

function owner() { return ownerFor(null); }

function urlPart(pick) {
  if (!process.env.DATABASE_URL) return '';
  try { return decodeURIComponent(pick(new URL(process.env.DATABASE_URL)) || ''); }
  catch (e) { return ''; }
}
function urlUser() { return urlPart((u) => u.username); }
function urlPassword() { return urlPart((u) => u.password); }

/* THE REGISTRY IS A DATABASE, AND IT IS NAMED, NEVER GUESSED. Falling back to
   "whatever database this connection happens to be on" would silently make a
   business database its own registry on a misconfigured deploy — the tables
   would create, the accounts would land in the wrong place, and nothing would
   say so until two customers had signed up. */
const CONTROL_DB = () => String(process.env.CONTROL_DB || '').trim();

function control() {
  const db = CONTROL_DB();
  if (!db) {
    throw Object.assign(new Error('CONTROL_DB is not set — the registry'
      + ' database has to be named, never guessed'), { status: 500 });
  }
  return ownerFor(db);
}

/* What a business's database is called. One rule, so a name is never spelled
   twice and a typo cannot point two businesses at one database. The prefix is
   configurable because a cluster may host more than one estate — two
   independent registries would otherwise both allocate from 1 and collide on
   the name, which is exactly what happens when several test suites share a
   cluster. */
function dbPrefix() {
  const p = String(process.env.BUSINESS_DB_PREFIX || '').trim();
  return p || 'kashikeyo_biz_';
}
function businessDb(id) { return dbPrefix() + Number(id); }

// ── one pool per outlet, each authenticating as that outlet's own role ───────
const pools = new Map();
/* WHICH DATABASE THIS OUTLET IS IN. Null means the connection's default, which
   is a single-database install — every install is that until its registry
   exists, and the whole test suite is that too.

   The require is deferred rather than top-level because src/business.js
   requires this module: hoisting it would be a load-time cycle. It is called
   once per transaction and the lookup behind it is cached for 30 seconds. */
async function dbFor(outletId) {
  if (!CONTROL_DB()) return null;
  const r = await require('./business').requireAtHead(outletId);
  return r.db;
}

/* THE OWNER CONNECTION FOR ONE OUTLET'S BUSINESS, which is not the same thing
   as owner(). owner() is this PROCESS's database — the one DATABASE_URL points
   at — and in a registry install that is a database nobody trades in.

   The six deliberate owner() exceptions in CLAUDE.md justify the PRIVILEGE:
   these are questions no outlet role can answer, so they need a connection
   that bypasses both isolation belts. When the tenancy boundary moved, nobody
   re-asked the other half of the question — WHICH DATABASE — and four handlers
   went on reading and writing the process's own. The lock screen returned a
   different install's outlets (in production, none, so a till could sign
   nobody in); GST registration marked the wrong company registered while the
   real one kept charging nothing; a handle rename claimed the name in the
   registry and renamed a store in a database nobody was looking at.

   Privilege and address are separate decisions. This is the address. */
async function ownerForOutlet(outletId) {
  const db = await dbFor(outletId);
  return db ? ownerFor(db) : owner();
}

/* IS THE DATABASE THIS PROCESS DIALLED ITSELF A BUSINESS? Two places need to
   know and they must not answer differently, which is why it lives here rather
   than being probed twice.

   It matters because owner() means "the database DATABASE_URL points at", and
   in a registry install that is one nobody trades in. A handler that answers
   ABOUT that database — the platform door's summary, anonymous onboarding —
   is right exactly when the database is a business and wrong, silently and
   with a 200, when it is not.

   Cached: a database does not become a business between requests, and
   re-asking on every call would put a round trip on the front door. An
   unreachable database is not cached as "no" — that is a blip, not an answer. */
let _selfIsBusiness = null;
async function selfIsBusiness() {
  if (_selfIsBusiness !== null) return _selfIsBusiness;
  try {
    const q = await owner().query("SELECT to_regclass('chain.company') IS NOT NULL AS yes");
    _selfIsBusiness = !!q.rows[0].yes;
  } catch (e) { return false; }
  return _selfIsBusiness;
}

function poolFor(outletId, dbName) {
  const id = Number(outletId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('bad outlet id'), { status: 400 });
  /* Keyed by DATABASE and outlet, not by outlet alone. Outlet ids are globally
     unique so a collision cannot happen today — but a pool is a credential
     pointed at a database, and keying it by half of what identifies it is how
     one customer's connection ends up serving another's request. */
  const key = (dbName || '') + '#' + id;
  if (!pools.has(key)) {
    pools.set(key, guarded(new Pool(Object.assign(baseConn(), dbName ? { database: dbName } : {}, {
      user: 'outlet_' + id + '_app',
      password: outletPassword(id),
      ssl,
      /* One connection is held for the whole of a request's transaction, and a
         sync push can carry a hundred ops — so the ceiling on concurrent
         requests to one outlet IS this number. Six was low enough that a rush
         across five or six terminals could reach it; twelve costs one idle
         backend each at worst, against a Postgres that allows a hundred, and
         one install serves one customer. Past it, checkout() now refuses
         quickly and retryably rather than queueing for ever. */
      max: Number(process.env.PGPOOL_MAX || 12),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: CHECKOUT_MS,
      statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT || 15000),
      application_name: 'kashikeyo-outlet-' + id
    })), 'outlet-' + id));
  }
  return pools.get(key);
}

/* CAN THIS OUTLET STILL OPEN A SESSION AT ALL?

   Everything else here runs on a POOL, and a pool authenticates once. Revoke
   the role's CONNECT, drop the role, rotate OUTLET_ROLE_SECRET — and every
   query keeps working through the connection that is already open, for as long
   as the pool keeps it. /readyz probed through that pool and answered 200 while
   a fresh connection was refused; measured, on a live outlet, by revoking
   CONNECT and watching the endpoint stay green for three minutes. The probe was
   proving the GRANTS and calling it the credential.

   So readiness opens one connection of its own, outside the pool, and closes
   it. That is the half a warm pool can never test. It costs one connect per
   outlet per probe, and the probe caches a good answer for ten seconds, so the
   ceiling is one connect per outlet per ten seconds. */
async function canConnect(outletId, dbName) {
  const id = Number(outletId);
  const c = new Client(Object.assign(baseConn(), dbName ? { database: dbName } : {}, {
    user: 'outlet_' + id + '_app',
    password: outletPassword(id),
    ssl,
    connectionTimeoutMillis: CHECKOUT_MS,
    application_name: 'kashikeyo-readyz-' + id
  }));
  try {
    await c.connect();
    await c.query('SELECT 1');
  } finally { await c.end().catch(() => {}); }
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
/* WAITING FOR A CONNECTION IS NOT THE SAME AS RUNNING A SLOW QUERY.
   `statement_timeout` bounds the query; nothing bounded the QUEUE. With more
   transactions in flight than the pool holds, the next connect() waited for
   ever — and the till's five-second retry piled on more waiters. It was the
   first thing to fail under a burst, and it failed by HANGING, which is the
   one failure a busy counter cannot see or act on.

   Now the wait is bounded and the answer is a fast 503. That is safe by
   construction on the sync path: a whole-request failure is a dead link as far
   as the outbox is concerned, so nothing counts toward the dead-letter lane and
   nothing is parked — the ops simply go again when the rush passes. */
const CHECKOUT_MS = Number(process.env.PGCHECKOUT_TIMEOUT || 8000);

async function checkout(pool) {
  try {
    return await pool.connect();
  } catch (e) {
    if (/timeout exceeded when trying to connect/i.test(e.message || '')) {
      throw Object.assign(new Error('the outlet is busy — send it again in a moment'),
        { status: 503, retryable: true });
    }
    throw e;
  }
}

async function commit(client) {
  const q = await client.query('COMMIT');
  if (q && q.command === 'ROLLBACK') {
    throw Object.assign(
      new Error('transaction was aborted by an earlier error and did not commit'),
      { status: 500, aborted: true });
  }
}

async function withOutlet(ctx, fn) {
  const client = await checkout(poolFor(ctx.outletId, await dbFor(ctx.outletId)));
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
  const client = await checkout(poolFor(ctx.outletId, await dbFor(ctx.outletId)));
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
      ssl, max: 2, connectionTimeoutMillis: CHECKOUT_MS,
      application_name: 'kashikeyo-report'
    })), 'report');
  }
  const client = await checkout(reportPool);
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
  const client = await checkout(owner());
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
  // Every owner pool, not just the default one: a fleet migration opens one
  // per business database, and a pool nobody ends holds its backends open
  // until Postgres times them out.
  const all = Array.from(pools.values()).concat(Array.from(ownerPools.values()));
  if (reportPool) all.push(reportPool);
  pools.clear(); ownerPools.clear(); reportPool = null;
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}

// Drop a cached pool — used after a role password rotation or a re-provision.
/* Pools are keyed by database AND outlet, so forgetting one outlet means
   forgetting it wherever it is cached — a re-provision changes the password
   and a stale pool would keep presenting the old one. */
function forget(outletId) {
  const id = Number(outletId);
  const suffix = '#' + id;
  Array.from(pools.keys()).filter((k) => k.endsWith(suffix)).forEach((k) => {
    const p = pools.get(k);
    pools.delete(k);
    if (p) p.end().catch(() => {});
  });
  if (CONTROL_DB()) require('./business').forgetRoute(id);
}

module.exports = { _sslConfig: sslConfig, peerCaPem, _checkout: checkout,
  owner, ownerFor, ownerForOutlet, dbFor, control, businessDb, dbPrefix, CONTROL_DB,
  selfIsBusiness,
  poolFor, canConnect, withOutlet, withOutletRead, withEstate, withOwner,
  setContext, commit, shutdown, forget
};
