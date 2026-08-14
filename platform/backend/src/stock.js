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
  /* NOT Math.round(price * 100). A cost per GRAM is a fraction of a laari —
     tuna at MVR 0.0850/g is 8.5 laari, and rounding that to 9 overstates every
     gram-denominated movement by six per cent. move() rounds the VALUE once,
     at the end, which is the only place a rounding belongs. */
  await move(c, { ingredientId: id, qty, unitCostLaari: price * 100, reason }, ctx);

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

  await move(c, { ingredientId: id, qty: -qty, unitCostLaari: cost * 100, reason: 'waste' }, ctx);

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

/* The rank that may approve a count somebody else took. Above MANAGER on
   purpose: a count is the one operation where a person types a number and the
   accounts move to meet it, which makes it the easiest place in the platform to
   write off a theft. If the counter could also approve it, the threshold would
   be a formality. */
const APPROVE_RANK = 4;

/**
 * A stock count. The counted figure becomes the truth and the difference is
 * posted as a variance — §15's "stock count" and "variance" in one operation,
 * and §2's "approval above a threshold".
 *
 * Above the outlet's threshold the count is RECORDED but nothing moves: no
 * stock, no journal. It waits for `approveCount`. That is the whole point —
 * a count held for approval that had already adjusted the stock would be an
 * approval of something that had happened anyway.
 *
 * p = { lines: [{ ingredientId, counted }], note?, date?, categories? }
 */
async function count(c, p, ctx, outlet) {
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) throw Object.assign(new Error('a count needs at least one line'), { status: 400 });

  const threshold = Number((outlet && outlet.count_approval_laari) || 0);
  const categories = Array.isArray(p.categories) ? p.categories.map(String).slice(0, 40) : [];

  const head = await c.query(
    'INSERT INTO stock_count (by_staff, categories, variance_value, note, threshold)'
    + ' VALUES ($1,$2,0,$3,$4) RETURNING id',
    [ctx.actor, categories, p.note ? String(p.note).slice(0, 200) : null, toMVR(threshold)]);
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
      'INSERT INTO count_line (count_id, ingredient_id, expected, counted, variance, value, unit_cost)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [countId, id, expected, counted, variance, toMVR(valueLaari), cost]);

    net += valueLaari;
    results.push({
      ingredientId: id, name: ing.rows[0].name, expected, counted, variance,
      unitCost: cost, value: toMVR(valueLaari),
    });
  }

  await c.query('UPDATE stock_count SET variance_value = $2 WHERE id = $1', [countId, toMVR(net)]);

  /* Above the threshold, and taken by somebody who cannot approve their own —
     hold it. A rank that could approve it anyway is not made to ask itself for
     permission; that would be ceremony, and people learn to click through
     ceremony. */
  const needsApproval = threshold > 0
    && Math.abs(net) > threshold
    && (ctx.rank || 0) < APPROVE_RANK;

  if (needsApproval) {
    await c.query("UPDATE stock_count SET status = 'pending' WHERE id = $1", [countId]);
    await c.query("SELECT chain.log('stock_count_pending','stock_count',$1,NULL,$2)",
      [countId, JSON.stringify({
        lines: results.length, variance: toMVR(net), threshold: toMVR(threshold),
      })]);
    return {
      countId, lines: results, varianceValue: toMVR(net),
      status: 'pending', threshold: toMVR(threshold),
      // Said plainly in the result, because the till has to tell whoever
      // counted that the stock has NOT moved yet.
      message: 'This count is worth ' + toMVR(Math.abs(net)) + ', over the '
        + toMVR(threshold) + ' limit. Nothing has moved until it is approved.',
    };
  }

  await applyCount(c, countId, results, net, date, p.note, ctx);

  await c.query("SELECT chain.log('stock_count','stock_count',$1,NULL,$2)",
    [countId, JSON.stringify({ lines: results.length, variance: toMVR(net) })]);

  return { countId, lines: results, varianceValue: toMVR(net), status: 'posted' };
}

/** Move the stock and post the journal for a count. Shared by the immediate
 *  path and the approval path so the two can never drift apart. */
