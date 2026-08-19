'use strict';
const { tableName } = require('./tables');
/* Sending a round to the kitchen, and moving it along the pass.
 *
 * 02-POS-SPEC.md §4. Two operations, both idempotent through op_log because
 * both arrive over the same offline replay path a sale does.
 *
 * WHY A ROUND IS NOT A SALE. A guest orders, eats, and pays — in that order,
 * an hour apart. The kitchen needs the food now and the ledger needs nothing
 * until money moves. So `ticket_send` writes a ticket and its lines and fires
 * the kitchen; it touches no account, allocates no receipt number and costs
 * nothing. Coupling the two is how a kitchen ends up waiting for a card machine.
 *
 * §37 of the brief says the same thing from the other side: "Do not couple
 * kitchen display state directly to payment state."
 */

const DEFAULT_STATION = 'Pass';

/** The stations an outlet runs, with their own targets (§4: "Per-station
 *  targets come from configuration, not a constant"). An outlet that has
 *  configured none gets one pass, so a kitchen works before anyone has been
 *  into settings — but it is a row, not a literal, and it can be renamed. */
async function stationsFor(c, outletId) {
  const q = await c.query(
    'SELECT name, target_mins, sort FROM chain.station'
    + ' WHERE outlet_id = $1 AND active ORDER BY sort, name', [outletId]);
  if (q.rows.length) return q.rows;
  return [{ name: DEFAULT_STATION, target_mins: 12, sort: 0 }];
}

/**
 * Fire a round. Opens the table's ticket if it has none, appends the lines, and
 * raises one kds_ticket per station the round actually touches.
 *
 * p = { table, split?, covers?, lines: [{ itemId, qty, note? }], server? }
 */
async function sendRound(c, p, ctx) {
  /* NORMALISED HERE, because this is where a ticket gets its table. The floor
     draws T05 and a guest's phone says 5; without this they became two rows for
     one table and the cashier's tile opened an empty bill. See src/tables.js. */
  const table = tableName(p && p.table);
  if (!table) throw Object.assign(new Error('a round needs a table'), { status: 400 });
  if (!Array.isArray(p.lines) || !p.lines.length) {
    throw Object.assign(new Error('a round needs at least one line'), { status: 400 });
  }

  /* Prices and stations come from the item master. The till sends ids and
     quantities; what a dish costs and who cooks it are not its call — the same
     rule the sale path follows, for the same reason. */
  const ids = p.lines.map((l) => String(l.itemId));
  const items = await c.query(
    'SELECT id, name, price, station FROM item WHERE id = ANY($1) AND active', [ids]);
  const byId = new Map(items.rows.map((r) => [r.id, r]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw Object.assign(new Error('unknown or inactive item: ' + id), { status: 409 });
    }
  }

  /* WHICH BILL ON THIS TABLE. `split` has been in the schema and in the unique
     index since the first migration and every insert wrote a literal 0, so a
     table could only ever have one bill and a party of four splitting it had to
     be handled on paper. It is a small non-negative integer: 0 is the table's
     own bill, 1.. are the guests who asked for their own. */
  const split = Math.max(0, Math.min(99, Math.trunc(Number(p.split) || 0)));

  /* One open ticket per (table, split) — the partial unique index enforces it.
     ON CONFLICT rather than a read-then-write: two servers firing the same
     table at the same moment must not race into two tickets, and the database
     is the only place that can be decided. */
  const existing = await c.query(
    "SELECT id FROM ticket WHERE table_no = $1 AND split = $2 AND status = 'open'"
    + ' FOR UPDATE', [table, split]);
  let ticketId;
  if (existing.rows.length) {
    ticketId = existing.rows[0].id;
    if (p.covers) {
      await c.query('UPDATE ticket SET covers = GREATEST(covers, $2) WHERE id = $1',
        [ticketId, Number(p.covers) || 1]);
    }
  } else {
    const ins = await c.query(
      'INSERT INTO ticket (table_no, split, channel, status, covers, opened_by, device_id, server_name)'
      + " VALUES ($1, $2, $3, 'open', $4, $5, $6, $7)"
      + ' ON CONFLICT DO NOTHING RETURNING id',
      [table, split, p.channel || 'dine_in', Number(p.covers) || 1,
        ctx.actor, ctx.deviceId, p.server || null]);
    if (ins.rows.length) ticketId = ins.rows[0].id;
    else {
      // Lost the race; the other transaction's ticket is the one to use.
      const again = await c.query(
        "SELECT id FROM ticket WHERE table_no = $1 AND split = $2 AND status = 'open'",
        [table, split]);
      if (!again.rows.length) throw new Error('could not open a ticket for ' + table);
      ticketId = again.rows[0].id;
    }
  }

  const stations = await stationsFor(c, ctx.outletId);
  const known = new Map(stations.map((s) => [s.name, s]));
  const touched = new Map();     // station name -> target_mins

  for (const l of p.lines) {
    const it = byId.get(String(l.itemId));
    const qty = Number(l.qty);
    if (!(qty > 0)) throw Object.assign(new Error('a line quantity must be positive'), { status: 400 });
    await c.query(
      'INSERT INTO ticket_line (ticket_id, item_id, name, qty, unit_price, note, sent_at, by_staff, device_id)'
      + ' VALUES ($1,$2,$3,$4,$5,$6, now(), $7,$8)',
      [ticketId, it.id, it.name, qty, it.price, l.note || null, ctx.actor, ctx.deviceId]);

    /* An unrouted dish still reaches the kitchen. §4's columns are per station,
       and a dish nobody has assigned would otherwise vanish from the pass — a
       configuration gap must not become a missing order. */
    const name = (it.station && known.has(it.station)) ? it.station : stations[0].name;
    if (!touched.has(name)) touched.set(name, known.get(name)?.target_mins ?? 12);
  }

  const fired = [];
  for (const [name, target] of touched) {
    const k = await c.query(
      'INSERT INTO kds_ticket (ticket_id, station, stage, target_mins, by_staff)'
      + " VALUES ($1,$2,'Received',$3,$4) RETURNING id", [ticketId, name, target, ctx.actor]);
    fired.push({ id: k.rows[0].id, station: name });
  }

  await c.query("SELECT chain.log('ticket_send','ticket',$1,NULL,$2)",
    [ticketId, JSON.stringify({
      table, split, lines: p.lines.length, stations: fired.map((f) => f.station),
    })]);

  return { ticketId, table, split, fired };
}

