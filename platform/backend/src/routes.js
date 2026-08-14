'use strict';
const express = require('express');
const { withOutlet, withEstate } = require('./db');
const { sign, pinMatches, pinLookup } = require('./secrets');
const { session, sameOutlet, atLeast } = require('./auth');
const { settle } = require('./sale');

const r = express.Router();
const LOCK_TRIES = 5, LOCK_MINS = 15;

// ── sign in with a PIN, at one outlet, on one device ────────────────────────
r.post('/auth/pin', async function (req, res, next) {
  const { outletId, pin, deviceId } = req.body || {};
  if (!outletId || !pin) return res.status(400).json({ error: 'outletId and pin required' });
  // Bound the input before it reaches a KDF: a PIN is a short numeric string,
  // and accepting a megabyte of it is a free way to make the server work.
  if (!/^[0-9]{4,12}$/.test(String(pin))) {
    return res.status(401).json({ error: 'PIN not recognised' });
  }
  try {
    const out = await withOutlet({ outletId: Number(outletId), rank: 0 }, async function (c) {
      /* Narrow to the one or two staff who could hold this PIN, then scrypt
         only those — instead of a KDF pass per member of staff, which an
         unauthenticated caller could trigger at will. The counters and the
         session row go through SECURITY DEFINER functions because at this
         point in the request there is no rank yet, and every policy on
         chain.staff resolves against one. See migration 007. */
      const lookup = pinLookup(Number(outletId), pin);
      const q = await c.query('SELECT * FROM chain.pin_candidates($1,$2)',
        [Number(outletId), lookup]);
      const now = Date.now();
      for (const s of q.rows) {
        if (s.locked_until && new Date(s.locked_until).getTime() > now) continue;
        let ok = false;
        try { ok = pinMatches(pin, s.pin_hash, s.pin_salt); } catch (e) { ok = false; }
        if (!ok) continue;
        await c.query('SELECT chain.note_pin_attempt($1,$2,true,$3,$4)',
          [Number(outletId), s.id, LOCK_TRIES, LOCK_MINS]);
        const ttlHours = Number(process.env.SESSION_TTL_HOURS || 12);
        const sess = await c.query('SELECT chain.open_session($1,$2,$3,$4,$5) AS id',
          [s.id, Number(outletId), deviceId || null, s.rank, ttlHours]);
        await c.query('SELECT chain.log_signin($1,$2,true)', [Number(outletId), s.id]);
        return {
          token: sign({ o: Number(outletId), r: s.rank, s: s.id,
                        d: deviceId || null, sid: sess.rows[0].id,
                        exp: now + ttlHours * 3600e3 }),
          name: s.name, rank: s.rank, outletId: Number(outletId)
        };
      }
      /* Wrong PIN: count the attempt against every unlocked account at this
         outlet. With PIN-only sign-in the attacker never names an account, so
         a per-account counter would let them walk the whole space while no
         single counter ever climbed. */
      await c.query('SELECT chain.note_pin_attempt($1,NULL,false,$2,$3)',
        [Number(outletId), LOCK_TRIES, LOCK_MINS]);
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
      /* Everything financial is derived server-side — see src/sale.js for why
         the payload's own gross/tax/total/journal are not trusted. The outlet
         row carries the service charge and the cash-rounding increment, and it
         is read HERE rather than passed in, so a replay arriving days later is
         priced by the outlet's configuration and not by the client's memory
         of it. */
      const outlet = await c.query(
        'SELECT service_pct, cash_round_laari FROM chain.outlet WHERE id = $1',
        [ctx.outletId]);
      if (!outlet.rows.length) throw new Error('outlet not found');
      return await settle(c, op.payload || {}, ctx, outlet.rows[0]);
    }
    case 'journal':
      /* A hand-posted journal is a Manager-and-above act with its own audit
         entry, not something a till replays. Rank is checked here as well as on
         the route because /sync/push admits everything at till rank and the
         ops inside it are not all the same weight. */
      if ((ctx.rank || 0) < 3) {
        throw Object.assign(new Error('a manual journal needs manager rank'), { status: 403 });
      }
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
