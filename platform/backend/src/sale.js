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
const costing = require('./costing');
const customers = require('./customers');
const loyalty = require('./loyalty');

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

/* THE TENDERS THE LEDGER KNOWS. One list, shared by the validation below and
   by ACCOUNT_FOR in the journal, so a method can never be accepted at the door
   and then have nowhere to go once it is inside.

   `account` is the house tender: no money arrives, a customer's debt goes up.
   `points` spends loyalty liability. Both are settlements without cash, which
   is exactly why the drawer must not be their fallback. */
const TENDERS = ['cash', 'card', 'wallet', 'bank', 'points', 'account'];

/* Costing lives in ./costing.js — the SAME functions Recipes & Costing calls
   to show a manager a plate cost while they edit. Written twice, the screen
   would say 31% food cost while the ledger booked 38%, with nothing to point
   at. */

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

  /* EVERY TENDER MUST BE ONE THE LEDGER KNOWS. The account each method debits
     used to fall back to 1000 for anything unrecognised, so a typo, an old
     client sending 'Cash', or a method added on the front end before the back
     end knew about it all quietly landed in the cash drawer. Nothing said so:
     the sale balanced, the P&L was right, and the only symptom was the drawer
     coming up short at close by exactly the mis-tendered amount — with the
     variance posted to 6920 as if somebody had taken the money.

     A guess about where money went is worse than a refusal. */
  for (const pay of (p.payments || [])) {
    if (!TENDERS.includes(pay.method)) {
      throw Object.assign(new Error(
        'unknown tender "' + String(pay.method).slice(0, 20) + '" — one of: '
        + TENDERS.join(', ')), { status: 400 });
    }
  }

  /* Payments must cover the bill. A short payment is a partly-paid ticket, not
     a closed sale, and letting one through is how a drawer comes up light with
     a receipt that says it should not have. */
  const paid = (p.payments || []).reduce((a, x) => a + toLaari(x.amount || 0), 0);
  if (paid !== b.total) {
    throw Object.assign(new Error(
      'payments (' + toMVR(paid) + ') do not equal the bill (' + toMVR(b.total) + ')'),
      { status: 409 });
  }

  /* A HOUSE CHARGE IS CHECKED BEFORE THE SALE EXISTS. Refusing afterwards would
     mean a printed receipt for a debt the customer was never approved for, and
     an accounts-receivable balance nobody agreed to. */
  const onAccount = (p.payments || [])
    .filter((x) => x.method === 'account')
    .reduce((a, x) => a + toLaari(x.amount || 0), 0);
  if (onAccount > 0) {
    if (!p.memberId) {
      throw Object.assign(new Error(
        'a house charge needs a customer — whose account is it going on?'),
      { status: 409 });
    }
    await customers.checkCredit(c, p.memberId, onAccount);
  }

  /* Points are the other settlement where nothing arrives, and they are checked
     in the same place and for the same reason: a member who turns out not to
     have the points, discovered after the sale, is a bill that was never
     settled and a receipt that says it was. */
  const inPoints = (p.payments || [])
    .filter((x) => x.method === 'points')
    .reduce((a, x) => a + toLaari(x.amount || 0), 0);
  if (inPoints > 0) {
    if (!p.memberId) {
      throw Object.assign(new Error(
        'paying with points needs a member — whose points are they?'), { status: 409 });
    }
    await loyalty.checkPoints(c, p.memberId, inPoints);
  }

  // Cost of what was sold, captured NOW: margin must never be recomputed from a
  // later ingredient price, or last month's profit changes when a supplier does.
  const costs = new Map();
  for (const id of new Set(ids)) costs.set(id, (await costing.itemCost(c, id)).cost);
  let cogs = 0;
  for (const l of billLines) {
    l.unitCost = costs.get(l.itemId) || 0;
    l.lineCost = Math.round(l.unitCost * l.qty);
    cogs += l.lineCost;
  }

  /* The till's own figure, when it sent one. Stored on the sale rather than
     only logged, so "which terminal disagrees, and by how much, over what
     period" is a query and not an archaeology exercise through the audit trail. */
  const clientTotal = p.clientTotal == null ? null : toLaari(p.clientTotal);

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['SALE']);
  const sale = await c.query(
    'INSERT INTO sale (receipt_no, ticket_id, business_date, channel, covers,'
    + ' gross, discount, discount_reason, service, tax_code, tax_rate, tax,'
    + ' rounding, total, cogs, member_id, server_name, closed_by, device_id, client_total)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)'
    + ' RETURNING id, receipt_no',
    [no.rows[0].no, p.ticketId || null, p.businessDate, p.channel || 'dine_in',
      p.covers || 1, toMVR(b.gross), toMVR(b.discount), p.discountReason || null,
      toMVR(b.service), tax.code, tax.rate, toMVR(b.tax), toMVR(b.rounding),
      toMVR(b.total), toMVR(cogs), p.memberId || null, p.server || null,
      ctx.actor, ctx.deviceId, clientTotal == null ? null : toMVR(clientTotal)]);
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

  await postSaleJournal(c, saleId, sale.rows[0].receipt_no, b, cogs, p, ctx);

  /* The house ledger entry, written from the SAME figure the journal debited to
     1030. The two are checked against each other by a test rather than trusted
     to stay in step: a receivable that agrees with itself but not with the
     ledger is the kind of thing nobody notices until a customer disputes a
     statement. */
  if (onAccount > 0) {
    await customers.charge(c, {
      onDate: p.businessDate, memberId: p.memberId, amount: onAccount,
      saleId, docNo: sale.rows[0].receipt_no,
    }, ctx);
  }

  /* Points spent, then points earned — in that order, so a member cannot earn
     on this bill and immediately spend it on the same one. */
  if (inPoints > 0) {
    await loyalty.spend(c, { memberId: p.memberId, amount: inPoints, saleId }, ctx);
  }
  if (p.memberId) {
    /* Earned on the GOODS, net of tax and service. Earning on the tax would
       have the business paying a member a share of the government's money, and
       earning on the service charge would pay them a share of the staff's. */
    await loyalty.earn(c, {
      memberId: p.memberId, goodsLaari: b.gross - b.discount, saleId,
      businessDate: p.businessDate, docNo: sale.rows[0].receipt_no,
    }, ctx);
  }

  if (p.ticketId) {
    // A closed ticket is never reopened by a late replay: the guard is in the
    // WHERE clause, not in a read-then-write the next arrival can race.
    await c.query(
      "UPDATE ticket SET status = 'closed', closed_at = now(), closed_by = $2"
      + " WHERE id = $1 AND status <> 'closed'", [p.ticketId, ctx.actor]);
  }

  await c.query("SELECT chain.log('sale','sale',$1,NULL,$2)",
    [saleId, JSON.stringify({ no: sale.rows[0].receipt_no, total: toMVR(b.total) })]);

  /* A disagreement is recorded rather than rejected — the guest has already
     paid and the cashier cannot un-take the money — but recorded loudly,
     because a till computing a different total from the server is a bug
     somebody has to find. */
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

