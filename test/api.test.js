'use strict';
/* ═══ THE SERVER SIDE OF THE CONTRACT ═══════════════════════════════════════
   Onboarding writes the records the running app reads. A sale settles once,
   whatever a flaky link does to the request. A rank cannot reach past itself.
   The trial balance squares.

   Everything here runs against a REAL Postgres, created fresh, migrated from
   nothing — because that is the path a deploy takes.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
/* THE SAME TABLE THE TILL AND THE SERVER BOTH READ. A fixture that spells its
   own quantities is a third opinion: these figures used to be written by hand
   as the PLATED amount, which is not what any real terminal has ever sent —
   a kitchen takes a whole fish off the shelf to plate 200g of fillet, and the
   till has always grossed up by the yield before queueing the move. The tests
   passed anyway, because the server accepted whatever it was given. */
const YIELD = require('../app/kashikeyo-yield.js');
const gross = (name, net) => YIELD.grossQty(YIELD.shipped(name), net);
const DB = require('./db');

DB.secrets();

/* A deploy has a public address, and the invitation refuses to compose a link
   without one — so the suite has one too. Set before `../server` loads, and
   left to the individual tests that clear it on purpose. */
if (!process.env.PUBLIC_URL) process.env.PUBLIC_URL = 'https://kashikeyopos.com';

const HAS_DB = DB.configured();
const opts = HAS_DB ? {} : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

let app, server, base, db;

test('the suite has a database', opts, async () => {
  await DB.freshDatabase(process.env.PGTESTDB || 'kashikeyo_test');
  /* Two databases, because that is the shape in production: the REGISTRY holds
     accounts and the business directory, and a BUSINESS database holds
     everything a till reads. One account may own several businesses, so
     "is this address known" cannot be asked of a business database. */
  await DB.freshControl(process.env.PGTESTCONTROL || 'kashikeyo_control_test');
  await DB.dropOutletRoles();
  // Required AFTER the environment is set: db.js reads it at module load.
  db = require('../src/db');
  const { migrate, migrateControl } = require('../src/scripts/migrate');
  await migrateControl(() => {});
  const n = await migrate(() => {});
  assert.ok(n >= 5, 'every migration applied to an empty database');
});

test('the server starts on an empty database and reports not-ready', opts, async () => {
  process.env.SKIP_MIGRATE = '1';
  process.env.PORT = '0';
  ({ app } = require('../server'));
  await new Promise((res) => { server = app.listen(0, res); });
  base = 'http://127.0.0.1:' + server.address().port;

  const ready = await get('/readyz');
  assert.strictEqual(ready.status, 200, 'the control plane answers');

  const install = await get('/api/auth/install');
  assert.strictEqual(install.body.ready, false, 'an empty install is not ready');
  assert.strictEqual(install.body.outlets.length, 0, 'no outlets yet');
  assert.strictEqual(install.body.merchant, null, 'no company yet');
});

let token, outletId;

test('a fresh install is claimed with a code, not by whoever gets there first',
  opts, async () => {
  /* chain.claim_first_owner() succeeds exactly ONCE in the life of an
     installation, and the three steps before it cannot be behind a staff
     session — the staff session is what step 3 creates. So they were behind
     nothing, and a new install's hostname is in the certificate transparency
     logs minutes after its first TLS handshake. Whoever POSTed first owned
     the business.

     Asserted here on the FENCE rather than on a completed claim, so the test
     proves the door without writing a company the next test then rewrites. */
  const prev = process.env.ONBOARDING_CLAIM_TOKEN;
  process.env.ONBOARDING_CLAIM_TOKEN = 'setup-code-for-this-install';
  try {
    const advertised = await get('/api/onboarding/state');
    assert.strictEqual(advertised.body.claimRequired, true,
      'the panel is told a code is wanted');
    assert.ok(!JSON.stringify(advertised.body).includes('setup-code-for-this-install'),
      'and never told what it is');

    const body = { legalName: 'Squatter Ltd', regNo: 'X-1', address: 'nowhere' };
    for (const [label, headers] of [
      ['with no code', {}],
      ['with the wrong code', { 'x-claim-token': 'setup-code-for-this-instal' }],
      ['with a longer wrong code', { 'x-claim-token': 'setup-code-for-this-installX' }]
    ]) {
      const r = await postWith('/api/onboarding/company', body, headers);
      assert.strictEqual(r.status, 403, 'the company step is refused ' + label);
      assert.strictEqual(r.body.claim, true, 'and says the refusal was the claim');
    }

    for (const step of ['outlet', 'owner']) {
      const r = await postWith('/api/onboarding/' + step, {}, {});
      assert.strictEqual(r.status, 403, 'the ' + step + ' step is fenced too');
    }

    /* The gate checks the code BEFORE the panel lets anybody type a company
       name. This build's rule about the store handle applies here too: a green
       tick must not be followed by a refusal on save. */
    assert.strictEqual((await postWith('/api/onboarding/claim', {}, {})).status, 403,
      'the gate refuses a missing code');
    assert.strictEqual((await postWith('/api/onboarding/claim', {},
      { 'x-claim-token': 'nope' })).status, 403, 'and a wrong one');
    assert.strictEqual((await postWith('/api/onboarding/claim', {},
      { 'x-claim-token': 'setup-code-for-this-install' })).status, 200,
    'and lets the right one through without writing anything');

    // With the code, the request reaches the handler — proved by the handler's
    // own validation refusing it, which is a 400 and not a 403.
    const through = await postWith('/api/onboarding/company', { legalName: 'X' },
      { 'x-claim-token': 'setup-code-for-this-install' });
    assert.strictEqual(through.status, 400,
      'the right code is let past the fence and stopped by the form');

    // asOwner, not one(): there is no outlet yet to scope a read to.
    const squatter = await asOwner(
      "SELECT count(*)::int AS n FROM chain.company WHERE legal_name = 'Squatter Ltd'");
    assert.strictEqual(squatter.n, 0, 'and the squatter wrote nothing');
  } finally {
    if (prev === undefined) delete process.env.ONBOARDING_CLAIM_TOKEN;
    else process.env.ONBOARDING_CLAIM_TOKEN = prev;
  }

  // Unset, the door is open again — an install onboarding itself on a counter
  // has no seller to get a code from, and that is a stated decision, not a
  // hole: the boot log says which of the two this install is.
  const open = await get('/api/onboarding/state');
  assert.strictEqual(open.body.claimRequired, false, 'and the fence is off by default');
});

test('onboarding writes the records the running app reads', opts, async () => {
  // 1 · company
  // This business IS registered for GST — everything below asserts GGST at 8%.
  // Registration is a stated fact now, not an assumption: a business that says
  // nothing is not registered, because most new ones are not.
  let r = await post('/api/onboarding/company', {
    legalName: 'Test Trading Pvt Ltd', regNo: 'C-0001/2026', gstRegistered: 'yes',
    tin: 'T1000001GST501', address: 'Test address, Malé'
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.gstRegistered, true, 'and it says so back');

  // The legal entity is required in full — but the TIN is required of a
  // REGISTERED business and of nobody else. Asking a business below the
  // threshold to invent one puts a false statement on every receipt it prints.
  const partial = await post('/api/onboarding/company', { legalName: 'X' });
  assert.strictEqual(partial.status, 400, 'an incomplete company is refused');
  assert.match(partial.body.error, /registration number/, partial.body.error);

  const claiming = await post('/api/onboarding/company', {
    legalName: 'X', regNo: 'C-1/2026', address: 'Somewhere', gstRegistered: 'yes'
  });
  assert.strictEqual(claiming.status, 400, 'registered, with no TIN, is refused');
  assert.match(claiming.body.error, /TIN is required/, claiming.body.error);

  // And it is claimed once: after that, edits go through Settings.
  const again2 = await post('/api/onboarding/company', {
    legalName: 'Someone Else', regNo: 'C-9999/2026', tin: 'X', address: 'Elsewhere'
  });
  assert.strictEqual(again2.status, 409, 'the company is already set');

  // 2 · first outlet — its own schema and its own login role
  r = await post('/api/onboarding/outlet', {
    name: 'Test Outlet', code: 'TSTO', kind: 'restaurant',
    taxCode: 'GGST', servicePct: 10, address: 'Test street'
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  outletId = r.body.id;
  assert.strictEqual(r.body.schema, 'outlet_' + outletId);

  // 3 · owner account — callable exactly once in the life of an installation
  r = await post('/api/onboarding/owner', { name: 'Test Owner', pin: '4718' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  token = r.body.token;
  assert.strictEqual(r.body.rank, 5);

  const again = await post('/api/onboarding/owner', { name: 'Impostor', pin: '0000' });
  assert.strictEqual(again.status, 409, 'a second owner cannot be claimed');

  // 4 · tax profile
  r = await post('/api/onboarding/tax', { code: 'GGST', rate: 8, from: '2026-01-01', servicePct: 10 }, token);
  assert.strictEqual(r.status, 200);

  // 5 · document series — renumberable only until they have issued a number
  r = await post('/api/onboarding/series', {
    series: [{ kind: 'SALE', prefix: 'TSTO-R', start: 500 }]
  }, token);
  assert.deepStrictEqual(r.body.refused, [], 'an unused series can be renumbered');

  // 6 · chart — confirm the bank and its opening position
  r = await post('/api/onboarding/chart', { bankCode: '1020', opening: 50000, asOf: '2026-01-01' }, token);
  assert.strictEqual(r.status, 200);

  // 8-11 · the records themselves, through the same handlers the app uses
  await post('/api/onboarding/locations', { locations: [
    { id: 'kitchen', name: 'Kitchen', kind: 'kitchen' },
    { id: 'dry', name: 'Dry store', kind: 'store' }
  ] }, token);
  await post('/api/onboarding/items', { items: [
    { id: 'ing_fish', name: 'Reef fish', cat: 'Seafood', base: 'g', stock: 'kg', factor: 1000, cost: 0.18, loc: 'dry', par: 20000 },
    { id: 'ing_rice', name: 'Basmati rice', cat: 'Dry', base: 'g', stock: 'kg', factor: 1000, cost: 0.032, loc: 'dry' },
    { id: 'ing_oil', name: 'Sunflower oil', cat: 'Dry', base: 'ml', stock: 'l', factor: 1000, cost: 0.028, loc: 'dry' }
  ] }, token);
  await post('/api/onboarding/sections', { sections: [{ id: 'food', name: 'Food', pos: 1 }] }, token);
  await post('/api/onboarding/categories', { categories: [
    { id: 'mains', name: 'Mains', section: 'food', pos: 1 },
    { id: 'sides', name: 'Sides', section: 'food', pos: 2 }
  ] }, token);
  await post('/api/onboarding/dishes', { dishes: [
    { id: 'm1', name: 'Grilled Reef Fish', cat: 'mains', price: 185, station: 'grill', recipe: [['ing_fish', 200, 4], ['ing_oil', 15, 0]] },
    { id: 'm2', name: 'Garlic Rice', cat: 'sides', price: 45, station: 'main', recipe: [['ing_rice', 120, 2], ['ing_oil', 10, 0]] },
    /* A DISH THE KITCHEN DOES NOT MAKE. Nobody writes a recipe for a bottle of
       water, and plenty of cafés write one for nothing at all — so this is the
       fixture for every test whose subject is the money rather than the shelf.
       Selling a dish that HAS a recipe while claiming no stock moved is not a
       café, it is a till that lost its expansion, and the server now says so. */
    { id: 'm3', name: 'Bottled water', cat: 'sides', price: 25, station: 'main', recipe: [] }
  ] }, token);
  await post('/api/onboarding/zones', { zones: [{ zones: [{ id: 'main', name: 'Main floor', pos: 1 }] }] }, token);
  await post('/api/onboarding/tables', { tables: [
    { id: 'T01', label: 'T01', zone: 'main', seats: 4, pos: 1 },
    { id: 'T02', label: 'T02', zone: 'main', seats: 2, pos: 2 },
    { id: 'T03', label: 'T03', zone: 'main', seats: 6, pos: 3 }
  ] }, token);

  // 12 · staff — and never above the writer's own rank
  r = await post('/api/onboarding/staff', { staff: [
    { name: 'Test Manager', rank: 3, pin: '7364', job: 'Outlet Manager', basic: 18000, hourly: 104, mrps: true },
    { name: 'Test Cashier', rank: 2, pin: '6520', job: 'Cashier', basic: 8200, hourly: 47, mrps: true }
  ] }, token);
  assert.strictEqual(r.body.staff.length, 2);

  // 13 · device, 14 · register
  r = await post('/api/auth/devices', { label: 'POS-1', kind: 'till' }, token);
  assert.strictEqual(r.status, 201);
  r = await post('/api/onboarding/register', { float: 1000 }, token);
  assert.strictEqual(r.status, 200);

  const state = await get('/api/onboarding/state', token);
  assert.strictEqual(state.body.done, true, 'all fourteen steps are done: '
    + JSON.stringify(state.body.steps.filter((x) => !x.done).map((x) => x.key)));
});

test('a series that has issued a number cannot be renumbered', opts, async () => {
  // Draw one number, then try to move the series.
  await push([{ opId: uuid(), kind: 'open_register', payload: { float: 0 } }]);
  const before = await post('/api/onboarding/series', {
    series: [{ kind: 'GRN', prefix: 'X', start: 1 }]
  }, token);
  assert.deepStrictEqual(before.body.refused, [], 'GRN has issued nothing yet');

  const v = await push([{ opId: uuid(), kind: 'vendor_upsert',
    payload: { name: 'Series Test Supplies', terms: 30 } }]);
  const got = await push([{ opId: uuid(), kind: 'grn_receive',
    payload: { vendor: v.body.results[0].result.vendorId, lines: [] } }]);
  assert.ok(got.body.results[0].result.no, 'the delivery drew a GRN number');

  const after = await post('/api/onboarding/series', {
    series: [{ kind: 'GRN', prefix: 'Y', start: 1 }]
  }, token);
  assert.deepStrictEqual(after.body.refused, ['GRN'],
    'a used series is refused — that is what makes the trail auditable');
});

test('a wrong PIN costs the caller, not the floor', opts, async () => {
  /* The lockout that shipped was outlet-wide and free to trigger: five POSTs
     from anybody killed every keypad in the building for fifteen minutes, on
     repeat. Two tiers now, and this asserts BOTH — that one caller can only
     lock itself, and that a distributed attempt still hits the old wall. */
  const LIMIT = require('../src/limit');
  const prev = process.env.RATE_LIMIT_SCALE;
  process.env.RATE_LIMIT_SCALE = '1';
  LIMIT._reset();
  const till = () => uuid();
  try {
    // TIER ONE. Six wrong PINs from one till, and that till is refused.
    const a = till();
    for (let i = 0; i < 6; i++) {
      const r = await post('/api/auth/pin', { outletId, pin: '0000', deviceId: a });
      assert.strictEqual(r.status, 401, 'wrong PIN ' + (i + 1) + ' is refused');
    }
    const seventh = await post('/api/auth/pin', { outletId, pin: '0000', deviceId: a });
    assert.strictEqual(seventh.status, 429, 'the seventh from that till is turned away');
    assert.match(seventh.body.error, /this terminal/i,
      'and it names the terminal, not the floor: ' + seventh.body.error);

    // The whole point: the counter beside it is still taking money.
    const beside = await post('/api/auth/pin', { outletId, pin: '4718' });
    assert.strictEqual(beside.status, 200,
      'the till beside it signs in — one caller cannot lock the building');

    // TIER TWO. Forty wrong PINs at one outlet is no longer somebody
    // mistyping, so the accounts themselves lock exactly as they always did.
    // Reaching it costs seven distinct callers rather than one request.
    for (let d = 0; d < 7; d++) {
      const dev = till();
      for (let i = 0; i < 6; i++) {
        await post('/api/auth/pin', { outletId, pin: '0000', deviceId: dev });
      }
    }
    const locked = await post('/api/auth/pin', { outletId, pin: '4718', deviceId: till() });
    assert.strictEqual(locked.status, 401, 'the right PIN is refused once the accounts lock');
    assert.match(locked.body.error, /locked/i, 'and it says so: ' + locked.body.error);
  } finally {
    // Unlock through the admin path, and give the doorman its allowance back,
    // so the rest of the suite is not standing behind this test's attack.
    const staff = await get('/api/auth/staff', token);
    for (const s of staff.body.staff) {
      await patch('/api/auth/staff/' + s.id, { unlock: true }, token);
    }
    process.env.RATE_LIMIT_SCALE = prev || '100';
    LIMIT._reset();
  }
  const ok = await post('/api/auth/pin', { outletId, pin: '4718' });
  assert.strictEqual(ok.status, 200, 'and it opens again once unlocked');
});

test('the roster is readable before sign-in, and carries no secret', opts, async () => {
  const r = await get('/api/auth/roster?outletId=' + outletId);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.staff.length >= 3);
  r.body.staff.forEach((s) => {
    assert.ok(s.name && s.initials, 'a face and a name');
    assert.strictEqual(s.pin, undefined, 'no PIN');
    assert.strictEqual(s.pin_hash, undefined, 'no hash');
    assert.strictEqual(s.pin_salt, undefined, 'no salt');
  });
});

test('a sale settles exactly once, however many times it is pushed', opts, async () => {
  // Stock first: a dish that sells must have something to consume.
  const vend = await push([{ opId: uuid(), kind: 'vendor_upsert', payload: { name: 'Test Supplies', terms: 30 } }]);
  const vendorId = vend.body.results[0].result.vendorId;
  await push([{ opId: uuid(), kind: 'grn_receive', payload: { vendor: vendorId, lines: [
    { ing: 'ing_fish', qty: 10000, price: 0.18, total: 1800 },
    { ing: 'ing_rice', qty: 20000, price: 0.032, total: 640 },
    { ing: 'ing_oil', qty: 5000, price: 0.028, total: 140 }
  ] } }]);

  const sub = 2 * 185 + 2 * 45;              // 460
  const svc = round(sub * 0.10);             // 46
  const tax = round((sub + svc) * 0.08);     // 40.48
  const raw = sub + svc + tax;
  const total = Math.round(raw * 2) / 2;     // cash rounds to the nearest 50 laari
  const rounding = round(total - raw);
  /* What the till really sends: the PURCHASED quantity needed to plate the
     recipe, grossed up by the ingredient's yield. And what it costs, at the
     figure the server will re-value it at anyway. */
  const gFish = gross('Reef fish', 2 * 200);
  const gOil = gross('Sunflower oil', 2 * 15 + 2 * 10);
  const gRice = gross('Basmati rice', 2 * 120);
  const cogs = round(round(gFish * 0.18) + round(gOil * 0.028) + round(gRice * 0.032));

  const op = {
    opId: uuid(), kind: 'sale', lamport: 10, at: Date.now(),
    payload: {
      bizDate: today(), channel: 'dine_in', covers: 4,
      sub: sub, disc: 0, net: sub, svc: svc, tax: tax, round: rounding, total: total,
      taxCode: 'GGST', taxLabel: 'GGST 8%', taxRate: 8, cogs: cogs,
      server: 'Test Cashier', cur: 'MVR', rate: 1, fgn: 0,
      sold: [
        { id: 'm1', name: 'Grilled Reef Fish', qty: 2, price: 185, amount: 370, cost: round(2 * (200 * 0.18 + 15 * 0.028)) },
        { id: 'm2', name: 'Garlic Rice', qty: 2, price: 45, amount: 90, cost: round(2 * (120 * 0.032 + 10 * 0.028)) }
      ],
      payments: [{ method: 'cash', amt: total, tendered: 600, chg: round(600 - total) }],
      stockMoves: [
        { ing: 'ing_fish', qty: gFish, cost: 0.18, value: round(gFish * 0.18) },
        { ing: 'ing_oil', qty: gOil, cost: 0.028, value: round(gOil * 0.028) },
        { ing: 'ing_rice', qty: gRice, cost: 0.032, value: round(gRice * 0.032) }
      ]
    }
  };

  const first = await push([op]);
  const r1 = first.body.results[0].result;
  assert.ok(r1.receiptNo, 'the receipt number was allocated on the server');
  assert.strictEqual(r1.repaired, false, 'the terminal\'s arithmetic tied');

  // Push the same op three more times — a flaky link, a retried outbox.
  await push([op]); await push([op, op]);

  const sales = await get('/api/outlet/' + outletId + '/sales', token);
  const mine = sales.body.sales.filter((s) => s.receipt_no === r1.receiptNo);
  assert.strictEqual(mine.length, 1, 'the sale exists exactly once');
  assert.strictEqual(sales.body.total, 1, 'and it is the only sale');

  // The chain, checked in the database rather than through the screen.
  const row = await one('SELECT * FROM sale WHERE receipt_no = $1', [r1.receiptNo]);
  assert.strictEqual(Number(row.covers), 4, 'covers = party size');
  assert.strictEqual(Number(row.net), sub, 'revenue is the post-discount net');
  assert.strictEqual(Number(row.tax_rate), 8, 'the rate in force is ON the row');
  assert.strictEqual(row.tax_label, 'GGST 8%', 'and so is its label');
  assert.strictEqual(String(row.business_date), today(), 'the trading day is recorded');
  assert.ok(Number(row.cogs) > 0, 'COGS came from the recipe');
  assert.strictEqual(round(Number(row.net) + Number(row.service) + Number(row.tax)
    + Number(row.rounding)), round(Number(row.total)), 'the row ties to itself');

  // Stock fell by exactly what the recipe consumed.
  const fish = await one("SELECT on_hand FROM ingredient WHERE id = 'ing_fish'");
  assert.ok(Math.abs(Number(fish.on_hand) - (10000 - gFish)) < 0.001,
    'the ingredient moved once, not four times — and by what the RECIPE says'
    + ' left the shelf: ' + fish.on_hand);

  // And the books square.
  const tb = await one('SELECT sum(dr) AS dr, sum(cr) AS cr FROM journal_line');
  assert.strictEqual(round(Number(tb.dr)), round(Number(tb.cr)), 'the trial balance squares');
});

test('a manual journal refuses the accounts the till owns', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'post_journal', payload: {
    memo: 'Trying to hand-key cash',
    lines: [{ acct: '1010', dr: 100 }, { acct: '6300', cr: 100 }]
  } }]);
  assert.ok(r.body.results[0].error, 'refused');
  assert.match(r.body.results[0].error, /till owns/i, r.body.results[0].error);

  const noMemo = await push([{ opId: uuid(), kind: 'post_journal', payload: {
    lines: [{ acct: '6300', dr: 100 }, { acct: '2100', cr: 100 }]
  } }]);
  assert.match(noMemo.body.results[0].error, /memo/i,
    'a manual entry without a reason is unauditable');

  const good = await push([{ opId: uuid(), kind: 'post_journal', payload: {
    memo: 'Accrue the audit fee', date: today(),
    lines: [{ acct: '6700', dr: 100 }, { acct: '2100', cr: 100 }]
  } }]);
  assert.ok(good.body.results[0].result.journalId, 'a proper entry posts');
});

test('an unbalanced journal cannot exist', opts, async () => {
  // Straight at the database, past the application's own balancing.
  await assert.rejects(async () => {
    await db.withOutlet({ outletId, rank: 5, actor: null }, async (c) => {
      const no = await c.query("SELECT chain.next_doc_no('JV') AS no");
      const j = await c.query('INSERT INTO journal (jv_no, entry_date, memo, source,'
        + " posted_by) VALUES ($1, current_date, 'unbalanced', 'test',"
        + " '00000000-0000-0000-0000-000000000000') RETURNING id", [no.rows[0].no]);
      await c.query("INSERT INTO journal_line (journal_id, account_code, dr)"
        + " VALUES ($1, '6300', 100)", [j.rows[0].id]);
    });
  }, /out of balance/, 'the deferred constraint trigger refuses it at COMMIT');
});

test('a rank cannot reach past itself', opts, async () => {
  const till = await post('/api/auth/pin', { outletId, pin: '6520' });
  assert.strictEqual(till.status, 200);
  const t2 = till.body.token;
  assert.strictEqual(till.body.rank, 2);

  // Rank 2 cannot list devices (manager), cannot add staff (admin), cannot
  // read the estate (owner).
  assert.strictEqual((await get('/api/auth/devices', t2)).status, 403);
  assert.strictEqual((await post('/api/auth/staff', { name: 'X', rank: 2, pin: '1111' }, t2)).status, 403);
  assert.strictEqual((await get('/api/estate/day', t2)).status, 403);
  assert.strictEqual((await get('/api/outlet/' + outletId + '/audit', t2)).status, 403);

  // And the refusal names the rank, so an operator learns what to ask for.
  const refused = await get('/api/auth/devices', t2);
  assert.match(refused.body.error, /Rank 3 required — Manager/, refused.body.error);

  // A rank-4 admin cannot mint a rank-5 owner.
  const mgr = await post('/api/auth/pin', { outletId, pin: '7364' });
  const t3 = mgr.body.token;
  const up = await post('/api/auth/staff', { name: 'Sneaky', rank: 5, pin: '9999' }, t3);
  assert.strictEqual(up.status, 403, 'rank 3 cannot create staff at all');
});

test('the outlet in the path must be the outlet in the token', opts, async () => {
  const other = outletId + 999;
  const r = await get('/api/outlet/' + other + '/bootstrap', token);
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /outlet mismatch/);
});

test('the bootstrap carries this outlet and no trade from anywhere else', opts, async () => {
  const r = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.strictEqual(r.status, 200);
  const k = r.body.kpos;
  assert.strictEqual(k.OUTLETS.length, 1, 'one outlet');
  assert.strictEqual(k.OUTLETS[0].rate, 8, 'the rate in force is resolved, not defaulted');
  assert.strictEqual(k.OUTLETS[0].tables, 3, 'the floor came with it');
  assert.strictEqual(k.MENU.length, 3, 'the menu came with it');
  // By id, not by position: a menu gains a dish and an index moves.
  assert.strictEqual((k.MENU.find((m) => m.id === 'm1') || {}).recipe.length, 2,
    'and its recipe');
  assert.strictEqual(k.ACCOUNTS.length, 38, 'the chart is complete');
  assert.strictEqual(k.MODULES, undefined, 'the module catalogue ships with the app, not the payload');
  assert.strictEqual(r.body.state.settled.length, 1, 'the one sale');
  assert.strictEqual(r.body.state.settled[0].outletId, outletId, 'labelled with its outlet');

  // Index 4 of the raw item tuple is the cost per STOCK unit: the recipe
  // explosion divides it by the conversion factor to reach a per-gram figure,
  // and a wrong index reports a food cost of 0.0%.
  const fish = r.body.raw.items.filter((i) => i[0] === 'ing_fish')[0];
  assert.strictEqual(fish[4], 180, 'cost per kilogram');
  assert.strictEqual(fish[7], 'g', 'base unit');
  assert.strictEqual(fish[8], 'kg', 'stock unit');
});

test('a guest posts intent and never money', opts, async () => {
  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;

  const t = await get('/api/g/' + slug + '/token?t=T01');
  assert.strictEqual(t.status, 200);
  const table = t.body.token;

  const menu = await getWith('/api/g/' + slug + '/menu', { 'x-table-token': table });
  assert.strictEqual(menu.status, 200);
  assert.ok(menu.body.items.length, 'the guest sees the menu');
  menu.body.items.forEach((i) => {
    assert.strictEqual(i.cost, undefined, 'a guest device never holds a cost');
    assert.strictEqual(i.margin, undefined, 'nor a margin');
  });
  assert.strictEqual(menu.body.staff, undefined, 'nor a staff record');

  const order = await postWith('/api/g/' + slug + '/order',
    { lines: [{ id: 'm1', qty: 1 }], name: 'A guest', opId: uuid() },
    { 'x-table-token': table });
  assert.strictEqual(order.status, 201);
  assert.strictEqual(order.body.status, 'awaiting till', 'the till decides');

  // An unknown handle is told so, rather than being landed somewhere else.
  const gone = await get('/api/g/no-such-store/token');
  assert.strictEqual(gone.status, 404);
  assert.match(gone.body.error, /not in use here any more/);
});

test('the guest projection carries the floor and only this table', opts, async () => {
  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token?t=T01');
  const table = t.body.token;
  const menu = await getWith('/api/g/' + slug + '/menu', { 'x-table-token': table });

  // The floor is the outlet's own. It used to be a count guessed on the phone,
  // which offered a six-table room a seat at table twelve.
  assert.ok(Array.isArray(menu.body.floor), 'the floor is published');
  assert.ok(menu.body.floor.length >= 1, 'and it has the outlet\'s tables in it');
  menu.body.floor.forEach((f) => {
    assert.ok(f.label, 'every table has the label the floor plan gave it');
    assert.strictEqual(typeof f.seats, 'number');
  });

  // Another table's bill is not this guest's business.
  await push([{ opId: uuid(), kind: 'add_line', payload: {
    table: 'T02', lines: [{ id: 'm1', qty: 1, name: 'Test dish', price: 100 }]
  } }]);
  const again = await getWith('/api/g/' + slug + '/menu', { 'x-table-token': table });
  again.body.tickets.forEach((tk) => {
    assert.strictEqual(tk.table_no, 'T01', 'a guest reads their OWN table only');
  });
  const ids = again.body.tickets.map((tk) => tk.id);
  again.body.stages.forEach((k) => {
    assert.ok(ids.indexOf(k.ticket_id) >= 0,
      "another table's ticket in the kitchen is not this guest's business");
  });
});

test('a member reaches their own card and nobody else\'s', opts, async () => {
  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token');
  const table = { 'x-table-token': t.body.token };

  // Two members, so "their own" is a claim with something to be wrong about.
  await one("INSERT INTO chain.member (phone, name, email, points)"
    + " VALUES ('7770001','Member One','one@example.mv',100),"
    + " ('7770002','Member Two','two@example.mv',900)"
    + ' ON CONFLICT (phone) DO NOTHING');

  // Whether a number is a customer here is not a question a stranger may ask:
  // the answer is the same either way.
  const unknown = await postWith('/api/g/' + slug + '/member/start',
    { id: '7000000' }, table);
  const known = await postWith('/api/g/' + slug + '/member/start',
    { id: '7770001' }, table);
  assert.strictEqual(unknown.status, known.status);
  assert.deepStrictEqual(Object.keys(unknown.body).sort(), Object.keys(known.body).sort());

  // A wrong code is refused; the right one is spent on use.
  const wrong = await postWith('/api/g/' + slug + '/member/verify',
    { id: '7770001', code: '0000' }, table);
  assert.strictEqual(wrong.status, 401);

  const code = process.env.MEMBER_CODE_ECHO === '1' ? known.body.code : null;
  if (!code) {
    // Without the echo the code is only readable at the counter, which is the
    // point. Set it and re-issue so the rest of the path is still exercised.
    process.env.MEMBER_CODE_ECHO = '1';
  }
  const issued = await postWith('/api/g/' + slug + '/member/start',
    { id: '7770001' }, table);
  const ok = await postWith('/api/g/' + slug + '/member/verify',
    { id: '7770001', code: issued.body.code }, table);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token, 'a member token is minted');

  const replay = await postWith('/api/g/' + slug + '/member/verify',
    { id: '7770001', code: issued.body.code }, table);
  assert.strictEqual(replay.status, 401, 'a used code is spent');

  const me = await getWith('/api/g/' + slug + '/member/me',
    { 'x-member-token': ok.body.token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.member.name, 'Member One');
  assert.strictEqual(me.body.member.phone, '7770001');
  assert.ok(Array.isArray(me.body.receipts), 'their own receipts, and only those');
  me.body.receipts.forEach((r) => assert.ok(r.receipt_no));

  // No token, no card. A table token is not a member token.
  const bare = await get('/api/g/' + slug + '/member/me');
  assert.strictEqual(bare.status, 401);
  const wrongKind = await getWith('/api/g/' + slug + '/member/me',
    { 'x-member-token': t.body.token });
  assert.strictEqual(wrongKind.status, 401,
    'a table token cannot read a membership');
});

