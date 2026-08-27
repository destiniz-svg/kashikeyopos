'use strict';
const express = require('express');
const { withOutlet, withOutletRead } = require('../db');
const { sameOutlet, atLeast } = require('../auth');
const { applyOp } = require('../apply');
const { all, buildLive } = require('../bootstrap');

const r = express.Router({ mergeParams: true });

/* ═══ PUSH ══════════════════════════════════════════════════════════════════
   The outbox arrives in Lamport order and is applied in that order. Each op
   is its own savepoint: one bad op does not roll back the sale in front of it,
   and it stays in the client's outbox where an operator can see it rather than
   disappearing.

   AND THE WHOLE BATCH IS NOT ONE TRANSACTION. It was, and that is where the
   only error in the entire load campaign came from. A till that has been
   offline does not push one bill at a time — it drains, and the evening
   arrives at once. At 80 ops a batch with eight outboxes draining together,
   one transaction held a pooled connection for up to 16.9 s: past the 8 s
   checkout bound the other seven were waiting on, and inside touching
   distance of the 15 s statement timeout. One request in ~4,000 failed. No
   money defect — that run balanced every journal and produced no duplicates —
   but the ceiling is real and it scales with how long a device was dark.

   So the batch is sorted ONCE, whole, and then applied in bounded chunks,
   each its own transaction. The connection goes back to the pool between
   them, so a long drain queues behind itself rather than starving every other
   till in the shop. Three things make that safe, and all three were already
   true: op_log is keyed by opId with ON CONFLICT DO NOTHING, so a chunk that
   committed before a later one failed replays as a no-op rather than a
   double; each op was ALREADY its own savepoint, so per-batch atomicity was
   never what the guarantee rested on; and the sort happens before the split,
   so chunk two can only ever carry ops that come after chunk one.

   The cap stays at 200. Lowering it would 413 every terminal in the field
   still slicing 100, and an op that cannot be delivered is not safer than one
   applied in two transactions.
   ═══════════════════════════════════════════════════════════════════════ */
const CHUNK = 25;

r.post('/push', sameOutlet, atLeast('kitchen'), async function (req, res, next) {
  const ops = (req.body || {}).ops;
  if (!Array.isArray(ops)) return res.status(400).json({ error: 'ops[] required' });
  if (ops.length > 200) return res.status(413).json({ error: 'send at most 200 ops per push' });
  try {
    /* Lamport first, then the position the device sent them in — because a
       device that has not yet been raised by a poll can send several ops
       carrying the same number (an outbox that has never been polled numbers
       from its own high-water mark, and a batch of unstamped ops carries
       zero), and Array.prototype.sort is not required to be stable about
       what it then does with them. The batch's own order is the only
       tiebreak that MEANS anything: it is the order the operator did the
       work in. Open the ticket, add the line, fire the course — sorted by
       anything else, the line is added to a ticket that does not exist.

       Sorted here, over the WHOLE batch, before it is split. */
    const ordered = ops.map((op, i) => ({ op, i })).sort((a, b) =>
      ((a.op && a.op.lamport) || 0) - ((b.op && b.op.lamport) || 0) || a.i - b.i);

    const chunks = [];
    for (let i = 0; i < ordered.length; i += CHUNK) chunks.push(ordered.slice(i, i + CHUNK));
    // An empty push still proves the device reached its outlet, so it still
    // gets a transaction — one that does nothing but stamp it.
    if (!chunks.length) chunks.push([]);

    /* Spans the whole push, not one chunk: the same op arriving twice in one
       delivery is a duplicate whichever chunks it lands in. */
    const inThisBatch = new Set();
    const results = [];
    let n = 0;

    for (let ci = 0; ci < chunks.length; ci++) {
      const part = await withOutlet(req.ctx, async function (c) {
      const out = [];
      for (const { op } of chunks[ci]) {
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
          out.push({ opId: op.opId, error: opSays(e) });
          continue;
        }
        await c.query('RELEASE SAVEPOINT ' + sp);
        out.push({ opId: op.opId, result: result });
      }
      /* The delivery itself is worth recording, whatever was in it — even a
         batch of pure replays proves the device can reach its outlet. This is
         what lets any OTHER screen answer "which till has not delivered in an
         hour", which matters precisely when that till cannot be asked.

         On the LAST chunk, so a long drain is stamped when its work is
         actually done rather than when it started. */
      if (req.ctx.deviceId && ci === chunks.length - 1) {
        /* The build this terminal is running, reported where it is already
           identifying itself (036). A push is the one moment the device is
           certainly the device; asking it anywhere else would be a second
           protocol for one fact. `coalesce` so a build that does not send it
           leaves the last answer standing rather than erasing it. */
        const ver = String(req.get('x-app-version') || '').slice(0, 32) || null;
        await c.query('UPDATE chain.device SET last_seen = now(), last_push_at = now(),'
          + ' app_version = coalesce($3, app_version)'
          + ' WHERE id = $1 AND outlet_id = $2',
          [req.ctx.deviceId, req.ctx.outletId, ver]);
      }
        return out;
      });
      results.push(...part);
    }
    res.json({ results, at: Date.now() });
  } catch (e) { next(e); }
});

