'use strict';
/* The cash drawer — 08-BUILD-STAGES.md stage 1's last acceptance criterion:
 * "A cashier signs in, opens the register with a float, sells, takes cash, and
 *  the drawer reconciles at close with a real over/short figure."
 *
 * REAL is the word doing the work. A reconciliation that always says zero is a
 * decoration, so the expected figure here is derived from the LEDGER — the
 * movement on account 1000 while the drawer was open — and not from a second
 * pass over the payments table. §22's acceptance criterion says the same thing
 * about the month: "computed from posted journals, not from a parallel
 * calculation". Two calculations that are supposed to agree are two things that
 * can disagree, and the one that is wrong is never the one anybody checks.
 *
 * So:
 *     expected = float + Σ(dr − cr) on 1000 while the drawer was open
 *     variance = counted − expected
 *
 * and the variance POSTS, to 6920:
 *     short   Dr 6920 Cash over or short   Cr 1000
 *     over    Dr 1000                      Cr 6920
 *
 * If it did not post, account 1000 would say the restaurant holds cash that is
 * not in the building, permanently, and every balance sheet after tonight would
 * be wrong by tonight's mistake.
 *
 * THE FLOAT POSTS NOTHING. In this chart the safe and the till are both 1000 —
 * there is no banking module yet — so moving a float from one to the other is a
 * transfer within a single account and posting it would be two lines that
 * cancel. When banking arrives (1000 → 1010) the float becomes a real movement
 * and this is where it goes.
 */

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);

/** Open the register. One open drawer per outlet at a time: two would each
 *  claim the same cash movements and both reconcile wrongly. */
async function open(c, p, ctx) {
  const float = toLaari(p.float || 0);
  if (float < 0) throw Object.assign(new Error('a float cannot be negative'), { status: 400 });

  const already = await c.query(
    'SELECT id, opened_at FROM drawer_session WHERE closed_at IS NULL ORDER BY opened_at LIMIT 1');
  if (already.rows.length) {
    throw Object.assign(
      new Error('the register is already open — close it before opening another'),
      { status: 409 });
  }

  const q = await c.query(
    'INSERT INTO drawer_session (opened_by, float_amount, device_id)'
    + ' VALUES ($1,$2,$3) RETURNING id, opened_at',
    [ctx.actor, toMVR(float), ctx.deviceId]);

  await c.query("SELECT chain.log('drawer_open','drawer_session',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ float: toMVR(float) })]);

  return { drawerId: q.rows[0].id, openedAt: q.rows[0].opened_at, float: toMVR(float) };
}

/** What the ledger says passed through the drawer while it was open. */
async function cashMovement(c, openedAt, until) {
  const q = await c.query(
    'SELECT coalesce(sum(l.dr - l.cr), 0) AS net'
    + ' FROM journal_line l JOIN journal j ON j.id = l.journal_id'
    + " WHERE l.account_code = '1000' AND j.posted_at >= $1 AND j.posted_at <= $2",
    [openedAt, until]);
  return toLaari(q.rows[0].net);
}

/**
 * Close and count. `counted` is what the cashier physically counted.
 *
 * p = { drawerId?, counted }
 */
async function close(c, p, ctx) {
  if (p.counted === undefined || p.counted === null) {
    throw Object.assign(new Error('count the drawer before closing it'), { status: 400 });
  }
  const counted = toLaari(p.counted);
  if (counted < 0) throw Object.assign(new Error('a count cannot be negative'), { status: 400 });

  /* FOR UPDATE, and the closed_at guard is in the WHERE clause of the update
     below rather than in a read-then-write: two terminals closing the same
     drawer at once would otherwise both compute a variance and both post one. */
  const sel = p.drawerId
    ? await c.query('SELECT id, opened_at, float_amount FROM drawer_session'
      + ' WHERE id = $1 AND closed_at IS NULL FOR UPDATE', [p.drawerId])
    : await c.query('SELECT id, opened_at, float_amount FROM drawer_session'
      + ' WHERE closed_at IS NULL ORDER BY opened_at FOR UPDATE');
  if (!sel.rows.length) {
    throw Object.assign(new Error('no open register to close'), { status: 409 });
  }
  const d = sel.rows[0];

  /* Measured BEFORE the variance journal exists, or the correction would be
     counted as part of what it is correcting. */
  const now = new Date();
  const moved = await cashMovement(c, d.opened_at, now);
  const float = toLaari(d.float_amount);
  const expected = float + moved;
  const variance = counted - expected;      // signed: positive = over

  const upd = await c.query(
    'UPDATE drawer_session SET closed_at = $2, closed_by = $3, counted = $4,'
    + ' expected = $5, variance = $6 WHERE id = $1 AND closed_at IS NULL RETURNING id',
    [d.id, now, ctx.actor, toMVR(counted), toMVR(expected), toMVR(variance)]);
  if (!upd.rows.length) {
    throw Object.assign(new Error('that register was closed by someone else'), { status: 409 });
  }

  if (variance !== 0) {
    const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
    const h = await c.query(
      'INSERT INTO journal (jv_no, entry_date, memo, source, source_id, posted_by)'
      + " VALUES ($1, $2::date, $3, 'drawer', $4, $5) RETURNING id",
      [no.rows[0].no, now.toISOString().slice(0, 10),
        'Drawer ' + (variance > 0 ? 'over' : 'short') + ' — counted ' + toMVR(counted)
          + ' against ' + toMVR(expected),
        d.id, ctx.actor]);
    const amt = toMVR(Math.abs(variance));
    // Over: there is more cash than the books say, so cash goes up.
    const dr = variance > 0 ? '1000' : '6920';
    const cr = variance > 0 ? '6920' : '1000';
    await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,$3,0)',
      [h.rows[0].id, dr, amt]);
    await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,0,$3)',
      [h.rows[0].id, cr, amt]);
  }

  await c.query("SELECT chain.log('drawer_close','drawer_session',$1,NULL,$2)",
    [d.id, JSON.stringify({
      counted: toMVR(counted), expected: toMVR(expected), variance: toMVR(variance),
    })]);

  return {
    drawerId: d.id,
    float: toMVR(float),
    takings: toMVR(moved),
    expected: toMVR(expected),
    counted: toMVR(counted),
    variance: toMVR(variance),
    // Named for the person reading it, not for the sign of a number.
    verdict: variance === 0 ? 'exact' : variance > 0 ? 'over' : 'short',
  };
}

