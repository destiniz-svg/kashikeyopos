'use strict';
/* Delivery & QR — 02-POS-SPEC.md §2 (`delivery`): "Aggregator and QR channel
 * orders, rider dispatch, stage tracking." §15: "accept, reject, dispatch,
 * track."
 *
 * ACCEPTING IS THE MISSING LINK, and it was missing in the most convincing way
 * possible. The accept operation stamped `accepted_at` and took a ticket id it
 * was never given, because nothing in the system ever created one: a guest's
 * round arrived as jsonb, was marked accepted, and stopped there. The kitchen
 * never saw the food. The guest's tracker could never follow it — its own code
 * matched the stage with `find(() => false)`, a predicate that cannot be true,
 * left as a placeholder for this. Every part of that chain looked built.
 *
 * So `accept()` does the thing the whole feature is for: it turns the lines
 * into a real ticket through kitchen.sendRound — THE SAME function a waiter's
 * terminal calls — so the round is priced from the item master, routed to the
 * right station, and lands on the pass. A second implementation here would be
 * a second answer to "what did they order".
 *
 * A REJECTION IS AN ANSWER. "We have run out of that" is something a guest can
 * act on; a row that quietly stays pending for ever is not. It carries a reason
 * and a time, and the guest's own phone reads it back.
 *
 * WHERE IT GOES IS THE ONLY THING THAT DIFFERS. A QR order goes to its table; a
 * delivery goes to the Delivery slot the floor already draws and then to a
 * rider. One object, one accept path, one place that branches.
 */

const { tableName } = require('./tables');

const money = (n) => Math.round(Number(n) * 100) / 100;

const CHANNELS = ['dine_in', 'takeaway', 'delivery'];
const SOURCES = ['qr', 'phone', 'aggregator'];

/* Where an accepted order's ticket lives. The floor draws Takeaway and
   Delivery as slots beside the tables (§3.2's "two non-table slots always
   exist"), so a channel order goes to the slot it belongs to and a QR order
   goes to the table the guest is sitting at. */
function slotFor(o) {
  if (o.channel === 'delivery') return 'Delivery';
  if (o.channel === 'takeaway') return 'Takeaway';
  /* Spelled the way the floor spells it. A round accepted for `5` used to open
     a ticket the cashier's own T05 tile could not open. */
  return tableName(o.table_no);
}

/** How far along it is — one word, derived, never stored twice. */
function stageOf(o) {
  if (o.rejected_at) return 'rejected';
  if (o.delivered_at) return 'delivered';
  if (o.dispatched_at) return 'with the rider';
  if (o.accepted_at) return 'in the kitchen';
  return 'waiting for the till';
}

function shape(o) {
  const lines = Array.isArray(o.lines) ? o.lines : [];
  return {
    id: o.id, at: o.at, channel: o.channel, source: o.source,
    tableNo: o.table_no, address: o.address, extRef: o.ext_ref,
    name: o.guest_name, phone: o.guest_phone, promo: o.promo,
    fee: money(o.fee || 0),
    lines: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), note: l.note || null })),
    items: lines.reduce((s, l) => s + Number(l.qty || 0), 0),
    ticketId: o.ticket_id,
    acceptedAt: o.accepted_at, rejectedAt: o.rejected_at,
    rejectedReason: o.rejected_reason,
    rider: o.rider, dispatchedAt: o.dispatched_at, deliveredAt: o.delivered_at,
    stage: stageOf(o),
    /* How long it has been sitting there. The number that decides whether a
       guest is about to walk out, and the only one a busy floor reads. */
    waitingMins: o.accepted_at || o.rejected_at ? null
      : Math.max(0, Math.round((Date.now() - new Date(o.at).getTime()) / 60000)),
  };
}

/* ── the board ───────────────────────────────────────────────────────────── */

