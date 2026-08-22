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
  assert.strictEqual(k.ACCOUNTS.length, 35, 'the chart is complete');
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
  await one("INSERT INTO chain.member (phone, name, email, points, tier)"
    + " VALUES ('7770001','Member One','one@example.mv',100,'Bronze'),"
    + " ('7770002','Member Two','two@example.mv',900,'Gold')"
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
      name: 'Aishath Waheed', phone: phone, tier: 'Gold', credit: 500
    } }]);
    assert.strictEqual(again.body.results[0].result.created, false, 'the second is an update');
    const n = await one('SELECT count(*)::int AS n FROM chain.member WHERE phone = $1', [phone]);
    assert.strictEqual(n.n, 1, 'one customer, however many times the till sent them');
    const up = await one('SELECT tier FROM chain.member WHERE phone = $1', [phone]);
    assert.strictEqual(up.tier, 'Gold', 'and the update landed');

    // The invite. No SMS in this build, so it is what a person hands across a
    // counter: where the card is, and a code to get in with.
    const inv = await post('/api/outlet/' + outletId + '/member/' + res.memberId
      + '/invite', {}, token);
    assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
    assert.match(String(inv.body.code), /^\d{4}$/, 'four digits');
    assert.strictEqual(inv.body.via, 'counter', 'and it says how it travels');
    // The address the SERVER spelled — absolute on a store's own subdomain,
    // /m/<handle> where there is no base domain. Never the QR portal's path
    // with /member glued on, which routes nowhere.
    assert.match(String(inv.body.url), /(^\/m\/[a-z0-9-]+$)|(^https:\/\/[a-z0-9-]+\..+\/member$)/,
      'the address the SERVER spelled: ' + inv.body.url);

    // That code signs them in on their own card, through the guest portal.
    const b = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const slug = b.body.kpos.OUTLETS[0].slug;
    const t = await get('/api/g/' + slug + '/token');
    const table = { 'x-table-token': t.body.token };
    const ok = await postWith('/api/g/' + slug + '/member/verify',
      { id: phone, code: inv.body.code }, table);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token, 'a member token is minted from a code read out at the till');

    // Spent on use, exactly like the one they request themselves.
    const replay = await postWith('/api/g/' + slug + '/member/verify',
      { id: phone, code: inv.body.code }, table);
    assert.strictEqual(replay.status, 401, 'the code is spent');

    // And the till now reports something it actually knows: they have been in.
    const b2 = await get('/api/outlet/' + outletId + '/bootstrap', token);
    const me = (b2.body.kpos.CUSTOMERS || []).find((c) => c.phone === phone);
    assert.ok(me, 'the customer is on the terminal');
    assert.match(String(me.seen), /^\d{4}-\d{2}-\d{2}$/,
      'signed in on a real date — not an invented "Registered" flag');
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
    headers: { location: res.headers.get('location') } };
}
const auth = (t) => (t ? { authorization: 'Bearer ' + t } : {});
const get = (p, t) => call('GET', p, undefined, auth(t));
const getWith = (p, h) => call('GET', p, undefined, h);
const post = (p, b, t) => call('POST', p, b, auth(t));
const postWith = (p, b, h) => call('POST', p, b, h);
const patch = (p, b, t) => call('PATCH', p, b, auth(t));
const push = (ops) => post('/api/outlet/' + outletId + '/sync/push', { ops }, token);

function one(sql, params) {
  return db.withOutlet({ outletId, rank: 5, actor: null },
    (c) => c.query(sql, params || []).then((q) => q.rows[0]));
}