/* ═══ THE BUSINESS DATE IS THE OUTLET'S ═════════════════════════════════════
   `current_date` and `toISOString()` are both UTC, and Malé is UTC+5. So from
   19:00 local — most of a restaurant's trading — every business date, document
   number and settlement key was filed under YESTERDAY, while the clock in the
   terminal's own header said tonight. A GST return keyed on that is wrong for
   roughly a third of every day's takings.
   ═══════════════════════════════════════════════════════════════════════ */
test('the business date is the outlet\'s local date, not the container\'s',
  opts, async () => {
    // What the outlet's own clock says, asked of the database inside a normal
    // request — which is where every defaulted business_date comes from.
    const local = await one("SELECT current_date::text AS d,"
      + " current_setting('timezone') AS tz");
    assert.strictEqual(local.tz, 'Indian/Maldives',
      'the transaction adopted the outlet\'s zone, not the container\'s');

    const utc = new Date().toISOString().slice(0, 10);
    const maldives = new Intl.DateTimeFormat('en-CA',
      { timeZone: 'Indian/Maldives' }).format(new Date());
    assert.strictEqual(local.d, maldives,
      'and current_date is the Malé date');

    // The evening case, stated rather than waited for: 21:00 Malé on any day
    // is still 16:00 UTC the same day, but 01:00 Malé is 20:00 UTC the day
    // BEFORE — which is the direction that used to lose a night's trading.
    const evening = new Date(Date.UTC(2026, 7, 21, 19, 30));  // 00:30 Malé, the 22nd
    assert.strictEqual(evening.toISOString().slice(0, 10), '2026-08-21',
      'UTC calls that the 21st');
    assert.strictEqual(new Intl.DateTimeFormat('en-CA',
      { timeZone: 'Indian/Maldives' }).format(evening), '2026-08-22',
    'the outlet calls it the 22nd, and the outlet is right');

    // Every `business_date date NOT NULL DEFAULT current_date` in the outlet
    // plane resolves against that same session, so proving the session is on
    // Malé time proves the defaults are — there is only the one clock to get
    // right, which is the point of setting it in one place.
    const dflt = await one("SELECT column_default FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'ticket'"
      + " AND column_name = 'business_date'");
    assert.match(String(dflt.column_default), /CURRENT_DATE/i,
      'the column still defaults to the session date rather than a stored string');
    assert.notStrictEqual(maldives, undefined);
    void utc;
  });

test('a row filed under UTC is refiled on the outlet\'s day', opts, async () => {
  // Exactly the rows the old code left behind: a sale whose timestamp is
  // 20:00 UTC — 01:00 the NEXT day in Malé — carrying the UTC date.
  const at = '2026-03-10T20:00:00Z';
  const staff = await one('SELECT id FROM chain.staff LIMIT 1');
  await one("INSERT INTO sale (receipt_no, at, business_date, channel, covers,"
    + " subtotal, discount, net, service, tax_code, tax_label, tax_rate, tax,"
    + " rounding, total, tip, cogs, currency, fx_rate, fx_amount, server_name,"
    + " closed_by)"
    + " VALUES ('BIZDATE-TEST', $1::timestamptz, '2026-03-10', 'dine_in', 1,"
    + " 100,0,100,0,'NONE','NONE',0,0,0,100,0,0,'MVR',1,0,'Test',$2)",
  [at, staff.id]);

  // The migration runner will not re-run a file it has already applied, so
  // this drives the migration's own SQL rather than the runner — what is
  // being tested is the repair, not the bookkeeping around it.
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '016_business_date_local.sql'), 'utf8');
  await db.owner().query(sql);

  const row = await one("SELECT business_date::text AS d FROM sale"
    + " WHERE receipt_no = 'BIZDATE-TEST'");
  assert.strictEqual(row.d, '2026-03-11',
    'refiled onto the Mal\u00e9 day the money actually changed hands');

  // Idempotent: running it again moves nothing.
  await db.owner().query(sql);
  const again = await one("SELECT business_date::text AS d FROM sale"
    + " WHERE receipt_no = 'BIZDATE-TEST'");
  assert.strictEqual(again.d, '2026-03-11', 'and re-running it is free');
});

/* ═══ HOW A CUSTOMER GETS IN ════════════════════════════════════════════════
   The whole member portal — the card, the points, the order tracker, the
   receipts — assumed a `chain.member` row existed. Nothing in the build ever
   created one. The till's "Add customer" queued a kind with no handler and no
   payload, so `applyOp` recorded it as unmodelled and answered success: the
   toast said the customer was created and the row lived in one browser.

   So nobody could be invited and nobody could sign in, on any real install.
   ═══════════════════════════════════════════════════════════════════════ */
test('a customer taken at the counter reaches the outlet, and can sign in',
  opts, async () => {
    const phone = '9998877';
    const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Aishath Waheed', phone: phone, email: 'aishath@example.mv',
      tier: 'Silver', credit: 500
    } }]);
    const res = r.body.results[0].result;
    assert.ok(res.memberId, 'the outlet holds the customer');
    assert.strictEqual(res.created, true, 'and this one is new');

    const row = await one('SELECT * FROM chain.member WHERE phone = $1', [phone]);
    assert.strictEqual(row.name, 'Aishath Waheed', 'by name');
    assert.strictEqual(Number(row.credit_limit), 500, 'with the credit the manager granted');
    assert.strictEqual(Number(row.points), 0,
      'and no points — those are the outlet\'s to award, never the till\'s to send');

    // A replayed outbox is one customer, not two. The phone is the identity.
    const again = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Aishath Waheed', phone: phone, tier: 'Gold', credit: 750
    } }]);
    assert.strictEqual(again.body.results[0].result.created, false, 'the second is an update');
    const n = await one('SELECT count(*)::int AS n FROM chain.member WHERE phone = $1', [phone]);
    assert.strictEqual(n.n, 1, 'one customer, however many times the till sent them');
    const up = await one('SELECT credit_limit FROM chain.member WHERE phone = $1', [phone]);
    assert.strictEqual(Number(up.credit_limit), 750, 'and the update landed');
    // The tier the till sent went nowhere, because there is nowhere for it to
    // go: it is derived from points against the published ladder every time it
    // is read (migration 019).
    const cols = await one("SELECT count(*)::int AS n FROM information_schema.columns"
      + " WHERE table_schema = 'chain' AND table_name = 'member'"
      + " AND column_name = 'tier'");
    assert.strictEqual(cols.n, 0, 'a cache nothing reads is a second answer waiting to be believed');

    // The invite, on a named channel. It carries a LINK — one token, whichever
    // channel takes it — and says honestly whether anything was sent.
    const inv = await post('/api/outlet/' + outletId + '/member/' + res.memberId
      + '/invite', { via: 'email' }, token);
    assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
    assert.match(String(inv.body.link), /\/join\/MV-[A-Za-z0-9]+-\d+/,
      'the link the SERVER spelled: ' + inv.body.link);
    assert.strictEqual(inv.body.via, 'email', 'and it says which channel it went on');
    assert.strictEqual(inv.body.to, 'aishath@example.mv', 'to the address on the membership');
    assert.strictEqual(inv.body.count, 1, 'the first invitation');
    assert.strictEqual(inv.body.sent, false, 'no transport here, and it does not pretend');
    assert.ok(inv.body.reason, 'and it says why');
    assert.ok(String(inv.body.body).indexOf(inv.body.link) >= 0,
      'the message carries the link it was composed around');
    // The card's own address is still spelled, for a counter that would rather
    // point than send. Never the QR portal's path with /member glued on, which
    // routes nowhere.
    assert.match(String(inv.body.url), /(^\/m\/[a-z0-9-]+$)|(^https:\/\/[a-z0-9-]+\..+\/member$)/,
      'the address the SERVER spelled: ' + inv.body.url);

    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const slug = b.body.kpos.OUTLETS[0].slug;
    const t = await get('/api/g/' + slug + '/token');
    const table = { 'x-table-token': t.body.token };
    const tok = /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(inv.body.link)[1];

    // Tapping it names the card and nothing more. It does not sign anybody in.
    const land = await postWith('/api/g/' + slug + '/member/join', { token: tok }, table);
    assert.strictEqual(land.status, 200, JSON.stringify(land.body));
    assert.strictEqual(land.body.first, 'Aishath', 'their own name, from the token');
    assert.strictEqual(land.body.state, 'fresh', 'seven days is not two');
    assert.ok(!land.body.token, 'a landing is not a session');

    // "Send my code" spends the token and sends to the address ON THE
    // MEMBERSHIP, whatever the request body says.
    const ask = await postWith('/api/g/' + slug + '/member/join/code',
      { token: tok, id: 'someone@else.mv' }, table);
    assert.strictEqual(ask.status, 200, JSON.stringify(ask.body));
    assert.strictEqual(ask.body.id, 'aishath@example.mv',
      'the address on the membership, never one carried in the request');
    // Read off the floor board, the way a server reads it to a guest — the
    // response carries it only under MEMBER_CODE_ECHO, and an earlier test in
    // this file turns that on for the rest of the run.
    const code = await boardCode('Aishath Waheed');
    assert.match(code, /^\d{4}$/, 'four digits, on the floor board');

    const ok = await postWith('/api/g/' + slug + '/member/verify',
      { id: phone, code: code }, table);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token, 'and that code opens the card');

    // Spent on use, exactly like the one they request themselves.
    const replay = await postWith('/api/g/' + slug + '/member/verify',
      { id: phone, code: code }, table);
    assert.strictEqual(replay.status, 401, 'the code is spent');
    // And so is the link.
    const spent = await postWith('/api/g/' + slug + '/member/join/code',
      { token: tok }, table);
    assert.strictEqual(spent.status, 410, 'the invitation works once');

    // And the till now reports something it actually knows: they have been in.
    const b2 = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const me = (b2.body.kpos.CUSTOMERS || []).find((c) => c.phone === phone);
    assert.ok(me, 'the customer is on the terminal');
    assert.match(String(me.seen), /^\d{4}-\d{2}-\d{2}$/,
      'signed in on a real date — not an invented "Registered" flag');
  });

/* ═══ CREDIT IS A BALANCE THE SERVER KEEPS ═══════════════════════════════════
   A house account has a limit, and it used to be decoration: the till promised
   a Postgres trigger would reject an over-limit charge "offline or not", and
   there was no trigger, no CHECK, no per-member balance. Now the server keeps
   the outstanding figure — a credit sale raises it, a settlement lowers it —
   and an overrun is STAMPED, not rejected, because a sale that already happened
   is never thrown away (migration 028). ═════════════════════════════════════ */
test('a credit sale moves the balance, and an overrun is recorded not rejected',
  opts, async () => {
    const phone = '9995500';
    const made = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Credit Customer', phone: phone, credit: 300 } }]);
    const mid = made.body.results[0].result.memberId;
    const used = () => one('SELECT credit_used FROM chain.member WHERE id = $1', [mid])
      .then((r) => Number(r.credit_used));

    assert.strictEqual(await used(), 0, 'a fresh account owes nothing');

    // A charge within the limit raises the balance and stamps nothing.
    const within = await push([{ opId: uuid(), kind: 'sale', payload: {
      bizDate: today(), covers: 1, sub: 200, disc: 0, net: 200, svc: 0,
      tax: 0, round: 0, total: 200, taxCode: 'NONE', taxLabel: '', taxRate: 0,
      member: mid, customer: 'Credit Customer',
      sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 200, amount: 200 }],
      payments: [{ method: 'credit', amt: 200 }], stockMoves: []
    } }]);
    assert.ok(!within.body.results[0].error, JSON.stringify(within.body.results[0]));
    assert.strictEqual(await used(), 200, 'the outstanding balance rose by the charge');
    const s1 = await one('SELECT server_audit FROM sale WHERE id = $1',
      [within.body.results[0].result.saleId]);
    assert.strictEqual(s1.server_audit, null, 'within the limit, nothing to answer for');

    // A second charge takes them past the 300 limit. The sale still posts — a
    // cashier does not un-serve a meal — but the overrun is on the row and the
    // trail, never silent.
    const over = await push([{ opId: uuid(), kind: 'sale', payload: {
      bizDate: today(), covers: 1, sub: 150, disc: 0, net: 150, svc: 0,
      tax: 0, round: 0, total: 150, taxCode: 'NONE', taxLabel: '', taxRate: 0,
      member: mid, customer: 'Credit Customer',
      sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 150, amount: 150 }],
      payments: [{ method: 'credit', amt: 150 }], stockMoves: []
    } }]);
    assert.ok(!over.body.results[0].error, 'the sale is NOT rejected: ' + JSON.stringify(over.body.results[0]));
    assert.strictEqual(await used(), 350, 'the balance carries the full charge, over limit and all');
    const s2 = await one('SELECT server_audit FROM sale WHERE id = $1',
      [over.body.results[0].result.saleId]);
    assert.ok(s2.server_audit && s2.server_audit.credit_over, 'the overrun is stamped on the sale');
    assert.strictEqual(Number(s2.server_audit.credit_over.over), 50, 'by exactly the amount over');
    const trail = await asOwner("SELECT count(*)::int AS n FROM chain.audit"
      + " WHERE action = 'credit_over_limit' AND entity_id = $1", [mid]);
    assert.strictEqual(trail.n, 1, 'and on the audit trail once');

    // A settlement lowers the balance; it can never drive it below zero.
    await push([{ opId: uuid(), kind: 'settle_credit', payload: {
      member: mid, amt: 350, method: 'cash' } }]);
    assert.strictEqual(await used(), 0, 'paid in full, the account owes nothing again');
    await push([{ opId: uuid(), kind: 'settle_credit', payload: {
      member: mid, amt: 50, method: 'cash' } }]);
    assert.strictEqual(await used(), 0, 'a settlement never floors below zero');

    // The bootstrap publishes the real outstanding — charges minus settlements —
    // so the till's own gate reads the truth, not just the sum of charges.
    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const pub = (b.body.kpos.CUSTOMERS || []).find((cu) => cu.id === mid);
    assert.ok(pub, 'the customer is published');
    assert.strictEqual(Number(pub.used), 0, 'and their published balance is net of settlement');
  });

/* ═══ AN INVITATION IS AN EVENT ══════════════════════════════════════════
   Channel, address, sender, time, count, and a revocation that KEEPS the
   history. Each of those was a boolean, and on a row where the field was
   simply absent it claimed the customer already had access. ═══════════════ */
/* AN EMAIL IS A SECOND IDENTITY. Both sign-in functions resolve a member with
   `phone = $1 OR lower(email) = lower($1)` and take one row silently, so two
   customers on one address is one guest being let into another's card. That
   was survivable only while no screen could enter an email; the till has the
   field now. ═══════════════════════════════════════════════════════════════ */
test('an address reaches the outlet, and signs its owner in', opts, async () => {
  const phone = '9997733';
  const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Aminath Shifa', phone: phone, email: 'Shifa@Example.MV'
  } }]);
  const id = r.body.results[0].result.memberId;
  const row = await one('SELECT email FROM chain.member WHERE id = $1', [id]);
  assert.strictEqual(row.email, 'shifa@example.mv',
    'stored lower-cased, because the sign-in lookup is case-insensitive');

  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const me = (b.body.kpos.CUSTOMERS || []).find((c) => c.phone === phone);
  assert.strictEqual(me.email, 'shifa@example.mv', 'and it reaches the till');

  // The address is the half the Email invitation needs, and it works.
  const inv = await post('/api/outlet/' + outletId + '/member/' + id
    + '/invite', { via: 'email' }, token);
  assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
  assert.strictEqual(inv.body.to, 'shifa@example.mv', 'sent to the address on file');

  // And it signs them in — either half of the membership does.
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token');
  const table = { 'x-table-token': t.body.token };
  const tok = /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(inv.body.link)[1];
  await postWith('/api/g/' + slug + '/member/join/code', { token: tok }, table);
  const code = await boardCode('Aminath Shifa');
  const ok = await postWith('/api/g/' + slug + '/member/verify',
    { id: 'SHIFA@example.mv', code: code }, table);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
});

test('one address cannot sign two customers in', opts, async () => {
  const first = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Ahmed Niyaz', phone: '9996611', email: 'shared@example.mv'
  } }]);
  assert.ok(first.body.results[0].result.memberId, 'the first holds it');

  const second = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Hawwa Latheefa', phone: '9996622', email: 'SHARED@example.mv'
  } }]);
  const res = second.body.results[0].result;
  assert.ok(res.refused, 'the second is refused: ' + JSON.stringify(res));
  assert.match(String(res.refused), /Ahmed Niyaz/,
    'and it names who already holds it, so the counter can ask');

  // Refused, not half-written: the customer still exists on their phone number,
  // which is the identity, and simply has no address.
  const row = await one('SELECT id, email FROM chain.member WHERE phone = $1',
    ['9996622']);
  assert.ok(!row, 'nothing was written under a refused address');

  const n = await one("SELECT count(*)::int AS n FROM chain.member"
    + " WHERE lower(email) = 'shared@example.mv'");
  assert.strictEqual(n.n, 1, 'one row holds it, whatever the till sent');
});

test('updating a customer keeps their own address', opts, async () => {
  const phone = '9995500';
  await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Ismail Waheed', phone: phone, email: 'ismail@example.mv'
  } }]);
  // A resend of the same row is not a clash with itself.
  const again = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Ismail Waheed', phone: phone, email: 'ismail@example.mv', credit: 750
  } }]);
  assert.ok(!again.body.results[0].result.refused,
    'a customer is not refused their own address: '
    + JSON.stringify(again.body.results[0].result));
  const row = await one('SELECT email, credit_limit FROM chain.member'
    + ' WHERE phone = $1', [phone]);
  assert.strictEqual(row.email, 'ismail@example.mv', 'and it survives the update');
  assert.strictEqual(Number(row.credit_limit), 750, 'along with what changed');
});

test('correcting a phone number renames the customer, it does not fork them',
  opts, async () => {
    const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Shifana Adam', phone: '9994400', credit: 300
    } }]);
    const id = r.body.results[0].result.memberId;

    // A waiter mistyped the last digit and fixes it. Keyed on phone alone this
    // INSERTED a second customer and left the first holding the credit.
    const fix = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      id: id, name: 'Shifana Adam', phone: '9994411', credit: 300
    } }]);
    assert.strictEqual(fix.body.results[0].result.memberId, id, 'the same customer');
    assert.strictEqual(fix.body.results[0].result.created, false, 'renamed, not created');

    const n = await one("SELECT count(*)::int AS n FROM chain.member"
      + " WHERE name = 'Shifana Adam'");
    assert.strictEqual(n.n, 1, 'one customer, not two');
    const row = await one('SELECT phone, credit_limit FROM chain.member WHERE id = $1', [id]);
    assert.strictEqual(row.phone, '9994411', 'on the corrected number');
    assert.strictEqual(Number(row.credit_limit), 300,
      'and the credit facility travelled with them rather than being stranded');

    // Two customers cannot share a number any more than an address.
    const other = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Nashid Hassan', phone: '9994422'
    } }]);
    const otherId = other.body.results[0].result.memberId;
    const clash = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      id: otherId, name: 'Nashid Hassan', phone: '9994411'
    } }]);
    assert.match(String(clash.body.results[0].result.refused || ''), /Shifana Adam/,
      'refused by name: ' + JSON.stringify(clash.body.results[0].result));
  });

test('an invitation records the channel, and refuses one with no address by name',
  opts, async () => {
    const phone = '9995544';
    // No email on this one: taken at the counter with a number, which is the
    // normal customer and exactly the row the old flag lied about.
    const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Hassan Moosa', phone: phone
    } }]);
    const id = r.body.results[0].result.memberId;

    const no = await post('/api/outlet/' + outletId + '/member/' + id
      + '/invite', { via: 'email' }, token);
    assert.strictEqual(no.status, 409, JSON.stringify(no.body));
    assert.match(String(no.body.error), /Hassan Moosa/,
      'refused BY NAME, so the counter knows whose record to fix');
    assert.match(String(no.body.error), /email/, 'and which address is missing');

    // Viber rides the mobile number they already gave, so it goes through.
    const v = await post('/api/outlet/' + outletId + '/member/' + id
      + '/invite', { via: 'viber' }, token);
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    assert.strictEqual(v.body.to, phone, 'on the number already on file');
    assert.strictEqual(v.body.sent, false, 'Viber is recorded, not wired');

    const row = await one('SELECT invited_via, invited_to, invite_count, invited_by'
      + ' FROM chain.member WHERE id = $1', [id]);
    assert.strictEqual(row.invited_via, 'viber', 'the channel is on the row');
    assert.strictEqual(row.invited_to, phone, 'with the address it went to');
    assert.strictEqual(row.invite_count, 1, 'and how many times');
    assert.ok(row.invited_by, 'and who handed it over');

    // A channel this build has never heard of is refused before anything moves.
    const junk = await post('/api/outlet/' + outletId + '/member/' + id
      + '/invite', { via: 'telegram' }, token);
    assert.strictEqual(junk.status, 400, 'a channel that does not exist is not a send');
  });

test('sending again reissues the link, so the forwarded one stops working',
  opts, async () => {
    const phone = '9993311';
    const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Fathimath Nasr', phone: phone
    } }]);
    const id = r.body.results[0].result.memberId;

    const first = await post('/api/outlet/' + outletId + '/member/' + id
      + '/invite', { via: 'whatsapp' }, token);
    const second = await post('/api/outlet/' + outletId + '/member/' + id
      + '/invite', { via: 'whatsapp' }, token);
    assert.strictEqual(second.body.count, 2, 'the row counts the sends');
    assert.notStrictEqual(first.body.link, second.body.link, 'a fresh token each time');

    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const slug = b.body.kpos.OUTLETS[0].slug;
    const t = await get('/api/g/' + slug + '/token');
    const table = { 'x-table-token': t.body.token };
    const tokOf = (x) => /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(x.body.link)[1];

    // The first link is dead the moment the second is issued: an invitation
    // forwarded to the wrong person stops working.
    const stale = await postWith('/api/g/' + slug + '/member/join',
      { token: tokOf(first) }, table);
    assert.strictEqual(stale.status, 404, 'the replaced token resolves to nothing');

    const live = await postWith('/api/g/' + slug + '/member/join',
      { token: tokOf(second) }, table);
    assert.strictEqual(live.status, 200, JSON.stringify(live.body));
    assert.strictEqual(live.body.first, 'Fathimath');
  });

/* Fix 22, and it bit hard in the prototype: the reader took `?t=` first and
   shape-checked only the path. `?t=` is the table on the QR portal, the
   hosting environment's own session token, and the parameter every email
   click-wrapper appends — so the canonical path was unreachable and a foreign
   credential went into a membership lookup. */
test('a token is validated on every branch, and ?t= is never one', opts, async () => {
  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token');
  const table = { 'x-table-token': t.body.token };

  for (const junk of ['', '7', 'MV-nodigits', 'MV--1', '../../etc/passwd',
    t.body.token, 'MV-abc-1x']) {
    const r = await postWith('/api/g/' + slug + '/member/join',
      { token: junk }, table);
    assert.strictEqual(r.status, 400,
      'nothing shaped wrong reaches the database: ' + JSON.stringify(junk));
  }
  // Correctly shaped and simply not ours is a different answer, and it is the
  // same one an expired invitation gets — this endpoint must not become a way
  // to ask whether an invitation ever existed.
  const nope = await postWith('/api/g/' + slug + '/member/join',
    { token: 'MV-neverminted-1' }, table);
  assert.strictEqual(nope.status, 404, JSON.stringify(nope.body));
});

/* An invitation IS a link, so a deploy that cannot spell an absolute one has
   no invitation to send. A message carrying `/join/MV-...` reaches an inbox
   with nothing to resolve it against, and the guest holds a link that does
   nothing while the row says they were invited. */
test('an invitation is refused where no link can be spelled', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Yoosuf Manik', phone: '9996600'
  } }]);
  const id = r.body.results[0].result.memberId;

  // A good one first, so there is a live token to protect.
  const good = await post('/api/outlet/' + outletId + '/member/' + id + '/invite',
    { via: 'viber' }, token);
  assert.strictEqual(good.status, 200, JSON.stringify(good.body));
  const tok = /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(good.body.link)[1];

  const pub = process.env.PUBLIC_URL, pbd = process.env.PORTAL_BASE_DOMAIN;
  delete process.env.PUBLIC_URL;
  process.env.PORTAL_BASE_DOMAIN = '';
  try {
    const no = await post('/api/outlet/' + outletId + '/member/' + id + '/invite',
      { via: 'viber' }, token);
    assert.strictEqual(no.status, 503, JSON.stringify(no.body));
    assert.match(String(no.body.error), /PUBLIC_URL/,
      'and it names what to set: ' + no.body.error);
  } finally {
    if (pub) process.env.PUBLIC_URL = pub; else delete process.env.PUBLIC_URL;
    if (pbd === undefined) delete process.env.PORTAL_BASE_DOMAIN;
    else process.env.PORTAL_BASE_DOMAIN = pbd;
  }

  /* And it refused BEFORE minting. `chain.member_invite()` replaces the live
     token, so a refusal after it would kill a working invitation in order to
     report a broken one. */
  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token');
  const still = await postWith('/api/g/' + slug + '/member/join', { token: tok },
    { 'x-table-token': t.body.token });
  assert.strictEqual(still.status, 200,
    'the invitation that already worked still works');
  assert.strictEqual(still.body.first, 'Yoosuf');

  const row = await one('SELECT invite_count FROM chain.member WHERE id = $1', [id]);
  assert.strictEqual(row.invite_count, 1, 'and the refusal counted as no send');
});

test('the landing knows the guest, and expiry is not a dead end', opts, async () => {
  const phone = '9998811';
  const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Aminath Rasheedha', phone: phone, email: 'rasheedha@example.mv'
  } }]);
  const id = r.body.results[0].result.memberId;
  await one('UPDATE chain.member SET points = 1842 WHERE id = $1', [id]);

  const inv = await post('/api/outlet/' + outletId + '/member/' + id
    + '/invite', { via: 'email' }, token);
  const tok = /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(inv.body.link)[1];
  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token');
  const table = { 'x-table-token': t.body.token };

  const fresh = await postWith('/api/g/' + slug + '/member/join', { token: tok }, table);
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
  assert.strictEqual(fresh.body.state, 'fresh', 'seven days out');
  assert.strictEqual(fresh.body.first, 'Aminath', 'the first name, for the greeting');
  assert.strictEqual(fresh.body.points, 1842, 'their real balance');
  /* TOLD, not derived. A browser arriving cold on a link has never been sent a
     programme, so a page working this out itself quoted a guest holding 1,842
     points a worth of zero. */
  assert.match(String(fresh.body.worth), /^[A-Z]{3} [\d,]+$/, fresh.body.worth);
  assert.notStrictEqual(fresh.body.worth.replace(/\D/g, ''), '0',
    'the outlet is asked what a point is worth: ' + fresh.body.worth);
  assert.strictEqual(fresh.body.invitedBy, 'Test Owner',
    'a person to ask for at the counter, not a handle');

  // Inside two days it warns; past seven it lapses — and a lapse still
  // resolves, because the membership is real and a dead end would say
  // otherwise.
  await one("UPDATE chain.member SET invite_token_exp = now() + interval '1 day'"
    + ' WHERE id = $1', [id]);
  const soon = await postWith('/api/g/' + slug + '/member/join', { token: tok }, table);
  assert.strictEqual(soon.body.state, 'expiring', JSON.stringify(soon.body));
  assert.strictEqual(soon.body.left, 1, 'one day is "tomorrow" on the strip');

  await one("UPDATE chain.member SET invite_token_exp = now() - interval '1 day'"
    + ' WHERE id = $1', [id]);
  const late = await postWith('/api/g/' + slug + '/member/join', { token: tok }, table);
  assert.strictEqual(late.status, 200, 'a lapsed link is not a 404');
  assert.strictEqual(late.body.state, 'lapsed');
  assert.strictEqual(late.body.to, 'rasheedha@example.mv',
    'and it carries the address, so the ordinary sign-in arrives pre-filled');

  // A lapsed link cannot mint a code, however it is asked.
  const no = await postWith('/api/g/' + slug + '/member/join/code',
    { token: tok }, table);
  assert.strictEqual(no.status, 410, JSON.stringify(no.body));
});

test('what a guest was told is audited apart from the fact they were told',
  opts, async () => {
    const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Nashwa Ibrahim', phone: '9997722'
    } }]);
    const id = r.body.results[0].result.memberId;
    await post('/api/outlet/' + outletId + '/member/' + id + '/invite',
      { via: 'viber' }, token);

    const body = await asOwner('SELECT after FROM chain.audit'
      + " WHERE action = 'member_invite_body' AND entity_id = $1"
      + ' ORDER BY at DESC LIMIT 1', [id]);
    assert.ok(body, 'the wording is its own row — a support call three weeks '
      + 'later needs the wording, not the timestamp');
    assert.match(String(body.after.body), /Nashwa/, 'the message as composed');
    // The token is not in it: an audit trail is read by more people than an
    // inbox is.
    assert.ok(String(body.after.body).indexOf('MV-') < 0,
      'and never the live token: ' + body.after.body);
    assert.match(String(body.after.body), /<link>/, 'which is stood in for');

    const sent = await asOwner('SELECT after FROM chain.audit'
      + " WHERE action = 'member_invite' AND entity_id = $1"
      + ' ORDER BY at DESC LIMIT 1', [id]);
    assert.strictEqual(sent.after.via, 'viber', 'the send is its own fact');
  });

