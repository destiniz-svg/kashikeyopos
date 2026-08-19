'use strict';
/* Production — 02-POS-SPEC §2 (`production`), 08-BUILD-STAGES.
 *
 * A PREP ITEM IS AN INGREDIENT THAT IS MADE RATHER THAN BOUGHT. That single
 * decision is why this module is small: a dish's recipe references sauce
 * exactly as it references tomatoes, so `costing.explode` needs no change and
 * knows nothing about prep; the sauce's cost is a weighted average like any
 * other ingredient's; it appears on count sheets, in the ledger and in wastage
 * without any of those modules learning a new concept. See migration 033 for
 * why the alternative — a build recipe keyed on the ingredient's own id in the
 * MENU recipe table — is a trap.
 *
 * WHAT MAKING A BATCH ACTUALLY FIXES. Until now a sub-recipe was exploded to
 * raw ingredients at the moment of SALE. Make four litres of sauce at nine in
 * the morning and the tomatoes are physically gone, but this system says they
 * are on the shelf until a dish containing them sells — possibly days later.
 * Count the store at eleven and the components are short with nothing to
 * explain it, and the variance lands in 5100 as if somebody had binned them.
 *
 * IT POSTS NO JOURNAL, deliberately. Tomatoes at 1100 become sauce at 1100 —
 * value moving between two things that are both inventory. Yield loss is not a
 * loss of value either: the components' whole cost lands in the smaller output,
 * which is precisely what makes the sauce cost what it costs. The only thing
 * production can do to the P&L is nothing.
 *
 * A RUN IS NEVER REFUSED FOR WANT OF STOCK. The batch has already been made —
 * the cook is standing at a screen recording it. Refusing would lose the record
 * and leave the physical stock wrong in the other direction. Short components
 * are reported on the way in and go negative, exactly as a sale does, because
 * on-hand going negative is a finding rather than an error.
 */

const stock = require('./stock');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const mvr = (n) => Math.round(Number(n) * 100) / 100;

/* An ingredient's unit cost in laari, UNROUNDED, which is the only way this
   can be right. Beef at MVR 0.0850 a gram is 8.5 laari a gram; rounding that
   to 9 before multiplying by the 500 g a batch takes turns MVR 42.50 into
   45.00 — a 6% error, per component, on every batch, silently. `avg_cost` is
   numeric(12,4) precisely because sub-laari unit costs are the normal case in
   a kitchen. Round the TOTAL, once, at the end. */
const unitLaariOf = (avgCostMvr) => Number(avgCostMvr) * 100;

/* The same guard the dish recipes use: a line that wastes everything is a typo,
   and 100% would divide by zero. */
const gross = (qty, wastePct) => qty / (1 - Math.min(0.95, (Number(wastePct) || 0) / 100));

/* ── the catalogue ───────────────────────────────────────────────────────── */

/**
 * Everything the kitchen makes, with what it costs and how much it could make
 * from what is in the store right now.
 *
 * `possibleBatches` is the figure a prep list is actually read for: not "do we
 * have tomatoes" but "how many more times can I make this before something runs
 * out", and WHICH thing runs out first. A shortfall list of every component is
 * noise; the binding one is the answer.
 */
