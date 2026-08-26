'use strict';
/* ═══ TAKING A COPY, AND PUTTING IT BACK ════════════════════════════════════
   One seam, two drivers, the same shape src/email.js already has: the caller
   asks for a backup and does not know where it lands; swapping the
   destination is this file and nothing else.

   WHAT THIS REPLACES. Until now the app took no backups at all. `backup_run`,
   `backup_create` and `restore_run` were audit-only ops that recorded the
   press and did nothing, and the Settings cards said so out loud after an
   earlier pass found them claiming otherwise. The platform's own volume
   snapshot is still the right thing for the CLUSTER — but it is all-or-
   nothing, and this product's boundary is the BUSINESS. Restoring one
   customer from a volume snapshot means restoring every customer, which is
   not a thing anybody can do at 2 a.m. to fix one shop. So: a logical dump
   per business, plus the registry, each restorable on its own.

   WHY pg_dump AND NOT SOMETHING WRITTEN HERE. A dump has to survive every
   column type, every extension, every default and every constraint this
   schema has or will have. Re-deriving that from the catalogs would be a
   second implementation of the one tool whose correctness the whole thing
   rests on, and it would drift silently the first time a migration adds a
   type it does not know. A backup that is subtly wrong is worse than none,
   because it is trusted.

   The cost is a binary that has to be in the image and has to be AT LEAST AS
   NEW AS THE SERVER — pg_dump refuses a server newer than itself. That is not
   assumed anywhere here: tools() finds it, reads its version, compares it to
   the server's, and refuses BY NAME with the remedy. An install whose image
   lacks it is told so on the Backup card rather than being handed a green
   tick over nothing.
   ═══════════════════════════════════════════════════════════════════════ */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { control, ownerFor, owner, businessDb } = require('./db');

/* ── where a copy goes ──────────────────────────────────────────────────────
   `file` writes to a directory this process can reach. `s3` PUTs to any
   S3-compatible bucket, signed here with node's own crypto — the two-runtime-
   dependency rule holds, and SigV4 is a hash, a few string joins and an HMAC
   chain. Unset, there is NO destination, and that is reported rather than
   papered over: a dump written to a container's ephemeral disk and lost on the
   next deploy is not a backup, it is a rehearsal. */
const DIR = () => String(process.env.BACKUP_DIR || '').trim();
const BUCKET = () => String(process.env.BACKUP_S3_BUCKET || '').trim();

/* The same trap src/email.js names: on Railway a variable may be written as a
   reference to another service, and a wrong service name leaves the LITERAL
   `${{...}}` in place — non-empty, truthy, and impossible to use. Imported
   rather than re-spelled, because two definitions of "this is a dangling
   reference" would eventually disagree. */
const { unresolved } = require('./email');

const s3cfg = () => ({
  bucket: BUCKET(),
  region: String(process.env.BACKUP_S3_REGION || 'us-east-1').trim(),
  endpoint: String(process.env.BACKUP_S3_ENDPOINT || '').trim(),
  key: String(process.env.BACKUP_S3_KEY || '').trim(),
  secret: String(process.env.BACKUP_S3_SECRET || '').trim(),
  prefix: String(process.env.BACKUP_S3_PREFIX || 'kashikeyo').trim()
    .replace(/^\/+|\/+$/g, '')
});

function driver() {
  const s = s3cfg();
  if (s.bucket && !unresolved(s.bucket)) {
    if (!s.key || !s.secret || unresolved(s.key) || unresolved(s.secret)) {
      return { name: null, why: 'BACKUP_S3_BUCKET is set but BACKUP_S3_KEY /'
        + ' BACKUP_S3_SECRET are missing or unresolved — a bucket nothing can'
        + ' sign for is not a destination' };
    }
    return { name: 's3', where: 's3://' + s.bucket + '/' + s.prefix };
  }
  if (DIR() && !unresolved(DIR())) return { name: 'file', where: DIR() };
  return { name: null, why: 'no backup destination is configured on this'
    + ' install — set BACKUP_DIR, or BACKUP_S3_BUCKET with its key and secret' };
}

/* ── the tool, found rather than assumed ────────────────────────────────────
   Cached because it cannot change under a running process, and because the
   Backup card asks on every render. */
let TOOLS = null;

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {})); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e) }); }
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out: out, err: String(e.message || e) }));
    p.on('close', (code) => resolve({ code: code, out: out, err: err }));
  });
}

