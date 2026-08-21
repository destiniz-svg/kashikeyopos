'use strict';
/* ═══ REPLAY ════════════════════════════════════════════════════════════════
   One operation, one client-generated opId, applied exactly once.

   Every mutation in the terminal goes through `queue(op, label, entity)` — one
   seam, 115 kinds — and lands here. Two rules hold for all of them:

     · IDEMPOTENT. op_log's primary key is the client's own opId, generated
       before the network was touched. A reconnect that replays the outbox
       books nothing twice.
     · A CLOSED TICKET IS NEVER OVERWRITTEN. A late replay of an earlier edit
       finds the ticket closed and is recorded as superseded, not applied.

   A kind with no handler is still recorded, because the op log is the audit
   trail as well as the queue: an operation nobody modelled is a gap we want
   visible, not a write we silently dropped.
   ═══════════════════════════════════════════════════════════════════════ */

const RULES = require('../app/kashikeyo-rules.js');

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const r2 = (v) => Math.round(num(v) * 100) / 100;
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── the sale: the one operation the whole product exists to get right ───── */
async function applySale(c, p, ctx) {
  // The receipt number is allocated HERE, on the server, under the series row
  // lock — never on the terminal, where two tills would mint the same one.
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['SALE']);

  // The books must square whatever the terminal computed. Recompute from the
  // components; if the terminal's own total disagrees, repair the row into a
  // consistent one and stamp the discrepancy — never reject, because a cashier
  // has already taken the money.
  const subtotal = r2(p.sub);
  const discount = r2(p.disc);
  const net = r2(subtotal - discount);
  const service = r2(p.svc);
  const tax = r2(p.tax);
  const rounding = r2(p.round);
  const total = r2(net + service + tax + rounding);
  const claimed = r2(p.total);
  const audit = Math.abs(claimed - total) > 0.005
    ? { at: new Date().toISOString(), claimed, computed: total,
      note: 'terminal total did not tie to its own components' }
    : null;

  const sale = await one(c,
    'INSERT INTO sale (receipt_no, ticket_id, at, business_date, channel, covers,'
    + ' subtotal, discount, discount_code, discount_reason, discount_by, net,'
    + ' service, tax_code, tax_label, tax_rate, tax, rounding, total, tip, cogs,'
    + ' currency, fx_rate, fx_amount, member_id, customer_name, server_name,'
    + ' closed_by, device_id, client_total, server_audit)'
    + ' VALUES ($1,$2,coalesce($3, now()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'
    + ' $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)'
    + ' RETURNING id, receipt_no',
    [no.no, p.ticketId || null, p.at ? new Date(p.at) : null,
      p.bizDate || today(), p.channel || 'dine_in', Math.max(1, num(p.covers) || 1),
      subtotal, discount, p.discCode || null, p.discReason || null,
      // An unregistered outlet must not have a tax LABEL invented for it: the
      // receipt would name a registration the business does not hold.
      p.discBy || null, net, service, p.taxCode || 'GGST',
      p.taxCode === 'NONE' ? '' : (p.taxLabel || 'GST'), num(p.taxRate), tax, rounding, total, r2(p.tip),
      r2(p.cogs), p.cur || 'MVR', num(p.rate) || 1, r2(p.fgn),
      p.member || null, p.customer || null, p.server || null,
      ctx.actor, ctx.deviceId, claimed, audit ? JSON.stringify(audit) : null]);

  for (const l of arr(p.sold)) {
    await c.query('INSERT INTO sale_line (sale_id, item_id, name, qty, unit_price,'
      + ' line_total, unit_cost, line_cost, addons, guest_ix)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [sale.id, l.id, l.name, num(l.qty), r2(l.price), r2(l.amount),
        num(l.unitCost), r2(l.cost), JSON.stringify(l.addons || []), num(l.guest)]);
  }

  for (const pay of arr(p.payments)) {
    await c.query('INSERT INTO payment (sale_id, method, amount, currency,'
      + ' fx_amount, fx_rate, tendered, change_given, tip, auth_ref, taken_by, device_id)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [sale.id, pay.method || 'cash', r2(pay.amt), pay.cur || 'MVR',
        pay.fgn ? r2(pay.fgn) : null, pay.rate ? num(pay.rate) : null,
        pay.tendered ? r2(pay.tendered) : null,
        pay.chg ? r2(pay.chg) : null, r2(pay.tip), pay.ref || null,
        ctx.actor, ctx.deviceId]);
  }

  // Stock and COGS move at the moment of sale, not in a nightly batch.
  for (const m of arr(p.stockMoves)) {
    await moveStock(c, ctx, {
      ing: m.ing, qty: -Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'sale', saleId: sale.id, loc: m.loc || null
    });
  }

  // The ledger legs. Derived from the sale that just happened, never keyed.
  await postJournal(c, ctx, saleJournal(p, {
    net, service, tax, rounding, total, discount, cogs: r2(p.cogs),
    payments: arr(p.payments), stock: arr(p.stockMoves), channel: p.channel
  }), 'sale', sale.id, p.bizDate || today(), 'Sale ' + sale.receipt_no);

  // Close the bill this sale settled. A ticket opened offline reaches the
  // outlet as lines against a TABLE and has no server id on the device, so
  // resolve either way — otherwise the floor keeps showing an occupied table
  // whose money is already in the drawer.
  const closing = await ticketRef(c, p);
  if (closing) {
    await c.query("UPDATE ticket SET status = 'closed', closed_at = now(),"
      + " closed_by = $2 WHERE id = $1 AND status <> 'closed'", [closing, ctx.actor]);
    await c.query('UPDATE sale SET ticket_id = coalesce(ticket_id, $2) WHERE id = $1',
      [sale.id, closing]);
  }
  await c.query('INSERT INTO document (no, kind, business_date, amount, ref_id, by_staff)'
    + " VALUES ($1,'SALE',$2,$3,$4,$5) ON CONFLICT (no) DO NOTHING",
    [sale.receipt_no, p.bizDate || today(), total, sale.id, ctx.actor]);

  /* Points are awarded HERE, from the outlet's own earn rate — never from a
     number the terminal sent. A till that computes its own points is a till
     that can be made to award any number of them, and a member whose balance
     depends on which device settled the bill has no balance at all. */
  if (p.member) {
    const rate = await c.query("SELECT value FROM chain.setting WHERE key = 'loyalty'");
    const per = Number(((rate.rows[0] || {}).value || {}).pointsPer) || 10;
    const earned = Math.floor(net / per);
    if (earned > 0) {
      await c.query('UPDATE chain.member SET points = points + $2 WHERE id = $1',
        [p.member, earned]);
      await log(c, 'points_earned', 'member', p.member, null,
        { sale: sale.receipt_no, net, per, points: earned });
    }
  }

  await log(c, 'sale', 'sale', sale.id, null, { no: sale.receipt_no, total });
  return { saleId: sale.id, receiptNo: sale.receipt_no, total, repaired: !!audit };
}

/* The posting rules, in one place, so the trial balance is a consequence of
   the design rather than something anybody has to remember to keep true. */
function saleJournal(p, T) {
  const lines = [];
  const dr = (acct, amt, memo) => { if (r2(amt) > 0) lines.push({ acct, dr: r2(amt), memo }); };
  const cr = (acct, amt, memo) => { if (r2(amt) > 0) lines.push({ acct, cr: r2(amt), memo }); };

  // Tender. Each method lands on its own account, because "cash" and "card
  // money that arrives on Tuesday" are not the same asset.
  const byMethod = {};
  T.payments.forEach((x) => {
    const m = x.method || 'cash';
    byMethod[m] = r2((byMethod[m] || 0) + num(x.amt));
  });
  if (!T.payments.length) byMethod.cash = T.total;
  Object.keys(byMethod).forEach((m) => {
    const acct = m === 'card' || m === 'wallet' ? '1030'
      : m === 'credit' ? '1040'
        : m === 'transfer' ? '1020' : '1010';
    dr(acct, byMethod[m], 'Tender · ' + m);
  });

  cr(T.channel === 'delivery' ? '4100' : '4000', T.net + T.discount, 'Revenue');
  dr('4200', T.discount, 'Discount given');
  cr('2300', T.service, 'Service charge payable');
  cr('2200', T.tax, 'Output tax');
  if (T.rounding > 0) cr('4900', T.rounding, 'Cash rounding');
  if (T.rounding < 0) dr('4900', -T.rounding, 'Cash rounding');
  if (T.cogs > 0) { dr('5000', T.cogs, 'Cost of sales'); cr('1200', T.cogs, 'Stock consumed'); }
  return lines;
}

