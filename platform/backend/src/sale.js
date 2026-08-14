'use strict';
/* Settling a sale — the one place money becomes a permanent record.
 *
 * WHY THIS FILE REPLACED THE INLINE VERSION. The handed-over `apply()` took
 * `gross`, `tax`, `total`, the COGS figure and the ENTIRE double-entry journal
 * straight off the request body and inserted them. Two consequences:
 *
 *   · Anything holding a till session could name its own tax. Post a sale with
 *     tax: 0 and the GST return is short, with the sale row itself as the
 *     evidence that it was right. The `sale_adds_up` constraint does not catch
 *     it — a self-consistent lie satisfies it perfectly.
 *   · The ledger was whatever the client said the ledger was. The deferred
 *     balance trigger only asks that debits equal credits, so a journal
 *     crediting the wrong account, or crediting income and debiting nothing but
 *     cash, posts happily and balances.
 *
 * A till is a device in a room full of members of the public, running code we
 * ship but do not control, and offline for hours at a time. It is the right
 * place to CAPTURE a sale and the wrong place to be the authority on what the
 * sale was worth.
 *
 * So the client sends what only it knows — which items, how many, what
 * discount, which tender, and the opId that makes the whole thing replayable —
 * and the server derives everything a tax authority or an accountant would ask
 * about: prices from `item`, the rate from `chain.tax_version` as at the
 * business date, service charge from `chain.outlet`, cost from the recipe, and
 * the journal from the sale it just computed.
 *
 * What the client sends IS still checked, and a disagreement is recorded rather
 * than discarded: `client_total` is stored on the sale so a till that has
 * drifted can be found, instead of the difference silently becoming the
 * server's problem at the end of the month.
 */

const money = require('../../packages/money/money');

/* MVR ↔ laari. The database columns are numeric(12,2) in MVR; every
   calculation in between is integer laari. Conversion happens here and at no
   other point in the request. */
const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);

/** The tax version in force for a business date. Never "the current rate": a
 *  sale replayed a week after a rate change must be taxed as it was on the day
 *  it was rung up, or a filed return gets restated by a reconnecting till. */
async function taxAsAt(c, outletId, businessDate) {
  const q = await c.query(
    'SELECT code, rate FROM chain.tax_version'
    + ' WHERE outlet_id = $1 AND effective_from <= $2::date'
    + '   AND (effective_to IS NULL OR effective_to >= $2::date)'
    + ' ORDER BY effective_from DESC LIMIT 1', [outletId, businessDate]);
  if (!q.rows.length) {
    throw Object.assign(
      new Error('no tax version covers ' + businessDate + ' for this outlet'),
      { status: 409 });
  }
  return { code: q.rows[0].code, rate: Number(q.rows[0].rate) };
}

/** Recipe cost of one unit of an item, in laari, walking sub-recipes.
 *  Depth-bounded and cycle-guarded: a recipe that refers to itself is a data
 *  error, and it must cost a sale a wrong number rather than the process. */
async function unitCost(c, itemId, seen, depth) {
  seen = seen || new Set();
  depth = depth || 0;
  if (depth > 8 || seen.has(itemId)) return 0;
  seen.add(itemId);

  const it = await c.query('SELECT yield_qty FROM item WHERE id = $1', [itemId]);
  const yieldQty = it.rows.length ? Number(it.rows[0].yield_qty) || 1 : 1;

  const lines = await c.query(
    'SELECT ingredient_id, sub_item_id, qty, waste_pct FROM recipe_line WHERE item_id = $1',
    [itemId]);

  let total = 0;
  for (const l of lines.rows) {
    // Waste is a yield loss: needing 100g at 10% waste means buying 111g, so
    // the cost divides by (1 − waste), it does not multiply by (1 + waste).
    const wastePct = Number(l.waste_pct) || 0;
    const grossQty = Number(l.qty) / (1 - Math.min(0.95, wastePct / 100));
    if (l.ingredient_id) {
      const ing = await c.query('SELECT avg_cost FROM ingredient WHERE id = $1', [l.ingredient_id]);
      const cost = ing.rows.length ? Number(ing.rows[0].avg_cost) : 0;
      total += grossQty * cost * 100;               // avg_cost is MVR per unit
    } else if (l.sub_item_id) {
      total += grossQty * await unitCost(c, l.sub_item_id, seen, depth + 1);
    }
  }
  seen.delete(itemId);
  // A recipe that yields 8 portions costs an eighth per portion. Forgetting
  // this is the classic way food cost comes out eight times too high.
  return total / (yieldQty || 1);
}

