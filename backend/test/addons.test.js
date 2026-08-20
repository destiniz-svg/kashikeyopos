'use strict';
/* ADD-ONS — 02-POS-SPEC.md §2 (`menu`), migration 037.
 *
 * "Extra sambol, +15." One sentence, and every hard rule in the platform lands
 * on it at once, which is what this file is for.
 *
 *   · THE TERMINAL NEVER NAMES A PRICE. A till that could post an add-on with
 *     a price attached is not a price list, it is a suggestion. So the till
 *     posts ids and the server does the arithmetic — the same rule the dish
 *     itself has followed since the money chain was made server-authoritative.
 *   · AN ADD-ON HAS TO BE OFFERED BEFORE IT CAN BE ORDERED. A guest phone that
 *     could post `EXTRA-SAMBOL` against a dessert would print a docket line the
 *     kitchen has no pass for, and the guest would be charged for it.
 *   · THE RETIRED RULE APPLIES TO ADD-ONS TOO. Pulling one at four o'clock
 *     must not make every open tab that already carries it unsettleable —
 *     exactly the bug that "off the menu" dishes had.
 *   · ADD-ON REVENUE CARRIES ADD-ON COST. An add-on that names a dish explodes
 *     through that dish's recipe when it sells. One that earned MVR 45 at
 *     nought cost would have made every GP figure in the platform lie.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const snapshot = (ctx, token) =>
  H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: token || ctx.token });

describe('the add-on catalogue', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Manager', 3);
  });
  after(() => H.teardown(ctx));

  const url = (p = '') => `/api/outlet/${ctx.outletId}/menu${p}`;
  const asMgr = (method, p, body) => H.req(method, url(p), { body, token: mgr.token });

  test('a till may sell an add-on and may not price one', async () => {
    const r = await H.req('GET', url('/addons'), { token: ctx.token });
    assert.equal(r.status, 403, 'the price list is a manager’s signature');
    const w = await H.req('POST', url('/addons'),
      { body: { id: 'X', name: 'X', price: 1 }, token: ctx.token });
    assert.equal(w.status, 403);
  });

  test('a manager publishes one to a section', async () => {
    const r = await asMgr('POST', '/addons', {
      id: 'extra-sambol', name: 'Extra sambol', price: 15, sections: ['Food'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.id, 'EXTRA-SAMBOL', 'codes normalise like dish codes do');
  });

  test('a free add-on is still an add-on', async () => {
    /* "No ice" prints on the docket and costs nothing. Nought is a price, not
       an unset field, which is why the column defaults to it rather than NULL. */
    const r = await asMgr('POST', '/addons', {
      id: 'no-ice', name: 'No ice', price: 0, sections: ['Beverage'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const list = await asMgr('GET', '/addons');
    const it = list.json.addons.find((a) => a.id === 'NO-ICE');
    assert.equal(Number(it.price), 0);
  });

  test('a negative price is refused', async () => {
    const r = await asMgr('POST', '/addons', { id: 'BAD', name: 'Bad', price: -1 });
    assert.equal(r.status, 400);
  });

  test('the catalogue says how many dishes each one reaches', async () => {
    const r = await asMgr('GET', '/addons');
    const sambol = r.json.addons.find((a) => a.id === 'EXTRA-SAMBOL');
    assert.equal(sambol.dishes, 1, 'BURGER is the outlet’s only Food dish');
    const ice = r.json.addons.find((a) => a.id === 'NO-ICE');
    assert.equal(ice.dishes, 1, 'and COLA its only Beverage');
  });

  test('the till and the guest both get it on the snapshot', async () => {
    const staff = await snapshot(ctx);
    assert.ok(staff.json.modifiers.some((m) => m.id === 'EXTRA-SAMBOL'));

    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '1' });
    const guest = await snapshot(ctx, g.json.token);
    const m = guest.json.modifiers.find((x) => x.id === 'EXTRA-SAMBOL');
    assert.ok(m, 'a guest phone can offer what the till offers');
    assert.equal(Number(m.price), 15, 'at the same price — one figure, two surfaces');
  });

  test('a dish may name its own list instead of inheriting the section’s', async () => {
    const r = await asMgr('PATCH', '/COLA', { addonsOwn: true, addonIds: ['EXTRA-SAMBOL'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const list = await asMgr('GET', '');
    const cola = list.json.items.find((i) => i.id === 'COLA');
    assert.deepEqual(cola.addonIds, ['EXTRA-SAMBOL']);
    assert.equal(cola.addonsOwn, true);
    // and put it back, so the rest of the file reads the section rule
    await asMgr('PATCH', '/COLA', { addonsOwn: false, addonIds: [] });
  });

  test('naming an EMPTY list is a real answer, not the same as inheriting', async () => {
    await asMgr('PATCH', '/COLA', { addonsOwn: true, addonIds: [] });
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T90', lines: [{ itemId: 'COLA', qty: 1, addons: [{ id: 'NO-ICE' }] }] },
    }]);
    assert.match(r.json.results[0].error, /not offered/i,
      '"this dish takes no add-ons" is a decision somebody made');
    await asMgr('PATCH', '/COLA', { addonsOwn: false, addonIds: [] });
  });

  test('renaming a section moves its dishes, and its add-ons, with it', async () => {
    /* A section is the TEXT on the dish. Renaming it here and nowhere else
       leaves every dish pointing at a name with no row: the colour, the icon
       and the station silently revert and the merchant is told nothing. */
    await asMgr('PUT', '/sections/Food', { color: '#b8431d' });
    const r = await asMgr('PUT', '/sections/Food', { renameTo: 'Kitchen' });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const dish = await H.q(ctx, "SELECT category FROM item WHERE id = 'BURGER'");
    assert.equal(dish.rows[0].category, 'Kitchen', 'the dish came with it');
    const mod = await H.q(ctx, "SELECT sections FROM modifier WHERE id = 'EXTRA-SAMBOL'");
    assert.ok(mod.rows[0].sections.includes('Kitchen'),
      'and so did the add-on published to it — otherwise it stops being offered');
    const sec = await H.q(ctx, "SELECT color FROM menu_section WHERE name = 'Kitchen'");
    assert.equal(sec.rows[0].color, '#b8431d', 'and the colour survived');

    await asMgr('PUT', '/sections/Kitchen', { renameTo: 'Food' });
  });

  test('an add-on pointed at a dish that does not exist is refused', async () => {
    const r = await asMgr('POST', '/addons',
      { id: 'GHOST', name: 'Ghost', price: 5, recipeItemId: 'NOPE' });
    assert.equal(r.status, 409);
  });
});

