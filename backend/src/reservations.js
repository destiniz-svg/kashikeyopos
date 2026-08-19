'use strict';
/* Reservations — 02-POS-SPEC.md §2 (`reservations`): "Tonight's book, table
 * assignment, arrival state."
 *
 * SEATING IS THE JOIN TO THE FLOOR, and it is the reason this module is worth
 * building rather than keeping a diary by the door. Marking a party arrived
 * opens their ticket, on their table, with their covers and their name already
 * on it — the governing principle's "nothing is entered twice", applied to the
 * one moment a restaurant is least able to type anything. A book that only
 * changed a status would leave the host writing the same four facts into the
 * till thirty seconds later.
 *
 * A BOOKING HOLDS A TABLE FOR A WINDOW. "Seven o'clock, table 4" means table 4
 * is unavailable at half past seven too. The overlap is refused by an exclusion
 * constraint in the schema rather than by a check in this file, because two
 * hosts on two terminals can both read an empty slot in the same second and
 * only a constraint can arbitrate that.
 *
 * A NO-SHOW IS DATA. It is a status, never a deletion: a name that fails to
 * arrive twice a month is exactly what a restaurant wants to know, and a book
 * that tidies away what did not happen can never tell anyone.
 *
 * THE BOOK IS A CLOCK, NOT A LIST. What a host needs at ten past seven is not
 * "here are tonight's twelve bookings" but "these two are late and this one is
 * due in ten minutes". So the day comes back already sorted into what has
 * passed, what is imminent, and what is still ahead.
 */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const iso = (d) => d.toISOString().slice(0, 10);
const hhmm = (min) =>
  String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

/**
 * ONE NAME PER TABLE. The floor draws its tiles as T01…Tn, the guest portal's
 * QR carries a bare number, and a host typing into a box will write whichever
 * they have in their head. Left alone, "2" and "T02" are different tables to
 * the double-booking guard — so two bookings, one typed each way, would both
 * be accepted on the same physical table and the constraint would have
 * enforced nothing at all.
 *
 * Anything that is a table NUMBER — bare, or T-prefixed, with or without the
 * leading zero — becomes the floor's own label. Anything else (a name like
 * "Terrace") is kept as it was written, because a restaurant that calls a table
 * the Terrace is not making a typing mistake.
 */
/* The one spelling, shared with every other path that names a table — the
   floor, the kitchen, the member's bill. It lived here first, because the
   EXCLUDE constraint below cannot stop a double booking if `2` and `T02` are
   two tables; it lives in src/tables.js now because they all needed it. */
const { tableName } = require('./tables');

