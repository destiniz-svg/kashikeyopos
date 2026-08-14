'use strict';
/* Payroll & Pension — §2 (`payroll`), 08-BUILD-STAGES §19.
 *
 * The link that makes PRIME COST true: reports.js has been flagging
 * `labourPosted: false` since the Reports phase because nothing had ever posted
 * a wage. The last assertion in this file is that the flag flips and the figure
 * moves — that is the whole reason this module exists.
 *
 * The rest is about the two-act structure. Payroll is the one calculation where
 * the inputs are routinely wrong (somebody forgot to clock out) and the output
 * is somebody's wages, so a draft that posts nothing has to exist and a posted
 * run has to be irreversible.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('payroll and pension', () => {
  let ctx, admin, mgr, alice, bob, draftId;
  const FROM = '2026-03-01', TO = '2026-03-15';

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);

    // 7% each way — the Maldives statutory figure, stated by the operator
    // rather than assumed by the code.
    await H.asOwner(ctx, 'UPDATE chain.outlet SET pension_employee_bp = 700,'
      + ' pension_employer_bp = 700 WHERE id = $1', [ctx.outletId]);

    const a = await H.q(ctx, "SELECT id FROM chain.staff WHERE name = 'Duty Manager'");
    alice = a.rows[0].id;
    const b = await H.q(ctx, "SELECT id FROM chain.staff WHERE name = 'Test Cashier'");
    bob = b.rows[0].id;

    /* Two closed shifts inside the period for the cashier — 10 hours — and one
       for the manager, who is on a monthly rate and paid regardless. */
    await H.asOwner(ctx,
      "INSERT INTO shift (staff_id, in_at, out_at) VALUES"
      + " ($1, '2026-03-02 08:00+00', '2026-03-02 14:00+00'),"
      + " ($1, '2026-03-03 08:00+00', '2026-03-03 12:00+00')", [bob]);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);

  /* ── rank ─────────────────────────────────────────────────────────────── */

  test('payroll is admin-only, top to bottom', async () => {
    for (const [m, p] of [['GET', '/payroll'], ['PUT', '/payroll/rates'],
      ['POST', '/payroll/draft']]) {
      const body = m === 'GET' ? undefined : {};
      assert.equal((await req(m, p, body, mgr.token)).status, 403, m + ' ' + p);
    }
    assert.equal((await get('/payroll', ctx.token)).status, 403);
  });

  /* ── rates ────────────────────────────────────────────────────────────── */

  test('a rate is effective-dated, and a rise does not restate the past', async () => {
    await req('PUT', '/payroll/rates',
      { staffId: bob, kind: 'hourly', amount: 50, effectiveFrom: '2026-01-01' });
    await req('PUT', '/payroll/rates',
      { staffId: bob, kind: 'hourly', amount: 80, effectiveFrom: '2026-06-01' });

    const list = (await get('/payroll')).json.rates.filter((r) => r.staffId === bob);
    assert.equal(list.length, 2);
    assert.equal(list[0].amount, 80, 'newest first');
    assert.equal(list[1].amount, 50);
  });

  test('a second rate from the SAME date corrects it rather than duplicating it', async () => {
    /* Two rows for one date make "the rate in force" ambiguous, and the run
       would silently pick whichever the index returned first. */
    await req('PUT', '/payroll/rates',
      { staffId: alice, kind: 'monthly', amount: 20000, effectiveFrom: '2026-01-01' });
    await req('PUT', '/payroll/rates',
      { staffId: alice, kind: 'monthly', amount: 24000, effectiveFrom: '2026-01-01' });
    const list = (await get('/payroll')).json.rates.filter((r) => r.staffId === alice);
    assert.equal(list.length, 1);
    assert.equal(list[0].amount, 24000);
  });

  test('a negative rate is refused', async () => {
    const r = await req('PUT', '/payroll/rates', { staffId: bob, kind: 'hourly', amount: -5 });
    assert.equal(r.status, 400);
  });

  /* ── the draft ────────────────────────────────────────────────────────── */

  test('a draft reads the CLOCK — nobody retypes a timesheet', async () => {
    const r = await req('POST', '/payroll/draft', { from: FROM, to: TO });
    assert.equal(r.status, 201, r.text);
    draftId = r.json.runId;
    assert.equal(r.json.status, 'draft');

    const line = r.json.lines.find((l) => l.staffId === bob);
    assert.ok(line, 'the cashier is on the run');
    assert.equal(line.hours, 10, 'six hours plus four, straight off the clock');
    assert.equal(line.shifts, 2);
    assert.equal(line.rate, 50, 'the rate in force in MARCH, not the June one');
    assert.equal(line.gross, 500);
  });

  test('pension is 7% each way, each rounded once from the gross', async () => {
    const r = await get('/payroll/' + draftId);
    const line = r.json.lines.find((l) => l.staffId === bob);
    assert.equal(line.employeePension, 35, '7% of 500');
    assert.equal(line.employerPension, 35);
    assert.equal(line.net, 465, 'gross less the employee half');
  });

  test('a monthly rate is prorated by the days in the period, not assumed to be 30', async () => {
    const r = await get('/payroll/' + draftId);
    const line = r.json.lines.find((l) => l.staffId === alice);
    assert.ok(line, 'a salaried manager who never clocks is still on the run');
    // 15 days of March's 31 → 24,000 × 15/31
    assert.equal(line.gross, Math.round(24000 * (15 / 31) * 100) / 100);
    assert.equal(line.hours, 0);
  });

  test('NOTHING has posted yet — a draft is arithmetic, not a liability', async () => {
    const j = await H.q(ctx,
      "SELECT count(*)::int AS n FROM journal WHERE source = 'payroll'");
    assert.equal(j.rows[0].n, 0);
    const tb = await get('/reports/trial-balance');
    assert.ok(!tb.json.accounts.some((a) => a.code === '6000' && a.dr > 0));
  });

  test('hours with NO RATE are reported, not paid at zero and not dropped', async () => {
    /* Both are ways of quietly not paying somebody, and dropping is worse
       because nothing on the run says they are missing. */
    const extra = await H.addStaff(ctx, 'Unrated Hand', 1);
    const id = (await H.q(ctx, "SELECT id FROM chain.staff WHERE name = 'Unrated Hand'"))
      .rows[0].id;
    await H.asOwner(ctx,
      "INSERT INTO shift (staff_id, in_at, out_at)"
      + " VALUES ($1, '2026-03-04 09:00+00', '2026-03-04 17:00+00')", [id]);

    const r = await req('POST', '/payroll/draft', { from: FROM, to: TO });
    draftId = r.json.runId;
    assert.ok(!r.json.lines.some((l) => l.staffId === id), 'not paid at a made-up zero');
    const flagged = r.json.unpaid.find((u) => u.staffId === id);
    assert.ok(flagged, 'but named on the run');
    assert.equal(flagged.hours, 8);
    assert.match(flagged.why, /no pay rate/);
    assert.ok(extra.token);
  });

  test('an OPEN shift is not paid, and is counted so somebody chases it', async () => {
    await H.asOwner(ctx,
      "INSERT INTO shift (staff_id, in_at) VALUES ($1, '2026-03-05 09:00+00')", [bob]);
    const r = await req('POST', '/payroll/draft', { from: FROM, to: TO });
    draftId = r.json.runId;
    assert.equal(r.json.openShifts, 1);
    assert.equal(r.json.lines.find((l) => l.staffId === bob).hours, 10,
      'a shift with no end has no hours');
    await H.asOwner(ctx, 'DELETE FROM shift WHERE out_at IS NULL');
  });

  test('recalculating replaces the draft rather than stacking another', async () => {
    const before = await H.q(ctx,
      "SELECT count(*)::int AS n FROM payroll_run WHERE status = 'draft'");
    const r = await req('POST', '/payroll/draft', { from: FROM, to: TO });
    draftId = r.json.runId;
    const after = await H.q(ctx,
      "SELECT count(*)::int AS n FROM payroll_run WHERE status = 'draft'");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  /* ── posting ──────────────────────────────────────────────────────────── */

  test('posting writes the journal, and it balances', async () => {
    const totals = (await get('/payroll/' + draftId)).json.run;
    const r = await req('POST', `/payroll/${draftId}/post`, {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'posted');

    const j = await H.q(ctx,
      'SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l'
      + " ON l.journal_id = j.id WHERE j.source = 'payroll' AND j.source_id = $1"
      + ' ORDER BY l.account_code', [draftId]);
    const by = Object.fromEntries(j.rows.map((x) => [x.account_code, x]));

    assert.equal(Number(by['6000'].dr).toFixed(2), totals.gross.toFixed(2), 'wages');
    assert.equal(Number(by['6010'].dr).toFixed(2), totals.employerPension.toFixed(2),
      'the employer half is an expense, not a deduction');
    assert.equal(Number(by['2300'].cr).toFixed(2), totals.net.toFixed(2), 'owed to the staff');
    assert.equal(Number(by['2310'].cr).toFixed(2),
      (totals.employeePension + totals.employerPension).toFixed(2),
      'owed to the pension office — a different party, so a different account');

    const dr = j.rows.reduce((a, x) => a + Number(x.dr), 0);
    const cr = j.rows.reduce((a, x) => a + Number(x.cr), 0);
    assert.equal(dr.toFixed(2), cr.toFixed(2));
    assert.equal((await get('/reports/trial-balance')).json.balanced, true);
  });

  test('a posted run cannot be posted again, or thrown away', async () => {
    assert.match((await req('POST', `/payroll/${draftId}/post`, {})).json.error,
      /already been posted/);
    assert.match((await req('DELETE', '/payroll/' + draftId, undefined)).json.error,
      /only a draft can be thrown away/);
  });

  test('the SAME PERIOD cannot be run twice — that would pay everybody twice', async () => {
    const r = await req('POST', '/payroll/draft', { from: FROM, to: TO });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /pay everybody twice/);
  });

  /* ── paying ───────────────────────────────────────────────────────────── */

  test('paying clears what is owed to the STAFF and leaves the pension outstanding', async () => {
    const before = (await get('/payroll/' + draftId)).json.run;
    const r = await req('POST', `/payroll/${draftId}/pay`, { method: 'bank' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'paid');

    const tb = await get('/reports/trial-balance');
    const payable = tb.json.accounts.find((a) => a.code === '2300');
    assert.equal(payable.balance.toFixed(2), '0.00', 'the staff have been paid');
    const pension = tb.json.accounts.find((a) => a.code === '2310');
    assert.ok(pension.balance > 0,
      'the pension is owed to somebody else on their own schedule — clearing it'
      + ' here would record a payment nobody made');
    assert.equal(before.net.toFixed(2), r.json.paid.toFixed(2));
  });

  test('a run cannot be paid before it is posted, or paid twice', async () => {
    const d = await req('POST', '/payroll/draft', { from: '2026-04-01', to: '2026-04-15' });
    assert.match((await req('POST', `/payroll/${d.json.runId}/pay`, {})).json.error,
      /post the run before paying/);
    assert.match((await req('POST', `/payroll/${draftId}/pay`, {})).json.error,
      /already been paid/);
    await req('DELETE', '/payroll/' + d.json.runId, undefined);
  });

  /* ── the point of the whole module ────────────────────────────────────── */

  test('PRIME COST is finally complete', async () => {
    /* reports.js has flagged labourPosted:false since the Reports phase. Prime
       cost without labour is not a low prime cost, it is an incomplete one. */
    const pnl = (await get('/reports/pnl')).json;
    assert.equal(pnl.labourPosted, true);
    const wages = pnl.operatingCosts.lines.find((l) => l.code === '6000');
    assert.ok(wages && wages.balance > 0);
    assert.equal(pnl.primeCost.toFixed(2),
      (pnl.costOfSales.total + wages.balance
        + (pnl.operatingCosts.lines.find((l) => l.code === '6010')?.balance || 0)).toFixed(2));
    assert.ok(pnl.primeCost > pnl.costOfSales.total, 'labour is in it now');
  });

  test('with no pension configured, nothing is deducted and nothing is owed', async () => {
    /* 10-NO-DEMO-DATA: a business that is not registered contributes nothing,
       and defaulting to 7% would invent a deduction from somebody's wages. */
    const fresh = await H.bootOutlet();
    const boss = await H.addStaff(fresh, 'Owner', 4);
    const who = (await H.q(fresh, "SELECT id FROM chain.staff WHERE name = 'Test Cashier'"))
      .rows[0].id;
    await H.req('PUT', `/api/outlet/${fresh.outletId}/payroll/rates`,
      { body: { staffId: who, kind: 'hourly', amount: 40, effectiveFrom: '2026-01-01' },
        token: boss.token });
    await H.asOwner(fresh,
      "INSERT INTO shift (staff_id, in_at, out_at)"
      + " VALUES ($1, '2026-03-02 08:00+00', '2026-03-02 13:00+00')", [who]);

    const r = await H.req('POST', `/api/outlet/${fresh.outletId}/payroll/draft`,
      { body: { from: FROM, to: TO }, token: boss.token });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.pension.configured, false);
    const line = r.json.lines.find((l) => l.staffId === who);
    assert.equal(line.gross, 200);
    assert.equal(line.employeePension, 0);
    assert.equal(line.net, 200, 'nobody had 7% taken from them by default');
  });

  test('a run with nobody on it will not post', async () => {
    const d = await req('POST', '/payroll/draft', { from: '2019-01-01', to: '2019-01-15' });
    assert.equal(d.json.lines.length, 0);
    const r = await req('POST', `/payroll/${d.json.runId}/post`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /nothing to pay/);
  });

  test('a malformed period is refused rather than guessed at', async () => {
    assert.equal((await req('POST', '/payroll/draft', { from: 'march', to: TO })).status, 400);
    assert.equal((await req('POST', '/payroll/draft', { from: TO, to: FROM })).status, 400);
    assert.equal((await get('/payroll/not-a-uuid')).status, 404);
    assert.equal((await get('/payroll/' + H.uuid())).status, 404);
  });
});
