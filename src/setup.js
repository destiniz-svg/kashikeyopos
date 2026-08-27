/* ═══ A STORE'S SETUP, IN A FILE SOMEBODY HOLDS ════════════════════════════
   What a shop spent a fortnight typing in — its sections, its dishes, its
   recipes, its ingredients, its customers, its suppliers, its floor plan, its
   settings — as one file an owner can download, keep, and put back.

   THIS IS NOT A BACKUP, and the distinction is the whole design. A backup must
   be COMPLETE or restoring from it is a fiction: a file with the menu and no
   sales cannot bring a store back. So this file deliberately carries no sales,
   no payments, no journal, no stock movements and no member balances — the
   trading history — and the screen that offers it says so. It is the answer to
   "we reset the store and want our setup back", which is a different question
   from "the database is gone".

   `src/backup.js` is the other one: pg_dump, complete, restorable, and
   all-or-nothing by nature.

   ── ONE DIRECTION OF TRUTH ────────────────────────────────────────────────
   The export emits OPS — the same `{kind, payload}` the till queues — and the
   import replays them through the SAME handlers in `src/apply.js`. So an
   imported dish and a dish typed at the counter arrive by one road: the same
   validation, the same allergen re-declaration, the same "silence preserves"
   rules. A bespoke importer would be a second way to write a dish, and the
   two would drift the first time either changed.

   ── AND THE ALLOWLIST IS THE FENCE ────────────────────────────────────────
   `IMPORTABLE` is the closed set of kinds this file may carry. Without it the
   import endpoint is "run any op you like against this outlet" — a rank-5
   owner could post a journal, ring a sale, or settle credit by editing a JSON
   file. Every kind here writes STRUCTURE; none of them moves money.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { HANDLERS } = require('./apply');

const FORMAT = 1;

/* Trading balances are NOT setup. `points` and `credit_used` are what a guest
   has earned and what they owe, maintained by the sale path — carrying them in
   a file an owner can edit would make a customer's balance a text field. */
const num = (v) => (v == null || v === '' ? null : Number(v));

/* ── the parts, in dependency order ────────────────────────────────────────
   The order here IS the import order, because the database has opinions: a
   dish needs its section, a recipe needs its ingredients, an ingredient may
   name its supplier. Reordering this list is a schema decision, not a
   cosmetic one. */
