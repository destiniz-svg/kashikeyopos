'use strict';
/* Loyalty & Rewards — §2 (`loyalty`), 08-BUILD-STAGES §24.
 *
 * What this file is really about:
 *
 *   · A POINT IS A LIABILITY, NOT A DISCOUNT. Earning credits 2200 and does not
 *     touch the sale; redeeming debits 2200 and does not touch income. The P&L
 *     sees the cost when it is incurred, once.
 *   · NO SCHEME UNTIL SOMEBODY SETS ONE. A default earn rate would have every
 *     restaurant accruing a liability nobody agreed to.
 *   · The points ledger and account 2200 must agree, and the tests say what
 *     "agree" means in a chain where the two need not be at the same outlet.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const loyalty = require('../src/loyalty');

describe('loyalty', () => {
  let ctx, mgr, admin, member;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
    /* The scheme is CHAIN-WIDE configuration in a single row, so a fresh test
       outlet inherits whatever the last run left behind — which is the design
       working, not a leak. Reset it so "the scheme is off" means something. */
    await H.req('POST', `/api/outlet/${ctx.outletId}/loyalty/config`,
      { body: { earnPerMvr: 0, pointValue: 0, tiers: [] }, token: admin.token });
    // The catalogue is chain-wide too, for the same reason and with the same
    // consequence for a test that expects an empty one.
    const had = await H.req('GET', `/api/outlet/${ctx.outletId}/loyalty`,
      { token: admin.token });
    for (const rw of (had.json?.rewards || [])) {
      await H.req('DELETE', `/api/outlet/${ctx.outletId}/loyalty/rewards/${rw.id}`,
        { token: admin.token });
    }
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const bal = async (code) => {
    const r = await get('/reports/trial-balance');
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };
  const num = (n) => String(8000000 + (ctx.outletId % 90000) * 10 + n);
  const bill = (qty) => H.priceIt(ctx, [['BURGER', qty]]);
  const sell = (payments, memberId) => H.push(ctx, [{
    opId: H.uuid(), kind: 'sale', at: Date.now(),
    payload: {
      businessDate: ctx.today, channel: 'dine_in', covers: 1,
      lines: [{ itemId: 'BURGER', qty: 1 }], payments, memberId,
    },
  }]);
  const one = () => (bill(1).total / 100).toFixed(2);

  /* ── nothing until somebody says so ───────────────────────────────────── */

  test('the scheme is OFF until an admin sets a rate, and says so', async () => {
    const r = await get('/loyalty', ctx.token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.config.running, false);
    assert.equal(r.json.config.earnPerMvr, 0);
    assert.equal(r.json.config.pointValue, 0);
    assert.deepEqual(r.json.ladder, [], 'and no ladder to stand on');
    /* This outlet has issued nothing. `outstanding` is chain-wide and may not
       be nought — see the reconciliation test below, which is where that
       distinction is nailed down. */
    assert.equal(r.json.hereEarned, 0);
    assert.equal(r.json.hereRedeemed, 0);
  });

  test('a sale to a member with the scheme off accrues NOTHING', async () => {
    /* A default earn rate would have every restaurant that installed this
       quietly accruing a liability nobody agreed to. */
    const c = await req('POST', '/customers', { phone: num(1), name: 'Mariyam' }, ctx.token);
    member = c.json.id;
    const r = await sell([{ method: 'cash', amount: one() }], member);
    assert.ok(r.json.results[0].result, r.text);

    assert.equal((await bal('2200')).toFixed(2), '0.00');
    assert.equal((await bal('4095')).toFixed(2), '0.00');
    const m = await get(`/loyalty/member/${member}`, ctx.token);
    assert.equal(m.json.points, 0);
  });

  test('a manager cannot set the earn rate', async () => {
    const r = await req('POST', '/loyalty/config',
      { earnPerMvr: 1, pointValue: 1 }, mgr.token);
    assert.equal(r.status, 403);
  });

  test('an admin starts the scheme', async () => {
    const r = await req('POST', '/loyalty/config', {
      earnPerMvr: 1, pointValue: 0.5,
      tiers: [{ name: 'Gold', points: 500 }, { name: 'Member', points: 0 }],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.running, true);
    assert.deepEqual(r.json.tiers.map((t) => t.name), ['Member', 'Gold'],
      'the ladder is returned in order, whatever order it arrived in');
  });

  test('two tiers with the same name are refused', async () => {
    const r = await req('POST', '/loyalty/config', {
      earnPerMvr: 1, pointValue: 0.5,
      tiers: [{ name: 'Gold', points: 100 }, { name: 'Gold', points: 200 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /share a name/);
  });

  /* ── earning ──────────────────────────────────────────────────────────── */

  test('earning credits 2200 and DOES NOT reduce the sale', async () => {
    /* The guest paid full price. What changed is that the business now owes
       something later. */
    const salesBefore = await bal('4000');
    const cashBefore = await bal('1000');
    const r = await sell([{ method: 'cash', amount: one() }], member);
    assert.ok(r.json.results[0].result, r.text);

    const goods = bill(1).gross / 100;                 // net of tax and service
    const points = Math.floor(goods * 1 * 100) / 100;
    const worth = Math.round(points * 0.5 * 100) / 100;

    assert.equal((await bal('4000')).toFixed(2), (salesBefore + goods).toFixed(2),
      'income is the full sale');
    assert.equal((await bal('1000')).toFixed(2), (cashBefore + Number(one())).toFixed(2),
      'and the drawer took the whole bill');
    assert.equal((await bal('2200')).toFixed(2), worth.toFixed(2), 'the promise');
    assert.equal((await bal('4095')).toFixed(2), worth.toFixed(2), 'and its cost, once');
  });

  test('points are earned on the GOODS, not on the tax or the service charge',
    async () => {
      /* Earning on the tax would have the business paying a member a share of
         the government's money; on the service charge, a share of the staff's. */
      const m = await get(`/loyalty/member/${member}`, ctx.token);
      const goods = bill(1).gross / 100;
      assert.equal(m.json.points, Math.floor(goods * 100) / 100);
      assert.ok(m.json.points < Number(one()), 'and so less than the bill');
    });

  test('a sale with no member earns nothing and posts no loyalty journal', async () => {
    const before = await bal('2200');
    const r = await sell([{ method: 'cash', amount: one() }]);
    assert.ok(r.json.results[0].result, r.text);
    assert.equal((await bal('2200')).toFixed(2), before.toFixed(2));
  });

  test('the member sees where the points came from', async () => {
    const m = await get(`/loyalty/member/${member}`, ctx.token);
    assert.equal(m.json.entries.length, 1);
    assert.equal(m.json.entries[0].kind, 'earn');
    assert.ok(m.json.entries[0].docNo, 'against the receipt that earned them');
    assert.equal(m.json.worth, Math.round(m.json.points * 0.5 * 100) / 100);
  });

  /* ── tiers ────────────────────────────────────────────────────────────── */

  test('a tier is read from the ladder, never from a hardcoded threshold', () => {
    const cfg = { tiers: [{ name: 'Member', points: 0 }, { name: 'Gold', points: 500 }] };
    assert.equal(loyalty.tierOf(cfg, 0).name, 'Member');
    assert.equal(loyalty.tierOf(cfg, 499).name, 'Member');
    assert.equal(loyalty.tierOf(cfg, 499).next, 'Gold');
    assert.equal(loyalty.tierOf(cfg, 499).toNext, 1);
    assert.equal(loyalty.tierOf(cfg, 500).name, 'Gold');
    assert.equal(loyalty.tierOf(cfg, 500).next, null, 'the top rung has nothing above it');
    assert.equal(loyalty.tierOf({ tiers: [] }, 900).name, null,
      'a scheme with no tiers is a perfectly ordinary scheme');
  });

  test('the ladder reports who is standing on each rung', async () => {
    const r = await get('/loyalty', mgr.token);
    const member0 = r.json.ladder.find((t) => t.name === 'Member');
    assert.ok(member0.members >= 1);
    assert.equal(r.json.ladder.find((t) => t.name === 'Gold').members, 0);
  });

  /* ── spending ─────────────────────────────────────────────────────────── */

  test('spending more points than a member has is refused BEFORE the sale',
    async () => {
      const before = await bal('2200');
      /* The whole bill in points — the member has nowhere near that many. It
         has to equal the bill, or the payments check fires first and this test
         proves nothing about points at all. */
      const r = await sell([{ method: 'points', amount: one() }], member);
      assert.match(r.json.results[0].error, /points/);
      assert.equal((await bal('2200')).toFixed(2), before.toFixed(2), 'nothing moved');
    });

  test('paying with points and naming nobody is refused', async () => {
    const r = await sell([{ method: 'points', amount: one() }]);
    assert.match(r.json.results[0].error, /whose points/);
  });

  test('points spent DEBIT the liability and never touch income', async () => {
    const liabilityBefore = await bal('2200');
    const salesBefore = await bal('4000');
    const total = Number(one());
    const withPoints = 5;                                    // MVR of the bill

    const r = await sell([
      { method: 'cash', amount: (total - withPoints).toFixed(2) },
      { method: 'points', amount: withPoints.toFixed(2) },
    ], member);
    assert.ok(r.json.results[0].result, r.text);

    const goods = bill(1).gross / 100;
    const earned = Math.round(Math.floor(goods * 100) / 100 * 0.5 * 100) / 100;
    assert.equal((await bal('4000')).toFixed(2), (salesBefore + goods).toFixed(2),
      'income is the whole sale — points are not a discount');
    /* Down by what was spent, up by what this sale earned. */
    assert.equal((await bal('2200')).toFixed(2),
      (liabilityBefore - withPoints + earned).toFixed(2));
  });

  test('the points came off the member, rounded UP so nothing is given away',
    async () => {
      /* Spending 5.00 at 0.50 a point costs 10 points. Rounding down would hand
         out a laari of free money on every redemption — small, systematic and
         impossible to reconcile. */
      const m = await get(`/loyalty/member/${member}`, ctx.token);
      const redeem = m.json.entries.find((e) => e.kind === 'redeem');
      assert.ok(redeem, 'the spend is on the ledger');
      assert.equal(redeem.points, -10);
      assert.equal(redeem.value, -5);
    });

  test('points cannot be spent while the scheme is off', async () => {
    await req('POST', '/loyalty/config', { earnPerMvr: 0, pointValue: 0 });
    const r = await sell([{ method: 'points', amount: one() }], member);
    assert.match(r.json.results[0].error, /not running/);
    await req('POST', '/loyalty/config', {
      earnPerMvr: 1, pointValue: 0.5, tiers: [{ name: 'Member', points: 0 }],
    });
  });

  /* ── the ledger agrees with the ledger ────────────────────────────────── */

  test('THIS outlet\'s 2200 is what THIS outlet issued, not the chain\'s points',
    async () => {
      /* The distinction that is easy to get wrong and impossible to spot later.
         A member earns at one branch and spends at another, so the chain-wide
         points balance is not any single outlet's liability — it is the sum of
         all of them. What must reconcile here is the branch's OWN issuance
         against its OWN 2200. Asserting the chain figure against one ledger
         would pass on a single-outlet estate and fail the day a second branch
         opened, which is the worst time to find out. */
      const r = await get('/loyalty', mgr.token);
      const here = (r.json.hereEarned - r.json.hereRedeemed) * r.json.config.pointValue;
      assert.equal(here.toFixed(2), (await bal('2200')).toFixed(2),
        'issued here, minus honoured here');
      assert.ok(r.json.outstanding >= r.json.hereEarned - r.json.hereRedeemed,
        'and the chain holds at least what this branch issued');
      assert.equal(r.json.liability.toFixed(2),
        (r.json.outstanding * r.json.config.pointValue).toFixed(2),
        'the chain-wide figure is what it would cost to honour every point');
    });

  /* ── the catalogue ────────────────────────────────────────────────────── */

  test('an empty catalogue is empty, not an error', async () => {
    const r = await get('/loyalty', ctx.token);
    assert.deepEqual(r.json.rewards, []);
  });

  test('a reward says what its points are actually worth', async () => {
    /* Priced below that it is being given away twice; far above it, nobody will
       ever take it. Either way it is worth saying out loud. */
    const r = await req('POST', '/loyalty/rewards',
      { name: 'Free coffee', points: 40, value: 25 });
    assert.equal(r.status, 201, r.text);
    const list = await get('/loyalty', ctx.token);
    const rw = list.json.rewards.find((x) => x.id === r.json.id);
    assert.equal(rw.pointsWorth, 20, '40 points at 0.50');
    assert.equal(rw.value, 25);
  });

  test('a reward with no points cost or no value is refused', async () => {
    assert.equal((await req('POST', '/loyalty/rewards',
      { name: 'Nothing', points: 0, value: 10 })).status, 400);
    assert.equal((await req('POST', '/loyalty/rewards',
      { name: 'Nothing', points: 10, value: 0 })).status, 400);
  });

  test('a manager cannot change the catalogue', async () => {
    const r = await req('POST', '/loyalty/rewards',
      { name: 'Sneaky', points: 1, value: 1 }, mgr.token);
    assert.equal(r.status, 403);
  });

  /* ── who may see it ───────────────────────────────────────────────────── */

  test('a cashier reads the scheme — they have to tell a guest what they earned',
    async () => {
      const r = await get('/loyalty', ctx.token);
      assert.equal(r.status, 200);
      assert.equal(r.json.canConfigure, false);
    });

  test('a kitchen session reaches none of it', async () => {
    const kds = await H.addStaff(ctx, 'Chef', 1);
    assert.equal((await get('/loyalty', kds.token)).status, 403);
  });

  test('the trial balance still balances', async () => {
    const r = await get('/reports/trial-balance');
    assert.equal(r.json.totals.difference, 0, JSON.stringify(r.json.totals));
  });
});
