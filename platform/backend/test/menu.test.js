'use strict';
/* Menu Master — 02-POS-SPEC.md §2 (`menu`).
 *
 * The two properties worth most of this file are the ones that go wrong
 * quietly: a dish must never be deleted out from under the sales that
 * reference it, and repricing a dish must never restate what a guest already
 * paid. Both are the kind of thing that looks fine in the UI on the day and is
 * discovered a month later by an accountant.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('Menu Master', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Manager', 3);
    await H.asOwner(ctx, 'INSERT INTO chain.station (outlet_id, name, target_mins, sort)'
      + " VALUES ($1,'Grill',14,0)", [ctx.outletId]);
  });
  after(() => H.teardown(ctx));

  const url = (p = '') => `/api/outlet/${ctx.outletId}/menu${p}`;
  const asMgr = (method, p, body) => H.req(method, url(p), { body, token: mgr.token });

  test('a cashier cannot edit the menu', async () => {
    // §1.5: rank is the gate. A till may sell a dish and not reprice it.
    const r = await H.req('GET', url(), { token: ctx.token });
    assert.equal(r.status, 403);
    const w = await H.req('POST', url(), { body: { id: 'X', name: 'X', price: 1 }, token: ctx.token });
    assert.equal(w.status, 403);
  });

  test('a manager creates a dish', async () => {
    const r = await asMgr('POST', '', {
      id: 'reef-curry', name: 'Reef fish curry', category: 'Mains',
      price: 95, station: 'Grill',
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.id, 'REEF-CURRY', 'codes are normalised to upper case');

    const row = await H.q(ctx, 'SELECT * FROM item WHERE id = $1', ['REEF-CURRY']);
    assert.equal(row.rows[0].name, 'Reef fish curry');
    assert.equal(Number(row.rows[0].price), 95);
    assert.equal(row.rows[0].station, 'Grill');
    assert.equal(row.rows[0].active, true);
  });

  test('it appears on the till at once', async () => {
    const snap = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });
    const found = snap.json.items.find((i) => i.id === 'REEF-CURRY');
    assert.ok(found, 'the dish reached the selling screen');
    assert.equal(found.station, 'Grill');
  });

  test('and on the guest menu — one price, two surfaces (§2)', async () => {
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '1' });
    const snap = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: g.json.token });
    const found = snap.json.items.find((i) => i.id === 'REEF-CURRY');
    assert.ok(found);
    assert.equal(Number(found.price), 95, 'the guest sees the same price the till charges');
  });

  test('a duplicate code is refused, not silently overwritten', async () => {
    /* Overwriting would rewrite the name on every historical sale line that
       points at the code. */
    const r = await asMgr('POST', '', { id: 'REEF-CURRY', name: 'Something else', price: 10 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already exists/i);
  });

  test('a bad code is refused', async () => {
    for (const id of ['', 'has space', 'x'.repeat(41), 'café']) {
      const r = await asMgr('POST', '', { id, name: 'X', price: 1 });
      assert.equal(r.status, 400, 'rejected: ' + JSON.stringify(id));
    }
  });

  test('a negative price is refused', async () => {
    const r = await asMgr('POST', '', { id: 'NEG', name: 'Negative', price: -5 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /negative/i);
  });

  test('a station this outlet does not run is refused', async () => {
    // A typo would route the dish to the pass forever with nobody able to see why.
    const r = await asMgr('POST', '', { id: 'TYPO', name: 'X', price: 10, station: 'Gril' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /no station called/i);
  });

  test('a partial edit changes only what it names', async () => {
    const r = await asMgr('PATCH', '/REEF-CURRY', { price: 105 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const row = await H.q(ctx, 'SELECT name, category, price, station FROM item WHERE id = $1', ['REEF-CURRY']);
    assert.equal(Number(row.rows[0].price), 105);
    assert.equal(row.rows[0].category, 'Mains', 'the category it never sent survived');
    assert.equal(row.rows[0].station, 'Grill');
  });

  test('the edit is in the audit trail, before and after', async () => {
    const a = await H.q(ctx,
      "SELECT before, after FROM chain.audit WHERE action = 'menu_update'"
      + " AND entity_id = 'REEF-CURRY' ORDER BY at DESC LIMIT 1");
    assert.ok(a.rows.length, 'a price change is the most disputed edit in a restaurant');
    assert.equal(Number(a.rows[0].before.price), 95);
    assert.equal(Number(a.rows[0].after.price), 105);
  });

  test('A PRICE CHANGE IS NOT RETROSPECTIVE', async () => {
    /* The property that matters most. Sell at one price, reprice, and the sale
       must still say what the guest actually paid. */
    const sold = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'REEF-CURRY', qty: 1 }],
        // 105.00 goods + 10% service = 115.50
        payments: [{ method: 'cash', amount: '115.50' }],
      },
    }]);
    const receipt = sold.json.results[0].result;
    assert.ok(receipt && receipt.receiptNo, JSON.stringify(sold.json.results[0]));

    await asMgr('PATCH', '/REEF-CURRY', { price: 250 });

    const line = await H.q(ctx,
      'SELECT l.unit_price, l.name FROM sale_line l JOIN sale s ON s.id = l.sale_id'
      + ' WHERE s.receipt_no = $1', [receipt.receiptNo]);
    assert.equal(Number(line.rows[0].unit_price), 105,
      'the sale still says what was charged, not what the dish costs now');

    const total = await H.q(ctx, 'SELECT total FROM sale WHERE receipt_no = $1', [receipt.receiptNo]);
    assert.equal(Number(total.rows[0].total), 115.50);
  });

  test('retiring a dish takes it off the till but keeps the history', async () => {
    const r = await asMgr('DELETE', '/REEF-CURRY');
    assert.equal(r.status, 200);
    assert.equal(r.json.retired, true);

    const snap = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });
    assert.ok(!snap.json.items.find((i) => i.id === 'REEF-CURRY'), 'gone from the selling screen');

    const still = await H.q(ctx, 'SELECT count(*)::int AS n FROM sale_line WHERE item_id = $1', ['REEF-CURRY']);
    assert.equal(still.rows[0].n, 1, 'and the sale that sold it is untouched');

    const row = await H.q(ctx, 'SELECT active FROM item WHERE id = $1', ['REEF-CURRY']);
    assert.equal(row.rows[0].active, false, 'deactivated, never deleted');
  });

  test('a retired dish cannot be sold', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'REEF-CURRY', qty: 1 }],
        payments: [{ method: 'cash', amount: '10.00' }],
      },
    }]);
    assert.match(r.json.results[0].error, /unknown or inactive item/i);
  });

  test('retiring twice is not an error', async () => {
    const r = await asMgr('DELETE', '/REEF-CURRY');
    assert.equal(r.status, 200);
    assert.equal(r.json.alreadyRetired, true);
  });

  test('a dish can be brought back', async () => {
    const r = await asMgr('PATCH', '/REEF-CURRY', { active: true });
    assert.equal(r.status, 200);
    const snap = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });
    assert.ok(snap.json.items.find((i) => i.id === 'REEF-CURRY'));
  });

  test('off-menu is a separate state from retired (§3.2)', async () => {
    /* "Off-menu dishes are visibly struck, not hidden — the kitchen took them
       off tonight and the operator needs to know why the guest cannot have
       one." So it stays in the projection, flagged. */
    await asMgr('PATCH', '/REEF-CURRY', { offMenu: true });
    const snap = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });
    const found = snap.json.items.find((i) => i.id === 'REEF-CURRY');
    assert.ok(found, 'still on the screen');
    assert.equal(found.off_menu, true, 'and marked');
  });

  test('the editor lists inactive dishes, with what they have sold', async () => {
    const r = await asMgr('GET', '');
    assert.equal(r.status, 200);
    const found = r.json.items.find((i) => i.id === 'REEF-CURRY');
    assert.ok(found);
    assert.equal(found.sold, 1, 'so a manager can see what a dish did before removing it');
    assert.ok(Array.isArray(r.json.stations));
    assert.equal(r.json.stations[0].name, 'Grill');
  });

  test('editing a dish in another outlet is impossible', async () => {
    const other = ctx.outletId + 1;
    const r = await H.req('PATCH', `/api/outlet/${other}/menu/REEF-CURRY`,
      { body: { price: 1 }, token: mgr.token });
    assert.equal(r.status, 403, 'sameOutlet refuses before the database is touched');
  });
});