function toMin(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  const m = HHMM.exec(String(v || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes from midnight, right now, in the outlet's own day. */
const nowMin = () => {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/* ── the book ────────────────────────────────────────────────────────────── */

async function day(c, onDate) {
  const date = onDate || iso(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('a date, YYYY-MM-DD'), { status: 400 });
  }
  const q = await c.query(
    'SELECT r.*, s.name AS by_name, m.phone AS member_phone,'
    + '  t.status AS ticket_status'
    + ' FROM reservation r'
    + ' LEFT JOIN chain.staff s ON s.id = r.by_staff'
    + ' LEFT JOIN chain.member m ON m.id = r.member_id'
    + ' LEFT JOIN ticket t ON t.id = r.ticket_id'
    + ' WHERE r.on_date = $1::date ORDER BY r.at_min, r.name', [date]);

  const isToday = date === iso(new Date());
  const now = nowMin();

  const rows = q.rows.map((r) => {
    const late = isToday && r.status === 'booked' && now > r.at_min;
    return {
      id: r.id, onDate: r.on_date, atMin: r.at_min, at: hhmm(r.at_min),
      mins: r.mins, until: hhmm(Math.min(1439, r.at_min + r.mins)),
      covers: r.covers, name: r.name, phone: r.phone || r.member_phone || null,
      memberId: r.member_id, note: r.note, tableNo: r.table_no,
      status: r.status, seatedAt: r.seated_at, ticketId: r.ticket_id,
      ticketOpen: r.ticket_status === 'open',
      reason: r.reason, by: r.by_name || null,
      /* How late, in minutes. A host does not need "overdue" — they need to
         know whether it is four minutes or forty, because those are different
         decisions about the table. */
      lateBy: late ? now - r.at_min : 0,
      dueIn: isToday && r.status === 'booked' && r.at_min >= now ? r.at_min - now : null,
    };
  });

  const live = rows.filter((r) => r.status === 'booked' || r.status === 'seated');
  return {
    date,
    reservations: rows,
    /* The three answers a host actually wants, computed once here rather than
       three times on the screen. */
    late: rows.filter((r) => r.lateBy > 0),
    soon: rows.filter((r) => r.dueIn !== null && r.dueIn <= 30),
    seated: rows.filter((r) => r.status === 'seated'),
    totals: {
      bookings: live.length,
      covers: live.reduce((s, r) => s + r.covers, 0),
      seated: rows.filter((r) => r.status === 'seated').length,
      noShows: rows.filter((r) => r.status === 'no_show').length,
    },
    /* Which tables are spoken for and when, so a host taking a booking on the
       telephone can see the evening rather than guess at it. */
    heldTables: [...new Set(live.filter((r) => r.tableNo).map((r) => r.tableNo))].sort(),
  };
}

/* ── taking one ──────────────────────────────────────────────────────────── */

async function book(c, p, ctx) {
  const name = String(p.name || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('whose booking is it?'), { status: 400 });

  const date = String(p.onDate || iso(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('a date, YYYY-MM-DD'), { status: 400 });
  }
  const at = toMin(p.at);
  if (at === null) {
    throw Object.assign(new Error('a time, like 19:30'), { status: 400 });
  }
  const covers = Number(p.covers);
  if (!Number.isInteger(covers) || covers < 1 || covers > 200) {
    throw Object.assign(new Error('how many people?'), { status: 400 });
  }
  const mins = p.mins ? Number(p.mins) : 90;
  if (!Number.isInteger(mins) || mins < 15 || mins > 480) {
    throw Object.assign(new Error('a table is held for 15 to 480 minutes'), { status: 400 });
  }

  /* Normalised ONCE, here, and the same value is stored, returned and logged.
     Returning what was typed instead would have the client believing it booked
     "8" while the book holds T08 — a difference nobody notices until they go
     looking for the booking. */
  const table = tableName(p.tableNo);

  try {
    const q = await c.query(
      'INSERT INTO reservation (on_date, at_min, mins, covers, name, phone,'
      + ' member_id, note, table_no, by_staff)'
      + ' VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [date, at, mins, covers, name, p.phone ? String(p.phone).slice(0, 30) : null,
        p.memberId || null, p.note ? String(p.note).slice(0, 200) : null,
        table, ctx.actor]);

    await c.query("SELECT chain.log('reservation_book','reservation',$1,NULL,$2)",
      [q.rows[0].id, JSON.stringify({ date, at: hhmm(at), covers, name, table })]);
    return { id: q.rows[0].id, onDate: date, at: hhmm(at), covers, name, tableNo: table };
  } catch (e) {
    if (e.code === '23P01') {
      /* The exclusion constraint. Turned into a sentence a host can act on:
         the table is taken, and the useful next move is another table or
         another time. */
      throw Object.assign(new Error(
        'Table ' + table + ' is already booked across ' + hhmm(at) + '–'
        + hhmm(Math.min(1439, at + mins)) + ' that day.'), { status: 409 });
    }
    throw e;
  }
}

/** Move a booking: a different time, a different table, a different party. */
async function amend(c, id, p, ctx) {
  const cur = await c.query('SELECT * FROM reservation WHERE id = $1', [id]);
  if (!cur.rows.length) throw Object.assign(new Error('no such booking'), { status: 404 });
  const r = cur.rows[0];
  if (r.status === 'cancelled' || r.status === 'no_show' || r.status === 'done') {
    throw Object.assign(new Error('that booking is closed'), { status: 409 });
  }

  const at = p.at === undefined ? r.at_min : toMin(p.at);
  if (at === null) throw Object.assign(new Error('a time, like 19:30'), { status: 400 });
  const covers = p.covers === undefined ? r.covers : Number(p.covers);
  if (!Number.isInteger(covers) || covers < 1) {
    throw Object.assign(new Error('how many people?'), { status: 400 });
  }
  const mins = p.mins === undefined ? r.mins : Number(p.mins);
  const tableNo = p.tableNo === undefined ? r.table_no : tableName(p.tableNo);

  try {
    await c.query(
      'UPDATE reservation SET at_min = $2, covers = $3, mins = $4, table_no = $5,'
      + ' name = coalesce($6, name), phone = coalesce($7, phone),'
      + ' note = coalesce($8, note) WHERE id = $1',
      [id, at, covers, mins, tableNo,
        p.name ? String(p.name).slice(0, 80) : null,
        p.phone === undefined ? null : String(p.phone || '').slice(0, 30) || null,
        p.note === undefined ? null : String(p.note || '').slice(0, 200) || null]);
  } catch (e) {
    if (e.code === '23P01') {
      throw Object.assign(new Error(
        'Table ' + tableNo + ' is already booked across ' + hhmm(at) + '–'
        + hhmm(Math.min(1439, at + mins)) + ' that day.'), { status: 409 });
    }
    throw e;
  }
  await c.query("SELECT chain.log('reservation_amend','reservation',$1,NULL,$2)",
    [id, JSON.stringify({ at: hhmm(at), covers, table: tableNo })]);
  return { id, at: hhmm(at), covers, tableNo };
}

/* ── arrival ─────────────────────────────────────────────────────────────── */

/**
 * They arrived. This is the join: the booking's table, covers and name become
 * an OPEN TICKET, so the host does not type them again into the till thirty
 * seconds later.
 */
async function seat(c, id, p, ctx) {
  const q = await c.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such booking'), { status: 404 });
  const r = q.rows[0];
  if (r.status === 'seated') {
    throw Object.assign(new Error('they are already sitting down'), { status: 409 });
  }
  if (r.status !== 'booked') {
    throw Object.assign(new Error('that booking is closed'), { status: 409 });
  }

  const table = p.tableNo ? tableName(p.tableNo) : r.table_no;
  if (!table) {
    /* A party cannot be seated at no table. The booking may have been taken
       without one — that is normal — but somebody has to decide now. */
    throw Object.assign(new Error('which table are they on?'), { status: 400 });
  }

  /* The ticket. If the table already has one open — a walk-in the host is
     moving, a table that was never closed — it is REUSED rather than fought
     over: `ticket_open_table` is a unique index and losing that race would
     fail the arrival of a party standing at the door. */
  let ticketId;
  const open = await c.query(
    "SELECT id FROM ticket WHERE table_no = $1 AND split = 0 AND status = 'open'", [table]);
  if (open.rows.length) {
    ticketId = open.rows[0].id;
    await c.query(
      'UPDATE ticket SET covers = GREATEST(covers, $2), member_id = coalesce(member_id, $3),'
      + ' server_name = coalesce(server_name, $4) WHERE id = $1',
      [ticketId, r.covers, r.member_id, r.name]);
  } else {
    const ins = await c.query(
      'INSERT INTO ticket (table_no, split, channel, status, covers, opened_by,'
      + " device_id, server_name, member_id) VALUES ($1,0,'dine_in','open',$2,$3,$4,$5,$6)"
      + ' RETURNING id',
      [table, r.covers, ctx.actor, ctx.deviceId, r.name, r.member_id]);
    ticketId = ins.rows[0].id;
  }

  try {
    await c.query(
      "UPDATE reservation SET status = 'seated', seated_at = now(), table_no = $2,"
      + ' ticket_id = $3 WHERE id = $1', [id, table, ticketId]);
  } catch (e) {
    if (e.code === '23P01') {
      throw Object.assign(new Error(
        'Table ' + table + ' is held by another booking at that time.'), { status: 409 });
    }
    throw e;
  }

  await c.query("SELECT chain.log('reservation_seat','reservation',$1,NULL,$2)",
    [id, JSON.stringify({ table, covers: r.covers, ticketId })]);
  return {
    id, tableNo: table, ticketId, covers: r.covers, name: r.name,
    message: r.name + ', ' + r.covers + ' on table ' + table
      + ' — the ticket is open and waiting.',
  };
}

/** They never came. A status, not a deletion. */
async function noShow(c, id, p, ctx) {
  const q = await c.query(
    "UPDATE reservation SET status = 'no_show', reason = $2, done_at = now()"
    + " WHERE id = $1 AND status = 'booked' RETURNING name, at_min", [id, p.reason || null]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only a booking that never arrived can be a no-show'),
      { status: 409 });
  }
  await c.query("SELECT chain.log('reservation_no_show','reservation',$1,NULL,$2)",
    [id, JSON.stringify({ name: q.rows[0].name })]);
  return { id, status: 'no_show' };
}

async function cancel(c, id, p, ctx) {
  const q = await c.query(
    "UPDATE reservation SET status = 'cancelled', reason = $2, done_at = now()"
    + " WHERE id = $1 AND status IN ('booked') RETURNING name", [id, p.reason || null]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only a booking that has not arrived can be cancelled'),
      { status: 409 });
  }
  await c.query("SELECT chain.log('reservation_cancel','reservation',$1,NULL,$2)",
    [id, JSON.stringify({ name: q.rows[0].name, reason: p.reason })]);
  return { id, status: 'cancelled' };
}