/* ── the ledger ─────────────────────────────────────────────────────────── */
async function postJournal(c, ctx, lines, source, sourceId, date, memo) {
  const clean = arr(lines).filter((l) => r2(l.dr) > 0 || r2(l.cr) > 0);
  if (!clean.length) return null;
  const drs = clean.reduce((a, l) => a + r2(l.dr), 0);
  const crs = clean.reduce((a, l) => a + r2(l.cr), 0);
  if (Math.abs(drs - crs) > 0.005) {
    // Balance the rounding on 4900 rather than refusing: an unposted sale is a
    // worse outcome than a one-laari rounding line somebody can see.
    const d = r2(crs - drs);
    clean.push(d > 0 ? { acct: '4900', dr: d, memo: 'Rounding' }
      : { acct: '4900', cr: -d, memo: 'Rounding' });
  }
  await ensurePeriodOpen(c, date);
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['JV']);
  const j = await one(c, 'INSERT INTO journal (jv_no, entry_date, memo, source,'
    + ' source_id, posted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [no.no, date || today(), memo || source, source, sourceId ? String(sourceId) : null, ctx.actor]);
  for (const l of clean) {
    await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr, memo)'
      + ' VALUES ($1,$2,$3,$4,$5)', [j.id, l.acct, r2(l.dr), r2(l.cr), l.memo || null]);
  }
  return j.id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

async function ensurePeriodOpen(c, date) {
  const d = date || today();
  const id = String(d).slice(0, 7);
  const q = await c.query('SELECT state FROM period WHERE id = $1', [id]);
  if (!q.rows.length) {
    await c.query("INSERT INTO period (id, starts_on, ends_on) VALUES ($1,"
      + " ($1 || '-01')::date, (date_trunc('month',($1 || '-01')::date)"
      + " + interval '1 month - 1 day')::date) ON CONFLICT DO NOTHING", [id]);
    return;
  }
  if (q.rows[0].state === 'closed') {
    throw Object.assign(new Error('Period ' + id + ' is closed — reopen it to post into it'),
      { status: 409 });
  }
}

/* ── stock: the immutable signed ledger, plus its cached balance ─────────── */
async function moveStock(c, ctx, m) {
  if (!m.ing) return null;
  const qty = num(m.qty);
  if (!qty && m.reason !== 'audit') return null;
  const row = await one(c,
    'INSERT INTO stock_move (ingredient_id, qty, unit_cost, value, reason,'
    + ' location_id, sale_id, batch_id, note, business_date, by_staff, device_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, current_date),$11,$12)'
    + ' RETURNING id',
    [m.ing, qty, num(m.cost), r2(m.value), m.reason, m.loc || null,
      m.saleId || null, m.batchId || null, m.note || null, m.date || null,
      ctx.actor, ctx.deviceId]);
  // The cache follows the ledger, never the other way round.
  await c.query('UPDATE ingredient SET on_hand = on_hand + $2 WHERE id = $1', [m.ing, qty]);
  // Receiving re-averages the cost. Weighted, so a big cheap delivery moves it
  // more than a small expensive one — which is what a plate actually costs.
  if (qty > 0 && num(m.cost) > 0 && (m.reason === 'purchase' || m.reason === 'produce')) {
    await c.query(
      'UPDATE ingredient SET avg_cost = CASE WHEN on_hand <= 0 THEN $2 ELSE'
      + ' ((greatest(on_hand - $3, 0) * avg_cost) + ($3 * $2))'
      + ' / nullif(greatest(on_hand - $3, 0) + $3, 0) END WHERE id = $1',
      [m.ing, num(m.cost), qty]);
  }
  return row.id;
}

/* ── the handler table ──────────────────────────────────────────────────── */
const H = {};

// ═══ SERVICE ═══════════════════════════════════════════════════════════════
H.open_register = async (c, p, ctx) => {
  const q = await c.query('SELECT id FROM drawer_session WHERE closed_at IS NULL');
  if (q.rows.length) return { id: q.rows[0].id, already: true };
  const d = await one(c, 'INSERT INTO drawer_session (opened_by, float_amount, device_id)'
    + ' VALUES ($1,$2,$3) RETURNING id', [ctx.actor, r2(p.float), ctx.deviceId]);
  await log(c, 'open_register', 'drawer', d.id, null, { float: r2(p.float) });
  return { id: d.id };
};

H.close_register = async (c, p, ctx) => {
  const open = await c.query('SELECT id, float_amount, opened_at FROM drawer_session'
    + ' WHERE closed_at IS NULL LIMIT 1');
  if (!open.rows.length) return { closed: false, why: 'no open register' };
  const d = open.rows[0];
  const takings = await one(c,
    "SELECT coalesce(sum(p.amount),0) AS cash FROM payment p JOIN sale s ON s.id = p.sale_id"
    + " WHERE p.method = 'cash' AND p.at >= $1", [d.opened_at]);
  const expected = r2(num(d.float_amount) + num(takings.cash));
  const counted = r2(p.counted);
  const variance = r2(counted - expected);
  await c.query('UPDATE drawer_session SET closed_at = now(), closed_by = $2,'
    + ' counted = $3, expected = $4, variance = $5, note = $6 WHERE id = $1',
    [d.id, ctx.actor, counted, expected, variance, p.note || null]);
  // A drawer that is short is a real cost, and it belongs in the books the day
  // it happened — not in a note nobody reads.
  if (Math.abs(variance) >= 0.01) {
    await postJournal(c, ctx, variance < 0
      ? [{ acct: '6300', dr: -variance, memo: 'Cash short' }, { acct: '1010', cr: -variance }]
      : [{ acct: '1010', dr: variance }, { acct: '4900', cr: variance, memo: 'Cash over' }],
    'drawer', d.id, today(), 'Drawer variance');
  }
  await log(c, 'close_register', 'drawer', d.id, null, { expected, counted, variance });
  return { id: d.id, expected, counted, variance };
};

H.sale = applySale;
H.split_payment = applySale;

/* A line on an open ticket. `lid` is the id the TILL gave it, which is what
   makes this idempotent: the same line arriving twice — a retry, a replay from
   an outbox that came back after an outage — updates the quantity rather than
   ordering the dish again. A line with no client id is still accepted, because
   an older terminal must not be refused mid-service. */
H.add_line = async (c, p, ctx) => {
  if (!p.item) return { skipped: 'no item' };
  const t = await ticketFor(c, ctx, p);
  if (!t) return { skipped: 'ticket closed' };
  const cols = [t.id, p.item, p.name || p.item, num(p.qty) || 1, r2(p.price),
    JSON.stringify(p.addons || []), num(p.guest), p.note || null,
    p.course || null, p.station || null, ctx.actor, ctx.deviceId, p.lid || null];
  const l = await one(c, 'INSERT INTO ticket_line (ticket_id, item_id, name, qty,'
    + ' unit_price, addons, guest_ix, note, course, station, by_staff, device_id,'
    + ' client_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
    + ' ON CONFLICT (ticket_id, client_id) WHERE client_id IS NOT NULL'
    + ' DO UPDATE SET qty = excluded.qty, note = excluded.note,'
    + ' guest_ix = excluded.guest_ix, course = excluded.course'
    + ' RETURNING id', cols);
  return { ticketId: t.id, lineId: l.id };
};

// Resolve a line the till named, either by server id or by the id it gave.
async function lineOf(c, p) {
  if (p.lineId) return p.lineId;
  if (!p.lid) return null;
  const q = await one(c, 'SELECT l.id FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id'
    + " WHERE l.client_id = $1 AND t.status <> 'closed'"
    + ' ORDER BY l.at DESC LIMIT 1', [p.lid]);
  return q ? q.id : null;
};

H.void_line = async (c, p, ctx) => {
  const id = await lineOf(c, p);
  if (!id) return { skipped: 'no such line' };
  await c.query('UPDATE ticket_line SET void_at = now(), void_by = $2, void_reason = $3'
    + ' WHERE id = $1 AND void_at IS NULL', [id, ctx.actor, p.reason || 'Voided']);
  await log(c, 'void_line', 'ticket_line', id, null, { reason: p.reason });
  return { ok: true };
};

H.line_note = async (c, p) => {
  const id = await lineOf(c, p);
  if (!id) return { skipped: 'no such line' };
  await c.query('UPDATE ticket_line SET note = $2 WHERE id = $1', [id, p.note || null]);
  return { ok: true };
};

/* An open ticket, named the way the terminal can name it. A till holds a
   TABLE, not a server id: the ticket was opened offline, or on the tablet in
   somebody else's hand. Every ticket operation therefore resolves by id when
   there is one and by table otherwise, so an outlet's open bills are the
   outlet's — visible at the counter, on the tablet and on the pass alike. */
async function ticketRef(c, p) {
  if (p.ticketId) return p.ticketId;
  if (p.table == null) return null;
  const t = await one(c, "SELECT id FROM ticket WHERE table_no = $1 AND split = $2"
    + " AND status <> 'closed' ORDER BY opened_at DESC LIMIT 1",
  [String(p.table), num(p.split)]);
  return t ? t.id : null;
}

H.move_table = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  const q = await c.query("UPDATE ticket SET table_no = $2 WHERE id = $1"
    + " AND status = 'open' RETURNING id", [id, String(p.to)]);
  if (!q.rows.length) return { skipped: 'ticket closed' };
  await log(c, 'move_table', 'ticket', id, { table: p.from }, { table: p.to });
  return { ok: true };
};

