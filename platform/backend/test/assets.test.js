'use strict';
/* Equipment & Maintenance — §2 (`assets`), 08-BUILD-STAGES §20.
 *
 * What this file is really about:
 *
 *   · An oven must not reach the P&L in one month. Capitalising is the whole
 *     point of the module, and the assertion is on the ledger, not on a screen.
 *   · Depreciation run twice in a month must charge the month once. The trial
 *     balance would balance either way, so no other test could catch it.
 *   · Net book value must land EXACTLY on the residual at the end of the life,
 *     not a few laari either side of it for ever.
 *   · A service that cost money must produce ONE expense row, visible from both
 *     the asset and the Operating Costs list — not two rows that disagree about
 *     what repairs cost.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const money = require('../src/assets');

describe('the asset register', () => {
  let ctx, mgr, admin, oven, fryer;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const bal = async (code) => {
    const r = await get('/reports/trial-balance');
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };

  /* ── buying one ───────────────────────────────────────────────────────── */

  test('an empty register says what it is for rather than nothing', async () => {
    const r = await get('/assets');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.assets, []);
    assert.equal(r.json.totals.count, 0);
    assert.equal(r.json.totals.netBook, 0);
    assert.deepEqual(r.json.overdue, []);
  });

  test('buying an oven CAPITALISES it — nothing reaches the P&L today', async () => {
    /* Entered as an operating cost, 60,000 would land in one month: that month
       reads as a catastrophe and the next five years read as better than they
       were. This is the assertion the whole module exists for. */
    const r = await req('POST', '/assets', {
      name: 'Combi oven', category: 'Kitchen', cost: 60000, lifeMonths: 60,
      residual: 0, acquiredOn: ctx.today, method: 'bank', serial: 'CO-99',
    });
    assert.equal(r.status, 201, r.text);
    oven = r.json.id;
    assert.equal(r.json.monthly, 1000);
    assert.match(r.json.message, /1000\.00 a month/);

    assert.equal((await bal('1500')).toFixed(2), '60000.00', 'on the balance sheet');
    assert.equal((await bal('6300')).toFixed(2), '0.00', 'and nothing in the P&L');
    assert.equal((await bal('1010')).toFixed(2), '-60000.00', 'the bank paid for it');
  });

  test('a residual at or above cost is refused — that is not an asset', async () => {
    const r = await req('POST', '/assets', {
      name: 'Nonsense', cost: 1000, lifeMonths: 12, residual: 1000,
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /less than what it cost/);
  });

  test('an absurd life is refused', async () => {
    const r = await req('POST', '/assets', { name: 'Forever', cost: 1000, lifeMonths: 0 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /1 to 600 months/);
  });

  test('the register shows what it is worth now, which nobody can do in their head',
    async () => {
      const r = await get('/assets');
      const a = r.json.assets.find((x) => x.id === oven);
      assert.equal(a.cost, 60000);
      assert.equal(a.netBook, 60000, 'nothing charged yet');
      assert.equal(a.monthsLeft, 60);
      assert.equal(r.json.totals.monthly, 1000, 'what the estate costs a month');
    });

  /* ── the monthly charge ───────────────────────────────────────────────── */

  test('a month of depreciation charges 6300 and credits 1510', async () => {
    const r = await req('POST', '/assets/depreciate', { period: ctx.today.slice(0, 7) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.charged.length, 1);
    assert.equal(r.json.charged[0].amount, 1000);
    assert.equal(r.json.total, 1000);

    assert.equal((await bal('6300')).toFixed(2), '1000.00');
    /* `balance` is signed the way the account's OWN side reads, so 1510 —
       declared cr, a contra-asset — shows its credit as a positive. It is 1500
       that must be untouched: depreciation never reduces what a thing cost. */
    assert.equal((await bal('1510')).toFixed(2), '1000.00');
    assert.equal((await bal('1500')).toFixed(2), '60000.00', 'cost is untouched');
  });

  test('running the month-end charge TWICE does not charge the month twice', async () => {
    /* Nothing downstream could catch this: the trial balance balances either
       way, because a duplicate is self-consistent. */
    const before = await bal('6300');
    const r = await req('POST', '/assets/depreciate', { period: ctx.today.slice(0, 7) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.charged.length, 0, 'nothing left to charge this month');
    assert.equal((await bal('6300')).toFixed(2), before.toFixed(2));
  });

  test('net book value falls by exactly what was charged', async () => {
    const a = (await get('/assets')).json.assets.find((x) => x.id === oven);
    assert.equal(a.accumulated, 1000);
    assert.equal(a.netBook, 59000);
    assert.equal(a.depreciatedMonths, 1);
    assert.equal(a.monthsLeft, 59);
  });

  test('an asset bought after the period is not depreciated for it', async () => {
    /* A fryer bought today has not been earning anything last January. */
    const past = '2025-01';
    const r = await req('POST', '/assets/depreciate', { period: past });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.charged.length, 0);
  });

  /* ── the remainder, which is where the laari go missing ───────────────── */

  test('the LAST month takes the remainder so net book lands ON the residual',
    async () => {
      /* 1,000 over 3 months is 333.33 + 333.33 + 333.34. Three equal roundings
         leave a few laari of net book value stranded for ever, and an asset
         that never quite reaches its residual is one somebody has to explain at
         every year end. */
      const r = await req('POST', '/assets', {
        name: 'Blender', cost: 1000, lifeMonths: 3, residual: 0,
        acquiredOn: ctx.today, method: 'cash',
      });
      assert.equal(r.status, 201, r.text);
      const id = r.json.id;

      const start = new Date(ctx.today + 'T00:00:00Z');
      for (let i = 1; i <= 3; i++) {
        const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
        const p = await req('POST', '/assets/depreciate', { period: d.toISOString().slice(0, 7) });
        assert.equal(p.status, 200, p.text);
      }
      const a = (await get('/assets')).json.assets.find((x) => x.id === id);
      assert.equal(a.netBook, 0, '333.33 + 333.33 + 333.34, not 999.99');
      assert.equal(a.accumulated, 1000);
      assert.equal(a.fullyDepreciated, true);
      assert.equal(a.monthly, 0, 'and it costs nothing more from here');
    });

  test('a fully depreciated asset stops charging rather than going negative',
    async () => {
      const start = new Date(ctx.today + 'T00:00:00Z');
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 4, 1));
      const r = await req('POST', '/assets/depreciate', { period: d.toISOString().slice(0, 7) });
      assert.equal(r.status, 200, r.text);
      assert.ok(!r.json.charged.some((c) => c.name === 'Blender'),
        'the blender is finished and stays finished');
    });

  test('a residual is not depreciated away', async () => {
    const r = await req('POST', '/assets', {
      name: 'Delivery bike', cost: 30000, lifeMonths: 2, residual: 10000,
      acquiredOn: ctx.today, method: 'cash',
    });
    fryer = r.json.id;                       // reused below for disposal
    assert.equal(r.json.monthly, 10000, '(30,000 − 10,000) ÷ 2');

    const start = new Date(ctx.today + 'T00:00:00Z');
    for (let i = 5; i <= 6; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      await req('POST', '/assets/depreciate', { period: d.toISOString().slice(0, 7) });
    }
    const a = (await get('/assets')).json.assets.find((x) => x.id === fryer);
    assert.equal(a.netBook, 10000, 'it stops at what it will be worth, not at nought');
    assert.equal(a.fullyDepreciated, true);
  });

  /* ── disposal ─────────────────────────────────────────────────────────── */

  test('selling below net book is a LOSS on 6310, never a sale', async () => {
    const r = await req('POST', `/assets/${fryer}/dispose`, {
      on: ctx.today, proceeds: 6000, method: 'bank',
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.netBook, 10000);
    assert.equal(r.json.result, -4000);
    assert.match(r.json.message, /loss of 4000\.00/);

    assert.equal((await bal('6310')).toFixed(2), '4000.00', 'a loss is an expense');
    const sales = await bal('4000');
    assert.equal(sales.toFixed(2), '0.00', 'and it never touches the sales line');
  });

  test('the disposed asset leaves the balance sheet entirely', async () => {
    const r = await get('/assets');
    assert.ok(!r.json.assets.some((a) => a.id === fryer), 'gone from the live register');
    const withDisposed = await get('/assets?disposed=1');
    const d = withDisposed.json.assets.find((a) => a.id === fryer);
    assert.equal(d.status, 'disposed');
    assert.equal(d.proceeds, 6000);
  });

  test('disposing of it twice is refused', async () => {
    const r = await req('POST', `/assets/${fryer}/dispose`, { proceeds: 1 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already gone/);
  });

  test('selling above net book is a GAIN, credited to 6310 and still not sales',
    async () => {
      const buy = await req('POST', '/assets', {
        name: 'Spare freezer', cost: 5000, lifeMonths: 12, residual: 0,
        acquiredOn: ctx.today, method: 'cash',
      });
      const before6310 = await bal('6310');
      const r = await req('POST', `/assets/${buy.json.id}/dispose`, {
        on: ctx.today, proceeds: 7000, method: 'bank',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.result, 2000);
      assert.match(r.json.message, /gain of 2000\.00/);
      assert.equal((await bal('6310')).toFixed(2), (before6310 - 2000).toFixed(2),
        'a gain reads as a negative expense');
      assert.equal((await bal('4000')).toFixed(2), '0.00');
    });

  test('scrapping for nothing writes off what is left', async () => {
    const buy = await req('POST', '/assets', {
      name: 'Broken mixer', cost: 800, lifeMonths: 24, residual: 0,
      acquiredOn: ctx.today, method: 'cash',
    });
    const before = await bal('6310');
    const r = await req('POST', `/assets/${buy.json.id}/dispose`, { on: ctx.today, proceeds: 0 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.result, -800);
    assert.equal((await bal('6310')).toFixed(2), (before + 800).toFixed(2));
  });

  /* ── maintenance ──────────────────────────────────────────────────────── */

  test('an overdue service is reported as an operations fact', async () => {
    /* A grease trap nobody serviced is how a kitchen fails an inspection, and
       it is worth saying before it is a money problem. */
    const past = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const r = await req('POST', '/assets/services', {
      assetId: oven, kind: 'service', dueOn: past, everyDays: 90,
      note: 'Annual gas check',
    }, mgr.token);
    assert.equal(r.status, 201, r.text);

    const list = await get('/assets', mgr.token);
    assert.equal(list.json.overdue.length, 1);
    assert.equal(list.json.overdue[0].name, 'Combi oven');
    assert.ok(list.json.overdue[0].daysLate >= 39);
    const a = list.json.assets.find((x) => x.id === oven);
    assert.equal(a.nextService.overdue, true);
  });

  test('a service that cost money books ONE expense, on the operating costs list',
    async () => {
      /* Two tables would mean two places to type the same repair and two
         answers to what repairs cost this month. */
      const list = await get('/assets', mgr.token);
      const svc = list.json.overdue[0].serviceId;
      const r = await req('POST', `/assets/services/${svc}/done`, {
        doneOn: ctx.today, cost: 850, method: 'cash',
      }, mgr.token);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.expenseId, 'it points at the expense it created');
      assert.match(r.json.message, /6190 Repairs/);

      const costs = await get('/opcosts', mgr.token);
      const rows = costs.json.expenses.filter((e) => e.account === '6190');
      assert.equal(rows.length, 1, 'exactly one, not one per screen');
      assert.equal(rows[0].id, r.json.expenseId);
      assert.equal(rows[0].amount, 850);
      assert.match(rows[0].note, /Combi oven/);
      assert.equal((await bal('6190')).toFixed(2), '850.00');
    });

  test('completing a repeating service schedules the next one', async () => {
    /* The moment a recurring job is most likely to be forgotten is the moment
       somebody has just finished it. */
    const a = (await get('/assets', mgr.token)).json.assets.find((x) => x.id === oven);
    assert.ok(a.nextService, 'there is another one waiting');
    assert.equal(a.nextService.overdue, false);
    const done = a.services.find((s) => s.doneOn);
    assert.ok(done.expenseId);
  });

  test('a service cannot be completed twice', async () => {
    const a = (await get('/assets', mgr.token)).json.assets.find((x) => x.id === oven);
    const done = a.services.find((s) => s.doneOn);
    const r = await req('POST', `/assets/services/${done.id}/done`, { cost: 100 }, mgr.token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already done/);
  });

  test('a job booked against the wrong machine is dropped; a completed one is not',
    async () => {
      const a = (await get('/assets', mgr.token)).json.assets.find((x) => x.id === oven);
      const waiting = a.services.find((s) => !s.doneOn);
      const drop = await req('DELETE', `/assets/services/${waiting.id}`, undefined, mgr.token);
      assert.equal(drop.status, 200, drop.text);

      const done = (await get('/assets', mgr.token)).json.assets
        .find((x) => x.id === oven).services.find((s) => s.doneOn);
      const no = await req('DELETE', `/assets/services/${done.id}`, undefined, mgr.token);
      assert.equal(no.status, 404, 'a record of money spent is not tidied away');
    });

  test('a service cannot be scheduled on an asset that has gone', async () => {
    const r = await req('POST', '/assets/services', {
      assetId: fryer, dueOn: ctx.today,
    }, mgr.token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /nothing left to service/);
  });

  /* ── who may do what ──────────────────────────────────────────────────── */

  test('a manager reads the register and closes a service but cannot buy or dispose',
    async () => {
      assert.equal((await get('/assets', mgr.token)).status, 200);
      const buy = await req('POST', '/assets',
        { name: 'Ice machine', cost: 20000, lifeMonths: 36 }, mgr.token);
      assert.equal(buy.status, 403, 'capitalising shapes the P&L for years');
      const dep = await req('POST', '/assets/depreciate', { period: '2026-01' }, mgr.token);
      assert.equal(dep.status, 403);
      const dis = await req('POST', `/assets/${oven}/dispose`, { proceeds: 1 }, mgr.token);
      assert.equal(dis.status, 403);
    });

  test('a cashier reaches none of it', async () => {
    assert.equal((await get('/assets', ctx.token)).status, 403);
    assert.equal((await req('POST', '/assets/services', {}, ctx.token)).status, 403);
  });

  /* ── the ledger, after all of that ────────────────────────────────────── */

  test('every asset journal is reachable from the asset itself', async () => {
    const r = await get(`/assets/${oven}/history`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.entries.length >= 4, 'the purchase and each charge');
    assert.ok(r.json.entries.some((e) => e.account === '1500' && e.dr === 60000));
    assert.ok(r.json.entries.some((e) => e.account === '6300'));
    for (const e of r.json.entries) assert.ok(e.jvNo, 'each one has a document number');
  });

  test('the trial balance still balances', async () => {
    const r = await get('/reports/trial-balance');
    assert.equal(r.json.totals.difference, 0, JSON.stringify(r.json.totals));
  });

  test('the arithmetic itself, without a database in the way', () => {
    /* The remainder rule is the one piece of arithmetic here that is easy to
       write plausibly and wrongly, so it is also checked directly. */
    const { slice, accumulated } = money;
    assert.equal(slice(100000, 0, 3, 0), 33333);
    assert.equal(slice(100000, 0, 3, 1), 33333);
    assert.equal(slice(100000, 0, 3, 2), 33334, 'the last one takes the remainder');
    assert.equal(slice(100000, 0, 3, 3), 0, 'and there is no fourth');
    assert.equal(accumulated(100000, 0, 3, 3), 100000);
    assert.equal(accumulated(100000, 20000, 3, 3), 80000, 'the residual survives');
    assert.equal(accumulated(100000, 0, 3, 0), 0);
  });
});
