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

  /* ── the dish's face (migration 037) ────────────────────────────────────
     A blank string is stored as NULL rather than as an empty string, because
     "no description" and "a description that is nothing" are the same fact and
     the front-ends test one of them. */
  if (body.description !== undefined) {
    const v = String(body.description ?? '').trim();
    out.description = v ? v.slice(0, 400) : null;
  }
  if (body.imageUrl !== undefined) out.image_url = imageUrl(body.imageUrl);
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      throw Object.assign(new Error('tags are a list'), { status: 400 });
    }
    /* Deduplicated and lower-cased, so "Veg" and "veg" cannot both sit on one
       dish and make the guest's diet filter answer twice. */
    const seen = [];
    for (const t of body.tags) {
      const v = String(t || '').trim().toLowerCase().slice(0, 24);
      if (v && !seen.includes(v)) seen.push(v);
      if (seen.length >= 12) break;
    }
    out.tags = seen;
  }
  if (body.spice !== undefined) {
    const n = Math.trunc(Number(body.spice) || 0);
    if (!(n >= 0 && n <= 3)) {
      throw Object.assign(new Error('heat runs 0 (not spicy) to 3 (hot)'), { status: 400 });
    }
    out.spice = n;
  }
  if (body.addonsOwn !== undefined) out.addons_own = !!body.addonsOwn;
  return out;
}

/* A photograph is a URL — this platform has no object store, and a database
   that grows four megabytes per dish cannot be replicated to an edge box.
   http(s) or a path rooted at /, and nothing else: a `javascript:` or `data:`
   URL here would be stored by a manager and then rendered on a guest's phone.
   Blank means no photograph, which is a first class state — the till draws the
   section artifact instead. */
function imageUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.length > 500) {
    throw Object.assign(new Error('that image address is too long'), { status: 400 });
  }
  if (!/^(https?:\/\/|\/)/i.test(s)) {
    throw Object.assign(new Error(
      'an image address starts with https:// or with /'), { status: 400 });
  }
  return s;
}

/** Every item, including the inactive ones — this is the editor, not the till.
 *  Carries `sold` so a manager can see what a dish has actually done before
 *  they take it off, and `recipeLines` so "costed / not costed" is visible
 *  without opening each one. */
async function list(c) {
  const q = await c.query(
    'SELECT i.id, i.name, i.category, i.price, i.station, i.yield_qty, i.active, i.off_menu,'
    + ' i.description, i.image_url, i.tags, i.spice, i.addons_own,'
    + ' (SELECT count(*)::int FROM recipe_line r WHERE r.item_id = i.id) AS recipe_lines,'
    + ' (SELECT coalesce(sum(l.qty),0) FROM sale_line l WHERE l.item_id = i.id) AS sold,'
    + ' (SELECT coalesce(array_agg(m.modifier_id ORDER BY m.modifier_id), ARRAY[]::text[])'
    + '    FROM item_modifier m WHERE m.item_id = i.id) AS addon_ids'
    + ' FROM item i ORDER BY i.active DESC, i.category NULLS LAST, i.name');
  return q.rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, price: r.price,
    station: r.station, yieldQty: Number(r.yield_qty), active: r.active,
    offMenu: r.off_menu, recipeLines: r.recipe_lines, sold: Number(r.sold),
    description: r.description, imageUrl: r.image_url, tags: r.tags || [],
    spice: r.spice, addonsOwn: r.addons_own, addonIds: r.addon_ids || [],
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
    'INSERT INTO item (id, name, category, price, station, yield_qty, active, off_menu,'
    + ' description, image_url, tags, spice, addons_own)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12)',
    [id, f.name, f.category ?? null, f.price, f.station ?? null, f.yield_qty ?? 1,
      f.off_menu ?? false, f.description ?? null, f.image_url ?? null,
      f.tags ?? [], f.spice ?? 0, f.addons_own ?? false]);
  if (body.addonIds !== undefined) await setDishAddons(c, id, body.addonIds);

  await c.query("SELECT chain.log('menu_create','item',$1,NULL,$2)",
    [id, JSON.stringify({ name: f.name, price: f.price, category: f.category ?? null })]);
  return { id };
}