async function applyCount(c, countId, results, netLaari, date, note, ctx) {
  for (const r of results) {
    /* A variance of zero writes NO move. The count confirmed the ledger, and a
       zero-quantity move would be noise in the very history somebody reads to
       explain a number. The count_line records that it was counted. */
    if (r.variance === 0) continue;
    await move(c, {
      ingredientId: r.ingredientId, qty: r.variance,
      /* Unrounded, for the same reason as receive(): rounding the per-unit cost
         made the LEDGER disagree with the SHEET that was approved — a count of
         2,820 g of tuna showed −239.70 on the sheet and posted −253.80 to the
         stock ledger, because 8.5 laari a gram had become 9. */
      unitCostLaari: Number(r.unitCost) * 100, reason: 'count',
    }, ctx);
  }

  /* One journal for the whole count, not one per line: a stock check is a
     single event, and the accounts should show it as one. */
  if (netLaari !== 0) {
    await postStockJournal(c, {
      date, memo: 'Stock count variance' + (note ? ' — ' + String(note).slice(0, 120) : ''),
      // Found MORE than expected: inventory goes up, variance is a credit.
      dr: netLaari > 0 ? '1100' : '5100',
      cr: netLaari > 0 ? '5100' : '1100',
      valueLaari: Math.abs(netLaari), sourceId: countId,
    }, ctx);
  }
}

/** Approve a held count: NOW the stock moves and the journal posts.
 *  p = { countId } */
async function approveCount(c, p, ctx) {
  if ((ctx.rank || 0) < APPROVE_RANK) {
    throw Object.assign(new Error('approving a count needs rank ' + APPROVE_RANK), { status: 403 });
  }
  const id = String(p.countId || '');
  const head = await c.query(
    'SELECT id, by_staff, at, variance_value, note FROM stock_count'
    + " WHERE id = $1 AND status = 'pending' FOR UPDATE", [id]);
  if (!head.rows.length) {
    throw Object.assign(new Error('no count is waiting for approval under that id'), { status: 409 });
  }
  if (head.rows[0].by_staff === ctx.actor) {
    // Belt and braces on top of the rank gate: an admin who counted the stock
    // themselves has still not had a second pair of eyes on it.
    throw Object.assign(new Error('somebody else has to approve a count you took'), { status: 403 });
  }

  const lines = await c.query(
    'SELECT ingredient_id, variance, unit_cost, value FROM count_line WHERE count_id = $1', [id]);

  /* The variances are posted EXACTLY as they were counted, not re-derived
     against today's on-hand. That is not laziness, it is arithmetic: if stock
     moved by M between the count and this moment, on-hand is now expected+M and
     the true adjustment is (counted+M) − (expected+M), which is the original
     variance. Re-deriving would silently absorb every sale made in between into
     the shrinkage figure. */
  const results = lines.rows.map((r) => ({
    ingredientId: r.ingredient_id, variance: Number(r.variance),
    unitCost: Number(r.unit_cost), value: Number(r.value),
  }));
  const netLaari = Math.round(Number(head.rows[0].variance_value) * 100);
  const date = new Date().toISOString().slice(0, 10);

  await applyCount(c, id, results, netLaari, date, head.rows[0].note, ctx);

  await c.query(
    "UPDATE stock_count SET status = 'posted', approved_by = $2, approved_at = now()"
    + ' WHERE id = $1', [id, ctx.actor]);
  await c.query("SELECT chain.log('stock_count_approve','stock_count',$1,NULL,$2)",
    [id, JSON.stringify({ variance: toMVR(netLaari), lines: results.length })]);

  return { countId: id, status: 'posted', varianceValue: toMVR(netLaari) };
}

/** Refuse a held count. Nothing moves, and the reason is kept — a rejected
 *  count is evidence, so the sheet is never deleted.
 *  p = { countId, reason } */
