'use strict';
/* Indent Requests — 02-POS-SPEC §2 (`requests`): "A kitchen asks; a manager
 * approves."
 *
 * AND THE THING IT CONNECTS TO. `purchase_order` and `po_line` have existed
 * since the first migration, the PO document series has been minting numbers
 * nobody asked for, and nothing in this application had ever written a row to
 * either. Deliveries were received against a supplier and no order at all, so
 * "what we asked for" and "what turned up" were never the same conversation.
 * The chain is now whole:
 *
 *     the kitchen asks → a manager decides → it becomes an order →
 *     the delivery is received against that order
 *
 * A MANAGER APPROVES A QUANTITY, NOT A REQUEST. What was asked for and what was
 * approved sit side by side and neither overwrites the other, because "we asked
 * for 20 kg and were given 12" is the fact somebody needs at the stove. A
 * request that quietly comes back smaller is how a kitchen learns to pad the
 * next one.
 *
 * APPROVING MOVES NO STOCK AND PROMISES NOTHING. The goods do not exist yet.
 * Everything real happens when the order is placed and again when it arrives,
 * which is where the money and the stock already live — so this module writes
 * no journal at all, and the one place it touches the ledger's world is by
 * creating the order that a delivery will later be received against.
 */

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const n4 = (x) => Math.round(Number(x) * 10000) / 10000;
const mvr = (n) => Math.round(Number(n) * 100) / 100;

const STATES = ['open', 'decided', 'ordered', 'cancelled'];

/* ── reading ─────────────────────────────────────────────────────────────── */

async function list(c, q, ctx) {
  const params = [];
  const where = [];
  if (q.state && STATES.includes(String(q.state))) {
    params.push(String(q.state)); where.push('i.state = $' + params.length);
  }
  const days = Math.min(Math.max(Number(q.days) || 60, 1), 365);
  params.push(String(days));
  where.push("i.at > now() - ($" + params.length + " || ' days')::interval");

  const heads = await c.query(
    'SELECT i.*, s.name AS raised_by_name, d.name AS decided_by_name,'
    + ' p.po_no, p.status AS po_status'
    + ' FROM indent i'
    + ' LEFT JOIN chain.staff s ON s.id = i.raised_by'
    + ' LEFT JOIN chain.staff d ON d.id = i.decided_by'
    + ' LEFT JOIN purchase_order p ON p.id = i.po_id'
    + ' WHERE ' + where.join(' AND ')
    + ' ORDER BY i.at DESC LIMIT 200', params);
  if (!heads.rows.length) return { indents: [], waiting: 0, approvedNotOrdered: 0 };

  const ids = heads.rows.map((r) => r.id);
  const lines = await c.query(
    'SELECT l.*, g.name, g.unit, g.on_hand, g.par, g.avg_cost'
    + ' FROM indent_line l JOIN ingredient g ON g.id = l.ingredient_id'
    + ' WHERE l.indent_id = ANY($1) ORDER BY g.name', [ids]);

  const byIndent = new Map();
  for (const l of lines.rows) {
    if (!byIndent.has(l.indent_id)) byIndent.set(l.indent_id, []);
    byIndent.get(l.indent_id).push({
      id: String(l.id), ingredientId: l.ingredient_id, name: l.name, unit: l.unit,
      qty: Number(l.qty),
      approvedQty: l.approved_qty === null ? null : Number(l.approved_qty),
      note: l.note, reason: l.reason,
      /* What the store has and what it is meant to keep. A manager deciding a
         quantity is answering "do we need this", and the two figures beside the
         request are the answer — without them the decision is a guess about
         somebody else's shelf. */
      onHand: Number(l.on_hand), par: l.par === null ? null : Number(l.par),
      avgCost: Number(l.avg_cost),
    });
  }

  const indents = heads.rows.map((r) => {
    const ls = byIndent.get(r.id) || [];
    return {
      id: r.id, ref: r.ref, state: r.state,
      at: r.at, onDate: r.on_date, forArea: r.for_area,
      neededBy: r.needed_by, note: r.note, reason: r.reason,
      raisedBy: r.raised_by_name || null,
      decidedBy: r.decided_by_name || null, decidedAt: r.decided_at,
      poId: r.po_id, poNo: r.po_no, poStatus: r.po_status,
      lines: ls,
      /* What it would cost at what the store last paid — not a price anybody
         has quoted. Said as an estimate, because a manager approving a list
         needs a size and not a promise. */
      estimate: mvr(ls.reduce((a, l) =>
        a + (l.approvedQty === null ? l.qty : l.approvedQty) * l.avgCost, 0)),
      approvedLines: ls.filter((l) => l.approvedQty !== null && l.approvedQty > 0).length,
    };
  });

  return {
    indents,
    waiting: indents.filter((i) => i.state === 'open').length,
    /* The gap that matters and the one nobody looks for: approved, and nobody
       has actually ordered it. An indent stuck here is a kitchen that thinks
       something is coming. */
    approvedNotOrdered: indents.filter((i) => i.state === 'decided' && i.approvedLines).length,
    canDecide: ctx.rank >= 3,
    canOrder: ctx.rank >= 3,
  };
}

