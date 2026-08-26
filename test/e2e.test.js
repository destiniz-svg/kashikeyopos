'use strict';
/* ═══ SIGNUP TO A RUNG SALE ══════════════════════════════════════════════════
   Every other suite proves a part. This one walks the whole road a real
   customer walks, over HTTP, against a real cluster:

     sign up on the website → confirm the email → a DATABASE is created →
     onboard the company, the outlet and the owner → sign in at the till →
     ring a bill with a member, a points redemption and a credit tender →
     and then check the money landed in THAT customer's database and nobody
     else's.

   It exists because the parts can each be right while the road is broken, and
   because the two live provisioning runs that failed this week both failed at
   a seam no unit test was looking at.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const DB = require('./db');

DB.secrets();
/* Its own database-name prefix. Suites share a cluster and each registry
   allocates business ids from 1, so without this they all reach for
   kashikeyo_biz_1 and clobber each other. */
process.env.BUSINESS_DB_PREFIX = 'ke_biz_';
process.env.PUBLIC_URL = process.env.PUBLIC_URL || 'https://kashikeyopos.com';

const CONTROL = process.env.PGTESTCONTROL4 || 'kashikeyo_control_e2e';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

let db, BIZ, app, srv, base;
let accountToken, businessId, bizDb, outletId, tillToken, memberId;

