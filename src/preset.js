'use strict';

/* ── The pre-set menu ─────────────────────────────────────────────────────────
   A store owner opening their first outlet chooses between an empty menu and
   this: the full Maldivian café catalogue — 9 sections, 112 add-ons, 8
   bought-in counter items with their suppliers, and 301 dishes carrying their
   tags, heat, add-on links and buy links.

   The data is `src/data/preset-menu.json`, extracted from a real outlet's own
   tables AFTER the catalogue had been driven through the shipped CSV import —
   so what ships is the state the import provably lands, not a second reading
   of the source file. It is applied by replaying ordinary ops through the SAME
   handlers in `src/apply.js` that every till write goes through: the same
   validation, the same allergen re-declaration, the same "silence preserves"
   rules. A bespoke loader would be a second way to write a dish, and the two
   would drift the first time either changed — the rule `src/setup.js` already
   keeps for a store's own setup file.

   THE ORDER IS THE APPLY ORDER, and it is not negotiable (the reconcileCats
   lesson, one layer down): suppliers before the dishes whose buy links name
   them, sections before the dishes that sit in them (`item_category_id_fkey`),
   add-on GROUPS before the dishes whose links reference them, and stock items
   before the buy links that resolve them — dish_upsert refuses an unknown
   stock item by name.

   Idempotent by construction: every kind here is an upsert keyed by the row's
   own id (suppliers by name), so applying the preset twice converges rather
   than duplicating — which is what makes "try it again" a safe instruction
   after a partial apply. */

const CATALOGUE = require('./data/preset-menu.json');

/* Which pre-set dishes name each add-on — 1,334 links across 96 of the 112
   options, derived from the shipped dishes rather than held as a second list
   that could disagree with them. Only the ADD-ONS-ONLY load carries these; see
   presetOps below for why the whole-catalogue load must not. */
function linksByAddon() {
  const by = {};
  for (const d of CATALOGUE.dishes) {
    for (const a of (d.addons || [])) (by[a] = by[a] || []).push(d.id);
  }
  return by;
}

/* The ops, in apply order. Payloads are handed to the handlers as-is; the
   composition happens once, at extraction, never here.

   `part` is 'all' (the whole catalogue — the onboarding choice, and Menu
   Master's action on a store that is still empty) or 'addons'.

   WHY 'addons' EXISTS. The whole-catalogue load is drawn only while a store's
   menu is still small, because on a mature store a 300-dish load is a decision
   for the import screen, not a header tap — and it would be a destructive one,
   since `dish_upsert` is exhaustive and would put the shipped name, price and
   description back over whatever the store has since typed. So a store that
   arrived at its menu any other way — the CSV import, or a build from before
   the add-ons were in this file — had NO WAY AT ALL to get the 112 add-ons,
   and Menu Master read "Add-ons · 0" for ever with nothing on screen to do
   about it. Reported exactly that way.

   'addons' is the additive half: the 112 groups and options, and the links
   that attach them to the dishes. It writes no dish row, so nothing a store
   has priced or renamed is touched.

   AND THE LINKS RIDE ONLY ON THIS PART. In the whole-catalogue load the
   add-ons are applied BEFORE the dishes exist (they must be — a dish naming a
   group that has not landed loses the link), so a link written there would
   name a row that is not there yet; the dishes write their own links a moment
   later, which is the one direction of truth. Here the dishes are already at
   the outlet, and re-establishing the links is the entire point. A link naming
   a dish this outlet does not have is dropped by the handler rather than
   refusing the load — the mirror of the rule dish_upsert already keeps for an
   unknown group. */