async function board(c) {
  /* The ticket comes along because it is what ENDS a dine-in order. A delivery
     finishes when the rider says so; a round sent to table 4 has no such
     moment, so without this it sat under "being cooked" for two days and every
     accepted round of the evening piled up under it. A board nobody can read is
     a board nobody reads — the party paying and leaving is the end of their
     order, and that is the ticket closing. */
  const q = await c.query(
    'SELECT g.*, t.status AS ticket_status FROM guest_order g'
    + ' LEFT JOIN ticket t ON t.id = g.ticket_id'
    + " WHERE g.at > now() - interval '2 days'"
    + ' ORDER BY g.at DESC LIMIT 300');
  const all = q.rows.map((r) => ({ ...shape(r), settled: !!r.ticket_status && r.ticket_status !== 'open' }));

  const waiting = all.filter((o) => !o.acceptedAt && !o.rejectedAt);
  const riding = all.filter((o) => o.dispatchedAt && !o.deliveredAt);
  const kitchen = all.filter((o) =>
    o.acceptedAt && !o.deliveredAt && !o.dispatchedAt && !o.settled);

  return {
    waiting, kitchen, riding,
    done: all.filter((o) => o.deliveredAt || o.rejectedAt).slice(0, 60),
    totals: {
      waiting: waiting.length,
      /* The oldest thing nobody has answered. A count of five says nothing;
         "the oldest has been there eleven minutes" is the decision. */
      oldestWait: waiting.reduce((m, o) => Math.max(m, o.waitingMins || 0), 0),
      riding: riding.length,
    },
  };
}

/* ── an order the till did not take ──────────────────────────────────────── */

/**
 * A delivery or telephone order typed at the till, or pushed by an aggregator.
 * It lands in the SAME table a QR order does and goes through the same accept
 * path, because the difference between them is where the food goes and nothing
 * else.
 */
async function take(c, p, ctx) {
  const channel = CHANNELS.includes(p.channel) ? p.channel : 'delivery';
  const source = SOURCES.includes(p.source) ? p.source : 'phone';
  if (!Array.isArray(p.lines) || !p.lines.length) {
    throw Object.assign(new Error('an order needs at least one line'), { status: 400 });
  }
  if (channel === 'delivery' && !String(p.address || '').trim()) {
    /* A delivery with no address is a thing nobody can deliver, and the moment
       to discover that is while the customer is still on the telephone. */
    throw Object.assign(new Error('where is it going?'), { status: 400 });
  }
  const lines = p.lines.map((l) => ({
    itemId: String(l.itemId), qty: Number(l.qty), note: l.note || null,
  }));
  for (const l of lines) {
    if (!(l.qty > 0)) {
      throw Object.assign(new Error('a line quantity must be positive'), { status: 400 });
    }
  }

  const q = await c.query(
    'INSERT INTO guest_order (table_no, lines, channel, source, ext_ref, address,'
    + ' fee, guest_name, guest_phone, promo)'
    + ' VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [slotFor({ channel, table_no: p.tableNo || 'Delivery' }), JSON.stringify(lines),
      channel, source, p.extRef || null,
      p.address ? String(p.address).slice(0, 300) : null,
      p.fee ? Number(p.fee).toFixed(2) : 0,
      p.name ? String(p.name).slice(0, 80) : null,
      p.phone ? String(p.phone).slice(0, 30) : null, p.promo || null]);

  await c.query("SELECT chain.log('order_take','guest_order',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ channel, source, lines: lines.length })]);
  return shape(q.rows[0]);
}

/* ── accept, and MEAN it ─────────────────────────────────────────────────── */

/**
 * Turn the order into a ticket and fire it at the kitchen.
 *
 * `sendRound` is the same function a waiter's terminal calls, which is the
 * whole point: the round is priced from the item master, routed to its
 * station, and appears on the pass exactly as any other round does.
 */
async function accept(c, id, p, ctx, kitchen) {
  const q = await c.query('SELECT * FROM guest_order WHERE id = $1 FOR UPDATE', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such order'), { status: 404 });
  const o = q.rows[0];
  if (o.rejected_at) {
    throw Object.assign(new Error('that one was already turned down'), { status: 409 });
  }
  if (o.accepted_at) {
    /* Idempotent rather than an error: a till that lost its connection between
       the update and the reply will press again, and a party's food must not
       be cooked twice for it. */
    return { ...shape(o), already: true };
  }

  const lines = Array.isArray(o.lines) ? o.lines : [];
  if (!lines.length) {
    throw Object.assign(new Error('that order has no lines'), { status: 409 });
  }

  const fired = await kitchen.sendRound(c, {
    table: slotFor(o),
    lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, note: l.note })),
    covers: o.channel === 'dine_in' ? undefined : 1,
    server: o.guest_name || null,
  }, ctx);

  const up = await c.query(
    'UPDATE guest_order SET accepted_at = now(), accepted_by = $2, ticket_id = $3'
    + ' WHERE id = $1 RETURNING *', [id, ctx.actor, fired.ticketId]);

  await c.query("SELECT chain.log('order_accept','guest_order',$1,NULL,$2)",
    [id, JSON.stringify({ ticketId: fired.ticketId, table: slotFor(o) })]);

  return {
    ...shape(up.rows[0]),
    message: 'On the pass at ' + slotFor(o) + '. The kitchen has it.',
  };
}