async function catalogue(c) {
  const items = await c.query(
    'SELECT id, name, unit, on_hand, avg_cost, prep_yield, category'
    + ' FROM ingredient WHERE prep_yield IS NOT NULL ORDER BY name');
  if (!items.rows.length) return { items: [] };

  const lines = await c.query(
    'SELECT r.makes_id, r.component_id, r.qty, r.waste_pct,'
    + ' i.name, i.unit, i.on_hand, i.avg_cost, i.prep_yield IS NOT NULL AS is_prep'
    + ' FROM prep_recipe r JOIN ingredient i ON i.id = r.component_id'
    + ' ORDER BY i.name');

  const byMakes = new Map();
  for (const l of lines.rows) {
    if (!byMakes.has(l.makes_id)) byMakes.set(l.makes_id, []);
    byMakes.get(l.makes_id).push(l);
  }

  return {
    items: items.rows.map((it) => {
      const rows = byMakes.get(it.id) || [];
      let batchCost = 0;
      let possible = rows.length ? Infinity : 0;
      let binding = null;

      const components = rows.map((l) => {
        const need = gross(Number(l.qty), l.waste_pct);
        const cost = need * Number(l.avg_cost);
        batchCost += cost;
        const canMake = need > 0 ? Number(l.on_hand) / need : Infinity;
        if (canMake < possible) { possible = canMake; binding = l.name; }
        return {
          id: l.component_id, name: l.name, unit: l.unit,
          qty: Number(l.qty), wastePct: Number(l.waste_pct),
          needPerBatch: Math.round(need * 10000) / 10000,
          onHand: Number(l.on_hand), avgCost: Number(l.avg_cost),
          costPerBatch: mvr(cost),
          isPrep: l.is_prep,
        };
      });

      const yieldQty = Number(it.prep_yield);
      return {
        id: it.id, name: it.name, unit: it.unit, category: it.category,
        onHand: Number(it.on_hand), avgCost: Number(it.avg_cost),
        yieldQty,
        components,
        /* What one batch costs at today's component prices, and what that makes
           a base unit of it worth. Not the same as `avgCost`, which is what the
           batches already in the store actually cost — the two differing is a
           price move, and seeing both is the point. */
        batchCost: mvr(batchCost),
        unitCostIfMadeNow: yieldQty > 0 ? Math.round((batchCost / yieldQty) * 10000) / 10000 : 0,
        possibleBatches: rows.length
          ? Math.floor(Math.max(0, possible) * 100) / 100 : null,
        /* Which component runs out first. A list of everything short is noise;
           the binding one is the thing to go and buy. */
        bindingComponent: rows.length && possible < 1 ? binding : null,
        ready: rows.length > 0,
      };
    }),
  };
}

/* ── the formula ─────────────────────────────────────────────────────────── */

/** Would making `component` part of `makes` close a loop? Walks the graph the
 *  application can see and the database cannot: the CHECK constraint stops a
 *  thing being its own ingredient, but A→B→A needs the whole picture. */
async function wouldLoop(c, makesId, componentId) {
  if (makesId === componentId) return true;
  const seen = new Set([componentId]);
  const queue = [componentId];
  while (queue.length) {
    const at = queue.shift();
    const rows = await c.query(
      'SELECT component_id FROM prep_recipe WHERE makes_id = $1', [at]);
    for (const r of rows.rows) {
      if (r.component_id === makesId) return true;
      if (!seen.has(r.component_id)) { seen.add(r.component_id); queue.push(r.component_id); }
    }
  }
  return false;
}

/**
 * Set what a thing is made of, and how much one run makes.
 *
 * The whole formula at once, not line by line: a prep sheet is read as a unit
 * and half-saving one is how a batch gets made from four of its five
 * components. Clearing the yield turns it back into something you buy.
 */
async function setRecipe(c, makesId, body, ctx) {
  const ing = await c.query('SELECT id, name, unit FROM ingredient WHERE id = $1', [makesId]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });

  const yieldQty = body.yieldQty === null || body.yieldQty === '' ? null : Number(body.yieldQty);
  if (yieldQty !== null && (!Number.isFinite(yieldQty) || yieldQty <= 0)) {
    throw bad('a batch has to make some positive amount');
  }
  const lines = Array.isArray(body.components) ? body.components : [];
  if (yieldQty !== null && !lines.length) {
    throw bad('a thing you make needs at least one thing to make it from');
  }

  const clean = [];
  const seen = new Set();
  for (const l of lines) {
    const id = String(l.id || l.componentId || '').trim();
    const qty = Number(l.qty);
    const waste = Number(l.wastePct || 0);
    if (!id) throw bad('a component with no ingredient');
    if (seen.has(id)) throw bad('the same component twice — put the quantities together');
    if (!Number.isFinite(qty) || qty <= 0) throw bad('every component needs a quantity');
    if (!Number.isFinite(waste) || waste < 0 || waste >= 100) {
      throw bad('waste is a percentage below 100');
    }
    if (id === makesId) throw bad('a thing cannot be an ingredient of itself');
    if (await wouldLoop(c, makesId, id)) {
      throw bad('that would make ' + id + ' and ' + makesId + ' depend on each other');
    }
    seen.add(id);
    clean.push({ id, qty, waste });
  }

  await c.query('UPDATE ingredient SET prep_yield = $2 WHERE id = $1', [makesId, yieldQty]);
  await c.query('DELETE FROM prep_recipe WHERE makes_id = $1', [makesId]);
  for (const l of clean) {
    await c.query(
      'INSERT INTO prep_recipe (makes_id, component_id, qty, waste_pct)'
      + ' VALUES ($1,$2,$3,$4)', [makesId, l.id, l.qty, l.waste]);
  }
  await c.query("SELECT chain.log('prep_recipe','ingredient',$1,NULL,$2)",
    [makesId, JSON.stringify({ yieldQty, components: clean })]);
  return catalogue(c);
}

