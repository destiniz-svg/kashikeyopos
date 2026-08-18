'use strict';
const { post: postJournal } = require('./journal');
/* Payroll & Pension — 02-POS-SPEC.md §2 (`payroll`): "Runs, pension, posts to
 * 6000 / 2300." 08-BUILD-STAGES.md §19.
 *
 * This is the link that makes PRIME COST true. reports.js has been computing it
 * as cost-of-sales plus 6000/6010 and flagging `labourPosted: false` since the
 * Reports phase, because nothing had ever posted a wage. Prime cost without
 * labour is not a low prime cost; it is an incomplete one, and a restaurant
 * managing against it is managing against half a number.
 *
 * NOTHING IS ENTERED TWICE. A run reads the hours the time clock already
 * recorded. Nobody retypes a timesheet, which is the step where payroll
 * normally acquires its errors.
 *
 * A RUN IS TWO ACTS, NOT ONE.
 *
 *   draft   — calculated from the clock and the rates in force. Nothing has
 *             posted. It can be recalculated, corrected, or thrown away.
 *   posted  — the journal exists and the money is owed. Irreversible.
 *
 * Splitting them is the whole design. Payroll is the one calculation where the
 * inputs (did somebody forget to clock out?) are routinely wrong and the output
 * is somebody's wages. A manager has to be able to look at the figures before
 * they become a liability — and once they are a liability, they stay one.
 *
 * THE JOURNAL:
 *
 *   Dr 6000 Wages              gross
 *   Dr 6010 Staff benefits     employer pension
 *   Cr 2300 Payroll payable    net pay — owed to the staff
 *   Cr 2310 Pension payable    both contributions — owed to the pension office
 *
 * 2310 is separate from 2300 because the two are owed to DIFFERENT PARTIES on
 * different schedules. Lumped together the balance reconciles against neither.
 */

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;

const MIN_RANK = 4;          // payroll is an admin's act, everywhere in this file

/* ── rates ───────────────────────────────────────────────────────────────── */

/** Every rate on record, newest first per person — the history matters, because
 *  a run priced at an old rate has to be explicable a year later. */
async function rates(c) {
  const q = await c.query(
    'SELECT r.id, r.staff_id, s.name, s.rank, r.kind, r.amount, r.effective_from,'
    + ' setter.name AS set_by_name, r.set_at'
    + ' FROM pay_rate r'
    + ' LEFT JOIN chain.staff s ON s.id = r.staff_id'
    + ' LEFT JOIN chain.staff setter ON setter.id = r.set_by'
    + ' ORDER BY s.name, r.effective_from DESC');
  return q.rows.map((r) => ({
    id: r.id, staffId: r.staff_id, name: r.name || 'a removed member of staff',
    rank: r.rank, kind: r.kind, amount: money(r.amount),
    effectiveFrom: r.effective_from, setBy: r.set_by_name || null, setAt: r.set_at,
  }));
}

/** p = { staffId, kind, amount, effectiveFrom } */
async function setRate(c, p, ctx) {
  const staffId = String(p.staffId || '');
  const kind = p.kind === 'monthly' ? 'monthly' : 'hourly';
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error('a rate cannot be negative'), { status: 400 });
  }
  const from = String(p.effectiveFrom || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw Object.assign(new Error('effectiveFrom must be YYYY-MM-DD'), { status: 400 });
  }

  const who = await c.query('SELECT id, name FROM chain.staff WHERE id = $1 AND outlet_id = $2',
    [staffId, ctx.outletId]);
  if (!who.rows.length) {
    throw Object.assign(new Error('nobody works here under that id'), { status: 404 });
  }

  /* A second rate from the same date REPLACES the first — that is a correction
     to a rate that has not been used yet, not a new rate. Two rows for one date
     would make "the rate in force" ambiguous, and the run would silently pick
     whichever the index returned first. */
  await c.query(
    'INSERT INTO pay_rate (staff_id, kind, amount, effective_from, set_by)'
    + ' VALUES ($1,$2,$3,$4::date,$5)'
    + ' ON CONFLICT (staff_id, effective_from) DO UPDATE'
    + ' SET kind = excluded.kind, amount = excluded.amount,'
    + '     set_by = excluded.set_by, set_at = now()',
    [staffId, kind, money(amount), from, ctx.actor]);

  await c.query("SELECT chain.log('pay_rate_set','staff',$1,NULL,$2)",
    [staffId, JSON.stringify({ kind, amount: money(amount), from })]);

  return { staffId, name: who.rows[0].name, kind, amount: money(amount), effectiveFrom: from };
}

