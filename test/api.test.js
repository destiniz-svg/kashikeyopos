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
  let r = await post('/api/onboarding/company', {
    legalName: 'Test Trading Pvt Ltd', regNo: 'C-0001/2026',
    tin: 'T1000001GST501', address: 'Test address, Malé'
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  // The legal entity is required IN FULL: a receipt without a TIN is not a
  // receipt a tax authority accepts, and a blank is better than a placeholder.
  const partial = await post('/api/onboarding/company', { legalName: 'X' });
  assert.strictEqual(partial.status, 400, 'an incomplete company is refused');
  assert.match(partial.body.error, /TIN/, partial.body.error);

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

test('isolation holds — the leak test runs in the pipeline', opts, async () => {
  const { run } = require('../src/scripts/leak-test');
  const out = await run(() => {});
  assert.strictEqual(out.leaks, 0,
    out.results.filter((r) => r.leaked).map((r) => r.name).join(', '));
  assert.ok(out.results.length >= 12, 'every crossing attempt was made');
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

async function call(method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
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
