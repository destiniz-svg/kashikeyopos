'use strict';
const express = require('express');
const { withOutlet, withEstate, poolFor } = require('./db');
const { sign, pinMatches } = require('./secrets');
const { session, sameOutlet, atLeast } = require('./auth');

const r = express.Router();
const LOCK_TRIES = 5, LOCK_MINS = 15;

// ── sign in with a PIN, at one outlet, on one device ────────────────────────
r.post('/auth/pin', async function (req, res, next) {
  const { outletId, pin, deviceId } = req.body || {};
  if (!outletId || !pin) return res.status(400).json({ error: 'outletId and pin required' });
  try {
    const out = await withOutlet({ outletId: Number(outletId), rank: 0 }, async function (c) {
      const q = await c.query(
        'SELECT id, name, rank, pin_hash, pin_salt, failed, locked_until'
        + ' FROM chain.staff WHERE outlet_id = $1 AND active', [Number(outletId)]);
      const now = Date.now();
      for (const s of q.rows) {
        if (s.locked_until && new Date(s.locked_until).getTime() > now) continue;
        let ok = false;
        try { ok = pinMatches(pin, s.pin_hash, s.pin_salt); } catch (e) { ok = false; }
        if (!ok) continue;
        await c.query('UPDATE chain.staff SET failed = 0, locked_until = NULL WHERE id = $1', [s.id]);
        const ttl = Number(process.env.SESSION_TTL_HOURS || 12) * 3600e3;
        const sess = await c.query(
          'INSERT INTO chain.session (staff_id, outlet_id, device_id, rank, expires_at)'
          + ' VALUES ($1,$2,$3,$4, now() + ($5 || \' hours\')::interval) RETURNING id',
          [s.id, Number(outletId), deviceId || null, s.rank,
           String(process.env.SESSION_TTL_HOURS || 12)]);
        await c.query("SELECT chain.log('signin','staff',$1,NULL,NULL)", [s.id]);
        return {
          token: sign({ o: Number(outletId), r: s.rank, s: s.id,
                        d: deviceId || null, sid: sess.rows[0].id, exp: now + ttl }),
          name: s.name, rank: s.rank, outletId: Number(outletId)
        };
      }
      // Wrong PIN: count the attempt against every unlocked account at this
      // outlet, so brute force locks the door rather than probing it.
      await c.query(
        'UPDATE chain.staff SET failed = failed + 1,'
        + ' locked_until = CASE WHEN failed + 1 >= $2'
        + "   THEN now() + ($3 || ' minutes')::interval ELSE locked_until END"
        + ' WHERE outlet_id = $1 AND active',
        [Number(outletId), LOCK_TRIES, String(LOCK_MINS)]);
      return null;
    });
    if (!out) return res.status(401).json({ error: 'PIN not recognised' });
    res.json(out);
  } catch (e) { next(e); }
});

r.use(session);

r.get('/me', function (req, res) { res.json(req.ctx); });

// ── the snapshot both guest portals read. Prices, stages and what is owed —
//    no margins, no costs, no staff records. A guest device has no business
//    holding those, so they are not in the projection at all.
r.get('/outlet/:outletId/snapshot', sameOutlet, async function (req, res, next) {
  try {
    const data = await withOutlet(req.ctx, async function (c) {
      const [outlet, tax, items, tickets, stages] = await Promise.all([
        c.query('SELECT id, name, currency, service_pct, tables FROM chain.outlet WHERE id = $1', [req.ctx.outletId]),
        c.query('SELECT code, rate FROM chain.tax_version WHERE outlet_id = $1'
          + ' AND effective_from <= current_date'
          + ' AND (effective_to IS NULL OR effective_to >= current_date)'
          + ' ORDER BY effective_from DESC LIMIT 1', [req.ctx.outletId]),
        c.query('SELECT id, name, category, price, off_menu FROM item WHERE active'),
        c.query("SELECT t.id, t.table_no, t.split, t.covers, t.status,"
          + " coalesce(json_agg(json_build_object('name', l.name, 'qty', l.qty,"
          + "   'price', l.unit_price, 'sent', l.sent_at IS NOT NULL)"
          + "   ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines"
          + ' FROM ticket t LEFT JOIN ticket_line l'
          + '   ON l.ticket_id = t.id AND l.void_at IS NULL'
          + " WHERE t.status = 'open' GROUP BY t.id"),
        c.query('SELECT ticket_id, station, stage, target_mins, fired_at FROM kds_ticket'
          + " WHERE served_at IS NULL")
      ]);
      return {
        v: 4, at: Date.now(),
        outlet: outlet.rows[0] || null,
        tax: tax.rows[0] || null,
        items: items.rows,
        tickets: tickets.rows,
        stages: stages.rows
      };
    });
    res.set('cache-control', 'no-store').json(data);
  } catch (e) { next(e); }
});

