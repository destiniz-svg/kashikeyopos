'use strict';
/* Recipes & Costing — 02-POS-SPEC.md §2 (`recipes`), and §16 of the brief.
 *
 * The arithmetic here is the arithmetic the LEDGER uses: src/costing.js is
 * called both by this module and by the sale path, so a plate cost on screen
 * and a COGS figure in the accounts cannot disagree. Several of these tests
 * assert exactly that, because "the screen said 31% and the books say 38%" is
 * the failure this design exists to make impossible.
 *
 * The rest pin the three ways food cost is commonly got wrong: yield, waste as
 * a yield loss rather than a surcharge, and sub-recipes that recurse.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('Recipes & Costing', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Chef', 3);
  });
  after(() => H.teardown(ctx));

  const api = (method, p, body) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: mgr.token });

  test('a cashier cannot see costs', async () => {
    // Margin is not a cashier's business, and the rail hides it — but the rail
    // is a courtesy and this is the control.
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/recipes`, { token: ctx.token });
    assert.equal(r.status, 403);
  });

  test('a manager adds an ingredient with a real cost', async () => {
    const r = await api('POST', '/ingredients', {
      id: 'tuna', name: 'Yellowfin tuna', unit: 'g', avgCost: 0.085, par: 5000,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.id, 'TUNA');
  });

  test('a fractional cost survives — cost per gram is not two decimals', async () => {
    /* Rounding avg_cost to 2dp would make every gram-denominated ingredient
       cost exactly zero, and every dish costed from grams free. */
    const r = await api('GET', '/ingredients');
    const tuna = r.json.ingredients.find((i) => i.id === 'TUNA');
    assert.equal(tuna.avgCost, 0.085);
  });

  test('a bad unit is refused', async () => {
    const r = await api('POST', '/ingredients', { id: 'X', name: 'X', unit: 'handfuls' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unit must be one of/i);
  });

  test('a recipe costs a dish, and the plate cost is real', async () => {
    // BURGER is 85.00 in the harness fixture. 150g of tuna at 0.085/g = 12.75.
    const put = await api('PUT', '/recipes/BURGER', {
      lines: [{ ingredientId: 'TUNA', qty: 150 }],
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));

    const r = await api('GET', '/recipes/BURGER');
    assert.equal(r.json.plateCost, 1275, 'in laari: 150 × 0.085 = MVR 12.75');
    assert.equal(r.json.incomplete, false);
  });

  test('GP is measured on the price NET of tax', async () => {
    /* A menu price is GST-inclusive. Measuring margin against the gross figure
       includes the government's share as if it were revenue and flatters every
       dish on the menu by the tax rate. */
    const r = await api('GET', '/recipes/BURGER');
    // 85.00 inclusive at 8% → 78.70 net. GP = 78.70 − 12.75 = 65.95.
    assert.equal(r.json.net, 7870);
    assert.equal(r.json.gp, 7870 - 1275);
    assert.equal(r.json.foodCostPct, 16.2);
  });

  test('WASTE IS A YIELD LOSS, NOT A SURCHARGE', async () => {
    /* Needing 100g of a trim at 20% waste means BUYING 125g, not 120g.
       Multiplying by (1 + waste) understates every costed dish slightly —
       small enough to survive review, large enough to matter across a year. */
    await api('PUT', '/recipes/BURGER', {
      lines: [{ ingredientId: 'TUNA', qty: 100, wastePct: 20 }],
    });
    const r = await api('GET', '/recipes/BURGER');
    // 100 / 0.8 = 125g × 0.085 = 10.625 → 1063 laari (rounded once, at the end)
    assert.equal(r.json.plateCost, 1063);
    assert.equal(r.json.lines[0].grossQty, 125);
  });

  test('YIELD divides — a batch that makes 8 costs an eighth a portion', async () => {
    await api('PUT', '/recipes/BURGER', {
      lines: [{ ingredientId: 'TUNA', qty: 800 }],
      yieldQty: 8,
    });
    const r = await api('GET', '/recipes/BURGER');
    // 800g × 0.085 = 68.00, over a yield of 8 = 8.50 a portion.
    assert.equal(r.json.yieldQty, 8);
    assert.equal(r.json.plateCost, 850);
  });

  test('SUB-RECIPES recurse', async () => {
    // A sauce that costs something, used by a dish.
    await api('POST', '/ingredients', { id: 'CREAM', name: 'Cream', unit: 'ml', avgCost: 0.02 });
    const sauce = await H.req('POST', `/api/outlet/${ctx.outletId}/menu`,
      { body: { id: 'SAUCE', name: 'House sauce', price: 0 }, token: mgr.token });
    assert.equal(sauce.status, 201, JSON.stringify(sauce.json));

    // 500ml of cream at 0.02 = 10.00, yielding 10 portions = 1.00 a portion.
    await api('PUT', '/recipes/SAUCE', {
      lines: [{ ingredientId: 'CREAM', qty: 500 }], yieldQty: 10,
    });
    const s = await api('GET', '/recipes/SAUCE');
    assert.equal(s.json.plateCost, 100, 'MVR 1.00 a portion');

    // COLA uses two portions of it. 2 × 1.00 = 2.00.
    await api('PUT', '/recipes/COLA', { lines: [{ subItemId: 'SAUCE', qty: 2 }] });
    const r = await api('GET', '/recipes/COLA');
    assert.equal(r.json.plateCost, 200, 'the sub-recipe cost reached the dish');
    assert.equal(r.json.lines[0].kind, 'sub');
  });

  test('THE SCREEN AND THE LEDGER AGREE', async () => {
    /* The whole reason costing.js exists as one module. Sell the dish and the
       COGS the accounts book must equal the plate cost the editor showed. */
    const shown = await api('GET', '/recipes/COLA');

    const sold = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: '27.50' }],   // 25.00 + 10% service
      },
    }]);
    const res = sold.json.results[0].result;
    assert.ok(res && res.receiptNo, JSON.stringify(sold.json.results[0]));

    const row = await H.q(ctx, 'SELECT cogs FROM sale WHERE receipt_no = $1', [res.receiptNo]);
    assert.equal(Math.round(Number(row.rows[0].cogs) * 100), shown.json.plateCost,
      'what the editor showed is what the accounts booked');

    // And the stock the sale moved is what the recipe says it eats.
    const moved = await H.q(ctx,
      "SELECT ingredient_id, sum(qty) AS qty FROM stock_move WHERE reason = 'sale'"
      + " AND ingredient_id = 'CREAM' GROUP BY ingredient_id");
    assert.equal(Number(moved.rows[0].qty), -100, '2 portions × 500ml ÷ 10 yield = 100ml');
  });

  test('an unpriced ingredient marks the dish INCOMPLETE rather than cheap', async () => {
    /* A dish costed from an ingredient nobody has priced is not a cheap dish,
       it is an unknown one, and printing a confident 100% margin is worse than
       saying so. */
    await api('POST', '/ingredients', { id: 'MYSTERY', name: 'Unpriced thing', unit: 'g' });
    await api('PUT', '/recipes/BURGER', { lines: [{ ingredientId: 'MYSTERY', qty: 10 }] });
    const r = await api('GET', '/recipes/BURGER');
    assert.equal(r.json.incomplete, true);
    assert.equal(r.json.lines[0].priced, false);
  });

  test('a dish cannot be a sub-recipe of itself', async () => {
    const r = await api('PUT', '/recipes/BURGER', { lines: [{ subItemId: 'BURGER', qty: 1 }] });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /sub-recipe of itself/i);
  });

  test('a LOOP through a sub-recipe is refused at the point somebody makes it', async () => {
    // SAUCE already uses nothing; make it use COLA, which uses SAUCE.
    const r = await api('PUT', '/recipes/SAUCE', { lines: [{ subItemId: 'COLA', qty: 1 }] });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /would make a loop/i);
  });

  test('a line must be an ingredient or a sub-recipe, not both', async () => {
    const r = await api('PUT', '/recipes/BURGER', {
      lines: [{ ingredientId: 'TUNA', subItemId: 'SAUCE', qty: 1 }],
    });
    assert.equal(r.status, 400);
  });

  test('a zero quantity is refused', async () => {
    const r = await api('PUT', '/recipes/BURGER', { lines: [{ ingredientId: 'TUNA', qty: 0 }] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /above zero/i);
  });

  test('a bad line leaves the existing recipe intact', async () => {
    // Checks run before the delete, so a rejected save is not a wiped recipe.
    await api('PUT', '/recipes/BURGER', { lines: [{ ingredientId: 'TUNA', qty: 150 }] });
    const bad = await api('PUT', '/recipes/BURGER', {
      lines: [{ ingredientId: 'TUNA', qty: 150 }, { ingredientId: 'DOES-NOT-EXIST', qty: 1 }],
    });
    assert.equal(bad.status, 409);
    const r = await api('GET', '/recipes/BURGER');
    assert.equal(r.json.lines.length, 1, 'the good recipe survived the bad save');
  });

  test('an ingredient unit cannot change while recipes use it', async () => {
    /* A recipe line saying "150" means 150 grams. Flipping the ingredient to
       kilos silently turns every one of those into 150kg. */
    const r = await api('PATCH', '/ingredients/TUNA', { unit: 'kg' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /unit cannot change/i);
  });

  test('a price change on the INGREDIENT reprices every dish that uses it', async () => {
    // §12's promise, from the costing side: one number, every dependent dish.
    const before = await api('GET', '/recipes/BURGER');
    await api('PATCH', '/ingredients/TUNA', { avgCost: 0.17 });   // doubled
    const after = await api('GET', '/recipes/BURGER');
    /* Within a laari of double, not exactly double: the figure is rounded ONCE
       at the end, so 2 × round(x) and round(2x) legitimately differ by one when
       x lands on a half. Asserting exact doubling here would be asserting the
       rounding bug this module was written to avoid. */
    assert.ok(Math.abs(after.json.plateCost - before.json.plateCost * 2) <= 1,
      before.json.plateCost + ' → ' + after.json.plateCost);
    assert.ok(after.json.plateCost > before.json.plateCost);
  });

  test('the costed menu names the dishes that are not costed yet', async () => {
    // A dish nobody has costed — the thing this list exists to surface.
    await H.req('POST', `/api/outlet/${ctx.outletId}/menu`,
      { body: { id: 'UNCOSTED', name: 'Not costed yet', price: 40 }, token: mgr.token });

    const r = await api('GET', '/recipes');
    assert.equal(r.status, 200);
    const uncosted = r.json.items.filter((i) => i.lines === 0);
    assert.ok(uncosted.length, 'a dish with no recipe is visible as such');
    assert.ok(uncosted.some((i) => i.itemId === 'UNCOSTED'));
    const burger = r.json.items.find((i) => i.itemId === 'BURGER');
    assert.ok(burger.plateCost > 0);
    assert.ok(burger.gpPct > 0);
  });

  test('the recipe change is in the audit trail', async () => {
    const a = await H.q(ctx,
      "SELECT before, after FROM chain.audit WHERE action = 'recipe_put'"
      + ' ORDER BY at DESC LIMIT 1');
    assert.ok(a.rows.length, 'what a dish is made of is an auditable fact');
  });
});
