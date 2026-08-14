'use strict';
/* Inventory and the stock ledger — 02-POS-SPEC.md §2 (`inventory`, `ledger`),
 * and §15 of the brief.
 *
 * THE TEST §15 SETS: "Inventory should be explainable. A user should be able to
 * answer: «Why is this item showing 17.4 units?» The system should provide the
 * movement history that explains it."
 *
 * So `ingredient.on_hand` is a CACHE and `stock_move` is the truth. Every
 * operation here writes a signed, reasoned, attributed move and then brings the
 * cache to the sum of the moves — never the other way round, and never a bare
 * UPDATE that leaves no trace. There is a test asserting the two agree after
 * every kind of operation, because the moment they can diverge the ledger stops
 * being an explanation and becomes a second opinion.
 *
 * VALUATION IS IN THE ACCOUNTS, not only on the item. §13 wants financial
 * movements to be auditable ledger events, so:
 *
 *   receive (opening) Dr 1100 Inventory      Cr 3000 Owner equity
 *   receive (bought)  Dr 1100 Inventory      Cr 2000 Accounts payable
 *   waste             Dr 5100 Stock variance Cr 1100 Inventory
 *   count short       Dr 5100 Stock variance Cr 1100 Inventory
 *   count over        Dr 1100 Inventory      Cr 5100 Stock variance
 *
 * A sale's consumption is already posted by the sale path (5000/1100), so it is
 * deliberately NOT re-posted here — it would double-count cost of sales.
 *
 * WEIGHTED AVERAGE COST. Receiving at a new price re-averages:
 *     new = (onHand × oldCost + qty × price) ÷ (onHand + qty)
 * which is 08-BUILD-STAGES §12's promise from the stock side — "a price
 * captured on a GRN updates the ingredient's average cost and therefore every
 * dish that uses it". Costing reads avg_cost, so every recipe reprices itself.
 * Received stock is never averaged against a NEGATIVE on-hand: that is an
 * oversold item, and dividing by a total that crosses zero produces a cost per
 * unit with no meaning.
 */

const REASONS = ['opening', 'purchase', 'waste', 'count', 'transfer', 'production', 'sale', 'return'];

const toMVR = (laari) => (laari / 100).toFixed(2);

/** Post a journal for a stock movement. Returns null when there is nothing to
 *  post — a zero-value move is real (a count that found exactly what it
 *  expected) and posting an empty journal would clutter the ledger. */
async function postStockJournal(c, { date, memo, dr, cr, valueLaari, sourceId }, ctx) {
  if (!valueLaari) return null;
  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
  const h = await c.query(
    'INSERT INTO journal (jv_no, entry_date, memo, source, source_id, posted_by)'
    + " VALUES ($1,$2,$3,'stock',$4,$5) RETURNING id",
    [no.rows[0].no, date, memo, sourceId || null, ctx.actor]);
  await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,$3,0)',
    [h.rows[0].id, dr, toMVR(valueLaari)]);
  await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,0,$3)',
    [h.rows[0].id, cr, toMVR(valueLaari)]);
  return h.rows[0].id;
}

/** Write a move and reconcile the cache to the ledger. The ONLY way stock
 *  changes in this module. */
async function move(c, { ingredientId, qty, unitCostLaari, reason, saleId }, ctx) {
  await c.query(
    'INSERT INTO stock_move (ingredient_id, qty, unit_cost, value, reason, sale_id, by_staff, device_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [ingredientId, qty, (unitCostLaari / 100).toFixed(4),
      toMVR(Math.round(qty * unitCostLaari)), reason, saleId || null, ctx.actor, ctx.deviceId]);

  /* on_hand = Σ moves, recomputed from the ledger rather than incremented.
     An increment drifts the moment anything else touches the row; a sum cannot
     disagree with the history it is derived from. */
  await c.query(
    'UPDATE ingredient SET on_hand = ('
    + ' SELECT coalesce(sum(qty),0) FROM stock_move WHERE ingredient_id = $1) WHERE id = $1',
    [ingredientId]);
}

/**
 * Receive stock. `opening` credits equity (this is what was already in the
 * store when the system arrived); anything else credits accounts payable.
 *
 * p = { ingredientId, qty, unitCost (MVR), reason?, date? }
 */