H.park_bill = async (c, p, ctx) => {
  const t = await ticketFor(c, ctx, p);
  if (!t) return { skipped: 'ticket closed' };
  await c.query("UPDATE ticket SET status = 'held' WHERE id = $1", [t.id]);
  return { ticketId: t.id };
};

H.resume_bill = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no held ticket' };
  await c.query("UPDATE ticket SET status = 'open' WHERE id = $1 AND status = 'held'", [id]);
  return { ok: true };
};

H.close_ticket = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query("UPDATE ticket SET status = 'closed', closed_at = now(), closed_by = $2"
    + " WHERE id = $1 AND status <> 'closed'", [id, ctx.actor]);
  return { ok: true };
};

H.ticket_status = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query('UPDATE ticket SET note = coalesce($2, note) WHERE id = $1',
    [id, p.note || null]);
  return { ok: true };
};

H.table_status = async (c, p) => {
  await c.query('UPDATE table_def SET status = $2 WHERE id = $1',
    [String(p.table), p.status || 'free']);
  return { ok: true };
};

H.table_update = async (c, p) => {
  await c.query('INSERT INTO table_def (id, label, zone_id, seats, pos, shape, active)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,coalesce($7,true))'
    + ' ON CONFLICT (id) DO UPDATE SET label = excluded.label,'
    + ' zone_id = excluded.zone_id, seats = excluded.seats, pos = excluded.pos,'
    + ' shape = excluded.shape, active = excluded.active',
    [String(p.id), p.label || String(p.id), p.zone || null, num(p.seats) || 4,
      num(p.pos), p.shape || 'square', p.active]);
  return { ok: true };
};

H.zones_update = async (c, p) => {
  for (const z of arr(p.zones)) {
    await c.query('INSERT INTO zone (id, name, pos, active) VALUES ($1,$2,$3,true)'
      + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, pos = excluded.pos',
      [String(z.id), z.name, num(z.pos)]);
  }
  return { zones: arr(p.zones).length };
};

H.covers_update = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query('UPDATE ticket SET party = $2, covers = greatest($2, covers)'
    + ' WHERE id = $1', [id, Math.max(1, num(p.party) || 1)]);
  return { ok: true };
};

H.guest_add = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query("UPDATE ticket SET guests = coalesce(guests,'[]'::jsonb) || $2::jsonb"
    + ' WHERE id = $1', [id, JSON.stringify([p.guest || {}])]);
  return { ok: true };
};

H.price_override = async (c, p, ctx) => {
  await c.query('INSERT INTO price_override (item_id, price, reason, by_staff, until)'
    + ' VALUES ($1,$2,$3,$4,$5)',
    [p.item, r2(p.price), p.reason || 'Override', ctx.actor, p.until || null]);
  await log(c, 'price_override', 'item', p.item, { price: p.from }, { price: r2(p.price) });
  return { ok: true };
};

// ═══ REFUNDS ═══════════════════════════════════════════════════════════════
// A refund is a REVERSING DOCUMENT with its own series, never an edit.
H.refund = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['CN']);
  const net = r2(p.net), tax = r2(p.tax), svc = r2(p.svc);
  const amount = r2(p.amt != null ? p.amt : net + tax + svc);
  const cn = await one(c, 'INSERT INTO credit_note (cn_no, sale_id, business_date,'
    + ' lines, net, tax, service, amount, method, reason, raised_by, approved_by)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
    [no.no, p.saleId || null, p.bizDate || today(), JSON.stringify(p.lines || []),
      net, tax, svc, amount, p.method || 'cash', p.reason || 'Refund',
      ctx.actor, p.approvedBy || ctx.actor]);

  const tenderAcct = p.method === 'card' ? '1030' : p.method === 'credit' ? '1040' : '1010';
  await postJournal(c, ctx, [
    { acct: '4000', dr: net, memo: 'Revenue reversed' },
    { acct: '2200', dr: tax, memo: 'Output tax reversed' },
    { acct: '2300', dr: svc, memo: 'Service charge reversed' },
    { acct: tenderAcct, cr: amount, memo: 'Refund paid' }
  ], 'refund', cn.id, p.bizDate || today(), 'Credit note ' + no.no);

  // Stock only comes back if it was actually returned to the kitchen.
  for (const m of arr(p.stockMoves)) {
    await moveStock(c, ctx, { ing: m.ing, qty: Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'refund' });
  }
  await c.query('INSERT INTO document (no, kind, business_date, amount, ref_id, by_staff)'
    + " VALUES ($1,'CN',$2,$3,$4,$5) ON CONFLICT (no) DO NOTHING",
    [no.no, p.bizDate || today(), amount, cn.id, ctx.actor]);
  await log(c, 'refund', 'credit_note', cn.id, null, { no: no.no, amount });
  return { creditNoteId: cn.id, no: no.no, amount };
};
H.credit_note = H.refund;

H.credit_reverse = async (c, p, ctx) => {
  await log(c, 'credit_reverse', 'credit_note', p.id, null, { reason: p.reason });
  return { ok: true };
};

// ═══ STOCK ═════════════════════════════════════════════════════════════════
H.stock_adjust = async (c, p, ctx) => {
  const id = await moveStock(c, ctx, {
    ing: p.ing, qty: num(p.qty), cost: num(p.cost), value: r2(p.value),
    reason: p.reason === 'waste' ? 'waste' : 'manual', note: p.note, loc: p.loc
  });
  if (r2(p.value)) {
    await postJournal(c, ctx, [
      { acct: '5100', dr: Math.abs(r2(p.value)), memo: p.note || 'Stock adjustment' },
      { acct: '1200', cr: Math.abs(r2(p.value)) }
    ], 'stock', id, today(), 'Stock adjustment');
  }
  return { moveId: id };
};
H.stock_writeoff = H.stock_adjust;
H.stock_return = H.stock_adjust;

H.transfer = async (c, p, ctx) => {
  await moveStock(c, ctx, { ing: p.ing, qty: -Math.abs(num(p.qty)), cost: num(p.cost),
    value: r2(p.value), reason: 'transfer', loc: p.from, note: 'to ' + (p.to || '') });
  await moveStock(c, ctx, { ing: p.ing, qty: Math.abs(num(p.qty)), cost: num(p.cost),
    value: r2(p.value), reason: 'transfer', loc: p.to, note: 'from ' + (p.from || '') });
  return { ok: true };
};

H.count_open = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO stock_count (by_staff, scope, categories,'
    + ' location_id) VALUES ($1,$2,$3,$4) RETURNING id',
    [ctx.actor, p.scope || 'all', arr(p.cats), p.loc || null]);
  return { countId: q.id };
};

H.count_post = async (c, p, ctx) => {
  const id = p.countId || (await one(c, 'INSERT INTO stock_count (by_staff, scope)'
    + ' VALUES ($1,$2) RETURNING id', [ctx.actor, p.scope || 'all'])).id;
  let value = 0;
  for (const l of arr(p.lines)) {
    const variance = r2(num(l.actual) - num(l.theo));
    const lineValue = r2(variance * num(l.cost));
    value = r2(value + lineValue);
    await c.query('INSERT INTO count_line (count_id, ingredient_id, expected,'
      + ' counted, variance, value) VALUES ($1,$2,$3,$4,$5,$6)'
      + ' ON CONFLICT (count_id, ingredient_id) DO UPDATE SET counted = excluded.counted,'
      + ' variance = excluded.variance, value = excluded.value',
      [id, l.ing, num(l.theo), num(l.actual), variance, lineValue]);
    // A count posts a MOVE, it does not overwrite a balance: the ledger stays
    // the story of what happened, and the variance is visible for ever.
    if (Math.abs(variance) > 0.0001) {
      await moveStock(c, ctx, { ing: l.ing, qty: variance, cost: num(l.cost),
        value: lineValue, reason: 'audit', note: 'Stock count' });
    }
  }
  await c.query("UPDATE stock_count SET closed_at = now(), state = 'posted',"
    + ' variance_value = $2, approved_by = $3, approved_at = now() WHERE id = $1',
    [id, value, ctx.actor]);
  if (Math.abs(value) >= 0.01) {
    await postJournal(c, ctx, value < 0
      ? [{ acct: '5100', dr: -value, memo: 'Count variance' }, { acct: '1200', cr: -value }]
      : [{ acct: '1200', dr: value }, { acct: '5100', cr: value, memo: 'Count variance' }],
    'count', id, today(), 'Stock count variance');
  }
  await log(c, 'count_post', 'stock_count', id, null, { value, lines: arr(p.lines).length });
  return { countId: id, value };
};

H.consume_recipe = async (c, p, ctx) => {
  for (const m of arr(p.moves)) {
    await moveStock(c, ctx, { ing: m.ing, qty: -Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'prep', note: p.note });
  }
  return { moves: arr(p.moves).length };
};