const PARTS = [
  {
    key: 'sections',
    label: 'Menu sections',
    note: 'the rail, with each section’s colour, glyph and station',
    kinds: ['menu_category_insert'],
    async read(c) {
      const q = await c.query('SELECT id, name, section_id, pos, colour, icon,'
        + ' station, hidden FROM menu_category ORDER BY pos, name');
      return q.rows.map((r) => ({ kind: 'menu_category_insert', payload: {
        id: r.id, name: r.name, section: r.section_id, pos: r.pos,
        colour: r.colour, icon: r.icon, station: r.station, hidden: r.hidden
      } }));
    }
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    note: 'names, terms and lead times — ingredients point at these',
    kinds: ['vendor_upsert'],
    async read(c) {
      const q = await c.query('SELECT name, trn, contact, phone, email,'
        + ' terms_days, lead_days FROM chain.supplier WHERE active ORDER BY name');
      return q.rows.map((r) => ({ kind: 'vendor_upsert', payload: {
        name: r.name, trn: r.trn, contact: r.contact, phone: r.phone,
        email: r.email, terms: r.terms_days, lead: r.lead_days
      } }));
    }
  },
  {
    key: 'ingredients',
    label: 'Ingredients & stock items',
    note: 'the item master with units, pars and allergens — not what is on the shelf',
    kinds: ['item_upsert'],
    async read(c) {
      /* NOT `on_hand`, which is stock, and NOT `supplier_id`: a supplier's id
         is a uuid this outlet issued, and the store a file is imported into
         issues its own. Rather than write a link that silently points at
         nothing, the ingredient comes back unlinked and the part says so.
         `yield_pct`/`waste_pct` are a MEASUREMENT somebody took on this
         outlet's own produce (migration 031) and are not written by this
         handler — carrying them here would publish a guess as a measurement. */
      const q = await c.query('SELECT id, name, category, base_unit, stock_unit,'
        + ' stock_factor, avg_cost, par, min_stock, location_id, count_freq,'
        + ' allergens, sellable, sell_price, producible FROM ingredient'
        + ' WHERE active ORDER BY name');
      return q.rows.map((r) => ({ kind: 'item_upsert', payload: {
        id: r.id, name: r.name, cat: r.category, base: r.base_unit,
        stock: r.stock_unit, factor: num(r.stock_factor), cost: num(r.avg_cost),
        par: num(r.par), min: num(r.min_stock), loc: r.location_id,
        freq: r.count_freq, allergens: r.allergens || [], sellable: r.sellable,
        sellPrice: num(r.sell_price), producible: r.producible
      } }));
    }
  },
  {
    key: 'menu',
    label: 'Dishes',
    note: 'names, prices, sections, photographs, tags, heat and add-on groups',
    kinds: ['dish_upsert'],
    async read(c) {
      // A BATCH IS AN ITEM but it is not a dish, and `dish_upsert` writes
      // neither `is_batch` nor `loss_pct` — putting one through here would
      // turn a litre of fish stock into a menu item priced at zero.
      const q = await c.query('SELECT id, name, description, category_id, price,'
        + ' station, yield_qty, unit, prep_mins, image, allergens, diets, tags,'
        + ' active, off_menu, pos, spice FROM item WHERE NOT is_batch ORDER BY pos, name');
      const im = await c.query('SELECT item_id, group_id FROM item_modifier');
      const addons = {};
      im.rows.forEach((r) => { (addons[r.item_id] = addons[r.item_id] || []).push(r.group_id); });
      return q.rows.map((r) => ({ kind: 'dish_upsert', payload: {
        id: r.id, name: r.name, desc: r.description, cat: r.category_id,
        station: r.station, price: num(r.price), yield: num(r.yield_qty),
        unit: r.unit, prep: r.prep_mins, img: r.image,
        allergens: r.allergens || [], diets: r.diets || [], tags: r.tags || [],
        active: r.active,
        /* A dish 86'd TONIGHT is tonight's stock and comes back on sale — that
           is what `sold_out_reason` is, and it is deliberately not here.
           `off_menu` is a standing menu decision and travels. */
        offMenu: r.off_menu, pos: r.pos, spice: r.spice,
        // null means "inherit the section", which is a real answer; an array
        // is exhaustive. Only send an array where the dish actually has one.
        addons: addons[r.id] || null
      } }));
    }
  },
  {
    key: 'batches',
    label: 'Batches',
    note: 'what the kitchen makes in bulk — a stock, a sauce — with what goes in it',
    kinds: ['subrecipe_add'],
    async read(c) {
      /* A batch carries its own recipe, because `subrecipe_add` writes the item
         AND its lines in one act. `yield_qty` is what the batch OUTPUTS net of
         reduction and `loss_pct` is why that is less than what went in, so the
         batch SIZE the handler wants is the output grossed back up. */
      const q = await c.query('SELECT id, name, yield_qty, loss_pct, unit,'
        + ' description FROM item WHERE is_batch ORDER BY name');
      const l = await c.query('SELECT rl.item_id, rl.ingredient_id, rl.sub_item_id,'
        + ' rl.qty FROM recipe_line rl JOIN item i ON i.id = rl.item_id'
        + ' WHERE i.is_batch ORDER BY rl.item_id');
      const byItem = {};
      l.rows.forEach((r) => {
        (byItem[r.item_id] = byItem[r.item_id] || []).push({
          ing: r.sub_item_id || r.ingredient_id, qty: num(r.qty) });
      });
      return q.rows.filter((r) => (byItem[r.id] || []).length)
        .map((r) => {
          const loss = num(r.loss_pct) || 0;
          const out = num(r.yield_qty) || 0;
          return { kind: 'subrecipe_add', payload: {
            id: r.id, name: r.name, unit: r.unit, loss: loss,
            batch: loss < 1 ? Math.round((out / (1 - loss)) * 100) / 100 : out,
            note: r.description, lines: byItem[r.id]
          } };
        });
    }
  },
  {
    key: 'recipes',
    label: 'Recipes',
    note: 'what each dish is made of',
    kinds: ['recipe_update'],
    async read(c) {
      // Batches carry their own lines through `subrecipe_add`; writing them
      // here as well would delete and rewrite the same rows a second time.
      const q = await c.query('SELECT rl.item_id, rl.ingredient_id, rl.sub_item_id,'
        + ' rl.qty, rl.waste_pct FROM recipe_line rl JOIN item i ON i.id = rl.item_id'
        + ' WHERE NOT i.is_batch ORDER BY rl.item_id');
      const byItem = {};
      q.rows.forEach((r) => {
        (byItem[r.item_id] = byItem[r.item_id] || []).push({
          ing: r.sub_item_id || r.ingredient_id, qty: num(r.qty),
          waste: num(r.waste_pct), sub: !!r.sub_item_id
        });
      });
      return Object.keys(byItem).map((item) => ({ kind: 'recipe_update',
        payload: { item: item, lines: byItem[item] } }));
    }
  },
  {
    key: 'modifiers',
    label: 'Add-ons',
    note: 'option groups and what they cost',
    kinds: ['modifier_update'],
    async read(c) {
      const g = await c.query('SELECT id, name, min_pick, max_pick, required'
        + ' FROM modifier_group ORDER BY name');
      const m = await c.query('SELECT id, group_id, name, price, pos FROM modifier'
        + ' ORDER BY group_id, pos');
      const im = await c.query('SELECT item_id, group_id FROM item_modifier');
      const itemsBy = {};
      im.rows.forEach((r) => { (itemsBy[r.group_id] = itemsBy[r.group_id] || []).push(r.item_id); });
      const ops = [];
      g.rows.forEach((r) => ops.push({ kind: 'modifier_update', payload: {
        group: r.id, groupName: r.name, min: r.min_pick, max: r.max_pick,
        required: r.required, items: itemsBy[r.id] || []
      } }));
      m.rows.forEach((r) => ops.push({ kind: 'modifier_update', payload: {
        group: r.group_id, id: r.id, name: r.name, price: num(r.price), pos: r.pos
      } }));
      return ops;
    }
  },
  {
    key: 'floor',
    label: 'Floor plan',
    note: 'zones and tables — not what is sitting on them',
    kinds: ['zones_update', 'table_update'],
    async read(c) {
      const z = await c.query('SELECT id, name, pos FROM zone WHERE active ORDER BY pos');
      const t = await c.query('SELECT id, label, zone_id, seats, pos, shape, active'
        + ' FROM table_def WHERE active ORDER BY pos, label');
      const ops = [];
      if (z.rows.length) {
        ops.push({ kind: 'zones_update', payload: { zones: z.rows.map((r) => ({
          id: r.id, name: r.name, pos: r.pos })) } });
      }
      t.rows.forEach((r) => ops.push({ kind: 'table_update', payload: {
        id: r.id, label: r.label, zone: r.zone_id, seats: r.seats,
        pos: r.pos, shape: r.shape, active: r.active
      } }));
      return ops;
    }
  },
  {
    key: 'customers',
    label: 'Customers',
    note: 'names, numbers, addresses and credit limits — never points or what they owe',
    kinds: ['member_upsert'],
    async read(c) {
      /* NOT `points`, NOT `credit_used`. Those are what a guest has earned and
         what they owe, maintained by the sale path against the ledger — 2350
         ties to the member balances, so a balance set from a file is a
         liability nobody posted. A restored customer starts from what the
         trading history says, not from what the file claims. */
      const q = await c.query('SELECT name, phone, email, credit_limit, notes'
        + ' FROM chain.member ORDER BY joined_at');
      return q.rows.map((r) => ({ kind: 'member_upsert', payload: {
        name: r.name, phone: r.phone, email: r.email,
        credit: num(r.credit_limit), note: r.notes
      } }));
    }
  },
  {
    key: 'settings',
    label: 'Settings',
    note: 'the outlet’s own policies — lock time, void rules, processor rates, FX',
    kinds: ['setting_change'],
    async read(c) {
      const q = await c.query('SELECT key, value FROM setting ORDER BY key');
      return q.rows.filter((r) => !SETTING_NEVER[r.key])
        .map((r) => ({ kind: 'setting_change', payload: { key: r.key, value: r.value } }));
    }
  }
];