async function receive(c, p, ctx) {
  const id = String(p.ingredientId || '');
  const qty = Number(p.qty);
  if (!(qty > 0)) throw Object.assign(new Error('receive a quantity above zero'), { status: 400 });

  const ing = await c.query(
    'SELECT id, name, on_hand, avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [id]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });

  const onHand = Number(ing.rows[0].on_hand);
  const oldCost = Number(ing.rows[0].avg_cost);
  const price = p.unitCost === undefined ? oldCost : Number(p.unitCost);
  if (!Number.isFinite(price) || price < 0) {
    throw Object.assign(new Error('a cost cannot be negative'), { status: 400 });
  }

  /* Re-average, but only over a non-negative base. A negative on-hand means the
     item was oversold and the average would be computed across a total that
     crosses zero — a number with no meaning that then reprices every dish. */
  const base = Math.max(0, onHand);
  const newCost = (base + qty) > 0
    ? (base * oldCost + qty * price) / (base + qty)
    : price;
  await c.query('UPDATE ingredient SET avg_cost = $2 WHERE id = $1',
    [id, Math.round(newCost * 10000) / 10000]);

  const reason = p.reason === 'opening' ? 'opening' : 'purchase';
  await move(c, { ingredientId: id, qty, unitCostLaari: Math.round(price * 100), reason }, ctx);

  const valueLaari = Math.round(qty * price * 100);
  const date = p.date || new Date().toISOString().slice(0, 10);
  await postStockJournal(c, {
    date, memo: (reason === 'opening' ? 'Opening stock — ' : 'Stock received — ') + ing.rows[0].name,
    dr: '1100', cr: reason === 'opening' ? '3000' : '2000',
    valueLaari, sourceId: id,
  }, ctx);

  await c.query("SELECT chain.log($1,'ingredient',$2,NULL,$3)",
    ['stock_' + reason, id, JSON.stringify({ qty, unitCost: price, newAvgCost: newCost })]);

  return { ingredientId: id, qty, avgCost: Math.round(newCost * 10000) / 10000 };
}

/**
 * Throw something away. Valued at the CURRENT average cost — what it cost to
 * have it, not what it would cost to replace it.
 *
 * p = { ingredientId, qty, note, date? }
 */
async function waste(c, p, ctx) {
  const id = String(p.ingredientId || '');
  const qty = Number(p.qty);
  if (!(qty > 0)) throw Object.assign(new Error('waste a quantity above zero'), { status: 400 });
  if (!String(p.note || '').trim()) {
    // §23: an adjustment carries a reason. Wastage with no reason is an
    // unexplained hole in the stock and in the margin.
    throw Object.assign(new Error('say why it was wasted'), { status: 400 });
  }

  const ing = await c.query(
    'SELECT id, name, avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [id]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });
  const cost = Number(ing.rows[0].avg_cost);

  await move(c, { ingredientId: id, qty: -qty, unitCostLaari: Math.round(cost * 100), reason: 'waste' }, ctx);

  const valueLaari = Math.round(qty * cost * 100);
  await postStockJournal(c, {
    date: p.date || new Date().toISOString().slice(0, 10),
    memo: 'Wastage — ' + ing.rows[0].name + ' — ' + String(p.note).slice(0, 120),
    dr: '5100', cr: '1100', valueLaari, sourceId: id,
  }, ctx);

  await c.query("SELECT chain.log('stock_waste','ingredient',$1,NULL,$2)",
    [id, JSON.stringify({ qty, value: toMVR(valueLaari), note: String(p.note).slice(0, 200) })]);

  return { ingredientId: id, qty: -qty, value: toMVR(valueLaari) };
}

/**
 * A stock count. The counted figure becomes the truth and the difference is
 * posted as a variance — §15's "stock count" and "variance" in one operation.
 *
 * p = { lines: [{ ingredientId, counted }], note?, date? }
 */
async function count(c, p, ctx) {
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) throw Object.assign(new Error('a count needs at least one line'), { status: 400 });

  const head = await c.query(
    'INSERT INTO stock_count (by_staff, categories, variance_value) VALUES ($1,$2,0) RETURNING id',
    [ctx.actor, []]);
  const countId = head.rows[0].id;
  const date = p.date || new Date().toISOString().slice(0, 10);

  let net = 0;          // laari, signed: positive = found more than expected
  const results = [];

  for (const l of lines) {
    const id = String(l.ingredientId || '');
    const counted = Number(l.counted);
    if (!Number.isFinite(counted) || counted < 0) {
      throw Object.assign(new Error('a counted quantity cannot be negative'), { status: 400 });
    }
    const ing = await c.query(
      'SELECT id, name, on_hand, avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [id]);
    if (!ing.rows.length) throw Object.assign(new Error('no such ingredient: ' + id), { status: 409 });

    const expected = Number(ing.rows[0].on_hand);
    const variance = counted - expected;              // signed, in units
    const cost = Number(ing.rows[0].avg_cost);
    const valueLaari = Math.round(variance * cost * 100);

    await c.query(
      'INSERT INTO count_line (count_id, ingredient_id, expected, counted, variance, value)'
      + ' VALUES ($1,$2,$3,$4,$5,$6)',
      [countId, id, expected, counted, variance, toMVR(valueLaari)]);

    /* A variance of zero writes NO move. The count confirmed the ledger, and a
       zero-quantity move would be noise in the very history somebody reads to
       explain a number. The count_line records that it was counted. */
    if (variance !== 0) {
      await move(c, { ingredientId: id, qty: variance, unitCostLaari: Math.round(cost * 100), reason: 'count' }, ctx);
    }
    net += valueLaari;
    results.push({ ingredientId: id, expected, counted, variance, value: toMVR(valueLaari) });
  }

  await c.query('UPDATE stock_count SET variance_value = $2 WHERE id = $1', [countId, toMVR(net)]);

  /* One journal for the whole count, not one per line: a stock check is a
     single event, and the accounts should show it as one. */
  if (net !== 0) {
    await postStockJournal(c, {
      date, memo: 'Stock count variance' + (p.note ? ' — ' + String(p.note).slice(0, 120) : ''),
      // Found MORE than expected: inventory goes up, variance is a credit.
      dr: net > 0 ? '1100' : '5100',
      cr: net > 0 ? '5100' : '1100',
      valueLaari: Math.abs(net), sourceId: countId,
    }, ctx);
  }

  await c.query("SELECT chain.log('stock_count','stock_count',$1,NULL,$2)",
    [countId, JSON.stringify({ lines: results.length, variance: toMVR(net) })]);

  return { countId, lines: results, varianceValue: toMVR(net) };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

/** On-hand, par, and value. §2: "On-hand, par, value, by sub-location." */
async function inventory(c) {
  const q = await c.query(
    'SELECT i.id, i.name, i.unit, i.on_hand, i.avg_cost, i.par,'
    + ' (SELECT count(*)::int FROM recipe_line r WHERE r.ingredient_id = i.id) AS used_in,'
    + ' (SELECT max(m.at) FROM stock_move m WHERE m.ingredient_id = i.id) AS last_move'
    + ' FROM ingredient i ORDER BY i.name');
  const rows = q.rows.map((r) => {
    const onHand = Number(r.on_hand);
    const cost = Number(r.avg_cost);
    return {
      id: r.id, name: r.name, unit: r.unit,
      onHand, avgCost: cost,
      value: Math.round(onHand * cost * 100),
      par: r.par === null ? null : Number(r.par),
      belowPar: r.par !== null && onHand < Number(r.par),
      negative: onHand < 0,
      usedIn: r.used_in,
      lastMove: r.last_move,
    };
  });
  return {
    items: rows,
    totalValue: rows.reduce((a, r) => a + r.value, 0),
    belowPar: rows.filter((r) => r.belowPar).length,
  };
}

/** WHY IS THIS ITEM SHOWING 17.4 UNITS — the movement history that explains it,
 *  newest first, with a running balance so the answer is readable rather than
 *  reconstructable. */
async function ledger(c, ingredientId, limit) {
  const ing = await c.query(
    'SELECT id, name, unit, on_hand, avg_cost FROM ingredient WHERE id = $1', [ingredientId]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });

  const q = await c.query(
    'SELECT m.id, m.at, m.qty, m.unit_cost, m.value, m.reason, m.sale_id, m.by_staff,'
    + ' s.receipt_no, st.name AS by_name'
    + ' FROM stock_move m'
    + ' LEFT JOIN sale s ON s.id = m.sale_id'
    + ' LEFT JOIN chain.staff st ON st.id = m.by_staff'
    + ' WHERE m.ingredient_id = $1 ORDER BY m.at, m.id',
    [ingredientId]);

  // Running balance forward, then present newest first — so every row answers
  // "what was the on-hand immediately after this movement".
  let running = 0;
  const rows = q.rows.map((r) => {
    running += Number(r.qty);
    return {
      id: r.id, at: r.at, qty: Number(r.qty),
      unitCost: Number(r.unit_cost), value: Number(r.value),
      reason: r.reason, balance: running,
      source: r.receipt_no || null, by: r.by_name || null,
    };
  }).reverse();

  return {
    ingredient: {
      id: ing.rows[0].id, name: ing.rows[0].name, unit: ing.rows[0].unit,
      onHand: Number(ing.rows[0].on_hand), avgCost: Number(ing.rows[0].avg_cost),
    },
    // The whole point of the screen: the ledger's own sum, so a reader can see
    // it equals the on-hand rather than taking it on trust.
    ledgerSum: running,
    moves: limit ? rows.slice(0, limit) : rows,
  };
}

module.exports = { receive, waste, count, inventory, ledger, REASONS };