H.produce = async (c, p, ctx) => {
  let cost = 0;
  for (const m of arr(p.components)) {
    cost = r2(cost + r2(m.value));
    await moveStock(c, ctx, { ing: m.ing, qty: -Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'prep', note: 'batch of ' + (p.ing || '') });
  }
  const qty = Math.abs(num(p.qty)) || 1;
  const unit = r2(cost / qty);
  const b = await one(c, 'INSERT INTO production_batch (ingredient_id, qty, unit_cost,'
    + ' by_staff, device_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [p.ing, qty, unit, ctx.actor, ctx.deviceId, p.note || null]);
  await moveStock(c, ctx, { ing: p.ing, qty: qty, cost: unit, value: cost,
    reason: 'produce', note: 'production batch' });
  return { batchId: b.id, unitCost: unit };
};

H.par_set = async (c, p) => {
  await c.query('UPDATE ingredient SET par = $2, min_stock = coalesce($3, min_stock)'
    + ' WHERE id = $1', [p.ing, num(p.par), p.min == null ? null : num(p.min)]);
  return { ok: true };
};

H.recipe_recost = async (c, p) => ({ items: arr(p.items).length });
H.recost_items = H.recipe_recost;
H.yield_test = async (c, p, ctx) => {
  await log(c, 'yield_test', 'ingredient', p.ing, null,
    { yield: num(p.y), waste: num(p.w), why: p.why });
  return { ok: true };
};

// ═══ PURCHASING ════════════════════════════════════════════════════════════
H.grn_receive = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['GRN']);
  const d = await one(c, 'INSERT INTO delivery (grn_no, po_id, supplier_id,'
    + ' business_date, received_by, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [no.no, p.po || null, p.vendor, p.bizDate || today(), ctx.actor, p.note || null]);
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO grn_line (delivery_id, ingredient_id, qty, unit,'
      + ' unit_price, line_total, use_by, lot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [d.id, l.ing, num(l.qty), l.unit || null, num(l.price), r2(l.total),
        l.useBy || null, l.lot || null]);
    if (l.useBy || l.lot) {
      await c.query('INSERT INTO batch (ingredient_id, lot, qty, unit_cost, use_by,'
        + ' location_id, delivery_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [l.ing, l.lot || null, num(l.qty), num(l.price), l.useBy || null,
          l.loc || null, d.id]);
    }
    await moveStock(c, ctx, { ing: l.ing, qty: Math.abs(num(l.qty)), cost: num(l.price),
      value: r2(l.total), reason: 'purchase', loc: l.loc, date: p.bizDate });
  }
  await c.query('INSERT INTO document (no, kind, business_date, ref_id, by_staff)'
    + " VALUES ($1,'GRN',$2,$3,$4) ON CONFLICT (no) DO NOTHING",
    [no.no, p.bizDate || today(), d.id, ctx.actor]);
  await log(c, 'grn_receive', 'delivery', d.id, null, { no: no.no, lines: arr(p.lines).length });
  return { deliveryId: d.id, no: no.no };
};

// Pricing a delivery is what claims the input tax. A signed-for delivery
// nobody priced is a credit being left on the table, and the return says so.
H.grn_priced = async (c, p, ctx) => {
  const net = r2(p.net), tax = r2(p.tax), total = r2(net + tax);
  await c.query('UPDATE delivery SET priced = true, priced_at = now(), priced_by = $2,'
    + ' net = $3, tax = $4, total = $5 WHERE id = $1',
    [p.deliveryId, ctx.actor, net, tax, total]);
  if (p.invoiceNo) {
    await c.query('INSERT INTO vendor_invoice (supplier_id, invoice_no, invoice_date,'
      + ' due_date, net, tax, amount, delivery_id, approved_by)'
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)"
      + ' ON CONFLICT (supplier_id, invoice_no) DO UPDATE SET net = excluded.net,'
      + ' tax = excluded.tax, amount = excluded.amount',
      [p.vendor, p.invoiceNo, p.date || today(),
        p.due || addDays(p.date || today(), num(p.terms) || 30),
        net, tax, total, p.deliveryId, ctx.actor]);
  }
  await postJournal(c, ctx, [
    { acct: '1200', dr: net, memo: 'Stock received' },
    { acct: '2200', dr: tax, memo: 'Input tax' },
    { acct: '2100', cr: total, memo: 'Supplier payable' }
  ], 'delivery', p.deliveryId, p.date || today(), 'Supplier invoice ' + (p.invoiceNo || ''));
  await log(c, 'grn_priced', 'delivery', p.deliveryId, null, { net, tax });
  return { ok: true, total };
};

H.vendor_payment = async (c, p, ctx) => {
  const amt = r2(p.amt);
  const v = await one(c, 'INSERT INTO vendor_payment (supplier_id, invoice_id, amount,'
    + ' method, ref, by_staff) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [p.vendor, p.invoiceId || null, amt, p.method || 'transfer', p.ref || null, ctx.actor]);
  if (p.invoiceId) {
    await c.query('UPDATE vendor_invoice SET paid = paid + $2 WHERE id = $1',
      [p.invoiceId, amt]);
  }
  await postJournal(c, ctx, [
    { acct: '2100', dr: amt, memo: 'Supplier paid' },
    { acct: p.method === 'cash' ? '1010' : '1020', cr: amt }
  ], 'vendor_payment', v.id, today(), 'Supplier payment');
  return { paymentId: v.id };
};
H.payment_run = H.vendor_payment;

H.indent = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['PR']);
  const i = await one(c, 'INSERT INTO indent (pr_no, to_outlet, needed_by, raised_by,'
    + ' note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [no.no, p.to || null, p.needed || null, ctx.actor, p.note || null]);
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO indent_line (indent_id, ingredient_id, qty)'
      + ' VALUES ($1,$2,$3)', [i.id, l.ing, num(l.qty)]);
  }
  return { indentId: i.id, no: no.no };
};

H.dispatch = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['DSP']);
  let value = 0;
  const d = await one(c, 'INSERT INTO dispatch (dsp_no, indent_id, to_outlet, sent_by)'
    + ' VALUES ($1,$2,$3,$4) RETURNING id',
    [no.no, p.indentId || null, p.to || null, ctx.actor]);
  for (const l of arr(p.lines)) {
    value = r2(value + num(l.qty) * num(l.cost));
    await c.query('INSERT INTO dispatch_line (dispatch_id, ingredient_id, qty, unit_cost)'
      + ' VALUES ($1,$2,$3,$4)', [d.id, l.ing, num(l.qty), num(l.cost)]);
    await moveStock(c, ctx, { ing: l.ing, qty: -Math.abs(num(l.qty)), cost: num(l.cost),
      value: r2(num(l.qty) * num(l.cost)), reason: 'transfer', note: 'dispatch ' + no.no });
  }
  await c.query('UPDATE dispatch SET value = $2 WHERE id = $1', [d.id, value]);
  if (p.indentId) await c.query("UPDATE indent SET status = 'fulfilled' WHERE id = $1", [p.indentId]);
  return { dispatchId: d.id, no: no.no, value };
};

H.fulfil_stage = async (c, p) => {
  await c.query('UPDATE dispatch SET status = $2, received_at = CASE WHEN $2 ='
    + " 'received' THEN now() ELSE received_at END WHERE id = $1",
  [p.id, p.stage || 'in_transit']);
  return { ok: true };
};

// ═══ THE BOOKS ═════════════════════════════════════════════════════════════
// A manual journal REFUSES the accounts the till owns and requires a memo. A
// manual entry without a reason is unauditable, and a hand-keyed cash line is
// how a ledger stops reconciling to the POS.
H.post_journal = async (c, p, ctx) => {
  if (!p.memo || !String(p.memo).trim()) {
    throw Object.assign(new Error('A manual journal needs a memo'), { status: 400 });
  }
  const codes = arr(p.lines).map((l) => l.acct);
  const owned = await c.query('SELECT code, name FROM account WHERE code = ANY($1)'
    + ' AND till_owned', [codes]);
  if (owned.rows.length) {
    throw Object.assign(new Error('The till owns ' + owned.rows.map((x) =>
      x.code + ' ' + x.name).join(', ') + ' — post through the operation that moves it'),
    { status: 403 });
  }
  const id = await postJournal(c, ctx, p.lines, 'manual', null, p.date || today(), p.memo);
  await log(c, 'post_journal', 'journal', id, null, { memo: p.memo });
  return { journalId: id };
};

H.period_close = async (c, p, ctx) => {
  await c.query("INSERT INTO period (id, starts_on, ends_on, state, closed_at, closed_by)"
    + " VALUES ($1, ($1 || '-01')::date, (date_trunc('month',($1 || '-01')::date)"
    + " + interval '1 month - 1 day')::date, 'closed', now(), $2)"
    + " ON CONFLICT (id) DO UPDATE SET state = 'closed', closed_at = now(), closed_by = $2",
  [p.period, ctx.actor]);
  await log(c, 'period_close', 'period', p.period, null, null);
  return { period: p.period };
};

H.period_reopen = async (c, p, ctx) => {
  await c.query("UPDATE period SET state = 'open', reopened_at = now(), reopened_by = $2"
    + ' WHERE id = $1', [p.period, ctx.actor]);
  await log(c, 'period_reopen', 'period', p.period, null, { why: p.why });
  return { period: p.period };
};