/* ── calculating a run ───────────────────────────────────────────────────── */

/**
 * Build a DRAFT run from the clock. Nothing posts.
 *
 * p = { from, to, note? }
 */
async function draft(c, p, ctx, outlet) {
  const from = String(p.from || '');
  const to = String(p.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw Object.assign(new Error('from and to must be YYYY-MM-DD'), { status: 400 });
  }
  if (from > to) throw Object.assign(new Error('from is after to'), { status: 400 });

  const clash = await c.query(
    "SELECT id, status FROM payroll_run WHERE status <> 'draft'"
    + ' AND period_from = $1::date AND period_to = $2::date', [from, to]);
  if (clash.rows.length) {
    throw Object.assign(
      new Error('that period has already been run — a second run would pay everybody twice'),
      { status: 409 });
  }
  // Only one draft at a time for a period; recalculating replaces it.
  await c.query("DELETE FROM payroll_run WHERE status = 'draft'"
    + ' AND period_from = $1::date AND period_to = $2::date', [from, to]);

  /* Hours from the clock, counted against the shifts that ENDED in the period.
     A shift that started on the 31st and ended on the 1st belongs to the period
     it finished in — one rule, applied consistently, so no hour is counted
     twice and none is dropped between two runs.
     An OPEN shift is not paid: it has no end, so it has no hours. It is
     reported instead, because an unclocked shift is somebody not being paid. */
  const worked = await c.query(
    'SELECT s.staff_id, st.name, st.rank,'
    + ' coalesce(sum(extract(epoch FROM (s.out_at - s.in_at))) / 3600, 0) AS hrs,'
    + ' count(*)::int AS shifts'
    + ' FROM shift s LEFT JOIN chain.staff st ON st.id = s.staff_id'
    + ' WHERE s.out_at IS NOT NULL AND s.out_at::date BETWEEN $1::date AND $2::date'
    + ' GROUP BY s.staff_id, st.name, st.rank ORDER BY st.name', [from, to]);

  const openShifts = await c.query(
    'SELECT count(*)::int AS n FROM shift'
    + ' WHERE out_at IS NULL AND in_at::date BETWEEN $1::date AND $2::date', [from, to]);

  /* Everybody on a MONTHLY rate is paid whether or not they clocked — that is
     what monthly means. They are joined in separately so a salaried manager who
     never touches the clock is still on the run. */
  const salaried = await c.query(
    'SELECT DISTINCT ON (r.staff_id) r.staff_id, s.name, s.rank, r.kind, r.amount'
    + ' FROM pay_rate r JOIN chain.staff s ON s.id = r.staff_id'
    + " WHERE r.kind = 'monthly' AND r.effective_from <= $1::date AND s.active"
    + '   AND s.outlet_id = $2'
    + ' ORDER BY r.staff_id, r.effective_from DESC', [to, ctx.outletId]);

  const employeeBp = Number(outlet.pension_employee_bp) || 0;
  const employerBp = Number(outlet.pension_employer_bp) || 0;

  const head = await c.query(
    'INSERT INTO payroll_run (period_from, period_to, run_by, note)'
    + ' VALUES ($1::date,$2::date,$3,$4) RETURNING id',
    [from, to, ctx.actor, p.note ? String(p.note).slice(0, 200) : null]);
  const runId = head.rows[0].id;

  /* Days in the period over days in a month, for a monthly rate. A fortnight is
     half a month's pay; a full calendar month is all of it. Computed from the
     dates rather than assumed to be 30, because February exists. */
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const monthDays = new Date(new Date(to).getFullYear(),
    new Date(to).getMonth() + 1, 0).getDate();

  const seen = new Set();
  const lines = [];
  const unpaid = [];

  const push = async (staffId, name, rank, kind, rateLaari, hrs, shiftCount) => {
    const grossLaari = kind === 'monthly'
      ? Math.round(rateLaari * Math.min(1, days / monthDays))
      : Math.round(rateLaari * hrs);
    // Rounded once each, from the gross — never one from the other.
    const empLaari = Math.round((grossLaari * employeeBp) / 10000);
    const erLaari = Math.round((grossLaari * employerBp) / 10000);
    const netLaari = grossLaari - empLaari;

    await c.query(
      'INSERT INTO payroll_line (run_id, staff_id, kind, rate, hours, shifts,'
      + ' gross, employee_pension, employer_pension, net)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [runId, staffId, kind, toMVR(rateLaari), Math.round(hrs * 100) / 100, shiftCount,
        toMVR(grossLaari), toMVR(empLaari), toMVR(erLaari), toMVR(netLaari)]);

    lines.push({
      staffId, name, rank, kind, rate: money(rateLaari / 100),
      hours: Math.round(hrs * 100) / 100, shifts: shiftCount,
      gross: money(grossLaari / 100), employeePension: money(empLaari / 100),
      employerPension: money(erLaari / 100), net: money(netLaari / 100),
    });
  };

  for (const w of worked.rows) {
    const rate = await rateAsAt(c, w.staff_id, to);
    if (!rate) {
      /* Hours with no rate. NOT paid at zero and not silently dropped: both
         are ways of quietly not paying somebody, and the second is worse
         because nothing on the run says they are missing. */
      unpaid.push({
        staffId: w.staff_id, name: w.name || 'a removed member of staff',
        hours: Math.round(Number(w.hrs) * 100) / 100, shifts: w.shifts,
        why: 'no pay rate on record',
      });
      continue;
    }
    seen.add(w.staff_id);
    await push(w.staff_id, w.name, w.rank, rate.kind, toLaari(rate.amount),
      Number(w.hrs), w.shifts);
  }

  for (const s of salaried.rows) {
    if (seen.has(s.staff_id)) continue;      // already priced from their hours
    await push(s.staff_id, s.name, s.rank, 'monthly', toLaari(s.amount), 0, 0);
  }

  const total = (k) => lines.reduce((a, l) => a + l[k], 0);
  await c.query(
    'UPDATE payroll_run SET gross = $2, employee_pension = $3, employer_pension = $4,'
    + ' net = $5 WHERE id = $1',
    [runId, money(total('gross')), money(total('employeePension')),
      money(total('employerPension')), money(total('net'))]);

  await c.query("SELECT chain.log('payroll_draft','payroll_run',$1,NULL,$2)",
    [runId, JSON.stringify({ from, to, people: lines.length, gross: money(total('gross')) })]);

  return {
    runId, from, to, status: 'draft', lines,
    totals: {
      gross: money(total('gross')),
      employeePension: money(total('employeePension')),
      employerPension: money(total('employerPension')),
      net: money(total('net')),
      cost: money(total('gross') + total('employerPension')),
    },
    /* What the run could not price, and what the clock left running. Both are
       reported ON the draft, because after it posts they are somebody's missing
       wages rather than a question. */
    unpaid,
    openShifts: openShifts.rows[0].n,
    pension: { employeeBp, employerBp, configured: employeeBp > 0 || employerBp > 0 },
  };
}