/* ── asking ──────────────────────────────────────────────────────────────── */

/**
 * Raise one. KITCHEN rank, deliberately: the person who can see the empty shelf
 * is a cook, and a request only a manager can enter is a request that gets made
 * by shouting instead.
 */
async function raise(c, body, ctx) {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('an indent with nothing on it is not a request');

  const clean = [];
  const seen = new Set();
  for (const l of lines) {
    const id = String(l.ingredientId || l.id || '').trim();
    const qty = Number(l.qty);
    if (!id) throw bad('a line with no ingredient');
    if (seen.has(id)) throw bad('the same thing twice — put the quantities together');
    if (!Number.isFinite(qty) || qty <= 0) throw bad('every line needs a quantity');
    seen.add(id);
    clean.push({ id, qty, note: String(l.note || '').trim() || null });
  }

  const ref = await c.query("SELECT chain.next_doc_no('IND') AS no");
  const head = await c.query(
    'INSERT INTO indent (ref, for_area, needed_by, note, raised_by)'
    + ' VALUES ($1,$2,$3,$4,$5) RETURNING id, ref, at',
    [ref.rows[0].no, String(body.forArea || '').trim() || null,
      body.neededBy ? String(body.neededBy).slice(0, 10) : null,
      String(body.note || '').trim() || null, ctx.actor || null]);

  for (const l of clean) {
    await c.query(
      'INSERT INTO indent_line (indent_id, ingredient_id, qty, note)'
      + ' VALUES ($1,$2,$3,$4)', [head.rows[0].id, l.id, l.qty, l.note]);
  }
  await c.query("SELECT chain.log('indent_raise','indent',$1,NULL,$2)",
    [head.rows[0].id, JSON.stringify({ lines: clean.length })]);
  return { id: head.rows[0].id, ref: head.rows[0].ref, at: head.rows[0].at };
}

/* ── deciding ────────────────────────────────────────────────────────────── */

/**
 * Approve, trim or turn down — per line.
 *
 * A line with no decision on it defaults to APPROVED IN FULL, because a manager
 * who reads a list and presses the button has agreed to it, and making them
 * retype every quantity is how the whole list gets approved unread. What has to
 * be explicit is cutting something: a trimmed or refused line carries a reason,
 * and an indent turned down in full with no explanation is how the next one
 * gets padded.
 */
