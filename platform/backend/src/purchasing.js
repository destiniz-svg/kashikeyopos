'use strict';
/* Vendors and Purchases — 02-POS-SPEC.md §2:
 *   `vendors`   "Supplier master, terms, price history."
 *   `purchases` "PO → delivery → priced GRN → vendor invoice → ageing."
 *
 * This is the link in the chain that 08-BUILD-STAGES §12 describes from the
 * other end: "a price captured on a GRN updates the ingredient's average cost
 * and therefore every dish that uses it". Until now stock could only enter
 * through a bare `stock_receive` with no document behind it — no supplier, no
 * reference, nothing to telephone anybody about.
 *
 * THE UNPRICED DELIVERY IS THE NORMAL CASE, and designing for the priced one
 * first is how purchasing modules end up unused. A driver hands over fish and
 * leaves; the invoice arrives days later, by email, from accounts. The stock
 * has to rise the moment the fish is in the walk-in or the next sale oversells
 * it. So:
 *
 *   receive  →  stock rises at the ingredient's CURRENT average cost,
 *               posted Dr 1100 / Cr 2000 at that provisional value,
 *               and the GRN is flagged `priced = false`
 *   price    →  the difference between provisional and invoiced is posted,
 *               and the average cost is corrected
 *
 * That flag is what the Today screen means by "unpriced deliveries" — a phrase
 * in the spec that this module finally makes true rather than approximate.
 *
 * WHERE A LATE PRICE CORRECTION LANDS. If the stock is still in the building,
 * the difference belongs on the shelf: Dr/Cr 1100. If it has already been sold,
 * the shelf is empty and the correction is a cost-of-sales one: 5100. Sending
 * everything to 1100 would slowly inflate an inventory figure against stock
 * that is not there, and nobody would ever find it.
 */

const stock = require('./stock');

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;

/* ── the supplier master ─────────────────────────────────────────────────── */

async function suppliers(c) {
  const q = await c.query(
    'SELECT id, name, trn, terms_days, active FROM chain.supplier ORDER BY active DESC, name');
  return q.rows.map((r) => ({
    id: r.id, name: r.name, trn: r.trn,
    termsDays: r.terms_days, active: r.active,
  }));
}

