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
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const money = require('../../packages/money/money');

const ROOT = path.join(__dirname, '..');

/* `node --test` runs each FILE in its own process, so a fixed port meant two
   consecutive files raced for it: the first had killed its server but the
   socket was not yet released when the second tried to bind, and the whole
   file's tests came back "cancelled" with no failure to point at. Intermittent
   green is worse than red — people stop believing the suite.
   So the port is derived per process and, if it is taken anyway, startServer
   walks to the next one. */
let PORT = Number(process.env.TEST_PORT || (4300 + (process.pid % 600)));
let BASE = 'http://127.0.0.1:' + PORT;

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

/* A per-run outlet id, CLAIMED rather than guessed.

   It used to be 9000 + (pid % 900) + random(90), which two test processes with
   nearby pids could easily land on together — and then two files shared one
   schema, so one file's sales broke another file's "nothing was written"
   assertion. That is where the intermittent single failure came from, and it
   only ever appeared when the whole suite ran, which is the worst way for a
   test to be wrong.

   Now the id is checked against chain.outlet and re-drawn on a collision, over
   a range wide enough that a collision is rare and handled when it happens.
   Kept well above the ids a human provisions by hand so a run can never land on
   a real outlet in a shared database. */
async function claimOutletId(owner) {
  for (let i = 0; i < 40; i++) {
    const id = 9000 + Math.floor(Math.random() * 90000);
    const q = await owner.query('SELECT 1 FROM chain.outlet WHERE id = $1', [id]);
    if (!q.rows.length) return id;
  }
  throw new Error('could not claim a free test outlet id');
}

let child = null;

/* The server does NOT migrate on boot — `/readyz` answers 503 until the control
   schema is there, which is exactly what it should do on a deploy that cannot
   see its database. The migration is a separate step of the deploy, so it has
   to be a separate step here too.

   Without this the suite could only ever run against a database somebody had
   already migrated by hand: on a genuinely cold one every file failed with
   "server did not become ready", the server having started perfectly and been
   asked a question about a table that did not exist yet. A harness that only
   works on a warm database cannot tell you a migration is missing, which is the
   one thing a cold run is for. */
function migrateIfCold() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js')],
    { env, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('migrations failed before the suite could start:\n'
      + (r.stderr || r.stdout || '').slice(-2000));
  }
}

async function startServer() {
  if (child) return;
  migrateIfCold();
  let lastLog = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = PORT + attempt;
    BASE = 'http://127.0.0.1:' + port;
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')],
      { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    /* TEST_SERVER_LOG=1 puts the server's own output on stderr. A 500 in a test
       is otherwise a message the harness swallows — the server logged the stack
       and nobody was listening, so the only clue was "server error". */
    const tee = process.env.TEST_SERVER_LOG ? (d) => process.stderr.write('[server] ' + d) : null;
    proc.stdout.on('data', (d) => { log += d; if (tee) tee(d); });
    proc.stderr.on('data', (d) => { log += d; if (tee) tee(d); });

    /* Long enough for a COLD database, where this boot is the one that runs the
       whole migration directory before /readyz will answer, and short enough
       that a Postgres which is simply not there fails the run in a minute
       rather than in twenty. (A dead database looks exactly like a slow one
       from here — the last log line is in the error either way, and it is worth
       reading before assuming the code is at fault.) */
    const deadline = Date.now() + 30000;
    for (;;) {
      // The port was taken, or the process died on boot: try the next one
      // rather than sitting out the whole timeout on a socket that will never
      // answer.
      if (proc.exitCode !== null || /EADDRINUSE/.test(log)) break;
      if (Date.now() > deadline) break;
      try {
        const r = await fetch(BASE + '/readyz');
        if (r.ok) { child = proc; PORT = port; return; }
      } catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    lastLog = log;
    proc.kill('SIGKILL');
  }
  throw new Error('server did not become ready on any port from ' + PORT + ':\n' + lastLog);
}

function ownerClient() {
  return new Client({ connectionString: env.DATABASE_URL });
}

/** Provision a fresh outlet, seed the minimum a sale needs, sign in. */
async function bootOutlet() {
  await startServer();
  const today = new Date().toISOString().slice(0, 10);
  const owner = ownerClient();
  await owner.connect();
  const outletId = await claimOutletId(owner);
  const code = 'T' + outletId;

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
  /* Opening stock is seeded WITH its matching ledger rows, not by setting
     on_hand directly. `ingredient.on_hand` is a cache of Σ stock_move.qty, and
     a fixture that sets one without the other creates a state the system could
     never reach — every test then runs against a database that is already
     inconsistent, and the invariant tests cannot tell a fixture flaw from a
     product bug. */
  const openingStock = { BEEF: 10000, BUN: 500, SYRUP: 20000 };
  const openingCost = { BEEF: 0.0850, BUN: 4.5000, SYRUP: 0.0120 };
  await owner.query('INSERT INTO ' + s + '.ingredient (id, name, unit, on_hand, avg_cost)'
    + " VALUES ('BEEF','Beef mince','g',$1,$4),"
    + "        ('BUN','Burger bun','pcs',$2,$5),"
    + "        ('SYRUP','Cola syrup','ml',$3,$6)"
    + ' ON CONFLICT (id) DO NOTHING',
  [openingStock.BEEF, openingStock.BUN, openingStock.SYRUP,
    openingCost.BEEF, openingCost.BUN, openingCost.SYRUP]);
  for (const [id, qty] of Object.entries(openingStock)) {
    await owner.query('INSERT INTO ' + s + '.stock_move'
      + " (ingredient_id, qty, unit_cost, value, reason) VALUES ($1,$2,$3,$4,'opening')",
    [id, qty, openingCost[id], (qty * openingCost[id]).toFixed(2)]);
  }

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
  /* The headers come back too. Not every response IS its body: a CSV export is
     a file, and whether it downloads as one is decided entirely by content-type
     and content-disposition — assertions no test could make while this returned
     the body alone. */
  return { status: r.status, json, text, headers: Object.fromEntries(r.headers) };
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

/* `money` is exported so a test can price a bill the server has not seen yet —
   a promo quote, for instance, where the expectation is a discount applied
   through the SAME calculation the server uses rather than a figure retyped. */
module.exports = { BASE, startServer, stopServer, bootOutlet, teardown, req, post, push, q, uuid, priceIt, asOwner, addStaff, money };
