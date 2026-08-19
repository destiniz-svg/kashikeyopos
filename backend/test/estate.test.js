'use strict';
/* The estate — 08-BUILD-STAGES §25, 11-OWNER-DASHBOARD-SPEC.
 *
 * THE TEST THAT MATTERS MOST HERE IS THE FIRST ONE: an owner can open it at
 * all. `chain.estate_day()` had never once succeeded — it asked `current_user`
 * inside a SECURITY DEFINER function, was told it was the function's owner
 * rather than the reporting role, and refused. The leak test's two probes
 * against it both wanted a refusal and both got one, so twenty-four green
 * probes sat on top of an endpoint that was a 500 for every owner who opened
 * the dashboard. A suite that only ever asserts "this is denied" cannot tell a
 * lock from a wall.
 *
 * NOTE ON ISOLATION IN THESE TESTS. The estate aggregates EVERY active outlet,
 * and the suite leaves each file's throwaway outlet provisioned. So assertions
 * about exact money are made against this outlet's own row; assertions about
 * the consolidated figures are made about their internal consistency, which is
 * what could actually break. Asserting an estate-wide total equals one outlet's
 * takings would be a test that passes only when it runs alone.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const estate = require('../src/estate');

describe('the estate', () => {
  let ctx, owner, mgr, today;

  before(async () => {
    ctx = await H.bootOutlet();
    owner = await H.addStaff(ctx, 'The Owner', 5);
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    today = new Date().toISOString().slice(0, 10);
  });
  after(() => H.teardown(ctx));

  const get = (p, token) => H.req('GET', `/api${p}`, { token: token || owner.token });
  const put = (p, body, token) =>
    H.req('PUT', `/api${p}`, { body, token: token || owner.token });
  /* Four people on one bill — the distinction the old aggregate lost. */
  const sell = (basket, covers) => H.push(ctx, [{
    opId: H.uuid(), kind: 'sale', at: Date.now(),
    payload: {
      businessDate: today, channel: 'dine_in', covers,
      lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
      payments: [{ method: 'cash', amount: H.priceIt(ctx, basket).total / 100 }],
    },
  }]);
  const mine = (body) => body.outlets.find((o) => o.id === ctx.outletId);

  test('an owner can actually open it', async () => {
    const r = await get('/estate/overview');
    assert.equal(r.status, 200, 'the estate refused the one caller it exists for');
    assert.ok(Array.isArray(r.json.outlets));
    assert.ok(mine(r.json), 'this outlet is missing from the estate');
  });

  test('a manager is not an owner', async () => {
    const r = await get('/estate/overview', mgr.token);
    assert.equal(r.status, 403);
  });

  test('the read is stamped in the audit trail as group scope', async () => {
    await get('/estate/overview');
    const r = await H.asOwner(ctx,
      "SELECT scope, action FROM chain.audit WHERE action = 'estate_read'"
      + ' AND outlet_id = $1 ORDER BY at DESC LIMIT 1', [ctx.outletId]);
    assert.equal(r.rows.length, 1, 'the one cross-outlet read left no trace');
    assert.equal(r.rows[0].scope, 'group');
  });

  describe('once it has traded', () => {
    let sold;

    before(async () => {
      /* Two bills, nine people between them. */
      await sell([['BURGER', 2]], 4);
      await sell([['BURGER', 1], ['COLA', 1]], 5);
      sold = (await get("/estate/overview")).json;
    });

    test('covers are people, not bills', () => {
      const o = mine(sold);
      assert.equal(o.bills, 2);
      assert.equal(o.covers, 9, 'covers came back as the number of bills again');
    });

    test('takings and revenue are different numbers, and both are named', () => {
      const o = mine(sold);
      assert.ok(o.takings > 0 && o.revenue > 0);
      /* Menu prices are GST-inclusive, so what the guest paid is more than the
         revenue the P&L recognises — by the tax, exactly. */
      assert.equal(
        Math.round((o.revenue + o.tax + o.service) * 100) / 100,
        Math.round(o.takings * 100) / 100,
        'takings does not decompose into revenue + tax + service');
    });

    test('the day it shows is the day it was asked for', () => {
      assert.equal(sold.date, today);
      assert.equal(sold.fellBack, false);
    });

    test('the consolidated P&L holds together', () => {
      const p = sold.pnl;
      assert.equal(p.grossProfit, Math.round((p.revenue - p.costOfSales) * 100) / 100);
      assert.equal(p.primeCost, Math.round((p.costOfSales + p.labour) * 100) / 100);
      assert.equal(p.netProfit,
        Math.round((p.grossProfit - p.labour - p.overheads) * 100) / 100);
    });

    test('labour with no payroll behind it is flagged missing, not on target', () => {
      /* The screen colours this figure from these two flags. Without them a
         restaurant that has never run payroll reads as having its wage bill
         under control, which is the most flattering lie the dashboard could
         tell — and prime cost inherits it. */
      assert.equal(sold.figures.labour.posted, false);
      assert.equal(sold.figures.primeCost.complete, false);
    });

    test('the cost of sales is cross-checked, not reconciled', () => {
      assert.ok('difference' in sold.reconciliation);
      assert.equal(sold.reconciliation.agrees,
        sold.reconciliation.difference === 0);
    });

    test('the fortnight has fourteen columns and knows which ones traded', () => {
      assert.equal(sold.series.bars.length, 14);
      assert.equal(sold.series.bars[13].date, today);
      assert.equal(sold.series.bars[13].traded, true);
      /* An untraded day is null, never a zero pretending to be a quiet day. */
      const untraded = sold.series.bars.filter((b) => !b.traded);
      assert.ok(untraded.every((b) => b.revenue === null));
    });

    test('growth is either a figure or a reason, never both and never neither', () => {
      /* WHICH of the two it is depends on what the rest of the suite happened
         to trade in the same fortnight — every file's throwaway outlet is in
         this estate. So the assertion is the INVARIANT, and the two branches
         themselves are pinned exactly in the derivation tests below, where the
         input is controlled. An integration assertion that only holds when this
         file runs alone is worse than none. */
      const s = sold.series;
      assert.equal(s.growthPct === null, s.growthSuppressed !== null,
        'a suppressed growth figure must say why, and a real one must not');
    });
  });

  describe('the targets', () => {
    /* One row for the whole chain — that is the point of a yardstick — so it
       carries over between runs and has to be put back to "undecided" here
       rather than assumed. A test that only passes on a virgin database is a
       test that stops being run. */
    before(() => put('/estate/targets',
      { foodCostTargetPct: null, labourTargetPct: 30, primeTargetPct: 65 }));

    test('food cost has no target until somebody sets one', async () => {
      const r = await get('/estate/targets');
      assert.equal(r.status, 200);
      /* Not 0, and not 33 — nobody has said what this kitchen is aiming at. */
      assert.equal(r.json.foodCostTargetPct, null);
      assert.equal(r.json.labourTargetPct, 30);
      assert.equal(r.json.primeTargetPct, 65);
    });

    test('and that unset target is the first thing waiting on the owner', async () => {
      const r = await get('/estate/overview');
      assert.ok(r.json.waiting.some((w) => w.kind === 'target'));
    });

    test('a manager may read the yardstick but not move it', async () => {
      assert.equal((await get('/estate/targets', mgr.token)).status, 200);
      assert.equal((await put('/estate/targets', { foodCostTargetPct: 30 }, mgr.token)).status,
        403);
    });

    test('an owner sets it, and food cost starts being judged', async () => {
      const r = await put('/estate/targets', { foodCostTargetPct: 30 });
      assert.equal(r.status, 200);
      assert.equal(r.json.foodCostTargetPct, 30);
      const o = await get('/estate/overview');
      assert.equal(o.json.figures.foodCost.target, 30);
      assert.notEqual(o.json.figures.foodCost.over, null);
      assert.ok(!o.json.waiting.some((w) => w.kind === 'target'));
    });

    test('a percentage outside 0–100 is refused', async () => {
      assert.equal((await put('/estate/targets', { labourTargetPct: 140 })).status, 400);
      assert.equal((await put('/estate/targets', { labourTargetPct: 0 })).status, 400);
    });

    test('only the food cost target may be cleared back to undecided', async () => {
      assert.equal((await put('/estate/targets', { labourTargetPct: null })).status, 400);
      const r = await put('/estate/targets', { foodCostTargetPct: null });
      assert.equal(r.status, 200);
      assert.equal(r.json.foodCostTargetPct, null);
    });

    test('setting one field leaves the others alone', async () => {
      await put('/estate/targets', { foodCostTargetPct: 31, labourTargetPct: 28 });
      await put('/estate/targets', { foodCostTargetPct: 32 });
      const r = await get('/estate/targets');
      assert.equal(r.json.foodCostTargetPct, 32);
      assert.equal(r.json.labourTargetPct, 28, 'an omitted field was blanked');
    });
  });
});