const call = (method, path, body, headers) => fetch(base + path, {
  method: method,
  headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const post = (p, b, t) => call('POST', p, b, t ? { authorization: 'Bearer ' + t } : {});
const get = (p, t) => call('GET', p, undefined, t ? { authorization: 'Bearer ' + t } : {});
const uuid = () => require('crypto').randomUUID();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Indian/Maldives' });

/* Whatever the business database says, asked as its owner. The trade tables
   live in the OUTLET's schema, so the search_path is set per query rather than
   the table names being guessed — an unqualified `sale` would find whichever
   schema happened to be first. */
const inBiz = async (sql, params) => {
  const c = await db.ownerFor(bizDb).connect();
  try {
    // In a transaction, because SET LOCAL outside one does nothing at all —
    // and a plain SET would follow this connection back into the pool.
    await c.query('BEGIN');
    if (outletId) await c.query('SET LOCAL search_path = outlet_' + outletId + ', chain, public');
    const q = await c.query(sql, params || []);
    await c.query('COMMIT');
    return q.rows[0];
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
};

test('the cluster is cold and the app is up', opts, async () => {
  await DB.dropBusinessDatabases();
  await DB.freshDatabase(process.env.PGTESTDB5 || 'kashikeyo_e2e_seed');
  await DB.freshControl(CONTROL);
  await DB.dropOutletRoles();

  db = require('../src/db');
  BIZ = require('../src/business');
  await require('../src/scripts/migrate').migrateControl(() => {});

  process.env.SKIP_MIGRATE = '1';
  process.env.ACCOUNT_CODE_ECHO = '1';
  ({ app } = require('../server'));
  await new Promise((res) => { srv = app.listen(0, res); });
  base = 'http://127.0.0.1:' + srv.address().port;
  assert.ok(base);
});

test('a customer signs up and confirms the address is theirs', opts, async () => {
  const email = 'owner-' + Date.now() + '@example.mv';
  const up = await post('/api/account/signup',
    { email: email, name: 'A Founder', password: 'a-good-long-password' });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.strictEqual(up.body.next, 'code');
  assert.ok(up.body.code, 'the development echo hands back the code');

  /* Before confirming, the door to CREATE DATABASE is shut. This is the check
     that keeps a bot with a wordlist from minting infrastructure. */
  const early = await post('/api/account/signin', { email: email, password: 'a-good-long-password' });
  const earlyTok = early.body.token;
  const refused = await post('/api/account/business', { name: 'Too Soon Ltd' }, earlyTok);
  assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

  const ver = await post('/api/account/code/verify', { email: email, code: up.body.code });
  assert.strictEqual(ver.status, 200, JSON.stringify(ver.body));
  accountToken = ver.body.token;
  assert.strictEqual(ver.body.next, 'onboarding', 'they own nothing yet');
  assert.deepStrictEqual(ver.body.outlets, []);
});

test('confirming creates a database, migrated to head', opts, async () => {
  const made = await post('/api/account/business', { name: 'Seaside Cafe' }, accountToken);
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  businessId = made.body.businessId;
  bizDb = db.businessDb(businessId);

  const row = await db.control().query(
    'SELECT status, db_name, schema_version FROM chain.business WHERE id = $1', [businessId]);
  assert.strictEqual(row.rows[0].status, 'live');
  assert.strictEqual(row.rows[0].db_name, bizDb);
  assert.strictEqual(row.rows[0].schema_version,
    require('../src/scripts/migrate').headCount(), 'at head, counted not guessed');

  // The schema a till reads is really there, in a database of its own.
  const t = await inBiz("SELECT to_regclass('chain.company') IS NOT NULL AS a,"
    + " to_regclass('chain.member') IS NOT NULL AS b");
  assert.deepStrictEqual([t.a, t.b], [true, true]);
});

test('they onboard the company, the outlet and themselves', opts, async () => {
  /* Onboarding names the account with x-account-token, not Authorization: it
     is not a staff session, and step 1 runs before any session exists. */
  const acct = { 'x-account-token': accountToken };
  const step = (p, b) => call('POST', p, b, acct);

  /* A BUSINESS AND AN OUTLET ARE DIFFERENT NAMES. The signup took "Seaside
     Cafe" — a working title, given before anybody had been asked for a
     registration number — and the panel offers it back on step 1 so the same
     answer is not typed twice. */
  const seeded = await call('GET', '/api/onboarding/state', undefined, acct);
  assert.strictEqual(seeded.body.business, 'Seaside Cafe',
    'the panel is told what the signup called this business, to prefill step 1');

  /* AND NOBODY ASKS A SELF-SERVE CUSTOMER FOR A CODE THEY WERE NEVER GIVEN.
     ONBOARDING_CLAIM_TOKEN exists because, on a per-install deploy, the three
     steps before a staff session are behind nothing and whoever POSTs first
     owns the business. That race cannot happen here: these steps are reached
     only with an account token naming a business this account created itself,
     through a door that already wanted a verified address. Left in place the
     fence asks for a code no seller ever issued, and the install's own boot
     log says "unclaimed" with nobody to ring. */
  const hadToken = process.env.ONBOARDING_CLAIM_TOKEN;
  process.env.ONBOARDING_CLAIM_TOKEN = 'a-code-nobody-here-was-given';
  try {
    const asked = await call('GET', '/api/onboarding/state', undefined, acct);
    assert.strictEqual(asked.body.claimRequired, false,
      'the panel does not put a field on screen that nobody can fill');
    // The stranger's door is unchanged: no account, no business, still fenced.
    const stranger = await call('POST', '/api/onboarding/company',
      { legalName: 'Squatter Ltd', regNo: 'X-1', address: 'nowhere' }, {});
    assert.strictEqual(stranger.status, 403, 'and the fence still stands for everyone else');
    assert.strictEqual(stranger.body.claim, true);
  } finally {
    if (hadToken === undefined) delete process.env.ONBOARDING_CLAIM_TOKEN;
    else process.env.ONBOARDING_CLAIM_TOKEN = hadToken;
  }

  let r = await step('/api/onboarding/company', {
    legalName: 'Seaside Cafe Pvt Ltd', regNo: 'C-9001/2026', gstRegistered: 'yes',
    tin: 'T9000001GST501', address: 'Boduthakurufaanu Magu, Malé'
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  /* THE REGISTRY ADOPTS THE REGISTERED NAME. Left alone it would keep the
     working title for ever, so the seller's list and the customer's own
     receipts would disagree about who this is. */
  const adopted = await db.control().query(
    'SELECT name FROM chain.business WHERE id = $1', [businessId]);
  assert.strictEqual(adopted.rows[0].name, 'Seaside Cafe Pvt Ltd');

  r = await step('/api/onboarding/outlet', {
    name: 'Seaside Cafe', code: 'SEAS', kind: 'restaurant',
    taxCode: 'GGST', servicePct: 10, address: 'Malé', tz: 'Indian/Maldives',
    currency: 'MVR', slug: 'seaside-e2e'
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  outletId = r.body.id;

  /* The outlet is registered globally and its handle claimed globally — the
     two facts that make one app able to route for many customers. */
  const dir = await db.control().query(
    'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1', [outletId]);
  assert.strictEqual(Number(dir.rows[0].business_id), businessId);
  const h = await db.control().query(
    'SELECT business_id FROM chain.handle WHERE name = $1', ['seaside-e2e']);
  assert.strictEqual(Number(h.rows[0].business_id), businessId);

  r = await step('/api/onboarding/owner', { name: 'A Founder', pin: '4718' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));

  // And the account now owns a business rather than being sent to onboarding.
  const me = await get('/api/account/me', accountToken);
  assert.strictEqual(me.body.next, 'terminal');
  assert.strictEqual(me.body.outlets.length, 1);
  assert.strictEqual(me.body.outlets[0].outlet_id, outletId);
});

test('the owner signs in at the till with four digits', opts, async () => {
  const r = await post('/api/auth/pin', { outletId: outletId, pin: '4718' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.rank, 5);
  tillToken = r.body.token;

  /* Two credentials, two planes: the account token cannot work an outlet and
     the staff session cannot read the account plane. */
  const wrongPlane = await get('/api/outlet/' + outletId + '/bootstrap', accountToken);
  assert.ok(wrongPlane.status >= 400, 'an account token is not a till session');
  const alsoWrong = await get('/api/account/me', tillToken);
  assert.strictEqual(alsoWrong.status, 401, 'and a till session is not an account');
});

test('a bill with a member, a redemption and credit reaches the ledger',
  opts, async () => {
    const push = (ops) => post('/api/outlet/' + outletId + '/sync/push', { ops }, tillToken);

    memberId = uuid();
    let r = await push([{ opId: uuid(), kind: 'member_upsert', lamport: 1, payload: {
      id: memberId, name: 'Hassan Moosa', phone: '7770001',
      creditLimit: 5000 } }]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const born = await inBiz('SELECT id FROM chain.member WHERE phone = $1', ['7770001']);
    assert.ok(born, 'the customer exists in THIS business');
    memberId = born.id;

    // Points to spend, granted the way the loyalty screen grants them.
    r = await push([{ opId: uuid(), kind: 'loyalty_update', lamport: 2, payload: {
      member: memberId, points: 500, reason: 'goodwill' } }]);
    assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));

    /* The bill: 300 of goods, 200 points redeemed at a value of 50, the rest
       on the house account. Points come off the GOODS before service and tax —
       a guest should not be charged service on money they did not hand over,
       and the government should not be taxing a discount. */
    r = await push([
      { opId: uuid(), kind: 'loyalty_update', lamport: 3, payload: {
        member: memberId, points: -200, reason: 'redeem' } },
      { opId: uuid(), kind: 'sale', lamport: 4, payload: {
        bizDate: today(), covers: 2, sub: 300, disc: 0, net: 300, svc: 0,
        tax: 0, round: 0, total: 250, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
        member: memberId, customer: 'Hassan Moosa',
        pts: 200, ptsValue: 50,
        sold: [{ id: 'm3', name: 'Reef fish curry', qty: 1, price: 300, amount: 300 }],
        payments: [{ method: 'credit', amt: 250 }], stockMoves: []
      } }
    ]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const sale = r.body.results[1];
    assert.ok(!sale.error, 'the sale posts: ' + JSON.stringify(sale));

    const row = await inBiz('SELECT total, pts, pts_value, server_audit FROM sale WHERE id = $1',
      [sale.result.saleId]);
    assert.strictEqual(Number(row.total), 250, 'the charged figure, not the gross');
    assert.strictEqual(Number(row.pts_value), 50);
    assert.strictEqual(row.server_audit, null, 'a redemption is not a discrepancy');

    // The journal balances, in this business's own books.
    const j = await inBiz('SELECT sum(dr)::numeric AS dr, sum(cr)::numeric AS cr'
      + ' FROM journal_line WHERE journal_id IN (SELECT id FROM journal)');
    assert.strictEqual(Number(j.dr), Number(j.cr), 'dr = cr across every journal');
    assert.ok(Number(j.dr) > 0, 'and there is something in them');

    // The member's balances moved: 500 earned by hand, 200 spent, and the
    // credit tender is outstanding against their limit.
    const m = await inBiz('SELECT points, credit_used FROM chain.member WHERE id = $1',
      [memberId]);
    /* 500 granted, 200 spent, and then EARNED on what was actually charged for
       goods: 300 net less the 50 the points were worth, at the outlet's own
       rate. A guest must not earn points on the points they just spent, which
       is why the base is 250 and not 300 — earning on the gross would put 30
       here instead of 25. */
    const rate = await inBiz("SELECT (value->>'pointsPer') AS r FROM chain.setting"
      + " WHERE key = 'loyalty'");
    const earned = Math.floor(250 * Number((rate || {}).r || 0.1));
    assert.strictEqual(Number(m.points), 300 + earned,
      '500 granted, 200 redeemed, then earned on the 250 actually charged');
    assert.ok(earned > 0 && Number(m.points) < 330,
      'earned on net less the redemption, never on the gross');
    assert.strictEqual(Number(m.credit_used), 250, 'the credit tender is owed');
  });

test('none of it is visible to another customer', opts, async () => {
  /* The whole point of the boundary. A second business, created the same way,
     shares the app and the cluster and can reach none of it. */
  const other = await BIZ.createBusiness({ name: 'Reef Grill' });
  const theirs = db.ownerFor(other.db_name);

  const members = await theirs.query('SELECT count(*)::int AS n FROM chain.member');
  assert.strictEqual(members.rows[0].n, 0, 'no members leaked across');
  const sales = await theirs.query("SELECT count(*)::int AS n FROM information_schema.tables"
    + " WHERE table_schema LIKE 'outlet_%'");
  assert.strictEqual(sales.rows[0].n, 0, 'and not one of the first outlet’s schemas');

  // And the first business's outlet role cannot open the second's database.
  const { outletPassword } = require('../src/secrets');
  const { Client } = require('pg');
  const crossing = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: 'outlet_' + outletId + '_app', password: outletPassword(outletId),
    database: other.db_name
  });
  let crossed = null;
  try {
    await crossing.connect();
    await crossing.query('SELECT count(*) FROM chain.member');
    crossed = 'it read another business\'s members';
  } catch (e) {
    assert.match(e.message, /permission denied|does not exist|not permitted|authentication/i,
      'refused, naming a privilege: ' + e.message);
  } finally { await crossing.end().catch(() => {}); }
  assert.strictEqual(crossed, null, crossed || 'refused');
});

test('and the shop is still trading after all of it', opts, async () => {
  // /readyz checks out each active outlet's OWN login role, which is the whole
  // path a real request takes — not something the owner connection stands in for.
  const ready = await get('/readyz');
  assert.strictEqual(ready.status, 200, JSON.stringify(ready.body));

  const boot = await get('/api/outlet/' + outletId + '/bootstrap', tillToken);
  assert.strictEqual(boot.status, 200, 'the till still boots');
  assert.ok(boot.body.kpos, 'and gets its payload');
});

/* RETENTION SWEPT THE WRONG DATABASE, AND SILENCE LOOKED LIKE SUCCESS.

   /readyz was generalised to walk every business when the tenancy boundary
   moved; pruneHistory() was not. It kept calling owner() — the database this
   process happens to be dialled at, which in a registry install is one no
   customer trades in. So op_log, a replay window, and guest_request, a floor
   board, grew for ever in every real business, a row per op and a row per
   guest signal, on tables that are only ever appended to.

   Nothing showed. A prune that removes nothing logs nothing, and that is
   indistinguishable from "nothing was old enough yet" — which is why this
   needed an audit rather than an error. Proved here rather than asserted from
   the source, for the same reason: the only honest evidence is a row that was
   there and is not. */
test('retention reaches every business, not the one this process dialled', opts, async () => {
  const server = require('../server.js');
  assert.strictEqual(typeof server.pruneHistory, 'function');

  const c = await db.ownerFor(bizDb).connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL search_path = outlet_' + outletId + ', chain, public');
    await c.query("INSERT INTO op_log (op_id, lamport, client_at, kind, payload, applied_at)"
      + " VALUES (gen_random_uuid(), 1, now() - interval '200 days', 'audit_probe',"
      + " '{}'::jsonb, now() - interval '200 days'),"
      + " (gen_random_uuid(), 2, now() - interval '1 day', 'audit_probe',"
      + " '{}'::jsonb, now() - interval '1 day')");
    await c.query('COMMIT');
  } finally { c.release(); }

  const count = async () => Number((await db.ownerFor(bizDb).query(
    'SELECT count(*)::int AS n FROM outlet_' + outletId + '.op_log'
    + " WHERE kind = 'audit_probe'")).rows[0].n);
  assert.strictEqual(await count(), 2, 'both probes are in the BUSINESS database');

  await server.pruneHistory();

  assert.strictEqual(await count(), 1,
    'the 200-day row is gone and the 1-day row is not — so the sweep opened'
    + ' this business, which is the whole finding');

  // And it is on the trail, in that business's own audit table.
  const trail = await db.ownerFor(bizDb).query(
    "SELECT after FROM chain.audit WHERE action = 'history_pruned' ORDER BY at DESC LIMIT 1");
  assert.ok(trail.rows.length, 'a prune that removed something says so');
  assert.ok(Number(trail.rows[0].after.op_log) >= 1);
});

test('the cluster is left clean', opts, async () => {
  if (srv) await new Promise((res) => srv.close(res));
  await db.shutdown();
  const n = await DB.dropBusinessDatabases();
  assert.ok(n >= 2, 'both business databases existed and were swept');
});