async function update(c, id, body, ctx) {
  const before = await c.query(
    'SELECT id, name, category, price, station, yield_qty, active, off_menu,'
    + ' description, image_url, tags, spice, addons_own'
    + ' FROM item WHERE id = $1 FOR UPDATE', [id]);
  if (!before.rows.length) throw Object.assign(new Error('no such dish'), { status: 404 });

  const f = clean(body);
  if (body.addonIds !== undefined) await setDishAddons(c, id, body.addonIds);
  if (!Object.keys(f).length) return { id, unchanged: true };
  await assertStation(c, ctx.outletId, f.station);

  /* Build the SET list from the fields actually sent, so a form that edits the
     price cannot blank a category it never showed. */
  const cols = [], vals = [id];
  for (const [k, v] of Object.entries(f)) { vals.push(v); cols.push(k + ' = $' + vals.length); }
  await c.query('UPDATE item SET ' + cols.join(', ') + ' WHERE id = $1', vals);

  const after = await c.query(
    'SELECT id, name, category, price, station, yield_qty, active, off_menu,'
    + ' description, image_url, tags, spice, addons_own'
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

/* ── which add-ons THIS dish names ─────────────────────────────────────────
   Replaced whole rather than diffed: the editor shows every add-on with a tick
   and saves the ticked set, so a half-applied diff is a state the merchant
   never asked for. Naming an empty set is a real answer and is why
   `addons_own` exists alongside these rows — see migration 037. */
async function setDishAddons(c, itemId, ids) {
  if (!Array.isArray(ids)) {
    throw Object.assign(new Error('add-ons are a list of ids'), { status: 400 });
  }
  const want = [...new Set(ids.map((x) => String(x || '').trim()).filter(Boolean))];
  if (want.length) {
    const q = await c.query('SELECT id FROM modifier WHERE id = ANY($1)', [want]);
    const have = new Set(q.rows.map((r) => r.id));
    for (const id of want) {
      if (!have.has(id)) {
        throw Object.assign(new Error('no such add-on: ' + id), { status: 409 });
      }
    }
  }
  await c.query('DELETE FROM item_modifier WHERE item_id = $1', [itemId]);
  for (const m of want) {
    await c.query('INSERT INTO item_modifier (item_id, modifier_id) VALUES ($1,$2)',
      [itemId, m]);
  }
}

// ── sections ───────────────────────────────────────────────────────────────
/* A SECTION IS THE TEXT ON THE DISH, plus a row of presentation if anyone has
   chosen one. That is why this lists what the dishes actually say rather than
   what the table holds: a section nobody has styled still exists, still needs a
   chip on the till, and must not disappear because no one opened this editor.
   Empty is a first class state (docs/10-NO-DEMO-DATA.md). */
async function sections(c) {
  const q = await c.query(
    'SELECT s.name, s.color, s.icon, s.station, s.sort, s.hidden,'
    + ' (SELECT count(*)::int FROM item i WHERE i.active AND i.category = s.name) AS dishes'
    + ' FROM menu_section s'
    + ' UNION ALL'
    + " SELECT DISTINCT i.category, NULL, NULL, NULL, 1000, false,"
    + '   (SELECT count(*)::int FROM item x WHERE x.active AND x.category = i.category)'
    + ' FROM item i'
    + ' WHERE i.category IS NOT NULL'
    + '   AND NOT EXISTS (SELECT 1 FROM menu_section s2 WHERE s2.name = i.category)'
    + ' ORDER BY 5, 1');
  return q.rows.map((r) => ({
    name: r.name, color: r.color, icon: r.icon, station: r.station,
    sort: r.sort, hidden: r.hidden, dishes: r.dishes,
  }));
}

const HEX = /^#[0-9a-f]{6}$/i;

async function saveSection(c, name, body, ctx) {
  const key = String(name || '').trim().slice(0, 60);
  if (!key) throw Object.assign(new Error('a section needs a name'), { status: 400 });

  const f = {};
  if (body.color !== undefined) {
    const v = String(body.color ?? '').trim();
    if (v && !HEX.test(v)) {
      throw Object.assign(new Error('a section colour is a hex value like #b8431d'), { status: 400 });
    }
    f.color = v || null;
  }
  if (body.icon !== undefined) {
    const v = String(body.icon ?? '').trim().toLowerCase().slice(0, 24);
    f.icon = v || null;
  }
  if (body.station !== undefined) {
    const v = body.station === null ? null : String(body.station).trim().slice(0, 60) || null;
    await assertStation(c, ctx.outletId, v);
    f.station = v;
  }
  if (body.sort !== undefined) f.sort = Math.trunc(Number(body.sort) || 0);
  if (body.hidden !== undefined) f.hidden = !!body.hidden;

  const before = await c.query('SELECT * FROM menu_section WHERE name = $1', [key]);
  const cols = ['name', ...Object.keys(f)];
  const vals = [key, ...Object.values(f)];
  const set = Object.keys(f).map((k, i) => k + ' = $' + (i + 2));
  await c.query(
    'INSERT INTO menu_section (' + cols.join(', ') + ')'
    + ' VALUES (' + cols.map((_, i) => '$' + (i + 1)).join(', ') + ')'
    + (set.length ? ' ON CONFLICT (name) DO UPDATE SET ' + set.join(', ')
      : ' ON CONFLICT (name) DO NOTHING'),
    vals);

  /* RENAMING MOVES THE DISHES WITH IT, in this transaction. A section renamed
     on its own would leave every dish pointing at a name that no longer has a
     row — the colour, the icon and the station would silently revert and a
     merchant would be told nothing. */
  if (body.renameTo !== undefined) {
    const to = String(body.renameTo || '').trim().slice(0, 60);
    if (!to) throw Object.assign(new Error('rename it to what?'), { status: 400 });
    if (to !== key) {
      const clash = await c.query('SELECT 1 FROM menu_section WHERE name = $1', [to]);
      if (clash.rows.length) {
        throw Object.assign(new Error('there is already a section called ' + to), { status: 409 });
      }
      await c.query('UPDATE menu_section SET name = $2 WHERE name = $1', [key, to]);
      await c.query('UPDATE item SET category = $2 WHERE category = $1', [key, to]);
      await c.query('UPDATE modifier SET sections = array_replace(sections, $1, $2)', [key, to]);
    }
  }

  const after = await c.query('SELECT * FROM menu_section WHERE name = $1',
    [body.renameTo ? String(body.renameTo).trim().slice(0, 60) : key]);
  await c.query("SELECT chain.log('menu_section_save','menu_section',$1,$2,$3)",
    [key, JSON.stringify(before.rows[0] || null), JSON.stringify(after.rows[0] || null)]);
  return after.rows[0] || { name: key };
}

/** Drop a section's styling. The dishes keep the section — they just stop
 *  having a colour anybody chose, which is where every section starts. */
async function dropSection(c, name) {
  const key = String(name || '').trim();
  const q = await c.query('DELETE FROM menu_section WHERE name = $1 RETURNING name', [key]);
  if (!q.rows.length) throw Object.assign(new Error('no such section'), { status: 404 });
  await c.query("SELECT chain.log('menu_section_drop','menu_section',$1,$2,NULL)",
    [key, JSON.stringify({ name: key })]);
  return { name: key, dropped: true };
}

// ── add-ons ────────────────────────────────────────────────────────────────
/** The catalogue, with how many dishes actually offer each one — the figure
 *  that tells a merchant whether repricing this will touch one dish or forty. */
async function modifiers(c) {
  const q = await c.query(
    'SELECT m.id, m.name, m.price, m.sections, m.active, m.sort, m.recipe_item_id,'
    + ' (SELECT i.name FROM item i WHERE i.id = m.recipe_item_id) AS recipe_item_name,'
    + ' (SELECT count(*)::int FROM item i WHERE i.active AND ('
    + '    CASE WHEN i.addons_own'
    + '      THEN EXISTS (SELECT 1 FROM item_modifier x'
    + '                    WHERE x.item_id = i.id AND x.modifier_id = m.id)'
    + '      ELSE i.category = ANY(m.sections) END)) AS dishes'
    + ' FROM modifier m ORDER BY m.sort, m.name');
  return q.rows.map((r) => ({
    id: r.id, name: r.name, price: r.price, sections: r.sections || [],
    active: r.active, sort: r.sort, dishes: r.dishes,
    recipeItemId: r.recipe_item_id, recipeItemName: r.recipe_item_name,
  }));
}

async function cleanModifier(c, body) {
  const out = {};
  if (body.name !== undefined) {
    const v = String(body.name).trim();
    if (!v) throw Object.assign(new Error('an add-on needs a name'), { status: 400 });
    out.name = v.slice(0, 80);
  }
  if (body.price !== undefined) {
    const n = Number(body.price);
    if (!Number.isFinite(n) || n < 0) {
      throw Object.assign(new Error('an add-on price cannot be negative'), { status: 400 });
    }
    /* Nought is allowed and is not the same as unset: "no ice" is a real
       add-on that prints on the docket and costs the guest nothing. */
    out.price = Math.round(n * 100) / 100;
  }
  if (body.sections !== undefined) {
    if (!Array.isArray(body.sections)) {
      throw Object.assign(new Error('sections are a list'), { status: 400 });
    }
    const seen = [];
    for (const x of body.sections) {
      const v = String(x || '').trim().slice(0, 60);
      if (v && !seen.includes(v)) seen.push(v);
    }
    out.sections = seen;
  }
  if (body.active !== undefined) out.active = !!body.active;
  if (body.sort !== undefined) out.sort = Math.trunc(Number(body.sort) || 0);
  if (body.recipeItemId !== undefined) {
    const v = String(body.recipeItemId ?? '').trim();
    if (v) {
      const q = await c.query('SELECT 1 FROM item WHERE id = $1', [v]);
      if (!q.rows.length) {
        throw Object.assign(new Error('no dish with the code ' + v), { status: 409 });
      }
    }
    out.recipe_item_id = v || null;
  }
  return out;
}

async function createModifier(c, body) {
  const id = String(body.id || '').trim().toUpperCase();
  if (!SLUG.test(id)) {
    throw Object.assign(new Error(
      'an add-on code is up to 40 characters, A-Z, 0-9, dash or underscore'), { status: 400 });
  }
  const f = await cleanModifier(c, body);
  if (!f.name) throw Object.assign(new Error('an add-on needs a name'), { status: 400 });

  const dup = await c.query('SELECT 1 FROM modifier WHERE id = $1', [id]);
  if (dup.rows.length) {
    throw Object.assign(new Error('an add-on with the code ' + id + ' already exists'), { status: 409 });
  }
  await c.query(
    'INSERT INTO modifier (id, name, price, sections, active, sort, recipe_item_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, f.name, f.price ?? 0, f.sections ?? [], f.active ?? true, f.sort ?? 0,
      f.recipe_item_id ?? null]);
  await c.query("SELECT chain.log('menu_addon_create','modifier',$1,NULL,$2)",
    [id, JSON.stringify({ name: f.name, price: f.price ?? 0, sections: f.sections ?? [] })]);
  return { id };
}

async function updateModifier(c, id, body) {
  const before = await c.query('SELECT * FROM modifier WHERE id = $1 FOR UPDATE', [id]);
  if (!before.rows.length) throw Object.assign(new Error('no such add-on'), { status: 404 });
  const f = await cleanModifier(c, body);
  if (!Object.keys(f).length) return { id, unchanged: true };

  const vals = [id];
  const cols = Object.entries(f).map(([k, v]) => { vals.push(v); return k + ' = $' + vals.length; });
  await c.query('UPDATE modifier SET ' + cols.join(', ') + ' WHERE id = $1', vals);
  const after = await c.query('SELECT * FROM modifier WHERE id = $1', [id]);

  /* Before and after, like a dish price, and for the same reason: an add-on is
     money, it is charged on every order that carries it, and "who moved it and
     from what" has to be answerable. */
  await c.query("SELECT chain.log('menu_addon_update','modifier',$1,$2,$3)",
    [id, JSON.stringify(before.rows[0]), JSON.stringify(after.rows[0])]);
  return after.rows[0];
}

/** Retire an add-on. Deactivates rather than deletes, exactly like a dish: an
 *  open tab that already carries one still has to be settleable, and the sale
 *  path keeps taking it (src/sale.js). */
async function retireModifier(c, id) {
  const q = await c.query(
    'UPDATE modifier SET active = false WHERE id = $1 AND active RETURNING id, name', [id]);
  if (!q.rows.length) {
    const exists = await c.query('SELECT 1 FROM modifier WHERE id = $1', [id]);
    if (!exists.rows.length) throw Object.assign(new Error('no such add-on'), { status: 404 });
    return { id, alreadyRetired: true };
  }
  await c.query("SELECT chain.log('menu_addon_retire','modifier',$1,$2,NULL)",
    [id, JSON.stringify({ name: q.rows[0].name })]);
  return { id, retired: true };
}

module.exports = {
  list, create, update, retire, stations,
  sections, saveSection, dropSection,
  modifiers, createModifier, updateModifier, retireModifier,
};
