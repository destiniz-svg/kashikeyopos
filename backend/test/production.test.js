'use strict';
/* Production — 02-POS-SPEC §2 (`production`).
 *
 * THE BUG THIS MODULE EXISTS TO FIX is the one worth testing first: a
 * sub-recipe was exploded to raw ingredients at the moment of SALE, so a
 * kitchen that made four litres of sauce this morning had physically used the
 * tomatoes while the system still said they were on the shelf. Every stock
 * count in between was short with nothing to explain it.
 *
 * The other half is arithmetic that has to be exactly right or every dish
 * containing a prep item is mispriced: yield loss makes the output DEARER, the
 * whole of the components' cost lands in whatever actually came out, and a
 * batch arriving averages into existing stock the same way a delivery does.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('production', () => {
  let ctx, mgr, cook;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Head Chef', 3);
    cook = await H.addStaff(ctx, 'A Cook', 2);

    /* A prep item of our own: 2 litres of sauce from beef and syrup, which are
       what this outlet's fixture happens to stock. The point is the mechanism,
       not the plausibility of the dish. */
    await H.asOwner(ctx,
      "INSERT INTO ingredient (id, name, unit, on_hand, avg_cost)"
      + " VALUES ('SAUCE','House sauce','ml',0,0) ON CONFLICT (id) DO NOTHING");
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const onHand = async (id) => {
    const r = await H.asOwner(ctx, 'SELECT on_hand, avg_cost FROM ingredient WHERE id = $1', [id]);
    return { onHand: Number(r.rows[0].on_hand), avgCost: Number(r.rows[0].avg_cost) };
  };

  test('an outlet that makes nothing says so rather than erroring', async () => {
    const r = await get('/production');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items, []);
  });

  test('a cook may read the prep list and may not write the formula', async () => {
    assert.equal((await get('/production', cook.token)).status, 200);
    const w = await req('PUT', '/production/SAUCE/recipe',
      { yieldQty: 2000, components: [{ id: 'BEEF', qty: 500 }] }, cook.token);
    assert.equal(w.status, 403);
  });

  describe('the formula', () => {
    test('a manager sets it whole, not line by line', async () => {
      const r = await req('PUT', '/production/SAUCE/recipe', {
        yieldQty: 2000,
        components: [
          { id: 'BEEF', qty: 400, wastePct: 20 },   // trim: 500 g goes in
          { id: 'SYRUP', qty: 1000, wastePct: 0 },
        ],
      });
      assert.equal(r.status, 200, r.text);
      const it = r.json.items.find((x) => x.id === 'SAUCE');
      assert.equal(it.yieldQty, 2000);
      assert.equal(it.components.length, 2);
      const beef = it.components.find((c) => c.id === 'BEEF');
      /* 400 g at 20% trim needs 500 g off the shelf. Waste is a yield loss on
         the way in, not a separate line of cost. */
      assert.equal(beef.needPerBatch, 500);
    });

    test('it costs a batch at what the components cost today', async () => {
      const r = await get('/production');
      const it = r.json.items.find((x) => x.id === 'SAUCE');
      /* 500 g beef at 0.0850 = 42.50; 1000 ml syrup at 0.0120 = 12.00. */
      assert.equal(it.batchCost, 54.5);
      /* Four decimal places, which is what `avg_cost` holds: 0.02725 rounds
         to 0.0273. Rounded ONCE, at the end — rounding each component's unit
         cost first is what turned beef at 8.5 laari a gram into 9 and every
         batch 6% dearer. */
      assert.equal(it.unitCostIfMadeNow, 0.0273);
    });

    test('it says how many more batches the store can stand, and what stops it',
      async () => {
        const r = await get('/production');
        const it = r.json.items.find((x) => x.id === 'SAUCE');
        /* 10 000 g beef / 500 = 20 batches; 20 000 ml syrup / 1000 = 20. */
        assert.equal(it.possibleBatches, 20);
        assert.equal(it.bindingComponent, null, 'nothing is short yet');
      });

    test('the same component twice is a mistake, not a merge', async () => {
      const r = await req('PUT', '/production/SAUCE/recipe', {
        yieldQty: 2000,
        components: [{ id: 'BEEF', qty: 1 }, { id: 'BEEF', qty: 2 }],
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /twice/);
    });

    test('a thing cannot be made of itself', async () => {
      const r = await req('PUT', '/production/SAUCE/recipe',
        { yieldQty: 2000, components: [{ id: 'SAUCE', qty: 1 }] });
      assert.equal(r.status, 400);
    });

    test('and a longer loop is refused too', async () => {
      /* SAUCE is made of BEEF. Making BEEF out of SAUCE would close the ring —
         the database's CHECK cannot see that, only the application can. */
      await req('PUT', '/production/SAUCE/recipe',
        { yieldQty: 2000, components: [{ id: 'BEEF', qty: 400, wastePct: 20 },
          { id: 'SYRUP', qty: 1000 }] });
      const r = await req('PUT', '/production/BEEF/recipe',
        { yieldQty: 1000, components: [{ id: 'SAUCE', qty: 100 }] });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /depend on each other/);
    });
  });

  describe('making a batch', () => {
    let before1;

    before(async () => { before1 = await onHand('BEEF'); });

    test('the components leave the shelf the moment it is made', async () => {
      const r = await req('POST', '/production/runs', { makesId: 'SAUCE', batches: 1 }, cook.token);
      assert.equal(r.status, 201, r.text);
      const after = await onHand('BEEF');
      /* THE WHOLE POINT. Before this module the tomatoes stayed on the books
         until a dish containing them sold, and the count in between was short
         with nothing to explain it. */
      assert.equal(after.onHand, before1.onHand - 500);
      const sauce = await onHand('SAUCE');
      assert.equal(sauce.onHand, 2000);
    });

    test('what came out is worth what went in', async () => {
      const sauce = await onHand('SAUCE');
      /* 54.50 of components over 2000 ml = 0.02725 per ml. */
      assert.equal(sauce.avgCost, 0.0273, 'rounded to the fourth place, once');
    });

    test('it posts no journal, and says so', async () => {
      const r = await req('POST', '/production/runs',
        { makesId: 'SAUCE', batches: 1 }, cook.token);
      assert.equal(r.json.posted, null);
      assert.match(r.json.ledger, /one inventory account line to another/);
      /* And the books really did not move: inventory in total is unchanged, so
         nothing reached the P&L. */
      const tb = await get(`/reports/trial-balance`);
      const cogs = tb.json.accounts.find((a) => a.code === '5000');
      assert.ok(!cogs || cogs.balance === 0, 'production charged something to cost of sales');
      /* And nothing at all posted from it: a source of `stock` with a prep run
         behind it would be a journal this module says it never writes. */
      const posted = await H.asOwner(ctx,
        "SELECT count(*)::int AS n FROM journal WHERE memo ILIKE '%prep%'");
      assert.equal(posted.rows[0].n, 0);
    });

    test('a short yield makes the product dearer, not the batch cheaper', async () => {
      const beforeSauce = await onHand('SAUCE');
      const r = await req('POST', '/production/runs',
        { makesId: 'SAUCE', batches: 1, qty: 1000, note: 'reduced hard' }, cook.token);
      assert.equal(r.status, 201, r.text);
      /* A full batch of components, half the output: the litre that survived
         carries the whole 54.50, which is the true story of a reduction. */
      assert.equal(r.json.cost, 54.5);
      /* 54.50 over the one litre that survived: 0.0545 a millilitre, against
         0.0273 when the full two litres came out. Twice the price, which is
         what a reduction costs. */
      assert.equal(r.json.unitCost, 0.0545);
      const after = await onHand('SAUCE');
      assert.equal(after.onHand, beforeSauce.onHand + 1000);
      assert.ok(after.avgCost > beforeSauce.avgCost,
        'the average did not move towards the dearer batch');
    });

    test('the run reads back as one act, with every movement it caused', async () => {
      const list = await get('/production/runs');
      assert.ok(list.json.runs.length >= 3);
      const r = await get(`/production/runs/${list.json.runs[0].id}`);
      assert.equal(r.status, 200);
      /* Two components out, one product in. Six movements at the same second
         with nothing joining them is not an audit trail. */
      assert.equal(r.json.moves.length, 3);
      assert.equal(r.json.moves.filter((m) => m.qty > 0).length, 1);
      assert.equal(r.json.moves.filter((m) => m.reason === 'prep').length, 2);
      assert.equal(r.json.moves.find((m) => m.qty > 0).reason, 'production');
    });

    test('short stock is reported, and the batch is still recorded', async () => {
      /* The cook is standing at the screen with the sauce already made.
         Refusing would lose the record AND leave the shelf wrong the other
         way. Same rule as a sale that has already taken money. */
      await H.asOwner(ctx,
        "INSERT INTO ingredient (id, name, unit, on_hand, avg_cost)"
        + " VALUES ('RARE','Rare thing','g',0,2) ON CONFLICT (id) DO NOTHING");
      await req('PUT', '/production/SAUCE/recipe', {
        yieldQty: 2000,
        components: [{ id: 'RARE', qty: 100 }, { id: 'SYRUP', qty: 1000 }],
      });
      const r = await req('POST', '/production/runs', { makesId: 'SAUCE' }, cook.token);
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.short.length, 1);
      assert.equal(r.json.short[0].id, 'RARE');
      const rare = await onHand('RARE');
      assert.equal(rare.onHand, -100, 'negative on-hand is a finding, not an error');
    });

    test('something nobody has a formula for cannot be made', async () => {
      const r = await req('POST', '/production/runs', { makesId: 'BUN' }, cook.token);
      assert.equal(r.status, 400);
      assert.match(r.json.error, /not something this kitchen makes/);
    });

    test('a dish can then use the prep item like any other ingredient', async () => {
      /* The reason a prep item IS an ingredient. Nothing in costing had to
         learn what prep is. */
      await H.asOwner(ctx,
        "INSERT INTO recipe_line (item_id, ingredient_id, qty, waste_pct)"
        + " VALUES ('BURGER','SAUCE',30,0) ON CONFLICT DO NOTHING");
      const r = await get('/recipes/BURGER');
      assert.equal(r.status, 200, r.text);
      const line = (r.json.lines || []).find((l) => l.ref === 'SAUCE');
      assert.ok(line, 'the dish cannot see the sauce');
      assert.ok(line.cost > 0, 'and it is priced at what the sauce cost to make');
    });
  });
});
