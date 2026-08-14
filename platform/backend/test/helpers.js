'use strict';
/* Test harness: boots the real server against a real Postgres, provisions a
 * throwaway outlet, and gives the suite a signed-in till session.
 *
 * Every outlet gets its OWN schema and role, so a test run isolates itself by
 * provisioning an id no other run is using rather than by cleaning up after
 * itself. That also means the suite exercises the real provisioning path on
 * every run, which is where two of the bugs in this build were found.
 *
 * Environment (defaults suit the sandbox harness):
 *   PGHOST PGPORT PGDATABASE DATABASE_URL
 *   OUTLET_ROLE_SECRET SESSION_SECRET REPORT_ROLE_PASSWORD
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const money = require('../../packages/money/money');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 4611);
const BASE = 'http://127.0.0.1:' + PORT;

const env = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: 'test',
  PGHOST: process.env.PGHOST || '127.0.0.1',
  PGPORT: process.env.PGPORT || '5432',
  PGDATABASE: process.env.PGDATABASE || 'kplatform',
  DATABASE_URL: process.env.DATABASE_URL
    || 'postgresql://postgres@' + (process.env.PGHOST || '127.0.0.1')
       + ':' + (process.env.PGPORT || '5432') + '/' + (process.env.PGDATABASE || 'kplatform'),
  OUTLET_ROLE_SECRET: process.env.OUTLET_ROLE_SECRET || 'test-outlet-secret-at-least-32-chars-long',
  SESSION_SECRET: process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars',
  REPORT_ROLE_PASSWORD: process.env.REPORT_ROLE_PASSWORD || 'test-report-pw',
  ALLOWED_ORIGINS: '*',
};

const uuid = () => crypto.randomUUID();

/* A per-run outlet id. Kept well above the ids a human would provision by hand
   so a test run cannot land on a real outlet in a shared database. */
function pickOutletId() {
  return 9000 + (process.pid % 900) + Math.floor(Math.random() * 90);
}

let child = null;

async function startServer() {
  if (child) return;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not become ready:\n' + log);
    try {
      const r = await fetch(BASE + '/readyz');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
}

function ownerClient() {
  return new Client({ connectionString: env.DATABASE_URL });
}

/** Provision a fresh outlet, seed the minimum a sale needs, sign in. */
async function bootOutlet() {
  await startServer();
  const outletId = pickOutletId();
  const code = 'T' + outletId;
  const today = new Date().toISOString().slice(0, 10);
  const owner = ownerClient();
  await owner.connect();

  const { outletPassword, hashPin, pinLookup } = require('../src/secrets');
  const s = 'outlet_' + outletId;

  await owner.query('SELECT chain.provision_outlet($1,$2,$3,$4)',
    [outletId, code, 'Test Outlet ' + outletId, outletPassword(outletId)]);
  await owner.query('SELECT chain.seed_chart($1)', [s]);
  // The new outlet's role needs the audit grant migration 005 hands out.
  await owner.query('GRANT SELECT, INSERT ON chain.audit TO ' + s + '_app');

  /* Configuration, not constants: 10% service, GGST at 8% from the start of
     time so a historical business date is still covered, and no cash rounding
     unless a test asks for it. */
  await owner.query('UPDATE chain.outlet SET service_pct = 10, cash_round_laari = 0'
    + ' WHERE id = $1', [outletId]);
  await owner.query(
    'INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from)'
    + " VALUES ($1,'GGST',8,'2020-01-01') ON CONFLICT DO NOTHING", [outletId]);

  const tillPin = String(1000 + (outletId % 8999));
  const till = hashPin(tillPin);
  const staffId = uuid();
  await owner.query(
    'INSERT INTO chain.staff (id, name, rank, outlet_id, pin_hash, pin_salt, pin_lookup)'
    + ' VALUES ($1,$2,2,$3,$4,$5,$6)',
    [staffId, 'Test Cashier', outletId, till.hash, till.salt,
      pinLookup(outletId, tillPin)]);

  /* A menu and a pantry. Real rows through the real path — the suite's own
     fixtures, in a throwaway outlet, which is what 10-NO-DEMO-DATA.md permits
     ("Seed data may exist ONLY for development/testing environments"). */
  const openingStock = { BEEF: 10000, BUN: 500, SYRUP: 20000 };
  await owner.query('INSERT INTO ' + s + '.ingredient (id, name, unit, on_hand, avg_cost)'
    + " VALUES ('BEEF','Beef mince','g',$1,0.0850),"
    + "        ('BUN','Burger bun','pcs',$2,4.5000),"
    + "        ('SYRUP','Cola syrup','ml',$3,0.0120)"
    + ' ON CONFLICT (id) DO NOTHING',
  [openingStock.BEEF, openingStock.BUN, openingStock.SYRUP]);

  const menu = { BURGER: 8500, COLA: 2500 };     // laari, GST-inclusive
  await owner.query('INSERT INTO ' + s + '.item (id, name, category, price)'
    + " VALUES ('BURGER','Beef burger','Food',85.00),"
    + "        ('COLA','Cola','Beverage',25.00) ON CONFLICT (id) DO NOTHING");
  await owner.query('INSERT INTO ' + s + '.recipe_line (item_id, ingredient_id, qty, waste_pct)'
    + " VALUES ('BURGER','BEEF',150,5), ('BURGER','BUN',1,0), ('COLA','SYRUP',40,0)"
    + ' ON CONFLICT DO NOTHING');

  await owner.end();

  const r = await post('/api/auth/pin', { outletId, pin: tillPin, deviceId: null });
  if (r.status !== 200) throw new Error('sign-in failed: ' + JSON.stringify(r.json));

  return {
    outletId, code, schema: s, today, tillPin, staffId,
    token: r.json.token, menu, openingStock,
    servicePct: 10, taxRate: 8,
  };
}

async function teardown(ctx) {
  stopServer();
}

function stopServer() {
  if (child) { child.kill('SIGTERM'); child = null; }
}

async function req(method, p, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

const post = (p, body, token) => req('POST', p, { body, token });
const push = (ctx, ops) =>
  req('POST', '/api/outlet/' + ctx.outletId + '/sync/push', { body: { ops }, token: ctx.token });

/** Query the outlet's schema AS the outlet's own role — so a test asserting
 *  that something is forbidden gets the same answer the application would. */
async function q(ctx, sql, params) {
  const { outletPassword } = require('../src/secrets');
  const c = new Client({
    host: env.PGHOST, port: Number(env.PGPORT), database: env.PGDATABASE,
    user: 'outlet_' + ctx.outletId + '_app', password: outletPassword(ctx.outletId),
  });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.outlet_id',$1,true),"
      + " set_config('app.user_rank','5',true), set_config('app.actor',$2,true),"
      + " set_config('app.scope','outlet',true)", [String(ctx.outletId), ctx.staffId]);
    const out = await c.query(sql, params || []);
    await c.query('COMMIT');
    return out;
  } finally { await c.end().catch(() => {}); }
}