/* ── A REFUSAL IS READ BY A PERSON ────────────────────────────────────────
   A parked op is what an operator opens when the till says a dish will not
   save, so `e.message` going straight through is the same defect the handle
   route already fixed one level up: an internal constraint name and a table
   name handed to whoever asked, saying nothing anybody can act on. Reported
   from a live store, verbatim off the Sync screen:

     Dish created · NESCAFE MILK at MVR 20 — insert or update on table "item"
     violates foreign key constraint "item_category_id_fkey"

   Everything an operator needs is in that sentence and none of it is legible:
   the dish is in a menu SECTION the outlet has no row for. Same rule as
   `checkSays()` — a named constraint is Postgres phrasing it, so it is
   translated by name; anything a trigger or a function RAISEd was written for
   a person and is repeated exactly as written. */
const CONSTRAINT_SAYS = {
  item_category_id_fkey: 'This dish is in a menu section the outlet has no'
    + ' record of. The section has to reach the outlet before a dish can be'
    + ' saved into it — open Menu, open the section, and save it.',
  recipe_line_sub_item_id_fkey: 'This recipe draws on a batch the outlet has no'
    + ' record of. Save the batch first, then the recipe.',
  recipe_line_ingredient_id_fkey: 'This recipe names an item the outlet has no'
    + ' record of. Save it in the item master first.',
  ticket_line_ticket_id_fkey: 'This line belongs to a bill the outlet has no'
    + ' record of — the bill it was added to never arrived.'
};
function opSays(e) {
  if (!e) return 'the outlet refused this without saying why';
  // 23503 foreign key, 23505 unique, 23514 check. Only a NAMED constraint is
  // Postgres's own phrasing; a RAISE carries a sentence somebody composed.
  if (e.constraint && CONSTRAINT_SAYS[e.constraint]) return CONSTRAINT_SAYS[e.constraint];
  if (e.constraint && (e.code === '23503' || e.code === '23505' || e.code === '23514')) {
    return 'The outlet refused this — it depends on a record the outlet does'
      + ' not have, or one it already has under another name.';
  }
  return e.message;
}

/* ═══ PULL ══════════════════════════════════════════════════════════════════
   What has happened since this device last looked: applied ops (so it can
   settle its own outbox), guest orders and requests waiting on the till, and
   the kitchen board. The full state comes from /bootstrap; this is the tick.
   ═══════════════════════════════════════════════════════════════════════ */
/* ONE CLOCK, AND A WINDOW THAT OVERLAPS ITSELF.

   `since` is a stamp this route issued and the device sent back. It is
   compared against `applied_at` and `sale.at`, which are the DATABASE's
   clock — so it has to BE the database's clock, or a few hundred
   milliseconds of skew between the app process and Postgres silently drops
   whatever landed in the gap, for ever, with nothing on any screen to say a
   bill went missing.

   And one clock is still not enough: `now()` in Postgres is the TRANSACTION's
   start time, so a sale whose transaction opened before this stamp and
   committed after it carries an `at` this window has already passed. The
   window therefore reaches back a few seconds every time. It costs a handful
   of rows re-sent to a device that already has them, and the client merges by
   id, so a row delivered twice is the same row. */
const PULL_OVERLAP_MS = 5000;

r.get('/pull', sameOutlet, atLeast('kitchen'), async function (req, res, next) {
  const asked = Number(req.query.since || 0) || 0;
  const since = new Date(asked ? Math.max(0, asked - PULL_OVERLAP_MS) : 0);
  try {
    const out = await withOutletRead(req.ctx, async function (c) {
      const q = await all(c, {
        // The stamp the device will send back, read off the clock the
        // predicates above are compared against.
        now: ['SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS ms'],
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
        now: Number(q.now.rows[0].ms),
        ops: ops.rows, guestOrders: orders.rows, guestRequests: reqs.rows,
        kds: kds.rows, tickets: tickets.rows
      };
    });
    /* THE FLOOR THIS POLL EXISTS TO SHARE, in the shape the terminal already
       merges. The rows above are headers — a ticket with no lines — which was
       enough when nothing read them and is not enough now: a bill rendered
       from a header is a bill that looks empty. `buildLive()` carries the
       whole slice, through the bootstrap's own row shapes, and the client
       feeds it to the one merge path rather than growing a second.

       A read that fails does not fail the poll. The ops half is what keeps a
       device's clock moving and what tells it to re-read; losing the slice for
       one tick costs five seconds, and answering 500 would stop the loop. */
    try {
      out.state = await buildLive(req.ctx, { since: since });
    } catch (e) {
      out.state = null;
      out.stateError = 'the live slice could not be read';
    }
    res.set('cache-control', 'no-store').json(out);
  } catch (e) { next(e); }
});

module.exports = r;
