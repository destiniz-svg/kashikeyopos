'use strict';
/* Staff & Time Clock — 02-POS-SPEC.md §2 (`staff`):
 * "Roster, clock in/out, rank assignment."
 *
 * Two things live here that are usually separate screens, and they belong
 * together: who works here and what rank they hold, and who is actually in the
 * building right now. A rota nobody clocks against is a wish, and a clock with
 * no roster behind it cannot tell you who forgot to press the button.
 *
 * RANK IS THE ONLY GATE IN THIS SYSTEM — Kitchen 1, Till 2, Manager 3, Admin 4,
 * Owner 5 — so the screen that assigns it is the most dangerous one in the
 * build. Three rules, and the first two are enforced by the DATABASE, not here:
 *
 *   · Writing chain.staff needs rank 4 (`staff_write` policy).
 *   · Nobody may create or promote ABOVE THEIR OWN RANK. The policy says
 *     `rank <= app.current_rank()`, so an admin cannot mint an owner. Without
 *     that, rank 4 is rank 5 with one extra click.
 *   · A PIN never arrives or leaves in the clear, is never stored, and is never
 *     shown again after it is set. It is scrypt'd with a per-row salt, and a
 *     separate keyed lookup makes sign-in fast without making the hash
 *     guessable offline (migration 007).
 *
 * THE CLOCK IS RANK 1. A kitchen hand clocks themselves in at 6am, and a system
 * that needed a manager present to start a shift would be a system people work
 * around with a notebook. Clocking somebody ELSE is a manager's act and is
 * recorded as theirs.
 */

const { hashPin, pinLookup } = require('./secrets');

const CLOCK_OTHERS_RANK = 3;

/* A shift open for longer than this was almost certainly never closed — the
   person went home and the clock kept running. It is surfaced rather than
   auto-closed: guessing when somebody left is inventing a payroll figure. */
const RUNAWAY_HOURS = 16;

const hours = (from, to) =>
  Math.round(((new Date(to).getTime() - new Date(from).getTime()) / 3600000) * 100) / 100;

/* ── the roster ──────────────────────────────────────────────────────────── */

const RANK_NAME = { 1: 'Kitchen', 2: 'Till', 3: 'Manager', 4: 'Admin', 5: 'Owner' };

async function roster(c, outletId) {
  const [people, open, week] = await Promise.all([
    c.query('SELECT id, name, rank, active, locked_until, failed FROM chain.staff'
      + ' WHERE outlet_id = $1 ORDER BY rank DESC, name', [outletId]),
    c.query('SELECT staff_id, id, in_at FROM shift WHERE out_at IS NULL'),
    /* Hours over the last seven days, which is the window a manager actually
       manages — a running total since the beginning of time is a number nobody
       can do anything about. */
    c.query('SELECT staff_id,'
      + ' coalesce(sum(extract(epoch FROM (out_at - in_at))) / 3600, 0) AS hrs,'
      + ' count(*)::int AS shifts'
      + " FROM shift WHERE out_at IS NOT NULL AND in_at > now() - interval '7 days'"
      + ' GROUP BY staff_id'),
  ]);

  const openBy = new Map(open.rows.map((r) => [r.staff_id, r]));
  const weekBy = new Map(week.rows.map((r) => [r.staff_id, r]));
  const now = Date.now();

  return people.rows.map((r) => {
    const o = openBy.get(r.id);
    const w = weekBy.get(r.id);
    const onSince = o ? o.in_at : null;
    return {
      id: r.id, name: r.name, rank: r.rank, rankName: RANK_NAME[r.rank] || String(r.rank),
      active: r.active,
      // A lockout in the past is not a lockout; it has expired and the person
      // can sign in. Reporting it would send a manager looking for a problem
      // that solved itself fifteen minutes ago.
      lockedUntil: r.locked_until && new Date(r.locked_until).getTime() > now
        ? r.locked_until : null,
      failedAttempts: r.failed,
      onShift: Boolean(o),
      shiftId: o ? o.id : null,
      onSince,
      onFor: onSince ? hours(onSince, new Date()) : null,
      runaway: Boolean(onSince && hours(onSince, new Date()) > RUNAWAY_HOURS),
      weekHours: w ? Math.round(Number(w.hrs) * 100) / 100 : 0,
      weekShifts: w ? w.shifts : 0,
    };
  });
}

