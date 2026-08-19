'use strict';
/* Recipes & Costing — 02-POS-SPEC.md §2 (`recipes`):
 * "Ingredients, yield, sub-recipes, waste %, live plate cost and GP."
 *
 * Two things live here: the INGREDIENT master (what the kitchen buys) and the
 * RECIPE for a menu item (what a dish is made of). The cost arithmetic itself
 * is in ./costing.js, which the sale path also calls — the screen and the
 * ledger must never be able to disagree about what a dish costs.
 *
 * A NOTE ON WHERE COST COMES FROM. `ingredient.avg_cost` is a weighted average
 * that a priced GRN maintains — 08-BUILD-STAGES §12: "A price captured on a GRN
 * updates the ingredient's average cost and therefore every dish that uses it."
 * Purchasing is a later stage, so until it lands a manager sets an opening cost
 * by hand, which is a real number they know from an invoice rather than a
 * placeholder. When GRNs arrive they take over the same column and every costed
 * dish reprices itself.
 */

const costing = require('./costing');

const UNITS = ['g', 'kg', 'ml', 'l', 'each', 'portion'];

/* ── ingredients ─────────────────────────────────────────────────────────── */

async function listIngredients(c) {
  const q = await c.query(
    'SELECT i.id, i.name, i.unit, i.on_hand, i.avg_cost, i.par, i.allergens, i.category,'
    + ' (SELECT count(*)::int FROM recipe_line r WHERE r.ingredient_id = i.id) AS used_in'
    + ' FROM ingredient i ORDER BY i.name');
  return q.rows.map((r) => ({
    id: r.id, name: r.name, unit: r.unit,
    onHand: Number(r.on_hand), avgCost: Number(r.avg_cost),
    par: r.par === null ? null : Number(r.par),
    allergens: r.allergens || [], category: r.category || null, usedIn: r.used_in,
  }));
}

function cleanIngredient(body) {
  const out = {};
  if (body.name !== undefined) {
    const v = String(body.name).trim();
    if (!v) throw Object.assign(new Error('an ingredient needs a name'), { status: 400 });
    out.name = v.slice(0, 120);
  }
  if (body.unit !== undefined) {
    const v = String(body.unit).trim();
    if (!UNITS.includes(v)) {
      throw Object.assign(new Error('unit must be one of: ' + UNITS.join(', ')), { status: 400 });
    }
    out.unit = v;
  }
  if (body.avgCost !== undefined) {
    const n = Number(body.avgCost);
    if (!Number.isFinite(n) || n < 0) {
      throw Object.assign(new Error('a cost cannot be negative'), { status: 400 });
    }
    // 4dp: cost per gram is a fraction of a laari, and rounding it to 2 would
    // make every gram-denominated ingredient cost zero.
    out.avg_cost = Math.round(n * 10000) / 10000;
  }
  if (body.par !== undefined) {
    out.par = body.par === null ? null : Math.max(0, Number(body.par) || 0);
  }
  if (body.category !== undefined) {
    // Trimmed but not normalised into a vocabulary: "Walk-in" and "walk in"
    // staying distinct is the kitchen's problem to tidy, not ours to guess at.
    const v = String(body.category || '').trim().slice(0, 60);
    out.category = v || null;
  }
  if (body.allergens !== undefined) {
    out.allergens = Array.isArray(body.allergens)
      ? body.allergens.map((a) => String(a).trim().toLowerCase()).filter(Boolean).slice(0, 20)
      : [];
  }
  return out;
}

async function createIngredient(c, body, ctx) {
  const id = String(body.id || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(id)) {
    throw Object.assign(new Error(
      'an ingredient code is up to 40 characters, A-Z, 0-9, dash or underscore'), { status: 400 });
  }
  const f = cleanIngredient(body);
  if (!f.name) throw Object.assign(new Error('an ingredient needs a name'), { status: 400 });
  if (!f.unit) throw Object.assign(new Error('an ingredient needs a unit'), { status: 400 });

  const dup = await c.query('SELECT 1 FROM ingredient WHERE id = $1', [id]);
  if (dup.rows.length) {
    throw Object.assign(new Error('an ingredient with the code ' + id + ' already exists'), { status: 409 });
  }
  await c.query(
    'INSERT INTO ingredient (id, name, unit, on_hand, avg_cost, par, allergens)'
    + ' VALUES ($1,$2,$3,0,$4,$5,$6)',
    [id, f.name, f.unit, f.avg_cost ?? 0, f.par ?? null, f.allergens ?? []]);
  await c.query("SELECT chain.log('ingredient_create','ingredient',$1,NULL,$2)",
    [id, JSON.stringify({ name: f.name, unit: f.unit, avgCost: f.avg_cost ?? 0 })]);
  return { id };
}

