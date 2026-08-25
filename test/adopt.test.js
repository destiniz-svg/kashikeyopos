'use strict';
/* ═══ ADOPTING AN INSTALL THAT ALREADY EXISTS ════════════════════════════════
   The gate before the new code reaches a live install. Two things have to be
   true or a customer loses something they cannot get back:

     · the accounts come out BEFORE migration 011 drops them — that tombstone
       is the only reason this ordering exists, and getting it wrong deletes
       the record of who owns the business;
     · two installs that each have an outlet 1 end up with two different
       outlets, and the one that moved still works — its schema, its login
       role, its staff, its members and its retired addresses.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const DB = require('./db');

DB.secrets();
process.env.BUSINESS_DB_PREFIX = 'ka_biz_';

const CONTROL = process.env.PGTESTCONTROL5 || 'kashikeyo_control_adopt';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

const A = 'ka_old_one';
const B = 'ka_old_two';
/* Both installs use the SAME outlet id, which is the property under test — an
   install allocated from 1 and every install therefore had the same ids. The
   number is high only because roles are CLUSTER-wide and other suites are
   running beside this one; outlet_1_app would be a fight over a name rather
   than a test of anything. */
const OLD_ID = 9001;
let db;

function adopt(dbName, name, apply) {
  const args = [path.join(__dirname, '..', 'src', 'scripts', 'adopt-install.js'),
    '--db', dbName, '--name', name];
  if (apply) args.push('--apply');
  return execFileSync(process.execPath, args, {
    env: Object.assign({}, process.env, { CONTROL_DB: CONTROL }),
    encoding: 'utf8'
  });
}

async function admin(database) {
  const c = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: database
  });
  await c.connect();
  return c;
}

/* An install in the shape the OLD product left them: migrated, with its own
   outlet 1, and with the account plane still inside it — which is what
   migration 011 is about to take away. */
async function oldInstall(dbName, slug) {
  const a = await admin(process.env.PGADMINDB || 'postgres');
  await a.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
    + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]).catch(() => {});
  await a.query('DROP DATABASE IF EXISTS ' + dbName);
  await a.query('CREATE DATABASE ' + dbName);
  await a.end();

  const { migrateBusiness } = require('../src/scripts/migrate');
  await migrateBusiness(dbName, () => {});

  const p = db.ownerFor(dbName);
  // 011's tables, put back: this install predates the tombstone.
  await p.query(`
    CREATE TABLE IF NOT EXISTS chain.account (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL,
      name text, password_hash text, password_salt text, verified_at timestamptz,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz);
    CREATE TABLE IF NOT EXISTS chain.account_outlet (
      account_id uuid NOT NULL, outlet_id int NOT NULL,
      role text NOT NULL DEFAULT 'owner', PRIMARY KEY (account_id, outlet_id));`);

  const { provisionOutlet } = require('../src/provision');
  const made = await provisionOutlet({ db: dbName, id: OLD_ID, code: 'OLD1',
    name: 'The Old Shop', slug: slug });
  assert.strictEqual(made.id, OLD_ID, 'every old install allocated from the same base');

  const acct = await p.query(
    "INSERT INTO chain.account (email, name, verified_at) VALUES ($1,$2,now())"
    + ' RETURNING id', ['owner-' + dbName + '@example.mv', 'An Owner']);
  await p.query("INSERT INTO chain.account_outlet (account_id, outlet_id, role)"
    + " VALUES ($1,$2,'owner')", [acct.rows[0].id, OLD_ID]);
  await p.query("INSERT INTO chain.member (phone, name) VALUES ($1,$2)",
    ['777' + dbName.slice(-1), 'A Regular']);

  /* An old install has never met a registry. Building the fixture with the
     CURRENT provisionOutlet registers it on the way past, so those rows come
     back out — otherwise this tests adoption of something already adopted,
     which is not the case that can lose a customer's data. */
  await db.control().query('DELETE FROM chain.handle WHERE outlet_id IN'
    + ' (SELECT outlet_id FROM chain.outlet_directory d JOIN chain.business b'
    + ' ON b.id = d.business_id WHERE b.db_name = $1)', [dbName]);
  await db.control().query('DELETE FROM chain.business WHERE db_name = $1', [dbName]);
  return acct.rows[0].id;
}

test('two old installs, each with an outlet 1', opts, async () => {
  const a = await admin(process.env.PGADMINDB || 'postgres');
  await a.query('DROP DATABASE IF EXISTS ' + CONTROL);
  await a.query('CREATE DATABASE ' + CONTROL);
  await a.end();
  process.env.CONTROL_DB = CONTROL;

  db = require('../src/db');
  await require('../src/scripts/migrate').migrateControl(() => {});
  /* Deliberately NOT dropOutletRoles(): roles are cluster-wide, and other
     suites are using theirs while this one runs. */

  await oldInstall(A, 'old-one');
  await oldInstall(B, 'old-two');
  const one = await db.ownerFor(A).query('SELECT id, slug FROM chain.outlet');
  const two = await db.ownerFor(B).query('SELECT id, slug FROM chain.outlet');
  assert.strictEqual(one.rows[0].id, OLD_ID);
  assert.strictEqual(two.rows[0].id, OLD_ID, 'and they collide, which is the point');
});

test('a dry run changes nothing and says what it would do', opts, async () => {
  const out = adopt(A, 'Old One', false);
  assert.match(out, /DRY RUN/);
  assert.match(out, /would copy account/);
  assert.match(out, new RegExp('would register outlet ' + OLD_ID));
  assert.match(out, /would claim handle "old-one"/);

  const reg = await db.control().query('SELECT count(*)::int AS n FROM chain.business');
  assert.strictEqual(reg.rows[0].n, 0, 'a dry run writes nothing at all');
  const acc = await db.control().query('SELECT count(*)::int AS n FROM chain.account');
  assert.strictEqual(acc.rows[0].n, 0);
});

