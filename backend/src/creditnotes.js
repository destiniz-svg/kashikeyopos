'use strict';
/* Credit notes — 08-BUILD-STAGES §21: "numbered documents against a sale, with
 * approval." DEPLOYMENT.md, under what this system refuses: "A closed sale is
 * corrected with a credit note, never erased."
 *
 * That was a promise with nothing behind it. The table and the `CN` document
 * series have been in the schema since the first migration and nothing wrote
 * either, so the only ways to correct a mistake were to void the sale — which
 * erases exactly what an inspection came to see — or to leave it wrong.
 *
 * THE FIGURES ARE A PRO-RATA SHARE OF THE SALE'S OWN, not a recalculation.
 * Crediting two lines out of nine credits the same fraction of the discount,
 * the service charge and the tax that those lines carried when they were sold.
 * Recomputing the tax at today's rate would restate a filed month the first
 * time a rate changed; recomputing it at the sale's rate would be a second
 * arithmetic beside the one that produced the receipt. The sale is the
 * authority on what the sale was, and a full credit therefore returns exactly
 * the total that was taken — to the laari, with no rounding to argue about.
 *
 * NOTHING POSTS UNTIL SOMEBODY WITH THE RANK SAYS YES. A raised note is a real
 * row in a real state — a cashier standing in front of a guest with a manager
 * on the way — and it moves no money, returns no stock and holds no document
 * number. The number is issued at approval, because `chain.next_doc_no` is
 * gapless and a declined note must not leave a hole nobody can explain years
 * later.
 *
 * THE GOODS ARE NOT ASSUMED TO COME BACK. A returned bottle of wine goes on the
 * shelf; a steak sent back goes in the bin. Restocking is a decision made line
 * by line and defaults to false, because inventing stock that is in a bin is
 * worse than a manager ticking a box.
 */

const money2 = require('../../packages/money/money');
const { post: postJournal } = require('./journal');
const { ACCOUNT_FOR } = require('./sale');
const costing = require('./costing');
const stock = require('./stock');

const money = (n) => Math.round(Number(n) * 100) / 100;
const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/* Where a refund goes back to. The same map a sale collects by — one list, so a
   method can never be refundable at the door and homeless in the ledger. */
const REFUND_METHODS = Object.keys(ACCOUNT_FOR);

/* ── what may still be credited ──────────────────────────────────────────── */

/**
 * The sale, its lines, and how much of each has already been credited.
 *
 * The remaining quantity is the only figure that matters on this screen: a line
 * sold three times and credited twice has one left, and offering three is
 * offering to refund a dish that was eaten.
 */
async function forSale(c, saleId) {
  const s = await c.query(
    'SELECT s.*, st.name AS closed_by_name FROM sale s'
    + ' LEFT JOIN chain.staff st ON st.id = s.closed_by WHERE s.id = $1', [saleId]);
  if (!s.rows.length) throw Object.assign(new Error('no such sale'), { status: 404 });
  const sale = s.rows[0];

  const lines = await c.query(
    'SELECT l.id, l.item_id, l.name, l.qty, l.unit_price, l.line_total, l.line_cost,'
    + ' coalesce((SELECT sum(cl.qty) FROM credit_note_line cl'
    + '   JOIN credit_note cn ON cn.id = cl.credit_note_id'
    + '   WHERE cl.sale_line_id = l.id AND cn.declined_at IS NULL), 0) AS credited'
    + ' FROM sale_line l WHERE l.sale_id = $1 ORDER BY l.id', [saleId]);

  const payments = await c.query(
    'SELECT method, sum(amount) AS amount FROM payment WHERE sale_id = $1'
    + ' GROUP BY method', [saleId]);

  const notes = await c.query(
    'SELECT cn.*, r.name AS raised_by_name, a.name AS approved_by_name,'
    + ' d.name AS declined_by_name'
    + ' FROM credit_note cn'
    + ' LEFT JOIN chain.staff r ON r.id = cn.raised_by'
    + ' LEFT JOIN chain.staff a ON a.id = cn.approved_by'
    + ' LEFT JOIN chain.staff d ON d.id = cn.declined_by'
    + ' WHERE cn.sale_id = $1 ORDER BY cn.at DESC', [saleId]);

  return {
    sale: {
      id: sale.id, receiptNo: sale.receipt_no, at: sale.at,
      businessDate: day(sale.business_date),
      gross: money(sale.gross), discount: money(sale.discount),
      service: money(sale.service), tax: money(sale.tax), total: money(sale.total),
      taxCode: sale.tax_code, taxRate: Number(sale.tax_rate),
      closedBy: sale.closed_by_name || null,
      voided: sale.voided_at !== null,
    },
    lines: lines.rows.map((l) => ({
      id: l.id, itemId: l.item_id, name: l.name,
      qty: Number(l.qty), unitPrice: money(l.unit_price),
      /* NET of tax, like the sale line itself. */
      amount: money(l.line_total),
      credited: Number(l.credited),
      remaining: Number(l.qty) - Number(l.credited),
    })),
    /* What was tendered, so the screen can offer to refund by the same route.
       Refunding cash a guest paid by card is how a drawer comes up short. */
    tenders: payments.rows.map((p) => ({ method: p.method, amount: money(p.amount) })),
    notes: notes.rows.map(shape),
  };
}

