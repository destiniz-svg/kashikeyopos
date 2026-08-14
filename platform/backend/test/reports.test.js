'use strict';
/* Reports, and the close of the trading day — §2 (`reports`), 08-BUILD-STAGES
 * stage 1 and §22.
 *
 * Two acceptance criteria are being tested here, both of them quoted from the
 * brief, and both of them about AGREEMENT rather than about output:
 *
 *   "A cashier signs in, opens the register with a float, sells, takes cash,
 *    and the drawer reconciles at close with a real over/short figure."
 *   "P&L, trial balance and tax return agree with each other and with the sum
 *    of the day's Z-reads."
 *
 * A report that renders is not a report that is right. So the assertions below
 * are almost all of the form "this figure equals that figure", computed two
 * ways, and the interesting ones are where a deliberate error is introduced and
 * the reports are required to NOTICE.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('reports and the close of day', () => {
  let ctx, mgr;
  let bill1, bill2;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
  });
  after(() => H.teardown(ctx));

  const get = (p, token) =>
    H.req('GET', `/api/outlet/${ctx.outletId}${p}`, { token: token || mgr.token });
  const op = (kind, payload, token) =>
    H.push({ ...ctx, token: token || ctx.token }, [{ opId: H.uuid(), kind, at: Date.now(), payload }]);

  const sell = (basket, payments, extra) => op('sale', {
    businessDate: ctx.today, channel: 'dine_in', covers: 1,
    lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
    payments, ...(extra || {}),
  });

  /* ── the drawer ───────────────────────────────────────────────────────── */

  test('there is no register open before anyone opens one', async () => {
    const r = await get('/drawer', ctx.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.open, false);
  });

  test('a cashier opens the register with a float', async () => {
    const r = await op('drawer_open', { float: 500 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.results[0].result.drawerId);

    const d = await get('/drawer', ctx.token);
    assert.equal(d.json.open, true);
    assert.equal(d.json.float, '500.00');
    assert.equal(d.json.takings, '0.00');
    assert.equal(d.json.expected, '500.00', 'nothing sold yet, so the float is all of it');
  });

  test('a second register cannot be opened over the first', async () => {
    // Two open drawers would each claim the same cash movements and both
    // reconcile wrongly.
    const r = await op('drawer_open', { float: 200 });
    assert.match(r.json.results[0].error, /already open/);
  });

  test('the expected figure follows the LEDGER as cash is taken', async () => {
    bill1 = H.priceIt(ctx, [['BURGER', 1]]);
    const r = await sell([['BURGER', 1]], [{ method: 'cash', amount: bill1.total / 100 }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const d = await get('/drawer', ctx.token);
    assert.equal(d.json.takings, (bill1.total / 100).toFixed(2));
    assert.equal(d.json.expected, (500 + bill1.total / 100).toFixed(2));
  });

  test('a CARD sale does not appear in the cash drawer', async () => {
    const before = (await get('/drawer', ctx.token)).json.expected;
    bill2 = H.priceIt(ctx, [['COLA', 2]]);
    await sell([['COLA', 2]], [{ method: 'card', amount: bill2.total / 100 }]);
    const after = (await get('/drawer', ctx.token)).json.expected;
    assert.equal(after, before, 'card money is with the acquirer, not in the till');
  });

  test('a CARD TIP does not appear in the cash drawer either', async () => {
    /* This used to fail. postSaleJournal debited 1000 for every tip whatever
       the tender was, so a card tip put money in the books that was never in
       the drawer, and the first count of the evening came up short by exactly
       the evening's card tips. */
    const before = (await get('/drawer', ctx.token)).json.expected;
    const b = H.priceIt(ctx, [['COLA', 1]]);
    const r = await sell([['COLA', 1]], [{ method: 'card', amount: b.total / 100, tip: 20 }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const after = (await get('/drawer', ctx.token)).json.expected;
    assert.equal(after, before, 'the tip went with the card money');
  });

  test('a CASH tip does', async () => {
    const before = Number((await get('/drawer', ctx.token)).json.expected);
    const b = H.priceIt(ctx, [['COLA', 1]]);
    await sell([['COLA', 1]], [{ method: 'cash', amount: b.total / 100, tip: 15 }]);
    const after = Number((await get('/drawer', ctx.token)).json.expected);
    assert.equal((after - before).toFixed(2), (b.total / 100 + 15).toFixed(2));
  });

  test('closing SHORT gives a real over/short figure and posts it', async () => {
    const d = await get('/drawer', ctx.token);
    const expected = Number(d.json.expected);
    const counted = expected - 37.5;          // somebody is 37.50 light

    const r = await op('drawer_close', { counted });
    const res = r.json.results[0].result;
    assert.equal(res.expected, expected.toFixed(2));
    assert.equal(res.counted, counted.toFixed(2));
    assert.equal(res.variance, '-37.50');
    assert.equal(res.verdict, 'short');

    /* And it POSTED. If it did not, account 1000 would say the restaurant holds
       cash that is not in the building, permanently. */
    const j = await H.q(ctx,
      "SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l ON l.journal_id = j.id"
      + " WHERE j.source = 'drawer' ORDER BY l.account_code");
    const byCode = Object.fromEntries(j.rows.map((x) => [x.account_code, x]));
    assert.equal(Number(byCode['6920'].dr).toFixed(2), '37.50', 'the loss is an expense');
    assert.equal(Number(byCode['1000'].cr).toFixed(2), '37.50', 'and cash came down');
  });

  test('a closed register cannot be closed again', async () => {
    const r = await op('drawer_close', { counted: 100 });
    assert.match(r.json.results[0].error, /no open register/);
  });

  test('closing OVER credits 6920 rather than income', async () => {
    // An over is not a sale. If it reached the revenue line it would be taxed
    // and it would flatter the day.
    await op('drawer_open', { float: 100 });
    const r = await op('drawer_close', { counted: 112 });
    assert.equal(r.json.results[0].result.verdict, 'over');
    assert.equal(r.json.results[0].result.variance, '12.00');

    const j = await H.q(ctx,
      "SELECT coalesce(sum(l.cr),0) AS cr FROM journal j JOIN journal_line l"
      + " ON l.journal_id = j.id WHERE j.source = 'drawer' AND l.account_code = '6920'");
    assert.equal(Number(j.rows[0].cr).toFixed(2), '12.00');
  });

  test('a count is required — closing blind is refused', async () => {
    await op('drawer_open', { float: 0 });
    const r = await op('drawer_close', {});
    assert.match(r.json.results[0].error, /count the drawer/);
    await op('drawer_close', { counted: 0 });     // tidy up for the checks below
  });

  /* ── the reports, and whether they agree ──────────────────────────────── */

  test('the trial balance balances, and says by how much', async () => {
    const r = await get('/reports/trial-balance');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.totals.difference, 0);
    assert.equal(r.json.balanced, true);
    // Shown as a figure, not a tick: a green tick is what a broken check also
    // looks like.
    assert.equal(r.json.totals.dr.toFixed(2), r.json.totals.cr.toFixed(2));
    assert.ok(r.json.accounts.length > 0);
    assert.ok(r.json.accounts.every((a) => a.dr !== 0 || a.cr !== 0),
      'accounts nothing was posted to are left off');
  });

  test('the P&L is derived from the ledger, not from the sale table', async () => {
    const [pnl, tb] = await Promise.all([
      get('/reports/pnl').then((r) => r.json),
      get('/reports/trial-balance').then((r) => r.json),
    ]);
    const acct = (code) => tb.accounts.find((a) => a.code === code);

    // Revenue is income accounts on their own side — so 4090, an INCOME account
    // whose normal side is dr, REDUCES it rather than reading as a cost.
    const income = tb.accounts.filter((a) => a.type === 'income');
    assert.equal(pnl.revenue.total.toFixed(2),
      income.reduce((a, x) => a + x.balance, 0).toFixed(2));

    assert.equal(pnl.costOfSales.total.toFixed(2),
      ((acct('5000')?.balance || 0) + (acct('5010')?.balance || 0)
        + (acct('5100')?.balance || 0)).toFixed(2));
    assert.equal(pnl.grossProfit.toFixed(2),
      (pnl.revenue.total - pnl.costOfSales.total).toFixed(2));
    assert.equal(pnl.netProfit.toFixed(2),
      (pnl.grossProfit - pnl.operatingCosts.total).toFixed(2));
  });

  test('the drawer shortage lands in operating costs, not in cost of sales', async () => {
    const pnl = (await get('/reports/pnl')).json;
    const short = pnl.operatingCosts.lines.find((l) => l.code === '6920');
    assert.ok(short, 'cash over/short is an operating cost');
    // 37.50 short less 12.00 over
    assert.equal(short.balance.toFixed(2), '25.50');
    assert.ok(!pnl.costOfSales.lines.some((l) => l.code === '6920'));
  });

  test('prime cost is honest about the labour it does not have yet', async () => {
    const pnl = (await get('/reports/pnl')).json;
    assert.equal(pnl.labourPosted, false, 'payroll is not built, and the report says so');
    assert.equal(pnl.primeCost.toFixed(2), pnl.costOfSales.total.toFixed(2));
  });

  test('the tax return agrees with the tax on the receipts', async () => {
    const r = await get('/reports/tax');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.difference, 0);
    assert.equal(r.json.agrees, true);
    assert.equal(r.json.outputTax.toFixed(2), r.json.checkedAgainstSales.toFixed(2));

    const band = r.json.bands.find((b) => b.code === 'GGST');
    assert.ok(band, 'the outlet trades under GGST');
    assert.equal(band.rate, ctx.taxRate);
    /* Prices are tax-INCLUSIVE and the tax is EXTRACTED as rate/(1+rate) of the
       inclusive figure — never rate × a base. The band is a sum of per-sale
       extractions, each rounded once, so re-extracting from the period total
       does NOT come back to the same laari and must not be asserted to: that is
       the "never re-gross off a rounded base" rule, and a test demanding exact
       equality here would be demanding the wrong arithmetic. What is true is
       that the drift is bounded by a laari per sale. */
    const inclusive = band.taxableValue + band.tax;
    const extracted = inclusive * (band.rate / (100 + band.rate));
    assert.ok(Math.abs(band.tax - extracted) <= 0.01 * band.sales,
      `band tax ${band.tax} drifts from ${extracted.toFixed(4)} by more than a laari a sale`);
  });

  test('the ledger cannot be knocked out of balance in the first place', async () => {
    /* Worth pinning before the cross-check below, because it says what the
       cross-check is FOR. Adding 10.00 to one side of a posted entry is refused
       at COMMIT by the deferred balance trigger — there is no way to write a
       lopsided journal through SQL, let alone through the app. */
    await assert.rejects(
      () => H.asOwner(ctx,
        "UPDATE journal_line SET cr = cr + 10 WHERE account_code = '2100'"
        + " AND id = (SELECT min(id) FROM journal_line WHERE account_code = '2100')"),
      /out of balance/);
  });

  test('the tax return NOTICES when the ledger and the receipts disagree', async () => {
    /* So a discrepancy can only arrive BALANCED — which is precisely why the
       return is cross-checked against the sales instead of trusting the trial
       balance. Here somebody posts a perfectly balanced manual journal that
       touches GST payable. Nothing about the ledger is wrong; the RETURN is,
       and the return has to be the thing that says so. */
    await H.asOwner(ctx,
      "WITH j AS (INSERT INTO journal (jv_no, entry_date, memo, source, posted_by)"
      + " VALUES ('TEST-JV-TAX', $1::date, 'a manual entry touching GST', 'manual', $2)"
      + ' RETURNING id)'
      + ' INSERT INTO journal_line (journal_id, account_code, dr, cr)'
      + " SELECT id, '1000', 10, 0 FROM j"
      + " UNION ALL SELECT id, '2100', 0, 10 FROM j", [ctx.today, ctx.staffId]);

    const r = await get('/reports/tax');
    assert.equal(r.json.agrees, false);
    assert.equal(r.json.difference.toFixed(2), '10.00',
      'the ledger holds 10.00 more GST than the receipts account for');

    // …and the trial balance still balances, which is the point: balanced is
    // not the same as right, and only the cross-check can tell them apart.
    assert.equal((await get('/reports/trial-balance')).json.balanced, true);

    await H.asOwner(ctx, "DELETE FROM journal WHERE jv_no = 'TEST-JV-TAX'");
    assert.equal((await get('/reports/tax')).json.agrees, true);
  });

  /* ── the Z-read: three statements of one day ──────────────────────────── */

  test('the Z-read ties the tickets, the tender and the ledger together', async () => {
    const z = (await get(`/reports/zread?date=${ctx.today}`)).json;

    assert.ok(z.sales.tickets >= 4, 'the four sales above are on it');
    assert.equal(z.sales.average.toFixed(2), (z.sales.total / z.sales.tickets).toFixed(2));

    for (const check of z.checks) {
      assert.equal(check.ok, true, check.name + ' — off by ' + check.difference);
    }

    const taken = z.tender.reduce((a, t) => a + t.amount, 0);
    assert.equal(taken.toFixed(2), z.sales.total.toFixed(2));
    assert.ok(z.tender.some((t) => t.method === 'cash'));
    assert.ok(z.tender.some((t) => t.method === 'card'));
  });

  test("the Z-read's drawer section is the day's counting, over/short and all", async () => {
    const z = (await get(`/reports/zread?date=${ctx.today}`)).json;
    assert.equal(z.drawer.sessions.length, 3, 'three registers were worked today');
    assert.equal(z.drawer.unclosed, 0);
    // −37.50 short, +12.00 over, 0.00 exact.
    assert.equal(z.drawer.variance.toFixed(2), '-25.50');
    assert.equal(z.drawer.counted.toFixed(2),
      (z.drawer.expected + z.drawer.variance).toFixed(2));
  });

  test('an unclosed register is REPORTED, not quietly left out', async () => {
    await op('drawer_open', { float: 300 });
    const z = (await get(`/reports/zread?date=${ctx.today}`)).json;
    assert.equal(z.drawer.unclosed, 1);
    const check = z.checks.find((c) => /counted and closed/.test(c.name));
    assert.equal(check.ok, false, 'the sheet refuses to say the day is closed');
    await op('drawer_close', { counted: 300 });
  });

  test('the Z-read, the P&L and the tax return agree with each other', async () => {
    /* §22's acceptance criterion, for one day rather than a month — the same
       arithmetic over the same rows is the only reason they can agree. */
    const [z, pnl, tax] = await Promise.all([
      get(`/reports/zread?date=${ctx.today}`).then((r) => r.json),
      get(`/reports/pnl?from=${ctx.today}&to=${ctx.today}`).then((r) => r.json),
      get(`/reports/tax?from=${ctx.today}&to=${ctx.today}`).then((r) => r.json),
    ]);

    // The Z-read's goods, net of tax and after discount, is the P&L's revenue.
    assert.equal(pnl.revenue.total.toFixed(2),
      (z.sales.gross - z.sales.discount).toFixed(2));
    // The Z-read's tax is the return's output tax.
    assert.equal(tax.outputTax.toFixed(2), z.sales.tax.toFixed(2));
    // And the day's COGS is the P&L's cost of sales, less any stock variance
    // (wastage and counts are cost of sales too, but they are not on a ticket).
    const stockVariance = pnl.costOfSales.lines.find((l) => l.code === '5100');
    assert.equal((pnl.costOfSales.total - (stockVariance?.balance || 0)).toFixed(2),
      z.sales.cogs.toFixed(2));
  });

  test('a day with no trading reports zeroes rather than failing', async () => {
    const z = (await get('/reports/zread?date=2019-02-11')).json;
    assert.equal(z.sales.tickets, 0);
    assert.equal(z.sales.total, 0);
    assert.equal(z.sales.average, 0);
    assert.equal(z.drawer.sessions.length, 0);
    assert.ok(z.checks.every((c) => c.ok), 'a day with nothing on it is in balance');
  });

  /* ── rank and range ───────────────────────────────────────────────────── */

  test('a cashier cannot read the reports', async () => {
    for (const p of ['/reports/zread', '/reports/pnl', '/reports/tax', '/reports/trial-balance']) {
      assert.equal((await get(p, ctx.token)).status, 403, p);
    }
  });

  test('a cashier CAN see the drawer they are working', async () => {
    assert.equal((await get('/drawer', ctx.token)).status, 200);
  });

  test('a malformed range is refused rather than guessed at', async () => {
    assert.equal((await get('/reports/pnl?from=last-tuesday')).status, 400);
    assert.equal((await get('/reports/pnl?from=2026-03-01&to=2026-02-01')).status, 400);
    assert.equal((await get('/reports/zread?date=soon')).status, 400);
  });

  test('a range that predates the outlet is empty, not an error', async () => {
    const r = await get('/reports/pnl?from=2019-01-01&to=2019-01-31');
    assert.equal(r.status, 200);
    assert.equal(r.json.revenue.total, 0);
    assert.equal(r.json.netProfit, 0);
    assert.equal(r.json.grossMarginPct, null, 'no margin on no revenue, rather than a 0%');
  });
});