async function updateIngredient(c, id, body) {
  const before = await c.query(
    'SELECT id, name, unit, avg_cost, par, allergens FROM ingredient WHERE id = $1 FOR UPDATE', [id]);
  if (!before.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });

  const f = cleanIngredient(body);
  if (!Object.keys(f).length) return { id, unchanged: true };

  /* The UNIT cannot change once recipes reference it. A recipe line saying
     "150" means 150 grams; flipping the ingredient to kilos silently turns
     every one of those lines into 150kg and the dish's cost with it. Create a
     new ingredient instead — the old one keeps its history. */
  if (f.unit && f.unit !== before.rows[0].unit) {
    const used = await c.query(
      'SELECT count(*)::int AS n FROM recipe_line WHERE ingredient_id = $1', [id]);
    if (used.rows[0].n) {
      throw Object.assign(new Error(
        'the unit cannot change while ' + used.rows[0].n + ' recipe line(s) use this ingredient'
        + ' — every quantity is written in the current unit. Create a new ingredient instead.'),
      { status: 409 });
    }
  }

  const cols = [], vals = [id];
  for (const [k, v] of Object.entries(f)) { vals.push(v); cols.push(k + ' = $' + vals.length); }
  await c.query('UPDATE ingredient SET ' + cols.join(', ') + ' WHERE id = $1', vals);

  const after = await c.query(
    'SELECT id, name, unit, avg_cost, par, allergens FROM ingredient WHERE id = $1', [id]);
  await c.query("SELECT chain.log('ingredient_update','ingredient',$1,$2,$3)",
    [id, JSON.stringify(before.rows[0]), JSON.stringify(after.rows[0])]);
  return { id, ...after.rows[0] };
}

/* ── recipes ─────────────────────────────────────────────────────────────── */

/** A dish's recipe, its live plate cost and its GP. */
async function recipeFor(c, itemId, taxRatePct) {
  const it = await c.query(
    'SELECT id, name, price, yield_qty FROM item WHERE id = $1', [itemId]);
  if (!it.rows.length) throw Object.assign(new Error('no such dish'), { status: 404 });

  const cost = await costing.itemCost(c, itemId);
  const priceLaari = Math.round(Number(it.rows[0].price) * 100);
  const gp = costing.grossProfit(priceLaari, Math.round(cost.cost), taxRatePct);

  return {
    itemId, name: it.rows[0].name,
    price: priceLaari,
    yieldQty: Number(it.rows[0].yield_qty),
    lines: cost.lines,
    plateCost: Math.round(cost.cost),
    incomplete: cost.incomplete,
    ...gp,
  };
}

/** Replace a dish's recipe wholesale. One transaction: a half-written recipe
 *  would cost the next sale a wrong number, and there is no state in which a
 *  partially-saved recipe is useful to anybody. */
