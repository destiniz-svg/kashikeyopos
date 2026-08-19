'use strict';
/* Menu Master — 02-POS-SPEC.md §2 (`menu`), the module every other one waits on.
 *
 * Until this existed a menu could only be inserted with SQL, so nothing else in
 * the system had anything to work on: no dish to ring, no recipe to cost, no
 * line for the kitchen to cook.
 *
 * SCOPE, STATED PLAINLY. §2 calls this "chain price list with per-outlet
 * overrides". The data model does not have a chain price list — 05-DATA-MODEL
 * §1 says the chain schema holds identity and configuration and "no
 * transactional data", and `item` lives in the OUTLET schema, which is also
 * where every reader of it looks (the sale path, the snapshot, the KDS, the
 * guest portal). So this manages an outlet's own menu, completely. A chain
 * master that outlets inherit and override is a real feature and a separate
 * one: you cannot have an override before you have the thing being overridden.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE.
 *
 * 1. AN ITEM IS NEVER DELETED. sale_line and recipe_line both point at item_id,
 *    and a sale from March must still say what it sold. Removing a dish
 *    deactivates it, which takes it off the till and the guest menu and leaves
 *    every historical row intact. The outlet role holds no DELETE on the
 *    financial tables anyway, but the rule belongs here where somebody reads it.
 *
 * 2. A PRICE CHANGE IS NOT RETROSPECTIVE. sale_line captures unit_price at the
 *    moment of sale, so repricing a dish tomorrow cannot restate what a guest
 *    paid today. That is a property of the schema rather than of this code, and
 *    there is a test pinning it, because it is the kind of property that gets
 *    quietly broken by a well-meaning join.
 */

const SLUG = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

function clean(body) {
  const out = {};
  if (body.name !== undefined) {
    const v = String(body.name).trim();
    if (!v) throw Object.assign(new Error('a dish needs a name'), { status: 400 });
    out.name = v.slice(0, 120);
  }
  if (body.category !== undefined) {
    out.category = body.category === null ? null : String(body.category).trim().slice(0, 60) || null;
  }
  if (body.price !== undefined) {
    const n = Number(body.price);
    if (!Number.isFinite(n) || n < 0) {
      throw Object.assign(new Error('a price cannot be negative'), { status: 400 });
    }
    // Money is two decimals. Accepting 12.999 here would round somewhere later,
    // and "somewhere later" is how a menu price and a bill disagree by a laari.
    out.price = Math.round(n * 100) / 100;
  }
  if (body.station !== undefined) {
    out.station = body.station === null ? null : String(body.station).trim().slice(0, 60) || null;
  }
  if (body.yieldQty !== undefined) {
    const n = Number(body.yieldQty);
    if (!Number.isFinite(n) || n <= 0) {
      throw Object.assign(new Error('yield must be greater than zero'), { status: 400 });
    }
    out.yield_qty = n;
  }
  if (body.offMenu !== undefined) out.off_menu = !!body.offMenu;
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

/** Every item, including the inactive ones — this is the editor, not the till.
 *  Carries `sold` so a manager can see what a dish has actually done before
 *  they take it off, and `recipeLines` so "costed / not costed" is visible
 *  without opening each one. */
async function list(c) {
  const q = await c.query(
    'SELECT i.id, i.name, i.category, i.price, i.station, i.yield_qty, i.active, i.off_menu,'
    + ' (SELECT count(*)::int FROM recipe_line r WHERE r.item_id = i.id) AS recipe_lines,'
    + ' (SELECT coalesce(sum(l.qty),0) FROM sale_line l WHERE l.item_id = i.id) AS sold'
    + ' FROM item i ORDER BY i.active DESC, i.category NULLS LAST, i.name');
  return q.rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, price: r.price,
    station: r.station, yieldQty: Number(r.yield_qty), active: r.active,
    offMenu: r.off_menu, recipeLines: r.recipe_lines, sold: Number(r.sold),
  }));
}