/** Every shift on a day, for the manager who has to answer "who was in?". */
async function shifts(c, date) {
  const q = await c.query(
    'SELECT s.id, s.staff_id, st.name, st.rank, s.in_at, s.out_at, s.note,'
    + ' ib.name AS in_by_name, ob.name AS out_by_name'
    + ' FROM shift s'
    + ' LEFT JOIN chain.staff st ON st.id = s.staff_id'
    + ' LEFT JOIN chain.staff ib ON ib.id = s.in_by'
    + ' LEFT JOIN chain.staff ob ON ob.id = s.out_by'
    + ' WHERE s.in_at::date = $1::date OR s.out_at::date = $1::date'
    + '    OR (s.out_at IS NULL AND s.in_at::date <= $1::date)'
    + ' ORDER BY s.in_at', [date]);

  const rows = q.rows.map((r) => ({
    id: r.id, staffId: r.staff_id, name: r.name || 'a removed member of staff',
    rank: r.rank, inAt: r.in_at, outAt: r.out_at, note: r.note,
    hours: r.out_at ? hours(r.in_at, r.out_at) : null,
    open: r.out_at === null,
    /* Attribution is only interesting when it is NOT the person themselves —
       "clocked in by Aishath" says something; "clocked in by themselves" is
       noise on every row. */
    inBy: r.in_by_name && r.in_by !== r.staff_id ? r.in_by_name : null,
    outBy: r.out_by_name && r.out_by !== r.staff_id ? r.out_by_name : null,
  }));

  return {
    date,
    shifts: rows,
    totalHours: Math.round(rows.reduce((a, r) => a + (r.hours || 0), 0) * 100) / 100,
    stillOpen: rows.filter((r) => r.open).length,
  };
}

/* ── the clock ───────────────────────────────────────────────────────────── */

/**
 * Clock in. `staffId` defaults to the caller — clocking somebody ELSE needs
 * manager rank, and is recorded as the manager's act.
 *
 * p = { staffId?, note? }
 */
async function clockIn(c, p, ctx) {
  const staffId = String(p.staffId || ctx.actor || '');
  if (!staffId) throw Object.assign(new Error('who is clocking in?'), { status: 400 });
  if (staffId !== ctx.actor && (ctx.rank || 0) < CLOCK_OTHERS_RANK) {
    throw Object.assign(
      new Error('clocking somebody else in needs rank ' + CLOCK_OTHERS_RANK), { status: 403 });
  }

  const who = await c.query(
    'SELECT id, name, active FROM chain.staff WHERE id = $1 AND outlet_id = $2',
    [staffId, ctx.outletId]);
  if (!who.rows.length) {
    throw Object.assign(new Error('nobody works here under that id'), { status: 404 });
  }
  if (!who.rows[0].active) {
    throw Object.assign(new Error(who.rows[0].name + ' has been taken off the roster'), { status: 409 });
  }

  /* ON CONFLICT DO NOTHING against the partial unique index: two terminals
     pressing the button in the same second get one shift, and the second one is
     told they are already on rather than given a duplicate clock. */
  const ins = await c.query(
    'INSERT INTO shift (staff_id, in_by, device_id, note) VALUES ($1,$2,$3,$4)'
    + ' ON CONFLICT DO NOTHING RETURNING id, in_at',
    [staffId, ctx.actor, ctx.deviceId, p.note ? String(p.note).slice(0, 200) : null]);
  if (!ins.rows.length) {
    const open = await c.query(
      'SELECT in_at FROM shift WHERE staff_id = $1 AND out_at IS NULL', [staffId]);
    throw Object.assign(new Error(
      who.rows[0].name + ' is already clocked in, since '
      + new Date(open.rows[0].in_at).toISOString().slice(11, 16)), { status: 409 });
  }

  await c.query("SELECT chain.log('clock_in','shift',$1,NULL,$2)",
    [ins.rows[0].id, JSON.stringify({ staff: who.rows[0].name })]);

  return {
    shiftId: ins.rows[0].id, staffId, name: who.rows[0].name, inAt: ins.rows[0].in_at,
  };
}

