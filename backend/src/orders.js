'use strict';
/* Orders & Tickets — 02-POS-SPEC.md §2 (`orders`):
 *
 *   "Every ticket today, open and closed, with its receipt, tender, server and
 *    audit trail."
 *
 * This is the module that makes the governing principle testable. "No screen is
 * a dead end. A financial or stock consequence must be visible and reachable
 * from where it was caused" — so a receipt here is not a picture of a receipt.
 * It carries the lines with the cost they moved at, the tender that closed it,
 * the tax version it was rung up under, the journal it posted, the stock it
 * consumed, and every attributable act between the round being fired and the
 * money being taken.
 *
 * It is READ-ONLY, on purpose. A closed sale is a permanent record: correcting
 * one is a void or a credit note, which posts a reversing journal and returns
 * stock, and that is its own operation with its own rank and its own audit
 * entry — not an edit made from a history screen. Until that operation exists
 * this module will not offer a half of it.
 *
 * TILL RANK, not manager. A cashier has to be able to reprint the receipt they
 * just handed over and answer "what did I ring up for table 6". Cost and margin
 * are the one thing held back below manager rank: `line_cost` on a receipt is
 * what the kitchen spends, and it is not a cashier's to read — see redact().
 */

const num = (x) => (x === null || x === undefined ? null : Number(x));

/* ── the day ───────────────────────────────────────────────────────────────
 *
 * Two lists, because a trading day has two kinds of ticket and conflating them
 * is how a floor loses one. `open` is what is still on the floor; `closed` is
 * what has been paid for.
 *
 * OPEN TICKETS ARE NOT DATE-FILTERED. A ticket opened at 23:40 and still open
 * at 00:20 belongs to the floor, not to yesterday's page, and a table that
 * silently drops off the list when the date rolls is a table nobody settles.
 * Closed sales are filtered by `business_date`, which is the figure the
 * accounts and the GST return use.
 */
