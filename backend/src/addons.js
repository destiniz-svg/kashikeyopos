'use strict';
/* Add-ons — 02-POS-SPEC.md §2 (`menu`), migration 037.
 *
 * "Extra sambol, +15." One sentence, and every hard rule in this platform lands
 * on it at once, which is why it lives in one module that the till, the kitchen
 * and the sale path all call rather than three implementations that drift.
 *
 * THE TERMINAL NEVER NAMES A PRICE. A till posts add-on IDs and quantities. The
 * price comes from `modifier`, here, on the server — the same rule the dish
 * itself already follows (src/sale.js). A tablet that could send "double
 * portion, 0.00" is not a price list, it is a suggestion.
 *
 * AN ADD-ON HAS TO BE OFFERED BEFORE IT CAN BE ORDERED. A dish inherits the
 * add-ons published to its section unless it names its own (`item.addons_own`).
 * Anything outside that answer is refused rather than silently dropped: a guest
 * phone that could post `mo3` against a dessert would print a docket line the
 * kitchen has no pass for, and the guest would be charged for it.
 *
 * QUANTITY IS PER DISH UNIT. Two curries with one extra sambol each is
 * `qty: 2` on the dish and `qty: 1` on the add-on — the extra folds into the
 * unit price, so every figure downstream (line total, tax, service, the
 * receipt) stays the arithmetic it already was. Making it per line instead
 * would have meant a second money path through the whole chain.
 */

/** Everything sellable as an add-on right now, in the merchant's own order. */
async function catalogue(c) {
  const q = await c.query(
    'SELECT id, name, price, sections, active, sort, recipe_item_id'
    + ' FROM modifier ORDER BY sort, name');
  return q.rows;
}

/**
 * Which add-ons each of these dishes offers.
 *
 * `items` are rows carrying at least id, category and addons_own. Returns a
 * Map from item id to the modifier rows offered on it, so a caller that
 * already has the dishes does not go back to the database per line.
 */
async function offeredFor(c, items) {
  const out = new Map();
  if (!items || !items.length) return out;

  const all = await catalogue(c);
  const active = all.filter((m) => m.active);
  const byId = new Map(active.map((m) => [m.id, m]));

  /* Only the dishes that name their own need the link table, and most outlets
     will have none — a section-wide add-on is the normal case and the whole
     reason the inheritance exists. */
  const own = items.filter((i) => i.addons_own).map((i) => i.id);
  const named = new Map();
  if (own.length) {
    const q = await c.query(
      'SELECT item_id, modifier_id FROM item_modifier WHERE item_id = ANY($1)', [own]);
    for (const r of q.rows) {
      if (!named.has(r.item_id)) named.set(r.item_id, []);
      const m = byId.get(r.modifier_id);
      if (m) named.get(r.item_id).push(m);
    }
  }

  for (const it of items) {
    if (it.addons_own) {
      /* Named-none is a real answer, distinct from inheriting: "this dish takes
         no add-ons" is a decision somebody made, and an empty array is how it
         survives a round trip. */
      out.set(it.id, named.get(it.id) || []);
    } else {
      const cat = it.category;
      out.set(it.id, cat ? active.filter((m) => (m.sections || []).includes(cat)) : []);
    }
  }
  return out;
}

/**
 * Price one line's add-on picks against what that dish actually offers.
 *
 * `picks` is what the terminal sent: [{ id, qty }] — ids and counts, nothing
 * else. `offered` is that dish's answer from offeredFor(). Returns the rows to
 * store on the ticket line and the per-unit extra in MVR, or throws on anything
 * that was never on offer.
 */
function priceLine(picks, offered, dishName) {
  /* The type check comes FIRST. Testing `.length` before `Array.isArray` let a
     string through — "abc" has a length of 3 and iterates to characters — and a
     terminal that sent one would have been answered with a confusing
     "that add-on is not offered" instead of "add-ons are a list". */
  if (picks === undefined || picks === null) return { addons: [], extra: 0 };
  if (!Array.isArray(picks)) {
    throw Object.assign(new Error('add-ons must be a list'), { status: 400 });
  }
  if (!picks.length) return { addons: [], extra: 0 };
  const byId = new Map((offered || []).map((m) => [m.id, m]));
  const chosen = new Map();

  for (const p of picks) {
    const id = String((p && p.id) || '');
    if (!id) continue;
    const m = byId.get(id);
    if (!m) {
      throw Object.assign(
        new Error('that add-on is not offered on ' + dishName), { status: 409 });
    }
    /* A pick with no quantity means one. A pick of nought means the guest
       stepped it back down to nothing and the phone still sent the row —
       that is not an error, it is just not an add-on. */
    const n = p.qty === undefined ? 1 : Math.trunc(Number(p.qty));
    if (!Number.isFinite(n) || n < 0 || n > 99) {
      throw Object.assign(new Error('an add-on quantity must be 0 to 99'), { status: 400 });
    }
    if (!n) continue;
    chosen.set(id, (chosen.get(id) || 0) + n);
  }

  const addons = [];
  let extra = 0;
  /* Emitted in the catalogue's order rather than the order the phone happened
     to send, so two identical rounds read identically on the docket and on the
     receipt. */
  for (const m of offered) {
    const n = chosen.get(m.id);
    if (!n) continue;
    addons.push({
      id: m.id, name: m.name, price: Number(m.price), qty: n,
      /* Carried onto the line so the sale can cost it without going back to the
         catalogue — and so a bill settled after the add-on was retired still
         knows what it took out of the store. */
      recipeItemId: m.recipe_item_id || null,
    });
    extra += Number(m.price) * n;
  }
  return { addons, extra: Math.round(extra * 100) / 100 };
}

module.exports = { catalogue, offeredFor, priceLine };