H.bank_import = async (c, p, ctx) => {
  let n = 0;
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO bank_line (value_date, descr, amount, balance, ref)'
      + ' VALUES ($1,$2,$3,$4,$5)',
      [l.date, l.descr, r2(l.amt), l.bal == null ? null : r2(l.bal), l.ref || null]);
    n++;
  }
  await log(c, 'bank_import', 'bank_line', null, null, { lines: n });
  return { imported: n };
};

// Three outcomes, never two: an exact hit clears itself, a near miss becomes a
// proposal a human accepts or rejects, and anything else stays unexplained.
H.bank_match = async (c, p, ctx) => {
  await c.query('UPDATE bank_line SET state = $2, matched_account = $3,'
    + ' matched_source = $4, matched_id = $5, matched_at = now(), matched_by = $6'
    + ' WHERE id = $1',
    [p.id, p.state || 'proposed', p.acct || null, p.src || null,
      p.ref || null, ctx.actor]);
  return { ok: true };
};

H.bank_match_accept = async (c, p, ctx) => {
  const l = await one(c, 'SELECT * FROM bank_line WHERE id = $1', [p.id]);
  if (!l) return { skipped: 'no such line' };
  await c.query("UPDATE bank_line SET state = 'cleared', matched_at = now(),"
    + ' matched_by = $2, matched_account = coalesce($3, matched_account) WHERE id = $1',
  [p.id, ctx.actor, p.acct || null]);
  // A charge nobody booked is proposed to 5600 Bank & card charges — not to
  // 6300 Administration, which overstates office cost and hides the cost of
  // taking cards.
  if (p.post) {
    const acct = p.acct || (num(l.amount) < 0 ? '5600' : '4900');
    const amt = Math.abs(r2(l.amount));
    await postJournal(c, ctx, num(l.amount) < 0
      ? [{ acct: acct, dr: amt, memo: l.descr }, { acct: '1020', cr: amt }]
      : [{ acct: '1020', dr: amt }, { acct: acct, cr: amt, memo: l.descr }],
    'bank', l.id, l.value_date, 'Bank: ' + l.descr);
  }
  return { ok: true };
};
H.bank_clear_manual = H.bank_match_accept;
H.bank_recon = async (c, p) => ({ ok: true, at: Date.now() });

H.bank_opening = async (c, p, ctx) => {
  await c.query('INSERT INTO bank_opening (id, account_code, as_of, amount, set_by)'
    + ' VALUES (1,$1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET account_code = $1,'
    + ' as_of = $2, amount = $3, set_by = $4, set_at = now()',
    [p.acct || '1020', p.asOf || today(), r2(p.amt), ctx.actor]);
  return { ok: true };
};

// Card settlement matches batch by batch at the contract rate; more than
// MVR 1 off expected net is flagged Short paid, not cleared.
H.acq_match = async (c, p, ctx) => {
  const gross = r2(p.gross), mdr = num(p.mdr);
  const fee = r2(gross * mdr / 100);
  const expected = r2(gross - fee);
  const net = p.net == null ? expected : r2(p.net);
  const variance = r2(net - expected);
  const state = Math.abs(variance) <= 1 ? 'matched' : 'short';
  const b = await one(c, 'INSERT INTO settlement_batch (acquirer, batch_no, value_date,'
    + ' gross, mdr_pct, fee, net, expected_net, variance, state, matched_at, matched_by)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)'
    + ' ON CONFLICT (acquirer, batch_no) DO UPDATE SET net = excluded.net,'
    + ' variance = excluded.variance, state = excluded.state RETURNING id',
    [p.acquirer, p.batch, p.date || today(), gross, mdr, fee, net, expected,
      variance, state, ctx.actor]);
  if (state === 'matched') {
    await postJournal(c, ctx, [
      { acct: '1020', dr: net, memo: 'Card settlement' },
      { acct: '5600', dr: fee, memo: 'Merchant fee' },
      { acct: '1030', cr: gross, memo: 'Card receivable cleared' }
    ], 'settlement', b.id, p.date || today(), 'Card batch ' + p.batch);
  }
  return { batchId: b.id, state, variance, fee };
};

H.acq_reopen = async (c, p) => {
  await c.query("UPDATE settlement_batch SET state = 'reopened' WHERE id = $1", [p.id]);
  return { ok: true };
};

H.mdr_set = async (c, p, ctx) => setSetting(c, ctx, 'acquirer_rates_outlet', p.rates || p);
H.channel_rates = async (c, p, ctx) => setSetting(c, ctx, 'channel_rates', p.rates || p);
H.fx_rates = async (c, p, ctx) => setSetting(c, ctx, 'fx_rates', p.rates || p);

H.tax_version = async (c, p, ctx) => {
  await c.query('INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from,'
    + ' authority_ref) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [ctx.outletId, p.code, num(p.rate), p.from || today(), p.ref || 'Rate change']);
  await log(c, 'tax_version', 'tax_version', p.code, null, { rate: num(p.rate), from: p.from });
  return { ok: true };
};

// ═══ PEOPLE AND COSTS ══════════════════════════════════════════════════════
H.clock_in = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO clock_entry (employee_id, in_at, business_date,'
    + ' by_staff, device_id) VALUES ($1, coalesce($2, now()), coalesce($3, current_date),'
    + ' $4,$5) RETURNING id',
    [p.emp, p.at ? new Date(p.at) : null, p.bizDate || null, ctx.actor, ctx.deviceId]);
  return { clockId: q.id };
};

H.clock_out = async (c, p) => {
  await c.query('UPDATE clock_entry SET out_at = coalesce($2, now()) WHERE id = $1'
    + ' AND out_at IS NULL', [p.clockId, p.at ? new Date(p.at) : null]);
  return { ok: true };
};

// Employer pension is its OWN expense, taken from wages, not netted into them.
H.post_payroll = async (c, p, ctx) => {
  const gross = r2(p.gross), ee = r2(p.pensionEe), er = r2(p.pensionEr);
  const wht = r2(p.withholding), svc = r2(p.service);
  const net = r2(gross - ee - wht + svc);
  await c.query('INSERT INTO payroll_run (id, posted_at, posted_by, gross, pension_ee,'
    + ' pension_er, withholding, service_pool, net) VALUES ($1, now(), $2,$3,$4,$5,$6,$7,$8)'
    + ' ON CONFLICT (id) DO UPDATE SET posted_at = now(), posted_by = $2, gross = $3,'
    + ' pension_ee = $4, pension_er = $5, withholding = $6, service_pool = $7, net = $8',
    [p.period, ctx.actor, gross, ee, er, wht, svc, net]);
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO payroll_line (run_id, employee_id, hours, ot_hours,'
      + ' basic, ot_pay, service, pension_ee, pension_er, withholding, net)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [p.period, l.emp, num(l.hours), num(l.ot), r2(l.basic), r2(l.otPay),
        r2(l.service), r2(l.pensionEe), r2(l.pensionEr), r2(l.wht), r2(l.net)]);
  }
  const j = await postJournal(c, ctx, [
    { acct: '5300', dr: gross, memo: 'Wages' },
    { acct: '5310', dr: er, memo: 'Employer pension' },
    { acct: '2500', cr: r2(ee + er), memo: 'MRPS payable' },
    { acct: '2600', cr: wht, memo: 'Withholding payable' },
    { acct: '2300', dr: svc, memo: 'Service charge distributed' },
    { acct: '2450', cr: net, memo: 'Net pay owed' }
  ], 'payroll', p.period, p.date || today(), 'Payroll ' + p.period);
  await c.query('UPDATE payroll_run SET journal_id = $2 WHERE id = $1', [p.period, j]);
  await log(c, 'post_payroll', 'payroll_run', p.period, null, { gross, net });
  return { period: p.period, net, journalId: j };
};

H.opex_insert = async (c, p, ctx) => {
  await c.query('INSERT INTO opex (id, category, vendor, amount, freq, due_day,'
    + ' account_code, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)'
    + ' ON CONFLICT (id) DO UPDATE SET category = excluded.category,'
    + ' vendor = excluded.vendor, amount = excluded.amount, freq = excluded.freq,'
    + ' due_day = excluded.due_day, account_code = excluded.account_code',
    [p.id || slug(p.cat), p.cat, p.vendor || null, r2(p.amt), p.freq || 'monthly',
      num(p.due) || 1, p.acct || '6300', p.note || null]);
  return { ok: true };
};

H.opex_pay = async (c, p, ctx) => {
  const amt = r2(p.amt);
  const j = await postJournal(c, ctx, [
    { acct: p.acct || '6300', dr: amt, memo: p.cat || 'Operating cost' },
    { acct: p.method === 'cash' ? '1010' : '1020', cr: amt }
  ], 'opex', p.id, p.on || today(), 'Operating cost · ' + (p.cat || ''));
  await c.query('INSERT INTO opex_payment (opex_id, period, paid_on, amount, by_staff,'
    + ' journal_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (opex_id, period) DO NOTHING',
    [p.id, p.period || String(today()).slice(0, 7), p.on || today(), amt, ctx.actor, j]);
  return { ok: true };
};