/** Turned down, with a reason the guest can act on. */
async function reject(c, id, p, ctx) {
  const why = String(p.reason || '').trim().slice(0, 200);
  if (why.length < 3) {
    /* "No" on its own leaves a guest staring at a phone with nothing to do
       next. Out of stock, too late, cannot deliver there — each is a different
       thing to say. */
    throw Object.assign(new Error('say why, so the guest knows what to do'), { status: 400 });
  }
  const q = await c.query(
    'UPDATE guest_order SET rejected_at = now(), rejected_by = $2, rejected_reason = $3'
    + ' WHERE id = $1 AND accepted_at IS NULL AND rejected_at IS NULL RETURNING *',
    [id, ctx.actor, why]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only an order still waiting can be turned down'),
      { status: 409 });
  }
  await c.query("SELECT chain.log('order_reject','guest_order',$1,NULL,$2)",
    [id, JSON.stringify({ reason: why })]);
  return shape(q.rows[0]);
}

/* ── the rider leg ───────────────────────────────────────────────────────── */

async function dispatch(c, id, p, ctx) {
  const rider = String(p.rider || '').trim().slice(0, 80);
  if (!rider) {
    throw Object.assign(new Error('who is taking it?'), { status: 400 });
  }
  const q = await c.query(
    'UPDATE guest_order SET rider = $2, dispatched_at = now()'
    + " WHERE id = $1 AND accepted_at IS NOT NULL AND dispatched_at IS NULL"
    + "   AND channel = 'delivery' RETURNING *", [id, rider]);
  if (!q.rows.length) {
    throw Object.assign(new Error(
      'only an accepted delivery that has not left can be dispatched'), { status: 409 });
  }
  await c.query("SELECT chain.log('order_dispatch','guest_order',$1,NULL,$2)",
    [id, JSON.stringify({ rider })]);
  return shape(q.rows[0]);
}

async function delivered(c, id, p, ctx) {
  const q = await c.query(
    'UPDATE guest_order SET delivered_at = now()'
    + ' WHERE id = $1 AND dispatched_at IS NOT NULL AND delivered_at IS NULL RETURNING *',
    [id]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only an order with a rider can arrive'), { status: 409 });
  }
  await c.query("SELECT chain.log('order_delivered','guest_order',$1,NULL,NULL)", [id]);
  return shape(q.rows[0]);
}

/* ── what the guest's own phone may see ──────────────────────────────────── */

/**
 * One table's orders, for the guest sitting at it. This is what lets the
 * tracker stop guessing: it can see that the till accepted the round, which
 * ticket it became — so the stages in the same snapshot match — and, if it was
 * turned down, why.
 */
async function forTable(c, tableNo) {
  /* THIS PARTY'S ORDERS, not this table's day.
   *
   * A table turns over several times an evening, and the phone of whoever is
   * sitting there now must not read back what the last party ordered. The
   * boundary is the ticket: an accepted round belongs to the party whose ticket
   * it went on, so once that ticket is settled the round leaves with them. A
   * round with no ticket is either still waiting or was turned down, and those
   * are only anybody's business while they are fresh. */
  const q = await c.query(
    'SELECT g.* FROM guest_order g LEFT JOIN ticket t ON t.id = g.ticket_id'
    + ' WHERE g.table_no = $1'
    + "   AND (CASE WHEN g.ticket_id IS NULL THEN g.at > now() - interval '3 hours'"
    + "             ELSE t.status = 'open' END)"
    + ' ORDER BY g.at', [String(tableNo)]);
  return q.rows.map((o) => {
    const s = shape(o);
    /* A guest is shown their own order and its fate, and nothing about the
       till: who accepted it, which staff id turned it down and when the shift
       started are not theirs. */
    return {
      id: s.id, at: s.at, stage: s.stage, ticketId: s.ticketId,
      items: s.items, rejectedReason: s.rejectedReason,
      rider: s.rider, deliveredAt: s.deliveredAt,
    };
  });
}

module.exports = {
  board, take, accept, reject, dispatch, delivered, forTable, stageOf, slotFor,
};
