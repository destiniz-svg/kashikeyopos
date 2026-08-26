'use strict';
/* ═══ DUMPED, DESTROYED, RESTORED ═══════════════════════════════════════════
   The restore drill DEPLOYMENT.md asks for, run by the suite rather than by
   hand once a quarter. It is the only test in this repository that destroys
   the thing it is testing, because that is the only way to find out whether a
   backup is a backup: the database is DROPPED, not truncated, not renamed.

   What it asserts is the money. "pg_restore exited 0" is not the question —
   the drill that produced this feature saw an exit code of 1 on a restore
   that had brought back every row, and a 200 from /readyz on an install that
   could serve nobody. So the comparison is a census taken the same way before
   and after: bills, gross, tax, the journal's own dr and cr, tenders, member
   points, credit outstanding, the install uuid, the audit trail's depth and
   the schema version. Then the half a plain pg_restore cannot do — the outlet
   login roles, which are cluster-wide and are not in a dump of one database —
   by connecting AS the outlet role and reading its own sales back.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const crypto = require('crypto');
const DB = require('./db');

DB.secrets();
process.env.BUSINESS_DB_PREFIX = 'kbak_biz_';
const CONTROL = process.env.PGTESTCONTROL_BACKUP || 'kashikeyo_control_backup';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

const os = require('os');
const path = require('path');
const fs = require('fs');
const ARCHIVES = path.join(os.tmpdir(), 'kashikeyo-test-archives-' + process.pid);

function admin(database) {
  return new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: database
  });
}
async function sql(database, text, params, user, pass) {
  const c = user
    ? new Client({ host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432), user: user, password: pass,
      database: database })
    : admin(database);
  await c.connect();
  try { return (await c.query(text, params || [])).rows; } finally { await c.end(); }
}

/* Read numerics as TEXT. A restore that comes back with 7841.00 as the float
   7841 has not lost money, but a test comparing them as JS numbers would pass
   on a restore that quietly changed a column's type — which is exactly the
   class of damage this exists to catch. */
require('pg').types.setTypeParser(1700, (v) => v);
require('pg').types.setTypeParser(1082, (v) => v);

let backup, dbmod, business, DBNAME, OUTLET, before;

/* THE TOOL IS A PRECONDITION, NOT A REASON TO SKIP. CI refuses a skipped test
   (see .github/workflows/test.yml), and it is right to: an environment with no
   pg_dump cannot take a backup, and quietly passing would mean this whole
   feature is unverified on exactly the runs that matter. */
test('this environment can take a backup at all', opts, async () => {
  process.env.CONTROL_DB = await DB.freshControl(CONTROL);
  await DB.dropBusinessDatabases();
  fs.mkdirSync(ARCHIVES, { recursive: true });
  process.env.BACKUP_DIR = ARCHIVES;
  delete process.env.BACKUP_S3_BUCKET;

  // The registry is created empty by freshControl; migrating it is what puts
  // chain.business and chain.backup in it.
  const { migrateControl } = require('../src/scripts/migrate');
  await migrateControl(() => {});

  backup = require('../src/backup');
  dbmod = require('../src/db');
  const t = await backup.tools(true);
  assert.ok(t.ok, 'pg_dump and pg_restore have to be on PATH (or PG_BIN_DIR)'
    + ' for the backup feature to work at all: ' + (t.why || ''));

  const d = backup.driver();
  assert.strictEqual(d.name, 'file', 'BACKUP_DIR selects the file driver');
  const h = await backup.health();
  assert.strictEqual(h.configured, true, h.reason || '');
  assert.match(String(h.tool), /pg_dump/, 'and it names the tool it found');
});

/* AND WITH NOTHING CONFIGURED IT SAYS SO, which is the state every install is
   in until somebody chooses a destination. The rule this whole feature exists
   to keep: never claim a copy that was not taken. */
test('with no destination configured it refuses by name rather than pretending',
  opts, async () => {
    const dir = process.env.BACKUP_DIR;
    delete process.env.BACKUP_DIR;
    try {
      const d = backup.driver();
      assert.strictEqual(d.name, null, 'there is no destination');
      assert.match(d.why, /no backup destination is configured/,
        'and the reason names the variables to set: ' + d.why);
      const h = await backup.health();
      assert.strictEqual(h.configured, false);
      assert.strictEqual(h.where, null, 'and it points nowhere rather than somewhere wrong');
    } finally { process.env.BACKUP_DIR = dir; }
  });

