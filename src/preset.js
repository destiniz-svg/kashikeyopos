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

/* The ops, in apply order. Payloads are handed to the handlers as-is; the
   composition happens once, at extraction, never here. */
function presetOps() {
  const ops = [];
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
async function applyPreset(c, ctx, applyOp) {
  let applied = 0;
  for (const op of presetOps()) {
    await applyOp(c, op, ctx);
    applied++;
  }
  return Object.assign({ applied }, presetCounts());
}

module.exports = { presetOps, presetCounts, applyPreset };