/* ── the derivation itself, without a database ─────────────────────────────
 *
 * These are the rules the spec states in words, so they are asserted exactly
 * rather than inferred from whatever the day happened to contain. */
describe('the estate derivation', () => {
  const noTargets = {
    foodCostTargetPct: null, labourTargetPct: 30, primeTargetPct: 65,
    weights: { foodOver: 3, labourOver: 2, primeOver: 1.5, silentSite: 6,
      serviceOverdue: 5, houseOverLimit: 3, saleUnjournalled: 8 },
  };
  const figures = (food, labour, prime) => ({
    foodCost: { value: food }, labour: { value: labour }, primeCost: { value: prime },
    netSales: { value: 1000 },
  });

  test('no revenue is no score, not a zero', () => {
    const s = estate.score(0, [], figures(null, null, null), noTargets);
    assert.equal(s.value, null);
    assert.equal(s.reason, 'nothing has traded');
  });

  test('food cost is not deducted for while no target exists', () => {
    const s = estate.score(1000, [], figures(70, 10, 80), noTargets);
    assert.ok(!s.why.some((w) => /food cost/.test(w.cause)),
      'food cost was scored against a target nobody set');
  });

  test('each deduction says what it is for', () => {
    const t = { ...noTargets, foodCostTargetPct: 30 };
    const s = estate.score(1000, [], figures(35, 40, 75), t);
    /* 5 over food × 3, 10 over labour × 2, 10 over prime × 1.5 = 50. */
    assert.equal(s.value, 50);
    assert.equal(s.why.length, 3);
    assert.ok(s.why.every((w) => w.cause && w.points > 0));
  });

  test('the score floors at zero rather than going negative', () => {
    const t = { ...noTargets, foodCostTargetPct: 10 };
    const s = estate.score(1000, [], figures(90, 90, 95), t);
    assert.equal(s.value, 0);
  });

  test('a silent site only counts as silent when others are trading', () => {
    const busy = { id: 1, name: 'A', bills: 3, alerts: null, silent: false };
    const quiet = { id: 2, name: 'B', bills: 0, alerts: null, silent: true };
    const both = estate.score(1000, [busy, quiet], figures(null, null, null), noTargets);
    assert.ok(both.why.some((w) => /took nothing/.test(w.cause)));
    /* Everybody shut is a public holiday, and `silent` is false on every row —
       the flag is set where the comparison is made, so nothing is deducted. */
    const shut = estate.score(1000,
      [{ ...busy, bills: 0, silent: false }, { ...quiet, silent: false }],
      figures(null, null, null), noTargets);
    assert.ok(!shut.why.some((w) => /took nothing/.test(w.cause)));
  });

  test('growth needs both halves of the fortnight to have traded', () => {
    const rows = (dates) => dates.map((d) => ({ business_date: d, revenue: 100 }));
    const to = '2026-08-14';
    /* Only the recent week traded. */
    const one = estate.buildSeries(rows(['2026-08-12', '2026-08-13']), '2026-08-01', to);
    assert.equal(one.growthPct, null);
    assert.ok(/earlier week/.test(one.growthSuppressed));
    /* Both weeks traded — now it is a real comparison. */
    const two = estate.buildSeries(
      rows(['2026-08-02', '2026-08-12']), '2026-08-01', to);
    assert.equal(two.growthPct, 0);
    assert.equal(two.growthSuppressed, null);
  });

  test('a fortnight with one trading day is a sentence, not a chart', () => {
    const s = estate.buildSeries([{ business_date: '2026-08-14', revenue: 100 }],
      '2026-08-01', '2026-08-14');
    assert.equal(s.plottable, false);
    assert.equal(s.tradingDays, 1);
  });

  test('the P&L groups by accounts.js and nothing else', () => {
    const rows = [
      { outlet_id: 1, code: '4000', name: 'Food sales', type: 'income', balance: 1000 },
      { outlet_id: 2, code: '4000', name: 'Food sales', type: 'income', balance: 500 },
      { outlet_id: 1, code: '5000', name: 'Food cost', type: 'expense', balance: 400 },
      { outlet_id: 1, code: '6000', name: 'Wages', type: 'expense', balance: 300 },
      { outlet_id: 1, code: '6100', name: 'Rent', type: 'expense', balance: 200 },
    ];
    const p = estate.profitAndLoss(rows);
    /* The same account in two outlets is one line of one P&L. That IS the
       consolidation, and it is addition. */
    assert.equal(p.revenue, 1500);
    assert.equal(p.costOfSales, 400);
    assert.equal(p.labour, 300);
    assert.equal(p.overheads, 200);
    assert.equal(p.primeCost, 700);
    assert.equal(p.netProfit, 600);
    assert.equal(p.bar.reduce((a, b) => a + b.pct, 0), 100);
  });

  test('a loss stops the bar short instead of wrapping it', () => {
    const p = estate.profitAndLoss([
      { code: '4000', name: 'Food sales', type: 'income', balance: 100 },
      { code: '5000', name: 'Food cost', type: 'expense', balance: 90 },
      { code: '6100', name: 'Rent', type: 'expense', balance: 60 },
    ]);
    assert.equal(p.netProfit, -50);
    assert.equal(p.bar.find((b) => b.key === 'profit').pct, 0);
  });
});