/** The rate in force on a date. Never "the current rate": a run for February
 *  priced at March's rate restates a period that has already been paid. */
async function rateAsAt(c, staffId, date) {
  const q = await c.query(
    'SELECT kind, amount FROM pay_rate WHERE staff_id = $1 AND effective_from <= $2::date'
    + ' ORDER BY effective_from DESC LIMIT 1', [staffId, date]);
  return q.rows.length ? { kind: q.rows[0].kind, amount: Number(q.rows[0].amount) } : null;
}

/* ── posting ─────────────────────────────────────────────────────────────── */

/** Post a draft: the journal exists and the money is owed. p = { runId } */
async function post(c, p, ctx) {
  const run = await c.query(
    'SELECT * FROM payroll_run WHERE id = $1 FOR UPDATE', [String(p.runId || '')]);
  if (!run.rows.length) throw Object.assign(new Error('no such run'), { status: 404 });
  const r = run.rows[0];
  if (r.status !== 'draft') {
    throw Object.assign(new Error('that run has already been posted'), { status: 409 });
  }

  const grossLaari = toLaari(r.gross);
  const empLaari = toLaari(r.employee_pension);
  const erLaari = toLaari(r.employer_pension);
  const netLaari = toLaari(r.net);
  if (!grossLaari) {
    throw Object.assign(new Error('there is nothing to pay on this run'), { status: 409 });
  }

  const lines = [{ account: '6000', dr: grossLaari, cr: 0 }];          // wages
  if (erLaari) lines.push({ account: '6010', dr: erLaari, cr: 0 });    // employer pension
  lines.push({ account: '2300', dr: 0, cr: netLaari });                // owed to the staff
  if (empLaari + erLaari) {                            // owed to the pension office
    lines.push({ account: '2310', dr: 0, cr: empLaari + erLaari });
  }
  const jv = await postJournal(c, {
    date: r.period_to,
    memo: 'Payroll ' + r.period_from.toISOString().slice(0, 10)
      + ' to ' + r.period_to.toISOString().slice(0, 10),
    source: 'payroll', sourceId: r.id, lines,
  }, ctx);

  await c.query(
    "UPDATE payroll_run SET status = 'posted', posted_by = $2, posted_at = now()"
    + ' WHERE id = $1', [r.id, ctx.actor]);

  await c.query("SELECT chain.log('payroll_post','payroll_run',$1,NULL,$2)",
    [r.id, JSON.stringify({ gross: r.gross, net: r.net, jv: jv.no })]);

  return {
    runId: r.id, status: 'posted', jvNo: jv.no,
    gross: money(r.gross), net: money(r.net),
    owedToStaff: money(r.net),
    owedToPension: money(Number(r.employee_pension) + Number(r.employer_pension)),
  };
}

