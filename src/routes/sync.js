'use strict';
const express = require('express');
const { withOutlet, withOutletRead } = require('../db');
const { sameOutlet, atLeast } = require('../auth');
const { applyOp } = require('../apply');

const r = express.Router({ mergeParams: true });

/* ═══ PUSH ══════════════════════════════════════════════════════════════════
   The outbox arrives in Lamport order and is applied in that order. Each op
   is its own savepoint: one bad op does not roll back the sale in front of it,
   and it stays in the client's outbox where an operator can see it rather than
   disappearing.
   ═══════════════════════════════════════════════════════════════════════ */
r.post('/push', sameOutlet, atLeast('kitchen'), async function (req, res, next) {
  const ops = (req.body || {}).ops;
  if (!Array.isArray(ops)) return res.status(400).json({ error: 'ops[] required' });
  if (ops.length > 200) return res.status(413).json({ error: 'send at most 200 ops per push' });
  try {
    const results = await withOutlet(req.ctx, async function (c) {
      const out = [];
      let n = 0;
      for (const op of ops.slice().sort((a, b) => (a.lamport || 0) - (b.lamport || 0))) {
        if (!op || !op.opId) { out.push({ error: 'opId required' }); continue; }
        if (!op.kind) { out.push({ opId: op.opId, error: 'kind required' }); continue; }

        const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [op.opId]);
        if (seen.rows.length) {
          // Replay, not a new sale. This is the whole reason the client
          // generates the id before it touches the network.
          out.push({ opId: op.opId, replay: true, result: seen.rows[0].result });
          continue;
        }

        const sp = 'op_' + (++n);
        await c.query('SAVEPOINT ' + sp);
        let result;
        try {
          result = await applyOp(c, op, req.ctx);
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT ' + sp);
          out.push({ opId: op.opId, error: e.message });
          continue;
        }
        await c.query('INSERT INTO op_log (op_id, kind, label, entity, payload,'
          + ' client_at, lamport, device_id, by_staff, result)'
          + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [op.opId, op.kind, op.label || null, op.entity || null,
          JSON.stringify(op.payload || {}),
          new Date(op.at || Date.now()), Number(op.lamport) || 0,
          req.ctx.deviceId, req.ctx.actor, JSON.stringify(result || {})]);
        await c.query('RELEASE SAVEPOINT ' + sp);
        out.push({ opId: op.opId, result: result });
      }
      return out;
    });
    res.json({ results, at: Date.now() });
  } catch (e) { next(e); }
});

/* ═══ PULL ══════════════════════════════════════════════════════════════════
   What has happened since this device last looked: applied ops (so it can
   settle its own outbox), guest orders and requests waiting on the till, and
   the kitchen board. The full state comes from /bootstrap; this is the tick.
   ═══════════════════════════════════════════════════════════════════════ */
r.get('/pull', sameOutlet, atLeast('kitchen'), async function (req, res, next) {
  const since = new Date(Number(req.query.since || 0) || 0);
  try {
    const out = await withOutletRead(req.ctx, async function (c) {
      const [ops, orders, reqs, kds, tickets] = await Promise.all([
        c.query('SELECT op_id, kind, label, entity, result, applied_at, lamport'
          + ' FROM op_log WHERE applied_at > $1 ORDER BY applied_at LIMIT 500', [since]),
        c.query('SELECT id, table_no, lines, promo, guest_name, guest_phone, note, at'
          + ' FROM guest_order WHERE accepted_at IS NULL AND rejected_reason IS NULL'
          + ' ORDER BY at'),
        c.query('SELECT id, table_no, kind, detail, at FROM guest_request'
          + ' WHERE ack_at IS NULL ORDER BY at'),
        c.query('SELECT id, ticket_id, station, stage, course, fired_at, ready_at,'
          + ' target_mins FROM kds_ticket WHERE served_at IS NULL ORDER BY fired_at'),
        c.query("SELECT id, table_no, split, status, covers, party, server_name,"
          + " opened_at FROM ticket WHERE status IN ('open','held') ORDER BY opened_at")
      ]);
      return {
        now: Date.now(),
        ops: ops.rows, guestOrders: orders.rows, guestRequests: reqs.rows,
        kds: kds.rows, tickets: tickets.rows
      };
    });
    res.set('cache-control', 'no-store').json(out);
  } catch (e) { next(e); }
});

module.exports = r;