function shape(n) {
  return {
    id: n.id, no: n.cn_no || null, at: n.at,
    businessDate: n.business_date ? day(n.business_date) : null,
    amount: money(n.amount), goods: money(n.goods),
    service: money(n.service), tax: money(n.tax),
    reason: n.reason, refundMethod: n.refund_method || null,
    raisedBy: n.raised_by_name || null,
    approvedBy: n.approved_by_name || null, approvedAt: n.approved_at,
    declinedBy: n.declined_by_name || null, declinedAt: n.declined_at,
    declineReason: n.decline_reason || null,
    journalId: n.journal_id,
    state: n.approved_at ? 'approved' : n.declined_at ? 'declined' : 'waiting for approval',
  };
}

/* ── raising one ─────────────────────────────────────────────────────────── */

/**
 * Raise a credit note. Posts nothing: this is a request.
 *
 * p = { saleId, reason, refundMethod, lines: [{ saleLineId, qty, restock? }] }
 */
async function raise(c, p, ctx) {
  const reason = String(p.reason || '').trim().slice(0, 200);
  if (reason.length < 4) {
    /* "Refund" is not a reason. What a manager approves is the sentence, and
       what an inspection reads a year later is the same sentence. */
    throw Object.assign(new Error('say why — it is what the manager approves and'
      + ' what anybody reading this in a year has to go on'), { status: 400 });
  }
  const method = String(p.refundMethod || '');
  if (!REFUND_METHODS.includes(method)) {
    throw Object.assign(new Error('refund by one of: ' + REFUND_METHODS.join(', ')),
      { status: 400 });
  }

  const found = await forSale(c, p.saleId);
  if (found.sale.voided) {
    throw Object.assign(new Error('that sale was voided — there is nothing to credit'),
      { status: 409 });
  }
  const wanted = Array.isArray(p.lines) ? p.lines : [];
  if (!wanted.length) {
    throw Object.assign(new Error('which lines are being credited?'), { status: 400 });
  }

  const byId = new Map(found.lines.map((l) => [l.id, l]));
  const rows = [];
  let goodsNet = 0;
  for (const w of wanted) {
    const line = byId.get(String(w.saleLineId));
    if (!line) {
      throw Object.assign(new Error('that line is not on this sale'), { status: 409 });
    }
    const qty = Number(w.qty);
    if (!(qty > 0)) {
      throw Object.assign(new Error('a credited quantity must be positive'), { status: 400 });
    }
    if (qty > line.remaining + 1e-9) {
      /* The check that stops a sale being refunded twice. A line sold three
         times and already credited twice has one left. */
      throw Object.assign(new Error(line.name + ': ' + line.remaining
        + ' left to credit, not ' + qty), { status: 409 });
    }
    /* The line's own money, pro rata by quantity — never a fresh multiplication
       of the unit price, which drifts by a laari against the figure the receipt
       carries. */
    const amount = Math.round(toLaari(line.amount) * (qty / line.qty));
    goodsNet += amount;
    rows.push({ line, qty, amount, restock: w.restock === true });
  }

  /* THE SHARE, from packages/money — the same function the screen calls to show
     the refund before anybody presses anything. Written twice, the two differed
     by a laari on the very first bill, which is a guest being told one number
     and handed another. */
  const share = money2.creditShare(goodsNet, {
    gross: toLaari(found.sale.gross), discount: toLaari(found.sale.discount),
    service: toLaari(found.sale.service), tax: toLaari(found.sale.tax),
  });
  const { discount, service, tax, total } = share;

  const cn = await c.query(
    'INSERT INTO credit_note (sale_id, business_date, amount, goods, service, tax,'
    + ' reason, refund_method, raised_by)'
    + ' VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [p.saleId, found.sale.businessDate, toMVR(total), toMVR(share.goodsAfterDiscount),
      toMVR(service), toMVR(tax), reason, method, ctx.actor]);

  for (const r of rows) {
    await c.query(
      'INSERT INTO credit_note_line (credit_note_id, sale_line_id, item_id, name,'
      + ' qty, amount, restock) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [cn.rows[0].id, r.line.id, r.line.itemId, r.line.name, r.qty,
        toMVR(r.amount), r.restock]);
  }

  await c.query("SELECT chain.log('credit_note_raise','credit_note',$1,NULL,$2)",
    [cn.rows[0].id, JSON.stringify({
      sale: found.sale.receiptNo, amount: toMVR(total), reason, lines: rows.length,
    })]);

  return {
    ...(await one(c, cn.rows[0].id)),
    message: 'Raised for ' + toMVR(total) + '. Nothing has moved yet — a manager'
      + ' has to approve it.',
  };
}