/* ── making a batch ──────────────────────────────────────────────────────── */

/**
 * Record a batch that has been made.
 *
 * `batches` scales the formula; `qty` is what actually came out and defaults to
 * the formula's yield. They are separate on purpose: a cook who gets 3.6 litres
 * out of a 4-litre recipe has used four litres' worth of components, and the
 * whole of that cost belongs in the 3.6 litres. Forcing them to be the same
 * number would either lose the components or invent output.
 */
async function make(c, body, ctx) {
  const makesId = String(body.makesId || '').trim();
  if (!makesId) throw bad('what was made?');
  const ing = await c.query(
    'SELECT id, name, unit, on_hand, avg_cost, prep_yield FROM ingredient'
    + ' WHERE id = $1 FOR UPDATE', [makesId]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });
  const it = ing.rows[0];
  if (it.prep_yield === null) throw bad(it.name + ' is not something this kitchen makes');

  const batches = body.batches === undefined || body.batches === '' ? 1 : Number(body.batches);
  if (!Number.isFinite(batches) || batches <= 0) throw bad('how many batches?');
  const yieldQty = Number(it.prep_yield) * batches;
  const outQty = body.qty === undefined || body.qty === '' ? yieldQty : Number(body.qty);
  if (!Number.isFinite(outQty) || outQty <= 0) throw bad('a batch has to produce something');

  const rows = await c.query(
    'SELECT r.component_id, r.qty, r.waste_pct, i.name, i.unit, i.on_hand, i.avg_cost'
    + ' FROM prep_recipe r JOIN ingredient i ON i.id = r.component_id'
    + ' WHERE r.makes_id = $1 ORDER BY i.name', [makesId]);
  if (!rows.rows.length) throw bad('there is no formula for ' + it.name + ' yet');

  const run = await c.query(
    'INSERT INTO prep_run (makes_id, qty, batches, note, by_staff, device_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, at, on_date',
    [makesId, outQty, batches, String(body.note || '').trim() || null,
      ctx.actor || null, ctx.deviceId || null]);
  const runId = run.rows[0].id;

  let costLaari = 0;
  const used = [];
  const short = [];
  for (const l of rows.rows) {
    const need = gross(Number(l.qty), l.waste_pct) * batches;
    const unitLaari = unitLaariOf(l.avg_cost);
    /* Reported, not refused. See the header: the batch is already made. */
    if (Number(l.on_hand) < need) {
      short.push({ id: l.component_id, name: l.name,
        onHand: Number(l.on_hand), needed: Math.round(need * 10000) / 10000 });
    }
    await stock.move(c, {
      ingredientId: l.component_id, qty: -need, unitCostLaari: unitLaari,
      reason: 'prep', prepRunId: runId,
    }, ctx);
    costLaari += Math.round(need * unitLaari);
    used.push({ id: l.component_id, name: l.name, unit: l.unit,
      qty: Math.round(need * 10000) / 10000, cost: mvr(Math.round(need * unitLaari) / 100) });
  }

  /* What the output is worth per base unit: the whole of the components' cost,
     divided by what actually came out. Yield loss makes the product dearer,
     which is the true story of a reduction. */
  /* Unrounded, for the same reason as above: the output's per-unit cost is
     almost never a whole laari, and `stock.move` rounds the VALUE it writes. */
  const outUnitLaari = costLaari / outQty;
  await stock.move(c, {
    ingredientId: makesId, qty: outQty, unitCostLaari: outUnitLaari,
    reason: 'production', prepRunId: runId,
  }, ctx);

  /* Weighted average, on the stock that was there BEFORE this batch — the same
     arithmetic a delivery uses, because a batch arriving is the same event as a
     delivery arriving as far as cost is concerned. */
  const prevQty = Number(it.on_hand);
  const prevCost = Number(it.avg_cost);
  const newAvg = prevQty + outQty > 0
    ? (prevQty * prevCost + costLaari / 100) / (prevQty + outQty)
    : costLaari / 100 / outQty;
  await c.query('UPDATE ingredient SET avg_cost = $2 WHERE id = $1',
    [makesId, Math.round(newAvg * 10000) / 10000]);

  await c.query('UPDATE prep_run SET cost = $2 WHERE id = $1', [runId, mvr(costLaari / 100)]);
  await c.query("SELECT chain.log('prep_run','prep_run',$1,NULL,$2)",
    [runId, JSON.stringify({ makesId, qty: outQty, batches, cost: mvr(costLaari / 100) })]);

  return {
    id: runId, at: run.rows[0].at, onDate: run.rows[0].on_date,
    makes: { id: makesId, name: it.name, unit: it.unit },
    qty: outQty, batches,
    cost: mvr(costLaari / 100),
    unitCost: Math.round((costLaari / outQty) * 100) / 10000,
    used,
    /* Named rather than hidden. A batch made from stock the system did not
       think was there means either the store is wrong or a delivery was never
       booked, and both are worth chasing while somebody remembers. */
    short,
    /* No journal, and the payload says so — see the header. */
    posted: null,
    ledger: 'none — value moved from one inventory account line to another',
  };
}