// ── a guest posts intent; the till decides. The phone never takes money. ────
r.post('/outlet/:outletId/guest/order', sameOutlet, async function (req, res, next) {
  const { table, lines, promo, name, phone, opId } = req.body || {};
  if (!table || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'table and lines required' });
  }
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      if (opId) {
        const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [opId]);
        if (seen.rows.length) return seen.rows[0].result;   // replay, not a new order
      }
      const ins = await c.query(
        'INSERT INTO guest_order (table_no, lines, promo, guest_name, guest_phone)'
        + ' VALUES ($1,$2,$3,$4,$5) RETURNING id, at',
        [String(table), JSON.stringify(lines), promo || null, name || null, phone || null]);
      const result = { id: ins.rows[0].id, at: ins.rows[0].at, status: 'awaiting till' };
      if (opId) {
        await c.query('INSERT INTO op_log (op_id, kind, payload, client_at, result)'
          + " VALUES ($1,'guest_order',$2, now(), $3)",
          [opId, JSON.stringify(req.body), JSON.stringify(result)]);
      }
      await c.query("SELECT chain.log('guest_order','guest_order',$1,NULL,$2)",
        [ins.rows[0].id, JSON.stringify({ table: table, lines: lines.length })]);
      return result;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.post('/outlet/:outletId/guest/request', sameOutlet, async function (req, res, next) {
  const { table, kind, detail } = req.body || {};
  if (!table || !kind) return res.status(400).json({ error: 'table and kind required' });
  try {
    const out = await withOutlet(req.ctx, function (c) {
      return c.query('INSERT INTO guest_request (table_no, kind, detail)'
        + ' VALUES ($1,$2,$3) RETURNING id, at', [String(table), kind, detail || null])
        .then(function (q) { return q.rows[0]; });
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// ── offline replay. Idempotent by construction: the client's own op_id is the
//    primary key, and a closed sale is never reopened by a late arrival.
r.post('/outlet/:outletId/sync/push', sameOutlet, atLeast('till'),
  async function (req, res, next) {
    const ops = (req.body || {}).ops;
    if (!Array.isArray(ops)) return res.status(400).json({ error: 'ops[] required' });
    try {
      const results = await withOutlet(req.ctx, async function (c) {
        const out = [];
        for (const op of ops) {
          if (!op || !op.opId) { out.push({ error: 'opId required' }); continue; }
          const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [op.opId]);
          if (seen.rows.length) { out.push({ opId: op.opId, replay: true, result: seen.rows[0].result }); continue; }
          let result;
          try { result = await apply(c, op, req.ctx); }
          catch (e) { out.push({ opId: op.opId, error: e.message }); continue; }
          await c.query('INSERT INTO op_log (op_id, kind, payload, client_at, device_id, by_staff, result)'
            + ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [op.opId, op.kind, JSON.stringify(op.payload || {}),
             new Date(op.at || Date.now()), req.ctx.deviceId, req.ctx.actor,
             JSON.stringify(result || {})]);
          out.push({ opId: op.opId, result: result });
        }
        return out;
      });
      res.json({ results: results });
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/sync/pull', sameOutlet, atLeast('till'),
  async function (req, res, next) {
    const since = new Date(Number(req.query.since || 0) || 0);
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const [ops, orders, reqs] = await Promise.all([
          c.query('SELECT op_id, kind, result, applied_at FROM op_log'
            + ' WHERE applied_at > $1 ORDER BY applied_at LIMIT 500', [since]),
          c.query('SELECT id, table_no, lines, promo, at FROM guest_order'
            + ' WHERE accepted_at IS NULL AND rejected_reason IS NULL ORDER BY at'),
          c.query('SELECT id, table_no, kind, detail, at FROM guest_request'
            + ' WHERE ack_at IS NULL ORDER BY at')
        ]);
        return { now: Date.now(), ops: ops.rows, guestOrders: orders.rows, guestRequests: reqs.rows };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

// The one cross-outlet read in the system: aggregates only, rank 5 only,
// through a read-only role, and stamped in the audit trail as group scope.
r.get('/estate/day', atLeast('owner'), async function (req, res, next) {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const rows = await withEstate(req.ctx, function (c) {
      return c.query('SELECT * FROM chain.estate_day($1)', [date])
        .then(function (q) { return q.rows; });
    });
    res.json({ date: date, outlets: rows });
  } catch (e) { next(e); }
});

// ── apply one replayed operation ────────────────────────────────────────────
async function apply(c, op, ctx) {
  switch (op.kind) {
    case 'sale': {
      const p = op.payload || {};
      // A closed ticket is never overwritten by a replay: the receipt number
      // is allocated here, on the server, under the series row lock.
      const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['SALE']);
      const sale = await c.query(
        'INSERT INTO sale (receipt_no, ticket_id, business_date, channel, covers,'
        + ' gross, discount, discount_reason, service, tax_code, tax_rate, tax,'
        + ' rounding, total, cogs, member_id, server_name, closed_by, device_id)'
        + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)'
        + ' RETURNING id, receipt_no',
        [no.rows[0].no, p.ticketId || null, p.businessDate, p.channel || 'dine_in',
         p.covers || 1, p.gross, p.discount || 0, p.discountReason || null,
         p.service || 0, p.taxCode, p.taxRate, p.tax, p.rounding || 0, p.total,
         p.cogs || 0, p.memberId || null, p.server || null, ctx.actor, ctx.deviceId]);
      for (const l of (p.lines || [])) {
        await c.query('INSERT INTO sale_line (sale_id, item_id, name, qty,'
          + ' unit_price, line_total, unit_cost, line_cost)'
          + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [sale.rows[0].id, l.itemId, l.name, l.qty, l.price, l.total,
           l.unitCost || 0, l.lineCost || 0]);
      }
      for (const pay of (p.payments || [])) {
        await c.query('INSERT INTO payment (sale_id, method, amount, currency,'
          + ' fx_amount, fx_rate, tendered, change_given, tip, auth_ref, taken_by, device_id)'
          + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [sale.rows[0].id, pay.method, pay.amount, pay.currency || 'MVR',
           pay.fxAmount || null, pay.fxRate || null, pay.tendered || null,
           pay.change || null, pay.tip || 0, pay.ref || null, ctx.actor, ctx.deviceId]);
      }
      // Stock and COGS move at the moment of sale, not in a nightly batch.
      for (const m of (p.stockMoves || [])) {
        await c.query('INSERT INTO stock_move (ingredient_id, qty, unit_cost, value,'
          + " reason, sale_id, by_staff, device_id) VALUES ($1,$2,$3,$4,'sale',$5,$6,$7)",
          [m.ingredientId, -Math.abs(m.qty), m.unitCost, m.value,
           sale.rows[0].id, ctx.actor, ctx.deviceId]);
        await c.query('UPDATE ingredient SET on_hand = on_hand - $2 WHERE id = $1',
          [m.ingredientId, Math.abs(m.qty)]);
      }
      if (p.journal) await postJournal(c, p.journal, ctx, 'sale', sale.rows[0].id);
      if (p.ticketId) {
        await c.query("UPDATE ticket SET status = 'closed', closed_at = now(),"
          + " closed_by = $2 WHERE id = $1 AND status <> 'closed'",
          [p.ticketId, ctx.actor]);
      }
      await c.query("SELECT chain.log('sale','sale',$1,NULL,$2)",
        [sale.rows[0].id, JSON.stringify({ no: sale.rows[0].receipt_no, total: p.total })]);
      return { saleId: sale.rows[0].id, receiptNo: sale.rows[0].receipt_no };
    }
    case 'journal':
      return { journalId: await postJournal(c, op.payload, ctx, op.payload.source || 'manual', null) };
    case 'stock_count': {
      const p = op.payload || {};
      const h = await c.query('INSERT INTO stock_count (by_staff, categories, variance_value)'
        + ' VALUES ($1,$2,$3) RETURNING id', [ctx.actor, p.categories || [], p.varianceValue || 0]);
      for (const l of (p.lines || [])) {
        await c.query('INSERT INTO count_line (count_id, ingredient_id, expected,'
          + ' counted, variance, value) VALUES ($1,$2,$3,$4,$5,$6)',
          [h.rows[0].id, l.ingredientId, l.expected, l.counted, l.variance, l.value]);
        await c.query('UPDATE ingredient SET on_hand = $2 WHERE id = $1',
          [l.ingredientId, l.counted]);
      }
      return { countId: h.rows[0].id };
    }
    case 'guest_order_accept': {
      const p = op.payload || {};
      await c.query('UPDATE guest_order SET accepted_at = now(), accepted_by = $2,'
        + ' ticket_id = $3 WHERE id = $1 AND accepted_at IS NULL',
        [p.id, ctx.actor, p.ticketId || null]);
      return { id: p.id, accepted: true };
    }
    default:
      throw new Error('unknown op kind: ' + op.kind);
  }
}

async function postJournal(c, j, ctx, source, sourceId) {
  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
  const h = await c.query('INSERT INTO journal (jv_no, entry_date, memo, source,'
    + ' source_id, posted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [no.rows[0].no, j.date, j.memo, source, sourceId, ctx.actor]);
  for (const l of (j.lines || [])) {
    await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr)'
      + ' VALUES ($1,$2,$3,$4)', [h.rows[0].id, l.account, l.dr || 0, l.cr || 0]);
  }
  return h.rows[0].id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

module.exports = r;