H.asset_insert = async (c, p, ctx) => {
  await c.query('INSERT INTO asset (id, name, category, cost, bought_on, life_years,'
    + ' residual, serial, location_id, warranty_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, cost = excluded.cost,'
    + ' life_years = excluded.life_years, residual = excluded.residual',
    [p.id || slug(p.name), p.name, p.cat || null, r2(p.cost), p.bought || today(),
      num(p.life) || 5, r2(p.residual), p.serial || null, p.loc || null,
      p.warranty || null]);
  await postJournal(c, ctx, [
    { acct: '1500', dr: r2(p.cost), memo: 'Equipment ' + p.name },
    { acct: p.method === 'cash' ? '1010' : '2100', cr: r2(p.cost) }
  ], 'asset', p.id || slug(p.name), p.bought || today(), 'Equipment purchase');
  return { ok: true };
};

H.asset_update = async (c, p) => {
  await c.query('UPDATE asset SET state = coalesce($2, state), disposed_on = $3,'
    + ' disposed_value = $4 WHERE id = $1',
    [p.id, p.state || null, p.disposedOn || null,
      p.disposedValue == null ? null : r2(p.disposedValue)]);
  return { ok: true };
};

H.maintenance_log = async (c, p, ctx) => {
  const cost = r2(p.cost);
  const j = cost ? await postJournal(c, ctx, [
    { acct: '5400', dr: cost, memo: p.detail || 'Repair' },
    { acct: p.method === 'cash' ? '1010' : '2100', cr: cost }
  ], 'maintenance', p.asset, p.on || today(), 'Repairs & maintenance') : null;
  await c.query('INSERT INTO maintenance_log (asset_id, kind, detail, cost, vendor,'
    + ' by_staff, journal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [p.asset, p.kind || 'repair', p.detail || '', cost, p.vendor || null, ctx.actor, j]);
  return { ok: true };
};

H.depreciate = async (c, p, ctx) => {
  const amt = r2(p.amount);
  if (!amt) return { skipped: 'nothing to depreciate' };
  const j = await postJournal(c, ctx, [
    { acct: '5500', dr: amt, memo: 'Depreciation ' + p.period },
    { acct: '1510', cr: amt }
  ], 'depreciation', p.period, p.date || today(), 'Depreciation ' + p.period);
  await c.query('INSERT INTO depreciation_run (period, posted_by, amount, journal_id)'
    + ' VALUES ($1,$2,$3,$4) ON CONFLICT (period) DO NOTHING', [p.period, ctx.actor, amt, j]);
  return { period: p.period, amount: amt };
};

// ═══ MENU AND MASTERS ══════════════════════════════════════════════════════
H.menu_section_insert = async (c, p) => {
  await c.query('INSERT INTO menu_section (id, name, pos, colour) VALUES ($1,$2,$3,$4)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, pos = excluded.pos',
    [p.id || slug(p.name), p.name, num(p.pos), p.colour || null]);
  return { ok: true };
};
H.menu_section_update = H.menu_section_insert;

H.menu_section_reorder = async (c, p) => {
  for (const [i, id] of arr(p.order).entries()) {
    await c.query('UPDATE menu_section SET pos = $2 WHERE id = $1', [id, i]);
  }
  return { ok: true };
};

H.menu_category_insert = async (c, p) => {
  await c.query('INSERT INTO menu_category (id, name, section_id, pos, colour)'
    + ' VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
    + ' section_id = excluded.section_id, pos = excluded.pos',
    [p.id || slug(p.name), p.name, p.section || null, num(p.pos), p.colour || null]);
  return { ok: true };
};
H.category_insert = H.menu_category_insert;

H.dish_upsert = async (c, p, ctx) => {
  const id = p.id || slug(p.name);
  await c.query('INSERT INTO item (id, name, category_id, station, price, yield_qty,'
    + ' unit, prep_mins, description, image, allergens, diets, tags, active, off_menu,'
    + ' sold_out_reason, pos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'
    + ' coalesce($14,true), coalesce($15,false), $16, $17)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
    + ' category_id = excluded.category_id, station = excluded.station,'
    + ' price = excluded.price, yield_qty = excluded.yield_qty, unit = excluded.unit,'
    + ' prep_mins = excluded.prep_mins, description = excluded.description,'
    + ' image = excluded.image, allergens = excluded.allergens, diets = excluded.diets,'
    + ' tags = excluded.tags, active = excluded.active, off_menu = excluded.off_menu,'
    + ' sold_out_reason = excluded.sold_out_reason',
    [id, p.name, p.cat || null, p.station || 'main', r2(p.price), num(p.yield) || 1,
      p.unit || 'plate', num(p.prep) || 12, p.desc || null, p.img || null,
      arr(p.allergens), arr(p.diets), arr(p.tags), p.active, p.offMenu,
      p.soldOutReason || null, num(p.pos)]);
  if (Array.isArray(p.recipe)) await writeRecipe(c, id, p.recipe);
  await publishDeclaration(c, id);
  await log(c, 'dish_upsert', 'item', id, null, { name: p.name, price: r2(p.price) });
  return { itemId: id };
};
H.menu_import = async (c, p, ctx) => {
  let n = 0;
  for (const d of arr(p.dishes)) { await H.dish_upsert(c, d, ctx); n++; }
  await log(c, 'menu_import', 'item', null, null, { dishes: n });
  return { imported: n };
};
H.ai_menu_draft = async (c, p, ctx) => {
  await log(c, 'ai_menu_draft', 'item', null, null, { dishes: arr(p.dishes).length });
  return { drafted: arr(p.dishes).length };
};

H.recipe_update = async (c, p) => {
  await writeRecipe(c, p.item, arr(p.lines));
  await publishDeclaration(c, p.item);
  return { lines: arr(p.lines).length };
};

async function writeRecipe(c, itemId, lines) {
  await c.query('DELETE FROM recipe_line WHERE item_id = $1', [itemId]);
  for (const l of lines) {
    const ing = Array.isArray(l) ? l[0] : l.ing;
    const qty = Array.isArray(l) ? l[1] : l.qty;
    const waste = Array.isArray(l) ? l[2] : l.waste;
    const isSub = Array.isArray(l) ? l[3] === 'sub' : !!l.sub;
    if (!ing || !num(qty)) continue;
    await c.query('INSERT INTO recipe_line (item_id, ingredient_id, sub_item_id, qty,'
      + ' waste_pct) VALUES ($1,$2,$3,$4,$5)',
    [itemId, isSub ? null : ing, isSub ? ing : null, num(qty), num(waste)]);
  }
}

/* ── what a dish declares ─────────────────────────────────────────────────
   A GUEST PHONE HOLDS NO RECIPE — a recipe is a cost sheet, and a costing on
   a customer's device is a leak. So the allergen and diet declaration is
   worked out HERE, from the recipe rows, using the same rule table the
   browser loads (app/kashikeyo-rules.js), and published onto the item. The
   phone reads the answer, never the ingredients.

   Sub-recipes are expanded: a sauce made of a sauce still declares what is in
   both. Depth is bounded because a recipe that references itself is a bug the
   kitchen should not be able to turn into a hang. ───────────────────────── */
async function publishDeclaration(c, itemId) {
  const parts = [];
  const add = {};
  let frontier = [itemId];
  const seen = new Set([itemId]);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const q = await c.query(
      'SELECT r.item_id, r.sub_item_id, i.name, i.category, i.allergens'
      + ' FROM recipe_line r LEFT JOIN ingredient i ON i.id = r.ingredient_id'
      + ' WHERE r.item_id = ANY($1::text[])', [frontier]);
    const next = [];
    q.rows.forEach((row) => {
      if (row.sub_item_id) {
        if (!seen.has(row.sub_item_id)) { seen.add(row.sub_item_id); next.push(row.sub_item_id); }
        return;
      }
      if (!row.name) return;
      parts.push({ name: row.name, cat: row.category });
      // An ingredient may carry a declaration of its own — a supplier's "may
      // contain". It is added, never subtracted.
      (row.allergens || []).forEach((k) => { add[k] = 1; });
    });
    frontier = next;
  }
  const declared = Object.keys(add);
  const allergens = RULES.allergenKeys(parts, declared);
  const diets = RULES.dietKeys(parts, declared);
  await c.query('UPDATE item SET allergens = $2, diets = $3 WHERE id = $1',
    [itemId, allergens, diets]);
  return { allergens, diets };
}

// An ingredient's name, category or own declaration changed: every dish that
// uses it says something different now.
async function republishUsing(c, ingredientId) {
  const q = await c.query('SELECT DISTINCT item_id FROM recipe_line'
    + ' WHERE ingredient_id = $1', [ingredientId]);
  for (const row of q.rows) await publishDeclaration(c, row.item_id);
}