/** Clock out. p = { staffId?, note? } */
async function clockOut(c, p, ctx) {
  const staffId = String(p.staffId || ctx.actor || '');
  if (!staffId) throw Object.assign(new Error('who is clocking out?'), { status: 400 });
  if (staffId !== ctx.actor && (ctx.rank || 0) < CLOCK_OTHERS_RANK) {
    throw Object.assign(
      new Error('clocking somebody else out needs rank ' + CLOCK_OTHERS_RANK), { status: 403 });
  }

  /* The guard is in the WHERE clause, not in a read-then-write: a shift already
     closed by another terminal must not be closed twice with a later time. */
  const upd = await c.query(
    'UPDATE shift SET out_at = now(), out_by = $2,'
    + ' note = coalesce(note, $3) WHERE staff_id = $1 AND out_at IS NULL'
    + ' RETURNING id, in_at, out_at',
    [staffId, ctx.actor, p.note ? String(p.note).slice(0, 200) : null]);
  if (!upd.rows.length) {
    throw Object.assign(new Error('there is no open shift to close'), { status: 409 });
  }

  const worked = hours(upd.rows[0].in_at, upd.rows[0].out_at);
  await c.query("SELECT chain.log('clock_out','shift',$1,NULL,$2)",
    [upd.rows[0].id, JSON.stringify({ hours: worked })]);

  return { shiftId: upd.rows[0].id, staffId, inAt: upd.rows[0].in_at,
    outAt: upd.rows[0].out_at, hours: worked };
}

/* ── the roster, written ─────────────────────────────────────────────────── */

function cleanPin(pin) {
  const v = String(pin || '');
  if (!/^[0-9]{4,12}$/.test(v)) {
    throw Object.assign(new Error('a PIN is 4 to 12 digits'), { status: 400 });
  }
  /* Four identical digits, or a straight run, is the PIN everybody picks and
     the first thing anybody tries. Refused at the point of setting rather than
     reported later, because later means never. */
  if (/^(\d)\1+$/.test(v) || '0123456789'.includes(v) || '9876543210'.includes(v)) {
    throw Object.assign(new Error('that PIN is too easy to guess — try another'), { status: 400 });
  }
  return v;
}

