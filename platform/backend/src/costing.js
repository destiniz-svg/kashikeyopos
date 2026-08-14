'use strict';
/* Recipe costing — the ONE implementation.
 *
 * WHY IT MOVED OUT OF sale.js. The sale path costs a dish at the moment it
 * sells, and Recipes & Costing shows a manager what a dish costs while they
 * edit it. Written twice, those two drift — and the way they drift is that the
 * screen says 31% food cost while the ledger books 38%, with nothing to point
 * at. So the screen and the ledger call the same function, and a change to the
 * costing rules reaches both or neither.
 *
 * THE RULES, and each one is a way food cost is commonly got wrong:
 *
 * · YIELD. A sauce recipe that makes 8 portions costs an eighth per portion.
 *   `item.yield_qty` divides. Forgetting it is the classic way food cost comes
 *   out eight times too high and a kitchen is told its margins are impossible.
 *
 * · WASTE IS A YIELD LOSS, NOT A SURCHARGE. Needing 100g of a trim at 10%
 *   waste means BUYING 111g, so the cost divides by (1 − waste). Multiplying by
 *   (1 + waste) gives 110g and understates every costed dish slightly — small
 *   enough to survive review, large enough to matter across a year.
 *
 * · SUB-RECIPES RECURSE. A curry uses a sauce that uses a stock. Costing only
 *   the top level reports a curry made of nothing.
 *
 * · A CYCLE IS DATA, NOT A CRASH. A recipe that reaches itself is somebody's
 *   mistake, and it must cost the dish a wrong number rather than take the
 *   process down mid-service. Depth-bounded and seen-guarded.
 *
 * Costs are LAARI throughout (MVR × 100) — see packages/money. `avg_cost` on
 * the ingredient is MVR per unit, so it converts once, here.
 */

const MAX_DEPTH = 8;

/**
 * What one unit of an item costs to make, in laari.
 * Returns { cost, lines, incomplete } — `lines` is the breakdown a manager
 * reads, `incomplete` is true when something in the tree has no cost or the
 * walk was cut short, so a screen can say "this figure is not the whole story"
 * instead of printing a confident wrong number.
 */
async function itemCost(c, itemId, seen, depth) {
  seen = seen || new Set();
  depth = depth || 0;
  if (depth > MAX_DEPTH || seen.has(itemId)) {
    return { cost: 0, lines: [], incomplete: true };
  }
  seen.add(itemId);

  const it = await c.query('SELECT yield_qty FROM item WHERE id = $1', [itemId]);
  const yieldQty = it.rows.length ? Number(it.rows[0].yield_qty) || 1 : 1;

  const rows = await c.query(
    'SELECT r.id, r.ingredient_id, r.sub_item_id, r.qty, r.waste_pct,'
    + ' i.name AS ingredient_name, i.unit, i.avg_cost,'
    + ' s.name AS sub_name'
    + ' FROM recipe_line r'
    + ' LEFT JOIN ingredient i ON i.id = r.ingredient_id'
    + ' LEFT JOIN item s ON s.id = r.sub_item_id'
    + ' WHERE r.item_id = $1 ORDER BY r.id', [itemId]);

  let total = 0, incomplete = false;
  const lines = [];

  for (const l of rows.rows) {
    const wastePct = Number(l.waste_pct) || 0;
    // Guarded at 95%: a 100% waste line would divide by zero and a recipe that
    // wastes everything is a typo, not a costing.
    const grossQty = Number(l.qty) / (1 - Math.min(0.95, wastePct / 100));

    if (l.ingredient_id) {
      /* NOT rounded to whole laari. A cost per GRAM is a fraction of a laari —
         tuna at MVR 0.085/g is 8.5 laari, and rounding that to 9 inflates every
         gram-denominated dish by six per cent. The multiply carries the
         fraction and the figure is rounded ONCE, at the end, from the figure
         itself. */
      const unitCost = Number(l.avg_cost) * 100;               // MVR/unit → laari
      const cost = grossQty * unitCost;
      if (!unitCost) incomplete = true;    // an ingredient nobody has priced
      total += cost;
      lines.push({
        id: l.id, kind: 'ingredient', ref: l.ingredient_id, name: l.ingredient_name,
        unit: l.unit, qty: Number(l.qty), wastePct, grossQty,
        unitCost, cost: Math.round(cost), priced: unitCost > 0,
      });
    } else if (l.sub_item_id) {
      const sub = await itemCost(c, l.sub_item_id, seen, depth + 1);
      // sub.cost is already unrounded laari; keep it that way through the
      // multiply for the same reason.
      const cost = grossQty * sub.cost;
      if (sub.incomplete) incomplete = true;
      total += cost;
      lines.push({
        id: l.id, kind: 'sub', ref: l.sub_item_id, name: l.sub_name,
        unit: 'portion', qty: Number(l.qty), wastePct, grossQty,
        unitCost: sub.cost, cost: Math.round(cost), priced: !sub.incomplete,
      });
    }
  }

  seen.delete(itemId);
  return {
    cost: total / (yieldQty || 1),
    lines,
    yieldQty,
    incomplete,
  };
}

/** The ingredient quantities one unit of an item consumes, exploded through
 *  sub-recipes. Same walk, different question — the sale path moves stock with
 *  this while the ledger is costed with itemCost, and they must agree about
 *  what a dish is made of. */
async function explode(c, itemId, qty, need, depth, seen) {
  need = need || new Map();
  depth = depth || 0;
  seen = seen || new Set();
  if (depth > MAX_DEPTH || seen.has(itemId)) return need;
  seen.add(itemId);

  const it = await c.query('SELECT yield_qty FROM item WHERE id = $1', [itemId]);
  const yieldQty = it.rows.length ? Number(it.rows[0].yield_qty) || 1 : 1;
  const rows = await c.query(
    'SELECT ingredient_id, sub_item_id, qty, waste_pct FROM recipe_line WHERE item_id = $1',
    [itemId]);

  for (const l of rows.rows) {
    const wastePct = Number(l.waste_pct) || 0;
    const each = (Number(l.qty) / (1 - Math.min(0.95, wastePct / 100))) / yieldQty;
    if (l.ingredient_id) {
      need.set(l.ingredient_id, (need.get(l.ingredient_id) || 0) + each * qty);
    } else if (l.sub_item_id) {
      await explode(c, l.sub_item_id, each * qty, need, depth + 1, seen);
    }
  }
  seen.delete(itemId);
  return need;
}

/** Plate cost and gross profit for a menu item, as the editor shows them.
 *  GP is against the price NET of tax: a menu price is GST-inclusive, and
 *  measuring margin against a figure that includes the government's share
 *  flatters every dish on the menu by the tax rate. */
function grossProfit(priceLaari, costLaari, taxRatePct) {
  const r = Number(taxRatePct) / 100;
  const net = Math.round(priceLaari / (1 + r));
  if (net <= 0) return { net, gp: 0, gpPct: 0, foodCostPct: 0 };
  const gp = net - costLaari;
  return {
    net,
    gp,
    gpPct: Math.round((gp / net) * 1000) / 10,
    foodCostPct: Math.round((costLaari / net) * 1000) / 10,
  };
}

module.exports = { itemCost, explode, grossProfit, MAX_DEPTH };