const majorOf = (s) => {
  const m = /(\d+)/.exec(String(s || ''));
  return m ? Number(m[1]) : 0;
};

async function tools(force) {
  if (TOOLS && !force) return TOOLS;
  const bin = String(process.env.PG_BIN_DIR || '').trim();
  const at = (n) => (bin ? path.join(bin, n) : n);
  const d = await run(at('pg_dump'), ['--version']);
  const r = await run(at('pg_restore'), ['--version']);
  if (d.code !== 0 || r.code !== 0) {
    TOOLS = { ok: false, why: 'pg_dump and pg_restore are not on this image —'
      + ' add the Postgres client tools to the Dockerfile (apk add'
      + ' postgresql-client) or point PG_BIN_DIR at them'
      + (d.err ? ' · ' + d.err.trim().split('\n')[0] : '') };
    return TOOLS;
  }
  TOOLS = { ok: true, pgDump: at('pg_dump'), pgRestore: at('pg_restore'),
    version: d.out.trim(), major: majorOf(d.out.replace(/^\D+/, '')) };
  return TOOLS;
}

/* THE CLIENT MUST NOT BE OLDER THAN THE SERVER. pg_dump refuses outright, and
   the message it gives ("server version 18.0; pg_dump version 17.4") is
   perfectly clear once you see it — but it arrives at 2 a.m. in a cron log
   nobody reads. Asked up front, once, so the Backup card can say it while
   somebody is looking. */
async function toolFit() {
  const t = await tools();
  if (!t.ok) return t;
  let server = 0;
  try {
    const q = await owner().query('SHOW server_version_num');
    server = Math.floor(Number(q.rows[0].server_version_num) / 10000);
  } catch (e) { /* the database's own reachability is /readyz's question */ }
  if (server && t.major && t.major < server) {
    return { ok: false, why: 'pg_dump is version ' + t.major + ' and the server'
      + ' is ' + server + ' — pg_dump refuses a server newer than itself, so'
      + ' this install can take no backup until the image carries a client of'
      + ' at least ' + server, major: t.major, server: server };
  }
  return Object.assign({}, t, { server: server });
}

/* ── what the screens and the watchdog ask ─────────────────────────────────
   One answer, the same shape email.health() gives: whether it is configured,
   where to, and — when it is not — the sentence that says what to do. */
async function health() {
  const d = driver();
  const t = await toolFit();
  const okBoth = !!d.name && t.ok;
  let last = null, lastGood = null, fails = 0;
  if (okBoth || d.name) {
    try {
      const q = await control().query(
        'SELECT started_at, finished_at, ok, bytes, location, db_name, why'
        + ' FROM chain.backup ORDER BY started_at DESC LIMIT 20');
      last = q.rows[0] || null;
      lastGood = q.rows.find((r) => r.ok) || null;
      fails = q.rows.filter((r) => !r.ok).length;
    } catch (e) { /* a registry that cannot be read is /readyz's question */ }
  }
  return {
    configured: okBoth,
    driver: d.name, where: d.name ? d.where : null,
    tool: t.ok ? t.version : null,
    reason: d.name ? (t.ok ? null : t.why) : d.why,
    last: last, lastGood: lastGood, recentFailures: fails
  };
}

/* ── the connection pg_dump is given ───────────────────────────────────────
   Built from the same environment src/db.js reads, so there is one answer to
   "which cluster is this" and a backup can never quietly dump somewhere else.
   The password goes in the ENVIRONMENT, never on the command line: an argv is
   world-readable in /proc on every process table on the box. */
function connEnv(dbName) {
  const env = Object.assign({}, process.env);
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    env.PGHOST = u.hostname;
    env.PGPORT = String(u.port || 5432);
    if (u.username) env.PGUSER = decodeURIComponent(u.username);
    if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  }
  env.PGDATABASE = dbName;
  // pg_dump has no PGSSL_CA; it reads the same file libpq always has.
  if (process.env.PGSSLROOTCERT) env.PGSSLROOTCERT = process.env.PGSSLROOTCERT;
  if (process.env.PGSSL_CA && !process.env.PGSSLROOTCERT) {
    // Written once per process, not per run: a CA is not a secret, and a
    // temp file per nightly backup is a temp file per nightly backup for ever.
    const p = path.join(os.tmpdir(), 'kashikeyo-pg-ca.pem');
    try {
      if (!fs.existsSync(p)) fs.writeFileSync(p, process.env.PGSSL_CA, { mode: 0o600 });
      env.PGSSLROOTCERT = p;
    } catch (e) { /* fall through: the dump still runs, unpinned */ }
  }
  if (/^(1|true|require|verify)$/i.test(String(process.env.PGSSL || ''))
    || (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL)) {
    env.PGSSLMODE = env.PGSSLROOTCERT ? 'verify-ca' : 'require';
  }
  return env;
}

