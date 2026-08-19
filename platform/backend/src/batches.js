'use strict';
/* Batches & Expiry — 02-POS-SPEC §2 (`batches`): "Lot tracking and expiry
 * alerts."
 *
 * TWO QUESTIONS, AND ONLY ONE OF THEM IS ABOUT DATES.
 *
 *   "What is about to go off" is asked every morning, and answering it is worth
 *   very little unless the quantities are honest — a list of batches that were
 *   used up last week is a list nobody reads twice. That is why allocation is
 *   done by the server on every movement (`stock.drawFefo`) rather than by
 *   asking anybody to scan anything.
 *
 *   "Which sales contained lot 24B-119" is asked once, by an inspector or a
 *   supplier issuing a recall, on the worst day of the year. It cannot be
 *   reconstructed after the fact from quantities, so every draw is recorded at
 *   the time: lot → draws → movements → sales → receipts and the hour they were
 *   printed.
 *
 * WHAT THIS DOES NOT CLAIM. FEFO is a MODEL of what a kitchen does, not a
 * record of it. A cook who reaches past the older tub is not lying to the
 * system — they are doing the thing the expiry alert exists to prevent — so the
 * trace says "the oldest open batch at that moment", and the screen says so
 * too. Pretending otherwise on a recall report would be worse than useless.
 */

const stock = require('./stock');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isoDay = (d) => (d instanceof Date
  ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10)
  : (d === null || d === undefined ? null : String(d).slice(0, 10)));
const n4 = (x) => Math.round(Number(x) * 10000) / 10000;

/* Far enough ahead to do something about it and near enough to be a today
   problem. Configurable per request; this is what the screen asks for. */
const SOON_DAYS = 7;

/* ── the list ────────────────────────────────────────────────────────────── */

/**
 * Open batches, soonest expiry first — which is both the order they will be
 * drawn in and the order somebody wants to read them in.
 *
 * `state` is computed here rather than on the screen, because a second screen
 * would compute it differently and "expiring" would come to mean two things.
 */
async function list(c, q) {
  const soon = Math.max(0, Math.min(Number(q.soonDays) || SOON_DAYS, 90));
  const params = [];
  const where = [];
  if (!q.includeClosed) where.push('b.closed_at IS NULL');
  if (q.ingredientId) { params.push(String(q.ingredientId)); where.push('b.ingredient_id = $' + params.length); }
  if (q.lot) { params.push('%' + String(q.lot) + '%'); where.push('b.lot ILIKE $' + params.length); }

  const rows = await c.query(
    'SELECT b.*, i.name, i.unit, s.name AS by_name,'
    + ' (b.expires_on - current_date) AS days'
    + ' FROM batch b JOIN ingredient i ON i.id = b.ingredient_id'
    + ' LEFT JOIN chain.staff s ON s.id = b.by_staff'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY b.closed_at IS NOT NULL, b.expires_on NULLS LAST, b.received_on'
    + ' LIMIT ' + Math.min(Number(q.limit) || 300, 1000), params);

  const batches = rows.rows.map((b) => {
    const days = b.days === null ? null : Number(b.days);
    return {
      id: b.id, ingredientId: b.ingredient_id, name: b.name, unit: b.unit,
      lot: b.lot, qtyIn: Number(b.qty_in), qtyLeft: Number(b.qty_left),
      unitCost: Number(b.unit_cost),
      value: Math.round(Number(b.qty_left) * Number(b.unit_cost) * 100) / 100,
      receivedOn: isoDay(b.received_on), expiresOn: isoDay(b.expires_on),
      daysLeft: days,
      closedAt: b.closed_at, closedReason: b.closed_reason,
      note: b.note, by: b.by_name || null,
      deliveryId: b.delivery_id, prepRunId: b.prep_run_id,
      state: b.closed_at ? (b.closed_reason || 'closed')
        : days === null ? 'no expiry'
          : days < 0 ? 'expired' : days <= soon ? 'expiring' : 'good',
    };
  });

  /* The picker's own list, carried here rather than fetched from `/inventory`.
     That endpoint is MANAGER rank because it carries COST, and recording a
     batch is a till-rank act — the person who opens the sack is who reads the
     date on it. Names and units only: nothing here is worth withholding, and
     nothing costly is included. */
  const pick = await c.query('SELECT id, name, unit FROM ingredient ORDER BY name');

  const open = batches.filter((b) => !b.closedAt);
  return {
    batches,
    ingredients: pick.rows,
    soonDays: soon,
    /* The two numbers a manager acts on, and the money attached to them —
       "four batches expiring" is a shrug; "MVR 812 expiring" is a decision. */
    expired: {
      count: open.filter((b) => b.state === 'expired').length,
      value: Math.round(open.filter((b) => b.state === 'expired')
        .reduce((a, b) => a + b.value, 0) * 100) / 100,
    },
    expiring: {
      count: open.filter((b) => b.state === 'expiring').length,
      value: Math.round(open.filter((b) => b.state === 'expiring')
        .reduce((a, b) => a + b.value, 0) * 100) / 100,
    },
    tracked: new Set(open.map((b) => b.ingredientId)).size,
  };
}