/** The table is free again. Closing the ticket is the till's business. */
async function finish(c, id, p, ctx) {
  const q = await c.query(
    "UPDATE reservation SET status = 'done', done_at = now()"
    + " WHERE id = $1 AND status = 'seated' RETURNING name", [id]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only a seated booking can be finished'), { status: 409 });
  }
  await c.query("SELECT chain.log('reservation_done','reservation',$1,NULL,NULL)", [id]);
  return { id, status: 'done' };
}

/**
 * What a table's evening looks like — every booking that holds it, in order.
 * The question a host on the telephone is actually asking.
 */
async function tableDay(c, tableNo, onDate) {
  const date = onDate || iso(new Date());
  const q = await c.query(
    'SELECT id, at_min, mins, covers, name, status FROM reservation'
    + ' WHERE on_date = $1::date AND table_no = $2'
    + "   AND status IN ('booked','seated') ORDER BY at_min", [date, tableName(tableNo)]);
  return q.rows.map((r) => ({
    id: r.id, at: hhmm(r.at_min), until: hhmm(Math.min(1439, r.at_min + r.mins)),
    covers: r.covers, name: r.name, status: r.status,
  }));
}

module.exports = { day, book, amend, seat, noShow, cancel, finish, tableDay, toMin, hhmm, tableName };