test('the first install keeps its outlet id', opts, async () => {
  adopt(A, 'Old One', true);

  const biz = await db.control().query('SELECT * FROM chain.business WHERE db_name = $1', [A]);
  assert.strictEqual(biz.rows[0].status, 'live');
  assert.strictEqual(Number(biz.rows[0].schema_version),
    require('../src/scripts/migrate').headCount(), 'recorded at what it really is');

  const dir = await db.control().query('SELECT * FROM chain.outlet_directory');
  assert.strictEqual(dir.rows.length, 1);
  assert.strictEqual(dir.rows[0].outlet_id, OLD_ID, 'the first one adopted keeps it');

  // Its account came out before anything could drop it, and it owns the business.
  const acc = await db.control().query('SELECT email FROM chain.account');
  assert.strictEqual(acc.rows.length, 1);
  assert.match(acc.rows[0].email, /owner-ka_old_one/);
  const owns = await db.control().query(
    "SELECT role FROM chain.account_business WHERE business_id = $1", [biz.rows[0].id]);
  assert.strictEqual(owns.rows[0].role, 'owner');

  const h = await db.control().query('SELECT outlet_id FROM chain.handle WHERE name = $1',
    ['old-one']);
  assert.strictEqual(h.rows[0].outlet_id, OLD_ID);
});

test('the second is remapped, and everything it owns moves with it', opts, async () => {
  const before = await db.ownerFor(B).query(
    'SELECT count(*)::int AS n FROM chain.member');
  adopt(B, 'Old Two', true);

  const dir = await db.control().query(
    'SELECT outlet_id FROM chain.outlet_directory ORDER BY outlet_id');
  assert.strictEqual(dir.rows.length, 2);
  const moved = dir.rows.map((r) => Number(r.outlet_id)).find((n) => n !== OLD_ID);
  assert.ok(moved && moved !== OLD_ID, 'it was given an id nobody else holds: ' + moved);

  // The row moved, and so did the schema and the login role.
  const o = await db.ownerFor(B).query('SELECT id, schema_name, slug FROM chain.outlet');
  assert.strictEqual(Number(o.rows[0].id), moved);
  assert.strictEqual(o.rows[0].schema_name, 'outlet_' + moved);

  const sch = await db.ownerFor(B).query(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
    ['outlet_' + moved]);
  assert.strictEqual(sch.rows.length, 1, 'the schema was renamed, not copied');

  // Its members are still its own — the remap repointed every reference,
  // including chain.member.home_outlet, which is not called outlet_id.
  const after = await db.ownerFor(B).query('SELECT count(*)::int AS n FROM chain.member');
  assert.strictEqual(after.rows[0].n, before.rows[0].n, 'nothing was orphaned');

  // And nothing still points at the id it left.
  const stale = await db.ownerFor(B).query(
    'SELECT count(*)::int AS n FROM chain.staff WHERE outlet_id = $1', [OLD_ID]);
  assert.strictEqual(stale.rows[0].n, 0);

  /* THE ROLE STILL OPENS THE DOOR. A remap that renamed the schema and left the
     login broken is a store that cannot trade — the password is derived from
     the id, so moving the id moves the password. */
  const { outletPassword } = require('../src/secrets');
  const c = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: 'outlet_' + moved + '_app', password: outletPassword(moved), database: B
  });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.outlet_id',$1,true),"
      + " set_config('app.user_rank','5',true), set_config('app.scope','outlet',true)",
    [String(moved)]);
    const mine = await c.query('SELECT count(*)::int AS n FROM chain.outlet');
    assert.strictEqual(mine.rows[0].n, 1, 'it signs in and reads its own outlet');
    await c.query('SELECT 1 FROM item LIMIT 1');   // its own renamed schema
    await c.query('COMMIT');
  } finally { await c.end().catch(() => {}); }

  // Its handle is its own, and the first store's is untouched.
  const h = await db.control().query('SELECT name, outlet_id FROM chain.handle ORDER BY name');
  assert.deepStrictEqual(h.rows.map((r) => r.name), ['old-one', 'old-two']);
  assert.strictEqual(Number(h.rows[1].outlet_id), moved);
});

test('adopting twice changes nothing the second time', opts, async () => {
  const before = await db.control().query(
    'SELECT count(*)::int AS b FROM chain.business');
  const out = adopt(A, 'Old One', true);
  assert.match(out, /already registered/);
  const after = await db.control().query(
    'SELECT count(*)::int AS b FROM chain.business');
  assert.strictEqual(after.rows[0].b, before.rows[0].b, 'no second business row');
});

test('an install whose accounts are already gone is reported, not papered over',
  opts, async () => {
    /* The one unrecoverable case: the new code booted first, 011 dropped the
       account tables, and nobody had carried them out. It has to SAY so — an
       adoption that silently succeeds leaves a business nobody can sign in to
       and no sign that anything was lost. */
    await db.ownerFor(B).query('DROP TABLE IF EXISTS chain.account_outlet');
    await db.ownerFor(B).query('DROP TABLE IF EXISTS chain.account');
    const out = adopt(B, 'Old Two', false);
    assert.match(out, /accounts: already gone|GONE from this install/);
  });

test('the cluster is left clean', opts, async () => {
  await db.shutdown();
  const a = await admin(process.env.PGADMINDB || 'postgres');
  for (const d of [A, B, CONTROL]) {
    await a.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
      + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [d]).catch(() => {});
    await a.query('DROP DATABASE IF EXISTS ' + d).catch(() => {});
  }
  await a.end();
});