/**
 * Explode the recipe and move stock, signed, with the cost it moved at.
 *
 * Goes through stock.move() rather than writing stock_move itself. It used to
 * have its own INSERT, and the two writers had drifted: this one stored a
 * POSITIVE value against a NEGATIVE quantity, while every other path stored the
 * value signed to match. `stock_move.value` therefore meant different things
 * depending on which code had written the row, so any sum over the column was
 * meaningless — which is exactly what the Stock Ledger's in/out totals do, and
 * how this was found. One table, one writer.
 */
async function moveStock(c, saleId, lines, ctx) {
  const stock = require('./stock');
  const need = new Map();   // ingredientId -> qty
  for (const l of lines) await costing.explode(c, l.itemId, Number(l.qty), need);
  for (const [ingredientId, qty] of need) {
    const ing = await c.query(
      'SELECT avg_cost FROM ingredient WHERE id = $1 FOR UPDATE', [ingredientId]);
    if (!ing.rows.length) continue;
    /* NOT rounded to whole laari. A cost per gram is a fraction of a laari, and
       rounding it here would inflate every gram-denominated dish — the same
       trap costing.js carries a comment about. */
    await stock.move(c, {
      ingredientId, qty: -qty, unitCostLaari: Number(ing.rows[0].avg_cost) * 100,
      reason: 'sale', saleId,
    }, ctx);
  }
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
async function postSaleJournal(c, saleId, receiptNo, b, cogs, p, ctx) {
  const lines = [];
  const dr = (account, laari) => { if (laari) lines.push({ account, dr: laari, cr: 0 }); };
  const cr = (account, laari) => { if (laari) lines.push({ account, dr: 0, cr: laari }); };

  /* Split the tender across accounts by method, so the ledger says how the
     money arrived and the drawer and the acquirer can each be reconciled
     against their own account rather than against one lump.

     `account` is the house tender and it is the odd one out: NO MONEY ARRIVED.
     It debits 1030 Customer receivable — a promise to pay — and the drawer must
     not think a thing of it, because the drawer's expected cash is derived from
     account 1000. */
  const ACCOUNT_FOR = {
    cash: '1000', card: '1020', wallet: '1020', bank: '1010',
    points: '2200', account: '1030',
  };

  /* A tip arrives WITH the money it was added to, so it debits the same
     account as its own payment. This used to debit 1000 for every tip
     regardless of method, which put a card tip in the cash drawer: the books
     then showed cash that was never there, and the first drawer count of the
     evening came up short by exactly the evening's card tips. The credit is
     2120 either way — a tip is the team's money passing through, never the
     restaurant's revenue. */
  let tips = 0;
  for (const pay of (p.payments || [])) {
    const account = ACCOUNT_FOR[pay.method];
    const tip = toLaari(pay.tip || 0);
    tips += tip;
    dr(account, toLaari(pay.amount || 0) + tip);
  }
  if (tips) cr('2120', tips);

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
    /* The memo is what somebody reads in the ledger, so it names the RECEIPT —
       the number printed on the document the guest was handed and the one the
       drawer count and any query will quote. `source_id` still carries the
       sale's uuid, which is what a join needs; a uuid in the memo is a
       reference nobody in the building can use. */
    [no.rows[0].no, p.businessDate, 'Sale ' + receiptNo, saleId, ctx.actor]);

  for (const l of lines) {
    await c.query(
      'INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,$3,$4)',
      [h.rows[0].id, l.account, toMVR(l.dr), toMVR(l.cr)]);
  }
  return h.rows[0].id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

module.exports = { settle, taxAsAt, toLaari, toMVR, TENDERS };