describe('an add-on on a round, and on the bill', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Manager', 3);
    await H.req('POST', `/api/outlet/${ctx.outletId}/menu/addons`, {
      token: mgr.token,
      body: { id: 'EXTRA-SAMBOL', name: 'Extra sambol', price: 15, sections: ['Food'] },
    });
  });
  after(() => H.teardown(ctx));

  test('the kitchen line carries it, at the catalogue’s price', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T21', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 2, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
      },
    }]);
    assert.ok(r.json.results[0].result, JSON.stringify(r.json.results[0]));

    const l = await H.q(ctx, "SELECT unit_price, addons FROM ticket_line"
      + " WHERE item_id = 'BURGER' AND ticket_id = (SELECT id FROM ticket WHERE table_no = 'T21')");
    assert.equal(Number(l.rows[0].unit_price), 100,
      'the extra folds into the unit price — 85 + 15');
    assert.equal(l.rows[0].addons[0].name, 'Extra sambol');
    assert.equal(Number(l.rows[0].addons[0].price), 15);
  });

  test('a price the terminal invents is ignored — the server holds the price list', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T22',
        lines: [{ itemId: 'BURGER', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 1, price: 0 }] }],
      },
    }]);
    const l = await H.q(ctx, "SELECT unit_price FROM ticket_line"
      + " WHERE ticket_id = (SELECT id FROM ticket WHERE table_no = 'T22')");
    assert.equal(Number(l.rows[0].unit_price), 100, 'not 85 — the terminal does not decide');
  });

  test('one the dish does not offer is refused, not silently dropped', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T23',
        lines: [{ itemId: 'COLA', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
      },
    }]);
    assert.equal(r.status, 200, 'the push itself succeeds — the OP is refused');
    assert.ok(!r.json.results[0].result, "the op wrote nothing");
    assert.match(r.json.results[0].error, /not offered on Cola/i);
    const t = await H.q(ctx, "SELECT 1 FROM ticket WHERE table_no = 'T23'");
    assert.equal(t.rows.length, 0, 'and nothing was written');
  });

  test('a quantity of nought is not an error — it is just not an add-on', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T24',
        lines: [{ itemId: 'BURGER', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 0 }] }],
      },
    }]);
    const l = await H.q(ctx, "SELECT unit_price, addons FROM ticket_line"
      + " WHERE ticket_id = (SELECT id FROM ticket WHERE table_no = 'T24')");
    assert.equal(Number(l.rows[0].unit_price), 85);
    assert.deepEqual(l.rows[0].addons, []);
  });

  test('the snapshot shows the till what was added, and what it cost', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T21');
    assert.equal(t.lines[0].addons[0].name, 'Extra sambol');
    assert.equal(Number(t.lines[0].price), 100);
  });

  test('the sale charges it, taxes it and writes it on the line', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T21');
    /* 2 × (85 + 15) = 200 goods, then service and tax on top of that, exactly
       as if the dish had been priced at 100 in the first place — which is the
       whole point of folding the extra into the unit price. */
    const bill = H.money.priceBill({
      lines: [{ unitPrice: 10000, qty: 2 }],
      servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        ticketId: t.id, table: 'T21', businessDate: ctx.today,
        lines: [{ itemId: 'BURGER', qty: 2, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
        payments: [{ method: 'cash', amount: (bill.total / 100).toFixed(2) }],
        clientTotal: (bill.total / 100).toFixed(2),
      },
    }]);
    assert.ok(r.json.results[0].result, JSON.stringify(r.json.results[0]));

    const line = await H.q(ctx, "SELECT unit_price, addons FROM sale_line"
      + " WHERE sale_id = (SELECT id FROM sale ORDER BY at DESC LIMIT 1)");
    assert.equal(Number(line.rows[0].unit_price), 100);
    assert.equal(line.rows[0].addons[0].name, 'Extra sambol',
      'the receipt can say WHY the curry cost more than the menu said');
  });

  test('and the receipt can say WHY the dish cost more than the menu said', async () => {
    /* The one question a unit price cannot answer, and the reason
       sale_line.addons exists at all. */
    const sale = await H.q(ctx, 'SELECT id FROM sale ORDER BY at DESC LIMIT 1');
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/orders/${sale.rows[0].id}`,
      { token: ctx.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const line = r.json.lines.find((l) => l.itemId === 'BURGER');
    assert.equal(line.addons[0].name, 'Extra sambol');
    assert.equal(Number(line.addons[0].price), 15);
  });

  test('a retired add-on can still be paid for on a tab that already carries it', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T25',
        lines: [{ itemId: 'BURGER', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
      },
    }]);
    const del = await H.req('DELETE', `/api/outlet/${ctx.outletId}/menu/addons/EXTRA-SAMBOL`,
      { token: mgr.token });
    assert.equal(del.status, 200);

    const s = await snapshot(ctx);
    assert.ok(!s.json.modifiers.some((m) => m.id === 'EXTRA-SAMBOL'),
      'it is off the selling screen at once');
    const t = s.json.tickets.find((x) => x.table_no === 'T25');

    const bill = H.money.priceBill({
      lines: [{ unitPrice: 10000, qty: 1 }],
      servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        ticketId: t.id, table: 'T25', businessDate: ctx.today,
        lines: [{ itemId: 'BURGER', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
        payments: [{ method: 'cash', amount: (bill.total / 100).toFixed(2) }],
      },
    }]);
    assert.ok(r.json.results[0].result,
      'a tab is settleable after the add-on on it is pulled: '
      + JSON.stringify(r.json.results[0]));
  });

  test('but it cannot be rung up fresh once it is gone', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T26',
        lines: [{ itemId: 'BURGER', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
      },
    }]);
    assert.match(r.json.results[0].error, /not offered/i);
  });
});

describe('an add-on ordered from a guest\u2019s phone', () => {
  let ctx, mgr, guest;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Manager', 3);
    await H.req('POST', `/api/outlet/${ctx.outletId}/menu/addons`, {
      token: mgr.token,
      body: { id: 'EXTRA-SAMBOL', name: 'Extra sambol', price: 15, sections: ['Food'] },
    });
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '3' });
    guest = g.json.token;
  });
  after(() => H.teardown(ctx));

  test('the phone posts ids and counts, and the till prices them', async () => {
    /* THE PHONE NEVER TAKES MONEY and never names a price. The order is a
       request; nothing is priced until a till accepts it and the round is fired
       through kitchen.sendRound, which reads the catalogue. */
    const r = await H.req('POST', `/api/outlet/${ctx.outletId}/guest/order`, {
      token: guest,
      body: {
        table: '3', opId: H.uuid(),
        lines: [{ itemId: 'BURGER', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 2 }] }],
      },
    });
    assert.equal(r.status, 201, r.text);

    const board = await H.req('GET', `/api/outlet/${ctx.outletId}/delivery`, { token: ctx.token });
    const o = board.json.waiting[0];
    assert.ok(o, 'it reached the till');

    const acc = await H.req('POST', `/api/outlet/${ctx.outletId}/delivery/${o.id}/accept`,
      { body: {}, token: ctx.token });
    assert.equal(acc.status, 200, acc.text);

    const l = await H.q(ctx, 'SELECT unit_price, addons FROM ticket_line'
      + ' WHERE ticket_id = (SELECT ticket_id FROM guest_order WHERE id = $1)', [o.id]);
    assert.equal(Number(l.rows[0].unit_price), 115,
      'the till priced it: 85 + two at 15, from ITS catalogue, not the phone\u2019s');
    assert.equal(l.rows[0].addons[0].qty, 2);
  });

  test('an add-on the dish does not offer is refused at the till, not printed', async () => {
    const r = await H.req('POST', `/api/outlet/${ctx.outletId}/guest/order`, {
      token: guest,
      body: {
        table: '3', opId: H.uuid(),
        lines: [{ itemId: 'COLA', qty: 1, addons: [{ id: 'EXTRA-SAMBOL', qty: 1 }] }],
      },
    });
    assert.equal(r.status, 201, 'the phone may ASK for anything');

    const board = await H.req('GET', `/api/outlet/${ctx.outletId}/delivery`, { token: ctx.token });
    const o = board.json.waiting.find((x) => x.id !== undefined);
    const acc = await H.req('POST', `/api/outlet/${ctx.outletId}/delivery/${o.id}/accept`,
      { body: {}, token: ctx.token });
    assert.equal(acc.status, 409, acc.text);
    assert.match(acc.json.error, /not offered/i,
      'and the till is the thing that says no — before it becomes money');
  });
});

describe('an add-on that costs the kitchen something', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Manager', 3);
    /* "Add a cola" — an add-on that IS a dish, so it explodes through that
       dish's recipe and moves syrup out of the store like any other sale. */
    await H.req('POST', `/api/outlet/${ctx.outletId}/menu/addons`, {
      token: mgr.token,
      body: {
        id: 'ADD-COLA', name: 'Add a cola', price: 25,
        sections: ['Food'], recipeItemId: 'COLA',
      },
    });
  });
  after(() => H.teardown(ctx));

  test('it moves stock and lands in cost of sales', async () => {
    const before = await H.q(ctx, "SELECT coalesce(sum(qty),0) AS q FROM stock_move"
      + " WHERE ingredient_id = 'SYRUP'");

    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: 'T31',
        lines: [{ itemId: 'BURGER', qty: 2, addons: [{ id: 'ADD-COLA', qty: 1 }] }],
      },
    }]);
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T31');
    const bill = H.money.priceBill({
      lines: [{ unitPrice: 11000, qty: 2 }],
      servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        ticketId: t.id, table: 'T31', businessDate: ctx.today,
        lines: [{ itemId: 'BURGER', qty: 2, addons: [{ id: 'ADD-COLA', qty: 1 }] }],
        payments: [{ method: 'cash', amount: (bill.total / 100).toFixed(2) }],
      },
    }]);
    assert.ok(r.json.results[0].result, JSON.stringify(r.json.results[0]));

    const after = await H.q(ctx, "SELECT coalesce(sum(qty),0) AS q FROM stock_move"
      + " WHERE ingredient_id = 'SYRUP'");
    /* COLA's recipe is 40 ml of syrup. Two burgers, one added cola each, so
       two colas' worth left the store — 80 ml. */
    assert.equal(Number(before.rows[0].q) - Number(after.rows[0].q), 80,
      'add-on revenue carried add-on stock');

    const sale = await H.q(ctx, 'SELECT cogs FROM sale ORDER BY at DESC LIMIT 1');
    const burgerOnly = await H.q(ctx,
      "SELECT (SELECT count(*) FROM recipe_line WHERE item_id = 'BURGER') AS n");
    assert.ok(Number(burgerOnly.rows[0].n) > 0);
    assert.ok(Number(sale.rows[0].cogs) > 0, 'and add-on cost reached the ledger');
  });
});