async function rejectCount(c, p, ctx) {
  if ((ctx.rank || 0) < APPROVE_RANK) {
    throw Object.assign(new Error('rejecting a count needs rank ' + APPROVE_RANK), { status: 403 });
  }
  if (!String(p.reason || '').trim()) {
    throw Object.assign(new Error('say why the count was refused'), { status: 400 });
  }
  const upd = await c.query(
    "UPDATE stock_count SET status = 'rejected', rejected_reason = $2,"
    + ' approved_by = $3, approved_at = now()'
    + " WHERE id = $1 AND status = 'pending' RETURNING id, variance_value",
    [String(p.countId || ''), String(p.reason).slice(0, 200), ctx.actor]);
  if (!upd.rows.length) {
    throw Object.assign(new Error('no count is waiting for approval under that id'), { status: 409 });
  }
  await c.query("SELECT chain.log('stock_count_reject','stock_count',$1,NULL,$2)",
    [upd.rows[0].id, JSON.stringify({ reason: String(p.reason).slice(0, 200) })]);
  return { countId: upd.rows[0].id, status: 'rejected' };
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

/* ── Stock Counts (§2 `counts`) ───────────────────────────────────────────
 * "Count sheets by category; variance in units and MVR; approval above a
 *  threshold." Pending sheets first whatever the date — a count waiting for a
 *  signature is the only thing on this screen anybody has to do.
 */
async function counts(c, limit) {
  const q = await c.query(
    'SELECT s.id, s.at, s.status, s.categories, s.variance_value, s.threshold,'
    + ' s.note, s.rejected_reason, s.approved_at,'
    + ' by_staff.name AS by_name, appr.name AS approved_by_name,'
    + ' count(l.*)::int AS lines,'
    + ' count(l.*) FILTER (WHERE l.variance <> 0)::int AS differed'
    + ' FROM stock_count s'
    + ' LEFT JOIN count_line l ON l.count_id = s.id'
    + ' LEFT JOIN chain.staff by_staff ON by_staff.id = s.by_staff'
    + ' LEFT JOIN chain.staff appr ON appr.id = s.approved_by'
    + ' GROUP BY s.id, by_staff.name, appr.name'
    + " ORDER BY (s.status = 'pending') DESC, s.at DESC LIMIT $1",
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]);

  return q.rows.map((r) => ({
    id: r.id, at: r.at, status: r.status,
    categories: r.categories || [],
    varianceValue: Number(r.variance_value),
    threshold: Number(r.threshold),
    note: r.note, rejectedReason: r.rejected_reason,
    by: r.by_name || null, approvedBy: r.approved_by_name || null, approvedAt: r.approved_at,
    lines: r.lines, differed: r.differed,
  }));
}

/**
 * A blank count sheet: what to go and count, in the kitchen's own categories.
 * §2's "count sheets by category".
 *
 * The EXPECTED figure is deliberately NOT on it. A sheet that tells somebody
 * what they are supposed to find is a sheet that gets agreed with rather than
 * counted, and the whole value of a stock check is that it is independent of
 * the number it is checking. The expected quantity is captured server-side at
 * the moment the count is submitted.
 */
async function countSheetFor(c, categories) {
  const wanted = Array.isArray(categories) && categories.length
    ? categories.map(String) : null;
  const q = await c.query(
    'SELECT id, name, unit, category FROM ingredient'
    /* Uncategorised items are on EVERY sheet. Something nobody has filed still
       has to be counted, and dropping it would let an item quietly go years
       without ever appearing on a sheet. */
    + ' WHERE $1::text[] IS NULL OR category = ANY($1) OR category IS NULL'
    + ' ORDER BY category NULLS FIRST, name', [wanted]);
  return q.rows.map((r) => ({
    id: r.id, name: r.name, unit: r.unit, category: r.category || null,
  }));
}

/** Every category in use, for the sheet picker. */
async function categories(c) {
  const q = await c.query(
    'SELECT category, count(*)::int AS n FROM ingredient'
    + ' WHERE category IS NOT NULL GROUP BY category ORDER BY category');
  const loose = await c.query(
    'SELECT count(*)::int AS n FROM ingredient WHERE category IS NULL');
  return {
    categories: q.rows.map((r) => ({ name: r.category, count: r.n })),
    uncategorised: loose.rows[0].n,
  };
}

/** One count sheet, line by line — units AND money, which is what §2 asks for.
 *  A line that matched is kept: "we checked and it was right" is a finding. */
