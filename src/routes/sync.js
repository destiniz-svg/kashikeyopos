'use strict';
const express = require('express');
const { withOutlet, withOutletRead } = require('../db');
const { sameOutlet, atLeast } = require('../auth');
const { applyOp } = require('../apply');
const { all } = require('../bootstrap');

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
      const inThisBatch = new Set();
      let n = 0;
      /* Lamport first, then the position the device sent them in — because a
         device that has not yet been raised by a poll can send several ops
         carrying the same number (an outbox that has never been polled numbers
         from its own high-water mark, and a batch of unstamped ops carries
         zero), and Array.prototype.sort is not required to be stable about
         what it then does with them. The batch's own order is the only
         tiebreak that MEANS anything: it is the order the operator did the
         work in. Open the ticket, add the line, fire the course — sorted by
         anything else, the line is added to a ticket that does not exist. */
      const ordered = ops.map((op, i) => ({ op, i })).sort((a, b) =>
        ((a.op && a.op.lamport) || 0) - ((b.op && b.op.lamport) || 0) || a.i - b.i);
      for (const { op } of ordered) {
        if (!op || !op.opId) { out.push({ error: 'opId required' }); continue; }
        if (!op.kind) { out.push({ opId: op.opId, error: 'kind required' }); continue; }

        // The same op can arrive twice in ONE push — an outbox drained by two
        // overlapping flushes, a retry that raced its own response. Idempotent
        // means idempotent, not "idempotent across requests".
        if (inThisBatch.has(op.opId)) {
          out.push({ opId: op.opId, replay: true });
          continue;
        }
        inThisBatch.add(op.opId);

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
          /* ── the containment ─────────────────────────────────────────────
             The journal-balance check is a DEFERRED constraint trigger, and a
             deferred trigger does not fire at savepoint release — it fires at
             the batch's final COMMIT, where no savepoint can catch it. Left
             alone, one unbalanced journal from one op would abort the whole
             batch there: the client sees a 500, keeps everything queued, and
             retries the same poison every five seconds for the life of the
             device. One bad op must never brick a till.

             So the deferral is collapsed PER OP: run the op with checks
             deferred (a journal is written header-then-lines, momentarily
             unbalanced by construction), then force everything pending to
             fire HERE, while this savepoint can still contain the failure.
             ROLLBACK TO a savepoint also reverts the constraint mode, which
             is why DEFERRED is restored explicitly at the top of every op. */
          await c.query('SET CONSTRAINTS ALL DEFERRED');
          result = await applyOp(c, op, req.ctx);
          // Inside the savepoint, so a duplicate that slipped past both checks
          // rolls back its own work rather than taking the batch with it. A
          // conflict here IS a replay — say so, and keep the stored result.
          const ins = await c.query(
            'INSERT INTO op_log (op_id, kind, label, entity, payload,'
            + ' client_at, lamport, device_id, by_staff, result)'
            + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'
            + ' ON CONFLICT (op_id) DO NOTHING RETURNING op_id',
            [op.opId, op.kind, op.label || null, op.entity || null,
              JSON.stringify(op.payload || {}),
              new Date(op.at || Date.now()), Number(op.lamport) || 0,
              req.ctx.deviceId, req.ctx.actor, JSON.stringify(result || {})]);
          if (!ins.rows.length) {
            await c.query('ROLLBACK TO SAVEPOINT ' + sp);
            const prev = await c.query('SELECT result FROM op_log WHERE op_id = $1', [op.opId]);
            out.push({ opId: op.opId, replay: true, result: prev.rows[0] && prev.rows[0].result });
            continue;
          }
          // Fire every check this op deferred, inside its own savepoint.
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT ' + sp);
          out.push({ opId: op.opId, error: e.message });
          continue;
        }
        await c.query('RELEASE SAVEPOINT ' + sp);
        out.push({ opId: op.opId, result: result });
      }
      /* The delivery itself is worth recording, whatever was in it — even a
         batch of pure replays proves the device can reach its outlet. This is
         what lets any OTHER screen answer "which till has not delivered in an
         hour", which matters precisely when that till cannot be asked. */
      if (req.ctx.deviceId) {
        await c.query('UPDATE chain.device SET last_seen = now(), last_push_at = now()'
          + ' WHERE id = $1 AND outlet_id = $2', [req.ctx.deviceId, req.ctx.outletId]);
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
      const q = await all(c, {
        ops: ['SELECT op_id, kind, label, entity, result, applied_at, lamport'
          + ' FROM op_log WHERE applied_at > $1 ORDER BY applied_at LIMIT 500', [since]],
        orders: ['SELECT id, table_no, lines, promo, guest_name, guest_phone, note, at'
          + ' FROM guest_order WHERE accepted_at IS NULL AND rejected_reason IS NULL'
          + ' ORDER BY at'],
        reqs: ['SELECT id, table_no, kind, detail, at FROM guest_request'
          + ' WHERE ack_at IS NULL ORDER BY at'],
        kds: ['SELECT id, ticket_id, station, stage, course, fired_at, ready_at,'
          + ' target_mins FROM kds_ticket WHERE served_at IS NULL ORDER BY fired_at'],
        tickets: ["SELECT id, table_no, split, status, covers, party, server_name,"
          + " opened_at FROM ticket WHERE status IN ('open','held') ORDER BY opened_at"],
      });
      const ops = q.ops;
      const orders = q.orders;
      const reqs = q.reqs;
      const kds = q.kds;
      const tickets = q.tickets;

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
