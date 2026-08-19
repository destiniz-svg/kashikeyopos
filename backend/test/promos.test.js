'use strict';
/* Promotions — §2 (`promos`), 08-BUILD-STAGES §16.
 *
 * The acceptance criterion IS the test plan: "A promo quoted on the phone is
 * charged by the till, or refused with a reason — never quoted and then
 * silently dropped." So this file:
 *
 *   · asks the same code on the phone and at the till and requires the same
 *     answer, to the laari;
 *   · requires every refusal to carry a reason a guest could act on;
 *   · pins the caps, because a cap counted from a mutable number is not a cap;
 *   · and covers the hole the module had to close on its way in — a discount
 *     the client simply named.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('promotions', () => {
  let ctx, mgr, admin, guest, member;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '1' });
    guest = g.json.token;
    const c = await H.req('POST', `/api/outlet/${ctx.outletId}/customers`,
      { body: { phone: String(6000000 + (ctx.outletId % 900000)), name: 'Ibrahim' },
        token: ctx.token });
    member = c.json.id;
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const bal = async (code) => {
    const r = await get('/reports/trial-balance');
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };
  /* Codes unique to this run. `chain.promo` is CHAIN-WIDE — a code on a flyer
     works wherever the guest walks in — so a fresh test outlet is born already
     able to see every promotion the chain has, including the ones a previous
     run of this file created. That is the design working, not a leak. */
  const P = (code) => 'R' + (ctx.outletId % 10000) + code;

  /* A sale through the real till path. */
  const sell = (payload) => H.push(ctx, [{
    opId: H.uuid(), kind: 'sale', at: Date.now(),
    payload: {
      businessDate: ctx.today, channel: 'dine_in', covers: 1,
      lines: [{ itemId: 'BURGER', qty: 2 }], ...payload,
    },
  }]);
  /* What the phone asks. Rank 0, a different door, the same evaluator. */
  const askPhone = (code, goods) =>
    H.req('POST', `/api/outlet/${ctx.outletId}/guest/promo`,
      { body: { code, goods }, token: guest });
  const askTill = (code, goodsLaari, memberId) =>
    req('POST', '/promos/quote', { code, goodsLaari, memberId }, ctx.token);

  /* ── setting one up ───────────────────────────────────────────────────── */

  test('a new outlet sees the chain\'s promotions and has run none of its own',
    async () => {
      const r = await get('/promos', mgr.token);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.promos.filter((x) => x.code.startsWith(P(''))), [],
        'nothing from this run yet');
      for (const x of r.json.promos) {
        assert.equal(typeof x.dormant, x.dormant === null ? 'object' : 'string',
          'and every one of them says whether it is live');
      }
    });

  test('a manager cannot create one — it is a standing offer to the public',
    async () => {
      const r = await req('POST', '/promos',
        { code: P('SNEAK'), name: 'Sneaky', kind: 'percent', value: 90 }, mgr.token);
      assert.equal(r.status, 403);
    });

  test('a code with a space in it is refused', async () => {
    /* It has to survive being read out over a telephone. */
    const r = await req('POST', '/promos',
      { code: 'SAVE 20', name: 'x', kind: 'percent', value: 20 });
    assert.equal(r.status, 400);
  });

  test('a percentage above 100 is not a discount', async () => {
    const r = await req('POST', '/promos',
      { code: P('FREE'), name: 'x', kind: 'percent', value: 150 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /above 100/);
  });

  test('an admin creates one', async () => {
    const r = await req('POST', '/promos', {
      code: P('SAVE20').toLowerCase(), name: 'Twenty off', kind: 'percent', value: 20,
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.code, P('SAVE20'), 'stored upper-case');
  });

  test('the same code twice is refused', async () => {
    const r = await req('POST', '/promos',
      { code: P('SAVE20'), name: 'Again', kind: 'percent', value: 5 });
    assert.equal(r.status, 409);
  });

  /* ── the phone and the till agree, which is the whole point ───────────── */

  test('the phone and the till quote the same figure, to the laari', async () => {
    /* The INCLUSIVE goods — the prices on the menu board, which is what the
       phone sends and what the guest was shown. Quoted against the net figure
       instead, "20% off" a 165.00 dish comes to 30.56 rather than 33.00, and
       the two sides disagree by exactly the tax fraction. */
    const goods = ctx.menu.BURGER * 2;
    const phone = await askPhone(P('SAVE20'), goods);
    const till = await askTill(P('SAVE20'), goods);
    assert.equal(phone.status, 200, phone.text);
    assert.equal(till.status, 200, till.text);
    assert.equal(phone.json.ok, true);
    assert.equal(phone.json.discount, till.json.discount);
    assert.equal(phone.json.discount, Math.round(goods * 0.2));
    assert.equal(phone.json.discount, Math.round(ctx.menu.BURGER * 2 * 0.2),
      'a fifth off the price on the board');
    assert.equal(phone.json.name, till.json.name);
  });

  test('a guest can quote a code with no staff session at all', async () => {
    /* A promo code is printed on a flyer. Rank 0 is the right rank for it. */
    const r = await askPhone(P('SAVE20').toLowerCase(), ctx.menu.BURGER);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, 'and lower case is the same code');
  });

  test('AND THE TILL CHARGES IT — the criterion, end to end', async () => {
    const goods = ctx.menu.BURGER * 2;
    const quoted = (await askPhone(P('SAVE20'), goods)).json.discount;
    const expected = H.money.priceBill({
      lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
      discount: quoted, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });

    const r = await sell({
      promoCode: P('SAVE20'),
      payments: [{ method: 'cash', amount: (expected.total / 100).toFixed(2) }],
    });
    const res = r.json.results[0].result;
    assert.ok(res, r.text);
    assert.equal(res.total, (expected.total / 100).toFixed(2));

    /* And it landed on 4090 as a discount, not as lost revenue — at the figure
       NET of GST, because 4090 is contra-INCOME and income is net. The quoted
       discount is inclusive, like every price a guest is shown. */
    assert.equal((await bal('4090')).toFixed(2), (expected.discount / 100).toFixed(2));
    assert.ok(expected.discount < quoted, 'and the net figure is the smaller one');
  });

  test('the use is recorded against the sale that honoured it', async () => {
    const list = await get('/promos', mgr.token);
    const p = list.json.promos.find((x) => x.code === P('SAVE20'));
    assert.equal(p.uses, 1);
    assert.ok(p.given > 0);
    const uses = await get(`/promos/${p.id}/uses`, mgr.token);
    assert.equal(uses.json.uses.length, 1);
    assert.ok(uses.json.uses[0].docNo, 'against a receipt number');
  });

  test('an unknown code is refused WITH A REASON, on both sides', async () => {
    /* "Not valid" is the answer that makes a guest argue with a cashier who
       also cannot see why. */
    const phone = await askPhone(P('NOPE'), 10000);
    assert.equal(phone.json.ok, false);
    assert.match(phone.json.reason, /No promotion with that code/);

    const r = await sell({
      promoCode: P('NOPE'), payments: [{ method: 'cash', amount: '1.00' }],
    });
    assert.match(r.json.results[0].error, /No promotion with that code/);
  });

  /* ── windows ──────────────────────────────────────────────────────────── */

  test('a promotion that has ended says so rather than saying nothing', async () => {
    await req('POST', '/promos', {
      code: P('LASTYEAR'), name: 'Old one', kind: 'percent', value: 50,
      startsOn: '2020-01-01', endsOn: '2020-12-31',
    });
    const r = await askPhone(P('LASTYEAR'), 100000);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /has ended/);
  });

  test('a promotion that has not started yet says when', async () => {
    await req('POST', '/promos', {
      code: P('SOON'), name: 'Next year', kind: 'percent', value: 10,
      startsOn: '2099-01-01',
    });
    const r = await askPhone(P('SOON'), 100000);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /not started/);
  });

  test('a day-of-week window names the days it runs', async () => {
    const today = new Date().getUTCDay();
    const notToday = [(today + 1) % 7, (today + 2) % 7];
    await req('POST', '/promos', {
      code: P('TUESDAY'), name: 'Not today', kind: 'percent', value: 10, days: notToday,
    });
    const r = await askPhone(P('TUESDAY'), 100000);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /runs on/);
  });

  test('a happy hour outside its hours says the hours', async () => {
    /* A window that has both ends, and a clock that is outside it. */
    const now = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const from = (now + 120) % 1440;
    await req('POST', '/promos', {
      code: P('HAPPY'), name: 'Happy hour', kind: 'percent', value: 30,
      fromMin: Math.min(from, 1380), toMin: Math.min(from + 60, 1440),
    });
    const r = await askPhone(P('HAPPY'), 100000);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /runs between/);
  });

  test('a window with only one end is refused when it is set up', async () => {
    const r = await req('POST', '/promos', {
      code: P('HALFWIN'), name: 'x', kind: 'percent', value: 10, fromMin: 600,
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /both ends/);
  });

  /* ── caps ─────────────────────────────────────────────────────────────── */

  test('a minimum spend says what the minimum is and what this bill is', async () => {
    await req('POST', '/promos', {
      code: P('BIG'), name: 'Big spender', kind: 'amount', value: 100, minSpend: 5000,
    });
    const r = await askPhone(P('BIG'), 10000);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /Spend 5000\.00/);
    assert.match(r.json.reason, /this is 100\.00/);
  });

  test('a per-bill cap bites, and says so', async () => {
    /* "20% off" on a party of thirty is a number nobody signed off. */
    await req('POST', '/promos', {
      code: P('CAPPED'), name: 'Capped', kind: 'percent', value: 50, maxDiscount: 25,
    });
    const r = await askPhone(P('CAPPED'), 100000);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.discount, 2500, 'not 500.00');
    assert.equal(r.json.capped, true);
    assert.match(r.json.note, /Capped at 25\.00/);
  });

  test('an amount larger than the bill cannot make the bill negative', async () => {
    /* Otherwise a 500-off code on a 300 basket owes the guest money for
       turning up. */
    await req('POST', '/promos', {
      code: P('HUGE'), name: 'Huge', kind: 'amount', value: 500,
    });
    const r = await askPhone(P('HUGE'), 30000);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.discount, 30000, 'the whole basket, and no more');
    assert.equal(r.json.capped, true);
  });

  test('a total-uses cap is counted from the ledger and stops the next one',
    async () => {
      await req('POST', '/promos', {
        code: P('ONLYONE'), name: 'One only', kind: 'amount', value: 5, maxUses: 1,
      });
      const goods = ctx.menu.BURGER * 2;
      const first = H.money.priceBill({
        lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
        discount: 500, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
      });
      const a = await sell({
        promoCode: P('ONLYONE'),
        payments: [{ method: 'cash', amount: (first.total / 100).toFixed(2) }],
      });
      assert.ok(a.json.results[0].result, a.text);

      const again = await askPhone(P('ONLYONE'), goods);
      assert.equal(again.json.ok, false);
      assert.match(again.json.reason, /fully used/);
    });

  test('a per-member cap needs a member, and then counts them', async () => {
    await req('POST', '/promos', {
      code: P('ONCEEACH'), name: 'Once each', kind: 'amount', value: 5, maxPerMember: 1,
    });
    const anon = await askTill(P('ONCEEACH'), 100000);
    assert.equal(anon.json.ok, false);
    assert.match(anon.json.reason, /limited per customer/);

    const named = await askTill(P('ONCEEACH'), 100000, member);
    assert.equal(named.json.ok, true);

    const priced = H.money.priceBill({
      lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
      discount: 500, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const sale = await sell({
      promoCode: P('ONCEEACH'), memberId: member,
      payments: [{ method: 'cash', amount: (priced.total / 100).toFixed(2) }],
    });
    assert.ok(sale.json.results[0].result, sale.text);

    const twice = await askTill(P('ONCEEACH'), 100000, member);
    assert.equal(twice.json.ok, false);
    assert.match(twice.json.reason, /used that one already/);
  });

  test('a members-only promotion asks for the member first', async () => {
    await req('POST', '/promos', {
      code: P('MEMBERS'), name: 'Members only', kind: 'percent', value: 10,
      membersOnly: true,
    });
    const anon = await askPhone(P('MEMBERS'), 100000);
    assert.equal(anon.json.ok, false);
    assert.match(anon.json.reason, /for members/);
    const named = await askTill(P('MEMBERS'), 100000, member);
    assert.equal(named.json.ok, true);
  });

  test('a stopped promotion stops, and the list says why it is dormant',
    async () => {
      const list = await get('/promos', mgr.token);
      const p = list.json.promos.find((x) => x.code === P('SAVE20'));
      const r = await req('DELETE', '/promos/' + p.id);
      assert.equal(r.status, 200, r.text);

      const q = await askPhone(P('SAVE20'), 100000);
      assert.equal(q.json.ok, false);
      assert.match(q.json.reason, /been stopped/);

      const after = await get('/promos', mgr.token);
      assert.equal(after.json.promos.find((x) => x.code === P('SAVE20')).dormant, 'stopped');
      assert.equal(after.json.promos.find((x) => x.code === P('SOON')).dormant,
        'starts 2099-01-01');
    });

  /* ── the hole this module had to close on its way in ──────────────────── */

  test('a discount the client simply NAMES is refused', async () => {
    /* Before this, any till session could settle a bill with a discount equal
       to the bill and a reason it invented. The sale balanced and posted to
       4090 like any other, and nothing downstream could tell it from a genuine
       goodwill gesture. */
    const priced = H.money.priceBill({
      lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
      discount: 10000, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const r = await sell({
      discount: '100.00', discountReason: 'because I said so',
      payments: [{ method: 'cash', amount: (priced.total / 100).toFixed(2) }],
    });
    assert.match(r.json.results[0].error, /no open discount is allowed/);
  });

  test('with a ceiling set, an open discount needs a MANAGER', async () => {
    await H.asOwner(ctx, 'UPDATE chain.outlet SET max_open_discount = 50 WHERE id = $1',
      [ctx.outletId]);
    const priced = H.money.priceBill({
      lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
      discount: 2000, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    /* ctx.token is the till session — rank 2. */
    const r = await sell({
      discount: '20.00', discountReason: 'burnt steak',
      payments: [{ method: 'cash', amount: (priced.total / 100).toFixed(2) }],
    });
    assert.match(r.json.results[0].error, /needs a manager/);
  });

  test('and it cannot exceed the ceiling even for one', async () => {
    const priced = H.money.priceBill({
      lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
      discount: 9000, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const r = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
      token: mgr.token,
      body: { ops: [{ opId: H.uuid(), kind: 'sale', at: Date.now(), payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 2 }],
        discount: '90.00', discountReason: 'sorry',
        payments: [{ method: 'cash', amount: (priced.total / 100).toFixed(2) }],
      } }] },
    });
    assert.match(r.json.results[0].error, /over the 50\.00/);
  });

  test('a manager within the ceiling goes through, and is NAMED on the sale',
    async () => {
      /* `discount_by` has existed since migration 003 and nothing ever wrote to
         it, which made every discount anonymous. */
      const priced = H.money.priceBill({
        lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
        discount: 2000, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
      });
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
        token: mgr.token,
        body: { ops: [{ opId: H.uuid(), kind: 'sale', at: Date.now(), payload: {
          businessDate: ctx.today, channel: 'dine_in', covers: 1,
          lines: [{ itemId: 'BURGER', qty: 2 }],
          discount: '20.00', discountReason: 'burnt steak',
          payments: [{ method: 'cash', amount: (priced.total / 100).toFixed(2) }],
        } }] },
      });
      assert.ok(r.json.results[0].result, r.text);

      const rows = await H.q(ctx,
        "SELECT discount, discount_reason, discount_by FROM sale"
        + " WHERE discount_reason = 'burnt steak'");
      assert.equal(rows.rows.length, 1);
      /* Stored NET of GST, like `gross` beside it and like every other figure
         on a sale row — the 20.00 the manager took off is what the guest saw,
         and it is inclusive. `sale_adds_up` is what keeps the two consistent. */
      assert.equal(Number(rows.rows[0].discount), priced.discount / 100);
      assert.ok(rows.rows[0].discount_by, 'somebody owns it');
    });

  test('an open discount with no reason is refused', async () => {
    const priced = H.money.priceBill({
      lines: [{ unitPrice: ctx.menu.BURGER, qty: 2 }],
      discount: 1000, servicePct: ctx.servicePct, taxRate: ctx.taxRate,
    });
    const r = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
      token: mgr.token,
      body: { ops: [{ opId: H.uuid(), kind: 'sale', at: Date.now(), payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 2 }], discount: '10.00',
        payments: [{ method: 'cash', amount: (priced.total / 100).toFixed(2) }],
      } }] },
    });
    assert.match(r.json.results[0].error, /say why/);
  });

  /* ── and the books still stand up ─────────────────────────────────────── */

  test('the trial balance still balances', async () => {
    const r = await get('/reports/trial-balance');
    assert.equal(r.json.totals.difference, 0, JSON.stringify(r.json.totals));
  });
});