test('revoking stops the sign-in and keeps the history', opts, async () => {
  const phone = '9992200';
  const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Ibrahim Latheef', phone: phone
  } }]);
  const id = r.body.results[0].result.memberId;
  const inv = await post('/api/outlet/' + outletId + '/member/' + id
    + '/invite', { via: 'viber' }, token);
  assert.strictEqual(inv.status, 200);
  const tok = /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(inv.body.link)[1];

  const rev = await post('/api/outlet/' + outletId + '/member/' + id
    + '/revoke', {}, token);
  assert.strictEqual(rev.status, 200, JSON.stringify(rev.body));

  const row = await one('SELECT invited_via, invite_count, revoked_at, code_hash'
    + ' FROM chain.member WHERE id = $1', [id]);
  assert.ok(row.revoked_at, 'the row is revoked');
  assert.strictEqual(row.invited_via, 'viber',
    'and it still reads Revoked rather than Not invited');
  assert.strictEqual(row.invite_count, 1, 'the history survives the revocation');
  assert.strictEqual(row.code_hash, null, 'any live code is spent in the same act');

  const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const slug = b.body.kpos.OUTLETS[0].slug;
  const t = await get('/api/g/' + slug + '/token');
  const table = { 'x-table-token': t.body.token };

  // The gate is in chain.member_code_set(), so it holds for the code the guest
  // asks for themselves as much as for the one the counter issues.
  const ask = await postWith('/api/g/' + slug + '/member/start',
    { id: phone }, table);
  const stranger = await postWith('/api/g/' + slug + '/member/start',
    { id: '7000001' }, table);
  assert.strictEqual(ask.status, stranger.status,
    'a revoked member is not told apart from a stranger — that would enumerate them');
  assert.deepStrictEqual(Object.keys(ask.body).sort(), Object.keys(stranger.body).sort());
  const issued = await one('SELECT code_hash FROM chain.member WHERE id = $1', [id]);
  assert.strictEqual(issued.code_hash, null,
    'and no code was minted: chain.member_code_set() refuses a revoked member');
  // A revocation that leaves a working link in somebody's inbox is not one.
  const dead = await postWith('/api/g/' + slug + '/member/join',
    { token: tok }, table);
  assert.strictEqual(dead.status, 404, 'the link died with the code');

  // Inviting again IS restoring access: a link that cannot work is not one.
  const back = await post('/api/outlet/' + outletId + '/member/' + id
    + '/invite', { via: 'viber' }, token);
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  assert.strictEqual(back.body.restored, true, 'and it says the access was restored');
  assert.strictEqual(back.body.count, 2, 'on top of the history, not instead of it');
  const tok2 = /\/join\/(MV-[A-Za-z0-9]+-\d+)/.exec(back.body.link)[1];
  await postWith('/api/g/' + slug + '/member/join/code', { token: tok2 }, table);
  const code = await boardCode('Ibrahim Latheef');
  const ok = await postWith('/api/g/' + slug + '/member/verify',
    { id: phone, code: code }, table);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
});

test('the terminal is told the invitation, not a flag', opts, async () => {
  const phone = '9991100';
  const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Mariyam Zahira', phone: phone, email: 'mariyam@example.mv'
  } }]);
  const id = r.body.results[0].result.memberId;

  const before = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const b0 = (before.body.kpos.CUSTOMERS || []).find((c) => c.phone === phone);
  assert.strictEqual(b0.invitedVia, '', 'a customer nobody asked has no channel');
  assert.strictEqual(b0.invites, 0, 'and no sends');
  assert.strictEqual(b0.revoked, '', 'and is not revoked — those are different answers');

  await post('/api/outlet/' + outletId + '/member/' + id + '/invite',
    { via: 'email' }, token);
  await post('/api/outlet/' + outletId + '/member/' + id + '/revoke', {}, token);

  const after = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const b1 = (after.body.kpos.CUSTOMERS || []).find((c) => c.phone === phone);
  assert.strictEqual(b1.invitedVia, 'email', 'the channel reaches the till');
  assert.strictEqual(b1.invites, 1, 'with the count');
  assert.match(String(b1.invitedAt), /^\d{4}-\d{2}-\d{2}$/, 'and when');
  assert.match(String(b1.revoked), /^\d{4}-\d{2}-\d{2}$/,
    'and the revocation, beside the history that earned it');
});

test('a cashier cannot withdraw a customer\'s portal access', opts, async () => {
  const phone = '9990099';
  const r = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Ali Rasheed', phone: phone
  } }]);
  const id = r.body.results[0].result.memberId;
  await post('/api/outlet/' + outletId + '/member/' + id + '/invite',
    { via: 'viber' }, token);

  // Rank 2 issues an invitation — whoever is standing with the guest — but
  // taking access back is rank 3. A credit facility is not a cashier's to
  // withdraw and neither is this.
  const cashier = await post('/api/auth/pin', { outletId, pin: '6520' });
  assert.strictEqual(cashier.body.rank, 2, 'rank 2, the till');
  const till = cashier.body.token;
  const inv = await post('/api/outlet/' + outletId + '/member/' + id + '/invite',
    { via: 'viber' }, till);
  assert.strictEqual(inv.status, 200, 'the till may invite');
  const rev = await post('/api/outlet/' + outletId + '/member/' + id + '/revoke',
    {}, till);
  assert.strictEqual(rev.status, 403, 'the till may not revoke');
});

test('a member signs in by PHONE, which is what the outlet files them under',
  opts, async () => {
    // `chain.member.phone` is NOT NULL UNIQUE and the email is nullable; the
    // till's Add customer form asks for a name and a phone and has no email
    // field at all. The card demanded an email to enable its button, so the
    // normal customer — taken at the counter, no address on file — could never
    // get in, and the screen never said why.
    const fs = require('fs');
    const path = require('path');
    const card = fs.readFileSync(path.join(__dirname, '..', 'app', 'member.html'), 'utf8');
    const idOk = /idOk\(\)\s*\{([\s\S]*?)\n  \}/.exec(card);
    assert.ok(idOk, 'the card validates what was typed');
    assert.match(idOk[1], /indexOf\("@"\)/,
      'and branches on whether it is an address at all');

    // The path itself, through the server, with a member who has no email.
    const phone = '7714455';
    await push([{ opId: uuid(), kind: 'member_upsert',
      payload: { name: 'Hassan Latheef', phone: phone } }]);
    const row = await one('SELECT id, email FROM chain.member WHERE phone = $1', [phone]);
    assert.strictEqual(row.email, null, 'no address on file — the normal case');

    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const slug = b.body.kpos.OUTLETS[0].slug;
    const t = await get('/api/g/' + slug + '/token');
    const table = { 'x-table-token': t.body.token };
    process.env.MEMBER_CODE_ECHO = '1';
    const started = await postWith('/api/g/' + slug + '/member/start',
      { id: phone }, table);
    assert.ok(started.body.code, 'the outlet issued a code against the number');
    const ok = await postWith('/api/g/' + slug + '/member/verify',
      { id: phone, code: started.body.code }, table);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token, 'and the number alone signed them in');
  });

test('inviting a customer needs the till, and names a real one', opts, async () => {
  // Rank 0 is a guest device. A sign-in code for somebody else's card is not
  // something a scanned QR gets to mint.
  const anon = await post('/api/outlet/' + outletId
    + '/member/00000000-0000-4000-8000-000000000000/invite', {}, null);
  assert.strictEqual(anon.status, 401, 'no token, no code');

  const ghost = await post('/api/outlet/' + outletId
    + '/member/00000000-0000-4000-8000-000000000000/invite', {}, token);
  assert.strictEqual(ghost.status, 404, 'and a customer who does not exist is not invented');
});

test('a dish declares what its recipe contains, worked out where the recipe is',
  opts, async () => {
    // The guest device holds no recipe, so the outlet publishes the answer.
    const { publishDeclaration } = require('../src/apply');
    await push([{ opId: uuid(), kind: 'item_upsert', payload: {
      id: 'ing_prawn', name: 'Tiger prawns', cat: 'Seafood', base: 'g', cost: 0.6
    } }, { opId: uuid(), kind: 'item_upsert', payload: {
      id: 'ing_coco', name: 'Coconut cream', cat: 'Dry goods', base: 'ml', cost: 0.02
    } }]);
    await push([{ opId: uuid(), kind: 'dish_upsert', payload: {
      id: 'prawn_curry', name: 'Prawn curry', price: 220,
      recipe: [{ ing: 'ing_prawn', qty: 120 }, { ing: 'ing_coco', qty: 80 }]
    } }]);

    const row = await one("SELECT allergens, diets FROM item WHERE id = 'prawn_curry'");
    assert.ok(row.allergens.indexOf('crustacean') >= 0, 'prawns are declared');
    // Coconut cream is not dairy. A vegan curry wrongly flagged is a dish a
    // guest cannot order.
    assert.strictEqual(row.allergens.indexOf('milk'), -1, 'coconut cream is not milk');
    assert.strictEqual(row.diets.indexOf('veg'), -1, 'and a prawn curry is not vegetarian');
    assert.strictEqual(typeof publishDeclaration, 'function');

    // A dish with no recipe claims nothing. Silence beats an unearned label.
    await push([{ opId: uuid(), kind: 'dish_upsert',
      payload: { id: 'mystery', name: 'Mystery plate', price: 90 } }]);
    const bare = await one("SELECT allergens, diets FROM item WHERE id = 'mystery'");
    assert.deepStrictEqual(bare.allergens, []);
    assert.deepStrictEqual(bare.diets, [], 'an unwritten recipe declares nothing');
  });

test('points are awarded by the outlet, never by the terminal', opts, async () => {
  await one("INSERT INTO chain.setting (key, value) VALUES ('loyalty','{\"pointsPer\":10}')"
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const m = await one("SELECT id, points FROM chain.member WHERE phone = '7770002'");

  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 2, sub: 500, disc: 0, net: 500, svc: 0,
    tax: 0, round: 0, total: 500, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    member: m.id, customer: 'Member Two',
    // The terminal claims a thousand points. It does not get to.
    points: 1000,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 500, amount: 500 }],
    payments: [{ method: 'cash', amt: 500, tendered: 500 }], stockMoves: []
  } }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await one('SELECT points FROM chain.member WHERE id = $1', [m.id]);
  assert.strictEqual(Number(after.points) - Number(m.points), 50,
    'fifty points on a five hundred rufiyaa net, at the outlet\'s own rate');
});

/* ═══ POINTS ARE A LIABILITY, AND NOW THE LEDGER AGREES ═════════════════════
   This is the test that never existed, and its absence is how three defects
   lived in one feature: the server journal had no redemption line (postJournal
   absorbed the value as fake "Cash rounding"), the till queued its own journal
   against 2300 — the SERVICE CHARGE pool — and the server's till-owned guard
   refused that op on every redemption, forever. The client arithmetic was
   tested in a vm; nothing ever settled a redemption against Postgres.
   ═══════════════════════════════════════════════════════════════════════ */
test('a redemption releases the liability, and hides in no rounding line',
  opts, async () => {
    const mk = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Points Spender', phone: '9990088'
    } }]);
    const mid = mk.body.results[0].result.memberId;
    await one('UPDATE chain.member SET points = 500 WHERE id = $1', [mid]);

    // The spend and the sale travel together, as the till sends them.
    const r = await push([
      { opId: uuid(), kind: 'loyalty_update', lamport: 1, payload: {
        member: mid, points: -200, reason: 'redeem' } },
      { opId: uuid(), kind: 'sale', lamport: 2, payload: {
        bizDate: today(), covers: 1, sub: 300, disc: 0, net: 300, svc: 0,
        tax: 0, round: 0, total: 250, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
        member: mid, customer: 'Points Spender',
        pts: 200, ptsValue: 50,
        sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 300, amount: 300 }],
        payments: [{ method: 'qr', amt: 250, tendered: 250 }], stockMoves: []
      } }
    ]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const saleRes = r.body.results[1];
    assert.ok(!saleRes.error, 'the sale posts: ' + JSON.stringify(saleRes));

    // The row carries what the guest was CHARGED, and it ties — no repair
    // stamp, because the server now knows what a redemption is.
    const row = await one('SELECT total, server_audit FROM sale WHERE id = $1',
      [saleRes.result.saleId]);
    assert.strictEqual(Number(row.total), 250, 'the charged figure, not the gross');
    assert.strictEqual(row.server_audit, null,
      'a redemption is not a discrepancy to be stamped');

    const lines = await one(
      "SELECT json_agg(json_build_object('acct', l.account_code,"
      + " 'dr', l.dr, 'cr', l.cr) ORDER BY l.account_code, l.dr) AS l"
      + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
      + " WHERE j.source = 'sale' AND j.source_id = $1",
      [String(saleRes.result.saleId)]).then((q) => q.l);
    const get = (acct, side) => lines.filter((x) => x.acct === acct
      && Number(x[side]) > 0).reduce((a, x) => a + Number(x[side]), 0);

    // Dr 2350 releases the liability; revenue stays the FULL goods figure.
    assert.strictEqual(get('2350', 'dr'), 50, JSON.stringify(lines));
    assert.strictEqual(get('4000', 'cr'), 300,
      'revenue is not reduced by a redemption — that is the doctrine, in SQL');
    // What tonight earned is accrued tonight: 25 pts on the 250 charged,
    // worth 6.25 at the default 100-for-25 redemption rate.
    assert.strictEqual(get('6550', 'dr'), 6.25, JSON.stringify(lines));
    assert.strictEqual(get('2350', 'cr'), 6.25, JSON.stringify(lines));
    // And NOTHING landed on 4900. Every redemption used to, labelled
    // "Rounding", on card sales that round to nothing.
    assert.strictEqual(lines.filter((x) => x.acct === '4900').length, 0,
      'no rounding line invents itself: ' + JSON.stringify(lines));

    // The balance moved by both truths: −200 spent, +25 earned on the charge.
    const after = await one('SELECT points FROM chain.member WHERE id = $1', [mid]);
    assert.strictEqual(Number(after.points), 325);
  });

/* The outlet is registered for GGST at 8%. A till that strikes tax at the RIGHT
   rate ties and is stamped with nothing; a till carrying a stale WRONG rate is
   recorded as charged — the money is taken — and the divergence is flagged for
   an accountant. A sale that charged NO tax is left alone: zero-rated and
   exempt supplies are real, and flagging every one would cry wolf. */
test('a tax figure struck at the wrong rate is recorded and flagged', opts, async () => {
  // Right rate: 100 net + 8% = 8.00 tax. Ties, nothing to answer for.
  const ok = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 8, round: 0, total: 108, taxCode: 'GGST', taxLabel: 'GST', taxRate: 8,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 108, tendered: 108 }], stockMoves: []
  } }]);
  const okRow = await one('SELECT server_audit FROM sale WHERE id = $1',
    [ok.body.results[0].result.saleId]);
  assert.strictEqual(okRow.server_audit, null, 'the right rate leaves no stamp');

  // Wrong rate: the till struck 6% (6.00) on a bill the outlet taxes at 8%.
  const bad = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 6, round: 0, total: 106, taxCode: 'GGST', taxLabel: 'GST', taxRate: 6,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 106, tendered: 106 }], stockMoves: []
  } }]);
  assert.ok(!bad.body.results[0].error, 'the sale is NOT rejected: money was taken');
  const badRow = await one('SELECT tax, server_audit FROM sale WHERE id = $1',
    [bad.body.results[0].result.saleId]);
  assert.strictEqual(Number(badRow.tax), 6, 'the row carries what was actually charged');
  assert.ok(badRow.server_audit && badRow.server_audit.tax_mismatch, 'and the divergence is stamped');
  assert.strictEqual(Number(badRow.server_audit.tax_mismatch.expected), 8, 'against the outlet’s own 8%');
  assert.strictEqual(Number(badRow.server_audit.tax_mismatch.rate), 8);

  // Zero tax on the same registered outlet is a business assertion, not a bug —
  // it is left unflagged.
  const zero = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }], stockMoves: []
  } }]);
  const zeroRow = await one('SELECT server_audit FROM sale WHERE id = $1',
    [zero.body.results[0].result.saleId]);
  assert.strictEqual(zeroRow.server_audit, null, 'a zero-rated sale is not second-guessed');
});

/* COGS and the value of stock moved are the same money. Where the outlet
   tracks stock and the two disagree, the sale is still recorded — the money was
   taken — and the gap is stamped, because a GL COGS and a stock-ledger
   valuation drifting apart in silence is how a month's margin goes quietly
   wrong. Where the outlet does NOT track stock, there is nothing to compare. */
test('COGS that disagrees with the stock it moved is recorded and flagged', opts, async () => {
  const ing = await one('SELECT id FROM ingredient WHERE avg_cost > 0 LIMIT 1');
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    // The till claims COGS of 40 while moving stock worth a great deal less.
    cogs: 40,
    sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 100, amount: 100, cost: 40 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }],
    stockMoves: [{ ing: ing.id, qty: 1, cost: 40, value: 40 }]
  } }]);
  assert.ok(!r.body.results[0].error, 'not rejected — the sale happened');
  const row = await one('SELECT cogs, server_audit FROM sale WHERE id = $1',
    [r.body.results[0].result.saleId]);
  assert.ok(row.server_audit && row.server_audit.cogs_mismatch, 'the gap is stamped');
  assert.strictEqual(Number(row.server_audit.cogs_mismatch.cogs), 40);
  // And the SALE is repaired to what actually moved, so the P&L and the stock
  // ledger cannot disagree even while the flag is waiting to be answered.
  assert.strictEqual(Number(row.cogs), Number(row.server_audit.cogs_mismatch.stockValue),
    'the sale is booked at the stock it moved, not at the figure it claimed');
  assert.notStrictEqual(Number(row.cogs), 40, 'which is not what it claimed');
});

/* ═══ A SHIFT, RECONCILED FROM THE RAW TABLES ═══════════════════════════════
   The one check an operator does on their first night, and the one the audit
   left NOT TESTED: ring a day's trade, close the drawer, and reconcile
   gross → net → tax → cash variance → COGS against the tables the sales wrote,
   independently of any screen that reports them. If this does not tie there is
   no point discussing anything else.

   Deliberately not a clean shift. It carries the things that break naive
   reconciliations: a discount, a service charge, cash rounding, a tip that is
   NOT revenue, a card sale that does not touch the drawer, a split bill paying
   two ways, and stock actually leaving the shelf. */
test('a full shift ties: gross to net to tax to cash to COGS', opts, async () => {
  const R = (n) => Math.round(Number(n) * 100) / 100;
  const ing = await one('SELECT id, avg_cost FROM ingredient WHERE avg_cost > 0'
    + ' ORDER BY avg_cost DESC LIMIT 1');
  const day = '2026-04-02';
  const FLOAT = 1500;

  // A drawer of its own, so the cash arithmetic is this shift's alone.
  await push([{ opId: uuid(), kind: 'close_register', payload: { counted: 0 } }]);
  await push([{ opId: uuid(), kind: 'open_register', payload: { float: FLOAT } }]);

  /* Take a delivery first. Earlier tests in this file deliberately oversell to
     prove the shortfall is named, so the shelf starts negative — and a shift
     run on a negative shelf is not a clean shift, it is the oversell case
     again. Reconciling wants the ordinary evening. */
  const onHand = Number((await one('SELECT on_hand FROM ingredient WHERE id = $1',
    [ing.id])).on_hand);
  await push([{ opId: uuid(), kind: 'stock_adjust', payload: {
    ing: ing.id, qty: Math.max(0, -onHand) + 50, cost: Number(ing.avg_cost),
    value: 0, note: 'opening the shelf for the shift test'
  } }]);

  // What the till would send: two units a bill at the cost it knows. Sending a
  // figure that does NOT match is the cogs_mismatch case, tested elsewhere.
  const COGS = R(2 * Number(ing.avg_cost));

  // ── the trade ───────────────────────────────────────────────────────────
  const bill = (o) => ({ opId: uuid(), kind: 'sale', payload: Object.assign({
    bizDate: day, covers: 2, taxCode: 'GGST', taxLabel: 'GGST 8%', taxRate: 8,
    /* A dish with no recipe, deliberately: this shift's subject is the money,
       and the stock move is hand-picked so the COGS arithmetic below is a
       known figure rather than a recipe explosion. Where the outlet HAS a
       recipe the server derives what left the shelf — that is its own test. */
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: o.net, amount: o.net }],
    stockMoves: [{ ing: ing.id, qty: 2, cost: 0, value: 0 }]
  }, o) });

  // 1 · plain cash bill, service and tax on top, rounded to the 50-laari coin
  const b1 = { sub: 200, disc: 0, net: 200, svc: 20, tax: 17.6, round: -0.1,
    total: 237.5, tip: 0, cogs: COGS,
    payments: [{ method: 'cash', amt: 237.5, tendered: 250, chg: 12.5 }] };
  // 2 · discounted cash bill WITH A TIP — the tip is held, never revenue
  /* The till's claimed `total` is what the GUEST HANDED OVER — bill plus tip —
     because that is the note that enters the drawer and the figure the count
     reconciles against. The server stores the bare bill on sale.total and the
     tip beside it. 297 + 20. */
  const b2 = { sub: 300, disc: 50, net: 250, svc: 25, tax: 22, round: 0,
    total: 317, tip: 20, cogs: COGS,
    payments: [{ method: 'cash', amt: 317, tendered: 320, chg: 3, tip: 20 }] };
  // 3 · card bill — money the drawer never sees
  const b3 = { sub: 400, disc: 0, net: 400, svc: 40, tax: 35.2, round: 0,
    total: 475.2, tip: 0, cogs: COGS,
    payments: [{ method: 'card', amt: 475.2, ref: 'AUTH-9001' }] };
  // 4 · split bill, half cash half card, to the laari
  const b4 = { sub: 100, disc: 0, net: 100, svc: 10, tax: 8.8, round: 0,
    total: 118.8, tip: 0, cogs: COGS,
    payments: [{ method: 'cash', amt: 59.4, tendered: 60, chg: 0.6 },
      { method: 'card', amt: 59.4, ref: 'AUTH-9002' }] };

  const rung = await push([bill(b1), bill(b2), bill(b3), bill(b4)]);
  rung.body.results.forEach((x, i) => assert.ok(!x.error,
    'bill ' + (i + 1) + ' rang: ' + JSON.stringify(x)));
  const ids = rung.body.results.map((x) => x.result.saleId);

  // ── what the SALES say ──────────────────────────────────────────────────
  const sale = await one('SELECT sum(net) net, sum(service) svc, sum(tax) tax,'
    + ' sum(rounding) rnd, sum(total) total, sum(tip) tip, sum(pts_value) pts,'
    + ' sum(cogs) cogs, count(*)::int n,'
    + ' count(*) FILTER (WHERE server_audit IS NOT NULL)::int flagged'
    + ' FROM sale WHERE id = ANY($1)', [ids]);
  assert.strictEqual(sale.n, 4, 'four bills');
  const why = await one('SELECT server_audit FROM sale WHERE id = ANY($1)'
    + ' AND server_audit IS NOT NULL LIMIT 1', [ids]);
  assert.strictEqual(sale.flagged, 0,
    'and none needed repairing — nothing was quietly corrected under this shift: '
    + JSON.stringify(why && why.server_audit));

  // The bill's own identity, summed across the shift.
  assert.strictEqual(
    R(Number(sale.net) + Number(sale.svc) + Number(sale.tax) + Number(sale.rnd)
      - Number(sale.pts)),
    R(sale.total),
    'net + service + tax + rounding − points = total');

  // ── what the LEDGER says, read back independently ───────────────────────
  const leg = async (code) => Number((await one(
    'SELECT coalesce(sum(jl.dr),0) dr, coalesce(sum(jl.cr),0) cr FROM journal_line jl'
    + ' JOIN journal j ON j.id = jl.journal_id'
    + ' WHERE j.source_id = ANY($1) AND jl.account_code = $2', [ids, code]))
    .cr) - Number((await one(
    'SELECT coalesce(sum(jl.dr),0) dr, coalesce(sum(jl.cr),0) cr FROM journal_line jl'
    + ' JOIN journal j ON j.id = jl.journal_id'
    + ' WHERE j.source_id = ANY($1) AND jl.account_code = $2', [ids, code]))
    .dr);

  /* Revenue is credited GROSS and the discount debited beside it — a discount
     is a thing the business gave away, not revenue it never earned, and a P&L
     that nets them cannot say how much was given away. So the identity is
     4000 − 4200 = net, which is what the sale row carries. */
  const disc = await one('SELECT coalesce(sum(discount),0) d FROM sale WHERE id = ANY($1)',
    [ids]);
  assert.strictEqual(R(await leg('4000')), R(Number(sale.net) + Number(disc.d)),
    '4000 carries the goods at menu price');
  assert.strictEqual(R(-(await leg('4200'))), R(disc.d),
    '4200 carries what was given away, where somebody can see it');
  assert.strictEqual(R((await leg('4000')) + (await leg('4200'))), R(sale.net),
    'and the two net to the goods figure the guest was charged');
  assert.strictEqual(R(await leg('2200')), R(sale.tax), '2200 carries the tax charged');
  assert.strictEqual(R(await leg('2300')), R(sale.svc), '2300 the service billed');
  assert.strictEqual(R(await leg('2450')), R(sale.tip),
    '2450 holds the tip for the team — it is not revenue and never was');

  // ── the drawer ──────────────────────────────────────────────────────────
  const cash = await one("SELECT coalesce(sum(amount),0) amt FROM payment"
    + " WHERE sale_id = ANY($1) AND method = 'cash'", [ids]);
  assert.strictEqual(R(-(await leg('1010'))), R(cash.amt),
    '1010 is debited with exactly the notes that entered the drawer, tips included');
  const card = await one("SELECT coalesce(sum(amount),0) amt FROM payment"
    + " WHERE sale_id = ANY($1) AND method = 'card'", [ids]);
  assert.strictEqual(R(-(await leg('1030'))), R(card.amt),
    'and card money sits in the acquirer receivable, not the drawer');
  assert.strictEqual(R(Number(cash.amt) + Number(card.amt)),
    R(Number(sale.total) + Number(sale.tip)),
    'every tender accounted for: the bills plus the tips');

  // ── cost of sales against the stock that moved ──────────────────────────
  const moved = await one('SELECT coalesce(sum(value),0) v, coalesce(sum(qty),0) q'
    + ' FROM stock_move WHERE sale_id = ANY($1)', [ids]);
  assert.strictEqual(R(moved.q), -8, 'four bills took two units each, signed out');
  // leg() reads credits-minus-debits, and a sale CREDITS 1200 (stock leaves).
  assert.strictEqual(R(await leg('1200')), R(moved.v),
    '1200 is relieved by the value of the stock that left the shelf');
  assert.strictEqual(R(await leg('5000') * -1), R(moved.v),
    'and 5000 is charged the same figure — one number, not two');
  assert.strictEqual(R(sale.cogs), R(moved.v),
    'and the sale rows agree with both');

  // ── close the drawer and reconcile the count ────────────────────────────
  const SHORT = 5;
  const counted = R(FLOAT + Number(cash.amt) - SHORT);
  const close = await push([{ opId: uuid(), kind: 'close_register',
    payload: { counted: counted, note: 'shift reconciliation test' } }]);
  const z = close.body.results[0].result;
  assert.strictEqual(R(z.expected), R(FLOAT + Number(cash.amt)),
    'the register expects the float plus the cash it took');
  assert.strictEqual(R(z.variance), -SHORT, 'and the count is short by exactly that');

  const shortLeg = await one("SELECT coalesce(sum(dr),0) dr FROM journal_line jl"
    + " JOIN journal j ON j.id = jl.journal_id"
    + " WHERE j.source_id = $1 AND jl.account_code = '6300'", [z.id]);
  assert.strictEqual(R(shortLeg.dr), SHORT,
    'a short drawer is a real cost, booked the day it happened');

  // ── and the whole shift balances ────────────────────────────────────────
  const tb = await one('SELECT coalesce(sum(jl.dr),0) dr, coalesce(sum(jl.cr),0) cr'
    + ' FROM journal_line jl JOIN journal j ON j.id = jl.journal_id'
    + ' WHERE j.source_id = ANY($1) OR j.source_id = $2', [ids, z.id]);
  assert.strictEqual(R(tb.dr), R(tb.cr),
    'the shift trial balance: ' + R(tb.dr) + ' = ' + R(tb.cr));

  // Leave a register open for whatever runs next.
  await push([{ opId: uuid(), kind: 'open_register', payload: { float: 0 } }]);
});

/* HIDING A DISH AND 86-ING ONE ARE DIFFERENT DECISIONS, and neither round trip
   closed. The bootstrap published `offMenu` and `soldOutReason`; the terminal
   reads `hidden` and `off`. So both controls wrote a local flag, queued an op,
   and were wiped by the next bootstrap — the dish came back on the menu and the
   86 came back on sale, with nothing on any screen to say why. Worse, the op
   mapped BOTH offMenu and active from `off`, so 86-ing a dish took it off the
   menu and deactivated it, while the toggle that says "Hidden from every
   channel" sent nothing at all. */
test('hiding a dish sticks, and 86-ing one does not hide it', opts, async () => {
  const dish = await one('SELECT id FROM item WHERE NOT is_batch AND active LIMIT 1');

  // Hide it. The op is what the terminal's own mapping now sends.
  await push([{ opId: uuid(), kind: 'dish_upsert',
    payload: { id: dish.id, name: 'Hidden dish', price: 50, offMenu: true } }]);
  let row = await one('SELECT off_menu, sold_out_reason, active FROM item WHERE id = $1',
    [dish.id]);
  assert.strictEqual(row.off_menu, true, 'the outlet holds the decision');

  // And the terminal is told in the word it reads. This is the half that was
  // missing: `hidden` was never published, so menuVisible() saw nothing.
  let boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  let m = (boot.body.kpos.MENU || []).find((x) => x.id === dish.id);
  assert.strictEqual(m.hidden, true, 'published as hidden, which is what the grid filters on');

  // A guest is never offered it — the toggle says "till, QR menu and printed
  // list alike", and the QR snapshot used to filter on `active` alone.
  const snap = await get('/api/outlet/' + outletId + '/snapshot', token);
  assert.ok(!(snap.body.items || []).some((x) => x.id === dish.id),
    'and it never reaches the QR menu');

  // An ORDINARY save that says nothing about it must not put it back.
  await push([{ opId: uuid(), kind: 'dish_upsert',
    payload: { id: dish.id, name: 'Hidden dish', price: 55 } }]);
  row = await one('SELECT off_menu FROM item WHERE id = $1', [dish.id]);
  assert.strictEqual(row.off_menu, true,
    'silence is not the same as saying "show it again"');

  // Back on the menu, said explicitly.
  await push([{ opId: uuid(), kind: 'dish_upsert',
    payload: { id: dish.id, name: 'Hidden dish', price: 55, offMenu: false } }]);
  row = await one('SELECT off_menu FROM item WHERE id = $1', [dish.id]);
  assert.strictEqual(row.off_menu, false, 'and a caller that means it is obeyed');

  // 86 it. That is tonight's stock, not a menu decision: it stays ON the grid
  // wearing its tag, which is what a cashier needs when a guest asks for it.
  await push([{ opId: uuid(), kind: 'dish_upsert', payload: {
    id: dish.id, name: 'Hidden dish', price: 55, soldOutReason: "86'd on the floor"
  } }]);
  row = await one('SELECT off_menu, sold_out_reason, active FROM item WHERE id = $1',
    [dish.id]);
  assert.strictEqual(row.off_menu, false, '86 is not hiding');
  assert.strictEqual(row.active, true, 'nor is it deactivating the dish');
  assert.ok(row.sold_out_reason, 'it is a stock-out, and it is recorded as one');

  boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  m = (boot.body.kpos.MENU || []).find((x) => x.id === dish.id);
  assert.strictEqual(m.off, true, 'and the terminal is told in the word it reads');
  assert.strictEqual(m.hidden, false, 'while still being on the menu');
});