H.item_upsert = async (c, p) => {
  const id = p.id || slug(p.name);
  await c.query('INSERT INTO ingredient (id, name, category, base_unit, stock_unit,'
    + ' stock_factor, avg_cost, par, min_stock, location_id, supplier_id, count_freq,'
    + ' allergens, sellable, sell_price, producible)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14,false),$15,'
    + ' coalesce($16,false)) ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
    + ' category = excluded.category, base_unit = excluded.base_unit,'
    + ' stock_unit = excluded.stock_unit, stock_factor = excluded.stock_factor,'
    + ' par = excluded.par, min_stock = excluded.min_stock,'
    + ' location_id = excluded.location_id, supplier_id = excluded.supplier_id,'
    + ' count_freq = excluded.count_freq, allergens = excluded.allergens,'
    + ' sellable = excluded.sellable, sell_price = excluded.sell_price,'
    + ' producible = excluded.producible',
    [id, p.name, p.cat || null, p.base || 'g', p.stock || p.base || 'g',
      num(p.factor) || 1, num(p.cost), p.par == null ? null : num(p.par),
      p.min == null ? null : num(p.min), p.loc || null, p.vendor || null,
      p.freq || 'weekly', arr(p.allergens), p.sellable,
      p.sellPrice == null ? null : r2(p.sellPrice), p.producible]);
  await republishUsing(c, id);
  return { ingredientId: id };
};

H.modifier_update = async (c, p) => {
  if (p.group) {
    await c.query('INSERT INTO modifier_group (id, name, min_pick, max_pick, required)'
      + ' VALUES ($1,$2,$3,$4,coalesce($5,false)) ON CONFLICT (id) DO UPDATE'
      + ' SET name = excluded.name, min_pick = excluded.min_pick,'
      + ' max_pick = excluded.max_pick, required = excluded.required',
      [p.group, p.groupName || p.group, num(p.min), num(p.max) || 1, p.required]);
  }
  if (p.id) {
    await c.query('INSERT INTO modifier (id, group_id, name, price, pos)'
      + ' VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
      + ' price = excluded.price, pos = excluded.pos',
      [p.id, p.group, p.name, r2(p.price), num(p.pos)]);
  }
  for (const item of arr(p.items)) {
    await c.query('INSERT INTO item_modifier (item_id, group_id) VALUES ($1,$2)'
      + ' ON CONFLICT DO NOTHING', [item, p.group]);
  }
  return { ok: true };
};

H.promo_upsert = async (c, p) => {
  await c.query('INSERT INTO promo (id, name, kind, value, code, max_pct, channels,'
    + ' starts_on, ends_on, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,true))'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind,'
    + ' value = excluded.value, code = excluded.code, max_pct = excluded.max_pct,'
    + ' channels = excluded.channels, active = excluded.active',
    [p.id || slug(p.name), p.name, p.kind || 'percent', num(p.value || p.pct),
      p.code || null, num(p.maxPct) || 100, arr(p.channels), p.from || null,
      p.to || null, p.active]);
  return { ok: true };
};
H.promo_clamped = async (c, p, ctx) => {
  await log(c, 'promo_clamped', 'promo', p.id, { asked: num(p.asked) }, { given: num(p.given) });
  return { ok: true };
};

H.banner_upsert = async (c, p) => {
  await c.query('INSERT INTO banner (id, slot, title, body, image, link, starts_on,'
    + ' ends_on, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,true))'
    + ' ON CONFLICT (id) DO UPDATE SET slot = excluded.slot, title = excluded.title,'
    + ' body = excluded.body, image = excluded.image, link = excluded.link,'
    + ' active = excluded.active',
    [p.id || slug(p.title), p.slot || 'hero', p.title, p.sub || null, p.img || null,
      p.code || null, p.from || null, p.to || null, p.active]);
  return { ok: true };
};
H.qr_banner_slot = H.banner_upsert;

H.vendor_upsert = async (c, p) => {
  const q = await one(c, 'INSERT INTO chain.supplier (name, trn, contact, phone, email,'
    + ' terms_days, lead_days) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [p.name, p.trn || null, p.contact || null, p.phone || null, p.email || null,
      num(p.terms) || 30, num(p.lead) || 2]);
  return { vendorId: q.id };
};

// ═══ KITCHEN ═══════════════════════════════════════════════════════════════
H.fire_course = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  // The till names its own lines; resolve them to the outlet's before the pass
  // is told which ones it is cooking.
  let ids = arr(p.lineIds);
  if (!ids.length && arr(p.lids).length && id) {
    const q = await c.query('SELECT id FROM ticket_line WHERE ticket_id = $1'
      + ' AND client_id = ANY($2::text[])', [id, arr(p.lids)]);
    ids = q.rows.map((r) => r.id);
  }
  const k = await one(c, 'INSERT INTO kds_ticket (ticket_id, line_ids, station, course,'
    + ' target_mins, by_staff) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [id, ids, p.station || 'main', p.course || null,
      num(p.target) || 12, ctx.actor]);
  if (ids.length) {
    await c.query('UPDATE ticket_line SET sent_at = now() WHERE id = ANY($1)', [ids]);
  }
  return { kdsId: k.id, lines: ids.length };
};

H.kds_bump = async (c, p, ctx) => {
  const next = p.stage || 'Ready';
  await c.query('UPDATE kds_ticket SET stage = $2, bumped_by = $3,'
    + " ready_at = CASE WHEN $2 = 'Ready' THEN now() ELSE ready_at END,"
    + " served_at = CASE WHEN $2 = 'Served' THEN now() ELSE served_at END"
    + ' WHERE id = $1', [p.id, next, ctx.actor]);
  return { ok: true };
};

H.kds_bump_all = async (c, p, ctx) => {
  const q = await c.query("UPDATE kds_ticket SET stage = 'Served', served_at = now(),"
    + ' bumped_by = $2 WHERE station = $1 AND served_at IS NULL', [p.station, ctx.actor]);
  return { bumped: q.rowCount };
};

H.kds_recall = async (c, p, ctx) => {
  await c.query("UPDATE kds_ticket SET stage = 'Recalled', served_at = NULL,"
    + ' bumped_by = $2 WHERE id = $1', [p.id, ctx.actor]);
  await log(c, 'kds_recall', 'kds_ticket', p.id, null, null);
  return { ok: true };
};

H.kds_station = async (c, p) => {
  await c.query('UPDATE kds_ticket SET station = $2 WHERE id = $1', [p.id, p.station]);
  return { ok: true };
};

// ═══ RESERVATIONS AND GUESTS ═══════════════════════════════════════════════
H.reservation_insert = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO reservation (guest_name, phone, member_id, party,'
    + ' at, duration_mins, zone_id, table_no, note, made_by) VALUES'
    + ' ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [p.name, p.phone || null, p.member || null, Math.max(1, num(p.party) || 1),
      new Date(p.at), num(p.mins) || 90, p.zone || null, p.table || null,
      p.note || null, ctx.actor]);
  return { reservationId: q.id };
};
H.reservation_ = async (c, p) => {
  await c.query('UPDATE reservation SET status = $2 WHERE id = $1',
    [p.id, p.status || 'confirmed']);
  return { ok: true };
};

// A booking's guest name, phone and kitchen note arrive on the ticket without
// anyone re-keying them. That is the whole point of holding the booking.
H.seat_reservation = async (c, p, ctx) => {
  const rv = await one(c, 'SELECT * FROM reservation WHERE id = $1', [p.id]);
  if (!rv) return { skipped: 'no such reservation' };
  const t = await openTicket(c, ctx, {
    table: p.table || rv.table_no, split: 0, party: rv.party,
    server: p.server, member: rv.member_id, note: rv.note,
    guests: [{ name: rv.guest_name, type: 'reservation', phone: rv.phone }]
  });
  await c.query("UPDATE reservation SET status = 'seated', seated_at = now(),"
    + ' seated_by = $2, ticket_id = $3, table_no = $4 WHERE id = $1',
  [p.id, ctx.actor, t.id, p.table || rv.table_no]);
  return { ticketId: t.id };
};

H.seat_walkin = async (c, p, ctx) => {
  const t = await openTicket(c, ctx, {
    table: p.table, split: num(p.split), party: num(p.party) || 1,
    server: p.server, channel: p.channel
  });
  return { ticketId: t.id };
};

H.qr_order = async (c, p, ctx) => {
  await c.query('UPDATE guest_order SET accepted_at = now(), accepted_by = $2,'
    + ' ticket_id = $3, rejected_reason = $4 WHERE id = $1 AND accepted_at IS NULL',
    [p.id, ctx.actor, p.ticketId || null, p.reject || null]);
  return { ok: true };
};
H.qr_pay_intent = async (c, p, ctx) => {
  await log(c, 'qr_pay_intent', 'guest_order', p.id, null, { amount: r2(p.amt) });
  return { ok: true };
};
H.flag_ack = async (c, p, ctx) => {
  await c.query('UPDATE guest_request SET ack_at = now(), ack_by = $2 WHERE id = $1',
    [p.id, ctx.actor]);
  return { ok: true };
};