/* ── dump one database to a local file, hashing as it goes ─────────────────
   To disk first, then to the destination. The alternative — piping pg_dump
   straight into an upload — holds the whole archive in memory or leaves a
   half-written object when the dump fails on its last table, and neither is
   something to discover during a restore. The temp file is bounded by disk,
   deleted in a finally, and the hash is computed from the bytes that were
   actually written rather than from the ones that were meant to be. */
async function dumpToFile(dbName, dest) {
  const t = await toolFit();
  if (!t.ok) throw Object.assign(new Error(t.why), { status: 503 });
  return new Promise((resolve, reject) => {
    // -Fc: the custom format. Compressed, and the only one pg_restore can
    // read selectively — which is what makes "restore just this table" and
    // "list what is in here" possible at all.
    const p = spawn(t.pgDump, ['-Fc', '--no-owner', '--no-privileges', '-f', dest, dbName],
      { env: connEnv(dbName), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error('pg_dump could not start: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('pg_dump exited ' + code
          + (err ? ': ' + err.trim().split('\n').slice(-3).join(' · ') : '')));
      }
      let bytes = 0;
      try { bytes = fs.statSync(dest).size; } catch (e) {}
      if (!bytes) return reject(new Error('pg_dump wrote nothing'));
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(dest);
      rs.on('data', (d) => h.update(d));
      rs.on('error', reject);
      rs.on('end', () => resolve({ bytes: bytes, sha256: h.digest('hex'),
        tool: t.version }));
    });
  });
}

/* ── AWS Signature V4, with node's own crypto ──────────────────────────────
   Every S3-compatible store speaks this, so one signer reaches AWS, Cloudflare
   R2, Backblaze B2, MinIO and Railway's own buckets without a dependency. It
   is a canonical request, a string to sign, and a four-step HMAC chain, and
   it is exported so the tests can hold it against AWS's own published test
   vectors — the only way to verify a signer without a bucket to fail against. */
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

function signV4(o) {
  const stamp = o.amzDate;                       // YYYYMMDDTHHMMSSZ
  const day = stamp.slice(0, 8);
  const scope = day + '/' + o.region + '/' + o.service + '/aws4_request';
  const names = Object.keys(o.headers).map((k) => k.toLowerCase()).sort();
  const canonHeaders = names
    .map((k) => k + ':' + String(o.headers[Object.keys(o.headers)
      .find((h) => h.toLowerCase() === k)]).trim() + '\n').join('');
  const signed = names.join(';');
  const canonical = [o.method, o.path, o.query || '', canonHeaders, signed,
    o.payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac('AWS4' + o.secret, day);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, o.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    signature: signature,
    authorization: 'AWS4-HMAC-SHA256 Credential=' + o.key + '/' + scope
      + ', SignedHeaders=' + signed + ', Signature=' + signature,
    canonical: canonical, toSign: toSign
  };
}

function s3Url(cfg, key) {
  if (cfg.endpoint) {
    const base = cfg.endpoint.replace(/\/+$/, '');
    return new URL(base + '/' + cfg.bucket + '/' + key);
  }
  return new URL('https://' + cfg.bucket + '.s3.' + cfg.region
    + '.amazonaws.com/' + key);
}

async function s3Put(cfg, key, file, bytes) {
  const url = s3Url(cfg, key);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  /* UNSIGNED-PAYLOAD rather than a hash of the body: signing the payload would
     mean reading the whole archive to sign it and again to send it. The link
     is TLS and the object's own sha256 is on the manifest, which is what a
     restore checks against. */
  const headers = {
    host: url.host,
    'content-length': String(bytes),
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': amzDate
  };
  const sig = signV4({ method: 'PUT', path: url.pathname, query: '',
    headers: headers, payloadHash: 'UNSIGNED-PAYLOAD', region: cfg.region,
    service: 's3', key: cfg.key, secret: cfg.secret, amzDate: amzDate });
  const res = await fetch(url, {
    method: 'PUT',
    headers: Object.assign({}, headers, { authorization: sig.authorization }),
    body: fs.createReadStream(file),
    duplex: 'half'
  });
  if (!res.ok) {
    throw new Error('the object store refused the upload (HTTP ' + res.status
      + ') ' + (await res.text().catch(() => '')).slice(0, 300));
  }
  return url.toString();
}