async function decide(c, id, body, ctx) {
  const head = await c.query('SELECT * FROM indent WHERE id = $1 FOR UPDATE', [id]);
  if (!head.rows.length) throw Object.assign(new Error('no such indent'), { status: 404 });
  if (head.rows[0].state !== 'open') throw bad('that indent has already been decided');

  const lines = await c.query(
    'SELECT l.id, l.ingredient_id, l.qty, g.name FROM indent_line l'
    + ' JOIN ingredient g ON g.id = l.ingredient_id WHERE l.indent_id = $1', [id]);
  const decisions = new Map();
  for (const d of (Array.isArray(body.lines) ? body.lines : [])) {
    decisions.set(String(d.id || d.lineId || ''), d);
  }

  let approved = 0;
  for (const l of lines.rows) {
    const d = decisions.get(String(l.id));
    const wanted = Number(l.qty);
    let qty = wanted;
    let reason = null;
    if (d) {
      qty = d.approvedQty === undefined || d.approvedQty === '' ? wanted : Number(d.approvedQty);
      if (!Number.isFinite(qty) || qty < 0) throw bad('an approved quantity cannot be negative');
      if (qty > wanted) {
        /* Refused rather than silently allowed. Approving MORE than was asked
           for is somebody using the approval screen to order, which is a
           different act with a different rank. */
        throw bad('you can approve less than was asked for, not more — '
          + l.name + ' was asked for as ' + n4(wanted));
      }
      reason = String(d.reason || '').trim() || null;
      if (qty < wanted && !reason) {
        throw bad('say why ' + l.name + ' is being cut — a line that comes back '
          + 'smaller with no reason is how the next request gets padded');
      }
    }
    if (qty > 0) approved++;
    await c.query('UPDATE indent_line SET approved_qty = $2, reason = $3 WHERE id = $1',
      [l.id, qty, reason]);
  }

  const reason = String(body.reason || '').trim() || null;
  if (approved === 0 && !reason) {
    throw bad('an indent turned down in full needs a reason');
  }
  await c.query(
    "UPDATE indent SET state = 'decided', decided_by = $2, decided_at = now(),"
    + ' reason = $3 WHERE id = $1', [id, ctx.actor || null, reason]);
  await c.query("SELECT chain.log('indent_decide','indent',$1,NULL,$2)",
    [id, JSON.stringify({ approvedLines: approved, of: lines.rows.length, reason })]);
  return { id, approvedLines: approved, of: lines.rows.length, reason };
}

/* ── ordering it ─────────────────────────────────────────────────────────── */

/**
 * Turn the approved lines into a purchase order.
 *
 * THIS IS THE FIRST ROW `purchase_order` HAS EVER HELD. The price on each line
 * is what the store last paid unless somebody types a better one — an order
 * with no prices on it is a document nobody can check a delivery against, and
 * the average is the only figure available before a supplier quotes.
 */
async function order(c, id, body, ctx) {
  const head = await c.query('SELECT * FROM indent WHERE id = $1 FOR UPDATE', [id]);
  if (!head.rows.length) throw Object.assign(new Error('no such indent'), { status: 404 });
  const ind = head.rows[0];
  if (ind.state !== 'decided') throw bad('decide it before ordering it');
  if (ind.po_id) throw bad('that indent has already been ordered');

  const supplierId = String(body.supplierId || '').trim();
  /* Checked as text before it reaches the query: a blank or malformed id is
     somebody's form, and `where id = ''` is a 500 from the type parser rather
     than the "no such supplier" the caller asked about. */
  if (!/^[0-9a-f-]{36}$/i.test(supplierId)) {
    throw Object.assign(new Error('no such supplier'), { status: 404 });
  }
  const sup = await c.query('SELECT id, name FROM chain.supplier WHERE id = $1', [supplierId]);
  if (!sup.rows.length) throw Object.assign(new Error('no such supplier'), { status: 404 });

  const lines = await c.query(
    'SELECT l.*, g.name, g.unit, g.avg_cost FROM indent_line l'
    + ' JOIN ingredient g ON g.id = l.ingredient_id'
    + ' WHERE l.indent_id = $1 AND l.approved_qty > 0 ORDER BY g.name', [id]);
  if (!lines.rows.length) throw bad('nothing on that indent was approved');

  const prices = new Map();
  for (const p of (Array.isArray(body.prices) ? body.prices : [])) {
    prices.set(String(p.ingredientId || ''), Number(p.unitPrice));
  }

  const no = await c.query("SELECT chain.next_doc_no('PO') AS no");
  const po = await c.query(
    'INSERT INTO purchase_order (po_no, supplier_id, raised_by, approved_by,'
    + " approved_at, status, expected, total)"
    + " VALUES ($1,$2,$3,$3,now(),'sent',$4,0) RETURNING id, po_no",
    [no.rows[0].no, supplierId, ctx.actor, ind.needed_by]);
  const poId = po.rows[0].id;

  let total = 0;
  const out = [];
  for (const l of lines.rows) {
    const asked = prices.get(l.ingredient_id);
    const price = Number.isFinite(asked) && asked >= 0 ? asked : Number(l.avg_cost);
    const qty = Number(l.approved_qty);
    await c.query(
      'INSERT INTO po_line (po_id, ingredient_id, qty, unit_price) VALUES ($1,$2,$3,$4)',
      [poId, l.ingredient_id, qty, price]);
    total += qty * price;
    out.push({ ingredientId: l.ingredient_id, name: l.name, unit: l.unit,
      qty, unitPrice: price, value: mvr(qty * price),
      /* Said, because an order priced off the last delivery is an estimate and
         a supplier is entitled to disagree with it. */
      pricedFrom: Number.isFinite(asked) ? 'entered' : 'last paid' });
  }
  await c.query('UPDATE purchase_order SET total = $2 WHERE id = $1', [poId, mvr(total)]);
  await c.query("UPDATE indent SET state = 'ordered', po_id = $2 WHERE id = $1", [id, poId]);

  await c.query("SELECT chain.log('indent_order','indent',$1,NULL,$2)",
    [id, JSON.stringify({ poNo: po.rows[0].po_no, lines: out.length, total: mvr(total) })]);

  return {
    id, poId, poNo: po.rows[0].po_no, supplier: sup.rows[0].name,
    lines: out, total: mvr(total),
    /* No journal, and it is worth saying why: an order is a promise, not a
       transaction. Nothing is owed until something arrives, and that is
       exactly where the delivery path already books it. */
    ledger: 'none — an order is a promise, not a purchase. The money moves when '
      + 'the delivery is received against it.',
  };
}

