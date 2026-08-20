'use strict';
/* What a table is called — once, for everybody.
 *
 * A physical table had four names in this system. The floor drew `T05`. A round
 * sent from a guest's phone opened a ticket called `5`. The reservations book
 * normalised its own way, because it had to: an EXCLUDE constraint stopping two
 * parties being booked onto one table sees `2` and `T02` as two different
 * tables and enforces nothing. And the member portal's bill screen looks up "my
 * open ticket", which the till then cannot open, because the tile it drew and
 * the ticket that exists are not the same string.
 *
 * The floor half-knew: its tile checked BOTH spellings when deciding whether to
 * shade a table busy, and then used its own spelling for everything after. So a
 * QR order at table 5 lit the tile, and tapping it opened an empty bill — and
 * sending a round from there would have opened a SECOND ticket for the same
 * table, which the unique index on (table_no, split) could not prevent because
 * the two rows disagreed about the name.
 *
 * So: one function, and every path that writes or looks up a ticket's table
 * goes through it. `T05` is the form, because that is what the floor draws and
 * what a printed ticket header shows.
 *
 * A NAME THAT IS NOT A NUMBER IS LEFT ALONE. "Terrace", "Bar 2" and the two
 * non-table slots the floor always draws — Takeaway and Delivery — are names,
 * not numbers, and mangling them into T-something would invent tables nobody
 * has.
 */

/** `5`, `05`, `t5`, `T05` → `T05`. `Terrace`, `Takeaway`, `Delivery` → as they are. */
function tableName(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return null;
  const m = /^[Tt]?0*([1-9]\d{0,2})$/.exec(raw);
  if (!m) return raw.slice(0, 20);
  const n = Number(m[1]);
  return 'T' + (n < 10 ? '0' + n : String(n));
}

/** True when two spellings mean the same table. */
const sameTable = (a, b) => tableName(a) === tableName(b);

/* ── the floor plan (migration 038, spec §3.1) ─────────────────────────────
 *
 * THE ROOM, WHEN SOMEBODY HAS DESCRIBED IT. An outlet that has never opened
 * the floor editor has no rows, and this returns an empty list — the till then
 * draws T01..Tn off `outlet.tables` exactly as it always has. That is the whole
 * design: naming tables and grouping them into zones is an enrichment, not a
 * migration a merchant is forced through, and nothing about the till changes on
 * the day they do it.
 */
async function floorPlan(c) {
  const q = await c.query(
    'SELECT name, zone, seats, sort, active FROM dining_table'
    + ' WHERE active ORDER BY sort, name');
  return q.rows.map((r) => ({
    name: r.name, zone: r.zone, seats: r.seats, sort: r.sort,
  }));
}

/** Every table including the retired ones — this is the editor, not the till. */
async function allTables(c) {
  const q = await c.query(
    'SELECT d.name, d.zone, d.seats, d.sort, d.active,'
    + ' (SELECT count(*)::int FROM ticket t'
    + "   WHERE t.table_no = d.name AND t.status = 'open') AS open_tickets,"
    + ' (SELECT count(*)::int FROM sale s'
    + '   JOIN ticket t2 ON t2.id = s.ticket_id WHERE t2.table_no = d.name) AS sales'
    + ' FROM dining_table d ORDER BY d.active DESC, d.sort, d.name');
  return q.rows.map((r) => ({
    name: r.name, zone: r.zone, seats: r.seats, sort: r.sort, active: r.active,
    openTickets: r.open_tickets, sales: r.sales,
  }));
}