/** The drawer the till is currently working, with its running expected figure
 *  so a cashier can see where they stand before they count. */
async function current(c) {
  const q = await c.query(
    'SELECT d.id, d.opened_at, d.float_amount, st.name AS opened_by_name'
    + ' FROM drawer_session d LEFT JOIN chain.staff st ON st.id = d.opened_by'
    + ' WHERE d.closed_at IS NULL ORDER BY d.opened_at LIMIT 1');
  if (!q.rows.length) return { open: false };
  const d = q.rows[0];
  const moved = await cashMovement(c, d.opened_at, new Date());
  const float = toLaari(d.float_amount);
  return {
    open: true,
    drawerId: d.id,
    openedAt: d.opened_at,
    openedBy: d.opened_by_name || null,
    float: toMVR(float),
    takings: toMVR(moved),
    expected: toMVR(float + moved),
  };
}

/** Every drawer session that belongs to a day, for the Z-read.
 *
 *  A session is dated by when it CLOSED — that is when its cash was counted and
 *  its variance posted — and an open one by when it started, so a register left
 *  open shows up on the day it was opened rather than nowhere. The day boundary
 *  is the database's own; a true business day that ends at 3am belongs with the
 *  day-close work and is not being faked here. */
async function sessionsOn(c, date) {
  const q = await c.query(
    'SELECT d.id, d.opened_at, d.closed_at, d.float_amount, d.counted, d.expected,'
    + ' d.variance, o.name AS opened_by_name, cl.name AS closed_by_name'
    + ' FROM drawer_session d'
    + ' LEFT JOIN chain.staff o ON o.id = d.opened_by'
    + ' LEFT JOIN chain.staff cl ON cl.id = d.closed_by'
    + ' WHERE d.closed_at::date = $1::date'
    + '    OR (d.closed_at IS NULL AND d.opened_at::date = $1::date)'
    + ' ORDER BY d.opened_at', [date]);
  return q.rows.map((r) => ({
    id: r.id, openedAt: r.opened_at, closedAt: r.closed_at,
    openedBy: r.opened_by_name || null, closedBy: r.closed_by_name || null,
    float: r.float_amount === null ? null : Number(r.float_amount),
    counted: r.counted === null ? null : Number(r.counted),
    expected: r.expected === null ? null : Number(r.expected),
    variance: r.variance === null ? null : Number(r.variance),
    stillOpen: r.closed_at === null,
  }));
}

module.exports = { open, close, current, sessionsOn };