async function day(c, p) {
  const date = p.date;
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  const offset = Math.max(Number(p.offset) || 0, 0);

  const open = await c.query(
    "SELECT t.id, t.table_no, t.split, t.covers, t.channel, t.status, t.opened_at,"
    + ' t.server_name, st.name AS opened_by_name,'
    + ' count(l.id)::int AS lines,'
    + ' count(l.id) FILTER (WHERE l.sent_at IS NOT NULL)::int AS sent,'
    + ' coalesce(sum(l.qty * l.unit_price), 0) AS value'
    + ' FROM ticket t'
    + ' LEFT JOIN ticket_line l ON l.ticket_id = t.id AND l.void_at IS NULL'
    + ' LEFT JOIN chain.staff st ON st.id = t.opened_by'
    + " WHERE t.status IN ('open','held')"
    + ' GROUP BY t.id, st.name ORDER BY t.opened_at');

  /* The page of closed sales, and — separately — the day's totals over ALL of
     them. A ribbon that added up only the rows on screen would say something
     different on page two, which is the kind of number people stop trusting. */
  const closed = await c.query(
    'SELECT s.id, s.receipt_no, s.at, s.business_date, s.channel, s.covers,'
    + ' s.gross, s.discount, s.service, s.tax, s.tax_code, s.rounding, s.total,'
    + ' s.voided_at, s.client_total, s.server_name, t.table_no,'
    + ' st.name AS closed_by_name,'
    + " string_agg(DISTINCT pay.method, ',' ORDER BY pay.method) AS methods"
    + ' FROM sale s'
    + ' LEFT JOIN ticket t ON t.id = s.ticket_id'
    + ' LEFT JOIN chain.staff st ON st.id = s.closed_by'
    + ' LEFT JOIN payment pay ON pay.sale_id = s.id'
    + ' WHERE s.business_date = $1::date'
    + ' GROUP BY s.id, t.table_no, st.name'
    + ' ORDER BY s.at DESC LIMIT $2 OFFSET $3', [date, limit, offset]);

  const totals = await c.query(
    'SELECT count(*)::int AS tickets, coalesce(sum(covers),0)::int AS covers,'
    + ' coalesce(sum(gross),0) AS gross, coalesce(sum(discount),0) AS discount,'
    + ' coalesce(sum(service),0) AS service, coalesce(sum(tax),0) AS tax,'
    + ' coalesce(sum(rounding),0) AS rounding, coalesce(sum(total),0) AS total,'
    + ' coalesce(sum(cogs),0) AS cogs,'
    + ' count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided,'
    /* A till whose own total disagreed with the server's. Surfaced on the day
       ribbon rather than buried in the audit trail, because the point of
       storing client_total was that somebody would look at it. */
    + ' count(*) FILTER (WHERE client_total IS NOT NULL'
    + '   AND round(client_total,2) <> round(total,2))::int AS mismatched'
    + ' FROM sale WHERE business_date = $1::date', [date]);

  const tender = await c.query(
    'SELECT pay.method, count(*)::int AS n, coalesce(sum(pay.amount),0) AS amount,'
    + ' coalesce(sum(pay.tip),0) AS tip'
    + ' FROM payment pay JOIN sale s ON s.id = pay.sale_id'
    + ' WHERE s.business_date = $1::date GROUP BY pay.method ORDER BY pay.method',
    [date]);

  const t = totals.rows[0];
  return {
    date,
    open: open.rows.map((r) => ({
      ticketId: r.id, table: r.table_no, split: r.split, covers: r.covers,
      channel: r.channel, status: r.status, openedAt: r.opened_at,
      server: r.server_name || r.opened_by_name || null,
      lines: r.lines, sent: r.sent, value: num(r.value),
    })),
    closed: closed.rows.map((r) => ({
      saleId: r.id, receiptNo: r.receipt_no, at: r.at, table: r.table_no,
      channel: r.channel, covers: r.covers,
      gross: num(r.gross), discount: num(r.discount), service: num(r.service),
      tax: num(r.tax), taxCode: r.tax_code, rounding: num(r.rounding),
      total: num(r.total),
      methods: r.methods ? r.methods.split(',') : [],
      server: r.server_name || r.closed_by_name || null,
      voided: r.voided_at !== null,
      // Flagged per row as well as counted on the ribbon, so the disagreeing
      // receipt is one click away rather than a hunt through the day.
      mismatch: r.client_total !== null
        && Number(r.client_total).toFixed(2) !== Number(r.total).toFixed(2)
        ? num(r.client_total) : null,
    })),
    page: { limit, offset, count: t.tickets },
    totals: {
      tickets: t.tickets, covers: t.covers,
      gross: num(t.gross), discount: num(t.discount), service: num(t.service),
      tax: num(t.tax), rounding: num(t.rounding), total: num(t.total),
      cogs: num(t.cogs), voided: t.voided, mismatched: t.mismatched,
      average: t.tickets ? Math.round((Number(t.total) / t.tickets) * 100) / 100 : 0,
    },
    tender: tender.rows.map((r) => ({
      method: r.method, count: r.n, amount: num(r.amount), tip: num(r.tip),
    })),
  };
}

/* ── one receipt, in full ───────────────────────────────────────────────────
 *
 * Everything the sale caused, reachable from the sale. The journal and the
 * stock moves are here because §13 asks that a financial movement be an
 * auditable ledger event — and an event nobody can see from the thing that
 * caused it may as well not be recorded.
 */