function cleanTable(body) {
  const out = {};
  if (body.zone !== undefined) {
    const v = body.zone === null ? null : String(body.zone).trim().slice(0, 40);
    out.zone = v || null;
  }
  if (body.seats !== undefined) {
    const n = Math.trunc(Number(body.seats));
    if (!(n >= 1 && n <= 99)) {
      throw Object.assign(new Error('a table seats 1 to 99'), { status: 400 });
    }
    out.seats = n;
  }
  if (body.sort !== undefined) out.sort = Math.trunc(Number(body.sort) || 0);
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

/** Add a table, or change one. Named through tableName() so the floor, the
 *  kitchen, the reservations book and the guest's QR card cannot end up
 *  holding four spellings of one room — the whole point of this module. */
async function saveTable(c, rawName, body) {
  const name = tableName(rawName);
  if (!name) throw Object.assign(new Error('a table needs a name'), { status: 400 });

  const f = cleanTable(body);
  const before = await c.query('SELECT * FROM dining_table WHERE name = $1', [name]);

  const cols = ['name', ...Object.keys(f)];
  const vals = [name, ...Object.values(f)];
  const set = Object.keys(f).map((k, i) => k + ' = $' + (i + 2));
  await c.query(
    'INSERT INTO dining_table (' + cols.join(', ') + ')'
    + ' VALUES (' + cols.map((_, i) => '$' + (i + 1)).join(', ') + ')'
    + (set.length ? ' ON CONFLICT (name) DO UPDATE SET ' + set.join(', ')
      : ' ON CONFLICT (name) DO NOTHING'),
    vals);

  /* RENAMING TAKES ITS HISTORY WITH IT, in this transaction. `ticket.table_no`
     is the only link between a table and everything ever rung against it, so a
     rename that touched this row alone would strand every open tab and every
     receipt on a name the floor no longer draws. */
  if (body.renameTo !== undefined) {
    const to = tableName(body.renameTo);
    if (!to) throw Object.assign(new Error('rename it to what?'), { status: 400 });
    if (to !== name) {
      const clash = await c.query('SELECT 1 FROM dining_table WHERE name = $1', [to]);
      if (clash.rows.length) {
        throw Object.assign(new Error('there is already a table called ' + to), { status: 409 });
      }
      await c.query('UPDATE dining_table SET name = $2 WHERE name = $1', [name, to]);
      await c.query('UPDATE ticket SET table_no = $2 WHERE table_no = $1', [name, to]);
    }
  }

  const key = body.renameTo !== undefined ? tableName(body.renameTo) : name;
  const after = await c.query('SELECT * FROM dining_table WHERE name = $1', [key]);
  await c.query("SELECT chain.log('floor_table_save','dining_table',$1,$2,$3)",
    [name, JSON.stringify(before.rows[0] || null), JSON.stringify(after.rows[0] || null)]);
  return after.rows[0] || { name };
}

/** Take a table out of the room.
 *
 *  A TABLE THAT HAS TRADED IS RETIRED, NOT DELETED, exactly as a dish is: every
 *  sale ever rung against it points at this name, and a floor plan that can
 *  erase the row a receipt refers to is a floor plan that can orphan a tax
 *  record. One that has never traded is a typo, and a typo is deleted. */
async function dropTable(c, rawName) {
  const name = tableName(rawName);
  const q = await c.query('SELECT 1 FROM dining_table WHERE name = $1', [name]);
  if (!q.rows.length) throw Object.assign(new Error('no such table'), { status: 404 });

  const open = await c.query(
    "SELECT 1 FROM ticket WHERE table_no = $1 AND status = 'open'", [name]);
  if (open.rows.length) {
    throw Object.assign(
      new Error('that table has an open bill — settle or write it off first'),
      { status: 409 });
  }

  const used = await c.query('SELECT 1 FROM ticket WHERE table_no = $1 LIMIT 1', [name]);
  if (used.rows.length) {
    await c.query('UPDATE dining_table SET active = false WHERE name = $1', [name]);
    await c.query("SELECT chain.log('floor_table_retire','dining_table',$1,$2,NULL)",
      [name, JSON.stringify({ name })]);
    return { name, retired: true };
  }
  await c.query('DELETE FROM dining_table WHERE name = $1', [name]);
  await c.query("SELECT chain.log('floor_table_drop','dining_table',$1,$2,NULL)",
    [name, JSON.stringify({ name })]);
  return { name, dropped: true };
}

module.exports = {
  tableName, sameTable, floorPlan, allTables, saveTable, dropTable,
};