/* ── history ─────────────────────────────────────────────────────────────── */

async function runs(c, q) {
  const params = [];
  const where = [];
  if (q.from) { params.push(String(q.from).slice(0, 10)); where.push('r.on_date >= $' + params.length); }
  if (q.to) { params.push(String(q.to).slice(0, 10)); where.push('r.on_date <= $' + params.length); }
  if (q.makesId) { params.push(String(q.makesId)); where.push('r.makes_id = $' + params.length); }
  const limit = Math.min(Number(q.limit) || 60, 300);

  const rows = await c.query(
    'SELECT r.id, r.at, r.on_date, r.makes_id, r.qty, r.batches, r.cost, r.note,'
    + ' i.name, i.unit, s.name AS by_name'
    + ' FROM prep_run r JOIN ingredient i ON i.id = r.makes_id'
    + ' LEFT JOIN chain.staff s ON s.id = r.by_staff'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY r.at DESC LIMIT ' + limit, params);

  return {
    runs: rows.rows.map((r) => ({
      id: r.id, at: r.at, onDate: r.on_date,
      makes: { id: r.makes_id, name: r.name, unit: r.unit },
      qty: Number(r.qty), batches: Number(r.batches),
      cost: Number(r.cost),
      unitCost: Number(r.qty) > 0
        ? Math.round((Number(r.cost) / Number(r.qty)) * 10000) / 10000 : 0,
      note: r.note, by: r.by_name || null,
    })),
  };
}

/** One run, and every movement it caused — which is what makes it auditable as
 *  a single act rather than as six coincidences at the same second. */
async function one(c, id) {
  const r = await c.query(
    'SELECT r.*, i.name, i.unit, s.name AS by_name FROM prep_run r'
    + ' JOIN ingredient i ON i.id = r.makes_id'
    + ' LEFT JOIN chain.staff s ON s.id = r.by_staff WHERE r.id = $1', [id]);
  if (!r.rows.length) throw Object.assign(new Error('no such run'), { status: 404 });
  const moves = await c.query(
    'SELECT m.id, m.ingredient_id, m.qty, m.unit_cost, m.value, m.reason, i.name, i.unit'
    + ' FROM stock_move m JOIN ingredient i ON i.id = m.ingredient_id'
    + ' WHERE m.prep_run_id = $1 ORDER BY m.qty DESC', [id]);
  const x = r.rows[0];
  return {
    id: x.id, at: x.at, onDate: x.on_date,
    makes: { id: x.makes_id, name: x.name, unit: x.unit },
    qty: Number(x.qty), batches: Number(x.batches), cost: Number(x.cost),
    note: x.note, by: x.by_name || null,
    moves: moves.rows.map((m) => ({
      id: String(m.id), ingredientId: m.ingredient_id, name: m.name, unit: m.unit,
      qty: Number(m.qty), unitCost: Number(m.unit_cost), value: Number(m.value),
      reason: m.reason,
    })),
  };
}

module.exports = { catalogue, setRecipe, make, runs, one, wouldLoop };