function cleanSupplier(body) {
  const out = {};
  if (body.name !== undefined) {
    const v = String(body.name).trim();
    if (!v) throw Object.assign(new Error('a supplier needs a name'), { status: 400 });
    out.name = v.slice(0, 160);
  }
  if (body.trn !== undefined) out.trn = String(body.trn || '').trim().slice(0, 40) || null;
  if (body.termsDays !== undefined) {
    const n = Number(body.termsDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      throw Object.assign(new Error('payment terms must be between 0 and 365 days'), { status: 400 });
    }
    out.terms_days = n;
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  return out;
}

async function createSupplier(c, body, ctx) {
  const f = cleanSupplier(body);
  if (!f.name) throw Object.assign(new Error('a supplier needs a name'), { status: 400 });
  const q = await c.query(
    'INSERT INTO chain.supplier (name, trn, terms_days, active)'
    + ' VALUES ($1,$2,$3,true) RETURNING id, name, trn, terms_days, active',
    [f.name, f.trn ?? null, f.terms_days ?? 30]);
  await c.query("SELECT chain.log('supplier_create','supplier',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ name: f.name })]);
  const r = q.rows[0];
  return { id: r.id, name: r.name, trn: r.trn, termsDays: r.terms_days, active: r.active };
}

async function updateSupplier(c, id, body, ctx) {
  const f = cleanSupplier(body);
  const keys = Object.keys(f);
  if (!keys.length) throw Object.assign(new Error('nothing to change'), { status: 400 });
  const sets = keys.map((k, i) => k + ' = $' + (i + 2));
  const q = await c.query(
    'UPDATE chain.supplier SET ' + sets.join(', ') + ' WHERE id = $1'
    + ' RETURNING id, name, trn, terms_days, active', [id, ...keys.map((k) => f[k])]);
  if (!q.rows.length) throw Object.assign(new Error('no such supplier'), { status: 404 });
  await c.query("SELECT chain.log('supplier_update','supplier',$1,NULL,$2)",
    [id, JSON.stringify(f)]);
  const r = q.rows[0];
  return { id: r.id, name: r.name, trn: r.trn, termsDays: r.terms_days, active: r.active };
}

/**
 * One supplier: the record, what THIS OUTLET has bought from them, and the
 * price history §2 asks for — every price this outlet has been charged for each
 * ingredient, newest first, so "they have put the tuna up twice since March" is
 * a thing somebody can see rather than suspect.
 */
async function supplier(c, id) {
  const s = await c.query(
    'SELECT id, name, trn, terms_days, active FROM chain.supplier WHERE id = $1', [id]);
  if (!s.rows.length) throw Object.assign(new Error('no such supplier'), { status: 404 });

  const [deliveries, prices, owed] = await Promise.all([
    c.query('SELECT d.id, d.grn_no, d.at, d.total, d.priced,'
      + ' (SELECT count(*)::int FROM delivery_line l WHERE l.delivery_id = d.id) AS lines'
      + ' FROM delivery d WHERE d.supplier_id = $1 ORDER BY d.at DESC LIMIT 30', [id]),
    c.query('SELECT l.ingredient_id, i.name, i.unit, l.unit_price, l.qty, d.at, d.grn_no'
      + ' FROM delivery_line l'
      + ' JOIN delivery d ON d.id = l.delivery_id'
      + ' LEFT JOIN ingredient i ON i.id = l.ingredient_id'
      + ' WHERE d.supplier_id = $1 AND l.unit_price IS NOT NULL'
      + ' ORDER BY i.name, d.at DESC', [id]),
    c.query('SELECT coalesce(sum(amount - paid),0) AS owed FROM vendor_invoice'
      + ' WHERE supplier_id = $1 AND paid < amount', [id]),
  ]);

  /* Grouped per ingredient, with the direction of travel. A list of prices is
     data; "up 12% since you last bought it" is the thing that changes a
     decision. */
  const byIngredient = new Map();
  for (const r of prices.rows) {
    if (!byIngredient.has(r.ingredient_id)) {
      byIngredient.set(r.ingredient_id, {
        ingredientId: r.ingredient_id, name: r.name || r.ingredient_id, unit: r.unit,
        prices: [],
      });
    }
    byIngredient.get(r.ingredient_id).prices.push({
      at: r.at, grnNo: r.grn_no, unitPrice: Number(r.unit_price), qty: Number(r.qty),
    });
  }

  return {
    supplier: {
      id: s.rows[0].id, name: s.rows[0].name, trn: s.rows[0].trn,
      termsDays: s.rows[0].terms_days, active: s.rows[0].active,
      owed: money(owed.rows[0].owed),
    },
    deliveries: deliveries.rows.map((r) => ({
      id: r.id, grnNo: r.grn_no, at: r.at, total: money(r.total),
      priced: r.priced, lines: r.lines,
    })),
    priceHistory: [...byIngredient.values()].map((x) => {
      const latest = x.prices[0].unitPrice;
      const previous = x.prices.length > 1 ? x.prices[1].unitPrice : null;
      return {
        ...x,
        latest,
        previous,
        changePct: previous ? Math.round(((latest - previous) / previous) * 1000) / 10 : null,
      };
    }),
  };
}

/* ── receiving a delivery ────────────────────────────────────────────────── */

/**
 * A GRN. Raises stock, posts one journal for the document, and records what was
 * invoiced — or that nothing was.
 *
 * p = { supplierId, lines: [{ ingredientId, qty, unitPrice? }], note?, date?,
 *       invoiceNo?, invoiceDate? }
 */
async function receiveDelivery(c, p, ctx) {
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) {
    throw Object.assign(new Error('a delivery needs at least one line'), { status: 400 });
  }
  const sup = await c.query('SELECT id, name, terms_days FROM chain.supplier WHERE id = $1',
    [String(p.supplierId || '')]);
  if (!sup.rows.length) throw Object.assign(new Error('no such supplier'), { status: 404 });

  const date = p.date || new Date().toISOString().slice(0, 10);
  /* Priced only if EVERY line carries a price. A part-priced delivery is an
     unpriced one with some of the answers — treating it as priced would leave
     the missing lines silently valued at the old average forever. */
  const priced = lines.every((l) => l.unitPrice !== undefined && l.unitPrice !== null
    && l.unitPrice !== '');

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['GRN']);
  const head = await c.query(
    'INSERT INTO delivery (grn_no, supplier_id, received_by, priced, total, note,'
    + ' priced_at, priced_by)'
    + ' VALUES ($1,$2,$3,$4,0,$5,$6,$7) RETURNING id, grn_no',
    [no.rows[0].no, sup.rows[0].id, ctx.actor, priced,
      p.note ? String(p.note).slice(0, 200) : null,
      priced ? new Date() : null, priced ? ctx.actor : null]);
  const deliveryId = head.rows[0].id;

  let totalLaari = 0;
  const results = [];
  for (const l of lines) {
    const hasPrice = l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== '';
    const r = await stock.receiveLine(c, {
      ingredientId: l.ingredientId, qty: l.qty,
      // No price? Raise it at what the shelf already thinks it is worth. Zero
      // would understate the inventory and make every dish using it look free.
      unitCost: hasPrice ? Number(l.unitPrice) : undefined,
      reason: 'purchase', date,
    }, ctx);

    await c.query(
      'INSERT INTO delivery_line (delivery_id, ingredient_id, qty, unit_price, provisional_cost)'
      + ' VALUES ($1,$2,$3,$4,$5)',
      [deliveryId, r.ingredientId, r.qty, hasPrice ? Number(l.unitPrice) : null, r.unitCost]);

    totalLaari += r.valueLaari;
    results.push({
      ingredientId: r.ingredientId, name: r.name, qty: r.qty,
      unitPrice: hasPrice ? Number(l.unitPrice) : null,
      provisionalCost: r.unitCost, value: toMVR(r.valueLaari), avgCost: r.avgCost,
    });
  }

  await c.query('UPDATE delivery SET total = $2 WHERE id = $1', [deliveryId, toMVR(totalLaari)]);

  /* ONE journal for the document. Dr 1100 Inventory, Cr 2000 Accounts payable —
     the goods are on the shelf and the money is owed, whether or not anybody
     has yet said how much. */
  await stock.postStockJournal(c, {
    date,
    memo: 'Delivery ' + head.rows[0].grn_no + ' — ' + sup.rows[0].name
      + (priced ? '' : ' (unpriced)'),
    dr: '1100', cr: '2000', valueLaari: totalLaari, sourceId: deliveryId,
  }, ctx);

  /* An invoice, when one came with it. The due date is derived from the
     supplier's terms rather than typed: terms are the supplier's, and a date
     somebody keys by hand is a date that will be keyed wrongly on the one
     invoice that matters. */
  let invoice = null;
  if (p.invoiceNo) {
    invoice = await recordInvoice(c, {
      supplierId: sup.rows[0].id, invoiceNo: p.invoiceNo,
      invoiceDate: p.invoiceDate || date, amount: totalLaari / 100,
      deliveryId, termsDays: sup.rows[0].terms_days,
    }, ctx);
  }

  await c.query("SELECT chain.log('delivery_receive','delivery',$1,NULL,$2)",
    [deliveryId, JSON.stringify({
      grn: head.rows[0].grn_no, supplier: sup.rows[0].name,
      lines: results.length, total: toMVR(totalLaari), priced,
    })]);

  return {
    deliveryId, grnNo: head.rows[0].grn_no, priced,
    total: toMVR(totalLaari), lines: results, invoice,
    message: priced ? undefined
      : 'Received without prices. The stock is on the shelf, valued at what it'
        + ' was already worth — put the invoice prices in when they arrive and'
        + ' every recipe recosts.',
  };
}

