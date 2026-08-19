'use strict';
/* Analytics & CFO — §2 (`analytics`): "Prime cost, margin by dish, variance
 * trend." 08-BUILD-STAGES §22.
 *
 * §22's rule is the one under test: "Prime cost and net margin are computed
 * from posted journals, not from a parallel calculation." So the assertions are
 * mostly of the form "this screen's figure equals the P&L's figure", because
 * the only way two screens can agree is by being the same arithmetic over the
 * same rows.
 *
 * The dish dimension is the exception, and it is handled honestly rather than
 * blended: the ledger does not know which dish, so dish figures come from
 * sale_line — and their SUM is reconciled back against the ledger and the
 * difference reported.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('analytics and the CFO view', () => {
  let ctx, admin;

  before(async () => {
    ctx = await H.bootOutlet();
    admin = await H.addStaff(ctx, 'General Manager', 4);

    // Trade: burgers (costed) and colas (costed), plus wastage and a drawer
    // that came up short — so there is something for a variance trend to show.
    const sell = (basket) => H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
        payments: [{ method: 'cash', amount: H.priceIt(ctx, basket).total / 100 }],
      },
    }]);
    await sell([['BURGER', 4]]);
    await sell([['COLA', 10]]);
    await sell([['BURGER', 1], ['COLA', 2]]);

    const mgr = await H.addStaff(ctx, 'Storekeeper', 3);
    await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'stock_waste', at: Date.now(),
      payload: { ingredientId: 'BEEF', qty: 500, note: 'walk-in failed', date: ctx.today },
    }]);
    await H.push(ctx, [{ opId: H.uuid(), kind: 'drawer_open', at: Date.now(), payload: { float: 0 } }]);
    await H.push(ctx, [{ opId: H.uuid(), kind: 'drawer_close', at: Date.now(), payload: { counted: 10 } }]);
  });
  after(() => H.teardown(ctx));

  const get = (p, token) =>
    H.req('GET', `/api/outlet/${ctx.outletId}${p}`, { token: token || admin.token });

  /* ── §22: the same arithmetic, not a second one ───────────────────────── */

  test('every headline figure equals the P&L, because it IS the P&L', async () => {
    const [a, pnl] = await Promise.all([
      get('/analytics').then((r) => r.json),
      get('/reports/pnl').then((r) => r.json),
    ]);
    assert.equal(a.headline.revenue.toFixed(2), pnl.revenue.total.toFixed(2));
    assert.equal(a.headline.costOfSales.toFixed(2), pnl.costOfSales.total.toFixed(2));
    assert.equal(a.headline.grossProfit.toFixed(2), pnl.grossProfit.toFixed(2));
    assert.equal(a.headline.netProfit.toFixed(2), pnl.netProfit.toFixed(2));
    assert.equal(a.headline.primeCost.toFixed(2), pnl.primeCost.toFixed(2),
      'one prime cost, or it means two different things on two screens');
  });

  test('percentages are of revenue, and null rather than zero when there is none', async () => {
    const a = (await get('/analytics')).json;
    assert.equal(a.headline.primeCostPct,
      Math.round((a.headline.primeCost / a.headline.revenue) * 1000) / 10);
    assert.equal(a.headline.netMarginPct,
      Math.round((a.headline.netProfit / a.headline.revenue) * 1000) / 10);

    const empty = (await get('/analytics?from=2019-01-01&to=2019-01-31')).json;
    assert.equal(empty.headline.revenue, 0);
    assert.equal(empty.headline.netMarginPct, null,
      'no margin on no revenue — a 0% would read as trading badly rather than not trading');
  });

  test('prime cost says whether labour is in it', async () => {
    /* A restaurant reading 28% prime cost when payroll has never been run is
       reading a number that will roughly double. */
    const a = (await get('/analytics')).json;
    assert.equal(a.headline.labourPosted, false);
    assert.equal(a.headline.labour, 0);
    assert.equal(a.headline.primeCost.toFixed(2), a.headline.costOfSales.toFixed(2));
  });

  /* ── margin by dish ───────────────────────────────────────────────────── */

  test('dish margin uses the cost captured AT THE SALE, not today\'s prices', async () => {
    const before = (await get('/analytics')).json.dishes.find((d) => d.itemId === 'BURGER');
    assert.ok(before, 'the burger is on the list');
    assert.ok(before.cost > 0);

    // Beef doubles in price. Last month's profit must not change.
    await H.asOwner(ctx, "UPDATE ingredient SET avg_cost = avg_cost * 2 WHERE id = 'BEEF'");
    const after = (await get('/analytics')).json.dishes.find((d) => d.itemId === 'BURGER');
    assert.equal(after.cost.toFixed(2), before.cost.toFixed(2),
      'recomputing would make last month change when a supplier does');
    assert.equal(after.margin.toFixed(2), before.margin.toFixed(2));
  });

  test('the list is ranked by CONTRIBUTION, not by percentage', async () => {
    /* A 90% dish that sells twice a week contributes nothing; a 55% dish that
       sells two hundred times pays the rent. Sorting by percentage tells a
       kitchen to promote the wrong things. */
    const dishes = (await get('/analytics')).json.dishes;
    for (let i = 1; i < dishes.length; i++) {
      assert.ok(dishes[i - 1].margin >= dishes[i].margin,
        'out of order: ' + dishes.map((d) => d.name + ' ' + d.margin).join(', '));
    }
    const byPct = [...dishes].sort((a, b) => (b.marginPct || 0) - (a.marginPct || 0));
    assert.ok(dishes.length >= 2);
    // Not a coincidence check — just that the two orders are conceptually
    // different and the screen has chosen the money one.
    assert.equal(dishes[0].margin, Math.max(...dishes.map((d) => d.margin)));
    assert.ok(byPct.length === dishes.length);
  });

  test('shares of margin add up to the whole', async () => {
    const dishes = (await get('/analytics')).json.dishes;
    const share = dishes.reduce((a, d) => a + (d.shareOfMargin || 0), 0);
    assert.ok(Math.abs(share - 100) < 0.5, 'shares sum to ' + share);
  });

  test('an UNCOSTED dish is flagged, not reported as the best on the menu', async () => {
    /* A dish with no cost is not a 100% margin. It is a dish nobody has costed,
       and putting it top of the league is how a recipe never gets written. */
    await H.asOwner(ctx, "INSERT INTO item (id, name, category, price)"
      + " VALUES ('WATER','Still water','Beverage',20.00) ON CONFLICT DO NOTHING");
    await H.push(ctx, [{ opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'WATER', qty: 5 }],
        payments: [{ method: 'cash',
          amount: H.priceIt({ ...ctx, menu: { WATER: 2000 } }, [['WATER', 5]]).total / 100 }],
      } }]);

    const water = (await get('/analytics')).json.dishes.find((d) => d.itemId === 'WATER');
    assert.ok(water);
    assert.equal(water.costed, false);
    assert.equal(water.cost, 0);
    assert.equal(water.marginPct, 100, 'the arithmetic is what it is…');
    // …and the flag is what stops it being read as the star of the menu.
  });

  /* ── the reconciliation, which is the honest part ─────────────────────── */

  test('the dish totals are reconciled back to the ledger, not blended with it', async () => {
    const a = (await get('/analytics')).json;
    assert.equal(a.reconciliation.revenueDifference, 0);
    assert.equal(a.reconciliation.costDifference, 0);
    assert.equal(a.reconciliation.agrees, true);
    assert.equal(a.reconciliation.dishRevenue.toFixed(2),
      a.reconciliation.ledgerRevenue.toFixed(2));
  });

  test('and a REAL disagreement is reported rather than papered over', async () => {
    /* sale_line is the only place a dish exists, so it has to be summed
       separately — which means it can drift. A line deleted behind the
       module's back is exactly the shape of that drift. */
    await H.asOwner(ctx,
      "DELETE FROM sale_line WHERE item_id = 'COLA'"
      + ' AND id = (SELECT min(id::text)::uuid FROM sale_line WHERE item_id = \'COLA\')');
    const a = (await get('/analytics')).json;
    assert.equal(a.reconciliation.agrees, false);
    assert.ok(a.reconciliation.revenueDifference !== 0,
      'the dish total no longer matches the money the ledger holds');
  });

  /* ── the trend ────────────────────────────────────────────────────────── */

  test('the trend is by week, from the ledger, on ONE scale', async () => {
    const a = (await get('/analytics')).json;
    assert.ok(a.trend.length >= 1);
    const w = a.trend[a.trend.length - 1];
    assert.ok(w.revenue > 0);
    assert.equal(w.primeCost.toFixed(2), (w.costOfSales + w.labour).toFixed(2));
    // Revenue, cost of sales and labour are all money — one axis, one chart.
    // Anything needing a second y-scale would be a different chart.
    assert.ok(Object.keys(w).every((k) => k !== 'covers' && k !== 'tickets'));
  });

  test('the variance trend counts the losses NOBODY DECIDED ON', async () => {
    const v = (await get('/analytics')).json.variance;
    assert.ok(v.weeks.length >= 1);
    const w = v.weeks[v.weeks.length - 1];
    assert.ok(w.stock > 0, 'the wastage is in it');
    assert.ok(w.cash !== 0, 'so is the drawer that came up short');
    assert.equal(w.total.toFixed(2), (w.stock + w.cash).toFixed(2));
    assert.equal(typeof v.worsening, 'boolean',
      'half the point of a trend is the direction, and a reader should not have'
      + ' to compute it from the bars');
  });

  /* ── rank and range ───────────────────────────────────────────────────── */

  test('a manager cannot read it, and a cashier certainly cannot', async () => {
    const mgr = await H.addStaff(ctx, 'Another Manager', 3);
    assert.equal((await get('/analytics', mgr.token)).status, 403);
    assert.equal((await get('/analytics', ctx.token)).status, 403);
  });

  test('a malformed range is refused rather than guessed at', async () => {
    assert.equal((await get('/analytics?from=last-year')).status, 400);
    assert.equal((await get('/analytics?from=2026-05-01&to=2026-04-01')).status, 400);
  });

  test('a period with no trading is empty, not an error', async () => {
    const r = await get('/analytics?from=2019-02-01&to=2019-02-28');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.dishes, []);
    assert.deepEqual(r.json.trend, []);
    assert.equal(r.json.variance.total, 0);
    assert.equal(r.json.variance.worsening, false);
    assert.equal(r.json.reconciliation.agrees, true, 'nothing against nothing agrees');
  });
});