async function receipt(c, saleId, rank) {
  const s = await c.query(
    'SELECT s.*, t.table_no, t.covers AS ticket_covers, t.opened_at, t.opened_by,'
    + ' t.channel AS ticket_channel,'
    + ' closer.name AS closed_by_name, voider.name AS voided_by_name,'
    + ' opener.name AS opened_by_name'
    + ' FROM sale s'
    + ' LEFT JOIN ticket t ON t.id = s.ticket_id'
    + ' LEFT JOIN chain.staff closer ON closer.id = s.closed_by'
    + ' LEFT JOIN chain.staff voider ON voider.id = s.voided_by'
    + ' LEFT JOIN chain.staff opener ON opener.id = t.opened_by'
    + ' WHERE s.id = $1', [saleId]);
  if (!s.rows.length) throw Object.assign(new Error('no such sale'), { status: 404 });
  const sale = s.rows[0];

  const [lines, payments, jrnl, moves] = await Promise.all([
    /* `addons` rides along so the receipt can answer the one question a
       unit price cannot: why this curry cost 200 when the menu says 185.
       See migration 037. */
    c.query('SELECT id, item_id, name, qty, unit_price, line_total, unit_cost, line_cost, addons'
      + ' FROM sale_line WHERE sale_id = $1 ORDER BY id', [saleId]),
    c.query('SELECT p.id, p.method, p.amount, p.currency, p.fx_amount, p.fx_rate,'
      + ' p.tendered, p.change_given, p.tip, p.auth_ref, p.at, st.name AS taken_by_name'
      + ' FROM payment p LEFT JOIN chain.staff st ON st.id = p.taken_by'
      + ' WHERE p.sale_id = $1 ORDER BY p.at, p.id', [saleId]),
    c.query('SELECT j.id, j.jv_no, j.entry_date, j.memo,'
      + " json_agg(json_build_object('account', l.account_code, 'name', a.name,"
      + "   'dr', l.dr, 'cr', l.cr) ORDER BY l.id) AS lines"
      + ' FROM journal j'
      + ' JOIN journal_line l ON l.journal_id = j.id'
      + ' LEFT JOIN account a ON a.code = l.account_code'
      + " WHERE j.source = 'sale' AND j.source_id = $1::text"
      + ' GROUP BY j.id', [saleId]),
    c.query('SELECT m.ingredient_id, i.name, i.unit, m.qty, m.unit_cost, m.value'
      + ' FROM stock_move m LEFT JOIN ingredient i ON i.id = m.ingredient_id'
      + ' WHERE m.sale_id = $1 ORDER BY i.name', [saleId]),
  ]);

  /* The ticket's own lines, INCLUDING the voided ones. A line struck off before
     payment never reaches the receipt, and a receipt that shows only what was
     charged cannot answer "the guest says they were charged for a drink they
     sent back". Void carries who did it and why, which is the whole reason to
     keep the row rather than delete it. */
  let ticketLines = [];
  if (sale.ticket_id) {
    const q = await c.query(
      'SELECT l.id, l.name, l.qty, l.unit_price, l.note, l.course, l.sent_at,'
      + ' l.void_at, l.void_reason, st.name AS by_name, vst.name AS void_by_name'
      + ' FROM ticket_line l'
      + ' LEFT JOIN chain.staff st ON st.id = l.by_staff'
      + ' LEFT JOIN chain.staff vst ON vst.id = l.void_by'
      + ' WHERE l.ticket_id = $1 ORDER BY l.id', [sale.ticket_id]);
    ticketLines = q.rows.map((r) => ({
      id: r.id, name: r.name, qty: num(r.qty), unitPrice: num(r.unit_price),
      note: r.note, course: r.course, sentAt: r.sent_at,
      voided: r.void_at !== null, voidReason: r.void_reason,
      by: r.by_name || null, voidBy: r.void_by_name || null,
    }));
  }

  /* chain.audit is readable at MANAGER rank and above — that is the RLS policy,
     not a decision taken here, and the query would come back empty for a
     cashier. Empty is the wrong answer: it reads as "nothing happened to this
     ticket", which is a stronger claim than "you may not see this". So the
     rank is checked before asking, and the difference is stated in the
     response. */
  const mayAudit = (rank || 0) >= 3;
  const trail = mayAudit ? await auditTrail(c, saleId, sale.ticket_id) : null;

  const out = {
    sale: {
      id: sale.id, receiptNo: sale.receipt_no, at: sale.at,
      businessDate: sale.business_date, channel: sale.channel, covers: sale.covers,
      table: sale.table_no, openedAt: sale.opened_at,
      server: sale.server_name || sale.opened_by_name || null,
      closedBy: sale.closed_by_name || null, deviceId: sale.device_id,
      gross: num(sale.gross), discount: num(sale.discount),
      discountReason: sale.discount_reason,
      service: num(sale.service), tax: num(sale.tax), taxCode: sale.tax_code,
      taxRate: num(sale.tax_rate), rounding: num(sale.rounding),
      total: num(sale.total), cogs: num(sale.cogs),
      voided: sale.voided_at !== null, voidedAt: sale.voided_at,
      voidedBy: sale.voided_by_name || null,
      clientTotal: num(sale.client_total),
      mismatch: sale.client_total !== null
        && Number(sale.client_total).toFixed(2) !== Number(sale.total).toFixed(2),
    },
    lines: lines.rows.map((r) => ({
      id: r.id, itemId: r.item_id, name: r.name, qty: num(r.qty),
      unitPrice: num(r.unit_price), lineTotal: num(r.line_total),
      unitCost: num(r.unit_cost), lineCost: num(r.line_cost),
      addons: r.addons || [],
    })),
    payments: payments.rows.map((r) => ({
      id: r.id, method: r.method, amount: num(r.amount), currency: r.currency,
      fxAmount: num(r.fx_amount), fxRate: num(r.fx_rate),
      tendered: num(r.tendered), change: num(r.change_given), tip: num(r.tip),
      ref: r.auth_ref, at: r.at, takenBy: r.taken_by_name || null,
    })),
    ticketLines,
    journal: jrnl.rows.length ? {
      id: jrnl.rows[0].id, jvNo: jrnl.rows[0].jv_no,
      date: jrnl.rows[0].entry_date, memo: jrnl.rows[0].memo,
      lines: jrnl.rows[0].lines.map((l) => ({
        account: l.account, name: l.name, dr: Number(l.dr), cr: Number(l.cr),
      })),
    } : null,
    stock: moves.rows.map((r) => ({
      ingredientId: r.ingredient_id, name: r.name, unit: r.unit,
      qty: num(r.qty), unitCost: num(r.unit_cost), value: num(r.value),
    })),
    audit: trail,
    auditVisible: mayAudit,
  };
  return redact(out, rank);
}

