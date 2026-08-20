'use strict';
const { tableName } = require('./tables');
const addons = require('./addons');
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
    'SELECT id, name, price, station, category, addons_own FROM item'
    + ' WHERE id = ANY($1) AND active', [ids]);
  const byId = new Map(items.rows.map((r) => [r.id, r]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw Object.assign(new Error('unknown or inactive item: ' + id), { status: 409 });
    }
  }

  /* Add-ons are priced HERE, off the catalogue, for the same reason the dish is
     (src/addons.js). The terminal sent ids; what "extra sambol" costs and
     whether this dish offers it at all are the server's answer. */
  const offered = await addons.offeredFor(c, items.rows);

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
    /* The add-on extra folds into the UNIT price, so every figure downstream —
       line total, tax, service charge, the receipt — stays the arithmetic it
       already was. The rows themselves are kept alongside so the docket and the
       bill can still say what was added and what each one cost. */
    const picked = addons.priceLine(l.addons, offered.get(it.id) || [], it.name);
    const unitPrice = Math.round((Number(it.price) + picked.extra) * 100) / 100;
    await c.query(
      'INSERT INTO ticket_line (ticket_id, item_id, name, qty, unit_price, addons, note, sent_at, by_staff, device_id)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8,$9)',
      [ticketId, it.id, it.name, qty, unitPrice, JSON.stringify(picked.addons),
        l.note || null, ctx.actor, ctx.deviceId]);

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
 * Whose bill this split is (§3.3).
 *
 * A NAME, NOT AN IDENTITY. This is what the cashier writes on the chip so the
 * server can say "Daniel's is the one with the ceviche" — it is not a customer
 * record and it deliberately does not reach for one. A bill that belongs to a
 * real member already carries `member_id`, which is the thing loyalty, credit
 * and the member portal read; this is the four-splits-on-table-nine problem,
 * and it is solved with four words.
 *
 * p = { ticketId, name }
 */
async function nameGuest(c, p, ctx) {
  const ticketId = String((p && p.ticketId) || '');
  if (!ticketId) throw Object.assign(new Error('which bill?'), { status: 400 });
  const name = String((p && p.name) || '').trim().slice(0, 60);

  const q = await c.query(
    "SELECT id, split, table_no, status FROM ticket WHERE id = $1 AND status = 'open'"
    + ' FOR UPDATE', [ticketId]);
  if (!q.rows.length) {
    throw Object.assign(new Error('that bill is not open'), { status: 409 });
  }
  await c.query('UPDATE ticket SET guest_name = $2 WHERE id = $1', [ticketId, name || null]);
  await c.query("SELECT chain.log('ticket_guest_name','ticket',$1,NULL,$2)",
    [ticketId, JSON.stringify({ table: q.rows[0].table_no, split: q.rows[0].split, name })]);
  return { ticketId, name: name || null };
}

/**
 * A note on a line (§3.3: "Modifiers and notes sit under the line").
 *
 * `ticket_line.note` has existed since migration 003. The kitchen path passes
 * it through, the KDS prints it and the receipt shows it — and until now no
 * screen could put one there, so "no onion", "allergy — nuts" and "fire with
 * the mains" were said out loud and written nowhere.
 *
 * NOT RANK-GATED, unlike a void. A note costs nothing and corrects nothing; it
 * is the server telling the kitchen something about food that is already going
 * to be cooked. Gating it would mean waiting for a manager to record an
 * allergy, which is the opposite of safe.
 *
 * p = { lineId, note }
 */
async function noteLine(c, p, ctx) {
  const lineId = String((p && p.lineId) || '');
  if (!lineId) throw Object.assign(new Error('which line?'), { status: 400 });
  const note = String((p && p.note) || '').trim().slice(0, 200);

  const q = await c.query(
    'SELECT l.id, l.name, l.note, t.id AS ticket_id, t.status'
    + ' FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id'
    + ' WHERE l.id = $1 AND l.void_at IS NULL FOR UPDATE OF l', [lineId]);
  if (!q.rows.length) throw Object.assign(new Error('no such line'), { status: 404 });
  if (q.rows[0].status !== 'open') {
    throw Object.assign(new Error('that bill is closed'), { status: 409 });
  }

  await c.query('UPDATE ticket_line SET note = $2 WHERE id = $1', [lineId, note || null]);
  await c.query("SELECT chain.log('ticket_line_note','ticket_line',$1,$2,$3)",
    [lineId, JSON.stringify({ note: q.rows[0].note }), JSON.stringify({ note })]);
  return { lineId, ticketId: q.rows[0].ticket_id, note: note || null };
}