/** p = { name, rank, pin } */
async function addStaff(c, p, ctx) {
  const name = String(p.name || '').trim().slice(0, 120);
  if (!name) throw Object.assign(new Error('a member of staff needs a name'), { status: 400 });
  const rank = Number(p.rank);
  if (!Number.isInteger(rank) || rank < 1 || rank > 5) {
    throw Object.assign(new Error('rank is 1 to 5'), { status: 400 });
  }
  /* Checked here for a readable message; the POLICY is what actually holds the
     line, because a check in application code is a check somebody can forget to
     write on the next endpoint. */
  if (rank > (ctx.rank || 0)) {
    throw Object.assign(
      new Error('you cannot give somebody a rank above your own'), { status: 403 });
  }
  const pin = cleanPin(p.pin);

  const h = hashPin(pin);
  const q = await c.query(
    'INSERT INTO chain.staff (name, rank, outlet_id, pin_hash, pin_salt, pin_lookup)'
    + ' VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, rank, active',
    [name, rank, ctx.outletId, h.hash, h.salt, pinLookup(ctx.outletId, pin)]);

  await c.query("SELECT chain.log('staff_add','staff',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ name, rank })]);

  // The PIN is never returned. Whoever set it knows it; nobody else ever can.
  return { id: q.rows[0].id, name, rank, rankName: RANK_NAME[rank], active: true };
}

/** p = { rank?, active?, pin?, name? } */
async function updateStaff(c, id, p, ctx) {
  const before = await c.query(
    'SELECT id, name, rank, active FROM chain.staff WHERE id = $1 AND outlet_id = $2',
    [id, ctx.outletId]);
  if (!before.rows.length) {
    throw Object.assign(new Error('nobody works here under that id'), { status: 404 });
  }

  const sets = [];
  const args = [id];
  const after = {};

  if (p.name !== undefined) {
    const v = String(p.name).trim().slice(0, 120);
    if (!v) throw Object.assign(new Error('a name cannot be blank'), { status: 400 });
    args.push(v); sets.push('name = $' + args.length); after.name = v;
  }
  if (p.rank !== undefined) {
    const rank = Number(p.rank);
    if (!Number.isInteger(rank) || rank < 1 || rank > 5) {
      throw Object.assign(new Error('rank is 1 to 5'), { status: 400 });
    }
    if (rank > (ctx.rank || 0)) {
      throw Object.assign(
        new Error('you cannot give somebody a rank above your own'), { status: 403 });
    }
    /* And you cannot demote somebody senior to you either — the policy's
       `rank <= app.current_rank()` in USING covers it, but the message here is
       the difference between "403" and knowing why. */
    if (before.rows[0].rank > (ctx.rank || 0)) {
      throw Object.assign(
        new Error('you cannot change somebody ranked above you'), { status: 403 });
    }
    args.push(rank); sets.push('rank = $' + args.length); after.rank = rank;
  }
  if (p.active !== undefined) {
    args.push(Boolean(p.active)); sets.push('active = $' + args.length);
    after.active = Boolean(p.active);
  }
  if (p.pin !== undefined) {
    const pin = cleanPin(p.pin);
    const h = hashPin(pin);
    args.push(h.hash); sets.push('pin_hash = $' + args.length);
    args.push(h.salt); sets.push('pin_salt = $' + args.length);
    args.push(pinLookup(ctx.outletId, pin)); sets.push('pin_lookup = $' + args.length);
    /* Setting a new PIN clears a lockout. Somebody who has forgotten theirs and
       locked the account is exactly who is standing at the counter asking for a
       new one, and leaving them locked out with a working PIN is a support call
       nobody can diagnose. */
    sets.push('failed = 0', 'locked_until = NULL');
    after.pin = 'changed';
  }
  if (!sets.length) throw Object.assign(new Error('nothing to change'), { status: 400 });

  const q = await c.query(
    'UPDATE chain.staff SET ' + sets.join(', ') + ' WHERE id = $1'
    + ' RETURNING id, name, rank, active', [...args]);
  if (!q.rows.length) {
    // The policy refused it — almost always the rank ceiling.
    throw Object.assign(new Error('you are not allowed to change that record'), { status: 403 });
  }

  await c.query("SELECT chain.log('staff_update','staff',$1,$2,$3)",
    [id, JSON.stringify(before.rows[0]), JSON.stringify(after)]);

  const r = q.rows[0];
  return { id: r.id, name: r.name, rank: r.rank, rankName: RANK_NAME[r.rank], active: r.active };
}

/** Release a lockout without changing the PIN — the common case is somebody
 *  fat-fingering five times on a wet screen, not a forgotten PIN. */
async function unlock(c, id, ctx) {
  /* Through a SECURITY DEFINER function, because writing chain.staff is rank 4
     by policy and rightly so — that table decides everybody's rank. Widening
     the policy to rank 3 would have handed managers the whole roster to get
     them one button. See migration 015. */
  const q = await c.query('SELECT * FROM chain.release_lock($1)', [id]);
  if (!q.rows.length) {
    throw Object.assign(new Error('nobody works here under that id'), { status: 404 });
  }
  await c.query("SELECT chain.log('staff_unlock','staff',$1,NULL,$2)",
    [id, JSON.stringify({ name: q.rows[0].name })]);
  return { id: q.rows[0].id, name: q.rows[0].name, locked: false };
}

module.exports = {
  roster, shifts, clockIn, clockOut, addStaff, updateStaff, unlock,
  RANK_NAME, CLOCK_OTHERS_RANK, RUNAWAY_HOURS,
};