/* ═══ ONE OUTLET, MANY TERMINALS, ONE ANSWER ════════════════════════════════
   Every signed-in terminal has always polled `/sync/pull` every five seconds,
   and the answer was DISPATCHED AND DISCARDED — `kpos-tick` had no listener
   anywhere in the three app pages. So the only thing that ever re-read the
   outlet was a bootstrap, which happens on sign-in, after THIS device's own
   material push, and on an explicit refresh. A table opened on the handheld
   was invisible at the counter until the counter wrote something of its own,
   and a bill settled on one till never reached the other till's takings.

   Measured in two real browsers before this was written: over twenty seconds
   of polling, the second terminal saw none of a table, a dish, a section or a
   sale. This is the server half of the fix — the slice that makes it possible
   — asked of the endpoint the poll actually calls. */
test('the five-second poll carries the floor, today\'s takings and the drawer', opts, async () => {
  // A poll from a device that has just come up: `since` is 0, so it is told
  // the whole trading day once, and the floor as it stands.
  const cold = await get('/api/outlet/' + outletId + '/sync/pull?since=0', token);
  assert.strictEqual(cold.status, 200);
  const st = cold.body.state;
  assert.ok(st, 'the poll carries a live slice at all — this is what was missing');
  assert.strictEqual(st.live, true, 'and says it is a SLICE, not a whole state');
  assert.ok(st.settledToday, 'today\'s takings ride the poll');
  assert.strictEqual(st.settled, undefined,
    'and are NOT called `settled`: that key is the bootstrap\'s wholesale refill, '
    + 'and a partial answer under it would delete the history every five seconds');
  assert.ok(st.register && typeof st.register.open === 'boolean', 'the drawer');
  assert.ok(Array.isArray(st.guestOrders) && Array.isArray(st.guestRequests),
    'and what guests have ordered or asked for');

  /* THE STAMP IS THE DATABASE'S CLOCK. It is compared against `applied_at` and
     `sale.at`, which Postgres wrote — so a few hundred milliseconds of skew
     between this process and the database would silently drop whatever landed
     in the gap, for ever, with nothing on any screen to say a bill went
     missing. */
  const dbNow = await one('SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS ms');
  assert.ok(Math.abs(Number(cold.body.now) - Number(dbNow.ms)) < 5000,
    'the stamp is read off the clock its own predicates are compared against');

  // A TICKET ARRIVES WITH ITS LINES. The pull has always carried ticket
  // headers and nothing read them; a bill rendered from a header is a bill
  // that looks empty, which is worse than not showing it.
  const table = 'T77';
  await push([{ opId: uuid(), kind: 'add_line', payload: {
    table: table, item: 'm1', name: 'Grilled Reef Fish', qty: 2, price: 185,
    lid: uuid(), split: 0
  } }]);
  const after = await get('/api/outlet/' + outletId + '/sync/pull?since=0', token);
  const key = Object.keys(after.body.state.tickets || {}).find((k) => k.indexOf(table) === 0);
  assert.ok(key, 'a table opened on another terminal is on the floor this one reads');
  assert.ok((after.body.state.tickets[key].lines || []).length >= 1,
    'and it carries its lines, not just a header');

  /* THE WINDOW OVERLAPS ITSELF. `now()` in Postgres is the TRANSACTION's start
     time, so a sale whose transaction opened before a stamp and committed
     after it carries an `at` the next window would otherwise have passed. */
  const t0 = Number(after.body.now);
  const sale = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), channel: 'dine_in', covers: 2,
    sub: 300, disc: 0, net: 300, svc: 0, tax: 0, round: 0, total: 300,
    taxCode: 'NONE', taxLabel: '', taxRate: 0, cogs: 0,
    server: 'Test Owner', cur: 'MVR', rate: 1, fgn: 0,
    sold: [{ id: 'm1', name: 'Grilled Reef Fish', qty: 2, price: 150, amount: 300, cost: 0 }],
    payments: [{ method: 'cash', amt: 300, tendered: 300, chg: 0 }],
    stockMoves: []
  } }]);
  assert.ok(!sale.body.results[0].error, 'the bill settles');
  const next = await get('/api/outlet/' + outletId + '/sync/pull?since=' + t0, token);
  assert.ok((next.body.state.settledToday || []).some((x) => Number(x.total) === 300),
    'and the terminal that did not ring it is told, on its very next poll');

  // A STEADY POLL DOES NOT RE-SEND THE DAY. The floor is sent whole — a
  // terminal cannot tell "unchanged" from "closed and gone" out of a partial
  // list — but a bill already delivered is not delivered again.
  const steady = await get('/api/outlet/' + outletId + '/sync/pull?since='
    + (Number(next.body.now) + 60000), token);
  assert.strictEqual((steady.body.state.settledToday || []).length, 0,
    'nothing new since, so nothing is re-sent');
  assert.ok(Object.keys(steady.body.state.tickets || {}).length >= 1,
    'while the floor is still whole, because that is what the poll is for');
});

/* ═══ A SETTING IS THE OUTLET'S, SO IT REACHES EVERY TERMINAL ═══════════════
   An owner sitting at home changes a policy — how long until a till locks,
   whether a void needs a PIN, what the acquirer charges, what a dollar is
   worth today — and every terminal in the shop has to be reading it by the
   next bootstrap. None of it travelled.

   The outlet's `setting` table has been there since the schema was written and
   the handler wrote to it; `src/bootstrap.js` read it into a local called
   `oset` and USED IT NOWHERE, so no terminal ever read a word of it back. The
   settings screen wrote one browser's localStorage and queued
   `setting_change` with no payload, so the outlet was told a key had changed
   and never which one. And the three rate screens wrote keys nothing reads —
   `acquirer_rates_outlet`, `channel_rates`, `fx_rates` — beside a till reading
   `prefs().processors`, `prefs().packCost` and `prefs().fx`.

   This walks the road over HTTP: the empty op refused by name, each policy
   landing on the key the till reads, and the bootstrap publishing all of it. */
test('a setting an owner changes reaches the outlet, and every terminal', opts, async () => {
  // ── an op that names no key is refused, not recorded as a change to
  //    nothing. A parked op is read by a person.
  const bare = await push([{ opId: uuid(), kind: 'setting_change', payload: {} }]);
  assert.ok(bare.body.results[0].error, 'a setting change with no key is refused');

  // ── the policies the settings screen sends, one key and one value each.
  await push([
    { opId: uuid(), kind: 'setting_change', payload: { key: 'autoLock', value: 12 } },
    { opId: uuid(), kind: 'setting_change', payload: { key: 'voidPin', value: false } },
    { opId: uuid(), kind: 'setting_change', payload: { key: 'showCost', value: false } },
    { opId: uuid(), kind: 'setting_change', payload: { key: 'activity', value: 'cafe' } }
  ]);

  // ── the rate screens, each on the key the till reads back.
  await push([
    { opId: uuid(), kind: 'mdr_set',
      payload: { processor: 'term', rate: 1.75, cycle: 2, suspended: false } },
    { opId: uuid(), kind: 'channel_rates', payload: { packCost: 3.5, aggCommission: 22 } },
    { opId: uuid(), kind: 'fx_rates', payload: { rates: { USD: 15.42, src: 'MMA' } } },
    { opId: uuid(), kind: 'qr_banner_slot', payload: { on: true } }
  ]);

  // A SECOND CONTRACT MUST NOT ERASE THE FIRST. The old handler wrote the one
  // processor it was told about over the whole setting.
  await push([{ opId: uuid(), kind: 'mdr_set',
    payload: { processor: 'gw', rate: 2.4, cycle: 2, suspended: true } }]);

  // ── what a terminal that has never seen any of this is told when it comes
  //    up. This is the half that did not exist.
  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const P = boot.body.kpos.PREFS || {};
  assert.strictEqual(P.autoLock, 12, 'the lock timeout is the outlet\'s');
  assert.strictEqual(P.voidPin, false, 'so is whether a void needs a PIN');
  assert.strictEqual(P.showCost, false, 'and whether costs show on the grid');
  assert.strictEqual(P.activity, 'cafe', 'and what the business does');
  assert.strictEqual(P.packCost, 3.5, 'the packaging cost');
  assert.strictEqual(P.aggCommission, 22, 'the aggregator commission');
  assert.strictEqual((P.fx || {}).USD, 15.42, 'and today\'s rate');
  assert.strictEqual(P.qrBanners, true, 'the banner slot is one decision, not one per till');
  assert.strictEqual((P.processors || {}).term.rate, 1.75, 'the card contract');
  assert.strictEqual((P.processors || {}).gw.rate, 2.4,
    'and the gateway beside it — a second contract merges rather than replacing');
  assert.strictEqual((P.processors || {}).gw.suspended, true);

  // ── AND A DEVICE PREFERENCE IS NOT AMONG THEM. Nothing stops a client from
  //    sending one; what the till must not do is push it, which is asserted
  //    statically in the wiring suite. Here: the outlet's answer is what a
  //    terminal reads, so a key the outlet holds wins over the shipped
  //    default and the local pen empties on top of it.
  const rows = await db.withOutletRead({ outletId, rank: 5, actor: null, scope: 'outlet' },
    (c) => c.query("SELECT key FROM setting WHERE key IN ('navPinned','paper','kdsStation')"));
  assert.strictEqual(rows.rows.length, 0,
    'the shop holds no opinion about one screen\'s sidebar, printer or station');
});

/* ═══ A MENU SECTION IS THE OUTLET'S, NOT ONE BROWSER'S ═════════════════════
   Reported from a live store, and it arrives wearing the wrong face: the till
   parked "Bajiya updated · Short Eats & Snacks · MVR 120" after the outlet
   refused it eight times. Nothing is wrong with that dish. The section it is
   in had never reached the outlet.

   Three screens created or edited a section, and every one of them queued its
   op with NO PAYLOAD — `queue(kind, label, entity)` against a signature of
   `(kind, label, entity, payload)` — while two of the three named
   `menu_section`, which is a different table from the `menu_category` the
   bootstrap publishes and `item.category_id` references. The server refused
   each for want of a name, the toast said "Section created", and the section
   existed in one browser. Then the FK did what a FK does.

   All three halves are asserted here: the empty op is refused BY NAME rather
   than with a Postgres constraint message, the section round-trips whole, and
   the dish that could not be saved lands. */
test('a menu section reaches the outlet, and the dish in it can be saved', opts, async () => {
  // ── what the shipped build sent. A parked op is read by a person, so the
  //    refusal has to be a sentence rather than `null value in column "name"`.
  for (const kind of ['menu_category_insert', 'menu_section_insert', 'menu_section_update']) {
    const r = await push([{ opId: uuid(), kind: kind, payload: {} }]);
    const err = String((r.body.results[0] || {}).error || '');
    assert.match(err, /sent with no name/, kind + ' is refused in English');
    assert.ok(!/null value in column/.test(err), kind + ' does not leak a constraint message');
  }
  for (const kind of ['menu_category_reorder', 'menu_section_reorder']) {
    const r = await push([{ opId: uuid(), kind: kind, payload: {} }]);
    assert.match(String((r.body.results[0] || {}).error || ''), /no section order/,
      kind + ' refuses rather than answering success over an empty walk');
  }

  // ── the section the till now sends, with everything its editor collects.
  const res = await push([{ opId: uuid(), kind: 'menu_category_insert', payload: {
    id: 'short-eats-snacks', name: 'Short Eats & Snacks', icon: 'starter',
    colour: '#c8553d', station: 'hot', hidden: false, pos: null
  } }]);
  assert.ok(!res.body.results[0].error, 'the section lands');

  // A NEW section goes to the END of the rail. `pos` is NOT NULL, and
  // defaulting it to 0 would put every section a store adds in front of the
  // ones it has already ordered.
  const others = await one('SELECT max(pos) AS top FROM menu_category WHERE id <> $1',
    ['short-eats-snacks']);
  let cat = await one('SELECT * FROM menu_category WHERE id = $1', ['short-eats-snacks']);
  assert.ok(cat.pos > others.top,
    'it lands at the end (' + cat.pos + ' past ' + others.top + '), not in front');
  assert.strictEqual(cat.icon, 'starter', 'the glyph is the outlet\'s now');
  assert.strictEqual(cat.station, 'hot', 'and so is the station its dishes fire to');
  assert.strictEqual(cat.hidden, false);

  // ── THE DISH THAT WAS PARKED. This is the exact save that was refused.
  const dishOp = await push([{ opId: uuid(), kind: 'dish_upsert', payload: {
    id: 'bajiya', name: 'Bajiya', cat: 'short-eats-snacks', price: 120,
    station: 'hot', active: true, offMenu: false, soldOutReason: null, diets: [], recipe: []
  } }]);
  assert.ok(!dishOp.body.results[0].error,
    'the dish lands — it was the missing section that refused it, not the dish');
  const dish = await one('SELECT category_id, price FROM item WHERE id = $1', ['bajiya']);
  assert.strictEqual(dish.category_id, 'short-eats-snacks');

  // ── the terminal is told, in the words it reads. `icon: r.colour || 'main'`
  //    read the colour column as the glyph key, so both were unreadable.
  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const pub = (boot.body.kpos.MENU_CATEGORIES || []).find((c) => c.id === 'short-eats-snacks');
  assert.ok(pub, 'the section is published');
  assert.strictEqual(pub.icon, 'starter', 'the glyph');
  assert.strictEqual(pub.color, '#c8553d', 'the colour, separately from the glyph');
  assert.strictEqual(pub.station, 'hot', 'the station');
  assert.strictEqual(pub.hidden, false, 'and whether it shows at all');

  // ── SILENCE IS PRESERVED, the same rule item.off_menu follows. A rename must
  //    not reset the colour, the glyph, the station and the position to nothing.
  await push([{ opId: uuid(), kind: 'menu_category_update',
    payload: { id: 'short-eats-snacks', name: 'Short Eats' } }]);
  cat = await one('SELECT * FROM menu_category WHERE id = $1', ['short-eats-snacks']);
  assert.strictEqual(cat.name, 'Short Eats', 'the rename lands');
  assert.strictEqual(cat.icon, 'starter', 'and says nothing about the glyph');
  assert.strictEqual(cat.colour, '#c8553d', 'or the colour');
  assert.strictEqual(cat.station, 'hot', 'or the station');

  // Hiding it is a decision, so `false` is obeyed where `null` is silence.
  await push([{ opId: uuid(), kind: 'menu_category_update',
    payload: { id: 'short-eats-snacks', name: 'Short Eats', hidden: true } }]);
  cat = await one('SELECT hidden FROM menu_category WHERE id = $1', ['short-eats-snacks']);
  assert.strictEqual(cat.hidden, true, 'hidden reaches every terminal, not one browser');

  // ── the order carries the order. Without it the handler walked an empty
  //    array and answered success, which is a control that says it did
  //    something. Reversed, so a no-op cannot pass for a move.
  const ids = (await db.withOutletRead({ outletId, rank: 5, actor: null, scope: 'outlet' },
    (c) => c.query('SELECT id FROM menu_category ORDER BY pos, name'))).rows.map((r) => r.id);
  const flipped = ids.slice().reverse();
  await push([{ opId: uuid(), kind: 'menu_category_reorder', payload: { order: flipped } }]);
  const after = (await db.withOutletRead({ outletId, rank: 5, actor: null, scope: 'outlet' },
    (c) => c.query('SELECT id FROM menu_category ORDER BY pos'))).rows.map((r) => r.id);
  assert.deepStrictEqual(after, flipped, 'the rail is the outlet\'s order, on every terminal');
});

/* A BATCH THE KITCHEN MAKES IS AN ITEM, and recipe_line.sub_item_id has
   referenced item(id) since 003 — but nothing ever wrote one, so that foreign
   key had no possible referent and a dish drawing on a batch could not be
   stored at all. The terminal carried three batches hard-coded in its source
   plus per-browser edits, and the ops meant to record one had no handler and
   no payload: a kitchen costing "the backbone of six dishes" costed it for
   itself, on one device, while the screen said it was saved. */
test('a batch the kitchen makes reaches the outlet, and a dish can draw on it',
  opts, async () => {
  const ings = await all2('SELECT id FROM ingredient ORDER BY name LIMIT 2');
  assert.ok(ings.length >= 2, 'the seeded outlet has ingredients to make it from');

  const r = await push([{ opId: uuid(), kind: 'subrecipe_add', payload: {
    id: 'SB1', name: 'Curry base', batch: 3000, unit: 'g', loss: 0.12,
    note: 'the backbone of six dishes',
    lines: [{ ing: ings[0].id, qty: 900 }, { ing: ings[1].id, qty: 300 }]
  } }]);
  assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));
  // 3000g reducing by 12% yields 2640 — what a gram of it is costed against.
  assert.strictEqual(Number(r.body.results[0].result.yielded), 2640);

  const it = await one('SELECT name, yield_qty, loss_pct, off_menu, price'
    + " FROM item WHERE id = 'SB1'");
  assert.ok(it, 'the batch is an item');
  assert.strictEqual(Number(it.yield_qty), 2640, 'holding what it yields');
  assert.strictEqual(Number(it.loss_pct), 0.12, 'and why that is less than went in');
  assert.strictEqual(it.off_menu, true, 'off the till grid — nobody orders a litre of stock');

  const lines = await all2("SELECT ingredient_id, qty FROM recipe_line"
    + " WHERE item_id = 'SB1' ORDER BY qty DESC");
  assert.strictEqual(lines.length, 2, 'with its inputs');

  // THE POINT: a dish can now reference it. This insert used to fail the
  // foreign key, because no item was ever written for sub_item_id to find.
  const dish = await one('SELECT id FROM item WHERE off_menu = false LIMIT 1');
  const d = await push([{ opId: uuid(), kind: 'recipe_update', payload: {
    item: dish.id, lines: [[ 'SB1', 200, 0, 'sub' ]]
  } }]);
  assert.ok(!d.body.results[0].error, JSON.stringify(d.body.results[0]));
  const drawn = await one('SELECT sub_item_id, qty FROM recipe_line'
    + ' WHERE item_id = $1', [dish.id]);
  assert.strictEqual(drawn.sub_item_id, 'SB1', 'the dish draws on the batch');

  /* A BATCH IS NOT A DISH. Nobody orders a litre of fish stock, and the till's
     grid, the guest's menu and the KDS all build from MENU — so it is
     published on its own list, and said rather than inferred: a batch and a
     dish taken off the menu are both off_menu. */
  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.ok(!(boot.body.kpos.MENU || []).some((m) => m.id === 'SB1'),
    'the batch never reaches the dish grid');
  const pub = (boot.body.kpos.SUBS || []).find((x) => x.id === 'SB1');
  assert.ok(pub, 'it is published as a batch');
  assert.strictEqual(Number(pub.loss), 0.12, 'with its reduction loss');
  assert.strictEqual(Number(pub.batch), 3000,
    'and the size that went IN, which is what the costing screens divide by');
  assert.strictEqual(pub.lines.length, 2, 'and its inputs');

  // Re-saving it is an update, not a second batch.
  await push([{ opId: uuid(), kind: 'subrecipe_update', payload: {
    id: 'SB1', name: 'Curry base', batch: 3000, unit: 'g', loss: 0.2,
    lines: [{ ing: ings[0].id, qty: 900 }]
  } }]);
  const again = await one("SELECT loss_pct, yield_qty FROM item WHERE id = 'SB1'");
  assert.strictEqual(Number(again.loss_pct), 0.2, 'the batch is corrected in place');
  const n = await one("SELECT count(*)::int AS n FROM item WHERE id = 'SB1'");
  assert.strictEqual(n.n, 1, 'not forked into a second one');
});

test('a batch with no size is refused, not costed against nothing', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'subrecipe_add',
    payload: { id: 'SB9', name: 'Nothing', batch: 0, lines: [{ ing: 'x', qty: 1 }] } }]);
  assert.ok(r.body.results[0].error, 'a batch size of zero cannot cost a gram');
});

/* WHAT A KILO AS PURCHASED ACTUALLY PLATES decides how much stock every sale
   deducts — grossQty = net / (yield x (1 - waste)) — and it lived in ONE
   BROWSER's local state, falling back to a regex matched on the ingredient's
   name. Two tills at a counter deducted different quantities for the same dish;
   clearing storage reverted a measurement to a guess; and the op that was meant
   to carry it was queued with no payload at all, so the trail recorded a yield
   of zero against no ingredient while the screen said "Yield recorded". */
test('a measured yield becomes the outlet\'s figure, not one browser\'s',
  opts, async () => {
  const ing = await one('SELECT id, name FROM ingredient ORDER BY name LIMIT 1');
  const before = await one('SELECT yield_pct, waste_pct FROM ingredient WHERE id = $1',
    [ing.id]);
  assert.strictEqual(before.yield_pct, null,
    'nobody has assessed it yet — which is a different fact from 100%');

  const r = await push([{ opId: uuid(), kind: 'yield_test',
    payload: { ing: ing.id, y: 0.62, w: 0.05, why: 'filleted and trimmed' } }]);
  assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));

  const after = await one('SELECT yield_pct, waste_pct, yield_by, yield_at'
    + ' FROM ingredient WHERE id = $1', [ing.id]);
  assert.strictEqual(Number(after.yield_pct), 0.62, 'the outlet holds the measurement');
  assert.strictEqual(Number(after.waste_pct), 0.05);
  assert.strictEqual(after.yield_by, 'filleted and trimmed', 'and why it was taken');
  assert.ok(after.yield_at, 'and when');

  // Every OTHER terminal reads it, which is the whole point: it reaches them
  // through the bootstrap rather than staying on the till that measured.
  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const row = (boot.body.raw.items || []).find((x) => x[0] === ing.id);
  assert.ok(row, 'the ingredient is published');
  assert.strictEqual(Number(row[13]), 0.62, 'with its yield at index 13');
  assert.strictEqual(Number(row[14]), 0.05, 'and its trim at 14');

  // An unassessed ingredient publishes NULL, never 1 — the till has a shipped
  // estimate for that case and says on screen that it is an estimate.
  const un = (boot.body.raw.items || []).find((x) => x[0] !== ing.id);
  if (un) assert.strictEqual(un[13], null, 'a guess is never published as a measurement');
});

test('a yield that is not a measurement is refused by name', opts, async () => {
  const ing = await one('SELECT id FROM ingredient ORDER BY name LIMIT 1');
  for (const [y, w, what] of [[0, 0.1, 'a yield of nothing'],
    [1.4, 0.1, 'a yield above 100%'], [0.5, 1.2, 'trim of more than everything']]) {
    const r = await push([{ opId: uuid(), kind: 'yield_test',
      payload: { ing: ing.id, y: y, w: w } }]);
    assert.ok(r.body.results[0].error, what + ' is refused');
  }
  // And the good figure from the test above is still standing — a refusal must
  // not half-write over a measurement somebody took.
  const still = await one('SELECT yield_pct FROM ingredient WHERE id = $1', [ing.id]);
  assert.strictEqual(Number(still.yield_pct), 0.62, 'the real measurement survives');
});

/* A CAFE THAT COSTS ITS MENU AT A FLAT PERCENTAGE has no recipes and moves no
   stock — an ordinary way to run one. It sends a COGS estimate and no moves,
   every sale, for ever. Comparing them there would flag every bill in the shop,
   and a flag that fires on every bill is one nobody reads by the second week.
   Same doctrine as the tax sweep: flag a wrong figure, never the absence. */
test('an outlet that tracks no stock is not flagged on every bill', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    cogs: 30,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100, cost: 30 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }],
    stockMoves: []
  } }]);
  const saleId = r.body.results[0].result.saleId;
  const row = await one('SELECT cogs, server_audit FROM sale WHERE id = $1', [saleId]);
  assert.ok(!(row.server_audit && row.server_audit.cogs_mismatch),
    'nothing moved, so there is no divergence to report');
  assert.strictEqual(Number(row.cogs), 30,
    'and the percentage estimate stays — it is the only costing the business has');

  // The LEDGER still books no cost of sales, because no stock left the shelf.
  // That is the half that had to change: 1200 used to be credited for stock
  // that never moved.
  const gl = await one("SELECT coalesce(sum(cr), 0)::numeric AS cr FROM journal_line jl"
    + ' JOIN journal j ON j.id = jl.journal_id'
    + " WHERE j.source_id = $1 AND jl.account_code = '1200'", [saleId]);
  assert.strictEqual(Number(gl.cr), 0, '1200 is untouched by a sale that moved nothing');
});

/* THE GL AND THE STOCK LEDGER WERE FED BY TWO DIFFERENT CLIENT NUMBERS. 1200
   was credited with the till's `cogs`, while stock_move carried the till's
   per-move `value`, and nothing ever compared them — so an outlet whose till
   had been offline across a price rise valued its evening at last week's cost
   in one place and this week's in the other, for ever. Both are the server's
   own weighted-average cost now, which is what makes them the same number by
   construction rather than by luck. */
test('the stock ledger and account 1200 are one figure, not two', opts, async () => {
  const ing = await one("SELECT id, avg_cost FROM ingredient WHERE avg_cost > 0"
    + ' ORDER BY avg_cost DESC LIMIT 1');
  assert.ok(ing, 'the seeded outlet has a costed ingredient');
  const qty = 3;
  const real = round(qty * Number(ing.avg_cost));

  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    // The till's own valuation is deliberately nonsense in both fields.
    cogs: 999,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }],
    stockMoves: [{ ing: ing.id, qty: qty, cost: 999, value: 999 }]
  } }]);
  const saleId = r.body.results[0].result.saleId;

  const mv = await one('SELECT value FROM stock_move WHERE sale_id = $1', [saleId]);
  assert.strictEqual(Number(mv.value), real,
    'the move is valued at the outlet\'s own weighted-average cost');

  const gl = await one("SELECT sum(cr)::numeric AS cr FROM journal_line jl"
    + ' JOIN journal j ON j.id = jl.journal_id'
    + " WHERE j.source_id = $1 AND jl.account_code = '1200'", [saleId]);
  assert.strictEqual(Number(gl.cr), real, '1200 is credited with exactly that');

  const sale = await one('SELECT cogs, server_audit FROM sale WHERE id = $1', [saleId]);
  assert.strictEqual(Number(sale.cogs), real, 'and so is the sale');
  assert.strictEqual(Number(sale.server_audit.cogs_mismatch.cogs), 999,
    'while what the till claimed is kept, to be answered for');
});

/* SELLING WHAT IS NOT THERE. Two tills offline at one counter can each sell
   the last portion, and the second one used to drive on_hand negative in
   silence. Blocking is the wrong answer — the food left the kitchen and the
   money is in the drawer — so the shortfall is NAMED. */
test('a sale that oversells says which ingredient went short', opts, async () => {
  const ing = await one('SELECT id, name, on_hand FROM ingredient'
    + ' WHERE on_hand IS NOT NULL ORDER BY on_hand DESC LIMIT 1');
  const take = Number(ing.on_hand) + 5;

  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 50, disc: 0, net: 50, svc: 0,
    tax: 0, round: 0, total: 50, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 50, amount: 50 }],
    payments: [{ method: 'cash', amt: 50, tendered: 50 }],
    stockMoves: [{ ing: ing.id, qty: take, cost: 1, value: take }]
  } }]);
  assert.ok(!r.body.results[0].error, 'the sale is never rejected for it');

  const sale = await one('SELECT server_audit FROM sale WHERE id = $1',
    [r.body.results[0].result.saleId]);
  const short = sale.server_audit && sale.server_audit.stock_short;
  assert.ok(short, 'the shortfall is stamped on the sale');
  assert.strictEqual(short.items[0].name, ing.name, 'and names the ingredient');
  assert.ok(Number(short.items[0].onHand) < 0, 'with the balance it left behind');

  // asOwner: an outlet's login role has INSERT on chain.audit and nothing else,
  // which is the point of the trail — reading it back is a support job.
  const trail = await asOwner("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'stock_negative' AND entity_id = $1", [ing.id]);
  assert.ok(trail.n > 0, 'and it is on the trail, where a manager can find it');

  // Put the shelf back so later tests are not standing on a negative balance.
  await push([{ opId: uuid(), kind: 'stock_adjust', payload: {
    ing: ing.id, qty: take, cost: 1, value: 0, note: 'test restock'
  } }]);
});

/* 2350 is what the outstanding points are WORTH, and it was fed by the sale
   path alone: a manager granting goodwill points moved what the business owes
   its customers and left the account saying otherwise. The tie held only as
   long as nobody used the screen, which is a hope rather than a guarantee. */
test('points granted by hand move the liability too', opts, async () => {
  const m = await one('SELECT id FROM chain.member ORDER BY id LIMIT 1');
  const before = await one("SELECT coalesce(sum(cr) - sum(dr), 0)::numeric AS bal"
    + " FROM journal_line WHERE account_code = '2350'");

  await push([{ opId: uuid(), kind: 'loyalty_update',
    payload: { member: m.id, points: 200, why: 'goodwill' } }]);

  const after = await one("SELECT coalesce(sum(cr) - sum(dr), 0)::numeric AS bal"
    + " FROM journal_line WHERE account_code = '2350'");
  const moved = round(Number(after.bal) - Number(before.bal));
  assert.ok(moved > 0, 'granting points raises the liability, not just the balance');

  // And taking them back releases it again — by the same rate, both ways.
  await push([{ opId: uuid(), kind: 'loyalty_update',
    payload: { member: m.id, points: -200, why: 'reversed' } }]);
  const back = await one("SELECT coalesce(sum(cr) - sum(dr), 0)::numeric AS bal"
    + " FROM journal_line WHERE account_code = '2350'");
  assert.strictEqual(round(Number(back.bal)), round(Number(before.bal)),
    'and withdrawing them puts it back exactly');
});