/**
 * Settle a sale. `p` is what the till captured; everything financial is derived.
 *
 * p = { ticketId?, businessDate, channel, covers, lines:[{itemId, qty}],
 *       discount?, discountReason?, fee?, payments:[{method, amount, ...}],
 *       memberId?, server?, clientTotal? }
 */
async function settle(c, p, ctx, outlet) {
  if (!p || !Array.isArray(p.lines) || !p.lines.length) {
    throw Object.assign(new Error('a sale needs at least one line'), { status: 400 });
  }
  if (!p.businessDate) {
    throw Object.assign(new Error('businessDate required'), { status: 400 });
  }

  /* Prices come from the item master, not from the payload. A till may send an
     item id and a quantity; what that item costs is not its decision. This is
     the difference between a price the guest was shown and a price the guest
     can choose. */
  const ids = p.lines.map((l) => String(l.itemId));
  const items = await c.query(
    'SELECT id, name, price, category FROM item WHERE id = ANY($1) AND active', [ids]);
  const byId = new Map(items.rows.map((r) => [r.id, r]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw Object.assign(new Error('unknown or inactive item: ' + id), { status: 409 });
    }
  }

  const tax = await taxAsAt(c, ctx.outletId, p.businessDate);
  const servicePct = Number(outlet.service_pct) || 0;

  const billLines = p.lines.map((l) => ({
    itemId: String(l.itemId),
    name: byId.get(String(l.itemId)).name,
    qty: Number(l.qty),
    unitPrice: toLaari(byId.get(String(l.itemId)).price),
  }));
  for (const l of billLines) {
    if (!(l.qty > 0)) {
      throw Object.assign(new Error('a line quantity must be positive'), { status: 400 });
    }
  }

  const b = money.priceBill({
    lines: billLines,
    discount: toLaari(p.discount || 0),
    servicePct,
    taxRate: tax.rate,
    fee: toLaari(p.fee || 0),
    // Cash rounding applies when the bill is settled in cash only.
    roundTo: (p.payments || []).some((x) => x.method === 'cash')
      ? Number(outlet.cash_round_laari || 0) : 0,
  });

  /* Payments must cover the bill. A short payment is a partly-paid ticket, not
     a closed sale, and letting one through is how a drawer comes up light with
     a receipt that says it should not have. */
  const paid = (p.payments || []).reduce((a, x) => a + toLaari(x.amount || 0), 0);
  if (paid !== b.total) {
    throw Object.assign(new Error(
      'payments (' + toMVR(paid) + ') do not equal the bill (' + toMVR(b.total) + ')'),
      { status: 409 });
  }

  // Cost of what was sold, captured NOW: margin must never be recomputed from a
  // later ingredient price, or last month's profit changes when a supplier does.
  const costs = new Map();
  for (const id of new Set(ids)) costs.set(id, await unitCost(c, id));
  let cogs = 0;
  for (const l of billLines) {
    l.unitCost = costs.get(l.itemId) || 0;
    l.lineCost = Math.round(l.unitCost * l.qty);
    cogs += l.lineCost;
  }

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['SALE']);
  const sale = await c.query(
    'INSERT INTO sale (receipt_no, ticket_id, business_date, channel, covers,'
    + ' gross, discount, discount_reason, service, tax_code, tax_rate, tax,'
    + ' rounding, total, cogs, member_id, server_name, closed_by, device_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)'
    + ' RETURNING id, receipt_no',
    [no.rows[0].no, p.ticketId || null, p.businessDate, p.channel || 'dine_in',
      p.covers || 1, toMVR(b.gross), toMVR(b.discount), p.discountReason || null,
      toMVR(b.service), tax.code, tax.rate, toMVR(b.tax), toMVR(b.rounding),
      toMVR(b.total), toMVR(cogs), p.memberId || null, p.server || null,
      ctx.actor, ctx.deviceId]);
  const saleId = sale.rows[0].id;

  for (let i = 0; i < billLines.length; i++) {
    const l = billLines[i];
    await c.query(
      'INSERT INTO sale_line (sale_id, item_id, name, qty, unit_price, line_total,'
      + ' unit_cost, line_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [saleId, l.itemId, l.name, l.qty, toMVR(l.unitPrice),
        toMVR(b.netLines[i]), (l.unitCost / 100).toFixed(4), toMVR(l.lineCost)]);
  }

  for (const pay of (p.payments || [])) {
    await c.query(
      'INSERT INTO payment (sale_id, method, amount, currency, fx_amount, fx_rate,'
      + ' tendered, change_given, tip, auth_ref, taken_by, device_id)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [saleId, pay.method, toMVR(toLaari(pay.amount)), pay.currency || 'MVR',
        pay.fxAmount || null, pay.fxRate || null, pay.tendered || null,
        pay.change || null, pay.tip || 0, pay.ref || null, ctx.actor, ctx.deviceId]);
  }

  // Stock moves at the moment of sale, exploded through the recipe.
  await moveStock(c, saleId, billLines, ctx);

  await postSaleJournal(c, saleId, b, cogs, p, ctx, tax);

  if (p.ticketId) {
    // A closed ticket is never reopened by a late replay: the guard is in the
    // WHERE clause, not in a read-then-write the next arrival can race.
    await c.query(
      "UPDATE ticket SET status = 'closed', closed_at = now(), closed_by = $2"
      + " WHERE id = $1 AND status <> 'closed'", [p.ticketId, ctx.actor]);
  }

  await c.query("SELECT chain.log('sale','sale',$1,NULL,$2)",
    [saleId, JSON.stringify({ no: sale.rows[0].receipt_no, total: toMVR(b.total) })]);

  /* The till's own figure, when it sent one and it disagrees. Recorded rather
     than rejected — the guest has already paid and the cashier cannot un-take
     the money — but recorded loudly, because a till that computes a different
     total from the server is a bug someone has to find. */
  const clientTotal = p.clientTotal == null ? null : toLaari(p.clientTotal);
  if (clientTotal != null && clientTotal !== b.total) {
    await c.query("SELECT chain.log('sale_total_mismatch','sale',$1,$2,$3)",
      [saleId, JSON.stringify({ client: toMVR(clientTotal) }),
        JSON.stringify({ server: toMVR(b.total) })]);
  }

  return {
    saleId,
    receiptNo: sale.rows[0].receipt_no,
    total: toMVR(b.total),
    tax: toMVR(b.tax),
    taxCode: tax.code,
    taxRate: tax.rate,
    cogs: toMVR(cogs),
    mismatch: clientTotal != null && clientTotal !== b.total ? toMVR(clientTotal) : undefined,
  };
}