async function create(c, body, ctx) {
  const id = String(body.id || '').trim().toUpperCase();
  if (!SLUG.test(id)) {
    throw Object.assign(new Error(
      'a dish code is up to 40 characters, A-Z, 0-9, dash or underscore'), { status: 400 });
  }
  const f = clean(body);
  if (!f.name) throw Object.assign(new Error('a dish needs a name'), { status: 400 });
  if (f.price === undefined) throw Object.assign(new Error('a dish needs a price'), { status: 400 });

  await assertStation(c, ctx.outletId, f.station);

  const dup = await c.query('SELECT 1 FROM item WHERE id = $1', [id]);
  if (dup.rows.length) {
    /* Not an upsert. A code that already exists is either a typo or a dish
       somebody deactivated, and silently overwriting the second one would
       rewrite the name on every historical sale line that points at it. */
    throw Object.assign(new Error('a dish with the code ' + id + ' already exists'), { status: 409 });
  }

  await c.query(
    'INSERT INTO item (id, name, category, price, station, yield_qty, active, off_menu)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,true,$7)',
    [id, f.name, f.category ?? null, f.price, f.station ?? null, f.yield_qty ?? 1, f.off_menu ?? false]);

  await c.query("SELECT chain.log('menu_create','item',$1,NULL,$2)",
    [id, JSON.stringify({ name: f.name, price: f.price, category: f.category ?? null })]);
  return { id };
}

async function update(c, id, body, ctx) {
  const before = await c.query(
    'SELECT id, name, category, price, station, yield_qty, active, off_menu'
    + ' FROM item WHERE id = $1 FOR UPDATE', [id]);
  if (!before.rows.length) throw Object.assign(new Error('no such dish'), { status: 404 });

  const f = clean(body);
  if (!Object.keys(f).length) return { id, unchanged: true };
  await assertStation(c, ctx.outletId, f.station);

  /* Build the SET list from the fields actually sent, so a form that edits the
     price cannot blank a category it never showed. */
  const cols = [], vals = [id];
  for (const [k, v] of Object.entries(f)) { vals.push(v); cols.push(k + ' = $' + vals.length); }
  await c.query('UPDATE item SET ' + cols.join(', ') + ' WHERE id = $1', vals);

  const after = await c.query(
    'SELECT id, name, category, price, station, yield_qty, active, off_menu'
    + ' FROM item WHERE id = $1', [id]);

  /* Before AND after, because a price change is the single most disputed edit
     in a restaurant and "who put it up, and from what" has to be answerable. */
  await c.query("SELECT chain.log('menu_update','item',$1,$2,$3)",
    [id, JSON.stringify(before.rows[0]), JSON.stringify(after.rows[0])]);
  return { id, ...after.rows[0] };
}

/** Take a dish off. Deactivates — see the header. */
async function retire(c, id) {
  const q = await c.query(
    'UPDATE item SET active = false WHERE id = $1 AND active RETURNING id, name', [id]);
  if (!q.rows.length) {
    const exists = await c.query('SELECT 1 FROM item WHERE id = $1', [id]);
    if (!exists.rows.length) throw Object.assign(new Error('no such dish'), { status: 404 });
    return { id, alreadyRetired: true };
  }
  await c.query("SELECT chain.log('menu_retire','item',$1,$2,NULL)",
    [id, JSON.stringify({ name: q.rows[0].name })]);
  return { id, retired: true };
}

/** A station has to be one this outlet runs. Routing a dish to "Gril" (typo)
 *  would send it to the pass forever with nobody able to see why. */
async function assertStation(c, outletId, station) {
  if (!station) return;
  const q = await c.query(
    'SELECT 1 FROM chain.station WHERE outlet_id = $1 AND name = $2 AND active',
    [outletId, station]);
  if (!q.rows.length) {
    throw Object.assign(new Error('this outlet has no station called "' + station + '"'), { status: 409 });
  }
}

/** The outlet's stations, for the editor's dropdown. */
async function stations(c, outletId) {
  const q = await c.query(
    'SELECT name, target_mins, sort FROM chain.station'
    + ' WHERE outlet_id = $1 AND active ORDER BY sort, name', [outletId]);
  return q.rows;
}

module.exports = { list, create, update, retire, stations };
