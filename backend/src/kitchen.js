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
 * p = { table, covers?, lines: [{ itemId, qty, note? }], server? }
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

  /* One open ticket per (table, split) — the partial unique index enforces it.
     ON CONFLICT rather than a read-then-write: two servers firing the same
     table at the same moment must not race into two tickets, and the database
     is the only place that can be decided. */
  const existing = await c.query(
    "SELECT id FROM ticket WHERE table_no = $1 AND split = 0 AND status = 'open'"
    + ' FOR UPDATE', [table]);
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
      + " VALUES ($1, 0, $2, 'open', $3, $4, $5, $6)"
      + ' ON CONFLICT DO NOTHING RETURNING id',
      [table, p.channel || 'dine_in', Number(p.covers) || 1, ctx.actor, ctx.deviceId, p.server || null]);
    if (ins.rows.length) ticketId = ins.rows[0].id;
    else {
      // Lost the race; the other transaction's ticket is the one to use.
      const again = await c.query(
        "SELECT id FROM ticket WHERE table_no = $1 AND split = 0 AND status = 'open'", [table]);
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
    [ticketId, JSON.stringify({ table, lines: p.lines.length, stations: fired.map((f) => f.station) })]);

  return { ticketId, table, fired };
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

module.exports = { sendRound, advance, stationsFor, STAGES, DEFAULT_STATION };