/**
 * The invoice turns up. Correct the value.
 *
 * p = { deliveryId, lines: [{ ingredientId, unitPrice }], invoiceNo?, invoiceDate? }
 */
async function priceDelivery(c, p, ctx) {
  const d = await c.query(
    'SELECT d.id, d.grn_no, d.supplier_id, d.priced, s.name, s.terms_days'
    + ' FROM delivery d JOIN chain.supplier s ON s.id = d.supplier_id'
    + ' WHERE d.id = $1 FOR UPDATE OF d', [String(p.deliveryId || '')]);
  if (!d.rows.length) throw Object.assign(new Error('no such delivery'), { status: 404 });
  if (d.rows[0].priced) {
    throw Object.assign(new Error('that delivery is already priced'), { status: 409 });
  }

  const given = new Map((Array.isArray(p.lines) ? p.lines : [])
    .map((l) => [String(l.ingredientId), Number(l.unitPrice)]));
  const existing = await c.query(
    'SELECT ingredient_id, qty, provisional_cost, unit_price FROM delivery_line'
    + ' WHERE delivery_id = $1', [d.rows[0].id]);

  const missing = existing.rows.filter((r) =>
    r.unit_price === null && !Number.isFinite(given.get(r.ingredient_id)));
  if (missing.length) {
    throw Object.assign(new Error(
      'every line needs a price — still missing: '
      + missing.map((m) => m.ingredient_id).join(', ')), { status: 400 });
  }

  const date = p.invoiceDate || new Date().toISOString().slice(0, 10);
  let onShelfLaari = 0;    // difference belonging to stock still in the building
  let soldLaari = 0;       // difference on stock already gone
  let totalLaari = 0;
  const results = [];

  for (const row of existing.rows) {
    const id = row.ingredient_id;
    const qty = Number(row.qty);
    const provisional = Number(row.provisional_cost);
    const invoiced = row.unit_price === null ? given.get(id) : Number(row.unit_price);
    if (!Number.isFinite(invoiced) || invoiced < 0) {
      throw Object.assign(new Error('a price cannot be negative'), { status: 400 });
    }

    const diffLaari = Math.round((invoiced - provisional) * qty * 100);
    totalLaari += Math.round(invoiced * qty * 100);

    const ing = await c.query(
      'SELECT on_hand, avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [id]);
    const onHand = Number(ing.rows[0].on_hand);

    /* Spread the price difference over what is still on the shelf. Only the
       part of the delivery that has not been sold can be revalued; the rest was
       consumed at the provisional cost and its correction is a cost-of-sales
       one. `remaining` is bounded by the delivered quantity — a shelf holding
       more than this delivery brought is holding somebody else's stock too, and
       revaluing that at this invoice's difference would be wrong. */
    const remaining = Math.max(0, Math.min(qty, onHand));
    const consumed = qty - remaining;
    onShelfLaari += Math.round((invoiced - provisional) * remaining * 100);
    soldLaari += Math.round((invoiced - provisional) * consumed * 100);

    if (onHand > 0) {
      const adjust = ((invoiced - provisional) * remaining) / onHand;
      const newAvg = Math.round((Number(ing.rows[0].avg_cost) + adjust) * 10000) / 10000;
      await c.query('UPDATE ingredient SET avg_cost = $2 WHERE id = $1',
        [id, Math.max(0, newAvg)]);
    }

    await c.query('UPDATE delivery_line SET unit_price = $3'
      + ' WHERE delivery_id = $1 AND ingredient_id = $2', [d.rows[0].id, id, invoiced]);

    results.push({
      ingredientId: id, qty, provisionalCost: provisional, unitPrice: invoiced,
      difference: toMVR(diffLaari),
    });
  }

  await c.query(
    "UPDATE delivery SET priced = true, priced_at = now(), priced_by = $2, total = $3"
    + ' WHERE id = $1', [d.rows[0].id, ctx.actor, toMVR(totalLaari)]);

  /* Two corrections, not one, because they belong in different places. What is
     still on the shelf revalues the shelf; what has been sold corrects the cost
     of having sold it. Posting both to 1100 would inflate an inventory figure
     against stock that is not in the building. */
  if (onShelfLaari !== 0) {
    await stock.postStockJournal(c, {
      date, memo: 'Price correction on ' + d.rows[0].grn_no + ' — ' + d.rows[0].name,
      dr: onShelfLaari > 0 ? '1100' : '2000',
      cr: onShelfLaari > 0 ? '2000' : '1100',
      valueLaari: Math.abs(onShelfLaari), sourceId: d.rows[0].id,
    }, ctx);
  }
  if (soldLaari !== 0) {
    await stock.postStockJournal(c, {
      date,
      memo: 'Price correction on ' + d.rows[0].grn_no + ' — stock already sold',
      dr: soldLaari > 0 ? '5100' : '2000',
      cr: soldLaari > 0 ? '2000' : '5100',
      valueLaari: Math.abs(soldLaari), sourceId: d.rows[0].id,
    }, ctx);
  }

  let invoice = null;
  if (p.invoiceNo) {
    invoice = await recordInvoice(c, {
      supplierId: d.rows[0].supplier_id, invoiceNo: p.invoiceNo,
      invoiceDate: date, amount: totalLaari / 100,
      deliveryId: d.rows[0].id, termsDays: d.rows[0].terms_days,
    }, ctx);
  }

  await c.query("SELECT chain.log('delivery_price','delivery',$1,NULL,$2)",
    [d.rows[0].id, JSON.stringify({
      grn: d.rows[0].grn_no, total: toMVR(totalLaari),
      onShelf: toMVR(onShelfLaari), alreadySold: toMVR(soldLaari),
    })]);

  return {
    deliveryId: d.rows[0].id, grnNo: d.rows[0].grn_no, priced: true,
    total: toMVR(totalLaari), lines: results, invoice,
    correction: { onShelf: toMVR(onShelfLaari), alreadySold: toMVR(soldLaari) },
  };
}

/** A vendor invoice, due on a date derived from the supplier's own terms. */
async function recordInvoice(c, p, ctx) {
  const q = await c.query(
    'INSERT INTO vendor_invoice (supplier_id, invoice_no, invoice_date, due_date,'
    + ' amount, delivery_id)'
    + " VALUES ($1,$2,$3::date,$3::date + ($4 || ' days')::interval,$5,$6)"
    + ' ON CONFLICT (supplier_id, invoice_no) DO UPDATE SET amount = excluded.amount'
    + ' RETURNING id, invoice_no, due_date, amount',
    [p.supplierId, String(p.invoiceNo).slice(0, 60), p.invoiceDate,
      String(Number(p.termsDays) || 30), money(p.amount), p.deliveryId || null]);
  return {
    id: q.rows[0].id, invoiceNo: q.rows[0].invoice_no,
    dueDate: q.rows[0].due_date, amount: money(q.rows[0].amount),
  };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

async function deliveries(c, limit) {
  const q = await c.query(
    'SELECT d.id, d.grn_no, d.at, d.total, d.priced, d.note, s.name AS supplier,'
    + ' st.name AS received_by_name,'
    + ' (SELECT count(*)::int FROM delivery_line l WHERE l.delivery_id = d.id) AS lines,'
    + ' (SELECT invoice_no FROM vendor_invoice v WHERE v.delivery_id = d.id LIMIT 1) AS invoice_no'
    + ' FROM delivery d'
    + ' LEFT JOIN chain.supplier s ON s.id = d.supplier_id'
    + ' LEFT JOIN chain.staff st ON st.id = d.received_by'
    // Unpriced first, whatever the date: it is the only row on the screen that
    // is somebody's job.
    + ' ORDER BY d.priced ASC, d.at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]);
  return q.rows.map((r) => ({
    id: r.id, grnNo: r.grn_no, at: r.at, total: money(r.total), priced: r.priced,
    note: r.note, supplier: r.supplier, receivedBy: r.received_by_name || null,
    lines: r.lines, invoiceNo: r.invoice_no,
  }));
}

async function delivery(c, id) {
  const d = await c.query(
    'SELECT d.*, s.name AS supplier, s.terms_days, st.name AS received_by_name,'
    + ' pb.name AS priced_by_name'
    + ' FROM delivery d'
    + ' LEFT JOIN chain.supplier s ON s.id = d.supplier_id'
    + ' LEFT JOIN chain.staff st ON st.id = d.received_by'
    + ' LEFT JOIN chain.staff pb ON pb.id = d.priced_by'
    + ' WHERE d.id = $1', [id]);
  if (!d.rows.length) throw Object.assign(new Error('no such delivery'), { status: 404 });

  const [lines, invoice] = await Promise.all([
    c.query('SELECT l.ingredient_id, i.name, i.unit, l.qty, l.unit_price,'
      + ' l.provisional_cost, i.avg_cost'
      + ' FROM delivery_line l LEFT JOIN ingredient i ON i.id = l.ingredient_id'
      + ' WHERE l.delivery_id = $1 ORDER BY i.name', [id]),
    c.query('SELECT id, invoice_no, invoice_date, due_date, amount, paid'
      + ' FROM vendor_invoice WHERE delivery_id = $1 LIMIT 1', [id]),
  ]);

  const h = d.rows[0];
  return {
    delivery: {
      id: h.id, grnNo: h.grn_no, at: h.at, total: money(h.total), priced: h.priced,
      note: h.note, supplier: h.supplier, supplierId: h.supplier_id,
      termsDays: h.terms_days,
      receivedBy: h.received_by_name || null,
      pricedAt: h.priced_at, pricedBy: h.priced_by_name || null,
    },
    lines: lines.rows.map((r) => ({
      ingredientId: r.ingredient_id, name: r.name || r.ingredient_id, unit: r.unit,
      qty: Number(r.qty),
      unitPrice: r.unit_price === null ? null : Number(r.unit_price),
      provisionalCost: Number(r.provisional_cost),
      currentAvgCost: r.avg_cost === null ? null : Number(r.avg_cost),
      value: r.unit_price === null
        ? money(Number(r.qty) * Number(r.provisional_cost))
        : money(Number(r.qty) * Number(r.unit_price)),
    })),
    invoice: invoice.rows.length ? {
      id: invoice.rows[0].id, invoiceNo: invoice.rows[0].invoice_no,
      invoiceDate: invoice.rows[0].invoice_date, dueDate: invoice.rows[0].due_date,
      amount: money(invoice.rows[0].amount), paid: money(invoice.rows[0].paid),
    } : null,
  };
}

/* §2's "ageing". Buckets from the DUE date, not the invoice date — an invoice
   on 60-day terms is not overdue at 45 days, and an ageing report that counts
   from the invoice date says it is. */
const BUCKETS = [
  { key: 'current', label: 'Not due yet', from: null, to: 0 },
  { key: 'd30', label: '1–30 days over', from: 1, to: 30 },
  { key: 'd60', label: '31–60 days over', from: 31, to: 60 },
  { key: 'd90', label: 'Over 60 days', from: 61, to: null },
];

async function ageing(c) {
  const q = await c.query(
    'SELECT v.id, v.invoice_no, v.invoice_date, v.due_date, v.amount, v.paid,'
    + ' v.delivery_id, d.grn_no, s.id AS supplier_id, s.name AS supplier,'
    + ' (current_date - v.due_date)::int AS days_over'
    + ' FROM vendor_invoice v'
    + ' LEFT JOIN chain.supplier s ON s.id = v.supplier_id'
    + ' LEFT JOIN delivery d ON d.id = v.delivery_id'
    + ' WHERE v.paid < v.amount ORDER BY v.due_date');

  const rows = q.rows.map((r) => {
    const over = r.days_over;
    const bucket = over <= 0 ? 'current' : over <= 30 ? 'd30' : over <= 60 ? 'd60' : 'd90';
    return {
      id: r.id, invoiceNo: r.invoice_no, invoiceDate: r.invoice_date,
      dueDate: r.due_date, daysOver: over, bucket,
      amount: money(r.amount), paid: money(r.paid),
      outstanding: money(Number(r.amount) - Number(r.paid)),
      supplierId: r.supplier_id, supplier: r.supplier,
      grnNo: r.grn_no, deliveryId: r.delivery_id,
    };
  });

  const totals = {};
  for (const b of BUCKETS) {
    totals[b.key] = money(rows.filter((x) => x.bucket === b.key)
      .reduce((a, x) => a + x.outstanding, 0));
  }
  return {
    buckets: BUCKETS,
    invoices: rows,
    totals,
    owed: money(rows.reduce((a, x) => a + x.outstanding, 0)),
    overdue: money(rows.filter((x) => x.daysOver > 0).reduce((a, x) => a + x.outstanding, 0)),
  };
}

/** Record a payment against an invoice. Dr 2000 Accounts payable, Cr the money. */
async function payInvoice(c, p, ctx) {
  const amount = toLaari(p.amount || 0);
  if (!(amount > 0)) throw Object.assign(new Error('pay an amount above zero'), { status: 400 });
  const method = ['bank', 'cash'].includes(p.method) ? p.method : 'bank';

  const inv = await c.query(
    'SELECT v.id, v.invoice_no, v.amount, v.paid, s.name AS supplier'
    + ' FROM vendor_invoice v LEFT JOIN chain.supplier s ON s.id = v.supplier_id'
    + ' WHERE v.id = $1 FOR UPDATE OF v', [String(p.invoiceId || '')]);
  if (!inv.rows.length) throw Object.assign(new Error('no such invoice'), { status: 404 });

  const outstanding = toLaari(inv.rows[0].amount) - toLaari(inv.rows[0].paid);
  if (amount > outstanding) {
    throw Object.assign(new Error(
      'that is more than is outstanding (' + toMVR(outstanding) + ')'), { status: 409 });
  }

  await c.query('UPDATE vendor_invoice SET paid = paid + $2 WHERE id = $1',
    [inv.rows[0].id, toMVR(amount)]);

  await stock.postStockJournal(c, {
    date: p.date || new Date().toISOString().slice(0, 10),
    memo: 'Paid ' + inv.rows[0].supplier + ' — invoice ' + inv.rows[0].invoice_no,
    dr: '2000', cr: method === 'cash' ? '1000' : '1010',
    valueLaari: amount, sourceId: inv.rows[0].id,
  }, ctx);

  await c.query("SELECT chain.log('invoice_pay','vendor_invoice',$1,NULL,$2)",
    [inv.rows[0].id, JSON.stringify({ amount: toMVR(amount), method })]);

  return {
    invoiceId: inv.rows[0].id, paid: toMVR(amount),
    outstanding: toMVR(outstanding - amount),
    settled: outstanding - amount === 0,
  };
}

module.exports = {
  suppliers, createSupplier, updateSupplier, supplier,
  receiveDelivery, priceDelivery, deliveries, delivery, ageing, payInvoice,
};