async function one(c, id) {
  const q = await c.query(
    'SELECT cn.*, r.name AS raised_by_name, a.name AS approved_by_name,'
    + ' d.name AS declined_by_name, s.receipt_no'
    + ' FROM credit_note cn'
    + ' LEFT JOIN chain.staff r ON r.id = cn.raised_by'
    + ' LEFT JOIN chain.staff a ON a.id = cn.approved_by'
    + ' LEFT JOIN chain.staff d ON d.id = cn.declined_by'
    + ' LEFT JOIN sale s ON s.id = cn.sale_id'
    + ' WHERE cn.id = $1', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such credit note'), { status: 404 });
  const lines = await c.query(
    'SELECT item_id, name, qty, amount, restock FROM credit_note_line'
    + ' WHERE credit_note_id = $1 ORDER BY id', [id]);
  return {
    ...shape(q.rows[0]),
    receiptNo: q.rows[0].receipt_no || null,
    lines: lines.rows.map((l) => ({
      itemId: l.item_id, name: l.name, qty: Number(l.qty),
      amount: money(l.amount), restock: l.restock,
    })),
  };
}

/* ── approving one ───────────────────────────────────────────────────────── */

/**
 * Approve, number, post, and put back whatever came back.
 *
 * The journal is the sale's own, in reverse and in proportion:
 *
 *   Dr 4000  goods credited, net of tax
 *   Cr 4090  the share of the discount that went with them
 *   Dr 2100  the share of the tax
 *   Dr 2110  the share of the service charge
 *   Cr <the tender>  what is actually being given back
 *
 * plus, for any line whose goods came back, Dr 1100 / Cr 5000 at the cost the
 * SALE captured — not today's cost, or last month's margin would move every
 * time a supplier changed a price.
 */
async function approve(c, id, p, ctx) {
  const q = await c.query('SELECT * FROM credit_note WHERE id = $1 FOR UPDATE', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such credit note'), { status: 404 });
  const cn = q.rows[0];
  if (cn.approved_at) {
    return { ...(await one(c, id)), already: true };
  }
  if (cn.declined_at) {
    throw Object.assign(new Error('that one was declined'), { status: 409 });
  }
  if (cn.raised_by === ctx.actor) {
    /* The point of an approval is that a second person looked. A manager who
       needs to credit a bill raises it and asks a colleague, or uses their own
       rank on somebody else's note — which is what this rule is for. */
    throw Object.assign(new Error('a credit note is approved by somebody other than'
      + ' the person who raised it'), { status: 409 });
  }

  const lines = await c.query(
    'SELECT cl.*, sl.unit_cost FROM credit_note_line cl'
    + ' JOIN sale_line sl ON sl.id = cl.sale_line_id'
    + ' WHERE cl.credit_note_id = $1', [id]);

  /* `goods` on the row is already NET of the discount share, so the two legs
     are derived back out here: the ledger wants the credit to 4000 at the
     lines' own value and the discount reversal separately, exactly as the sale
     posted them. */
  const total = toLaari(cn.amount);
  const service = toLaari(cn.service);
  const tax = toLaari(cn.tax);
  const goodsAfterDiscount = toLaari(cn.goods);
  const rawGoods = await c.query(
    'SELECT coalesce(sum(amount),0) AS goods FROM credit_note_line'
    + ' WHERE credit_note_id = $1', [id]);
  const goods = toLaari(rawGoods.rows[0].goods);
  const discount = goods - goodsAfterDiscount;

  const account = ACCOUNT_FOR[cn.refund_method];
  if (!account) {
    throw Object.assign(new Error('no account for a ' + cn.refund_method + ' refund'),
      { status: 409 });
  }

  const jlines = [{ account: '4000', dr: goods, cr: 0 }];
  if (discount) jlines.push({ account: '4090', dr: 0, cr: discount });
  if (tax) jlines.push({ account: '2100', dr: tax, cr: 0 });
  if (service) jlines.push({ account: '2110', dr: service, cr: 0 });
  jlines.push({ account: account, dr: 0, cr: total });

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['CN']);
  /* WHAT CAME BACK GOES BACK. The same recipe walk the sale used to take the
     ingredients out — `costing.explode` — so the two can never disagree about
     what a dish is made of.

     Valued at TODAY'S average cost, not the cost the sale captured. The stock
     ledger's job is to say what is on the shelf and what it is worth, and a
     bottle returned to the shelf is worth what a bottle is worth now. Where a
     supplier's price moved in between, the difference between this and the
     original cost of sale is a real revaluation and lands in 5000 where it can
     be seen, rather than being papered over to make the reversal symmetrical. */
  const back = new Map();
  for (const l of lines.rows) {
    if (!l.restock) continue;
    await costing.explode(c, l.item_id, Number(l.qty), back);
  }
  let restockValue = 0;
  for (const [ingredientId, qty] of back) {
    const ing = await c.query(
      'SELECT avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [ingredientId]);
    if (!ing.rows.length) continue;
    const unitCostLaari = Number(ing.rows[0].avg_cost) * 100;
    await stock.move(c, {
      ingredientId, qty, unitCostLaari, reason: 'return', saleId: cn.sale_id,
    }, ctx);
    restockValue += Math.round(qty * unitCostLaari);
  }
  if (restockValue) {
    jlines.push({ account: '1100', dr: restockValue, cr: 0 });
    jlines.push({ account: '5000', dr: 0, cr: restockValue });
  }

  const jv = await postJournal(c, {
    date: day(cn.business_date || new Date()),
    memo: 'Credit note ' + no.rows[0].no,
    source: 'credit_note', sourceId: cn.id, lines: jlines,
  }, ctx);

  await c.query(
    'UPDATE credit_note SET cn_no = $2, approved_by = $3, approved_at = now(),'
    + ' journal_id = $4 WHERE id = $1', [id, no.rows[0].no, ctx.actor, jv.id]);

  await c.query("SELECT chain.log('credit_note_approve','credit_note',$1,NULL,$2)",
    [id, JSON.stringify({ no: no.rows[0].no, amount: toMVR(total), jv: jv.no })]);

  return {
    ...(await one(c, id)),
    restockValue: money(restockValue / 100),
    message: 'Credit note ' + no.rows[0].no + ' for ' + toMVR(total) + ', refunded by '
      + cn.refund_method + '.'
      + (restockValue ? ' ' + toMVR(restockValue) + ' of ingredients went back on'
        + ' the shelf.' : ''),
  };
}

/** Turn one down. It stays on the record, and takes no document number with it. */
async function decline(c, id, p, ctx) {
  const why = String(p.reason || '').trim().slice(0, 200);
  if (why.length < 4) {
    throw Object.assign(new Error('say why it is being turned down'), { status: 400 });
  }
  const q = await c.query(
    'UPDATE credit_note SET declined_at = now(), declined_by = $2, decline_reason = $3'
    + ' WHERE id = $1 AND approved_at IS NULL AND declined_at IS NULL RETURNING id',
    [id, ctx.actor, why]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only a note still waiting can be turned down'),
      { status: 409 });
  }
  await c.query("SELECT chain.log('credit_note_decline','credit_note',$1,NULL,$2)",
    [id, JSON.stringify({ reason: why })]);
  return { ...(await one(c, id)), message: 'Turned down. Nothing was refunded.' };
}

/* ── the list ────────────────────────────────────────────────────────────── */

async function list(c, q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? q.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? q.to : null;
  const r = await c.query(
    'SELECT cn.*, r.name AS raised_by_name, a.name AS approved_by_name,'
    + ' d.name AS declined_by_name, s.receipt_no'
    + ' FROM credit_note cn'
    + ' LEFT JOIN chain.staff r ON r.id = cn.raised_by'
    + ' LEFT JOIN chain.staff a ON a.id = cn.approved_by'
    + ' LEFT JOIN chain.staff d ON d.id = cn.declined_by'
    + ' LEFT JOIN sale s ON s.id = cn.sale_id'
    + ' WHERE ($1::date IS NULL OR cn.business_date >= $1::date)'
    + '   AND ($2::date IS NULL OR cn.business_date <= $2::date)'
    + ' ORDER BY cn.at DESC LIMIT 200', [from, to]);

  const notes = r.rows.map((n) => ({ ...shape(n), receiptNo: n.receipt_no || null }));
  return {
    notes,
    totals: {
      /* The two figures a manager acts on: what is waiting for them, and what
         has actually been given back this period. */
      waiting: notes.filter((n) => n.state === 'waiting for approval').length,
      waitingValue: money(notes.filter((n) => n.state === 'waiting for approval')
        .reduce((a, n) => a + n.amount, 0)),
      credited: money(notes.filter((n) => n.state === 'approved')
        .reduce((a, n) => a + n.amount, 0)),
    },
  };
}

module.exports = { forSale, raise, approve, decline, list, one, REFUND_METHODS };
