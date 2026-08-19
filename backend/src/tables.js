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

module.exports = { tableName, sameTable };
