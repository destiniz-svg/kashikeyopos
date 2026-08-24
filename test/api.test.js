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
  await DB.dropOutletRoles();
  // Required AFTER the environment is set: db.js reads it at module load.
  db = require('../src/db');
  const { migrate } = require('../src/scripts/migrate');
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
    { id: 'm2', name: 'Garlic Rice', cat: 'sides', price: 45, station: 'main', recipe: [['ing_rice', 120, 2], ['ing_oil', 10, 0]] }
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

test('the PIN pad locks rather than being probed', opts, async () => {
  for (let i = 0; i < 6; i++) {
    const r = await post('/api/auth/pin', { outletId, pin: '0000' });
    assert.strictEqual(r.status, 401, 'a wrong PIN is refused');
  }
  const locked = await post('/api/auth/pin', { outletId, pin: '4718' });
  assert.strictEqual(locked.status, 401, 'the right PIN is refused while the door is locked');
  assert.match(locked.body.error, /locked/i, 'and it says so: ' + locked.body.error);

  // Unlock through the admin path so the rest of the suite can carry on.
  const staff = await get('/api/auth/staff', token);
  for (const s of staff.body.staff) {
    await patch('/api/auth/staff/' + s.id, { unlock: true }, token);
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
  const cogs = round(2 * (200 * 0.18 + 15 * 0.028) + 2 * (120 * 0.032 + 10 * 0.028));

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
        { ing: 'ing_fish', qty: 400, cost: 0.18, value: 72 },
        { ing: 'ing_oil', qty: 50, cost: 0.028, value: 1.4 },
        { ing: 'ing_rice', qty: 240, cost: 0.032, value: 7.68 }
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
  assert.strictEqual(Number(fish.on_hand), 10000 - 400, 'the ingredient moved once, not four times');

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
  assert.strictEqual(k.MENU.length, 2, 'the menu came with it');
  assert.strictEqual(k.MENU[0].recipe.length, 2, 'and its recipe');
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
      sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 200, amount: 200 }],
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
      sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 150, amount: 150 }],
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
    sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 500, amount: 500 }],
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
        sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 300, amount: 300 }],
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

test('a sale with no member accrues nothing', opts, async () => {
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 1, sub: 100, disc: 0, net: 100, svc: 0,
    tax: 0, round: 0, total: 100, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 100, amount: 100 }],
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

test('a tip is held for the team, not booked as rounding', opts, async () => {
  // The guest hands over 100 for a 90 bill: the payment carries the whole
  // note, the bill total stays 90, and the 10 is a liability from the moment
  // it lands. It used to overshoot the journal by exactly itself and be
  // absorbed into 4900 — revenue nobody could ever pay out to the staff.
  const r = await push([{ opId: uuid(), kind: 'sale', payload: {
    bizDate: today(), covers: 2, sub: 90, disc: 0, net: 90, svc: 0,
    tax: 0, round: 0, total: 100, tip: 10, taxCode: 'GGST', taxLabel: 'GST', taxRate: 0,
    sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 90, amount: 90 }],
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

  /* Link one the way onboarding does — on the OWNER connection, because an
     outlet's own role is granted nothing on the account plane. That the line
     below has to use owner() is itself the isolation working. */
  await db.owner().query(
    "INSERT INTO chain.account_outlet (account_id, outlet_id, role)"
    + " SELECT id, $1, 'owner' FROM chain.account WHERE email = 'founder@example.mv'"
    + ' ON CONFLICT DO NOTHING', [outletId]);
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
    const why = await db.owner().query('SELECT chain.handle_why($1) AS w', [h]);
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
  const left = (await db.owner().query(
    'SELECT handle FROM chain.outlet_handle_history WHERE outlet_id = $1'
    + ' ORDER BY retired_at DESC LIMIT 1', [outletId])).rows[0].handle;

  // To another outlet it is taken — a guest scanning the card in front of them
  // must never land on a competitor's menu.
  const other = outletId + 1;
  const why = await db.owner().query('SELECT chain.handle_why($1,$2) AS w', [left, other]);
  assert.ok(why.rows[0].w, left + ' must not be free to outlet ' + other);
  assert.match(why.rows[0].w, /still points at it/, why.rows[0].w);

  // To the outlet that left it, it is its own name to take back.
  const mine = await db.owner().query('SELECT chain.handle_why($1,$2) AS w', [left, outletId]);
  assert.strictEqual(mine.rows[0].w, null);

  const back = await patch('/api/outlet/' + outletId + '/handle', { handle: left }, token);
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  assert.strictEqual(back.body.handle, left);

  // And it stops being history — an outlet at an address does not redirect to
  // itself.
  const still = await db.owner().query(
    'SELECT 1 FROM chain.outlet_handle_history WHERE handle = $1', [left]);
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
    const before = await db.owner().query(
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

    const linked = await db.owner().query(
      "SELECT 1 FROM chain.account_identity WHERE subject = 'g-stranger'");
    assert.strictEqual(linked.rows.length, 0, 'no identity was attached to their account');

    // 2 · The same address, VERIFIED, is the person coming back — it joins.
    restore = fakeProvider({ sub: 'g-owner', email: mine, email_verified: true, nonce: 'n2' });
    r = await call('GET', '/api/account/oauth/google/callback?code=c&state='
      + encodeURIComponent(sign('n2')), undefined, {});
    restore();
    const back = String((r.headers && r.headers.location) || '');
    assert.ok(/#token=/.test(back), 'signed in: ' + back);

    const joined = await db.owner().query(
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
    sold: [{ id: 'm1', name: 'Test dish', qty: 2, price: 50, amount: 100 }],
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
    sold: [{ id: 'm1', name: 'Test dish', qty: 1, price: 10, amount: 10 }],
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

  // AGGREGATES ONLY — the whole shape is pinned, so a member list or a staff
  // roster cannot ride in later without failing here first.
  assert.deepStrictEqual(Object.keys(r.body).sort(),
    ['at', 'commit', 'company', 'days', 'devices', 'install', 'outlets']);
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

test('shut down cleanly', opts, async () => {
  if (server) await new Promise((res) => server.close(res));
  if (db) await db.shutdown();
});

/* ── plumbing ───────────────────────────────────────────────────────────── */
function uuid() { return require('crypto').randomUUID(); }
function today() { return new Date().toISOString().slice(0, 10); }
function round(n) { return Math.round(n * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }

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

function one(sql, params) {
  return db.withOutlet({ outletId, rank: 5, actor: null },
    (c) => c.query(sql, params || []).then((q) => q.rows[0]));
}