/* THE SETTINGS THAT MUST NOT TRAVEL. `install` is the uuid migration 026 gave
   this DATABASE so one install's outbox can never replay into another — copy
   it into a second store and the fence that stops staging ops reaching a real
   shop is gone. The rest are this store's identity at the outlet, not a policy
   somebody chose. */
const SETTING_NEVER = { install: 1, licence: 1, plan_request: 1 };

const PART = {};
PARTS.forEach((p) => { PART[p.key] = p; });

/* THE CLOSED SET OF KINDS AN IMPORT MAY CARRY. Without this the endpoint runs
   whatever the file names, and a hand-edited JSON becomes a way to ring a
   sale, post a journal or settle a credit balance under an owner's own token.
   Every kind here writes structure; none of them moves money. */
const IMPORTABLE = {};
PARTS.forEach((p) => p.kinds.forEach((k) => { IMPORTABLE[k] = p.key; }));

const partList = () => PARTS.map((p) => ({ key: p.key, label: p.label, note: p.note }));

/* Which parts a caller asked for, honoured in DEPENDENCY order whatever order
   they were named in — a file whose dishes precede their sections cannot be
   imported, so it is never written that way. An empty or unknown selection is
   refused by name rather than silently exporting everything. */
function chosen(parts) {
  const want = {};
  (Array.isArray(parts) ? parts : String(parts || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).forEach((k) => { want[k] = 1; });
  const unknown = Object.keys(want).filter((k) => !PART[k]);
  if (unknown.length) {
    throw Object.assign(new Error('this build has nothing called '
      + unknown.join(', ') + ' to put in a file'), { status: 400 });
  }
  return PARTS.filter((p) => want[p.key]);
}

async function exportSetup(c, opts) {
  const o = opts || {};
  const picked = chosen(o.parts);
  if (!picked.length) {
    throw Object.assign(new Error('nothing was selected, so there is nothing to'
      + ' put in the file'), { status: 400 });
  }
  const ops = [];
  const counts = {};
  for (const p of picked) {
    const rows = await p.read(c);
    counts[p.key] = rows.length;
    rows.forEach((r) => ops.push(r));
  }
  const at = (await c.query('SELECT now() AS t')).rows[0].t;
  return {
    format: FORMAT,
    at: at,
    // Named so a person opening the file in a text editor can tell whose it
    // is, and so an import can warn when it is somebody else's.
    outlet: o.outlet || null,
    parts: picked.map((p) => p.key),
    counts: counts,
    ops: ops
  };
}

/* ── putting it back ───────────────────────────────────────────────────────
   Every op runs in its own SAVEPOINT, so one row the outlet refuses does not
   throw away the other four hundred. What was refused is REPORTED by name and
   by part rather than swallowed: an import that silently drops a third of a
   menu is worse than one that fails, because the operator believes it worked.

   Idempotent by construction — every kind here is an upsert keyed by the row's
   own id — so importing the same file twice changes nothing the second time,
   which is what makes "try it again" a safe instruction. */
async function importSetup(c, file, opts) {
  const o = opts || {};
  if (!file || typeof file !== 'object') {
    throw Object.assign(new Error('that file is not a setup file'), { status: 400 });
  }
  if (Number(file.format) !== FORMAT) {
    throw Object.assign(new Error('that file was written by a different version'
      + ' of this app (format ' + file.format + ', this build reads ' + FORMAT + ')'),
    { status: 400 });
  }
  const ops = Array.isArray(file.ops) ? file.ops : [];
  if (!ops.length) {
    throw Object.assign(new Error('that file carries no records'), { status: 400 });
  }

  // What the CALLER asked to restore, which may be less than the file holds.
  const only = o.parts == null ? null : {};
  if (only) chosen(o.parts).forEach((p) => { only[p.key] = 1; });

  const applied = {};
  const skipped = {};
  const refused = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    const kind = String(op.kind || '');
    const part = IMPORTABLE[kind];
    /* A kind this file has no business carrying is refused, not run. This is
       the fence: without it, editing one line of the JSON turns an owner's
       restore into `post_journal`. */
    if (!part) {
      refused.push({ at: i, kind: kind || '(none)', part: null,
        why: 'a setup file does not carry ' + (kind || 'an unnamed record') });
      continue;
    }
    if (only && !only[part]) { skipped[part] = (skipped[part] || 0) + 1; continue; }
    await c.query('SAVEPOINT setup_row');
    try {
      const r = await HANDLERS[kind](c, op.payload || {}, o.ctx || {});
      await c.query('RELEASE SAVEPOINT setup_row');
      // A handler that declines by NAME (a duplicate address, a member with no
      // phone) has not failed — it has answered, and the answer is the thing
      // an operator has to see.
      if (r && (r.refused || r.skipped)) {
        refused.push({ at: i, kind: kind, part: part, why: r.refused || r.skipped });
      } else {
        applied[part] = (applied[part] || 0) + 1;
      }
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT setup_row');
      await c.query('RELEASE SAVEPOINT setup_row');
      refused.push({ at: i, kind: kind, part: part,
        why: (e && e.message) || 'the outlet refused this record' });
    }
  }
  return { applied: applied, skipped: skipped, refused: refused,
    total: ops.length, ok: !refused.length };
}

module.exports = { PARTS: partList, exportSetup, importSetup, FORMAT,
  // exported for the test that pins the fence
  _IMPORTABLE: IMPORTABLE, _SETTING_NEVER: SETTING_NEVER };