async function countSheet(c, countId) {
  const head = await c.query(
    'SELECT s.*, by_staff.name AS by_name, appr.name AS approved_by_name'
    + ' FROM stock_count s'
    + ' LEFT JOIN chain.staff by_staff ON by_staff.id = s.by_staff'
    + ' LEFT JOIN chain.staff appr ON appr.id = s.approved_by'
    + ' WHERE s.id = $1', [countId]);
  if (!head.rows.length) throw Object.assign(new Error('no such count'), { status: 404 });
  const h = head.rows[0];

  const lines = await c.query(
    'SELECT l.ingredient_id, i.name, i.unit, l.expected, l.counted, l.variance,'
    + ' l.unit_cost, l.value'
    + ' FROM count_line l LEFT JOIN ingredient i ON i.id = l.ingredient_id'
    + ' WHERE l.count_id = $1 ORDER BY abs(l.value) DESC, i.name', [countId]);

  return {
    count: {
      id: h.id, at: h.at, status: h.status, categories: h.categories || [],
      varianceValue: Number(h.variance_value), threshold: Number(h.threshold),
      note: h.note, rejectedReason: h.rejected_reason,
      by: h.by_name || null, approvedBy: h.approved_by_name || null, approvedAt: h.approved_at,
      // Said explicitly rather than inferred from the status, because "the
      // stock has not moved" is the one thing a reader must not get wrong.
      applied: h.status === 'posted',
    },
    lines: lines.rows.map((r) => ({
      ingredientId: r.ingredient_id, name: r.name || r.ingredient_id, unit: r.unit,
      expected: Number(r.expected), counted: Number(r.counted),
      variance: Number(r.variance), unitCost: Number(r.unit_cost), value: Number(r.value),
    })),
  };
}

/* ── Stock Ledger (§2 `ledger`) ───────────────────────────────────────────
 * "Every movement with its reason and source document." Outlet-wide, newest
 * first, filterable — the per-item view in Inventory answers "why is this
 * showing 17.4"; this one answers "what happened to the store yesterday".
 */
async function movements(c, p) {
  const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 500);
  const offset = Math.max(Number(p.offset) || 0, 0);
  const reason = p.reason && REASONS.includes(p.reason) ? p.reason : null;

  const where = ' WHERE ($1::text IS NULL OR m.ingredient_id = $1)'
    + ' AND ($2::text IS NULL OR m.reason = $2)'
    + ' AND ($3::date IS NULL OR m.at::date >= $3::date)'
    + ' AND ($4::date IS NULL OR m.at::date <= $4::date)';
  const args = [p.ingredientId || null, reason, p.from || null, p.to || null];

  const [rows, totals] = await Promise.all([
    c.query(
      'SELECT m.id, m.at, m.ingredient_id, i.name, i.unit, m.qty, m.unit_cost, m.value,'
      + ' m.reason, m.sale_id, s.receipt_no, st.name AS by_name'
      + ' FROM stock_move m'
      + ' LEFT JOIN ingredient i ON i.id = m.ingredient_id'
      + ' LEFT JOIN sale s ON s.id = m.sale_id'
      + ' LEFT JOIN chain.staff st ON st.id = m.by_staff'
      + where + ' ORDER BY m.at DESC, m.id DESC LIMIT $5 OFFSET $6',
      [...args, limit, offset]),
    c.query(
      'SELECT count(*)::int AS n,'
      + ' coalesce(sum(m.value) FILTER (WHERE m.qty > 0),0) AS in_value,'
      + ' coalesce(sum(m.value) FILTER (WHERE m.qty < 0),0) AS out_value'
      + ' FROM stock_move m' + where, args),
  ]);

  return {
    moves: rows.rows.map((r) => ({
      id: r.id, at: r.at, ingredientId: r.ingredient_id,
      name: r.name || r.ingredient_id, unit: r.unit,
      qty: Number(r.qty), unitCost: Number(r.unit_cost), value: Number(r.value),
      reason: r.reason,
      /* No sub-location here. §2's "by sub-location" is a real requirement and
         this build does not have it — stock_move has no location column, and
         adding one nothing populates would be a field that always reads empty,
         which is worse than an absence somebody can see. */
      /* The SOURCE DOCUMENT §2 asks for. A sale names its receipt; everything
         else names the person who did it, because for a manual movement the
         person IS the document. */
      source: r.receipt_no || null, by: r.by_name || null,
    })),
    page: { limit, offset, count: totals.rows[0].n },
    value: {
      in: Number(totals.rows[0].in_value),
      out: Number(totals.rows[0].out_value),
      net: Math.round((Number(totals.rows[0].in_value) + Number(totals.rows[0].out_value)) * 100) / 100,
    },
    reasons: REASONS,
  };
}

module.exports = {
  move,
  receive, waste, count, approveCount, rejectCount,
  inventory, ledger, counts, countSheet, countSheetFor, categories,
  movements, REASONS, APPROVE_RANK,
};
