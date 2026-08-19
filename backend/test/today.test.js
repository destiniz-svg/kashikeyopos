'use strict';
/* Today — §2 (`today`): "decisions waiting … NOT a dashboard of numbers; a list
 * of things to do, each linking to where it is done."
 *
 * The hardest requirement here is the one that sounds easy: a healthy outlet's
 * list must be EMPTY. A morning screen that always has something on it is a
 * screen people stop opening, and the way that happens is a check that fires on
 * an ordinary condition. So the suite starts by proving the list is clear, then
 * breaks one thing at a time and requires exactly that row to appear.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('today — the decisions waiting', () => {
  let ctx, mgr;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
  });
  after(() => H.teardown(ctx));

  const today = (token) =>
    H.req('GET', `/api/outlet/${ctx.outletId}/today?date=${ctx.today}`, { token: token || mgr.token });
  const op = (kind, payload) =>
    H.push(ctx, [{ opId: H.uuid(), kind, at: Date.now(), payload }]);
  const ids = async () => (await today()).json.items.map((i) => i.id);

  test('a healthy outlet has NOTHING waiting', async () => {
    const r = await today();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.items, [], 'nothing fires on an ordinary quiet outlet');
    assert.equal(r.json.clear, true);
    assert.equal(r.json.now, 0);
  });

  test('every row that ever appears carries somewhere to go', async () => {
    /* Rule 2 of the module, enforced against whatever the suite has managed to
       provoke by the end. Registered here so it runs over the full list. */
    await op('drawer_open', { float: 0 });
    await op('drawer_close', { counted: 90 });        // 90.00 over
    const r = await today();
    assert.ok(r.json.items.length > 0);
    for (const i of r.json.items) {
      assert.ok(i.where && i.where.module, i.id + ' has no module to open');
      assert.ok(i.action, i.id + ' has no action');
      assert.ok(i.title && i.detail, i.id + ' does not explain itself');
      assert.ok(['now', 'today', 'watch'].includes(i.severity), i.id + ' has an odd severity');
    }
  });

  test('a drawer that missed by a lot is a conversation, and says where', async () => {
    const item = (await today()).json.items.find((i) => i.id === 'drawer-variance');
    assert.ok(item, 'the 90.00 over is on the list');
    assert.match(item.title, /over by 90\.00/);
    assert.equal(item.where.module, 'reports');
    assert.equal(item.severity, 'today');
  });

  test('a small variance is NOT on the list', async () => {
    /* The threshold earns its place here. Every drawer misses by a few laari;
       a screen that reported each one would be noise, and noise is how the
       hundred-rufiyaa one gets scrolled past. */
    await H.asOwner(ctx, 'DELETE FROM drawer_session');
    await H.asOwner(ctx, "DELETE FROM journal WHERE source = 'drawer'");
    await op('drawer_open', { float: 0 });
    await op('drawer_close', { counted: 0.5 });
    assert.ok(!(await ids()).includes('drawer-variance'));
  });

  test('a register left open on a previous day is the loudest thing on it', async () => {
    await H.asOwner(ctx,
      "INSERT INTO drawer_session (opened_by, float_amount, opened_at)"
      + " VALUES ($1, 300, now() - interval '2 days')", [ctx.staffId]);
    const r = await today();
    const item = r.json.items.find((i) => i.id === 'register-left-open');
    assert.ok(item);
    assert.equal(item.severity, 'now');
    assert.equal(r.json.items[0].id, 'register-left-open', 'and it sorts to the top');
    await H.asOwner(ctx, 'DELETE FROM drawer_session WHERE closed_at IS NULL');
  });

  test('a till that disagreed with the server lands here too', async () => {
    const b = H.priceIt(ctx, [['COLA', 1]]);
    await op('sale', {
      businessDate: ctx.today, channel: 'takeaway', covers: 1,
      lines: [{ itemId: 'COLA', qty: 1 }],
      payments: [{ method: 'card', amount: b.total / 100 }],
      clientTotal: (b.total / 100) + 3,
    });
    const item = (await today()).json.items.find((i) => i.id === 'till-disagreed');
    assert.ok(item);
    assert.equal(item.where.module, 'orders');
  });

  test('stock that went negative is urgent, and names what', async () => {
    // Sell more beef than the pantry ever held.
    await op('sale', {
      businessDate: ctx.today, channel: 'dine_in', covers: 1,
      lines: [{ itemId: 'BURGER', qty: 200 }],
      payments: [{ method: 'cash', amount: H.priceIt(ctx, [['BURGER', 200]]).total / 100 }],
    });
    const item = (await today()).json.items.find((i) => i.id === 'stock-negative');
    assert.ok(item, 'the oversold ingredient is on the list');
    assert.equal(item.severity, 'now');
    assert.match(item.detail, /Beef mince/);
    assert.equal(item.where.module, 'inventory');
  });

  test('an ingredient in a recipe with no cost is a margin that is not real', async () => {
    await H.asOwner(ctx, "UPDATE ingredient SET avg_cost = 0 WHERE id = 'BUN'");
    const item = (await today()).json.items.find((i) => i.id === 'ingredient-uncosted');
    assert.ok(item);
    assert.match(item.detail, /Burger bun/);
    assert.equal(item.where.module, 'recipes');
  });

  test('a dish SOLD today with no recipe is flagged; an unsold one is not', async () => {
    await H.asOwner(ctx, "INSERT INTO item (id, name, category, price)"
      + " VALUES ('WATER','Still water','Beverage',15.00) ON CONFLICT DO NOTHING");
    assert.ok(!(await ids()).includes('sold-without-recipe'),
      'a dish nobody has ordered is an unfinished menu, not a decision this morning');

    await op('sale', {
      businessDate: ctx.today, channel: 'takeaway', covers: 1,
      lines: [{ itemId: 'WATER', qty: 1 }],
      payments: [{ method: 'cash', amount: H.priceIt({ ...ctx, menu: { WATER: 1500 } }, [['WATER', 1]]).total / 100 }],
    });
    const item = (await today()).json.items.find((i) => i.id === 'sold-without-recipe');
    assert.ok(item, 'once it has been sold, its zero cost is overstating the day');
    assert.match(item.detail, /Still water/);
  });

  test('an item on the menu at no price can be rung up for nothing', async () => {
    await H.asOwner(ctx, "INSERT INTO item (id, name, category, price)"
      + " VALUES ('FREE','Mystery dish','Food',0) ON CONFLICT (id) DO UPDATE SET price = 0");
    const item = (await today()).json.items.find((i) => i.id === 'item-unpriced');
    assert.ok(item);
    assert.equal(item.where.module, 'menu');
    await H.asOwner(ctx, "DELETE FROM item WHERE id = 'FREE'");
  });

  test('a dish bleeding margin is watched, not shouted about', async () => {
    /* A cost that swamps the price. Ordered LAST because it changes the
       costing every other check reads. */
    await H.asOwner(ctx, "UPDATE ingredient SET avg_cost = 0.55 WHERE id = 'BEEF'");
    const item = (await today()).json.items.find((i) => i.id === 'margin-bleeder');
    assert.ok(item, 'the burger is now costing more than it earns');
    assert.equal(item.severity, 'watch', 'a thin margin is not an emergency at 7am');
    assert.match(item.detail, /Beef burger/);
    assert.equal(item.where.module, 'recipes');
  });

  test('the list is ordered by what it costs to ignore', async () => {
    const items = (await today()).json.items;
    const rank = { now: 0, today: 1, watch: 2 };
    for (let i = 1; i < items.length; i++) {
      assert.ok(rank[items[i - 1].severity] <= rank[items[i].severity],
        'severities are out of order: ' + items.map((x) => x.severity).join(','));
    }
    const r = (await today()).json;
    assert.equal(r.clear, false);
    assert.equal(r.now, items.filter((i) => i.severity === 'now').length);
  });

  test('a cashier cannot read it, and a guest certainly cannot', async () => {
    assert.equal((await today(ctx.token)).status, 403);
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '1' });
    assert.equal((await today(g.json.token)).status, 403);
  });

  test('a malformed date is refused rather than guessed at', async () => {
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/today?date=this-morning`,
      { token: mgr.token });
    assert.equal(r.status, 400);
  });

  test('a brand-new outlet with nothing in it is clear, not broken', async () => {
    /* 10-NO-DEMO-DATA.md: "Empty is a first-class state." A fresh outlet has no
       menu, no stock, no sales and no register — every one of which a naive
       check would report as a problem on the operator's very first morning. */
    const fresh = await H.bootOutlet();
    const boss = await H.addStaff(fresh, 'New Manager', 3);
    const r = await H.req('GET', `/api/outlet/${fresh.outletId}/today?date=${fresh.today}`,
      { token: boss.token });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.items, []);
    assert.equal(r.json.clear, true);
  });
});