/** Pay the net. Dr 2300, Cr the money. p = { runId, method? } */
async function pay(c, p, ctx) {
  const run = await c.query(
    'SELECT * FROM payroll_run WHERE id = $1 FOR UPDATE', [String(p.runId || '')]);
  if (!run.rows.length) throw Object.assign(new Error('no such run'), { status: 404 });
  const r = run.rows[0];
  if (r.status !== 'posted') {
    throw Object.assign(new Error(
      r.status === 'paid' ? 'that run has already been paid'
        : 'post the run before paying it'), { status: 409 });
  }

  const method = p.method === 'cash' ? 'cash' : 'bank';
  const netLaari = toLaari(r.net);
  await postJournal(c, {
    date: new Date().toISOString().slice(0, 10),
    memo: 'Wages paid — ' + r.period_from.toISOString().slice(0, 10)
      + ' to ' + r.period_to.toISOString().slice(0, 10),
    source: 'payroll', sourceId: r.id,
    lines: [
      { account: '2300', dr: netLaari, cr: 0 },
      { account: method === 'cash' ? '1000' : '1010', dr: 0, cr: netLaari },
    ],
  }, ctx);

  await c.query("UPDATE payroll_run SET status = 'paid', paid_at = now() WHERE id = $1", [r.id]);
  await c.query("SELECT chain.log('payroll_pay','payroll_run',$1,NULL,$2)",
    [r.id, JSON.stringify({ net: r.net, method })]);

  /* The PENSION is deliberately still outstanding on 2310. It is owed to
     somebody else on their own schedule, and clearing it here would be
     recording a payment nobody made. */
  return { runId: r.id, status: 'paid', paid: money(r.net), method };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

async function runs(c, limit) {
  const q = await c.query(
    'SELECT r.id, r.period_from, r.period_to, r.status, r.gross, r.employee_pension,'
    + ' r.employer_pension, r.net, r.note, r.run_at, r.posted_at, r.paid_at,'
    + ' rb.name AS run_by_name, pb.name AS posted_by_name,'
    + ' (SELECT count(*)::int FROM payroll_line l WHERE l.run_id = r.id) AS people'
    + ' FROM payroll_run r'
    + ' LEFT JOIN chain.staff rb ON rb.id = r.run_by'
    + ' LEFT JOIN chain.staff pb ON pb.id = r.posted_by'
    + " ORDER BY (r.status = 'draft') DESC, r.period_to DESC LIMIT $1",
    [Math.min(Math.max(Number(limit) || 24, 1), 100)]);
  return q.rows.map((r) => ({
    id: r.id, from: r.period_from, to: r.period_to, status: r.status,
    gross: money(r.gross), employeePension: money(r.employee_pension),
    employerPension: money(r.employer_pension), net: money(r.net),
    cost: money(Number(r.gross) + Number(r.employer_pension)),
    note: r.note, people: r.people,
    runAt: r.run_at, postedAt: r.posted_at, paidAt: r.paid_at,
    runBy: r.run_by_name || null, postedBy: r.posted_by_name || null,
  }));
}

async function run(c, id) {
  const h = await c.query(
    'SELECT r.*, rb.name AS run_by_name, pb.name AS posted_by_name FROM payroll_run r'
    + ' LEFT JOIN chain.staff rb ON rb.id = r.run_by'
    + ' LEFT JOIN chain.staff pb ON pb.id = r.posted_by WHERE r.id = $1', [id]);
  if (!h.rows.length) throw Object.assign(new Error('no such run'), { status: 404 });

  const lines = await c.query(
    'SELECT l.*, s.name, s.rank FROM payroll_line l'
    + ' LEFT JOIN chain.staff s ON s.id = l.staff_id'
    + ' WHERE l.run_id = $1 ORDER BY s.name', [id]);

  const r = h.rows[0];
  return {
    run: {
      id: r.id, from: r.period_from, to: r.period_to, status: r.status,
      gross: money(r.gross), employeePension: money(r.employee_pension),
      employerPension: money(r.employer_pension), net: money(r.net),
      cost: money(Number(r.gross) + Number(r.employer_pension)),
      note: r.note, runAt: r.run_at, postedAt: r.posted_at, paidAt: r.paid_at,
      runBy: r.run_by_name || null, postedBy: r.posted_by_name || null,
      // Said rather than inferred: whether this is money that is owed.
      owed: r.status !== 'draft',
    },
    lines: lines.rows.map((l) => ({
      staffId: l.staff_id, name: l.name || 'a removed member of staff', rank: l.rank,
      kind: l.kind, rate: money(l.rate), hours: money(l.hours), shifts: l.shifts,
      gross: money(l.gross), employeePension: money(l.employee_pension),
      employerPension: money(l.employer_pension), net: money(l.net),
    })),
  };
}

/** Abandon a draft. Only a draft — a posted run is a liability, and a liability
 *  is corrected with a further entry, never deleted. */
async function discard(c, id, ctx) {
  const q = await c.query(
    "DELETE FROM payroll_run WHERE id = $1 AND status = 'draft' RETURNING id", [id]);
  if (!q.rows.length) {
    throw Object.assign(new Error('only a draft can be thrown away'), { status: 409 });
  }
  await c.query("SELECT chain.log('payroll_discard','payroll_run',$1,NULL,NULL)", [id]);
  return { runId: id, discarded: true };
}

module.exports = { rates, setRate, draft, post, pay, runs, run, discard, rateAsAt, MIN_RANK };