/** Explode the recipe and move stock, signed, with the cost it moved at. */
async function moveStock(c, saleId, lines, ctx) {
  const need = new Map();   // ingredientId -> qty
  for (const l of lines) await accumulate(c, l.itemId, Number(l.qty), need, 0, new Set());
  for (const [ingredientId, qty] of need) {
    const ing = await c.query(
      'SELECT avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [ingredientId]);
    if (!ing.rows.length) continue;
    const unit = Number(ing.rows[0].avg_cost);
    await c.query(
      'INSERT INTO stock_move (ingredient_id, qty, unit_cost, value, reason, sale_id,'
      + " by_staff, device_id) VALUES ($1,$2,$3,$4,'sale',$5,$6,$7)",
      [ingredientId, -qty, unit, (qty * unit).toFixed(2), saleId, ctx.actor, ctx.deviceId]);
    // on_hand is a cache of Σ stock_move.qty; the ledger above is the truth.
    await c.query('UPDATE ingredient SET on_hand = on_hand - $2 WHERE id = $1',
      [ingredientId, qty]);
  }
}

async function accumulate(c, itemId, qty, need, depth, seen) {
  if (depth > 8 || seen.has(itemId)) return;
  seen.add(itemId);
  const it = await c.query('SELECT yield_qty FROM item WHERE id = $1', [itemId]);
  const yieldQty = it.rows.length ? Number(it.rows[0].yield_qty) || 1 : 1;
  const lines = await c.query(
    'SELECT ingredient_id, sub_item_id, qty, waste_pct FROM recipe_line WHERE item_id = $1',
    [itemId]);
  for (const l of lines.rows) {
    const wastePct = Number(l.waste_pct) || 0;
    const each = (Number(l.qty) / (1 - Math.min(0.95, wastePct / 100))) / yieldQty;
    if (l.ingredient_id) {
      need.set(l.ingredient_id, (need.get(l.ingredient_id) || 0) + each * qty);
    } else if (l.sub_item_id) {
      await accumulate(c, l.sub_item_id, each * qty, need, depth + 1, seen);
    }
  }
  seen.delete(itemId);
}

/**
 * The journal a sale posts. Derived here from the sale the server just
 * computed, never accepted from a caller.
 *
 *   Dr 1000/1020  the tender          total taken
 *   Cr 4000/4010  sales               goods, net of tax
 *   Cr 2100       GST payable         the tax
 *   Cr 2110       service charge      service, net of tax
 *   Dr 4090       discounts given     discount, net of tax  (contra-income)
 *   Dr/Cr 6910    cash rounding       the rounding adjustment
 *   Dr 5000       cost of sales       COGS
 *   Cr 1100       inventory           COGS
 *
 * Tips credit 2120 and never touch income — a tip is the team's money passing
 * through the till, not the restaurant's revenue.
 */
async function postSaleJournal(c, saleId, b, cogs, p, ctx, tax) {
  const lines = [];
  const dr = (account, laari) => { if (laari) lines.push({ account, dr: laari, cr: 0 }); };
  const cr = (account, laari) => { if (laari) lines.push({ account, dr: 0, cr: laari }); };

  /* Split the tender across accounts by method, so the ledger says how the
     money arrived and the drawer and the acquirer can each be reconciled
     against their own account rather than against one lump. */
  const ACCOUNT_FOR = { cash: '1000', card: '1020', wallet: '1020', bank: '1010', points: '2200' };
  let tips = 0;
  for (const pay of (p.payments || [])) {
    const amt = toLaari(pay.amount || 0);
    const tip = toLaari(pay.tip || 0);
    tips += tip;
    dr(ACCOUNT_FOR[pay.method] || '1000', amt);
  }
  if (tips) { dr('1000', tips); cr('2120', tips); }

  cr('4000', b.gross);
  cr('2100', b.tax);
  cr('2110', b.service);
  dr('4090', b.discount);
  if (b.rounding > 0) cr('6910', b.rounding);
  if (b.rounding < 0) dr('6910', -b.rounding);
  if (cogs) { dr('5000', cogs); cr('1100', cogs); }

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
  const h = await c.query(
    'INSERT INTO journal (jv_no, entry_date, memo, source, source_id, posted_by)'
    + " VALUES ($1,$2,$3,'sale',$4,$5) RETURNING id",
    [no.rows[0].no, p.businessDate, 'Sale ' + saleId, saleId, ctx.actor]);

  for (const l of lines) {
    await c.query(
      'INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,$3,$4)',
      [h.rows[0].id, l.account, toMVR(l.dr), toMVR(l.cr)]);
  }
  return h.rows[0].id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

module.exports = { settle, taxAsAt, unitCost, toLaari, toMVR };