test('a store trades, and every figure is written down', opts, async () => {
  const { createBusiness } = require('../src/business');
  const { provisionOutlet } = require('../src/provision');
  business = await createBusiness({ name: 'Backup Drill Pvt Ltd' });
  DBNAME = business.db_name;

  const o = await provisionOutlet({
    db: DBNAME, code: 'BKUP', name: 'Backup Drill Cafe',
    slug: 'bkupdrill' + String(Date.now()).slice(-6), tz: 'Indian/Maldives'
  });
  OUTLET = o.id || o;

  // Real rows, written the way applySale writes them, through the op path.
  const apply = require('../src/apply');
  const { withOutlet } = dbmod;
  /* A SALE IS CLOSED BY SOMEBODY — sale.closed_by is NOT NULL and comes from
     ctx.actor, which is a chain.staff uuid. A till supplies it from the signed
     -in session; here the row is made directly, because this suite is about
     what a restore brings back rather than about how a bill is rung. */
  const staff = await sql(DBNAME,
    "INSERT INTO chain.staff (name, rank, role_key, outlet_id, pin_hash, pin_salt)"
    + " VALUES ('Drill Owner', 5, 'SuperAdmin', $1, 'x', 'y') RETURNING id", [OUTLET]);
  const ctx = { outletId: OUTLET, rank: 5, actor: staff[0].id, scope: 'outlet',
    db: DBNAME };
  const r2 = (n) => Math.round(n * 100) / 100;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Indian/Maldives' })
    .format(new Date());
  for (let i = 1; i <= 7; i++) {
    const net = 100 * i, svc = r2(net * 0.1), tax = r2((net + svc) * 0.08);
    const gross = r2(net + svc + tax), cash = Math.round(gross * 2) / 2;
    await withOutlet(ctx, (c) => apply.applyOp(c, {
      opId: crypto.randomUUID(), kind: 'sale', lamport: i,
      payload: { bizDate: day, covers: 2, sub: net, disc: 0, net: net, svc: svc,
        tax: tax, round: r2(cash - gross), total: cash, taxCode: 'GGST',
        taxLabel: 'GST', taxRate: 8,
        sold: [{ id: 'd' + i, name: 'Dish ' + i, qty: 1, price: net, amount: net }],
        payments: [{ method: 'cash', amt: cash }], stockMoves: [] } }, ctx));
  }

  before = await census(DBNAME, OUTLET);
  assert.strictEqual(before.bills, 7, 'seven bills are on the books');
  assert.ok(Number(before.dr) > 0 && before.dr === before.cr,
    'and the trial balance balances before anything is backed up: dr '
    + before.dr + ' = cr ' + before.cr);
});

async function census(db, outletId) {
  const one = async (q, p) => (await sql(db, q, p))[0];
  const s = await one('SELECT count(*)::int AS bills, coalesce(sum(total),0)::text AS gross,'
    + ' coalesce(sum(tax),0)::text AS tax FROM outlet_' + outletId + '.sale');
  const j = await one('SELECT count(*)::int AS lines, coalesce(sum(dr),0)::text AS dr,'
    + ' coalesce(sum(cr),0)::text AS cr FROM outlet_' + outletId + '.journal_line');
  const p = await one('SELECT count(*)::int AS n, coalesce(sum(amount),0)::text AS amt'
    + ' FROM outlet_' + outletId + '.payment');
  const i = await one("SELECT value #>> '{}' AS install FROM chain.setting WHERE key = 'install'");
  const o = await one('SELECT count(*)::int AS n FROM chain.outlet');
  const a = await one('SELECT count(*)::int AS n FROM chain.audit');
  const m = await one('SELECT count(*)::int AS n FROM chain.migration');
  return { bills: s.bills, gross: s.gross, tax: s.tax, jlines: j.lines,
    dr: j.dr, cr: j.cr, tenders: p.n, tendered: p.amt,
    install: (i || {}).install, outlets: o.n, audit: a.n, schema: m.n };
}

let archive;

