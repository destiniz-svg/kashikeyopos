'use strict';
/* Operating Costs — §2 (`opcosts`), 08-BUILD-STAGES §18.
 *
 * Two things this file is really about:
 *
 *   · The categories this screen REFUSES. An expense screen that accepted a
 *     wage would double-count payroll and nothing downstream would say so — the
 *     trial balance still balances, because a duplicate is self-consistent.
 *   · The spread cost. An annual licence paid in January is a twelfth of
 *     January's cost, twelve times. Charged where it was paid, January reads as
 *     a disaster and the other eleven read better than they were.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/** n consecutive 'YYYY-MM' periods starting with the one `day` falls in. */
function monthsFrom(day, n) {
  const [y, m] = day.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

describe('operating costs', () => {
  let ctx, mgr, admin, scheduleId;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const bal = async (code) => {
    const r = await get('/reports/trial-balance', admin.token);
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };

  /* ── the categories, and the ones it refuses ──────────────────────────── */

  test('the categories split into what you enter and what another module posts', async () => {
    const r = await get('/opcosts');
    assert.equal(r.status, 200, r.text);
    const enterable = r.json.categories.enterable.map((x) => x.code);
    const elsewhere = r.json.categories.elsewhere;

    assert.ok(enterable.includes('6100'), 'rent is entered here');
    assert.ok(enterable.includes('6110'), 'so is electricity');
    assert.ok(!enterable.includes('6000'), 'wages are not');
    assert.ok(!enterable.includes('5000'), 'nor is cost of sales');

    const wages = elsewhere.find((x) => x.code === '6000');
    assert.ok(wages, 'and it says where they DO come from');
    assert.match(wages.postedBy, /payroll run/);
  });

  test('entering a wage here is REFUSED, because it would count it twice', async () => {
    /* Nothing downstream would catch it — the trial balance still balances,
       because a duplicate is self-consistent. */
    const r = await req('POST', '/opcosts', { account: '6000', amount: 5000 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /payroll run/);
    assert.match(r.json.error, /count it twice/);
  });

  test('an account that is not an expense at all is refused', async () => {
    assert.equal((await req('POST', '/opcosts', { account: '1000', amount: 10 })).status, 404);
    assert.equal((await req('POST', '/opcosts', { account: 'NOPE', amount: 10 })).status, 404);
  });

  /* ── an ordinary cost ─────────────────────────────────────────────────── */

  test('a cost on credit debits its category and owes the money', async () => {
    const r = await req('POST', '/opcosts',
      { account: '6110', amount: 1200, spentOn: ctx.today, note: 'STELCO, March', method: 'credit' });
    assert.equal(r.status, 201, r.text);

    assert.equal((await bal('6110')).toFixed(2), '1200.00');
    assert.equal((await bal('2000')).toFixed(2), '1200.00', 'and it is owed');
    assert.equal((await get('/reports/trial-balance', admin.token)).json.balanced, true);
  });

  test('a cost paid from the bank takes the money instead of owing it', async () => {
    const before = await bal('1010');
    await req('POST', '/opcosts',
      { account: '6120', amount: 300, spentOn: ctx.today, method: 'bank' });
    assert.equal((await bal('6120')).toFixed(2), '300.00');
    assert.equal((await bal('1010')).toFixed(2), (before - 300).toFixed(2));
  });

  test('it lands in the P&L under operating costs, not cost of sales', async () => {
    const pnl = (await get('/reports/pnl', admin.token)).json;
    const power = pnl.operatingCosts.lines.find((l) => l.code === '6110');
    assert.ok(power, 'electricity is an operating cost');
    assert.equal(power.balance.toFixed(2), '1200.00');
    assert.ok(!pnl.costOfSales.lines.some((l) => l.code === '6110'));
  });

  /* ── the spread cost, which is the overhead allocation ────────────────── */

  test('a SPREAD cost capitalises to 1200 and charges nothing yet', async () => {
    /* An annual licence paid in January is not January's cost. */
    const r = await req('POST', '/opcosts', {
      account: '6200', amount: 12000, spentOn: ctx.today, method: 'bank', spreadMonths: 12,
    });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.message, /released over 12 months/);

    assert.equal((await bal('1200')).toFixed(2), '12000.00', 'held as prepaid');
    assert.equal((await bal('6200')).toFixed(2), '0.00',
      'and charged to no month yet — this is the whole point');
  });

  test('releasing a month moves a twelfth, not the lot', async () => {
    const r = await req('POST', '/opcosts/release', { period: ctx.today.slice(0, 7) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.released.length, 1);
    assert.equal(r.json.released[0].amount, 1000);
    assert.equal(r.json.released[0].month, 1);
    assert.equal(r.json.released[0].of, 12);

    assert.equal((await bal('6200')).toFixed(2), '1000.00');
    assert.equal((await bal('1200')).toFixed(2), '11000.00');
  });

  test('running the month-end release twice does NOT charge the month twice', async () => {
    /* The failure this guards against is invisible downstream: a duplicate
       allocation is self-consistent, so the trial balance goes on balancing and
       the month simply reads worse than it was. */
    const before = await bal('6200');
    const again = await req('POST', '/opcosts/release', { period: ctx.today.slice(0, 7) });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.released.length, 0, 'nothing left to release this month');
    assert.equal((await bal('6200')).toFixed(2), before.toFixed(2));
  });

  test('the LAST slice takes the remainder so nothing is stranded', async () => {
    /* Three equal roundings of an amount that does not divide by three leave a
       few laari on 1200 for ever. */
    const odd = await req('POST', '/opcosts', {
      account: '6150', amount: 100, spentOn: ctx.today, method: 'bank', spreadMonths: 3,
    });
    assert.equal(odd.status, 201);
    // Three SEPARATE periods — one period gets one slice, by design.
    for (const period of monthsFrom(ctx.today, 3)) {
      const r = await req('POST', '/opcosts/release', { period });
      assert.equal(r.status, 200, r.text);
    }
    assert.equal((await bal('6150')).toFixed(2), '100.00',
      '33.33 + 33.33 + 33.34 — the whole amount, not 99.99');
    const row = (await get('/opcosts')).json.expenses.find((e) => e.id === odd.json.id);
    assert.equal(row.stillPrepaid, 0);
  });

  test('a spread cost is not added up as if it were this period\'s', async () => {
    const list = (await get('/opcosts')).json;
    const licence = list.expenses.find((e) => e.account === '6200');
    assert.equal(licence.amount, 12000, 'what was paid');
    assert.equal(licence.thisPeriod, 1000, 'what this period bears');
    assert.ok(licence.stillPrepaid > 0);
    // The category summary uses the period figure, not the payment.
    const cat = list.byCategory.find((x) => x.account === '6200');
    assert.equal(cat.total, 1000);
  });

  test('an absurd spread is refused', async () => {
    assert.equal((await req('POST', '/opcosts',
      { account: '6100', amount: 10, spreadMonths: 1 })).status, 400);
    assert.equal((await req('POST', '/opcosts',
      { account: '6100', amount: 10, spreadMonths: 600 })).status, 400);
  });

  /* ── recurring ────────────────────────────────────────────────────────── */

  test('setting up a schedule is ADMIN — it keeps charging after everyone forgets', async () => {
    const asMgr = await req('POST', '/opcosts/recurring',
      { account: '6100', amount: 20000, cadence: 'monthly', dueDay: 1 });
    assert.equal(asMgr.status, 403);

    const r = await req('POST', '/opcosts/recurring', {
      account: '6100', amount: 20000, cadence: 'monthly', dueDay: 1,
      startsOn: '2026-01-01', note: 'shop rent', method: 'bank',
    }, admin.token);
    assert.equal(r.status, 201, r.text);
    scheduleId = r.json.id;
  });

  test('what is due is computed FROM THE SCHEDULE, not from a diary', async () => {
    /* Rent falls due on the first whether or not anybody opened this screen. */
    const r = await get('/opcosts?to=2026-04-15');
    const rent = r.json.due.filter((d) => d.recurringId === scheduleId);
    assert.equal(rent.length, 4, 'January, February, March and April');
    assert.deepEqual(rent.map((x) => x.periodKey),
      ['2026-01', '2026-02', '2026-03', '2026-04']);
    assert.equal(rent[0].dueOn, '2026-01-01');
    assert.ok(rent[0].daysLate > 0, 'and it says how late it is');
  });

  test('a monthly 31st falls on the last day of a short month, not into the next', async () => {
    const r = await req('POST', '/opcosts/recurring', {
      account: '6150', amount: 500, cadence: 'monthly', dueDay: 31,
      startsOn: '2026-02-01',
    }, admin.token);
    const due = (await get('/opcosts?to=2026-03-05')).json.due
      .filter((d) => d.recurringId === r.json.id);
    assert.equal(due[0].dueOn, '2026-02-28');
    await req('DELETE', '/opcosts/recurring/' + r.json.id, undefined, admin.token);
  });

  test('posting a due period charges it once, however many times you press', async () => {
    const first = await req('POST', '/opcosts', {
      account: '6100', amount: 20000, spentOn: '2026-01-01', method: 'bank',
      recurringId: scheduleId, periodKey: '2026-01', note: 'shop rent',
    });
    assert.equal(first.status, 201, first.text);

    const again = await req('POST', '/opcosts', {
      account: '6100', amount: 20000, spentOn: '2026-01-01', method: 'bank',
      recurringId: scheduleId, periodKey: '2026-01',
    });
    assert.equal(again.json.already, true, 'idempotent on (schedule, period)');

    assert.equal((await bal('6100')).toFixed(2), '20000.00', 'charged once, not twice');
  });

  test('a posted period drops off the due list', async () => {
    const due = (await get('/opcosts?to=2026-04-15')).json.due
      .filter((d) => d.recurringId === scheduleId);
    assert.ok(!due.some((d) => d.periodKey === '2026-01'));
    assert.equal(due.length, 3);
  });

  test('the annualised figure lets two cadences be compared', async () => {
    /* A weekly 500 and a monthly 2,000 are not the same cost, and a list that
       shows only the amounts makes them look it. */
    await req('POST', '/opcosts/recurring', {
      account: '6160', amount: 500, cadence: 'weekly', dueDay: 1, startsOn: '2026-01-01',
    }, admin.token);
    const s = (await get('/opcosts')).json.schedules;
    const weekly = s.find((x) => x.account === '6160');
    const monthly = s.find((x) => x.account === '6100');
    assert.equal(weekly.annualised, 26000);
    assert.equal(monthly.annualised, 240000);
  });

  test('a stopped schedule stops being due', async () => {
    await req('DELETE', '/opcosts/recurring/' + scheduleId, undefined, admin.token);
    const due = (await get('/opcosts?to=2026-04-15')).json.due
      .filter((d) => d.recurringId === scheduleId);
    assert.equal(due.length, 0);
  });

  test('a bad due day for the cadence is refused with the right bound', async () => {
    const r = await req('POST', '/opcosts/recurring',
      { account: '6100', amount: 10, cadence: 'weekly', dueDay: 20 }, admin.token);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /1 to 7 for a weekly/);
  });

  /* ── rank and shape ───────────────────────────────────────────────────── */

  test('a cashier reaches none of it', async () => {
    assert.equal((await get('/opcosts', ctx.token)).status, 403);
    assert.equal((await req('POST', '/opcosts',
      { account: '6100', amount: 1 }, ctx.token)).status, 403);
  });

  test('the trial balance still balances after all of that', async () => {
    const tb = await get('/reports/trial-balance', admin.token);
    assert.equal(tb.json.balanced, true);
    assert.equal(tb.json.totals.difference, 0);
  });

  test('a fresh outlet has no costs and says so rather than failing', async () => {
    const fresh = await H.bootOutlet();
    const boss = await H.addStaff(fresh, 'Manager', 3);
    const r = await H.req('GET', `/api/outlet/${fresh.outletId}/opcosts`, { token: boss.token });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.expenses, []);
    assert.deepEqual(r.json.schedules, []);
    assert.deepEqual(r.json.due, []);
    assert.equal(r.json.total, 0);
    assert.ok(r.json.categories.enterable.length >= 10, 'the categories are still there');
  });
});