/**
 * Park a bill (§3.5).
 *
 * A party moves to the bar. A walk-in has to give the table back before the
 * card machine frees up. A bill wants setting aside. Until now the only ways
 * out of an open ticket were to settle it or write it off, so every one of
 * those became a lie in the books.
 *
 * PARKING FREES THE TABLE, and the schema does it rather than this function:
 * `ticket_open_table` is a partial unique index over `WHERE status = 'open'`,
 * so a held ticket stops reserving its (table, split) the moment the status
 * changes and the next party can be seated on it.
 *
 * IDEMPOTENT, like everything else that arrives over the replay path: a till
 * re-sending a queued park after a reconnect gets the reference it already
 * minted rather than a second one.
 *
 * p = { ticketId }
 */
async function parkTicket(c, p, ctx) {
  const ticketId = String((p && p.ticketId) || '');
  if (!ticketId) throw Object.assign(new Error('which bill?'), { status: 400 });

  const q = await c.query(
    'SELECT id, table_no, split, status, hold_ref FROM ticket WHERE id = $1 FOR UPDATE',
    [ticketId]);
  if (!q.rows.length) throw Object.assign(new Error('no such bill'), { status: 404 });
  const t = q.rows[0];
  if (t.status === 'held') return { ticketId, ref: t.hold_ref, already: true };
  if (t.status !== 'open') {
    throw Object.assign(new Error('only an open bill can be parked'), { status: 409 });
  }

  const lines = await c.query(
    'SELECT count(*)::int AS n FROM ticket_line WHERE ticket_id = $1 AND void_at IS NULL',
    [ticketId]);
  if (!lines.rows[0].n) {
    /* An empty bill is not parked, it is given back. Minting a HOLD reference
       for nothing would put a row on the parked strip that resumes to an empty
       ticket — and `ticket_void` already does the right thing for this. */
    throw Object.assign(
      new Error('there is nothing on this bill to park — give the table back instead'),
      { status: 409 });
  }

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['HOLD']);
  const ref = no.rows[0].no;
  await c.query(
    "UPDATE ticket SET status = 'held', hold_ref = $2, held_at = now(), held_by = $3"
    + ' WHERE id = $1', [ticketId, ref, ctx.actor]);
  await c.query("SELECT chain.log('ticket_park','ticket',$1,NULL,$2)",
    [ticketId, JSON.stringify({ ref, table: t.table_no, split: t.split })]);
  return { ticketId, ref, table: t.table_no };
}

/**
 * Put a parked bill back on a table (§3.5).
 *
 * The table has to be free again, and that is the honest constraint rather than
 * an oversight: two open bills on one (table, split) is exactly what
 * `ticket_open_table` exists to prevent, and a resumed bill landing on top of
 * the party who was seated after it is how one table's food reaches another
 * table's receipt. A cashier whose table has been taken resumes onto a
 * different one, which is what they would do with paper.
 *
 * p = { ticketId, table? }
 */