test('a sale with no member accrues nothing', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }], stockMoves: []
  } }]);
  const lines = await one(
    'SELECT count(*)::int AS n FROM journal j JOIN journal_line l'
    + ' ON l.journal_id = j.id WHERE j.source = $1 AND j.source_id = $2'
    + " AND l.account_code IN ('2350','6550')",
    ['sale', String(r.body.results[0].result.saleId)]);
  assert.strictEqual(lines.n, 0, 'the loyalty accounts move only when loyalty did');
});

/* ═══ ONE AUTHOR PER JOURNAL ════════════════════════════════════════════════
   An audit found that NO client screen had ever successfully posted a journal:
   every `post_journal` in the terminal was queued with a label and no payload,
   so the server refused each one for want of a memo — including the manual
   journal form itself, which validated the accounts and the memo and then
   threw them away. Meanwhile the real ops were queued bare too, so their
   handlers minted zero-amount rows and journalled nothing. Supplier payments,
   credit settlements, bank charges and short settlement batches were booked
   NOWHERE, and every attempt left a poison op retrying in the outbox.
   These tests are the contract the screens now feed.
   ═══════════════════════════════════════════════════════════════════════ */
test('a supplier payment books once, and a bare replay mints nothing', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'vendor_payment', payload: {
    vendor: 7, vendorName: 'Island Fresh Produce', amt: 1250, method: 'transfer',
    ref: 'INV-0042' } }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const pid = r.body.results[0].result.paymentId;
  assert.ok(pid, JSON.stringify(r.body.results[0]));

  // A seed-era numeric vendor id resolves to a REAL chain.supplier row by
  // name — the same cure member_upsert got for the same disease.
  const sup = await one("SELECT id FROM chain.supplier WHERE name = 'Island Fresh Produce'");
  assert.ok(sup, 'the supplier exists as a row, not a number');
  const row = await one('SELECT supplier_id, amount FROM vendor_payment WHERE id = $1', [pid]);
  assert.strictEqual(row.supplier_id, sup.id);
  assert.strictEqual(Number(row.amount), 1250);

  const j = await one("SELECT count(*)::int AS n, sum(l.dr) AS dr FROM journal j"
    + ' JOIN journal_line l ON l.journal_id = j.id'
    + " WHERE j.source = 'vendor_payment' AND j.source_id = $1", [String(pid)]);
  assert.strictEqual(Number(j.dr), 1250, 'Dr 2100 · Cr 1020, once');

  // Devices still hold the op from before it carried money. A bare replay is
  // recorded as skipped, not minted as a zero-amount payment.
  const bare = await push([{ opId: uuid(), kind: 'vendor_payment', payload: {} }]);
  assert.ok(bare.body.results[0].result.skipped, JSON.stringify(bare.body.results[0]));
  const zeros = await one('SELECT count(*)::int AS n FROM vendor_payment WHERE amount <= 0');
  assert.strictEqual(zeros.n, 0, 'no zero-amount rows, ever');
});

test('a settled house account reaches the books, on the tender\'s own account',
  opts, async () => {
    const mk = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'House Account Holder', phone: '9990055', credit: 1000 } }]);
    const mid = mk.body.results[0].result.memberId;
    const r = await push([{ opId: uuid(), kind: 'settle_credit', payload: {
      member: mid, amt: 400, method: 'card', ref: 'A12345' } }]);
    assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));
    const lines = await one("SELECT json_agg(json_build_object('a', l.account_code,"
      + " 'dr', l.dr, 'cr', l.cr)) AS l FROM journal j"
      + ' JOIN journal_line l ON l.journal_id = j.id'
      + " WHERE j.source = 'credit' AND j.source_id = $1", [String(mid)]).then((q) => q.l);
    // Card money is a RECEIVABLE from the acquirer, not cash in the drawer and
    // not money already in the bank.
    assert.ok(lines.some((x) => x.a === '1030' && Number(x.dr) === 400), JSON.stringify(lines));
    assert.ok(lines.some((x) => x.a === '1040' && Number(x.cr) === 400), JSON.stringify(lines));
  });

test('a short settlement batch books what actually happened, once', opts, async () => {
  // Gross 1000 at 1.5%: expected 985. The bank paid 970 — short by 15.
  const r = await push([{ opId: uuid(), kind: 'acq_match', payload: {
    acquirer: 'term', batch: 'TB-2001', date: today(), gross: 1000, mdr: 1.5, net: 970
  } }]);
  const res = r.body.results[0].result;
  assert.strictEqual(res.state, 'short', JSON.stringify(res));

  const lines = await one("SELECT json_agg(json_build_object('a', l.account_code,"
    + " 'dr', l.dr, 'cr', l.cr)) AS l FROM journal j"
    + ' JOIN journal_line l ON l.journal_id = j.id'
    + " WHERE j.source = 'settlement' AND j.source_id = $1",
  [String(res.batchId)]).then((q) => q.l);
  // The whole deduction — fee AND shortfall — is the cost of taking cards,
  // and the receivable clears at gross. Short batches used to book NOTHING.
  assert.ok(lines.some((x) => x.a === '1020' && Number(x.dr) === 970), JSON.stringify(lines));
  assert.ok(lines.some((x) => x.a === '5600' && Number(x.dr) === 30), JSON.stringify(lines));
  assert.ok(lines.some((x) => x.a === '1030' && Number(x.cr) === 1000), JSON.stringify(lines));

  // The same figures again — the legacy repair button, or a replayed file —
  // post nothing new; a CORRECTED net posts only its delta.
  await push([{ opId: uuid(), kind: 'acq_match', payload: {
    acquirer: 'term', batch: 'TB-2001', date: today(), gross: 1000, mdr: 1.5, net: 970 } }]);
  const n1 = await one("SELECT count(*)::int AS n FROM journal"
    + " WHERE source = 'settlement' AND source_id = $1", [String(res.batchId)]);
  assert.strictEqual(n1.n, 1, 'unchanged figures restate nothing');

  await push([{ opId: uuid(), kind: 'acq_match', payload: {
    acquirer: 'term', batch: 'TB-2001', date: today(), gross: 1000, mdr: 1.5, net: 985 } }]);
  const adj = await one("SELECT sum(l.dr) FILTER (WHERE l.account_code = '1020') AS bank"
    + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
    + " WHERE j.source = 'settlement' AND j.source_id = $1", [String(res.batchId)]);
  assert.strictEqual(Number(adj.bank), 985, '970 originally, +15 corrected — never restated');
});

/* ═══ A SALE CANNOT HAPPEN TWICE ═══════════════════════════════════════════
   The one failure this build is least allowed to have. A till pushes, the
   connection drops before the answer arrives, and the outbox — which cannot
   know whether the op landed — pushes the same op again. If that mints a
   second sale, the guest is charged twice, the drawer is over, the stock is
   double-consumed and the ledger says both are correct.

   The fence is `op_log.op_id` as the PRIMARY KEY with `ON CONFLICT DO NOTHING
   RETURNING`: a seen op short-circuits BEFORE the handler runs, so nothing
   downstream needs to be idempotent on its own. This asserts it end to end —
   sale row, payment, stock move, journal and the member's points — across
   both shapes a duplicate actually arrives in: twice inside one batch (the
   till retried while the first was still in flight), and again hours later
   (the outbox drained after a reconnect). */
test('a sale replayed is one sale, one payment, one journal', opts, async () => {
  const opId = uuid();
  const before = await one('SELECT count(*)::int AS n FROM sale');
  const op = { opId, kind: 'sale', payload: {
    bizDate: today(), covers: 2, sub: 200, disc: 0, net: 200, svc: 0, tax: 0,
    round: 0, total: 200, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 200, amount: 200 }],
    payments: [{ method: 'cash', amt: 200, tendered: 200 }], stockMoves: []
  } };

  // SHAPE ONE: the same op twice inside one batch. A duplicate inside a batch
  // must not abort its neighbours either — that is what the savepoint is for.
  const r = await push([op, op]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results.length, 2);
  r.body.results.forEach((x) => assert.ok(!x.error, JSON.stringify(x)));

  const mid = await one('SELECT count(*)::int AS n FROM sale');
  assert.strictEqual(mid.n, before.n + 1,
    'two identical ops in one batch made exactly one sale');

  // SHAPE TWO: hours later, from a drained outbox that never saw the answer.
  const again = await push([op]);
  assert.strictEqual(again.status, 200);
  assert.ok(!again.body.results[0].error, JSON.stringify(again.body.results[0]));

  const after = await one('SELECT count(*)::int AS n FROM sale');
  assert.strictEqual(after.n, before.n + 1, 'and still exactly one sale');

  /* One sale is not enough on its own — the money and the goods have to be
     single too. A handler that ran twice against one sale row would leave the
     row looking right and the drawer wrong. */
  const sid = await one("SELECT id FROM sale WHERE total = 200 AND covers = 2"
    + ' ORDER BY id DESC LIMIT 1');
  const legs = await one('SELECT'
    + ' (SELECT count(*)::int FROM payment WHERE sale_id = $1) AS pays,'
    + ' (SELECT coalesce(sum(amount), 0) FROM payment WHERE sale_id = $1) AS taken,'
    + ' (SELECT count(*)::int FROM journal WHERE source = $2'
    + '    AND source_id = $1::text) AS journals', [sid.id, 'sale']);
  assert.strictEqual(legs.pays, 1, 'one tender, not three');
  assert.strictEqual(Number(legs.taken), 200, 'and 200 taken, not 600');
  assert.strictEqual(legs.journals, 1, 'one journal — a second would double revenue');

  // The op log holds it once, which is the mechanism itself.
  const log = await one('SELECT count(*)::int AS n FROM op_log WHERE op_id = $1',
    [opId]);
  assert.strictEqual(log.n, 1);
});

test('a replayed sale does not award its points a second time', opts, async () => {
  /* Loyalty is the accrual most likely to survive a duplicate quietly: points
     are added rather than set, so a handler that ran twice reads as a generous
     evening rather than as a fault, and 2350 drifts from the member balances
     it is supposed to tie to. */
  const phone = '960' + String(Date.now()).slice(-7);
  await push([{ opId: uuid(), kind: 'member_upsert', payload: {
    name: 'Replay Probe', phone, email: null } }]);
  const m = await one('SELECT id, points FROM chain.member WHERE phone = $1', [phone]);
  assert.ok(m, 'the customer exists');

  const opId = uuid();
  const op = { opId, kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 500, disc: 0, net: 500, svc: 0, tax: 0,
    round: 0, total: 500, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    member: m.id,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 500, amount: 500 }],
    payments: [{ method: 'cash', amt: 500, tendered: 500 }], stockMoves: []
  } };
  await push([op]);
  const once = await one('SELECT points FROM chain.member WHERE id = $1', [m.id]);
  await push([op]);
  await push([op]);
  const thrice = await one('SELECT points FROM chain.member WHERE id = $1', [m.id]);
  assert.strictEqual(Number(thrice.points), Number(once.points),
    'the balance is what one visit earned, however many times the op arrived');
  assert.ok(Number(once.points) > Number(m.points), 'and it did earn on the first');
});

/* ═══ THE OTHER HALF OF "STOCK AND THE LEDGER ARE ONE FIGURE" ══════════════
   The server already decides what a consumed portion is WORTH. What it took on
   trust until now was HOW MUCH — the quantities came from the till's own recipe
   expansion, against whatever menu that browser happened to be holding.

   A device offline across a recipe change deducts yesterday's recipe for ever,
   and the only symptom is a stock ledger that drifts a little every service
   until a count finds it, weeks later, with nothing to attribute it to. */
test('the recipe this outlet holds decides what left the shelf', opts, async () => {
  // An ingredient whose name the shipped yield table does NOT match, so the
  // arithmetic here is the recipe's and not an estimate's: 1.0 yield, 2% trim.
  await push([{ opId: uuid(), kind: 'item_upsert', payload: {
    id: 'ing_drift', name: 'Kurumba pith', base: 'g', stock: 'g',
    factor: 1, cost: 0.4 } }]);
  await push([{ opId: uuid(), kind: 'grn_priced', payload: {
    lines: [{ ing: 'ing_drift', qty: 50000, cost: 0.4 }], supplier: 'Drift Supply',
    total: 20000, invoice: 'DR-1' } }]);

  await push([{ opId: uuid(), kind: 'dish_upsert', payload: {
    id: 'dish_drift', name: 'Drift dish', price: 120 } }]);
  // 200 g on the plate, per dish.
  await push([{ opId: uuid(), kind: 'recipe_update', payload: {
    item: 'dish_drift', lines: [['ing_drift', 200]] } }]);

  const before = Number((await one(
    'SELECT on_hand FROM ingredient WHERE id = $1', ['ing_drift'])).on_hand);

  /* The till rings two, and sends a quantity from a recipe that said 150 g —
     the shape a stale device produces. Gross for 2 × 200 g at a 1.0 yield and
     2% trim is 400 / 0.98 = 408.163…; the till's stale figure is 300 / 0.98. */
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 240, disc: 0, net: 240, svc: 0, tax: 0,
    round: 0, total: 240, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'dish_drift', name: 'Drift dish', qty: 2, price: 120, amount: 240 }],
    payments: [{ method: 'cash', amt: 240, tendered: 240 }],
    stockMoves: [{ ing: 'ing_drift', qty: 306.122449, cost: 0.4, value: 122.45 }]
  } }]);
  assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));

  const after = Number((await one(
    'SELECT on_hand FROM ingredient WHERE id = $1', ['ing_drift'])).on_hand);
  const moved = before - after;
  assert.ok(Math.abs(moved - 408.163265) < 0.01,
    'the shelf lost what the OUTLET\'s recipe says, not what the device'
    + ' believed — moved ' + moved.toFixed(4));

  const sale = await one("SELECT id, cogs, server_audit FROM sale"
    + " WHERE receipt_no IS NOT NULL ORDER BY at DESC LIMIT 1");
  const drift = (sale.server_audit || {}).qty_mismatch;
  assert.ok(drift, 'and the divergence is stamped: ' + JSON.stringify(sale.server_audit));
  assert.strictEqual(drift.items.length, 1);
  assert.strictEqual(drift.items[0].ing, 'ing_drift',
    'named by ingredient — "stock is off somewhere" is not an answer');
  assert.ok(Math.abs(drift.items[0].recipe - 408.1633) < 0.01
    && Math.abs(drift.items[0].till - 306.1224) < 0.01,
    'with both figures, so somebody can see which device is stale: '
    + JSON.stringify(drift.items[0]));

  // On the trail as well as on the row — that is where somebody looks for
  // "when did this start".
  // asOwner: an outlet's login role has INSERT on chain.audit and nothing
  // else, so reading the trail back is a support job by design.
  const trail = await asOwner("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'recipe_drift' AND outlet_id = $1", [outletId]);
  assert.ok(trail.n >= 1, 'a manager can find it without reading sale rows');
});

test('a sale the outlet cannot cost keeps the till\'s figures, and says why',
  opts, async () => {
    /* THE OTHER DIRECTION, and it is the one that could do damage. A dish the
       outlet has never heard of — created on a device that has not pushed it
       yet — cannot be expanded here. Replacing the till's moves with a partial
       derivation would under-deduct the shelf, which is worse than trusting
       the device. So the till's figures stand and the REASON is recorded. */
    const r = await push([{ opId: uuid(), kind: 'sale', payload: {
      bizDate: today(), covers: 1, sub: 90, disc: 0, net: 90, svc: 0, tax: 0,
      round: 0, total: 90, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
      sold: [{ id: 'dish_never_pushed', name: 'Offline dish', qty: 1,
        price: 90, amount: 90 }],
      payments: [{ method: 'cash', amt: 90, tendered: 90 }],
      stockMoves: [{ ing: 'ing_drift', qty: 100, cost: 0.4, value: 40 }]
    } }]);
    assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));

    const sale = await one('SELECT id, server_audit FROM sale ORDER BY at DESC LIMIT 1');
    const why = (sale.server_audit || {}).qty_underived;
    assert.ok(why, 'the reason is on the row: ' + JSON.stringify(sale.server_audit));
    assert.ok(/does not carry/.test(why.why), why.why);
    assert.ok(!(sale.server_audit || {}).qty_mismatch,
      'and it is NOT reported as a divergence — there is nothing to diverge'
      + ' from, and a flag that fires on the absence of a figure is one nobody'
      + ' reads by the second week');

    const mv = await one('SELECT sum(abs(qty)) AS q FROM stock_move'
      + ' WHERE sale_id = $1', [sale.id]);
    assert.strictEqual(Math.round(Number(mv.q)), 100,
      "the till's own quantity moved, unaltered");
  });

test('a cafe with no recipes at all is never flagged', opts, async () => {
  /* The anti-wolf-crying case, asserted rather than assumed. An outlet costing
     its menu at a flat percentage sends a COGS estimate and NO stock moves, on
     every bill, for ever. */
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 60, disc: 0, net: 60, svc: 0, tax: 0,
    round: 0, total: 60, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    cogs: 18,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 60, amount: 60 }],
    payments: [{ method: 'cash', amt: 60, tendered: 60 }], stockMoves: []
  } }]);
  assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));
  const sale = await one('SELECT cogs, server_audit FROM sale ORDER BY at DESC LIMIT 1');
  const a = sale.server_audit || {};
  assert.ok(!a.qty_mismatch && !a.qty_underived && !a.cogs_mismatch,
    'nothing to compare, so nothing is claimed: ' + JSON.stringify(a));
  assert.strictEqual(Number(sale.cogs), 18,
    "and the till's percentage estimate stays on the row as the margin figure"
    + ' it is, rather than being zeroed');
});

/* ═══ THE TILL'S EXPANSION AND THE SERVER'S, ON THE SAME OUTLET ════════════
   The server's derivation is only worth having if it is the SAME expansion the
   till performs. Two expansions that disagree would present as a stock
   discrepancy on every bill — and it would be the check, not the till, that
   was wrong.

   So this runs both: the SHIPPED terminal source in a vm, fed this outlet's
   real bootstrap, and the server's own derivation against the same outlet, on
   the same bill. Not two retyped copies of the arithmetic — the two that
   actually run in production. */
test('the till and the server expand one recipe to one answer', opts, async () => {
  const HARNESS = require('./harness');
  const { deriveConsumption } = require('../src/apply');

  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.strictEqual(boot.status, 200);
  const dish = (boot.body.kpos.MENU || []).find((m) => (m.recipe || []).length);
  assert.ok(dish, 'the fixture outlet has a dish with a recipe');

  const F = HARNESS.makeInstance({ kpos: boot.body.kpos, raw: boot.body.raw || {} });
  const till = F.saleTrail({ sold: [[dish.id, 3]], T: {} }).stock
    .map((s) => ({ ing: String(s.id), qty: Number(s.used.toFixed(6)) }))
    .sort((a, b) => (a.ing < b.ing ? -1 : 1));
  assert.ok(till.length, 'the terminal expanded it to something');

  const server = await db.withOutletRead({ outletId, rank: 5, actor: null },
    (c) => deriveConsumption(c, [{ id: dish.id, qty: 3 }]));
  assert.strictEqual(server.complete, true, server.reason || '');
  const srv = server.moves
    .map((m) => ({ ing: String(m.ing), qty: Number(m.qty.toFixed(6)) }))
    .sort((a, b) => (a.ing < b.ing ? -1 : 1));

  /* Compared as JSON: `till` was built by the vm's own Array.prototype.map,
     so its objects carry the sandbox realm's prototypes and deepStrictEqual
     would fail on that rather than on any number. */
  assert.strictEqual(JSON.stringify(srv), JSON.stringify(till),
    'the same bill, the same recipe, the same yields — and therefore the same'
    + ' quantities, to six places. A divergence here is not a stock finding,'
    + ' it is these two implementations having drifted:\n  till   '
    + JSON.stringify(till) + '\n  server ' + JSON.stringify(srv));
});

/* ═══ AN OUTLET'S OWN PRICE, AND THE TILL THAT NEVER SAW IT ═══════════════
   Two shapes with nothing between them. The bootstrap publishes this outlet's
   overrides keyed by ITEM — a bootstrap is one outlet's, so there is nothing
   else to key them by. The terminal keys them by OUTLET and then by item, and
   holds a bare number. applyLive assigned one straight onto the other, so
   state.priceOv[outletId] was whatever row happened to sit under a key shaped
   like an outlet id, and priceOv() came back undefined for every dish on the
   menu. A price the office set was never the price the till charged, and the
   only symptom was a margin nobody could account for.

   Run here rather than reasoned about: a real override row, this outlet's real
   bootstrap, and the SHIPPED terminal in a vm asked what it would charge. */
test('a price the outlet set is the price the till charges', opts, async () => {
  const HARNESS = require('./harness');
  const boot0 = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const dish = (boot0.body.kpos.MENU || [])[0];
  assert.ok(dish && dish.price > 0, 'the fixture outlet has a priced dish');
  const cut = Math.round(Number(dish.price) / 2);
  assert.notStrictEqual(cut, Number(dish.price), 'and the override is a different figure');

  await db.withOutlet({ outletId, rank: 5, actor: null }, async (c) => {
    const who = await c.query('SELECT id FROM chain.staff LIMIT 1');
    await c.query('INSERT INTO price_override (item_id, price, reason, by_staff)'
      + ' VALUES ($1,$2,$3,$4)', [dish.id, cut, 'api test', who.rows[0].id]);
  });

  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.strictEqual(boot.status, 200);
  assert.ok(boot.body.state.priceOv[dish.id], 'the outlet publishes it, keyed by item');

  const F = HARNESS.makeInstance({ kpos: boot.body.kpos, raw: boot.body.raw || {},
    outletId: outletId });
  F.state.outletId = outletId;
  assert.strictEqual(F.priceOv(dish.id), undefined, 'a cold terminal holds none');
  F.applyLive(boot.body.state);
  assert.strictEqual(F.priceOv(dish.id), cut, 'and reads the outlet\'s answer after one poll');
  assert.strictEqual(F.menuPrice(dish), cut,
    'so the figure the till would charge is the one the outlet set, not the menu price');
});

test('a tip is held for the team, not booked as rounding', opts, async () => {
  // The guest hands over 100 for a 90 bill: the payment carries the whole
  // note, the bill total stays 90, and the 10 is a liability from the moment
  // it lands. It used to overshoot the journal by exactly itself and be
  // absorbed into 4900 — revenue nobody could ever pay out to the staff.
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 2, sub: 90, disc: 0, net: 90, svc: 0,
    tax: 0, round: 0, total: 100, tip: 10, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 90, amount: 90 }],
    payments: [{ method: 'cash', amt: 100, tip: 10, tendered: 100 }], stockMoves: []
  } }]);
  const res = r.body.results[0];
  assert.ok(!res.error, JSON.stringify(res));

  const row = await one('SELECT total, tip, server_audit FROM sale WHERE id = $1',
    [res.result.saleId]);
  assert.strictEqual(Number(row.total), 90, 'the BILL total — the tip is not the bill');
  assert.strictEqual(Number(row.tip), 10);
  assert.strictEqual(row.server_audit, null,
    'a tipped sale is not a discrepancy: the claimed figure ties as total + tip');

  const lines = await one("SELECT json_agg(json_build_object('a', l.account_code,"
    + " 'dr', l.dr, 'cr', l.cr)) AS l FROM journal j"
    + ' JOIN journal_line l ON l.journal_id = j.id'
    + " WHERE j.source = 'sale' AND j.source_id = $1",
  [String(res.result.saleId)]).then((q) => q.l);
  assert.ok(lines.some((x) => x.a === '1010' && Number(x.dr) === 100),
    'the drawer holds the whole note: ' + JSON.stringify(lines));
  assert.ok(lines.some((x) => x.a === '2450' && Number(x.cr) === 10),
    'and the tip is a liability to the team');
  assert.strictEqual(lines.filter((x) => x.a === '4900').length, 0,
    'no rounding line invents itself for a tip either');
});

test('net wages land on 2400, and the tips account keeps only tips',
  opts, async () => {
    const r = await push([{ opId: uuid(), kind: 'post_payroll', payload: {
      period: '2026-07', gross: 10000, pensionEe: 700, pensionEr: 700,
      withholding: 0, service: 990, lines: []
    } }]);
    const res = r.body.results[0];
    assert.ok(!res.error, JSON.stringify(res));
    assert.strictEqual(res.result.net, 10290, 'gross − pension − wht + service pool');

    const lines = await one("SELECT json_agg(json_build_object('a', l.account_code,"
      + " 'dr', l.dr, 'cr', l.cr)) AS l FROM journal j"
      + ' JOIN journal_line l ON l.journal_id = j.id'
      + " WHERE j.source = 'payroll' AND j.source_id = '2026-07'").then((q) => q.l);
    assert.ok(lines.some((x) => x.a === '2400' && Number(x.cr) === 10290),
      'wages owed on the wages account: ' + JSON.stringify(lines));
    assert.ok(!lines.some((x) => x.a === '2450'),
      'and NOT on 2450 — the tips account carried the whole payroll, and'
      + ' neither figure could ever be reconciled');
  });

test('the manual journal form\'s payload is the journal', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'post_journal', payload: {
    memo: 'August rent · manual',
    lines: [{ acct: '6100', dr: 18000 }, { acct: '2100', cr: 18000 }] } }]);
  assert.ok(r.body.results[0].result.journalId, JSON.stringify(r.body.results[0]));
  // And bare — as every device queued it before the form sent its payload —
  // is refused for want of a memo, not posted as an empty entry.
  const bare = await push([{ opId: uuid(), kind: 'post_journal', payload: {} }]);
  assert.match(String(bare.body.results[0].error || ''), /memo/, JSON.stringify(bare.body.results[0]));
});

/* One bad op must never brick a till. The balance check is a deferred
   constraint trigger, which fires at the batch COMMIT — outside every
   savepoint — so an unbalanced journal used to poison the whole batch: 500 to
   the client, everything stays queued, same batch retried every five seconds
   for the life of the device. The push handler now collapses the deferral per
   op, and postJournal refuses a non-sale imbalance outright. */
test('an unbalanced journal fails alone, not as a batch', opts, async () => {
  const r = await push([
    { opId: uuid(), kind: 'member_upsert', lamport: 1, payload: {
      name: 'Before The Bad Op', phone: '9990077' } },
    { opId: uuid(), kind: 'post_journal', lamport: 2, payload: {
      memo: 'deliberately unbalanced',
      lines: [{ acct: '6100', dr: 100 }, { acct: '2100', cr: 40 }] } },
    { opId: uuid(), kind: 'member_upsert', lamport: 3, payload: {
      name: 'After The Bad Op', phone: '9990066' } }
  ]);
  assert.strictEqual(r.status, 200, 'the batch survives its worst member');
  assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));
  assert.match(String(r.body.results[1].error || ''), /out of balance/,
    'the bad op is refused BY NAME: ' + JSON.stringify(r.body.results[1]));
  assert.ok(!r.body.results[2].error, JSON.stringify(r.body.results[2]));

  // And the neighbours actually committed — refusal contained, not contagious.
  const n = await one("SELECT count(*)::int AS n FROM chain.member"
    + " WHERE phone IN ('9990077','9990066')");
  assert.strictEqual(n.n, 2, 'the good ops around the bad one landed');
});

/* ═══ THE ACCOUNT PLANE ═════════════════════════════════════════════════════
   An account signs up on the website and owns the business. A staff member
   taps their face at the till and keys four digits. Different people,
   different credentials, and the second must never reach the first.
   ═══════════════════════════════════════════════════════════════════════ */
test('an account signs up, and is never told whether an address is known',
  opts, async () => {
    process.env.ACCOUNT_CODE_ECHO = '1';
    const mine = await post('/api/account/signup',
      { email: 'founder@example.mv', password: 'a-good-long-password', name: 'A Founder' });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
    assert.ok(mine.body.code, 'the development echo returns the code');

    // The SAME address again, and an address that has never been seen, must be
    // indistinguishable — otherwise this endpoint enumerates the customer list.
    const again = await post('/api/account/signup',
      { email: 'founder@example.mv', password: 'another-long-password' });
    const never = await post('/api/account/code', { email: 'stranger@example.mv' });
    assert.strictEqual(again.status, never.status);
    assert.strictEqual(again.body.note, never.body.note);
    assert.deepStrictEqual(Object.keys(again.body).sort().filter((k) => k !== 'code'),
      Object.keys(never.body).sort().filter((k) => k !== 'code'));

    /* And the NEW-address answer must match them too. This comparison was
       missing, and it is the one that mattered: `delivered` was attached only
       where an account exists, so the two bodies above agreed with each other
       precisely because NEITHER carried it. Its presence was the oracle —
       ask for a code, look for the key, learn whether the address is
       registered, in the endpoint this block is named after. */
    const keys = (r) => Object.keys(r.body).sort().filter((k) => k !== 'code');
    assert.deepStrictEqual(keys(mine), keys(again),
      'a brand-new address answers exactly as a known one does');
    assert.deepStrictEqual(keys(mine), keys(never),
      'and exactly as one that has never been seen');
    [mine, again, never].forEach((r) => {
      assert.ok('delivered' in r.body,
        'every answer says whether this install can deliver — that is a fact'
        + ' about the install, and telling everyone leaks nothing about anyone');
    });
  });

test('a code signs an account in, and is spent on use', opts, async () => {
  const issued = await post('/api/account/code', { email: 'founder@example.mv' });
  const code = issued.body.code;
  assert.ok(code, 'a code was issued');

  const wrong = await post('/api/account/code/verify',
    { email: 'founder@example.mv', code: '000000' });
  assert.strictEqual(wrong.status, 401);

  const ok = await post('/api/account/code/verify',
    { email: 'founder@example.mv', code });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token, 'an account token is minted');
  assert.strictEqual(ok.body.account.email, 'founder@example.mv');
  assert.strictEqual(ok.body.account.verified, true, 'the code proved the address');

  const replay = await post('/api/account/code/verify',
    { email: 'founder@example.mv', code });
  assert.strictEqual(replay.status, 401, 'a used code is spent');
});

test('a password signs an account in, and a wrong one says nothing useful',
  opts, async () => {
    const good = await post('/api/account/signin',
      { email: 'founder@example.mv', password: 'a-good-long-password' });
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));

    const bad = await post('/api/account/signin',
      { email: 'founder@example.mv', password: 'not-the-password' });
    const missing = await post('/api/account/signin',
      { email: 'nobody@example.mv', password: 'not-the-password' });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(missing.status, 401);
    assert.deepStrictEqual(bad.body, missing.body,
      'no such account and wrong password are the same answer');
  });