/* ── recording one ───────────────────────────────────────────────────────── */

/**
 * Record a batch of something already in the store.
 *
 * IT MOVES NO STOCK, and that is the point. The quantity arrived through a
 * delivery, a production run or an opening count and is already on hand;
 * recording a lot against it is saying which of the stock this is, not that
 * there is more of it. A batch that added stock would double every delivery.
 */
async function add(c, body, ctx) {
  const ingredientId = String(body.ingredientId || '').trim();
  const qty = Number(body.qty);
  if (!ingredientId) throw bad('a batch is a batch OF something');
  if (!Number.isFinite(qty) || qty <= 0) throw bad('how much came in?');
  const expires = body.expiresOn ? String(body.expiresOn).slice(0, 10) : null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw bad('that is not a date');

  const ing = await c.query('SELECT id, name, unit, avg_cost FROM ingredient WHERE id = $1',
    [ingredientId]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });

  const unitCost = body.unitCost === undefined || body.unitCost === ''
    ? Number(ing.rows[0].avg_cost) : Number(body.unitCost);
  if (!Number.isFinite(unitCost) || unitCost < 0) throw bad('a cost cannot be negative');

  const r = await c.query(
    'INSERT INTO batch (ingredient_id, lot, qty_in, qty_left, unit_cost,'
    + ' received_on, expires_on, note, by_staff)'
    + ' VALUES ($1,$2,$3,$3,$4,coalesce($5::date, current_date),$6,$7,$8) RETURNING id',
    [ingredientId, String(body.lot || '').trim() || null, qty, unitCost,
      body.receivedOn ? String(body.receivedOn).slice(0, 10) : null,
      expires, String(body.note || '').trim() || null, ctx.actor || null]);

  await c.query("SELECT chain.log('batch_add','batch',$1,NULL,$2)",
    [r.rows[0].id, JSON.stringify({ ingredientId, qty, lot: body.lot || null, expires })]);
  return list(c, {});
}

/* ── throwing one away ───────────────────────────────────────────────────── */

/**
 * Write a batch off — the expired half of this screen's job.
 *
 * It goes through the ordinary WASTAGE path, so the value lands in 5100 with
 * every other thing that was thrown away and appears in the wastage report
 * beside them. A write-off with its own account would be a second word for
 * waste, and a kitchen's real waste figure would be the sum of two screens
 * nobody adds up.
 */