/** What the SERVER should compute for a basket — the test's independent
 *  expectation, built from the same module the server uses. Sharing the module
 *  is deliberate: what is under test here is that the server APPLIES it to
 *  configuration from the database rather than to figures from the client.
 *  money.test.js is where the module's own arithmetic is pinned. */
function priceIt(ctx, basket) {
  return money.priceBill({
    lines: basket.map(([id, qty]) => ({ unitPrice: ctx.menu[id], qty })),
    servicePct: ctx.servicePct,
    taxRate: ctx.taxRate,
  });
}

/** Run SQL as the OWNER — for the handful of setup steps that are a Manager's
 *  job through the app but have no endpoint yet (configuring stations). Kept
 *  distinct from q() so a test can never accidentally assert an outlet-role
 *  permission using owner privileges. */
async function asOwner(ctx, sql, params) {
  const c = ownerClient();
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.outlet_id',$1,true),"
      + " set_config('app.user_rank','5',true), set_config('app.scope','outlet',true)",
      [String(ctx.outletId)]);
    await c.query('SET LOCAL search_path = ' + ctx.schema + ', chain, public');
    const out = await c.query(sql, params || []);
    await c.query('COMMIT');
    return out;
  } finally { await c.end().catch(() => {}); }
}

/** Add a member of staff at a rank, and sign them in. */
async function addStaff(ctx, name, rank) {
  const { hashPin, pinLookup } = require('../src/secrets');
  const pin = String(2000 + Math.floor(Math.random() * 7000));
  const h = hashPin(pin);
  const c = ownerClient();
  await c.connect();
  try {
    await c.query('INSERT INTO chain.staff (name, rank, outlet_id, pin_hash, pin_salt, pin_lookup)'
      + ' VALUES ($1,$2,$3,$4,$5,$6)',
      [name, rank, ctx.outletId, h.hash, h.salt, pinLookup(ctx.outletId, pin)]);
  } finally { await c.end().catch(() => {}); }
  const r = await post('/api/auth/pin', { outletId: ctx.outletId, pin });
  if (r.status !== 200) throw new Error('staff sign-in failed: ' + JSON.stringify(r.json));
  return { token: r.json.token, rank: r.json.rank, name, pin };
}

module.exports = { BASE, startServer, stopServer, bootOutlet, teardown, req, post, push, q, uuid, priceIt, asOwner, addStaff };