test('an account token is not a staff session, and vice versa', opts, async () => {
  const s = await post('/api/account/signin',
    { email: 'founder@example.mv', password: 'a-good-long-password' });
  const accountToken = s.body.token;

  // An account token must not open an outlet's data.
  const cross = await get('/api/outlet/' + outletId + '/bootstrap', accountToken);
  assert.ok(cross.status === 401 || cross.status === 403,
    'an account token cannot read an outlet — it carries no rank (got '
    + cross.status + ')');

  // And a staff token must not read the account plane.
  const back = await getWith('/api/account/me', { authorization: 'Bearer ' + token });
  assert.strictEqual(back.status, 401,
    'a floor session cannot reach the owner\'s account');
});

test('the account that onboards owns the outlet', opts, async () => {
  const s = await post('/api/account/signin',
    { email: 'founder@example.mv', password: 'a-good-long-password' });
  const me = await getWith('/api/account/me', { authorization: 'Bearer ' + s.body.token });
  assert.strictEqual(me.status, 200);
  // This suite onboarded WITHOUT an account (the older path), so this account
  // owns nothing — which is exactly what it should say.
  assert.strictEqual(me.body.next, 'onboarding');
  assert.deepStrictEqual(me.body.outlets, []);

  /* Link one the way onboarding does — in the REGISTRY, because that is where
     the account plane lives now. An outlet's own role is granted nothing on it
     and its database does not even contain it, which is the isolation working
     twice over. */
  const biz = await db.control().query(
    'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1', [outletId]);
  await db.control().query(
    "INSERT INTO chain.account_business (account_id, business_id, role)"
    + " SELECT id, $1, 'owner' FROM chain.account WHERE email = 'founder@example.mv'"
    + ' ON CONFLICT DO NOTHING', [Number(biz.rows[0].business_id)]);
  const after = await getWith('/api/account/me', { authorization: 'Bearer ' + s.body.token });
  assert.strictEqual(after.body.next, 'terminal');
  assert.strictEqual(after.body.outlets.length, 1);
  assert.strictEqual(after.body.outlets[0].role, 'owner');
});

test('an outlet login role cannot reach the account plane at all', opts, async () => {
  // Not a policy question — the grant does not exist. Asserted from inside an
  // outlet's own connection, which is the credential an attacker would have.
  await assert.rejects(
    () => db.withOutletRead({ outletId, rank: 5, actor: null },
      (c) => c.query('SELECT email FROM chain.account')),
    /permission denied|does not exist/i,
    'chain.account is unreachable from an outlet role');
});

test('only enabled sign-in methods are offered', opts, async () => {
  const p = await get('/api/account/providers');
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.password, undefined);
  assert.strictEqual(p.body.password, true);
  assert.strictEqual(p.body.code, true);
  // No credentials configured in the test environment, so neither is offered —
  // a button that cannot work is worse than no button.
  assert.strictEqual(p.body.google, false);
  assert.strictEqual(p.body.apple, false);
});

test('isolation holds — the leak test runs in the pipeline', opts, async () => {
  const { run } = require('../src/scripts/leak-test');
  const out = await run(() => {});
  assert.strictEqual(out.leaks, 0,
    out.results.filter((r) => r.leaked).map((r) => r.name).join(', '));
  assert.ok(out.results.length >= 12, 'every crossing attempt was made');
});

/* ═══ THE SECOND BELT, READ RATHER THAN TRUSTED ════════════════════════════
   `npm run leak-test` proves thirteen specific crossings fail. That is the
   right test for the crossings somebody thought of; it says nothing about the
   table added next year. This is the other half — the INVARIANT, asked of the
   catalog itself, so a new `chain.*` table cannot arrive unprotected and pass.

   There are exactly two ways a control-plane table may be safe, and every one
   of them is one or the other:

     BY POLICY — `FORCE ROW LEVEL SECURITY` and at least one policy, so even
     the table's owner is filtered. Eleven tables.

     BY ABSENCE OF GRANT — no privilege of any kind to any outlet login role,
     which is what migration 011 does to the account plane. There is no policy
     to get wrong because there is no way in. Six tables.

   A table with neither is reachable and unfiltered, which is the cross-tenant
   exposure this whole build is arranged to make impossible. */
test('every control-plane table is either policied or ungranted', opts, async () => {
  const q = await db.owner().query(`
    SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
      coalesce((SELECT array_agg(DISTINCT g.privilege_type::text ORDER BY g.privilege_type::text)
        FROM information_schema.role_table_grants g
        WHERE g.table_schema = 'chain' AND g.table_name = c.relname
          AND g.grantee ~ '^outlet_[0-9]+_app$'), '{}'::text[]) AS granted
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'chain' AND c.relkind = 'r' ORDER BY 1`);

  assert.ok(q.rows.length >= 15, 'the control plane was actually read');
  let policied = 0; let ungranted = 0;
  q.rows.forEach((r) => {
    const grants = r.granted || [];
    if (!grants.length) { ungranted++; return; }
    policied++;
    assert.ok(r.rls && r.forced,
      'chain.' + r.t + ' is granted to outlet roles (' + grants.join(', ')
      + ') and does not FORCE row level security — an outlet could read another'
      + " outlet's rows, or the table's own owner could");
    assert.ok(r.policies > 0,
      'chain.' + r.t + ' forces RLS with no policy at all, which denies every'
      + ' row to every outlet: a table nobody can read is a broken feature,'
      + ' not a secure one');
    // DELETE is never granted anywhere on the control plane. A till corrects by
    // writing, never by removing — and a compromised one must not be able to
    // shred the row that proves what it did.
    assert.ok(!grants.includes('DELETE') && !grants.includes('TRUNCATE'),
      'chain.' + r.t + ' lets an outlet role remove rows');
  });
  /* Three of the tables this used to count as "ungranted" — account,
     account_identity, account_outlet — are not in a business database at all
     any more: they live in the control registry, because one account may own
     several businesses. That is the same protection in a stronger form, so the
     floor drops rather than the rule changing. Absence is checked separately,
     in test/tenancy.test.js, which asserts a business database holds no copy
     of them and that an outlet role cannot reach the registry. */
  assert.ok(policied >= 10 && ungranted >= 3,
    'both halves of the belt are in use: ' + policied + ' policied, '
    + ungranted + ' ungranted');
  assert.ok(!q.rows.some((r) => r.t === 'account'),
    'and the account plane is absent, not merely ungranted');

  // The trail is append-only from the floor, by grant rather than by policy —
  // an outlet role that could UPDATE chain.audit could rewrite what it did.
  const audit = q.rows.find((r) => r.t === 'audit');
  assert.deepStrictEqual(audit.granted, ['INSERT'],
    'chain.audit is written and never edited from an outlet');
});

test('no policy on the control plane is unconditional', opts, async () => {
  /* A policy is only worth having if it asks the transaction who it is. One
     written `USING (true)` — the easy shape to reach for when a query comes
     back empty during development — is FORCE RLS that filters nothing, and it
     reads as protected from every angle except this one. */
  const q = await db.owner().query(`
    SELECT c.relname AS t, p.polname AS name, p.polcmd AS cmd,
      coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual,
      coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS chk
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'chain' ORDER BY 1, 2`);

  assert.ok(q.rows.length >= 18, 'every policy was read');
  const asks = /app\.current_outlet\(\)|app\.current_rank\(\)|app\.group_scope\(\)/;
  q.rows.forEach((r) => {
    const body = [r.qual, r.chk].filter(Boolean).join(' AND ');
    assert.ok(body, 'chain.' + r.t + '.' + r.name + ' has no expression at all');
    assert.ok(asks.test(body),
      'chain.' + r.t + '.' + r.name + ' never reads the transaction context: '
      + body);
    assert.ok(!/^\(?true\)?$/i.test(r.qual.trim()),
      'chain.' + r.t + '.' + r.name + ' is USING (true)');
  });

  /* And the context it reads is transaction-scoped, so a pooled connection
     cannot carry one request's identity into the next. Proven rather than
     read: set it, leave, come back on the same pool. */
  const c = await db.owner().connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.outlet_id', '424242', true)");
    const inside = await c.query('SELECT app.current_outlet() AS o');
    assert.strictEqual(Number(inside.rows[0].o), 424242);
    await c.query('COMMIT');
    const after = await c.query('SELECT app.current_outlet() AS o');
    assert.strictEqual(after.rows[0].o, null,
      'the identity died at COMMIT — a SET LOCAL that outlived its transaction'
      + ' is one outlet answering with another\'s context');
  } finally { c.release(); }
});

/* ═══ A STORE HAS AN ADDRESS ══════════════════════════════════════════════
   The shape rule is written twice — src/handle.js for the browser, and
   chain.handle_shape_ok() for the database — and two copies of a rule are two
   rules the moment one is edited. Every case in test/handle.test.js is run
   through the SQL half here, so a divergence fails rather than ships. */
test('the browser rule and the database rule agree on an address', opts, async () => {
  const HANDLE = require('../src/handle');
  const cases = ['sea-house', 's3a-h0use-2', 'abc', 'a'.repeat(40),
    'ab', '', 'a'.repeat(41), '-nope', 'nope-', 'no--pe',
    'Sea-House', 'sea_house', 'sea house', 'sea.house', 'sea/house'];
  const q = await db.owner().query(
    'SELECT h, chain.handle_shape_ok(h) AS ok FROM unnest($1::text[]) AS h', [cases]);
  q.rows.forEach((r) => assert.strictEqual(r.ok, HANDLE.ok(r.h),
    JSON.stringify(r.h) + ': the database says ' + r.ok
    + ' and the browser says ' + HANDLE.ok(r.h)));
});

test('a reserved address cannot become a store, and the refusal names why', opts, async () => {
  // Not hypothetical: webmail. and demo. are probed by scanners on the live
  // domain daily, and before migration 012 either was claimable.
  for (const h of ['www', 'webmail', 'demo', 'api', 'admin', 'member']) {
    const why = await db.control().query('SELECT chain.handle_why($1) AS w', [h]);
    assert.ok(why.rows[0].w, h + ' must not be free');
    assert.ok(/reserved for/.test(why.rows[0].w),
      h + ' is refused by name, not as "invalid": ' + why.rows[0].w);
  }
  // And the trigger refuses it even when nothing asked chain.handle_why first.
  await assert.rejects(
    db.owner().query("UPDATE chain.outlet SET slug = 'webmail' WHERE id = $1", [outletId]),
    /reserved/, 'the database refuses it whoever asks');
});

test('a chosen address is honoured or refused, never quietly swapped', opts, async () => {
  const { claimHandle } = require('../src/provision');
  const c = await db.owner().connect();
  try {
    const mine = await c.query('SELECT slug FROM chain.outlet WHERE id = $1', [outletId]);
    const taken = mine.rows[0].slug;
    // Chosen and free: honoured exactly.
    assert.strictEqual(await claimHandle(c, { slug: 'reef-grill-test' }, 999), 'reef-grill-test');
    // Chosen and taken: refused BY NAME. Handing back a different address is
    // how a business prints one thing and the database holds another.
    await assert.rejects(() => claimHandle(c, { slug: taken }, 999), /already another/);
    await assert.rejects(() => claimHandle(c, { slug: 'Sea House' }, 999), /letters, numbers/);
    // Merely derived from the name: a suggestion, so it steps aside.
    const derived = await claimHandle(c, { name: taken.replace(/-/g, ' ') }, 999);
    assert.notStrictEqual(derived, taken, 'a derived address gives way to a taken one');
    assert.ok(/^[a-z0-9-]+$/.test(derived), derived);
  } finally { c.release(); }
});

test('a store answers on its own address; the apex answers with the terminal', opts, async () => {
  process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  const mine = await db.owner().query('SELECT slug FROM chain.outlet WHERE id = $1', [outletId]);
  const handle = mine.rows[0].slug;

  const portal = await callHost(handle + '.kashikeyopos.com', 'GET', '/');
  assert.strictEqual(portal.status, 200);
  assert.ok(/guest-bridge\.js/.test(portal.text), 'the QR ordering portal');
  assert.ok(!/kpos-bridge\.js/.test(portal.text), 'and NOT the till');

  const card = await callHost(handle + '.kashikeyopos.com', 'GET', '/member');
  assert.ok(/guest-bridge\.js/.test(card.text), 'the customer card is on the same address');

  const apex = await callHost('kashikeyopos.com', 'GET', '/');
  assert.ok(/kpos-bridge\.js/.test(apex.text), 'the apex is the business\'s own software');

  // A guest who mistypes a path on a store's address must not land on the
  // back office.
  const stray = await callHost(handle + '.kashikeyopos.com', 'GET', '/nonsense');
  assert.strictEqual(stray.status, 404);
  assert.ok(/guest-bridge\.js/.test(stray.text), 'and lands back on the portal');

  // The till has one home, and it is not a store's subdomain.
  for (const p of ['/pos', '/kds', '/admin', '/onboarding', '/account']) {
    const r = await callHost(handle + '.kashikeyopos.com', 'GET', p);
    assert.strictEqual(r.status, 308, p + ' redirects off the store address');
    assert.strictEqual(r.headers.location, 'https://kashikeyopos.com' + p);
  }

  // And that home follows PUBLIC_URL: with the apex given to the product's
  // website, the till lives at app.<base> — served there as itself, never
  // mistaken for a store called "app", and the 308s follow it.
  const pub = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://app.kashikeyopos.com';
  try {
    const till = await callHost('app.kashikeyopos.com', 'GET', '/');
    assert.strictEqual(till.status, 200);
    assert.ok(/kpos-bridge\.js/.test(till.text), 'the till answers on its own host');
    assert.ok(!/guest-bridge\.js/.test(till.text), 'and it is not a portal for a store "app"');
    const off = await callHost(handle + '.kashikeyopos.com', 'GET', '/pos');
    assert.strictEqual(off.headers.location, 'https://app.kashikeyopos.com/pos',
      'the store-host 308 follows the till home');
    const still = await callHost(handle + '.kashikeyopos.com', 'GET', '/');
    assert.ok(/guest-bridge\.js/.test(still.text), 'store portals stay on the base domain');
  } finally {
    if (pub) process.env.PUBLIC_URL = pub; else delete process.env.PUBLIC_URL;
  }
});

test('the host mints the same table token the path does', opts, async () => {
  process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  const mine = await db.owner().query('SELECT slug FROM chain.outlet WHERE id = $1', [outletId]);
  const handle = mine.rows[0].slug;

  const byHost = await callHost(handle + '.kashikeyopos.com', 'GET', '/api/g/token?t=T04');
  assert.strictEqual(byHost.status, 200, byHost.text);
  const a = JSON.parse(byHost.text);
  assert.strictEqual(a.outlet.slug, handle);
  assert.strictEqual(a.table, 'T04');

  const byPath = await get('/api/g/' + handle + '/token?t=T04');
  assert.strictEqual(byPath.body.outlet.id, a.outlet.id, 'the same store, either way');

  // The apex is not a store, and neither is a handle nobody answers to.
  const onApex = await callHost('kashikeyopos.com', 'GET', '/api/g/token');
  assert.strictEqual(onApex.status, 404);
  const nobody = await callHost('nosuchstore.kashikeyopos.com', 'GET', '/api/g/token');
  assert.strictEqual(nobody.status, 404);
});

test('the onboarding address check answers the same question the save will', opts, async () => {
  const mine = await db.owner().query('SELECT slug FROM chain.outlet WHERE id = $1', [outletId]);
  const taken = mine.rows[0].slug;
  const cases = [[taken, false], ['webmail', false], ['Sea House', false],
    ['ab', false], ['a-brand-new-address', true]];
  for (const [h, free] of cases) {
    const r = await get('/api/onboarding/handle?h=' + encodeURIComponent(h));
    assert.strictEqual(r.body.free, free, h + ' -> free=' + r.body.free);
    if (!free) assert.ok(r.body.why, h + ' is refused with a reason');
    else assert.strictEqual(r.body.url, 'https://' + h + '.' + r.body.base);
  }
  // It also hands back the suggestion, so the panel need not know the rules.
  const s = await get('/api/onboarding/handle?h=&from=' + encodeURIComponent('Sea House Café'));
  assert.strictEqual(s.body.suggested, 'sea-house-cafe');
});

/* ═══ A STORE MAY MOVE, AND ITS OLD ADDRESS MUST NOT ══════════════════════
   The whole reason renaming is allowed is that the address it leaves keeps
   working. A dead QR is bad; a QR pointing at somebody else's menu is worse. */
test('renaming a store is the owner\'s, and nobody else\'s', opts, async () => {
  const till = await post('/api/auth/pin', { outletId, pin: '6520' });
  const mgr = await post('/api/auth/pin', { outletId, pin: '7364' });
  for (const t of [till.body.token, mgr.body.token]) {
    const r = await patch('/api/outlet/' + outletId + '/handle', { handle: 'nice-try' }, t);
    assert.strictEqual(r.status, 403, 'a rank below owner cannot change the address');
    assert.match(r.body.error, /Rank 5 required — Owner/, r.body.error);
  }
  const now = await db.owner().query('SELECT slug FROM chain.outlet WHERE id = $1', [outletId]);
  assert.notStrictEqual(now.rows[0].slug, 'nice-try', 'and nothing moved');
});

test('a renamed store keeps the address it left', opts, async () => {
  process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  const before = (await db.owner().query(
    'SELECT slug FROM chain.outlet WHERE id = $1', [outletId])).rows[0].slug;

  const done = await patch('/api/outlet/' + outletId + '/handle',
    { handle: 'moved-house' }, token);
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(done.body.was, before);
  assert.strictEqual(done.body.handle, 'moved-house');
  assert.strictEqual(done.body.url, 'https://moved-house.kashikeyopos.com');

  // The card already on the table: 301, keeping the path and the table on it.
  const old = await callHost(before + '.kashikeyopos.com', 'GET', '/?t=T04');
  assert.strictEqual(old.status, 301, 'the address it left redirects');
  assert.strictEqual(old.headers.location,
    'https://moved-house.kashikeyopos.com/?t=T04');

  // The new one does not.
  const now = await callHost('moved-house.kashikeyopos.com', 'GET', '/');
  assert.strictEqual(now.status, 200);

  // The path form self-heals instead: it resolves and hands back the CURRENT
  // address, which the page then uses for everything after.
  const byPath = await get('/api/g/' + before + '/token?t=T04');
  assert.strictEqual(byPath.status, 200, JSON.stringify(byPath.body));
  assert.strictEqual(byPath.body.outlet.slug, 'moved-house');
  assert.strictEqual(byPath.body.movedFrom, before);
});

test('the address a store left is nobody else\'s to take', opts, async () => {
  // The registry owns retired addresses now: they have to outlive a business
  // database being restored, and nobody else may claim them meanwhile.
  const left = (await db.control().query(
    'SELECT name FROM chain.handle_history WHERE outlet_id = $1'
    + ' ORDER BY retired_at DESC LIMIT 1', [outletId])).rows[0].name;

  // To another outlet it is taken — a guest scanning the card in front of them
  // must never land on a competitor's menu.
  const other = outletId + 1;
  const why = await db.control().query('SELECT chain.handle_why($1,$2) AS w', [left, other]);
  assert.ok(why.rows[0].w, left + ' must not be free to outlet ' + other);
  assert.match(why.rows[0].w, /still points at it/, why.rows[0].w);

  // To the outlet that left it, it is its own name to take back.
  const mine = await db.control().query('SELECT chain.handle_why($1,$2) AS w', [left, outletId]);
  assert.strictEqual(mine.rows[0].w, null);

  const back = await patch('/api/outlet/' + outletId + '/handle', { handle: left }, token);
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  assert.strictEqual(back.body.handle, left);

  // And it stops being history — an outlet at an address does not redirect to
  // itself.
  const still = await db.control().query(
    'SELECT 1 FROM chain.handle_history WHERE name = $1', [left]);
  assert.strictEqual(still.rows.length, 0, 'the address it took back is not history');
  const hit = await callHost(left + '.kashikeyopos.com', 'GET', '/');
  assert.strictEqual(hit.status, 200, 'and it answers there rather than redirecting');
});

test('a rename is refused by name, and refusing changes nothing', opts, async () => {
  const before = (await db.owner().query(
    'SELECT slug FROM chain.outlet WHERE id = $1', [outletId])).rows[0].slug;
  const cases = [
    ['webmail', 409, /reserved for mail/],
    ['Sea House', 400, /letters, numbers/],
    ['ab', 400, /at least 3/],
    ['', 400, /required/]
  ];
  for (const [h, status, why] of cases) {
    const r = await patch('/api/outlet/' + outletId + '/handle', { handle: h }, token);
    assert.strictEqual(r.status, status, h + ' -> ' + r.status + ' ' + JSON.stringify(r.body));
    assert.match(r.body.error, why, r.body.error);
  }
  const after = (await db.owner().query(
    'SELECT slug FROM chain.outlet WHERE id = $1', [outletId])).rows[0].slug;
  assert.strictEqual(after, before, 'a refused rename left the store where it was');
});

/* ═══ THE PREVIOUS TENANT ══════════════════════════════════════════════════
   This build keeps everything it owns in chain, app and outlet_<id>, and never
   touches `public` — which is why it could be deployed onto a database that
   still held the app before it without deleting anything first. Removing that
   app afterwards is a separate, deliberate act, and it destroys data nothing in
   this repository created. */
test('the legacy drop refuses without both of its guards', opts, async () => {
  const legacy = require('../src/scripts/drop-legacy');
  const was = process.env.DROP_LEGACY_PUBLIC;
  await db.owner().query('CREATE TABLE IF NOT EXISTS public.guarded (id int)');
  try {
    delete process.env.DROP_LEGACY_PUBLIC;
    await assert.rejects(() => legacy.run(() => {}), /yes-i-mean-it/,
      'a flag that can be set by accident is not a guard');
    process.env.DROP_LEGACY_PUBLIC = 'maybe';
    await assert.rejects(() => legacy.run(() => {}), /yes-i-mean-it/);

    const still = await db.owner().query("SELECT to_regclass('public.guarded') IS NOT NULL AS ok");
    assert.strictEqual(still.rows[0].ok, true, 'and nothing was dropped on the way');
  } finally {
    if (was === undefined) delete process.env.DROP_LEGACY_PUBLIC;
    else process.env.DROP_LEGACY_PUBLIC = was;
  }
});

test('the legacy drop clears public and leaves this app alone', opts, async () => {
  const legacy = require('../src/scripts/drop-legacy');
  const o = db.owner();
  // A plausible previous tenant: rows, a view, a sequence, a routine, a type —
  // and an extension, which is NOT the old app's data and may well be holding
  // this one up.
  await o.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await o.query('CREATE TABLE IF NOT EXISTS public.entities'
    + ' (id serial PRIMARY KEY, org_id int, data jsonb)');
  await o.query("INSERT INTO public.entities (org_id, data)"
    + " SELECT g, '{}'::jsonb FROM generate_series(1,25) g");
  await o.query('CREATE OR REPLACE VIEW public.v_old AS SELECT id FROM public.entities');
  await o.query('CREATE SEQUENCE IF NOT EXISTS public.old_counter');
  await o.query("CREATE OR REPLACE FUNCTION public.old_total(a int, b int)"
    + " RETURNS int LANGUAGE sql AS 'SELECT a + b'");

  const before = await o.query('SELECT count(*)::int AS n FROM chain.outlet');
  const was = process.env.DROP_LEGACY_PUBLIC;
  process.env.DROP_LEGACY_PUBLIC = 'yes-i-mean-it';
  let out;
  try { out = await legacy.run(() => {}); }
  finally {
    if (was === undefined) delete process.env.DROP_LEGACY_PUBLIC;
    else process.env.DROP_LEGACY_PUBLIC = was;
  }
  assert.ok(out.dropped >= 4, 'it dropped what was there (' + out.dropped + ')');
  assert.ok(out.rows >= 25, 'and counted the rows it destroyed (' + out.rows + ')');

  const left = await o.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
    + " WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')"
    + "   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')");
  assert.strictEqual(left.rows[0].n, 0, 'public is clear');

  // The extension survives, and so does what depends on it. DROP SCHEMA public
  // CASCADE would have taken pgcrypto with the rest.
  const ext = await o.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'");
  assert.strictEqual(ext.rows[0].n, 1, 'an extension in public is not the old app\'s data');
  await o.query('SELECT gen_random_uuid()');

  // And the only thing that actually matters.
  const after = await o.query('SELECT count(*)::int AS n FROM chain.outlet');
  assert.strictEqual(after.rows[0].n, before.rows[0].n, 'this app is untouched');
  const boot = await get('/api/auth/install');
  assert.strictEqual(boot.status, 200, 'and still serving');
});

/* ═══ AN EMAIL FROM A PROVIDER IS A CLAIM, NOT A FACT ══════════════════════
   Matching an incoming Google or Apple identity to an existing account BY
   ADDRESS is the convenience that makes "Continue with Google" work for
   somebody who first signed up with a password. It is only safe when the
   provider says it verified that address — otherwise a provider account
   asserting somebody else's email walks straight into their business.

   Driven through the real callback with the provider's token endpoint stubbed,
   because that is the only way to exercise the path a browser actually takes. */
function fakeProvider(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // An id_token as it arrives from a token endpoint: read, never trusted for
  // authorisation, so an unsigned one exercises the same code path.
  const idToken = b64({ alg: 'RS256' }) + '.' + b64(claims) + '.' + 'sig';
  const real = global.fetch;
  // ONLY the provider's token endpoint. A blanket stub also swallows this
  // suite's own requests to the app, which is a test that fails for a reason
  // that has nothing to do with the thing under test.
  global.fetch = async (url, opts) => {
    if (/googleapis\.com|appleid\.apple\.com/.test(String(url))) {
      return { ok: true, json: async () => ({ id_token: idToken, access_token: 'x' }) };
    }
    return real(url, opts);
  };
  return () => { global.fetch = real; };
}