H.loyalty_update = async (c, p, ctx) => {
  if (p.member && p.points != null) {
    await c.query('UPDATE chain.member SET points = greatest(0, points + $2),'
      + ' tier = coalesce($3, tier) WHERE id = $1',
      [p.member, num(p.points), p.tier || null]);
  }
  if (p.rules) await setSetting(c, ctx, 'loyalty_rules', p.rules);
  return { ok: true };
};
H.earn_rate = async (c, p, ctx) => setSetting(c, ctx, 'loyalty_earn', p);
H.settle_credit = async (c, p, ctx) => {
  const amt = r2(p.amt);
  await postJournal(c, ctx, [
    { acct: p.method === 'cash' ? '1010' : '1020', dr: amt, memo: 'Credit settled' },
    { acct: '1040', cr: amt }
  ], 'credit', p.member, today(), 'Customer credit settled');
  return { ok: true };
};

// ═══ PRINT AND DEVICES ═════════════════════════════════════════════════════
H.print_job = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO print_job (kind, target, label, meta, by_staff,'
    + ' device_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [p.kind || 'receipt', p.target || 'counter', p.label || '',
      JSON.stringify(p.meta || {}), ctx.actor, ctx.deviceId]);
  return { jobId: q.id };
};
H.print_retry = async (c, p) => {
  await c.query("UPDATE print_job SET state = 'queued', tries = tries + 1 WHERE id = $1",
    [p.id]);
  return { ok: true };
};
H.print_failed = async (c, p) => {
  await c.query("UPDATE print_job SET state = 'failed', tries = tries + 1 WHERE id = $1",
    [p.id]);
  return { ok: true };
};
H.print_abandoned = async (c, p) => {
  await c.query("UPDATE print_job SET state = 'abandoned' WHERE id = $1", [p.id]);
  return { ok: true };
};
H.printer_state = async (c, p, ctx) => setSetting(c, ctx, 'printers', p.printers || p);
H.pair_kds = async (c, p, ctx) => {
  await c.query('UPDATE chain.device SET station = $2, paired_at = now(),'
    + ' pair_code = NULL WHERE id = $1 AND outlet_id = $3',
    [p.id, p.station || 'main', ctx.outletId]);
  return { ok: true };
};

// ═══ CONFIGURATION ═════════════════════════════════════════════════════════
H.setting_change = async (c, p, ctx) => setSetting(c, ctx, p.key, p.value);
H.terminal_update = async (c, p, ctx) => setSetting(c, ctx, 'terminal', p);
H.brand_update = async (c, p, ctx) => {
  await c.query("UPDATE chain.company SET brand = coalesce(brand,'{}'::jsonb) || $1::jsonb,"
    + ' updated_at = now() WHERE id = 1', [JSON.stringify(p.brand || p)]);
  await log(c, 'brand_update', 'company', '1', null, p.brand || p);
  return { ok: true };
};
H.company_update = async (c, p, ctx) => {
  await c.query('UPDATE chain.company SET legal_name = coalesce($1, legal_name),'
    + ' reg_no = coalesce($2, reg_no), tin = coalesce($3, tin),'
    + ' address = coalesce($4, address), phone = $5, email = $6, updated_at = now()'
    + ' WHERE id = 1',
    [p.name || null, p.regNo || null, p.tin || null, p.hq || p.address || null,
      p.phone || null, p.email || null]);
  await log(c, 'company_update', 'company', '1', null, p);
  return { ok: true };
};
H.chain_update = H.company_update;

H.outlet_update = async (c, p, ctx) => {
  await c.query('UPDATE chain.outlet SET name = coalesce($2, name),'
    + ' service_pct = coalesce($3, service_pct), address = coalesce($4, address),'
    + ' phone = coalesce($5, phone), day_start = coalesce($6, day_start),'
    + ' active = coalesce($7, active) WHERE id = $1',
    [ctx.outletId, p.name || null, p.sc == null ? null : num(p.sc),
      p.addr || null, p.phone || null, p.dayStart || null,
      p.active == null ? null : !!p.active]);
  await log(c, 'outlet_update', 'outlet', String(ctx.outletId), null, p);
  return { ok: true };
};

H.location_upsert = async (c, p) => {
  await c.query('INSERT INTO location (id, name, kind) VALUES ($1,$2,$3)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind',
    [p.id || slug(p.name), p.name, p.kind || 'store']);
  return { ok: true };
};

H.employee_upsert = async (c, p) => {
  await c.query('INSERT INTO employee (id, staff_id, name, job, kind, basic, hourly,'
    + ' joined_on, mrps, ot, svc, emp_type, phone, id_no)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,false),coalesce($10,true),'
    + ' coalesce($11,true),$12,$13,$14) ON CONFLICT (id) DO UPDATE SET'
    + ' name = excluded.name, job = excluded.job, kind = excluded.kind,'
    + ' basic = excluded.basic, hourly = excluded.hourly, mrps = excluded.mrps,'
    + ' ot = excluded.ot, svc = excluded.svc, emp_type = excluded.emp_type',
    [p.id || slug(p.name), p.staffId || null, p.name, p.job || '', p.kind || 'local',
      r2(p.basic), r2(p.hourly), p.joined || null, p.mrps, p.ot, p.svc,
      p.type || 'fulltime', p.phone || null, p.idNo || null]);
  return { ok: true };
};
H.staffedit = H.employee_upsert;

// ═══ AUDIT-ONLY KINDS ══════════════════════════════════════════════════════
// These change nothing in a table; the record IS the point. They are listed
// explicitly rather than swept into the default so that "not modelled yet" and
// "deliberately audit-only" stay distinguishable.
const AUDIT_ONLY = [
  'access_change', 'act_as', 'auto_lock', 'backup_create', 'backup_run',
  'cfo_query', 'device_deregister', 'device_diagnostics', 'device_lock',
  'device_paired', 'device_replay', 'grn_query', 'outlet_switch_denied',
  // The rename itself happened over HTTP, at rank 5, behind a refusal the
  // operator saw. What reaches the outbox is the record of it.
  'outlet_handle_change',
  'password_reset', 'permission_change', 'permission_reset', 'pin_failed',
  'pin_lockout', 'pin_reset', 'restore_run', 'revoke_sessions', 'sign_in',
  'sign_in_refused', 'sign_out', 'stock_query', 'store_reset', 'vendor_query',
  'void_refused'
];
AUDIT_ONLY.forEach((k) => {
  H[k] = async (c, p, ctx) => {
    await log(c, k, p && p.entity ? p.entity : null,
      p && p.id ? String(p.id) : null, null, p || null);
    return { audited: true };
  };
});

/* ── plumbing ───────────────────────────────────────────────────────────── */

async function one(c, sql, params) {
  const q = await c.query(sql, params || []);
  return q.rows[0] || null;
}

function log(c, action, entity, id, before, after) {
  return c.query('SELECT chain.log($1,$2,$3,$4,$5)',
    [action, entity, id == null ? null : String(id),
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

async function setSetting(c, ctx, key, value) {
  await c.query('INSERT INTO setting (key, value, updated_by) VALUES ($1,$2,$3)'
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(),'
    + ' updated_by = excluded.updated_by',
    [String(key), JSON.stringify(value == null ? null : value), ctx.actor]);
  await log(c, 'setting_change', 'setting', key, null, { key });
  return { ok: true };
}

// A closed ticket is never reopened by a late replay.
async function ticketFor(c, ctx, p) {
  if (p.ticketId) {
    const t = await one(c, "SELECT id FROM ticket WHERE id = $1 AND status <> 'closed'",
      [p.ticketId]);
    return t;
  }
  return openTicket(c, ctx, p);
}

async function openTicket(c, ctx, p) {
  const table = p.table == null ? null : String(p.table);
  const split = num(p.split);
  if (table) {
    const has = await one(c, "SELECT id FROM ticket WHERE table_no = $1 AND split = $2"
      + " AND status = 'open'", [table, split]);
    if (has) {
      if (p.party) {
        await c.query('UPDATE ticket SET party = greatest(party, $2),'
          + ' covers = greatest(covers, $2) WHERE id = $1', [has.id, num(p.party)]);
      }
      return has;
    }
  }
  return one(c, 'INSERT INTO ticket (table_no, split, channel, covers, party,'
    + ' business_date, opened_by, device_id, server_name, member_id, note, guests)'
    + ' VALUES ($1,$2,$3,$4,$5, coalesce($6, current_date), $7,$8,$9,$10,$11,$12)'
    + ' RETURNING id',
  [table, split, p.channel || 'dine_in', Math.max(1, num(p.party) || 1),
    num(p.party), p.bizDate || null, ctx.actor, ctx.deviceId, p.server || null,
    p.member || null, p.note || null, JSON.stringify(p.guests || [])]);
}

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'x' + Date.now().toString(36);
}

/* ── the entry point ────────────────────────────────────────────────────── */
async function applyOp(c, op, ctx) {
  const fn = H[op.kind];
  if (!fn) return { recorded: true, unmodelled: op.kind };
  return fn(c, op.payload || {}, ctx) || {};
}

module.exports = { applyOp, postJournal, moveStock, publishDeclaration, HANDLERS: H, AUDIT_ONLY };