async function putRecipe(c, itemId, body, ctx) {
  const it = await c.query('SELECT id FROM item WHERE id = $1 FOR UPDATE', [itemId]);
  if (!it.rows.length) throw Object.assign(new Error('no such dish'), { status: 404 });

  const lines = Array.isArray(body.lines) ? body.lines : [];
  const clean = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error('every recipe line needs a quantity above zero'), { status: 400 });
    }
    const waste = Math.min(95, Math.max(0, Number(l.wastePct) || 0));
    const ingredientId = l.ingredientId ? String(l.ingredientId) : null;
    const subItemId = l.subItemId ? String(l.subItemId) : null;
    if (!ingredientId === !subItemId) {
      throw Object.assign(new Error(
        'a recipe line is either an ingredient or a sub-recipe, not both and not neither'),
      { status: 400 });
    }
    /* A dish cannot be an ingredient of itself. The costing walk survives a
       cycle, but a recipe that reaches itself is a mistake worth refusing at
       the point somebody makes it rather than absorbing quietly. */
    if (subItemId === itemId) {
      throw Object.assign(new Error('a dish cannot be a sub-recipe of itself'), { status: 409 });
    }
    clean.push({ ingredientId, subItemId, qty, waste });
  }

  // Referential checks up front, so a bad line does not half-apply.
  for (const l of clean) {
    if (l.ingredientId) {
      const q = await c.query('SELECT 1 FROM ingredient WHERE id = $1', [l.ingredientId]);
      if (!q.rows.length) {
        throw Object.assign(new Error('unknown ingredient: ' + l.ingredientId), { status: 409 });
      }
    } else {
      const q = await c.query('SELECT 1 FROM item WHERE id = $1', [l.subItemId]);
      if (!q.rows.length) {
        throw Object.assign(new Error('unknown sub-recipe: ' + l.subItemId), { status: 409 });
      }
      // Would this create a loop? Ask the costing walk, which knows the graph.
      const reaches = await reachesItem(c, l.subItemId, itemId);
      if (reaches) {
        throw Object.assign(new Error(
          l.subItemId + ' already uses this dish, so adding it would make a loop'), { status: 409 });
      }
    }
  }

  const before = await c.query(
    'SELECT ingredient_id, sub_item_id, qty, waste_pct FROM recipe_line WHERE item_id = $1', [itemId]);

  await c.query('DELETE FROM recipe_line WHERE item_id = $1', [itemId]);
  for (const l of clean) {
    await c.query(
      'INSERT INTO recipe_line (item_id, ingredient_id, sub_item_id, qty, waste_pct)'
      + ' VALUES ($1,$2,$3,$4,$5)',
      [itemId, l.ingredientId, l.subItemId, l.qty, l.waste]);
  }

  if (body.yieldQty !== undefined) {
    const y = Number(body.yieldQty);
    if (!Number.isFinite(y) || y <= 0) {
      throw Object.assign(new Error('yield must be greater than zero'), { status: 400 });
    }
    await c.query('UPDATE item SET yield_qty = $2 WHERE id = $1', [itemId, y]);
  }

  await c.query("SELECT chain.log('recipe_put','item',$1,$2,$3)",
    [itemId, JSON.stringify(before.rows), JSON.stringify(clean)]);
  return { itemId, lines: clean.length };
}

/** Does `from` reach `target` through its recipe tree? Bounded by the same
 *  depth the costing walk uses, so the two agree about what is reachable. */
async function reachesItem(c, from, target, depth, seen) {
  depth = depth || 0;
  seen = seen || new Set();
  if (depth > costing.MAX_DEPTH || seen.has(from)) return false;
  if (from === target) return true;
  seen.add(from);
  const q = await c.query(
    'SELECT sub_item_id FROM recipe_line WHERE item_id = $1 AND sub_item_id IS NOT NULL', [from]);
  for (const r of q.rows) {
    if (await reachesItem(c, r.sub_item_id, target, depth + 1, seen)) return true;
  }
  return false;
}

/** Every dish with its cost and margin — the module's landing list, and the
 *  answer to "which dishes are not costed yet". */
async function costedMenu(c, taxRatePct) {
  const items = await c.query(
    'SELECT id, name, category, price, yield_qty FROM item WHERE active ORDER BY category NULLS LAST, name');
  const out = [];
  for (const it of items.rows) {
    const cost = await costing.itemCost(c, it.id);
    const priceLaari = Math.round(Number(it.price) * 100);
    const gp = costing.grossProfit(priceLaari, Math.round(cost.cost), taxRatePct);
    out.push({
      itemId: it.id, name: it.name, category: it.category,
      price: priceLaari, plateCost: Math.round(cost.cost),
      lines: cost.lines.length, incomplete: cost.incomplete,
      ...gp,
    });
  }
  return out;
}

module.exports = {
  listIngredients, createIngredient, updateIngredient,
  recipeFor, putRecipe, costedMenu, UNITS,
};