test('a social sign-in joins an existing account only on a VERIFIED address', opts, async () => {
  const { signAccount } = require('../src/secrets');
  const wasId = process.env.GOOGLE_CLIENT_ID;
  const wasSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

  const sign = (nonce) => signAccount({ n: 'x', p: 'google', nn: nonce,
    exp: Date.now() + 60e3 });
  const realFetch = global.fetch;

  try {
    // Somebody already has an account here, made the ordinary way.
    const mine = 'owner-' + Date.now() + '@example.mv';
    const made = await post('/api/account/signup', { email: mine, password: 'a-real-password' });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    const before = await db.control().query(
      'SELECT id FROM chain.account WHERE lower(email) = lower($1)', [mine]);
    assert.strictEqual(before.rows.length, 1);

    // 1 · An UNVERIFIED provider email bearing that address is refused, by name.
    let restore = fakeProvider({ sub: 'g-stranger', email: mine,
      email_verified: false, nonce: 'n1' });
    let r = await call('GET', '/api/account/oauth/google/callback?code=c&state='
      + encodeURIComponent(sign('n1')), undefined, {});
    restore();
    assert.strictEqual(r.status, 302, 'it redirects rather than signing in');
    const to = String((r.headers && r.headers.location) || r.body && r.body.raw || '');
    assert.ok(/error=/.test(to), 'and carries a refusal: ' + to);
    assert.match(decodeURIComponent(to), /already has an account/);

    const linked = await db.control().query(
      "SELECT 1 FROM chain.account_identity WHERE subject = 'g-stranger'");
    assert.strictEqual(linked.rows.length, 0, 'no identity was attached to their account');

    // 2 · The same address, VERIFIED, is the person coming back — it joins.
    restore = fakeProvider({ sub: 'g-owner', email: mine, email_verified: true, nonce: 'n2' });
    r = await call('GET', '/api/account/oauth/google/callback?code=c&state='
      + encodeURIComponent(sign('n2')), undefined, {});
    restore();
    const back = String((r.headers && r.headers.location) || '');
    assert.ok(/#token=/.test(back), 'signed in: ' + back);

    const joined = await db.control().query(
      "SELECT account_id FROM chain.account_identity WHERE subject = 'g-owner'");
    assert.strictEqual(joined.rows.length, 1);
    assert.strictEqual(joined.rows[0].account_id, before.rows[0].id,
      'and it is the SAME account, not a second one');

    // 3 · A mismatched nonce is an id_token from some other request.
    restore = fakeProvider({ sub: 'g-owner', email: mine, email_verified: true,
      nonce: 'not-the-one' });
    r = await call('GET', '/api/account/oauth/google/callback?code=c&state='
      + encodeURIComponent(sign('n3')), undefined, {});
    restore();
    assert.match(decodeURIComponent(String((r.headers && r.headers.location) || '')),
      /did not complete/, 'a replayed or swapped id_token is refused');
  } finally {
    // A stub left installed by a failing assertion breaks every test after it.
    global.fetch = realFetch;
    if (wasId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = wasId;
    if (wasSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = wasSecret;
  }
});

test('the providers list says WHY a provider is off', opts, async () => {
  const p = await get('/api/account/providers');
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.google, false, 'not configured in the test environment');
  assert.ok(p.body.why, 'and it says so');
  assert.match(p.body.why.apple, /not configured|missing/);
  // Never the values — only which names are absent.
  assert.ok(!/=/.test(JSON.stringify(p.body.why)), 'no values leak into the reason');
});

/* ═══ NOT EVERY BUSINESS IS REGISTERED FOR GST ═════════════════════════════
   Registration is conditional (migration 009: MVR 1,000,000 over 12 months,
   tourism always). A business below the threshold charges nothing and NO TAX
   LINE PRINTS — a document showing one claims a registration it does not hold.

   The database refuses the inconsistent states outright, because "the whole
   application behaves" is not something four route files can promise between
   them. This is the whole lifecycle: unregistered, trading, then registering
   when the threshold is crossed. It runs last because it changes the company. */
/* ═══ WHERE AN ORDER IS ══════════════════════════════════════════════════════
   The kitchen ticked both lines done and finished the table; Orders & Tickets
   still said "Open". Four screens held four different answers and none of them
   reached the database: the pass bumped a MENU id at an op that wanted a docket
   row, the whole-table bump filtered on a station the payload never carried,
   and the floor's own status move wrote to `dispatch` — a stock transfer
   between outlets, an entirely different noun.

   So none of it survived a refresh either, and the second tablet on the floor
   never learned any of it.
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══ A BATCH IS APPLIED IN BOUNDED PIECES, AND THE PIECES STAY IN ORDER ═══
   The whole push used to be one transaction, which is where the only error in
   the load campaign came from: eight outboxes draining 80 ops each held pooled
   connections up to 16.9 s — past the 8 s checkout bound the others were
   waiting on, and past the 15 s statement timeout, which is what cancelled it.
   Measured again here on this box before the change: p99 17,615 ms, one
   request in 132 cancelled by the statement timeout. After: p99 7,798 ms and
   no errors, across two runs, with live serving unchanged.

   The split is only safe if order survives it, and order is the whole contract
   — open the ticket, add the line, fire the course. Sorted or split wrongly, a
   line is added to a ticket that does not exist yet. So this sends a run
   LONGER than one chunk whose ops depend on each other across the boundary,
   and asks the outlet what it ended up holding. */
test('a push longer than one chunk keeps every op and their order', opts, async () => {
  const table = 'T29';
  // Comfortably past the chunk size, so the dependency chain is split.
  const N = 60;
  const lids = Array.from({ length: N }, () => uuid());
  const ops = [{ opId: uuid(), kind: 'open_ticket', lamport: 1,
    payload: { table: table, split: 0, covers: 2 } }];
  lids.forEach((lid, i) => ops.push({ opId: uuid(), kind: 'add_line', lamport: i + 2,
    payload: { table: table, split: 0, lid: lid, item: 'm1',
      name: 'Line ' + (i + 1), qty: 1, price: 10 } }));

  const r = await push(ops);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((r.body.results || []).length, ops.length, 'every op is answered');
  const errs = (r.body.results || []).filter((x) => x.error);
  assert.strictEqual(errs.length, 0, 'and none refused: ' + JSON.stringify(errs.slice(0, 3)));

  /* The ticket the FIRST op opened is the one every later chunk added to. If
     the split had reordered anything, add_line would have found no ticket and
     ticketRef() would have created a second one under the same table. */
  const tks = await all2("SELECT id FROM ticket WHERE table_no = $1 AND status = 'open'", [table]);
  assert.strictEqual(tks.length, 1, 'one ticket, not one per chunk');

  const n = await one('SELECT count(*)::int AS n FROM ticket_line WHERE ticket_id = $1', [tks[0].id]);
  assert.strictEqual(n.n, N, 'and every line landed on it');

  // Replayed whole, it is a no-op — op_log is keyed by opId, and a chunk that
  // committed before a later one failed must come back as a replay, never a
  // double.
  const again = await push(ops);
  assert.strictEqual(again.status, 200);
  assert.ok((again.body.results || []).every((x) => x.replay), 'a re-push is all replays');
  const n2 = await one('SELECT count(*)::int AS n FROM ticket_line WHERE ticket_id = $1', [tks[0].id]);
  assert.strictEqual(n2.n, N, 'and nothing was added twice');

  // The same op twice in ONE delivery is still caught, whichever chunks it
  // lands in — the seen-set spans the push, not the piece.
  const dup = { opId: uuid(), kind: 'sign_in', label: 'chunk dup probe' };
  const spread = [dup].concat(
    Array.from({ length: 40 }, () => ({ opId: uuid(), kind: 'sign_in', label: 'filler' })),
    [dup]);
  const d = await push(spread);
  assert.strictEqual(d.status, 200);
  const dupes = (d.body.results || []).filter((x) => x.opId === dup.opId);
  assert.strictEqual(dupes.length, 2, 'both copies are answered');
  assert.ok(dupes.some((x) => x.replay), 'and the second is named a replay');
});

test('the pass finishing the food moves the order everyone reads', opts, async () => {
  const table = 'T07';
  const lidA = uuid(), lidB = uuid();
  await push([
    { opId: uuid(), kind: 'open_ticket', payload: { table: table, split: 0, covers: 2 } },
    { opId: uuid(), kind: 'add_line', payload: { table: table, split: 0, lid: lidA, item: 'm1', name: 'Grilled Reef Fish', qty: 1, price: 185 } },
    { opId: uuid(), kind: 'add_line', payload: { table: table, split: 0, lid: lidB, item: 'm2', name: 'Garlic Rice', qty: 1, price: 45 } }
  ]);

  const rung = async () => Number((await one('SELECT stage FROM ticket WHERE table_no = $1'
    + " AND status = 'open'", [table])).stage);
  const cooking = async () => Number((await one('SELECT count(*)::int AS n FROM ticket_line l'
    + ' JOIN ticket t ON t.id = l.ticket_id WHERE t.table_no = $1'
    + ' AND l.sent_at IS NOT NULL AND l.ready_at IS NULL', [table])).n);

  assert.strictEqual(await rung(), 0, 'nothing fired — the order is still being taken');

  await push([{ opId: uuid(), kind: 'fire_course',
    payload: { table: table, split: 0, lids: [lidA, lidB], station: 'hot', target: 12 } }]);
  assert.strictEqual(await rung(), 1, 'fired — the order is in the kitchen');
  assert.strictEqual(await cooking(), 2, 'and both plates are up');

  // One line comes back at the pass. The order stays in the kitchen, because
  // the other plate is still cooking — this is the half of it a table plated
  // in pieces gets wrong.
  await push([{ opId: uuid(), kind: 'kds_bump',
    payload: { table: table, split: 0, lid: lidA } }]);
  assert.strictEqual(await cooking(), 1, 'that plate is finished');
  assert.strictEqual(await rung(), 1, 'the table is not away on one plate');

  // The second one. Now the kitchen is done, and the order says so — to the
  // orders list, to the floor and to the guest, off one number.
  await push([{ opId: uuid(), kind: 'kds_bump',
    payload: { table: table, split: 0, lid: lidB } }]);
  assert.strictEqual(await cooking(), 0, 'nothing left cooking');
  assert.strictEqual(await rung(), 2, 'the order is ready at the pass');

  // The terminal reads it back. A tablet coming up mid-service, and the same
  // tablet after a refresh, must be told what the pass already did.
  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const tk = boot.body.state.tickets[table + ':0'];
  assert.ok(tk, 'the outlet holds the open ticket');
  assert.strictEqual(tk.stage, 2, 'the bootstrap carries the rung');
  assert.deepStrictEqual(tk.lines.map((l) => l.done), [true, true],
    'and which plates the pass has finished');

  // A bump undone puts the food back up and the order back in the kitchen —
  // the guest was told Ready and it was not.
  await push([{ opId: uuid(), kind: 'kds_recall',
    payload: { table: table, split: 0, lids: [lidB] } }]);
  assert.strictEqual(await rung(), 1, 'recalled — back in the kitchen');
  assert.strictEqual(await cooking(), 1, 'and the plate is up again');
});

test('the floor moving the status moves the order, not a stock transfer', opts, async () => {
  const table = 'T08';
  const lid = uuid();
  await push([
    { opId: uuid(), kind: 'open_ticket', payload: { table: table, split: 0, covers: 2 } },
    { opId: uuid(), kind: 'add_line', payload: { table: table, split: 0, lid: lid, item: 'm2', name: 'Garlic Rice', qty: 1, price: 45 } },
    { opId: uuid(), kind: 'fire_course', payload: { table: table, split: 0, lids: [lid], station: 'hot' } }
  ]);

  const row = async () => one('SELECT stage FROM ticket WHERE table_no = $1'
    + " AND status = 'open'", [table]);
  const ready = async () => (await one('SELECT ready_at FROM ticket_line l JOIN ticket t'
    + ' ON t.id = l.ticket_id WHERE t.table_no = $1', [table])).ready_at;

  // The counter says served. Ready or later means the kitchen is done with it,
  // so the pass agrees rather than holding the ticket on screen for ever.
  const r = await push([{ opId: uuid(), kind: 'fulfil_stage',
    payload: { table: table, split: 0, stage: 3 } }]);
  assert.strictEqual(r.body.results[0].result.stage, 3, 'the op reports the rung it set');
  assert.strictEqual(Number((await row()).stage), 3, 'the order is served');
  assert.ok(await ready(), 'and the pass was cleared with it');

  // Dragging it back is a real correction: the food goes back up.
  await push([{ opId: uuid(), kind: 'fulfil_stage',
    payload: { table: table, split: 0, stage: 1 } }]);
  assert.strictEqual(Number((await row()).stage), 1, 'back in the kitchen');
  assert.strictEqual(await ready(), null, 'and the plate is cooking again');

  // A later course reopens an order the pass had finished, or the guest is
  // told Ready while their next round is on the grill.
  await push([{ opId: uuid(), kind: 'fulfil_stage', payload: { table: table, split: 0, stage: 2 } }]);
  const lid2 = uuid();
  await push([
    { opId: uuid(), kind: 'add_line', payload: { table: table, split: 0, lid: lid2, item: 'm1', name: 'Grilled Reef Fish', qty: 1, price: 185 } },
    { opId: uuid(), kind: 'fire_course', payload: { table: table, split: 0, lids: [lid2], station: 'hot' } }
  ]);
  assert.strictEqual(Number((await row()).stage), 1, 'a fired course reopens the order');

  // The op that used to run here wrote to `dispatch`. Nothing in this outlet's
  // stock movements has been touched by a waiter pressing Served.
  const disp = await one('SELECT count(*)::int AS n FROM dispatch');
  assert.strictEqual(disp.n, 0, 'no stock transfer was invented by a status change');
});

test('an unregistered business cannot be given a rate to charge', opts, async () => {
  const o = db.owner();
  await o.query("UPDATE chain.outlet SET tax_code = 'NONE'");
  await o.query("DELETE FROM chain.tax_version WHERE outlet_id IS NOT NULL AND code <> 'NONE'");
  await o.query('UPDATE chain.company SET gst_registered = false, tin = NULL WHERE id = 1');

  assert.strictEqual((await o.query('SELECT chain.gst_registered() AS on')).rows[0].on, false);

  // A registered business has a TIN; an unregistered one has none to give.
  await assert.rejects(
    o.query('UPDATE chain.company SET gst_registered = true WHERE id = 1'),
    /company_tin_iff_registered/, 'cannot be registered without a TIN');

  // An outlet cannot charge what its company is not registered to collect.
  await assert.rejects(
    o.query("UPDATE chain.outlet SET tax_code = 'GGST' WHERE id = $1", [outletId]),
    /not registered for GST/, 'refused by name, naming the outlet');

  // Nor hold a rate version, which is the thing a receipt actually quotes.
  await assert.rejects(
    o.query('INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from)'
      + " VALUES ($1,'GGST',8,current_date)", [outletId]),
    /cannot hold a GGST rate/);

  // The STATUTORY history is untouched: those are facts about the Maldives,
  // shipped whether or not this business is registered.
  const statutory = await o.query(
    'SELECT count(*)::int AS n FROM chain.tax_version WHERE outlet_id IS NULL');
  assert.ok(statutory.rows[0].n > 0, 'the country\'s rates are still there');
});

test('a sale by an unregistered business carries no tax, anywhere', opts, async () => {
  const before = await one('SELECT count(*)::int AS n FROM sale');
  // The DELTA, not the balance: earlier sales in this suite were made while the
  // business was registered, and their GST is rightly still sitting there.
  const gstBefore = await one("SELECT coalesce(sum(cr - dr),0)::numeric AS n"
    + " FROM journal_line WHERE account_code = '2200'");
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 2, sub: 400, disc: 0, net: 400, svc: 0,
    // A till that has not caught up still sends a code and a rate. The server
    // recomputes from the outlet's OWN registration rather than believing it.
    tax: 32, round: 0, total: 432, taxCode: 'GGST', taxLabel: 'GGST 8%', taxRate: 8,
    server: 'Test Cashier', cur: 'MVR', rate: 1,
    sold: [{ id: 'm1', name: 'Grilled Reef Fish', qty: 2, price: 200, amount: 400, cost: 0 }],
    payments: [{ method: 'cash', amt: 432 }]
  } }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = await one('SELECT count(*)::int AS n FROM sale');
  assert.strictEqual(after.n, before.n + 1, 'the sale still went through — a cashier took the money');

  const sale = await one('SELECT tax, total, tax_code FROM sale ORDER BY at DESC LIMIT 1');
  assert.strictEqual(Number(sale.tax), 0, 'no tax was charged');
  assert.strictEqual(sale.tax_code, 'NONE', 'and the sale says which registration it was under');

  // Nothing reached the GST account, which is what a return is built from.
  const gstAfter = await one("SELECT coalesce(sum(cr - dr),0)::numeric AS n"
    + " FROM journal_line WHERE account_code = '2200'");
  assert.strictEqual(Number(gstAfter.n), Number(gstBefore.n),
    'not one laari reached GST payable');

  // The money the till over-collected did not evaporate: it rode into the
  // difference account, where somebody has to answer for it, and the sale says
  // so rather than quietly absorbing it.
  const audit = await one('SELECT server_audit FROM sale ORDER BY at DESC LIMIT 1');
  assert.ok(audit.server_audit && audit.server_audit.unregistered,
    'the discrepancy is stamped on the sale: ' + JSON.stringify(audit.server_audit));
  assert.strictEqual(Number(audit.server_audit.unregistered.charged), 32);
});

test('registering later sets the rate on every outlet at once', opts, async () => {
  const o = db.owner();
  // What GST_WATCH nags about, and the action that answers it.
  await o.query("SELECT chain.register_for_gst('1000000GST501','GGST',8,current_date)");

  const co = await o.query('SELECT gst_registered, tin FROM chain.company WHERE id = 1');
  assert.strictEqual(co.rows[0].gst_registered, true);
  assert.strictEqual(co.rows[0].tin, '1000000GST501');

  const still = await o.query("SELECT count(*)::int AS n FROM chain.outlet WHERE tax_code = 'NONE'");
  assert.strictEqual(still.rows[0].n, 0,
    'no outlet is left charging nothing while the company believes it charges GST');

  const rates = await o.query("SELECT count(*)::int AS n FROM chain.tax_version"
    + " WHERE outlet_id IS NOT NULL AND code = 'GGST'");
  assert.ok(rates.rows[0].n > 0, 'and each has a rate, dated');

  // Registering is not a text field: it refuses a registration with no TIN.
  await assert.rejects(o.query("SELECT chain.register_for_gst(NULL,'GGST',8,current_date)"),
    /TIN is required/);
  await assert.rejects(o.query("SELECT chain.register_for_gst('X','NONE',0,current_date)"),
    /NONE is not a registration/);
});

test('the doors that send email or take guesses refuse a hammer', opts, async () => {
  /* Every request in this suite arrives from one loopback address, so the
     harness runs with the ceilings scaled up (test/db.js). Here the scale
     comes back to 1 — the shipped figures — and goes back up on the way out. */
  const LIMIT = require('../src/limit');
  const prev = process.env.RATE_LIMIT_SCALE;
  process.env.RATE_LIMIT_SCALE = '1';
  LIMIT._reset();
  try {
    // Three codes to one address are a guest retrying; the fourth is a hose.
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/account/code', { email: 'hammered@example.mv' });
      assert.strictEqual(r.status, 200, 'attempt ' + (i + 1) + ' is a guest retrying');
    }
    const fourth = await post('/api/account/code', { email: 'hammered@example.mv' });
    assert.strictEqual(fourth.status, 429, 'the fourth is refused');
    assert.match(fourth.body.error, /Too many attempts/);
    assert.ok(Number(fourth.headers['retry-after']) >= 1,
      'the refusal says when to come back');

    // The refusal must not answer the question the endpoints refuse to answer:
    // a KNOWN address hammered the same way gets the byte-identical refusal.
    for (let i = 0; i < 3; i++) await post('/api/account/code', { email: 'founder@example.mv' });
    const known = await post('/api/account/code', { email: 'founder@example.mv' });
    assert.strictEqual(known.status, 429);
    assert.deepStrictEqual(known.body, fourth.body,
      'the doorman cannot be used to enumerate the customer list');

    // Somebody else on the same connection is not locked out by the hammer —
    // a restaurant's wifi is one address holding the whole room.
    const bystander = await post('/api/account/code', { email: 'bystander@example.mv' });
    assert.strictEqual(bystander.status, 200, 'one guest\'s flood is not another\'s problem');

    // But a fresh address on every call is not fresh TRAFFIC: walking the
    // identity space spends the connection's own, wider allowance.
    let walked = null;
    for (let i = 0; i < 12 && !walked; i++) {
      const r = await post('/api/account/code', { email: 'walk' + i + '@example.mv' });
      if (r.status === 429) walked = r;
    }
    assert.ok(walked, 'the connection has a ceiling of its own');

    // The member door refuses the same hammer with the same wording.
    LIMIT._reset();
    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const slug = b.body.kpos.OUTLETS[0].slug;
    const t = await get('/api/g/' + slug + '/token');
    const table = { 'x-table-token': t.body.token };
    for (let i = 0; i < 3; i++) {
      const r = await postWith('/api/g/' + slug + '/member/start', { id: '7779999' }, table);
      assert.strictEqual(r.status, 200);
    }
    const spent = await postWith('/api/g/' + slug + '/member/start', { id: '7779999' }, table);
    assert.strictEqual(spent.status, 429);
    assert.match(spent.body.error, /Too many attempts/);
  } finally {
    process.env.RATE_LIMIT_SCALE = prev || '100';
    LIMIT._reset();
  }
});

test('a split bill lands each share on its own account, to the laari', opts, async () => {
  // 100.00 split three ways: the till floors each share to 33.33 and the last
  // share takes the remainder, 33.34 — so cash-then-card-then-card must reach
  // the ledger as Dr 1010 33.33 and Dr 1030 66.67, summing to the bill with
  // no invented rounding and no repair stamp. Before this, the sale op
  // carried ONE leg — the closing share's tender for the whole total — so a
  // split bill booked its entire cash to the card receivable or vice versa.
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 3, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 2, price: 50, amount: 100 }],
    payments: [
      { method: 'cash', amt: 33.33, tendered: 33.33 },
      { method: 'card', amt: 33.33, tendered: 33.33, ref: '111111' },
      { method: 'card', amt: 33.34, tendered: 33.34, ref: '222222' }
    ], stockMoves: []
  } }]);
  const res = r.body.results[0];
  assert.ok(!res.error, JSON.stringify(res));

  const row = await one('SELECT total, server_audit FROM sale WHERE id = $1',
    [res.result.saleId]);
  assert.strictEqual(Number(row.total), 100);
  assert.strictEqual(row.server_audit, null,
    'three shares that sum to the bill are not a discrepancy');

  const pays = await one('SELECT count(*)::int AS n, sum(amount) AS amt FROM payment'
    + ' WHERE sale_id = $1', [res.result.saleId]);
  assert.strictEqual(pays.n, 3, 'every share is its own payment row');
  assert.strictEqual(Number(pays.amt), 100, 'and not a laari is lost between them');

  const lines = await one("SELECT json_agg(json_build_object('a', l.account_code,"
    + " 'dr', l.dr, 'cr', l.cr)) AS l FROM journal j"
    + ' JOIN journal_line l ON l.journal_id = j.id'
    + " WHERE j.source = 'sale' AND j.source_id = $1",
  [String(res.result.saleId)]).then((q) => q.l);
  assert.ok(lines.some((x) => x.a === '1010' && Number(x.dr) === 33.33),
    'the drawer holds exactly the cash share: ' + JSON.stringify(lines));
  assert.ok(lines.some((x) => x.a === '1030' && Number(x.dr) === 66.67),
    'the receivable holds exactly the card shares');
  assert.strictEqual(lines.filter((x) => x.a === '4900').length, 0,
    'no rounding line absorbs a split');
});

test('a delivered push stamps the device, so the outlet can see who went quiet', opts, async () => {
  // A registered device, and a session signed in ON it.
  const dev = await post('/api/auth/devices', { label: 'Till A', kind: 'till' }, token);
  assert.strictEqual(dev.status, 201, JSON.stringify(dev.body));
  const sess = await post('/api/auth/pin', { outletId, pin: '4718', deviceId: dev.body.id });
  assert.strictEqual(sess.status, 200, JSON.stringify(sess.body));

  const before = await one('SELECT last_push_at FROM chain.device WHERE id = $1', [dev.body.id]);
  assert.strictEqual(before.last_push_at, null, 'nothing delivered yet');

  // Any delivered batch counts — even one carrying a single audit-only op.
  const r = await post('/api/outlet/' + outletId + '/sync/push',
    { ops: [{ opId: uuid(), kind: 'sign_in', label: 'stamp probe' }] }, sess.body.token);
  assert.strictEqual(r.status, 200);

  const after = await one('SELECT last_push_at, last_seen FROM chain.device WHERE id = $1', [dev.body.id]);
  assert.ok(after.last_push_at, 'the delivery is on the record');
  assert.ok(after.last_seen, 'and the device is seen');

  // The devices list and the bootstrap both carry it, because a figure only
  // the database can see is a figure nobody acts on.
  const list = await get('/api/auth/devices', sess.body.token);
  const mine = (list.body.devices || []).filter((d) => d.id === dev.body.id)[0];
  assert.ok(mine && mine.last_push_at, 'the devices screen can read it');
  const b = await get('/api/outlet/' + outletId + '/bootstrap', sess.body.token);
  const bd = (b.body.kpos.DEVICES || []).filter((d) => d.id === dev.body.id)[0];
  assert.ok(bd && bd.pushed, 'the terminal is told');
});

test('database TLS verifies when a CA is pinned, and says so when not', opts, async () => {
  const env = process.env;
  const keep = { PGSSL: env.PGSSL, PGSSL_CA: env.PGSSL_CA,
    PGSSLROOTCERT: env.PGSSLROOTCERT, DATABASE_URL: env.DATABASE_URL };
  try {
    delete env.PGSSL; delete env.PGSSL_CA; delete env.PGSSLROOTCERT; delete env.DATABASE_URL;
    assert.strictEqual(db._sslConfig(), false, 'loopback development needs none');

    env.PGSSL = '1';
    assert.deepStrictEqual(db._sslConfig(), { rejectUnauthorized: false },
      'TLS without a pin is encrypted but unauthenticated — and permitted, warned');

    env.PGSSL_CA = '-----BEGIN CERTIFICATE-----\nnot-really\n-----END CERTIFICATE-----';
    const pinned = db._sslConfig();
    assert.strictEqual(pinned.rejectUnauthorized, true, 'a pinned CA is VERIFIED');
    assert.ok(pinned.ca.includes('BEGIN CERTIFICATE'));
    // The chain is the identity; the hostname comparison is skipped, because
    // an infra self-signed cert does not carry the internal hostname the app
    // dials and the default check failed a connection the pin had already
    // authenticated — which took staging down for exactly one deploy.
    assert.strictEqual(typeof pinned.checkServerIdentity, 'function',
      'hostname comparison is explicitly disarmed');
    assert.strictEqual(pinned.checkServerIdentity('x', {}), undefined);

    // An environment that promises verification cannot quietly degrade when
    // the variable carrying the certificate is lost.
    delete env.PGSSL_CA;
    env.PGSSL = 'verify';
    assert.throws(() => db._sslConfig(), /needs a CA/);
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
  }
});

test('history has a horizon, and the trail does not', opts, async () => {
  const o = db.owner();
  // One stale row in each pruned table, one fresh, and one old AUDIT row that
  // must survive — the trail is kept, not trimmed.
  const staleOp = uuid(), freshOp = uuid();
  await o.query('INSERT INTO outlet_' + outletId + '.op_log'
    + " (op_id, kind, client_at, applied_at) VALUES"
    + " ($1,'sale', now() - interval '200 days', now() - interval '200 days'),"
    + " ($2,'sale', now(), now())", [staleOp, freshOp]);
  await o.query('INSERT INTO outlet_' + outletId + '.guest_request'
    + " (table_no, kind, detail, at) VALUES"
    + " ('T1','water','stale', now() - interval '200 days'),"
    + " ('T1','water','fresh', now())");
  await o.query('INSERT INTO chain.audit (outlet_id, action, entity, at)'
    + " VALUES ($1,'probe_old_audit','retention', now() - interval '200 days')",
  [outletId]);

  const pruned = await o.query('SELECT * FROM chain.prune_history(90, 30)');
  const mine = pruned.rows.filter((r) => r.outlet_id === outletId)[0];
  assert.ok(Number(mine.op_rows) >= 1 && Number(mine.guest_rows) >= 1,
    'the stale rows are gone: ' + JSON.stringify(mine));

  const ops = await o.query('SELECT op_id FROM outlet_' + outletId + '.op_log'
    + ' WHERE op_id = ANY($1)', [[staleOp, freshOp]]);
  assert.deepStrictEqual(ops.rows.map((r) => r.op_id), [freshOp],
    'the fresh replay window survives; the stale one does not');
  const gr = await o.query('SELECT detail FROM outlet_' + outletId
    + ".guest_request WHERE detail IN ('stale','fresh')");
  assert.deepStrictEqual(gr.rows.map((r) => r.detail), ['fresh']);

  const trail = await o.query("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'probe_old_audit'");
  assert.strictEqual(trail.rows[0].n, 1, 'chain.audit is never pruned');
  const logged = await o.query("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'history_pruned' AND outlet_id = $1", [outletId]);
  assert.ok(logged.rows[0].n >= 1, 'and the prune itself is on the trail');

  // A window short enough to eat live replays is a typo, not a policy.
  await assert.rejects(o.query('SELECT chain.prune_history(5, 30)'), /at least 30/);
  // A till cannot shred its own history early: `one()` runs on the OUTLET's
  // login role, which was never granted EXECUTE on the pruner.
  const tillTry = await one('SELECT chain.prune_history(90, 30)')
    .then(() => 'allowed').catch((e) => e.message);
  assert.match(tillTry, /permission denied/, 'no outlet role may execute the pruner');
});

test('the LAN print relay writes the exact bytes, inside its fence', opts, async () => {
  const E = require('../app/kashikeyo-escpos.js');
  const netMod = require('net');
  const docket = E.render({ title: 'KAS-CHA', rows: [['Tea', '5.00']], kick: true });

  // A little printer: everything port 9100 receives, kept for the assert.
  const got = [];
  const printer = netMod.createServer((sock) => sock.on('data', (d) => got.push(...d)));
  await new Promise((res, rej) => { printer.on('error', rej); printer.listen(9100, '127.0.0.1', res); });

  try {
    // Loopback is refused by default — the fence, not a bug — and opened for
    // this test alone, the way a LAN address would be open in production.
    const fenced = await post('/api/outlet/' + outletId + '/print',
      { host: '127.0.0.1', data: E.toBase64(docket) }, token);
    assert.strictEqual(fenced.status, 400, 'loopback is not a printer');

    process.env.PRINT_ALLOW_LOOPBACK = '1';
    const r = await post('/api/outlet/' + outletId + '/print',
      { host: '127.0.0.1', data: E.toBase64(docket) }, token);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.bytes, docket.length);
    await new Promise((res) => setTimeout(res, 150));
    assert.deepStrictEqual(got, docket, 'the printer received the exact bytes composed');

    // The rest of the fence: link-local is every cloud's metadata service,
    // the port is not negotiable because it is not a parameter, and garbage
    // is refused before any socket opens.
    const meta = await post('/api/outlet/' + outletId + '/print',
      { host: '169.254.169.254', data: E.toBase64(docket) }, token);
    assert.strictEqual(meta.status, 400, 'link-local is never a printer');
    const junk = await post('/api/outlet/' + outletId + '/print',
      { host: 'not a host!', data: 'xx' }, token);
    assert.strictEqual(junk.status, 400);
    const dead = await post('/api/outlet/' + outletId + '/print',
      { host: '127.0.0.2', data: E.toBase64(docket) }, token);
    assert.strictEqual(dead.status, 502, 'an unreachable printer is an honest 502');
    assert.match(dead.body.error, /nothing is listening|did not answer/);
  } finally {
    delete process.env.PRINT_ALLOW_LOOPBACK;
    await new Promise((res) => printer.close(res));
  }
});

test('one outlet\'s ops cannot reach another outlet, by token or by side effect', opts, async () => {
  // The URL names outlet 2; the TOKEN was signed for outlet 1. The gate reads
  // the signature, not the URL — an outlet id typed into a path buys nothing.
  const cross = await post('/api/outlet/2/sync/push',
    { ops: [{ opId: uuid(), kind: 'sign_in', label: 'crossing attempt' }] }, token);
  assert.strictEqual(cross.status, 403, JSON.stringify(cross.body));
  assert.match(cross.body.error, /outlet mismatch/);
  const boot2 = await get('/api/outlet/2/bootstrap', token);
  assert.strictEqual(boot2.status, 403, 'nor can it READ another outlet');

  // And an op legitimately pushed to outlet 1 leaves no trace in outlet 2:
  // the handler runs as outlet 1's own database role, whose search_path ends
  // at its own schema — outlet 2's tables are unreachable, not just filtered.
  const opId = uuid();
  const r = await push([{ opId: opId, kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 10, disc: 0, net: 10, svc: 0, tax: 0,
    round: 0, total: 10, tip: 0, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 10, amount: 10 }],
    payments: [{ method: 'cash', amt: 10 }], stockMoves: []
  } }]);
  assert.ok(!r.body.results[0].error, JSON.stringify(r.body.results[0]));
  const saleId = r.body.results[0].result.saleId;

  const o = db.owner();
  const mine = await o.query('SELECT 1 FROM outlet_1.op_log WHERE op_id = $1', [opId]);
  assert.strictEqual(mine.rows.length, 1, 'the op landed at its own outlet');
  const theirsOp = await o.query('SELECT 1 FROM outlet_2.op_log WHERE op_id = $1', [opId]);
  assert.strictEqual(theirsOp.rows.length, 0, 'and nowhere else');
  const theirsSale = await o.query('SELECT 1 FROM outlet_2.sale WHERE id = $1', [saleId]);
  assert.strictEqual(theirsSale.rows.length, 0, 'no sale row crossed either');
});

test('every install has a name, and the bootstrap says it', opts, async () => {
  // Outlet ids repeat across databases — staging's outlet 1 and production's
  // outlet 1 are both "1" — so the install's uuid is what lets a terminal
  // refuse to replay one install's outbox into another. It is minted once by
  // migration 026 and published in every bootstrap.
  const b1 = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const inst = b1.body.kpos.INSTALL;
  assert.match(String(inst), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'a uuid, present: ' + inst);
  const b2 = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.strictEqual(b2.body.kpos.INSTALL, inst, 'stable across calls');
  const row = await asOwner("SELECT value->>'id' AS id FROM chain.setting WHERE key = 'install'");
  assert.strictEqual(row.id, inst, 'and it is the database\'s own name');
});