/**
 * Take a line off an open ticket.
 *
 * NOT a delete. `void_at` and a reason, so the line stays on the ticket and in
 * the receipt's own "voided lines" section — the schema, the snapshot query and
 * the receipt drawer have all read this column since the beginning and nothing
 * has ever written it, which meant a dish keyed by mistake could not be taken
 * off a tab by anybody at any rank.
 *
 * RANK IS DECIDED BY WHETHER THE KITCHEN HAS IT. An unsent line is a typo and
 * the person who made it should fix it, so the till can. A line that has been
 * fired is food that was cooked and is now being written off, which is a
 * manager's signature — the same reason wastage is rank 3. Every line this
 * build creates is sent the moment it is created (see sendRound), so in
 * practice this is the manager rule; the unsent branch is here because the
 * column allows it and a future "hold this round" would rely on it.
 *
 * p = { lineId, reason }
 */
async function voidLine(c, p, ctx) {
  const lineId = String((p && p.lineId) || '');
  const reason = String((p && p.reason) || '').trim();
  if (!lineId) throw Object.assign(new Error('which line?'), { status: 400 });
  if (reason.length < 3) {
    throw Object.assign(
      new Error('a voided line needs a reason — it is what the write-off is answered with'),
      { status: 400 });
  }

  const q = await c.query(
    'SELECT l.id, l.name, l.qty, l.unit_price, l.sent_at, l.void_at,'
    + ' t.id AS ticket_id, t.status, t.table_no'
    + ' FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id'
    + ' WHERE l.id = $1 FOR UPDATE OF l', [lineId]);
  if (!q.rows.length) throw Object.assign(new Error('no such line'), { status: 404 });
  const l = q.rows[0];

  /* Idempotent: a till replaying a queued void after a reconnect must not be
     told its own completed work was an error. */
  if (l.void_at) return { lineId: l.id, ticketId: l.ticket_id, already: true };

  if (l.status !== 'open') {
    throw Object.assign(
      new Error('that ticket is settled — a settled sale is corrected with a credit note, never edited'),
      { status: 409 });
  }
  if (l.sent_at && (ctx.rank || 0) < 3) {
    throw Object.assign(
      new Error('that one is already with the kitchen — a manager takes it off'),
      { status: 403 });
  }

  await c.query(
    'UPDATE ticket_line SET void_at = now(), void_reason = $2, void_by = $3 WHERE id = $1',
    [lineId, reason, ctx.actor]);

  await c.query("SELECT chain.log('ticket_line_void','ticket_line',$1,NULL,$2)",
    [lineId, JSON.stringify({
      ticketId: l.ticket_id, table: l.table_no, name: l.name,
      qty: l.qty, unitPrice: l.unit_price, wasSent: l.sent_at !== null, reason,
    })]);

  return { lineId: l.id, ticketId: l.ticket_id, name: l.name, qty: l.qty };
}

/* §4: "Stages: Received → In the kitchen → Ready → Served." A stage only ever
   moves FORWARD along this list. A ticket that has been served is finished;
   dragging it back to "In the kitchen" would restart a timer against a target
   that was already met and quietly rewrite the kitchen's own performance. */
const STAGES = ['Received', 'In the kitchen', 'Ready', 'Served'];

/**
 * Advance one kds_ticket to a named stage.
 *
 * p = { kdsId, stage }
 */
async function advance(c, p, ctx) {
  const stage = String((p && p.stage) || '');
  const at = STAGES.indexOf(stage);
  if (at < 0) throw Object.assign(new Error('unknown stage: ' + stage), { status: 400 });

  const cur = await c.query(
    'SELECT id, stage, ticket_id FROM kds_ticket WHERE id = $1 FOR UPDATE', [p.kdsId]);
  if (!cur.rows.length) throw Object.assign(new Error('no such kitchen ticket'), { status: 404 });

  const from = STAGES.indexOf(cur.rows[0].stage);
  if (at <= from) {
    /* Not an error — a replayed op, or two hands on two screens tapping the
       same card. Report the state and change nothing, which is what makes this
       safe to retry. */
    return { kdsId: p.kdsId, stage: cur.rows[0].stage, unchanged: true };
  }

  await c.query(
    'UPDATE kds_ticket SET stage = $2,'
    + " ready_at = CASE WHEN $2 = 'Ready' THEN now() ELSE ready_at END,"
    + " served_at = CASE WHEN $2 = 'Served' THEN now() ELSE served_at END"
    + ' WHERE id = $1', [p.kdsId, stage]);

  await c.query("SELECT chain.log('kds_stage','kds_ticket',$1,$2,$3)",
    [p.kdsId, JSON.stringify({ stage: cur.rows[0].stage }), JSON.stringify({ stage })]);

  return { kdsId: p.kdsId, stage, from: cur.rows[0].stage };
}

module.exports = { sendRound, advance, voidLine, stationsFor, STAGES, DEFAULT_STATION };