async function writeOff(c, id, body, ctx) {
  const b = await c.query(
    'SELECT b.*, i.name, i.unit FROM batch b JOIN ingredient i ON i.id = b.ingredient_id'
    + ' WHERE b.id = $1 FOR UPDATE', [id]);
  if (!b.rows.length) throw Object.assign(new Error('no such batch'), { status: 404 });
  const batch = b.rows[0];
  if (batch.closed_at) throw bad('that batch is already closed');

  const qty = body.qty === undefined || body.qty === ''
    ? Number(batch.qty_left) : Number(body.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw bad('how much is being thrown away?');
  if (qty > Number(batch.qty_left) + 0.00005) {
    throw bad('there is only ' + n4(batch.qty_left) + ' ' + batch.unit + ' left in that batch');
  }
  const reason = String(body.reason || '').trim()
    || (batch.expires_on && isoDay(batch.expires_on) < new Date().toISOString().slice(0, 10)
      ? 'expired' : 'written off');

  /* The wastage path posts the journal and writes the movement; `drawFefo`
     inside it will draw from the OLDEST open batch, which may not be this one.
     So this batch is settled explicitly afterwards — the movement's value is
     right either way, and what changes is which lot is recorded as gone. */
  const before = Number(batch.qty_left);
  const r = await stock.waste(c, {
    ingredientId: batch.ingredient_id, qty,
    /* `note`, which is what wastage calls its reason and refuses to be without
       — an unexplained hole in the stock is an unexplained hole in the margin.
       The lot goes in it so the wastage report names the batch too. */
    note: reason + (batch.lot ? ' (lot ' + batch.lot + ')' : ''),
    date: body.date,
  }, ctx);

  const after = await c.query('SELECT qty_left FROM batch WHERE id = $1', [id]);
  const stillHere = Number(after.rows[0].qty_left);
  /* If FEFO happened to take it from somewhere else, close this batch for the
     amount it was meant to lose rather than leaving two batches half wrong. */
  const target = Math.max(0, n4(before - qty));
  if (stillHere > target) {
    await c.query('UPDATE batch SET qty_left = $2 WHERE id = $1', [id, target]);
  }
  await c.query(
    'UPDATE batch SET closed_at = CASE WHEN qty_left <= 0 THEN now() ELSE closed_at END,'
    + ' closed_reason = CASE WHEN qty_left <= 0 THEN $2 ELSE closed_reason END'
    + ' WHERE id = $1', [id, reason]);

  await c.query("SELECT chain.log('batch_writeoff','batch',$1,NULL,$2)",
    [id, JSON.stringify({ qty, reason, value: r.value })]);

  return { id, qty, reason, wasted: r, remaining: target };
}

/* ── the recall ─────────────────────────────────────────────────────────── */

/**
 * Where a lot went.
 *
 * The reason `batch_draw` exists. It walks the draws to the movements, the
 * movements to the sales, and the sales to their receipt numbers and times —
 * which is the answer to the only question anybody ever asks about a lot in
 * anger, and the one that cannot be reconstructed from quantities afterwards.
 *
 * A prep run is followed THROUGH: flour in a lot that went into a sauce shows
 * the sauce, and the sauce's own batches lead on to the dishes. One level, and
 * the screen says so — an unbounded walk over a graph a kitchen can build is a
 * query nobody can predict the cost of.
 */
async function trace(c, id) {
  const b = await c.query(
    'SELECT b.*, i.name, i.unit FROM batch b JOIN ingredient i ON i.id = b.ingredient_id'
    + ' WHERE b.id = $1', [id]);
  if (!b.rows.length) throw Object.assign(new Error('no such batch'), { status: 404 });
  const batch = b.rows[0];

  const draws = await c.query(
    'SELECT d.qty, d.at, m.id AS move_id, m.reason, m.sale_id, m.prep_run_id,'
    + ' s.receipt_no, s.at AS sale_at, s.business_date, s.channel,'
    + ' p.makes_id, pi.name AS prep_name'
    + ' FROM batch_draw d'
    + ' JOIN stock_move m ON m.id = d.stock_move_id'
    + ' LEFT JOIN sale s ON s.id = m.sale_id'
    + ' LEFT JOIN prep_run p ON p.id = m.prep_run_id'
    + ' LEFT JOIN ingredient pi ON pi.id = p.makes_id'
    + ' WHERE d.batch_id = $1 ORDER BY d.at', [id]);

  const sales = [];
  const preps = [];
  const other = [];
  for (const d of draws.rows) {
    const row = { qty: Number(d.qty), at: d.at, reason: d.reason };
    if (d.sale_id) {
      sales.push({ ...row, saleId: d.sale_id, receiptNo: d.receipt_no,
        soldAt: d.sale_at, businessDate: isoDay(d.business_date), channel: d.channel });
    } else if (d.prep_run_id) {
      preps.push({ ...row, prepRunId: d.prep_run_id, madeId: d.makes_id, made: d.prep_name });
    } else {
      other.push(row);
    }
  }

  return {
    batch: {
      id: batch.id, ingredientId: batch.ingredient_id, name: batch.name, unit: batch.unit,
      lot: batch.lot, qtyIn: Number(batch.qty_in), qtyLeft: Number(batch.qty_left),
      receivedOn: isoDay(batch.received_on), expiresOn: isoDay(batch.expires_on),
      closedAt: batch.closed_at, closedReason: batch.closed_reason,
    },
    sales, preps, other,
    drawn: n4(draws.rows.reduce((a, d) => a + Number(d.qty), 0)),
    /* Said in the payload, so no screen has to remember to say it. */
    basis: 'Allocation is first-to-expire-first-out, applied by the server when '
      + 'stock moves. It is a model of what the kitchen does, not a scan of what '
      + 'it did: a cook who reached past an older tub would not appear here.',
    followsPrep: preps.length > 0
      ? 'Some of this went into a batch of something else. Trace that batch to '
        + 'follow it to the dishes.'
      : null,
  };
}

module.exports = { list, add, writeOff, trace, SOON_DAYS };