/* ── the audit trail of one ticket ─────────────────────────────────────────
 *
 * Assembled across the three entities one ticket touches, because that is how
 * the acts were recorded as they happened and rewriting history into a single
 * table afterwards would mean trusting a second copy of it:
 *
 *   ticket      — the round being fired to the kitchen
 *   kds_ticket  — each stage the pass moved it through
 *   sale        — the money, and any disagreement about the money
 *
 * Ordered by time, so it reads as the evening did.
 */
async function auditTrail(c, saleId, ticketId) {
  const q = await c.query(
    'SELECT a.at, a.action, a.entity, a.entity_id, a.before, a.after, a.rank,'
    + ' a.device_id, st.name AS actor_name'
    + ' FROM chain.audit a LEFT JOIN chain.staff st ON st.id = a.actor'
    + " WHERE (a.entity = 'sale' AND a.entity_id = $1::text)"
    + "    OR ($2::text IS NOT NULL AND a.entity = 'ticket' AND a.entity_id = $2::text)"
    + "    OR ($2::text IS NOT NULL AND a.entity = 'kds_ticket' AND a.entity_id IN ("
    + '         SELECT k.id::text FROM kds_ticket k WHERE k.ticket_id = $2::uuid))'
    + ' ORDER BY a.at, a.id',
    [saleId, ticketId || null]);
  return q.rows.map((r) => ({
    at: r.at, action: r.action, entity: r.entity,
    actor: r.actor_name || null, rank: r.rank,
    before: r.before, after: r.after,
  }));
}

/* Below manager rank, a receipt shows what the guest was charged and nothing
 * about what it cost to make. A cashier legitimately needs the receipt, the
 * tender and the trail; plate cost, COGS and the inventory side of the journal
 * are the business's margin, and the till is the least controlled screen in the
 * building. Stripped here rather than hidden in the client, because a client is
 * not a boundary — the same reason the guest snapshot is scoped server-side. */
const COST_ACCOUNTS = new Set(['5000', '1100']);

function redact(out, rank) {
  if ((rank || 0) >= 3) return out;
  out.sale.cogs = null;
  out.lines = out.lines.map((l) => ({ ...l, unitCost: null, lineCost: null }));
  out.stock = out.stock.map((m) => ({ ...m, unitCost: null, value: null }));
  if (out.journal) {
    out.journal = {
      ...out.journal,
      lines: out.journal.lines.filter((l) => !COST_ACCOUNTS.has(l.account)),
      partial: true,
    };
  }
  return out;
}

/** The day summary, without the cost line, for a till session. */
function redactDay(out, rank) {
  if ((rank || 0) >= 3) return out;
  out.totals = { ...out.totals, cogs: null };
  return out;
}

module.exports = { day, receipt, redactDay };