async function s3Get(cfg, key, dest) {
  const url = s3Url(cfg, key);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const headers = { host: url.host, 'x-amz-content-sha256': sha256hex(''),
    'x-amz-date': amzDate };
  const sig = signV4({ method: 'GET', path: url.pathname, query: '',
    headers: headers, payloadHash: sha256hex(''), region: cfg.region,
    service: 's3', key: cfg.key, secret: cfg.secret, amzDate: amzDate });
  const res = await fetch(url, { headers: Object.assign({}, headers,
    { authorization: sig.authorization }) });
  if (!res.ok) throw new Error('the object store refused the read (HTTP ' + res.status + ')');
  await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/* ── put the local file where it was configured to go ──────────────────────*/
async function store(local, name, bytes) {
  const d = driver();
  if (d.name === 'file') {
    await fs.promises.mkdir(DIR(), { recursive: true });
    const dest = path.join(DIR(), name);
    await fs.promises.copyFile(local, dest);
    return { driver: 'file', location: 'file:' + dest };
  }
  if (d.name === 's3') {
    const cfg = s3cfg();
    const key = (cfg.prefix ? cfg.prefix + '/' : '') + name;
    const url = await s3Put(cfg, key, local, bytes);
    return { driver: 's3', location: 's3://' + cfg.bucket + '/' + key, url: url };
  }
  throw Object.assign(new Error(d.why), { status: 503 });
}

async function fetchArchive(row, dest) {
  const loc = String(row.location || '');
  if (loc.startsWith('file:')) {
    await fs.promises.copyFile(loc.slice(5), dest);
    return dest;
  }
  if (loc.startsWith('s3://')) {
    const cfg = s3cfg();
    if (!cfg.key || !cfg.secret) {
      throw new Error('this archive is in an object store and no credentials'
        + ' are configured to read it back');
    }
    const key = loc.slice(5 + cfg.bucket.length + 1);
    return s3Get(cfg, key, dest);
  }
  throw new Error('this archive has no location on record: ' + loc);
}

/* ── one database, start to finish ─────────────────────────────────────────
   The row is written BEFORE the work, like src/business.js and
   panel/railway.js: a process that dies mid-dump leaves a row saying it
   started and never finished, which is the state somebody needs to see. A
   shelf holding only the runs that succeeded is a shelf that lies by
   omission. */
async function backupOne(opts) {
  const o = opts || {};
  const dbName = String(o.db);
  const started = await control().query(
    'INSERT INTO chain.backup (business_id, db_name, driver, by_whom)'
    + ' VALUES ($1,$2,$3,$4) RETURNING id',
    [o.businessId || null, dbName, driver().name, o.by || 'schedule']);
  const id = started.rows[0].id;

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const name = dbName + '-' + stamp + '.dump';
  const tmp = path.join(os.tmpdir(), 'kashikeyo-' + id + '.dump');
  try {
    const d = await dumpToFile(dbName, tmp);
    const put = await store(tmp, name, d.bytes);
    let version = null;
    try {
      const v = await ownerFor(dbName).query(
        'SELECT count(*)::int AS n FROM chain.migration');
      version = Number(v.rows[0].n);
    } catch (e) { /* the registry's own count is read the same way */ }
    await control().query(
      'UPDATE chain.backup SET finished_at = now(), ok = true, location = $2,'
      + ' driver = $3, bytes = $4, sha256 = $5, schema_version = $6,'
      + ' tool_version = $7 WHERE id = $1',
      [id, put.location, put.driver, d.bytes, d.sha256, version, d.tool]);
    return { id: id, db: dbName, ok: true, bytes: d.bytes, sha256: d.sha256,
      location: put.location, schemaVersion: version };
  } catch (e) {
    await control().query(
      'UPDATE chain.backup SET finished_at = now(), ok = false, why = $2'
      + ' WHERE id = $1', [id, String(e.message || e)]).catch(() => {});
    return { id: id, db: dbName, ok: false, why: String(e.message || e) };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/* ── the whole fleet, registry first ───────────────────────────────────────
   The registry first because it is the routing table: a set of restored
   business databases nothing can find is not a restore. Serially, not in
   parallel: this is a background job competing with shops that are trading,
   and pg_dump is heavy on the same cluster. */
async function backupAll(opts) {
  const o = opts || {};
  const say = o.log || (() => {});
  const d = driver();
  if (!d.name) return { ok: false, why: d.why, runs: [] };
  const t = await toolFit();
  if (!t.ok) return { ok: false, why: t.why, runs: [] };

  const runs = [];
  const reg = require('./db').CONTROL_DB();
  say('[backup] ' + reg + ' (registry)');
  runs.push(await backupOne({ db: reg, businessId: null, by: o.by }));

  const q = await control().query(
    "SELECT id, db_name FROM chain.business WHERE status = 'live' ORDER BY id");
  for (const b of q.rows) {
    say('[backup] ' + b.db_name);
    runs.push(await backupOne({ db: b.db_name, businessId: Number(b.id), by: o.by }));
  }
  const bad = runs.filter((r) => !r.ok);
  runs.forEach((r) => say('[backup] ' + r.db + (r.ok
    ? '  ' + (r.bytes / 1024 / 1024).toFixed(1) + ' MB  ' + r.location
    : '  FAILED  ' + r.why)));
  return { ok: !bad.length, runs: runs, failed: bad };
}

/* ── retention ─────────────────────────────────────────────────────────────
   Old archives are removed by the same run that makes new ones, because a
   retention policy nothing enforces is a bill that grows for ever. The MOST
   RECENT GOOD archive of a database is never deleted whatever its age: a
   business nobody has touched for a year still needs its last copy. */
async function prune(days, log) {
  const say = log || (() => {});
  const keep = Number(days || process.env.BACKUP_RETAIN_DAYS || 30);
  if (!(keep > 0)) return { removed: 0, kept: 'retention disabled' };
  const q = await control().query(
    'SELECT id, db_name, location, ok, started_at FROM chain.backup'
    + ' WHERE started_at < now() - ($1 || \' days\')::interval'
    + ' ORDER BY started_at DESC', [String(keep)]);
  // The newest good one per database, whatever its age.
  const newest = await control().query(
    'SELECT DISTINCT ON (db_name) id FROM chain.backup WHERE ok'
    + ' ORDER BY db_name, started_at DESC');
  const spared = new Set(newest.rows.map((r) => String(r.id)));
  let removed = 0;
  for (const r of q.rows) {
    if (spared.has(String(r.id))) continue;
    const loc = String(r.location || '');
    try {
      if (loc.startsWith('file:')) await fs.promises.unlink(loc.slice(5)).catch(() => {});
      // An object store's own lifecycle rule is the right tool for s3, and
      // deleting there needs a signed DELETE this does not yet make. The row
      // says so rather than pretending the object is gone.
      if (loc.startsWith('s3://')) {
        await control().query('UPDATE chain.backup SET why = $2 WHERE id = $1',
          [r.id, 'past retention — the object is the bucket\'s lifecycle rule to remove']);
        continue;
      }
      await control().query('DELETE FROM chain.backup WHERE id = $1', [r.id]);
      removed++;
    } catch (e) { say('[backup] could not prune ' + r.id + ': ' + e.message); }
  }
  if (removed) say('[backup] pruned ' + removed + ' archive(s) older than ' + keep + ' days');
  return { removed: removed, keep: keep };
}

async function list(limit) {
  const q = await control().query(
    'SELECT b.*, z.name AS business FROM chain.backup b'
    + ' LEFT JOIN chain.business z ON z.id = b.business_id'
    + ' ORDER BY b.started_at DESC LIMIT $1', [Number(limit || 25)]);
  return q.rows;
}

/* ═══ PUTTING IT BACK ═══════════════════════════════════════════════════════
   BESIDE BY DEFAULT, NEVER OVER BY ACCIDENT. A restore into the live database
   destroys everything rung since the archive was taken, and it is the single
   most destructive act this system can perform. So the default target is a NEW
   database — the live one keeps trading while somebody checks the restored
   copy has what they think it has — and the swap is a separate, deliberate
   step. Restoring OVER a live business needs the database named in full and
   `over: true`, which is the same shape as the typed confirmations the till
   asks for before a void.

   AND THE ROLES DO NOT COME IN THE DUMP. This is the finding the restore drill
   in DEPLOYMENT.md produced, and it is the one that makes an otherwise perfect
   restore useless: pg_dump of one database carries no cluster-wide roles, so
   into a fresh cluster `pg_restore` drops every GRANT on the floor and the
   install answers /readyz 200 while every outlet request fails with
   `role "outlet_1_app" does not exist`. The archive is written --no-owner
   --no-privileges precisely so the restore does not depend on them, and the
   grants are re-applied afterwards by the same function that made them —
   which is also what makes the restored copy reachable at all. */

function safeNewDb(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(String(name || ''))) {
    throw Object.assign(new Error('refusing a database name that is not a bare'
      + ' lower-case identifier: ' + name), { status: 400 });
  }
  return name;
}

async function reprovision(dbName, log) {
  const say = log || (() => {});
  const { outletPassword } = require('./secrets');
  const pool = ownerFor(dbName);
  let rows = [];
  try {
    const q = await pool.query('SELECT id, code, name FROM chain.outlet ORDER BY id');
    rows = q.rows;
  } catch (e) {
    // The registry has no chain.outlet, and that is not a fault: it is not a
    // business. Say which of the two this was rather than reporting a failure.
    say('[restore] ' + dbName + ' has no outlets to re-provision'
      + ' (' + e.message.split('\n')[0] + ')');
    return { outlets: 0 };
  }
  for (const o of rows) {
    await pool.query('SELECT chain.provision_outlet($1,$2,$3,$4)',
      [o.id, o.code, o.name, outletPassword(o.id)]);
    say('[restore] ' + dbName + ' · outlet_' + o.id + ' (' + o.code
      + ') — role and grants re-applied');
  }
  return { outlets: rows.length };
}

async function restore(opts) {
  const o = opts || {};
  const say = o.log || (() => {});
  const t = await toolFit();
  if (!t.ok) throw Object.assign(new Error(t.why), { status: 503 });

  // Which archive. By id, or the newest good one for a named database.
  let row = null;
  if (o.backupId) {
    const q = await control().query('SELECT * FROM chain.backup WHERE id = $1',
      [o.backupId]);
    row = q.rows[0];
    if (!row) throw Object.assign(new Error('no archive ' + o.backupId), { status: 404 });
  } else if (o.db) {
    const q = await control().query('SELECT * FROM chain.backup WHERE db_name = $1'
      + ' AND ok ORDER BY started_at DESC LIMIT 1', [o.db]);
    row = q.rows[0];
    if (!row) {
      throw Object.assign(new Error('no successful archive on record for '
        + o.db + ' — `npm run backup -- --list` shows what there is'), { status: 404 });
    }
  } else {
    throw Object.assign(new Error('name an archive: --id <uuid> or --db <name>'),
      { status: 400 });
  }
  if (!row.ok) {
    throw Object.assign(new Error('that archive is on record as having FAILED ('
      + (row.why || 'no reason recorded') + ') — it is not something to restore'
      + ' from'), { status: 409 });
  }

  const target = safeNewDb(o.into
    || (row.db_name + '_restored_' + new Date().toISOString()
      .replace(/[-:]/g, '').replace(/\..*/, '').toLowerCase()));

  /* OVER A LIVE DATABASE IS A DIFFERENT DECISION and is refused unless it was
     asked for by name. Restoring into the database a shop is trading on right
     now discards every bill rung since the archive; nothing about a default
     should be able to do that. */
  const exists = await owner().query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [target]);
  if (exists.rows.length && !o.over) {
    throw Object.assign(new Error('database "' + target + '" already exists.'
      + ' Restoring into it would discard everything in it. Pass --over to'
      + ' mean that, or leave --into off and this restores beside it into a'
      + ' new database.'), { status: 409 });
  }

  const tmp = path.join(os.tmpdir(), 'kashikeyo-restore-' + row.id + '.dump');
  try {
    say('[restore] reading ' + row.location);
    await fetchArchive(row, tmp);

    /* THE ARCHIVE IS CHECKED BEFORE IT IS TRUSTED. A truncated upload restores
       most of a database and reports success on the part that arrived, which
       is the worst possible failure here: the shape looks right and the tail
       of the trading history is missing. The manifest carries what was
       written; this is what was read back. */
    const h = crypto.createHash('sha256');
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(tmp);
      rs.on('data', (d) => h.update(d));
      rs.on('error', rej); rs.on('end', res);
    });
    const got = h.digest('hex');
    if (row.sha256 && got !== row.sha256) {
      throw new Error('this archive does not match what was written'
        + ' (recorded ' + row.sha256.slice(0, 12) + '…, read ' + got.slice(0, 12)
        + '…) — it is damaged or truncated and must not be restored from');
    }
    say('[restore] archive verified · ' + (Number(row.bytes) / 1024 / 1024).toFixed(1) + ' MB');

    if (!exists.rows.length) {
      await owner().query('CREATE DATABASE ' + target);
      say('[restore] created ' + target);
    } else {
      say('[restore] restoring OVER the existing ' + target);
    }

    const r = await run(t.pgRestore,
      ['--no-owner', '--no-privileges', '--clean', '--if-exists',
        '-d', target, tmp],
      { env: connEnv(target) });
    /* pg_restore exits non-zero on warnings it recovered from as readily as on
       real failures, which is why the drill's own run "exited 1" while having
       restored every row. The rule here: a non-zero exit is reported in full
       and the caller is told to read it, but what decides success is whether
       the data is THERE — checked by the caller, and by the test, against the
       figures it expects. Nothing here reports a clean restore it did not
       verify. */
    if (r.code !== 0) {
      say('[restore] pg_restore exited ' + r.code + ' — read this before'
        + ' trusting the copy:');
      String(r.err || '').trim().split('\n').slice(0, 12).forEach((l) => say('    ' + l));
    }

    const rp = await reprovision(target, say);

    let sales = null;
    try {
      const q = await ownerFor(target).query(
        'SELECT count(*)::int AS n FROM chain.outlet');
      sales = Number(q.rows[0].n);
    } catch (e) { /* the registry has none, and says so above */ }

    return { ok: true, into: target, from: row.id, location: row.location,
      bytes: Number(row.bytes), schemaVersion: row.schema_version,
      outlets: rp.outlets, pgRestoreExit: r.code,
      pgRestoreStderr: r.code === 0 ? '' : String(r.err || '').trim() };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/* ── and the swap, which is its own decision ───────────────────────────────
   A restore beside the live database changes nothing a customer can see: the
   registry still routes every request to the original. Pointing the business
   at the restored copy is the act that takes the old one out of service, so
   it is separate, explicit, and it renames rather than drops — the database
   that was live an instant ago is the only copy of anything rung since the
   archive, and destroying it as part of a recovery is how a bad afternoon
   becomes an unrecoverable one. */
async function adopt(businessId, dbName, log) {
  const say = log || (() => {});
  const b = await control().query(
    'SELECT id, name, db_name FROM chain.business WHERE id = $1', [businessId]);
  if (!b.rows.length) throw Object.assign(new Error('no business ' + businessId), { status: 404 });
  const was = b.rows[0].db_name;
  safeNewDb(dbName);
  const there = await owner().query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!there.rows.length) {
    throw Object.assign(new Error('there is no database "' + dbName + '" to'
      + ' point at'), { status: 404 });
  }
  let version = null;
  try {
    const v = await ownerFor(dbName).query('SELECT count(*)::int AS n FROM chain.migration');
    version = Number(v.rows[0].n);
  } catch (e) {
    throw Object.assign(new Error('"' + dbName + '" does not look like a'
      + ' business database (' + e.message.split('\n')[0] + ')'), { status: 409 });
  }
  await control().query(
    'UPDATE chain.business SET db_name = $2, schema_version = $3 WHERE id = $1',
    [businessId, dbName, version]);
  await control().query(
    'INSERT INTO chain.audit (action, entity, entity_id, after)'
    + ' VALUES ($1,$2,$3,$4)',
    ['business_db_swapped', 'business', String(businessId),
      JSON.stringify({ was: was, now: dbName, schemaVersion: version })]);
  /* Every route to this business is now stale — routeFor() caches db_name for
     30s and the next request would open the database this swap just retired. */
  require('./business').forgetRoute(null);
  say('[restore] business ' + businessId + ' (' + b.rows[0].name + ') now reads '
    + dbName + ' at schema ' + version + '; "' + was + '" is still on the cluster'
    + ' and is the only copy of anything rung since the archive');
  return { businessId: businessId, was: was, now: dbName, schemaVersion: version };
}

module.exports = {
  tools, toolFit, health, driver, backupOne, backupAll, prune, list,
  fetchArchive, dumpToFile, connEnv, run,
  restore, adopt, reprovision,
  // exported for the test that holds it against AWS's published vectors
  _signV4: signV4, _sha256hex: sha256hex, _s3Url: s3Url
};