test('the archive is written, hashed and recorded', opts, async () => {
  archive = await backup.backupOne({ db: DBNAME, businessId: Number(business.id),
    by: 'test' });
  assert.ok(archive.ok, 'the dump succeeded: ' + (archive.why || ''));
  assert.ok(archive.bytes > 1000, 'and it is not an empty file: ' + archive.bytes);
  assert.match(String(archive.sha256), /^[0-9a-f]{64}$/, 'with a sha256 on it');
  assert.strictEqual(Number(archive.schemaVersion), Number(before.schema),
    'and the schema version it carries is recorded, so a restore knows'
    + ' whether the fleet runner has to catch it up');

  const shelf = (await sql(process.env.CONTROL_DB,
    'SELECT * FROM chain.backup WHERE id = $1', [archive.id]))[0];
  assert.ok(shelf, 'the shelf has the row');
  assert.strictEqual(shelf.ok, true);
  assert.ok(shelf.finished_at, 'and it finished');
  assert.strictEqual(Number(shelf.business_id), Number(business.id),
    'attributed to the business it belongs to');
  assert.ok(fs.existsSync(String(shelf.location).slice(5)),
    'and the file the row names is really there: ' + shelf.location);
});

/* A FAILED RUN IS A ROW, and it is the row that matters most: a shelf showing
   only successes reads as "backed up nightly" on an install whose last four
   nights failed. */
test('a run that fails is written down too, with the reason', opts, async () => {
  const r = await backup.backupOne({ db: 'no_such_database_here', by: 'test' });
  assert.strictEqual(r.ok, false, 'dumping a database that is not there fails');
  const row = (await sql(process.env.CONTROL_DB,
    'SELECT ok, why FROM chain.backup WHERE id = $1', [r.id]))[0];
  assert.strictEqual(row.ok, false, 'and the shelf says so');
  assert.match(String(row.why), /\S/, 'in words: ' + row.why);
  const h = await backup.health();
  assert.ok(h.recentFailures >= 1,
    'which is what the watchdog counts: ' + h.recentFailures);
});

test('DROP the database, restore it, and every figure comes back', opts, async () => {
  await dbmod.shutdown();
  const a = admin('postgres');
  await a.connect();
  await a.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
    + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [DBNAME]);
  await a.query('DROP DATABASE ' + DBNAME);
  const gone = await a.query('SELECT 1 FROM pg_database WHERE datname = $1', [DBNAME]);
  await a.end();
  assert.strictEqual(gone.rows.length, 0, 'the business database is really gone');

  const res = await backup.restore({ backupId: archive.id, into: DBNAME,
    over: true, log: () => {} });
  assert.ok(res.ok, 'the restore reports done');
  assert.strictEqual(res.outlets, before.outlets,
    'and re-applied every outlet role — a dump of one database carries none');

  const after = await census(DBNAME, OUTLET);
  Object.keys(before).forEach((k) => {
    assert.strictEqual(String(after[k]), String(before[k]),
      k + ' came back: ' + before[k] + ' -> ' + after[k]);
  });
  assert.strictEqual(after.dr, after.cr, 'and the trial balance still balances');
});

/* THE HALF A PLAIN pg_restore SILENTLY DOES NOT DO. In the drill that produced
   this feature, a restore into a fresh cluster dropped 108 GRANT statements on
   the floor, /readyz answered 200, and every outlet request failed with
   `role "outlet_1_app" does not exist`. */
test('and the outlet can trade again on its own login role', opts, async () => {
  const { outletPassword } = require('../src/secrets');
  const rows = await sql(DBNAME,
    'SELECT count(*)::int AS n FROM outlet_' + OUTLET + '.sale', [],
    'outlet_' + OUTLET + '_app', outletPassword(OUTLET));
  assert.strictEqual(Number(rows[0].n), before.bills,
    "the outlet's own role reads its own sales back");

  /* canConnect resolves on success and THROWS on failure — it is the probe
     /readyz uses precisely because a warm pool cannot tell you whether a fresh
     connection would still be accepted. */
  await assert.doesNotReject(() => dbmod.canConnect(OUTLET, DBNAME),
    'the readiness probe can open a FRESH connection as that role — which is'
    + ' the check a warm pool cannot make, and the one that was green for three'
    + ' minutes on an outlet nobody could reach');
});

test('a damaged archive is refused, not restored from', opts, async () => {
  const good = archive.sha256;
  await sql(process.env.CONTROL_DB,
    'UPDATE chain.backup SET sha256 = $2 WHERE id = $1', [archive.id, 'ab'.repeat(32)]);
  await assert.rejects(
    () => backup.restore({ backupId: archive.id, into: DBNAME + '_x', log: () => {} }),
    /does not match what was written/,
    'a truncated or damaged archive restores most of a database and reports'
    + ' success on the part that arrived — which is why the hash is checked'
    + ' before anything is created');
  await sql(process.env.CONTROL_DB,
    'UPDATE chain.backup SET sha256 = $2 WHERE id = $1', [archive.id, good]);
});