async function resumeTicket(c, p, ctx) {
  const ticketId = String((p && p.ticketId) || '');
  if (!ticketId) throw Object.assign(new Error('which bill?'), { status: 400 });

  const q = await c.query(
    'SELECT id, table_no, split, status, hold_ref FROM ticket WHERE id = $1 FOR UPDATE',
    [ticketId]);
  if (!q.rows.length) throw Object.assign(new Error('no such bill'), { status: 404 });
  const t = q.rows[0];
  if (t.status === 'open') return { ticketId, table: t.table_no, already: true };
  if (t.status !== 'held') {
    throw Object.assign(new Error('that bill is not parked'), { status: 409 });
  }

  const table = p.table ? tableName(p.table) : t.table_no;
  const taken = await c.query(
    "SELECT 1 FROM ticket WHERE table_no = $1 AND split = $2 AND status = 'open'",
    [table, t.split]);
  if (taken.rows.length) {
    throw Object.assign(
      new Error(table + ' has an open bill on it — resume this one onto another table'),
      { status: 409 });
  }

  await c.query(
    "UPDATE ticket SET status = 'open', table_no = $2, hold_ref = NULL,"
    + ' held_at = NULL, held_by = NULL WHERE id = $1', [ticketId, table]);
  await c.query("SELECT chain.log('ticket_resume','ticket',$1,$2,$3)",
    [ticketId, JSON.stringify({ ref: t.hold_ref, table: t.table_no }),
      JSON.stringify({ table })]);
  return { ticketId, table, ref: t.hold_ref };
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

/**
 * Close an open ticket WITHOUT a sale.
 *
 * There has never been a way to do this, and there are two ordinary ways to
 * end up needing one:
 *
 *   · Seating a reservation opens a ticket before anybody has ordered
 *     (reservations.js). The party sits down, changes its mind and leaves, and
 *     the table is shaded busy for the rest of the service.
 *   · Every line on a ticket gets voided — a round keyed onto the wrong table,
 *     say — and what is left is an open ticket with nothing on it.
 *
 * In both cases the till could not settle it: Pay is disabled with no lines,
 * and sale.js rightly refuses a sale with none. So the table stayed busy and
 * no rank could free it.
 *
 * THE RANK FOLLOWS WHETHER THERE IS ANYTHING TO ANSWER FOR. An empty ticket is
 * a table being given back and the till can do it. A ticket with food on it is
 * a walkout: the kitchen made it, nobody paid, and that is a manager's
 * signature with a reason — the same rule as voiding a single fired line, for
 * the same reason.
 *
 * WHAT IT DOES NOT DO IS MOVE STOCK. Costing happens at the moment of sale, so
 * a voided ticket books no COGS and relieves no ingredients: the food that was
 * made is still on the books as stock. That is a wastage entry, through the
 * ordinary wastage path, so it lands in the same figure as everything else
 * that was thrown away rather than in a second one nobody adds up. The screen
 * says so; this function will not quietly invent the policy.
 *
 * p = { ticketId, reason? }
 */
async function voidTicket(c, p, ctx) {
  const ticketId = String((p && p.ticketId) || '');
  const reason = String((p && p.reason) || '').trim();
  if (!ticketId) throw Object.assign(new Error('which ticket?'), { status: 400 });

  /* Two queries, not one: Postgres refuses FOR UPDATE alongside GROUP BY, and
     the lock on the ticket row is the thing that stops two terminals voiding
     and settling the same bill at once. So lock first, count second. */
  const q = await c.query(
    'SELECT id, table_no, split, status, covers FROM ticket WHERE id = $1 FOR UPDATE',
    [ticketId]);
  if (!q.rows.length) throw Object.assign(new Error('no such ticket'), { status: 404 });
  const t = q.rows[0];
  const agg = await c.query(
    'SELECT count(*) AS live, coalesce(sum(qty * unit_price), 0) AS value'
    + ' FROM ticket_line WHERE ticket_id = $1 AND void_at IS NULL', [ticketId]);
  const live = Number(agg.rows[0].live);
  t.value = agg.rows[0].value;

  /* Idempotent: a till replaying a queued void after a reconnect must not be
     told its own completed work was an error. A ticket somebody SETTLED in the
     meantime is a different matter and must not be quietly voided over. */
  if (t.status === 'void') return { ticketId: t.id, table: t.table_no, already: true };
  if (t.status === 'closed') {
    throw Object.assign(
      new Error('that ticket was paid — a settled sale is corrected with a credit note, never voided'),
      { status: 409 });
  }

  if (live > 0) {
    if ((ctx.rank || 0) < 3) {
      throw Object.assign(
        new Error('there is food on that bill — a manager writes it off'), { status: 403 });
    }
    if (reason.length < 3) {
      throw Object.assign(
        new Error('a written-off bill needs a reason — it is what the loss is answered with'),
        { status: 400 });
    }
    /* Each line voided by name, so the write-off is itemised in the trail
       rather than being one number at the ticket. */
    await c.query(
      'UPDATE ticket_line SET void_at = now(), void_reason = $2, void_by = $3'
      + ' WHERE ticket_id = $1 AND void_at IS NULL', [ticketId, reason, ctx.actor]);
  }

  await c.query(
    "UPDATE ticket SET status = 'void', closed_at = now(), closed_by = $2 WHERE id = $1",
    [ticketId, ctx.actor]);

  /* Whatever the kitchen still had is off the pass: there is no longer a bill
     for it to belong to, and a card nobody can act on is worse than none. */
  await c.query(
    'UPDATE kds_ticket SET served_at = now() WHERE ticket_id = $1 AND served_at IS NULL',
    [ticketId]);

  await c.query("SELECT chain.log('ticket_void','ticket',$1,NULL,$2)",
    [ticketId, JSON.stringify({
      table: t.table_no, split: t.split, covers: t.covers,
      lines: live, value: Number(t.value), reason: reason || null,
    })]);

  return { ticketId: t.id, table: t.table_no, lines: live, value: Number(t.value) };
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

module.exports = {
  sendRound, advance, voidLine, voidTicket, stationsFor, STAGES, DEFAULT_STATION,
  nameGuest, noteLine, parkTicket, resumeTicket,
};