test('the platform door does not exist until a key is set, then opens to it alone', opts, async () => {
  // The product is sold one install per customer, and the seller's panel
  // reads each install through this one door. Unset, the door is a 404 —
  // indistinguishable from any other unknown path, so an install that was
  // never sold advertises nothing.
  delete process.env.PLATFORM_KEY;
  assert.strictEqual((await get('/api/platform/summary')).status, 404,
    'no key configured — no door');

  // A short key is a weak key, and a weak key is no key.
  process.env.PLATFORM_KEY = 'short';
  assert.strictEqual(
    (await getWith('/api/platform/summary', { authorization: 'Bearer short' })).status,
    404, 'under 32 characters never enables the door');

  const KEY = 'platform-test-key-0123456789abcdef-0123456789';
  process.env.PLATFORM_KEY = KEY;
  assert.strictEqual((await get('/api/platform/summary')).status, 401, 'no bearer — refused');
  assert.strictEqual(
    (await getWith('/api/platform/summary',
      { authorization: 'Bearer ' + KEY.slice(0, -1) + 'X' })).status,
    401, 'a wrong key is refused');

  const r = await getWith('/api/platform/summary', { authorization: 'Bearer ' + KEY });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  /* AGGREGATES ONLY — the whole shape is pinned, so a member list or a staff
     roster cannot ride in later without failing here first.

     `licence` and `planRequest` are the two commercial facts, added
     deliberately: what this customer is on, and whether they have asked to be
     put on a plan. Both are about the CONTRACT rather than about the
     restaurant's trade, which is the line this door has always drawn — neither
     carries a member, a staff record or a line item. */
  assert.deepStrictEqual(Object.keys(r.body).sort(),
    ['at', 'commit', 'company', 'days', 'devices', 'install', 'licence',
      'outlets', 'planRequest']);
  assert.match(String(r.body.install),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'the install names itself: ' + r.body.install);
  assert.strictEqual(r.body.company.name, 'Test Trading Pvt Ltd');
  assert.ok(r.body.outlets.length >= 1, 'the outlets are listed');
  assert.deepStrictEqual(Object.keys(r.body.outlets[0]).sort(),
    ['currency', 'id', 'name', 'slug', 'tz'], 'an outlet row is identity, not trade');
  assert.strictEqual(typeof r.body.devices.writers, 'number');
  assert.strictEqual(typeof r.body.devices.quiet, 'number');
  assert.strictEqual(r.body.days.length, 14, 'fourteen days, oldest first');
  const last = r.body.days[13];
  assert.ok(last.net > 0, 'today carries the suite\'s own settled sales: ' + JSON.stringify(last));

  // The read is on the trail: a platform looking in is never invisible.
  const trail = await asOwner("SELECT count(*)::int AS n FROM chain.audit WHERE action = 'platform_read'");
  assert.ok(trail.n >= 1, 'platform_read audited');

  delete process.env.PLATFORM_KEY;
  assert.strictEqual((await get('/api/platform/summary')).status, 404,
    'clearing the key closes the door again');
});


/* The licence tests below drive the same door, so they set the key themselves
   rather than depending on the order the platform-door test leaves it in. */
const PLATFORM_KEY = 'licence-test-key-0123456789abcdef-0123456789';
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
/* ═══ A LICENCE A CUSTOMER CAN EDIT IS NOT A LICENCE ════════════════════════
   The commercial state of an install used to live only in the seller's
   registry, on a screen the customer cannot see — so a trial ending was an
   event that happened somewhere else, and the first the customer heard of it
   was a phone call.

   Migration 033 puts it where the till can read it, and the whole design turns
   on WHO MAY WRITE IT. It is deliberately not a row in chain.setting, which
   any rank-4 admin can edit: this is the "protection by absence of grant"
   belt, the same shape the account plane uses, and it is asserted here
   directly rather than inferred from the invariant test. */
test('an outlet can read its licence and cannot write one', opts, async () => {
  process.env.PLATFORM_KEY = PLATFORM_KEY;
  // The platform sets it. That door is guarded by PLATFORM_KEY and audited.
  const set = await postWith('/api/platform/licence',
    { kind: 'trial', trialEnds: '2030-01-31', note: 'Set by the seller' },
    { authorization: 'Bearer ' + PLATFORM_KEY });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  assert.strictEqual(set.body.licence.kind, 'trial');
  assert.strictEqual(set.body.licence.trialEnds, '2030-01-31');

  // The outlet reads it — it has to, or the till cannot render the countdown.
  const seen = await one('SELECT kind, trial_ends FROM chain.licence WHERE id = 1');
  assert.strictEqual(seen.kind, 'trial');

  /* And cannot move it. This is the assertion the whole plane exists for: an
     admin who could write here would give themselves a year, and the seller
     would have no way to know. */
  for (const sql of [
    "UPDATE chain.licence SET kind = 'paid' WHERE id = 1",
    "UPDATE chain.licence SET trial_ends = '2099-12-31' WHERE id = 1",
    "INSERT INTO chain.licence (id, kind) VALUES (1, 'paid')",
    'DELETE FROM chain.licence WHERE id = 1'
  ]) {
    await assert.rejects(() => one(sql), (e) => /permission denied/i.test(e.message),
      'an outlet role must not be able to: ' + sql);
  }

  // Unchanged after every attempt.
  const after = await one('SELECT kind, trial_ends FROM chain.licence WHERE id = 1');
  assert.strictEqual(after.kind, 'trial');
  assert.strictEqual(String(after.trial_ends).slice(0, 10), '2030-01-31');
});

test('the platform refuses a licence that contradicts itself', opts, async () => {
  process.env.PLATFORM_KEY = PLATFORM_KEY;
  /* A paid install counting down to a date is a contradiction the customer's
     own screen would have to render, so it is refused by name here rather
     than stored and quietly ignored — which is how a screen ends up showing
     "Paid · 3 days left". */
  const bad = await postWith('/api/platform/licence',
    { kind: 'paid', trialEnds: '2030-01-31' },
    { authorization: 'Bearer ' + PLATFORM_KEY });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /only a trial/i);

  const nokind = await postWith('/api/platform/licence', { kind: 'gold' },
    { authorization: 'Bearer ' + PLATFORM_KEY });
  assert.strictEqual(nokind.status, 400);

  // And the door is the platform's alone.
  const nokey = await post('/api/platform/licence', { kind: 'paid' });
  assert.strictEqual(nokey.status, 401, 'no key, no write');
});

test('a re-push of the same licence writes no new trail', opts, async () => {
  process.env.PLATFORM_KEY = PLATFORM_KEY;
  /* Mission Control reconciles every install on every dashboard load, which is
     what makes the copy self-healing. If each of those wrote a trail row, the
     trail would carry thirty identical entries an hour and the one real change
     would be unfindable in it. */
  const send = () => postWith('/api/platform/licence',
    { kind: 'trial', trialEnds: '2030-06-30', note: 'steady' },
    { authorization: 'Bearer ' + PLATFORM_KEY });

  const first = await send();
  assert.strictEqual(first.body.changed, true, 'the first push moved something');
  const n1 = await asOwner("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'licence_set'");

  const again = await send();
  assert.strictEqual(again.body.changed, false, 'an identical push changes nothing');
  const n2 = await asOwner("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'licence_set'");
  assert.strictEqual(n2.n, n1.n, 'and writes no row');

  // A real change does.
  await postWith('/api/platform/licence', { kind: 'paid' },
    { authorization: 'Bearer ' + PLATFORM_KEY });
  const n3 = await asOwner("SELECT count(*)::int AS n FROM chain.audit"
    + " WHERE action = 'licence_set'");
  assert.strictEqual(n3.n, n1.n + 1, 'a change is on the trail, exactly once');
});

test('the till is told what it is on, and how long is left', opts, async () => {
  process.env.PLATFORM_KEY = PLATFORM_KEY;
  await postWith('/api/platform/licence',
    { kind: 'trial', trialEnds: addDays(today(), 5), note: 'Ends Friday' },
    { authorization: 'Bearer ' + PLATFORM_KEY });

  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  const l = boot.body.kpos.LICENCE;
  assert.ok(l, 'the bootstrap publishes it');
  assert.strictEqual(l.kind, 'trial');
  assert.strictEqual(l.days, 5,
    "counted on the OUTLET's own calendar, not the container's — a trial must"
    + ' not expire at seven in the evening because the box is in UTC');
  assert.strictEqual(l.note, 'Ends Friday');

  /* An install nobody has sold has NO licence, and that is published as null
     rather than as a trial with an invented deadline. A countdown on a demo
     box is exactly the kind of number this build refuses to make up. */
  await asOwner('DELETE FROM chain.licence WHERE id = 1');
  const bare = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.strictEqual(bare.body.kpos.LICENCE, null,
    'no licence is a real answer, and it is silence rather than a guess');
});

test('asking for a plan is an event the platform can read back', opts, async () => {
  process.env.PLATFORM_KEY = PLATFORM_KEY;
  /* The customer's one action. It is audit-only by design: a plan is not
     something an install can grant itself, and the consequence lives in
     Mission Control. What has to survive is WHO asked, WHEN, and FOR WHAT. */
  await push([{ opId: uuid(), kind: 'plan_request', payload: {
    entity: 'install', want: 'yearly', note: 'Two more outlets in March' } }]);

  const sum = await getWith('/api/platform/summary',
    { authorization: 'Bearer ' + PLATFORM_KEY });
  assert.strictEqual(sum.status, 200);
  const pr = sum.body.planRequest;
  assert.ok(pr, 'the summary carries it: ' + JSON.stringify(sum.body.planRequest));
  assert.strictEqual(pr.want, 'yearly');
  assert.strictEqual(pr.note, 'Two more outlets in March');
  assert.ok(pr.at, 'with the moment it was asked');

  // And the till knows it has already asked, so the control does not offer to
  // ask again as though the first one went nowhere.
  await postWith('/api/platform/licence', { kind: 'trial', trialEnds: addDays(today(), 3) },
    { authorization: 'Bearer ' + PLATFORM_KEY });
  const boot = await get('/api/outlet/' + outletId + '/bootstrap', token);
  assert.ok(boot.body.kpos.LICENCE.asked, 'published as asked');
});

test('a stranger cannot walk phone numbers and harvest the customer roster',
  opts, async () => {
    /* GET /g/<slug>/member?phone= answered with a customer's name, points and
       join date behind only a table token — and a table token is mintable by
       anyone who can read a QR sticker on a table. Every other door in the
       guest file refuses to say whether an address is a customer; this one
       said it, with their name attached. It is gone, not throttled. */
    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const slug = b.body.kpos.OUTLETS[0].slug;
    const t = await get('/api/g/' + slug + '/token');
    const table = { 'x-table-token': t.body.token };
    assert.strictEqual(t.status, 200, 'the table token is freely mintable — that is the threat');

    const known = await getWith('/api/g/' + slug + '/member?phone=9998877', table);
    // The route is gone, so the path falls past the guest router into the
    // session gate. What matters is that it never answers WITH A CUSTOMER.
    assert.notStrictEqual(known.status, 200, 'the door does not open: ' + JSON.stringify(known.body));
    assert.ok(!/Aishath|points|joined/i.test(JSON.stringify(known.body || {})),
      'and it names nobody: ' + JSON.stringify(known.body));

    // The honest way to ask "am I a member here" is still open, and it still
    // answers the same for a stranger as for a customer. Asserted with the dev
    // echo OFF, because that is production: MEMBER_CODE_ECHO returns the code
    // in the body and is exactly the thing that would tell the two apart.
    const echo = process.env.MEMBER_CODE_ECHO;
    delete process.env.MEMBER_CODE_ECHO;
    try {
      const mine = await postWith('/api/g/' + slug + '/member/start', { phone: '9998877' }, table);
      const nobody = await postWith('/api/g/' + slug + '/member/start', { phone: '9000001' }, table);
      assert.strictEqual(mine.status, nobody.status, 'known and unknown answer alike');
      assert.deepStrictEqual(mine.body, nobody.body, 'byte for byte');
    } finally {
      if (echo !== undefined) process.env.MEMBER_CODE_ECHO = echo;
    }
  });

/* ═══ A VOID HAS TO UNDO SOMETHING ═══════════════════════════════════════════
   sale.voided_at existed from the first migration and five readers trusted it;
   nothing ever wrote it, so voiding a settled sale was a line in the trail and
   nothing else — revenue recognised, stock consumed, points granted, credit
   owed. The reversal is now derived from the server's own records: the sale's
   journal legs swapped, its stock_move rows negated, what it recorded spending
   and granting handed back. ═══════════════════════════════════════════════ */
test('voiding a settled sale reverses its money, stock, points and credit',
  opts, async () => {
    const phone = '9994422';
    const made = await push([{ opId: uuid(), kind: 'member_upsert', payload: {
      name: 'Void Customer', phone: phone, credit: 500 } }]);
    const mid = made.body.results[0].result.memberId;
    const member = () => one('SELECT points, credit_used FROM chain.member WHERE id = $1', [mid]);
    const before = await member();

    const sold = await push([{ opId: uuid(), kind: 'sale', payload: {
      bizDate: today(), covers: 2, sub: 200, disc: 0, net: 200, svc: 0,
      tax: 0, round: 0, total: 200, taxCode: 'NONE', taxLabel: '', taxRate: 0,
      member: mid, customer: 'Void Customer',
      sold: [{ id: 'm3', name: 'Bottled water', qty: 2, price: 100, amount: 200 }],
      payments: [{ method: 'credit', amt: 200 }], stockMoves: []
    } }]);
    const saleId = sold.body.results[0].result.saleId;
    const afterSale = await member();
    assert.ok(Number(afterSale.points) > Number(before.points), 'the visit granted points');
    assert.strictEqual(Number(afterSale.credit_used) - Number(before.credit_used), 200,
      'and put 200 on the house account');

    const bal = () => one("SELECT coalesce(sum(l.dr) - sum(l.cr), 0)::numeric AS v"
      + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
      + " WHERE l.account_code = '4000'").then((r) => Number(r.v));
    const revenueBefore = await bal();

    // The void, through the same outbox as everything else.
    const v = await push([{ opId: uuid(), kind: 'void_sale', payload: {
      saleId: saleId, reason: 'Wrong table charged', bizDate: today() } }]);
    assert.ok(!v.body.results[0].error, JSON.stringify(v.body.results[0]));

    const row = await one('SELECT voided_at, voided_by FROM sale WHERE id = $1', [saleId]);
    assert.ok(row.voided_at, 'the sale is marked void, not deleted');
    assert.ok(row.voided_by, 'by somebody');

    // Revenue came back out: the reversal is the sale's own legs, swapped.
    // dr − cr on 4000: the sale credited revenue, the void debits it back out.
    assert.strictEqual(await bal(), revenueBefore + 200,
      'revenue is reversed exactly, not approximately');

    const back = await member();
    assert.strictEqual(Number(back.points), Number(before.points),
      'the points the visit granted are taken back');
    assert.strictEqual(Number(back.credit_used), Number(before.credit_used),
      'and the customer no longer owes for a sale that did not happen');

    // A replayed void is a no-op — this arrives through the outbox like
    // everything else, and the second pass must not reverse twice.
    const again = await push([{ opId: uuid(), kind: 'void_sale', payload: {
      saleId: saleId, reason: 'Wrong table charged' } }]);
    assert.strictEqual(again.body.results[0].result.skipped, 'already void');
    assert.strictEqual(await bal(), revenueBefore + 200, 'and the ledger did not move again');
    const twice = await member();
    assert.strictEqual(Number(twice.points), Number(before.points), 'nor the points');

    /* A void with no reason is refused: an unexplained reversal is unauditable.
       Asked of a LIVE sale — an already-void one short-circuits as a no-op
       first, which is what makes a replay safe. */
    const other = await push([{ opId: uuid(), kind: 'sale', payload: {
      bizDate: today(), covers: 1, sub: 50, disc: 0, net: 50, svc: 0,
      tax: 0, round: 0, total: 50, taxCode: 'NONE', taxLabel: '', taxRate: 0,
      sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 50, amount: 50 }],
      payments: [{ method: 'cash', amt: 50, tendered: 50 }], stockMoves: []
    } }]);
    const bare = await push([{ opId: uuid(), kind: 'void_sale',
      payload: { saleId: other.body.results[0].result.saleId } }]);
    assert.ok(bare.body.results[0].error, 'a void needs a written reason');
    const still = await one('SELECT voided_at FROM sale WHERE id = $1',
      [other.body.results[0].result.saleId]);
    assert.strictEqual(still.voided_at, null, 'and the refused void changed nothing');
  });

test('a refund marked "untouched — return to stock" actually returns it', opts, async () => {
  /* The refund form asks the one question that matters for the shelf, and the
     answer used to go nowhere: "untouched" queued a stock_return op carrying no
     payload, which resolved to an adjustment of nothing. The operator said the
     food came back, the screen agreed, and the count never moved. */
  const ing = await one('SELECT id, on_hand, avg_cost FROM ingredient'
    + ' WHERE on_hand > 5 ORDER BY name LIMIT 1');
  assert.ok(ing, 'the fixture has stock to move');
  const cost = Number(ing.avg_cost) || 1;

  const sold = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'NONE', taxLabel: '', taxRate: 0,
    cogs: round(2 * cost),
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }],
    stockMoves: [{ ing: ing.id, qty: 2, cost: cost, value: round(2 * cost) }]
  } }]);
  const saleId = sold.body.results[0].result.saleId;
  const afterSale = await one('SELECT on_hand FROM ingredient WHERE id = $1', [ing.id]);
  assert.strictEqual(Number(afterSale.on_hand), Number(ing.on_hand) - 2,
    'the sale took two off the shelf');

  await push([{ opId: uuid(), kind: 'refund', payload: {
    saleId: saleId, bizDate: today(), net: 100, tax: 0, svc: 0, amt: 100,
    method: 'cash', reason: 'Sent back to the kitchen', restock: true
  } }]);
  const back = await one('SELECT on_hand FROM ingredient WHERE id = $1', [ing.id]);
  assert.strictEqual(Number(back.on_hand), Number(ing.on_hand),
    'and the refund put both back — from the sale\'s own ledger rows');

  // "Consumed or discarded" must NOT return it: that answer is also real.
  const sold2 = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'NONE', taxLabel: '', taxRate: 0,
    cogs: round(cost),
    sold: [{ id: 'm3', name: 'Bottled water', qty: 1, price: 100, amount: 100 }],
    payments: [{ method: 'cash', amt: 100, tendered: 100 }],
    stockMoves: [{ ing: ing.id, qty: 1, cost: cost, value: round(cost) }]
  } }]);
  const eaten = await one('SELECT on_hand FROM ingredient WHERE id = $1', [ing.id]);
  await push([{ opId: uuid(), kind: 'refund', payload: {
    saleId: sold2.body.results[0].result.saleId, bizDate: today(),
    net: 100, tax: 0, svc: 0, amt: 100, method: 'cash', reason: 'Guest ate it'
  } }]);
  const stillGone = await one('SELECT on_hand FROM ingredient WHERE id = $1', [ing.id]);
  assert.strictEqual(Number(stillGone.on_hand), Number(eaten.on_hand),
    'food that was eaten does not come back just because the money did');
});

test('an exhausted pool answers fast and retryably, instead of hanging', opts, async () => {
  /* statement_timeout bounds a running query; nothing bounded the WAIT for a
     free connection. Past the pool's size the next checkout waited for ever
     while the till's five-second retry piled on more waiters — the first thing
     to fail under a burst, failing by hanging, which a busy counter cannot see.

     Tested against a REAL pool, not a stub: the value of this test is proving
     that pg's actual timeout wording is the wording the mapping matches. */
  const { Pool } = require('pg');
  const tiny = new Pool(Object.assign({
    host: process.env.PGHOST, port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGTESTDB || 'kashikeyo_test',
    user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || ''
  }, { max: 1, connectionTimeoutMillis: 300 }));
  const held = await tiny.connect();          // the only connection there is
  try {
    const began = Date.now();
    await assert.rejects(() => db._checkout(tiny), (e) => {
      assert.strictEqual(e.status, 503, 'a busy outlet is not a broken one');
      assert.strictEqual(e.retryable, true, 'and the caller is told it may go again');
      assert.doesNotMatch(e.message, /timeout exceeded|pool|connect/i,
        'in words an operator can act on: ' + e.message);
      return true;
    });
    assert.ok(Date.now() - began < 3000, 'and it answers fast, rather than hanging');
  } finally {
    held.release();
    await tiny.end();
  }
});

test('a killed idle connection is a log line, not an outage', opts, async () => {
  // A pool EMITS 'error' when an idle connection dies under it, and an
  // 'error' event nobody listens to kills the process — so a Postgres
  // restart used to take every till in every outlet down with it. Kill the
  // pools' idle connections and the suite itself is the proof: without the
  // guard in src/db.js this test does not fail, it exits.
  const o = db.owner();
  await o.query('SELECT 1');
  await o.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
    + " WHERE application_name LIKE 'kashikeyo-%' AND pid <> pg_backend_pid()");
  await new Promise((r) => setTimeout(r, 200));
  const q = await o.query('SELECT 1 AS ok');
  assert.strictEqual(q.rows[0].ok, 1, 'the next query gets a fresh connection');
});

/* READY MEANS AN OUTLET REQUEST CAN BE SERVED.

   /readyz asked the OWNER connection whether chain.outlet had a row, and the
   owner connection bypasses both isolation belts — so it could not detect the
   one failure that takes an install off the air. Found by running the restore
   drill: a pg_dump of one database carries no roles, so a restore into a fresh
   cluster leaves every outlet_<n>_app missing; the app booted, /readyz
   answered 200, and every outlet request failed with `role does not exist`.

   Reproduced here by taking the grant away rather than the role, which is the
   same wall from the request's side and is reversible inside one test. */
test('readiness fails when an outlet cannot be reached with its own role', opts, async () => {
  const role = 'outlet_' + outletId + '_app';
  const schema = 'outlet_' + outletId;

  /* The healthy answer is cached for ten seconds, which is right in
     production and would make this test pass by staleness. Turn it off for
     the duration; `READY_TTL_MS` is read per probe for exactly this. */
  const ttlWas = process.env.READY_TTL_MS;
  process.env.READY_TTL_MS = '0';

  const good = await get('/readyz');
  assert.strictEqual(good.status, 200, 'a healthy install is ready');
  assert.ok(good.body.outlets >= 1, 'and it says how many outlets it checked');

  await db.owner().query('REVOKE USAGE ON SCHEMA ' + schema + ' FROM ' + role);
  try {
    // A failing answer is never cached, so this needs no wait.
    const bad = await get('/readyz');
    assert.strictEqual(bad.status, 503, 'an unreachable outlet takes the instance out of rotation');
    assert.strictEqual(bad.body.ok, false);
    assert.ok(Array.isArray(bad.body.unreachable) && bad.body.unreachable.length >= 1,
      'and it NAMES the outlet rather than saying "not ready"');
    assert.strictEqual(bad.body.unreachable[0].outlet, outletId);
    assert.match(bad.body.remedy, /provision:outlet -- --all/,
      'with the command that fixes it — a 503 nobody can act on is the old 200');
  } finally {
    await db.owner().query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
  }

  // Recovery is immediate: no cache to wait out once the remedy is run.
  const back = await get('/readyz');
  assert.strictEqual(back.status, 200, 'and it goes green again without a restart');

  if (ttlWas === undefined) delete process.env.READY_TTL_MS;
  else process.env.READY_TTL_MS = ttlWas;
});

/* CROSS-PLANE TOKEN USE, behaviourally. The static pin is in wiring; this is
   the proof that the doors actually refuse. */
test('a token from one plane is refused by every other', opts, async () => {
  const S = require('../src/secrets');

  // Each plane mints its own, and each verifies only its own.
  const staff = S.sign({ o: outletId, r: 5, s: null, exp: Date.now() + 60e3 });
  const table = S.signTable({ o: outletId, tb: '1', sl: 'x', exp: Date.now() + 60e3 });
  const member = S.signMember({ m: uuid(), o: outletId, sl: 'x', exp: Date.now() + 60e3 });
  const account = S.signAccount({ a: uuid(), exp: Date.now() + 60e3 });

  assert.ok(S.verify(staff), 'a staff token verifies as staff');
  assert.ok(S.verifyTable(table), 'a table token verifies as a table token');
  assert.ok(S.verifyMember(member), 'a member token verifies as a member token');
  assert.ok(S.verifyAccount(account), 'an account token verifies as an account token');

  // Every crossing, including the two that were live.
  assert.strictEqual(S.verify(table), null, 'a table token is not a staff session');
  assert.strictEqual(S.verify(member), null, 'nor is a member token');
  assert.strictEqual(S.verify(account), null, 'nor is an account token');
  assert.strictEqual(S.verifyTable(member), null,
    'a member token is not a table token — it ordered onto any table before this');
  assert.strictEqual(S.verifyTable(staff), null, 'nor is a staff token');
  assert.strictEqual(S.verifyMember(table), null, 'a table token reads no member card');
  assert.strictEqual(S.verifyAccount(staff), null, 'a staff session is not an account');

  /* And the guest plane's key is its own even when PORTAL_SECRET is unset,
     which is the configuration the whole exposure needed. */
  const had = process.env.PORTAL_SECRET;
  delete process.env.PORTAL_SECRET;
  const derived = S.signTable({ o: outletId, tb: '1', sl: 'x', exp: Date.now() + 60e3 });
  assert.ok(S.verifyTable(derived), 'a derived-key table token still works');
  assert.strictEqual(S.verify(derived), null,
    'and it is refused as a staff session — it read the whole bootstrap before this');
  if (had === undefined) delete process.env.PORTAL_SECRET;
  else process.env.PORTAL_SECRET = had;
});

/* THE PRINT RELAY'S FENCE, dialled rather than read. It began as a deny-list
   and let through both 0.0.0.0 — which on Linux reaches loopback, proved by
   delivering bytes to a listener on 127.0.0.1:9100 — and every public address
   on the internet. A printer is never on a public address, so the question is
   turned round: inside a private range, or refused. */
test('the print relay dials the shop LAN and nothing else', opts, async () => {
  const refused = ['0.0.0.0', '0', '0000', '00.0.0.0', '127.0.0.1', '169.254.169.254',
    '8.8.8.8', '172.32.0.1', '::1'];
  for (const host of refused) {
    const r = await post('/api/outlet/' + outletId + '/print',
      { host: host, data: Buffer.from('x').toString('base64') }, token);
    assert.strictEqual(r.status, 400, host + ' must be refused');
    assert.match(r.body.error, /not a printer/, host + ' is named as not a printer');
  }
  /* And a LAN address is dialled — it will not answer in this environment, and
     that is the point: the refusal is different from the timeout, so the fence
     is measurably not just refusing everything. */
  const lan = await post('/api/outlet/' + outletId + '/print',
    { host: '192.168.199.199', data: Buffer.from('x').toString('base64') }, token);
  assert.ok(!/not a printer/.test(lan.body.error || ''),
    'a LAN address gets past the fence and fails on the wire instead');
});

/* A PIN HASH NEVER LEAVES THE DATABASE — asked as the outlet role itself,
   which is the only question that matters. Closing the function while the
   column stayed readable would have been theatre. */
test('the outlet role cannot read a PIN hash', opts, async () => {
  const asOutlet = (sql) => db.withOutletRead({ outletId, rank: 5, actor: null, scope: 'outlet' },
    (c) => c.query(sql));

  await assert.rejects(() => asOutlet('SELECT pin_hash FROM chain.staff LIMIT 1'),
    /permission denied/, 'the column is not readable');
  await assert.rejects(() => asOutlet('SELECT * FROM chain.staff LIMIT 1'),
    /permission denied/, 'nor by the lazy way in');
  await assert.rejects(() => asOutlet('SELECT * FROM chain.pin_candidates(1)'),
    /does not exist/, 'and the function that handed them out is gone');

  // What it can still read is everything a screen needs.
  const ok = await asOutlet('SELECT name, rank, active FROM chain.staff LIMIT 1');
  assert.ok(ok.rows.length >= 1, 'names, ranks and active still read');

  // And sign-in still works, which is the whole point of moving the comparison.
  const good = await post('/api/auth/pin', { outletId: outletId, pin: '4718' });
  assert.strictEqual(good.status, 200, 'the right PIN still signs in');
  const bad = await post('/api/auth/pin', { outletId: outletId, pin: '0000' });
  assert.strictEqual(bad.status, 401, 'and the wrong one still does not');
});

test('shut down cleanly', opts, async () => {
  if (server) await new Promise((res) => server.close(res));
  if (db) await db.shutdown();
});

/* ── plumbing ───────────────────────────────────────────────────────────── */
function uuid() { return require('crypto').randomUUID(); }
function round(n) { return Math.round(n * 100) / 100; }

/* The business date belongs to the OUTLET, and the fixture outlet is in Malé.
   This was `toISOString()` — the container's UTC date — twice, in two copies of
   the same function. Every caller uses it as a business date, which the server
   files on the outlet's own calendar, so from 19:00 UTC the fixture and the
   server were a day apart. It only ever SHOWED on the trial countdown, which
   does arithmetic across the boundary: that test failed for the five hours
   before midnight UTC, every day, with an assertion message about exactly this.
   A suite that is red every evening is a suite people stop reading. */
const FIXTURE_TZ = 'Indian/Maldives';
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: FIXTURE_TZ });
}

/* `fetch` refuses to set a Host header, and Host is the whole question here. */
function callHost(host, method, path) {
  const http = require('http');
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method,
      path: u.pathname + u.search, headers: { host: host } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function call(method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    // A redirect is the ANSWER for the OAuth callback, not a step on the way
    // to one — following it would test the page it lands on instead.
    redirect: 'manual',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
  return { status: res.status, body: parsed,
    headers: { location: res.headers.get('location'),
      'retry-after': res.headers.get('retry-after') } };
}
const auth = (t) => (t ? { authorization: 'Bearer ' + t } : {});
const get = (p, t) => call('GET', p, undefined, auth(t));
const getWith = (p, h) => call('GET', p, undefined, h);
const post = (p, b, t) => call('POST', p, b, auth(t));
const postWith = (p, b, h) => call('POST', p, b, h);
const patch = (p, b, t) => call('PATCH', p, b, auth(t));
const push = (ops) => post('/api/outlet/' + outletId + '/sync/push', { ops }, token);

/* The code the outlet issued, read off the floor board — which is where a
   server reads it out to the guest. The response never carries it (that is
   MEMBER_CODE_ECHO, and it is development only, because it turns a phone
   number into a login), so a test must look where a person would. */
function boardCode(match) {
  // ORDER BY `at`, not `id`: the id is a uuid, so ordering on it returns an
  // arbitrary row and a test that passes by luck.
  return one("SELECT detail FROM guest_request WHERE kind = 'member_code'"
    + ' AND detail LIKE $1 ORDER BY at DESC LIMIT 1', ['%' + match + '%'])
    .then((r) => (/(\d{4})\s*$/.exec((r || {}).detail || '') || [])[1] || '');
}

/* Through the OWNER connection, because an outlet's login role has INSERT on
   chain.audit and nothing else — a till that could read its own trail could
   edit its own story. This is the connection a support engineer uses. */
function asOwner(sql, params) {
  return db.owner().query(sql, params || []).then((q) => q.rows[0]);
}

// Every row, where a test needs more than the first.
function all2(sql, params) {
  return db.withOutlet({ outletId, rank: 5, actor: null },
    (c) => c.query(sql, params || []).then((q) => q.rows));
}

function one(sql, params) {
  return db.withOutlet({ outletId, rank: 5, actor: null },
    (c) => c.query(sql, params || []).then((q) => q.rows[0]));
}