async function cancel(c, id, body, ctx) {
  const reason = String(body.reason || '').trim();
  if (!reason) throw bad('say why');
  const r = await c.query(
    "UPDATE indent SET state = 'cancelled', reason = $2, decided_by = $3,"
    + " decided_at = now() WHERE id = $1 AND state IN ('open','decided') RETURNING id",
    [id, reason, ctx.actor || null]);
  if (!r.rows.length) throw bad('that indent cannot be cancelled now');
  await c.query("SELECT chain.log('indent_cancel','indent',$1,NULL,$2)",
    [id, JSON.stringify({ reason })]);
  return { id, state: 'cancelled', reason };
}

/* ── the orders themselves ───────────────────────────────────────────────── */

/** Open orders, so a delivery can be received against one. The other half of
 *  the chain: until now `purchase_order` was a table with a document series and
 *  no rows, and a delivery arrived against a supplier and no order. */
async function orders(c, q) {
  const rows = await c.query(
    'SELECT p.*, s.name AS supplier_name,'
    + ' (SELECT count(*)::int FROM po_line l WHERE l.po_id = p.id) AS lines,'
    + ' (SELECT coalesce(sum(l.qty - l.received_qty),0) FROM po_line l'
    + '   WHERE l.po_id = p.id) AS outstanding'
    + ' FROM purchase_order p'
    + ' LEFT JOIN chain.supplier s ON s.id = p.supplier_id'
    + (q.open ? " WHERE p.status IN ('sent','part')" : '')
    + ' ORDER BY p.raised_at DESC LIMIT 100');

  const ids = rows.rows.map((r) => r.id);
  const lines = ids.length ? await c.query(
    'SELECT l.*, g.name, g.unit FROM po_line l'
    + ' LEFT JOIN ingredient g ON g.id = l.ingredient_id'
    + ' WHERE l.po_id = ANY($1) ORDER BY g.name', [ids]) : { rows: [] };
  const byPo = new Map();
  for (const l of lines.rows) {
    if (!byPo.has(l.po_id)) byPo.set(l.po_id, []);
    byPo.get(l.po_id).push({
      ingredientId: l.ingredient_id, name: l.name || l.ingredient_id, unit: l.unit,
      qty: Number(l.qty), receivedQty: Number(l.received_qty),
      outstanding: n4(Number(l.qty) - Number(l.received_qty)),
      unitPrice: Number(l.unit_price),
    });
  }

  return {
    orders: rows.rows.map((r) => ({
      id: r.id, poNo: r.po_no, supplier: r.supplier_name || null,
      status: r.status, raisedAt: r.raised_at, expected: r.expected,
      total: Number(r.total), lines: byPo.get(r.id) || [],
      outstanding: n4(r.outstanding),
    })),
  };
}

module.exports = { list, raise, decide, order, cancel, orders };