function presetOps(opts) {
  const part = (opts && opts.part) || 'all';
  const ops = [];

  if (part === 'addons') {
    const links = linksByAddon();
    const resolve = (opts && opts.resolve) || ((ids) => ids);
    for (const a of CATALOGUE.addons) {
      ops.push({ kind: 'modifier_update',
        payload: Object.assign({}, a, { items: resolve(links[a.id] || []) }) });
    }
    return ops;
  }

  for (const s of CATALOGUE.suppliers) {
    ops.push({ kind: 'vendor_upsert', payload: s });
  }
  for (const c of CATALOGUE.sections) {
    ops.push({ kind: 'menu_category_insert', payload: c });
  }
  for (const a of CATALOGUE.addons) {
    ops.push({ kind: 'modifier_update', payload: a });
  }
  for (const i of CATALOGUE.stockItems) {
    ops.push({ kind: 'item_upsert', payload: i });
  }
  for (const d of CATALOGUE.dishes) {
    ops.push({ kind: 'dish_upsert', payload: d });
  }
  return ops;
}

/* What the choice screen says it is about to do — counted from the shipped
   data, never typed as a literal, so the sentence can not drift from the file. */
function presetCounts() {
  return {
    dishes: CATALOGUE.dishes.length,
    sections: CATALOGUE.sections.length,
    addons: CATALOGUE.addons.length,
    counter: CATALOGUE.dishes.filter((d) => d.buy).length,
    stockItems: CATALOGUE.stockItems.length,
    suppliers: CATALOGUE.suppliers.length
  };
}

/* Replay the whole catalogue through the handlers, on a connection the caller
   already holds inside its outlet context. `applyOp` is passed in rather than
   required, because src/apply.js is the heavier module and both callers (the
   onboarding plane and the outlet route) already hold it. */
/* WHICH DISH AT THIS OUTLET A PRE-SET LINK MEANS — by id, and failing that by
   NAME. The links are composed against the shipped catalogue's own ids, and a
   store only carries those if its menu came from the pre-set load. A store
   that reached the same catalogue through the CSV import has every dish under
   an id its own terminal minted — which is exactly the store this door exists
   for, and against which matching on id alone attaches nothing at all.
   Measured that way before this was written: 112 options landed and 0 links.

   Name is the key the rest of this build already resolves a menu on: the CSV
   import matches sections, add-ons and dishes by name and refuses a duplicate
   name in one file, and suppliers resolve by name everywhere. Compared
   case- and space-insensitively for the same reason `msisdn()` exists — a
   catalogue that went out through a spreadsheet comes back with different
   capitalisation and stray whitespace, and a link that misses because of a
   trailing space is a link nobody can see is missing.

   A name this outlet does not have resolves to nothing and is dropped. A name
   it holds TWICE resolves to nothing too: two dishes under one name make
   "which one offers extra cheese" a coin toss, and silently linking one of
   them is the take-one-silently defect migration 018 and chain.member_resolve()
   both exist to refuse. */
async function itemResolver(c) {
  const rows = await c.query('SELECT id, name FROM item');
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  const byId = new Set();
  const byName = new Map();
  for (const r of rows.rows) {
    byId.add(r.id);
    const k = norm(r.name);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : r.id);   // null marks an ambiguous name
  }
  const nameOf = new Map();
  for (const d of CATALOGUE.dishes) nameOf.set(d.id, norm(d.name));
  return (ids) => {
    const out = [];
    for (const id of ids) {
      if (byId.has(id)) { out.push(id); continue; }
      const hit = byName.get(nameOf.get(id));
      if (hit) out.push(hit);
    }
    return out;
  };
}

async function applyPreset(c, ctx, applyOp, opts) {
  const part = (opts && opts.part) || 'all';
  const resolve = part === 'addons' ? await itemResolver(c) : null;
  let applied = 0;
  let links = 0;
  for (const op of presetOps({ part: part, resolve: resolve })) {
    if (part === 'addons') links += (op.payload.items || []).length;
    await applyOp(c, op, ctx);
    applied++;
  }
  /* The add-ons part reports what it actually attached — every other figure in
     presetCounts() is about a load this one did not perform, and answering
     "301 dishes" to a caller that wrote none is the invented-figure defect
     this build refuses by name. `links` is what RESOLVED at this outlet, not
     what the catalogue ships, so a store holding half the menu is told the
     truth about its half. */
  if (part === 'addons') {
    return { applied: applied, part: part, addons: CATALOGUE.addons.length,
      links: links };
  }
  return Object.assign({ applied, part: part }, presetCounts());
}

module.exports = { presetOps, presetCounts, applyPreset };
