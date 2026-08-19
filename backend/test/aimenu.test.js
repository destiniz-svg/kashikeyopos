'use strict';
/* AI Menu Builder — 02-POS-SPEC §2 (`aimenu`): "Cost-engineered menu
 * suggestions from the live item master."
 *
 * THE POINT OF THIS FILE is that the whole board is arithmetic and NO API KEY
 * IS SET, here or in this build's production environment. So every test below
 * runs against a module with nothing configured, and the last describe proves
 * the one part that would call out says so plainly instead of failing.
 *
 * `env -u ANTHROPIC_API_KEY` is not needed: the harness does not set one. If
 * one ever leaks into the environment the "not configured" assertions here fail
 * loudly, which is the correct outcome — a test that quietly starts making
 * paid API calls is worse than a red one.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const aimenu = require('../src/aimenu');

describe('AI menu builder', () => {
  let ctx, mgr, admin;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);

    /* Trade, so there is a popularity axis at all. Cola sells four times as
       often as the burger and makes a much fatter margin — a textbook star
       against a textbook puzzle, which is what makes the quadrants checkable
       rather than plausible. */
    const sell = (basket) => H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
        payments: [{ method: 'cash', amount: H.priceIt(ctx, basket).total / 100 }],
      },
    }]);
    await sell([['COLA', 20]]);
    await sell([['BURGER', 2]]);
  });
  after(() => H.teardown(ctx));

  const get = (p, token) =>
    H.req('GET', `/api/outlet/${ctx.outletId}${p}`, { token: token || mgr.token });

  /* ── the arithmetic ───────────────────────────────────────────────────── */

  test('a cashier does not price the menu', async () => {
    assert.equal((await H.req('GET', `/api/outlet/${ctx.outletId}/aimenu`,
      { token: ctx.token })).status, 403);
  });

  test('margin is measured NET of tax, because the menu price includes it',
    async () => {
      const r = await get('/aimenu');
      assert.equal(r.status, 200, r.text);
      const burger = r.json.items.find((i) => i.itemId === 'BURGER');
      /* 150 g of beef at 5% waste is 150/0.95 g BOUGHT, at 0.0850 — waste is a
         yield loss, not a surcharge — plus one bun at 4.50. */
      assert.equal(burger.plateCost, 1792);
      assert.equal(burger.price, 8500);
      assert.equal(burger.net, 7870, 'GST was not extracted from the menu price');
      assert.equal(burger.gp, 7870 - 1792);
      /* Measured against the gross this would read 78.9% and every dish on the
         menu would be flattered by the tax rate together, so nothing would look
         wrong. */
      assert.equal(burger.gpPct, 77.2);
    });

  test('the two axes are drawn against this menu, and the averages are published',
    async () => {
      const r = await get('/aimenu');
      const b = r.json.benchmark;
      assert.equal(b.dishesRanked, 2);
      assert.equal(b.meanSold, 11, '(20 colas + 2 burgers) / 2');
      /* A dish is called a dog by comparison with these, so they are shown. */
      assert.ok(b.meanGpPct > 0);
    });

  test('sells well and makes money is a star; sells badly and makes less is not',
    async () => {
      const r = await get('/aimenu');
      const cola = r.json.items.find((i) => i.itemId === 'COLA');
      const burger = r.json.items.find((i) => i.itemId === 'BURGER');
      assert.equal(cola.quadrant, 'star');
      assert.match(cola.why, /protect it/);
      /* The burger sells below the menu average and makes below-average margin.
         That is the cut candidate, and the screen says so in words rather than
         leaving a manager to decode a colour. */
      assert.equal(burger.quadrant, 'dog');
      assert.match(burger.why, /candidate to cut/);
    });

  test('the board is ranked by contribution, not by percentage', async () => {
    /* A 90% dish that sells twice a week contributes nothing; the ranking has
       to be money. */
    const r = await get('/aimenu');
    assert.equal(r.json.items[0].itemId, 'COLA');
    assert.ok(r.json.items[0].contribution > r.json.items[1].contribution);
  });

  test('a dish nobody has costed is not a 100% margin dish', async () => {
    await H.asOwner(ctx, "INSERT INTO item (id, name, category, price)"
      + " VALUES ('CAKE','Cake slice','Food',45.00) ON CONFLICT DO NOTHING");
    const r = await get('/aimenu');
    const cake = r.json.items.find((i) => i.itemId === 'CAKE');
    assert.equal(cake.costed, false);
    /* Ranked nowhere: putting it top of the board as the menu's best performer
       is how the recipe never gets written. */
    assert.equal(cake.quadrant, null);
    assert.match(cake.why, /nobody has written this recipe/);
    assert.equal(r.json.benchmark.uncosted, 1);
    /* And it does not move the averages every other dish is judged against. */
    assert.equal(r.json.benchmark.dishesRanked, 2);
  });

  test('a target GP prices every costed dish, rounded once from the figure itself',
    async () => {
      const r = await get('/aimenu?targetGpPct=70');
      const burger = r.json.items.find((i) => i.itemId === 'BURGER');
      /* 1792 / 0.30 = 5973.33 net, × 1.08 = 6451.2 → 6451 laari, MVR 64.51.
         Working the tax back off a rounded exclusive base instead drifts by
         laari on every dish, in the same direction. */
      assert.equal(burger.suggestedPrice, 6451);
      const cake = r.json.items.find((i) => i.itemId === 'CAKE');
      assert.equal(cake.suggestedPrice, null, 'a dish with no cost cannot be priced to a target');
    });

  test('an outlet that has sold nothing says so rather than dividing by zero',
    async () => {
      const fresh = await H.bootOutlet();
      try {
        const boss = await H.addStaff(fresh, 'Duty Manager', 3);
        const r = await H.req('GET', `/api/outlet/${fresh.outletId}/aimenu`,
          { token: boss.token });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.benchmark.dishesRanked, 0);
        assert.equal(r.json.benchmark.meanGpPct, 0);
        assert.ok(r.json.items.every((i) => i.quadrant === null));
        assert.ok(r.json.items.every((i) => /has not sold/.test(i.why)));
      } finally { /* one server serves both; teardown happens in the outer after */ }
    });

  /* ── the part that needs a key, with no key ───────────────────────────── */

  describe('with nothing configured', () => {
    test('the board says so without being asked twice', async () => {
      const r = await get('/aimenu');
      assert.equal(r.json.ai.configured, false);
      /* Naming the variable is the difference between a five-minute fix and a
         support ticket. */
      assert.match(r.json.ai.needs, /ANTHROPIC_API_KEY/);
    });

    test('asking for menu copy answers, rather than failing', async () => {
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/aimenu/BURGER/describe`,
        { token: admin.token, body: { tone: 'plain' } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.configured, false);
      assert.match(r.json.needs, /ANTHROPIC_API_KEY/);
      /* It still shows what it WOULD be given, so the feature is
         understandable before anybody pays for a key. */
      assert.equal(r.json.name, 'Beef burger');
      assert.deepEqual(r.json.ingredients.sort(), ['Beef mince', 'Burger bun']);
      assert.equal(r.json.draft, undefined, 'a local invention presented as advice');
    });

    test('a manager cannot spend money on an outside service', async () => {
      /* Reading the board is manager; calling out is admin, because it is the
         only thing in this build that leaves the building and it costs per
         call. */
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/aimenu/BURGER/describe`,
        { token: mgr.token, body: {} });
      assert.equal(r.status, 403);
    });

    test('a dish that does not exist is a 404, not an empty draft', async () => {
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/aimenu/NOPE/describe`,
        { token: admin.token, body: {} });
      assert.equal(r.status, 404);
    });
  });

  /* ── the pricing arithmetic on its own ────────────────────────────────── */

  describe('priceForTarget', () => {
    test('hits the target it was given', () => {
      const price = aimenu.priceForTarget(1792, 70, 8);
      const net = Math.round(price / 1.08);
      assert.ok(Math.abs(((net - 1792) / net) * 100 - 70) < 0.1);
    });

    test('a free dish and an impossible margin both decline to answer', () => {
      assert.equal(aimenu.priceForTarget(0, 70, 8), null);
      assert.equal(aimenu.priceForTarget(1792, 100, 8), null,
        'a 100% margin needs an infinite price');
    });

    test('an outlet that is not GST-registered is not charged 8% anyway', () => {
      assert.equal(aimenu.priceForTarget(1000, 50, 0), 2000);
    });
  });
});