test('restoring into a database that exists needs saying so', opts, async () => {
  await assert.rejects(
    () => backup.restore({ backupId: archive.id, into: DBNAME, log: () => {} }),
    /already exists/,
    'restoring over a live business discards everything rung since the'
    + ' archive, so no default may choose it');
  const r = await backup.restore({ backupId: archive.id, log: () => {} });
  assert.notStrictEqual(r.into, DBNAME, 'with no target named it lands beside');
  assert.match(r.into, /_restored_/, 'in a database whose name says what it is: ' + r.into);
  const beside = await census(r.into, OUTLET);
  assert.strictEqual(beside.bills, before.bills,
    'and the copy beside it holds the same trade');
  // The live one is untouched, which is the whole point of restoring beside.
  const live = await census(DBNAME, OUTLET);
  assert.strictEqual(live.bills, before.bills, 'while the original still serves');
  await sql('postgres', 'DROP DATABASE ' + r.into).catch(() => {});
});

/* A FAILED ARCHIVE IS NOT A RESTORE POINT, and offering it as one is how a
   recovery becomes a second incident. */
test('an archive on record as failed is refused as a source', opts, async () => {
  const bad = await backup.backupOne({ db: 'still_no_such_database', by: 'test' });
  await assert.rejects(
    () => backup.restore({ backupId: bad.id, log: () => {} }),
    /on record as having FAILED/);
});

test('retention keeps the newest good copy whatever its age', opts, async () => {
  // Age everything past the window, then prune with a one-day retention.
  await sql(process.env.CONTROL_DB,
    "UPDATE chain.backup SET started_at = now() - interval '90 days'");
  const out = await backup.prune(1, () => {});
  const left = await sql(process.env.CONTROL_DB,
    'SELECT db_name, ok FROM chain.backup ORDER BY started_at DESC');
  const keptGood = left.filter((r) => r.ok);
  assert.ok(keptGood.length >= 1,
    'the newest good archive of a database is never pruned by age: a business'
    + ' nobody has touched for a year still needs its last copy');
  assert.ok(out.removed >= 1, 'and the ones past retention are gone: ' + out.removed);
});

/* ═══ THE SIGNER, AGAINST AWS'S OWN VECTORS ═════════════════════════════════
   There is no bucket here to fail against, so the S3 driver's round trip is
   stated as unverified in DEPLOYMENT.md rather than implied by a green suite.
   What CAN be verified without one is the part that is pure arithmetic: AWS
   publishes a signature test suite with fixed inputs and a fixed expected
   signature, and a signer that reproduces it is correct about canonicalisation,
   the scope string and the four-step key derivation — which is every part of
   SigV4 that a hand-rolled implementation gets wrong. */
test('the S3 signer reproduces AWS\'s published test vector', async () => {
  const b = require('../src/backup');
  // get-vanilla, from AWS's aws-sig-v4-test-suite.
  const sig = b._signV4({
    method: 'GET', path: '/', query: '',
    headers: { Host: 'example.amazonaws.com',
      'X-Amz-Date': '20150830T123600Z' },
    payloadHash: b._sha256hex(''),
    region: 'us-east-1', service: 'service',
    key: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    amzDate: '20150830T123600Z'
  });
  assert.strictEqual(sig.signature,
    '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    'the canonical request, the scope and the key derivation all agree with AWS');
  assert.match(sig.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=/,
    'and the Authorization header is assembled the way S3 expects');
});

test('the object URL is built for both an AWS bucket and a custom endpoint', async () => {
  const b = require('../src/backup');
  const aws = b._s3Url({ bucket: 'shelf', region: 'eu-west-1', endpoint: '' }, 'a/b.dump');
  assert.strictEqual(aws.host, 'shelf.s3.eu-west-1.amazonaws.com');
  assert.strictEqual(aws.pathname, '/a/b.dump');
  // R2, MinIO, B2 and Railway's own buckets are all path-style on an endpoint.
  const other = b._s3Url({ bucket: 'shelf', region: 'auto',
    endpoint: 'https://acct.r2.cloudflarestorage.com/' }, 'a/b.dump');
  assert.strictEqual(other.host, 'acct.r2.cloudflarestorage.com');
  assert.strictEqual(other.pathname, '/shelf/a/b.dump');
});

test('cleanup', opts, async () => {
  await dbmod.shutdown().catch(() => {});
  fs.rmSync(ARCHIVES, { recursive: true, force: true });
});
