'use strict';
/* Operating Costs — 02-POS-SPEC.md §2 (`opcosts`): "All 16 expense categories,
 * recurring costs, overhead allocation." 08-BUILD-STAGES §18.
 *
 * Everything below gross profit has so far arrived as a SIDE EFFECT of
 * something else: cost of sales from a sale, wages from a payroll run, variance
 * from a stock count. Rent, electricity, the licence and the pest contract have
 * had accounts in the chart since day one and no way to reach them, so net
 * profit has been gross profit minus whatever happened to post.
 *
 * WHAT THIS SCREEN WILL NOT LET YOU TYPE is as important as what it will. An
 * expense screen that accepted a wage would double-count payroll, and nothing
 * downstream would ever say so — the trial balance would still balance, because
 * a duplicate is self-consistent. So the categories are split: the ones an
 * operator enters, and the ones another module owns, listed with the module
 * that owns them rather than silently missing.
 *
 * A RECURRING COST IS A SCHEDULE, NOT A REMINDER. Rent falls due on the first
 * whether or not anybody opens this screen, and a system that only knows about
 * costs somebody remembered to type produces a P&L that flatters every month
 * nobody was paying attention. `due()` computes what a schedule owes for a
 * period from the schedule itself; posting is idempotent on (schedule, period),
 * so pressing the button twice cannot charge the rent twice.
 *
 * A SPREAD COST IS THE OVERHEAD ALLOCATION. An annual licence paid in January
 * is not January's cost — it is a twelfth of it, twelve times. Charged where it
 * was paid, January reads as a disaster and the other eleven read better than
 * they were, and a restaurant managing by monthly P&L acts on both. So it is
 * capitalised to 1200 Prepaid expenses and released a period at a time.
 */

const { post: postJournal } = require('./journal');

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;

/* Expense accounts an operator ENTERS here. Deliberately not every expense
   account in the chart — see the header. */
const OWNED_ELSEWHERE = {
  5000: 'a sale, through its recipe',
  5010: 'a sale, through its recipe',
  5100: 'wastage and stock counts',
  6000: 'a payroll run',
  6010: 'a payroll run',
  6300: 'the asset register',
  6910: 'cash rounding on a bill',
  6920: 'counting the drawer',
};

async function categories(c) {
  const q = await c.query(
    "SELECT code, name FROM account WHERE type = 'expense' ORDER BY code");
  const enterable = [];
  const elsewhere = [];
  for (const r of q.rows) {
    (OWNED_ELSEWHERE[r.code] ? elsewhere : enterable)
      .push({ code: r.code, name: r.name, postedBy: OWNED_ELSEWHERE[r.code] || null });
  }
  return { enterable, elsewhere };
}

/* ── one-off costs ───────────────────────────────────────────────────────── */

async function record(c, p, ctx) {
  const account = String(p.account || '');
  if (OWNED_ELSEWHERE[account]) {
    throw Object.assign(new Error(
      'that category is posted by ' + OWNED_ELSEWHERE[account]
      + ' — entering it here would count it twice'), { status: 409 });
  }
  const ok = await c.query(
    "SELECT code, name FROM account WHERE code = $1 AND type = 'expense'", [account]);
  if (!ok.rows.length) {
    throw Object.assign(new Error('no such expense category'), { status: 404 });
  }

  const amount = toLaari(p.amount || 0);
  if (!(amount > 0)) {
    throw Object.assign(new Error('an amount above zero, please'), { status: 400 });
  }
  const on = String(p.spentOn || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    throw Object.assign(new Error('spentOn must be YYYY-MM-DD'), { status: 400 });
  }
  const method = ['cash', 'bank', 'credit'].includes(p.method) ? p.method : 'credit';
  const spread = p.spreadMonths ? Number(p.spreadMonths) : null;
  if (spread !== null && (!Number.isInteger(spread) || spread < 2 || spread > 60)) {
    throw Object.assign(new Error('spread over 2 to 60 months, or not at all'), { status: 400 });
  }

  const ins = await c.query(
    'INSERT INTO expense (spent_on, account_code, amount, supplier_id, note, method,'
    + ' recurring_id, period_key, spread_months, by_staff)'
    + ' VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10)'
    + ' ON CONFLICT (recurring_id, period_key) DO NOTHING RETURNING id',
    [on, account, toMVR(amount), p.supplierId || null,
      p.note ? String(p.note).slice(0, 200) : null, method,
      p.recurringId || null, p.periodKey || null, spread, ctx.actor]);
  if (!ins.rows.length) {
    /* A schedule already posted this period. Idempotent by the unique key, not
       by a read-then-write, so pressing the button twice cannot charge the rent
       twice even from two terminals. */
    return { already: true, account, periodKey: p.periodKey };
  }
  const id = ins.rows[0].id;

  /* The journal. A SPREAD cost capitalises to 1200 and hits no expense account
     yet; an ordinary one goes straight to its category. */
  await postJournal(c, {
    date: on,
    memo: (spread ? 'Prepaid — ' : '') + ok.rows[0].name
      + (p.note ? ' — ' + String(p.note).slice(0, 120) : ''),
    source: 'expense', sourceId: id,
    lines: [
      { account: spread ? '1200' : account, dr: amount, cr: 0 },
      { account: method === 'cash' ? '1000' : method === 'bank' ? '1010' : '2000',
        dr: 0, cr: amount },
    ],
  }, ctx);

  await c.query("SELECT chain.log('expense_record','expense',$1,NULL,$2)",
    [id, JSON.stringify({ account, amount: toMVR(amount), method, spread })]);

  return {
    id, account, name: ok.rows[0].name, amount: money(amount / 100),
    spentOn: on, method, spreadMonths: spread,
    message: spread
      ? 'Held on 1200 Prepaid expenses and released over ' + spread
        + ' months — it is not all this month\'s cost.'
      : undefined,
  };
}

/**
 * Release one month of every spread cost that still owes one, into the period
 * given. Dr the category, Cr 1200.
 *
 * p = { period } — 'YYYY-MM'
 *
 * IDEMPOTENT PER PERIOD, and that is not a nicety. Without it, running the
 * month-end release twice charges the month twice and every downstream figure
 * agrees with itself — the trial balance still balances, because a duplicate
 * always does. `released_upto` is the last period each cost has been released
 * for, so a second run in the same month finds nothing to do.
 */
async function release(c, p, ctx) {
  const period = String(p.period || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw Object.assign(new Error('period must be YYYY-MM'), { status: 400 });
  }
  /* The LAST day of the period, for both the cutoff and the entry date. Dated
     the 1st, the cutoff missed every cost paid later in its own month — a
     licence bought on the 14th sat on 1200 untouched — and the release would
     have been dated before the capitalisation it releases. */
  const [yy, mm] = period.split('-').map(Number);
  const date = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);

  const due = await c.query(
    'SELECT e.id, e.account_code, e.amount, e.spread_months, e.released_months,'
    + ' a.name FROM expense e JOIN account a ON a.code = e.account_code'
    + ' WHERE e.spread_months IS NOT NULL AND e.released_months < e.spread_months'
    + '   AND e.spent_on <= $1::date'
    + '   AND (e.released_upto IS NULL OR e.released_upto < $2)'
    + ' FOR UPDATE OF e', [date, period]);

  const released = [];
  for (const r of due.rows) {
    const total = toLaari(r.amount);
    const n = r.spread_months;
    const already = r.released_months;
    /* The LAST release takes the remainder, so twelve monthly slices of an
       amount that does not divide by twelve still add up to the amount. Twelve
       equal roundings would leave a few laari stranded on 1200 for ever. */
    const slice = already === n - 1
      ? total - Math.round(total / n) * (n - 1)
      : Math.round(total / n);

    await postJournal(c, {
      date, memo: 'Monthly share — ' + r.name,
      source: 'expense', sourceId: r.id,
      lines: [
        { account: r.account_code, dr: slice, cr: 0 },
        { account: '1200', dr: 0, cr: slice },
      ],
    }, ctx);
    await c.query('UPDATE expense SET released_months = released_months + 1,'
      + ' released_upto = $2 WHERE id = $1', [r.id, period]);
    released.push({
      id: r.id, account: r.account_code, name: r.name,
      amount: money(slice / 100), month: already + 1, of: n,
    });
  }

  if (released.length) {
    await c.query("SELECT chain.log('expense_release','expense',$1,NULL,$2)",
      [released[0].id, JSON.stringify({ period, count: released.length })]);
  }
  return { period, released, total: money(released.reduce((a, r) => a + r.amount, 0)) };
}

/* ── recurring ───────────────────────────────────────────────────────────── */

async function schedules(c) {
  const q = await c.query(
    'SELECT r.*, a.name AS account_name, s.name AS supplier'
    + ' FROM recurring_cost r'
    + ' JOIN account a ON a.code = r.account_code'
    + ' LEFT JOIN chain.supplier s ON s.id = r.supplier_id'
    + ' ORDER BY r.active DESC, a.name');
  return q.rows.map((r) => ({
    id: r.id, account: r.account_code, accountName: r.account_name,
    amount: money(r.amount), cadence: r.cadence, dueDay: r.due_day,
    startsOn: r.starts_on, endsOn: r.ends_on, supplier: r.supplier,
    note: r.note, method: r.method, spreadMonths: r.spread_months, active: r.active,
    /* What it costs a year, so two schedules on different cadences can be
       compared. A weekly 500 and a monthly 2,000 are not the same cost and a
       list that shows only the figures makes them look it. */
    annualised: money(Number(r.amount)
      * (r.cadence === 'weekly' ? 52 : r.cadence === 'monthly' ? 12 : 1)),
  }));
}

async function setSchedule(c, p, ctx) {
  const account = String(p.account || '');
  if (OWNED_ELSEWHERE[account]) {
    throw Object.assign(new Error(
      'that category is posted by ' + OWNED_ELSEWHERE[account]), { status: 409 });
  }
  const cadence = ['weekly', 'monthly', 'annual'].includes(p.cadence) ? p.cadence : 'monthly';
  const amount = toLaari(p.amount || 0);
  if (!(amount > 0)) {
    throw Object.assign(new Error('an amount above zero, please'), { status: 400 });
  }
  const max = cadence === 'weekly' ? 7 : cadence === 'monthly' ? 31 : 366;
  const dueDay = Number(p.dueDay);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > max) {
    throw Object.assign(new Error('due day must be 1 to ' + max + ' for a '
      + cadence + ' cost'), { status: 400 });
  }
  const starts = String(p.startsOn || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(starts)) {
    throw Object.assign(new Error('startsOn must be YYYY-MM-DD'), { status: 400 });
  }

  const q = await c.query(
    'INSERT INTO recurring_cost (account_code, amount, cadence, due_day, starts_on,'
    + ' ends_on, supplier_id, note, method, spread_months, set_by)'
    + ' VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11) RETURNING id',
    [account, toMVR(amount), cadence, dueDay, starts, p.endsOn || null,
      p.supplierId || null, p.note ? String(p.note).slice(0, 200) : null,
      ['cash', 'bank', 'credit'].includes(p.method) ? p.method : 'credit',
      p.spreadMonths ? Number(p.spreadMonths) : null, ctx.actor]);

  await c.query("SELECT chain.log('recurring_set','recurring_cost',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ account, amount: toMVR(amount), cadence })]);
  return { id: q.rows[0].id, account, amount: money(amount / 100), cadence, dueDay };
}

async function stopSchedule(c, id, ctx) {
  const q = await c.query(
    'UPDATE recurring_cost SET active = false WHERE id = $1 RETURNING id', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such schedule'), { status: 404 });
  await c.query("SELECT chain.log('recurring_stop','recurring_cost',$1,NULL,NULL)", [id]);
  return { id, active: false };
}

/**
 * What every schedule owes, up to a date, that has not been posted.
 *
 * Computed FROM THE SCHEDULE rather than from a diary: a cost is due because
 * the calendar says so, not because somebody opened this screen on the day.
 */
async function due(c, upTo) {
  const to = new Date(upTo + 'T00:00:00Z');
  const q = await c.query(
    'SELECT r.*, a.name AS account_name FROM recurring_cost r'
    + ' JOIN account a ON a.code = r.account_code'
    + ' WHERE r.active AND r.starts_on <= $1::date'
    + '   AND (r.ends_on IS NULL OR r.ends_on >= r.starts_on)', [upTo]);

  const owing = [];
  for (const r of q.rows) {
    const posted = await c.query(
      'SELECT period_key FROM expense WHERE recurring_id = $1', [r.id]);
    const seen = new Set(posted.rows.map((x) => x.period_key));

    for (const p of periodsFor(r, to)) {
      if (seen.has(p.key)) continue;
      owing.push({
        recurringId: r.id, account: r.account_code, accountName: r.account_name,
        amount: money(r.amount), periodKey: p.key, dueOn: p.date,
        cadence: r.cadence, method: r.method, note: r.note,
        spreadMonths: r.spread_months,
        /* How late it is. A cost three months overdue is a different
           conversation from one due yesterday, and a list that sorts by date
           without saying so buries it. */
        daysLate: Math.max(0, Math.round((to - new Date(p.date + 'T00:00:00Z')) / 86400000)),
      });
    }
  }
  owing.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
  return owing;
}

/** Every period this schedule has reached, from its start up to `to`. */
function periodsFor(r, to) {
  const out = [];
  const start = new Date(r.starts_on);
  const end = r.ends_on && new Date(r.ends_on) < to ? new Date(r.ends_on) : to;
  /* Bounded: a schedule starting in 1990 must not spin out 1,800 rows. Anything
     older than this is a data-entry mistake, not a debt. */
  const LIMIT = 120;

  if (r.cadence === 'weekly') {
    const d = new Date(start);
    // Move to the first occurrence of the weekday on or after the start.
    const want = r.due_day % 7;                  // 7 (Sunday) → 0
    while (d.getUTCDay() !== want) d.setUTCDate(d.getUTCDate() + 1);
    while (d <= end && out.length < LIMIT) {
      out.push({ key: iso(d), date: iso(d) });
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return out;
  }

  if (r.cadence === 'monthly') {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (d <= end && out.length < LIMIT) {
      // A 31st in a 30-day month falls on the last day, not into the next one.
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const on = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),
        Math.min(r.due_day, last)));
      if (on >= start && on <= end) {
        out.push({ key: on.toISOString().slice(0, 7), date: iso(on) });
      }
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
  }

  // annual
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear() && out.length < LIMIT; y++) {
    const on = new Date(Date.UTC(y, 0, 1));
    on.setUTCDate(r.due_day);
    if (on >= start && on <= end) out.push({ key: String(y), date: iso(on) });
  }
  return out;
}

const iso = (d) => d.toISOString().slice(0, 10);

/* ── reads ───────────────────────────────────────────────────────────────── */

async function list(c, from, to) {
  const q = await c.query(
    'SELECT e.*, a.name AS account_name, s.name AS supplier, st.name AS by_name'
    + ' FROM expense e JOIN account a ON a.code = e.account_code'
    + ' LEFT JOIN chain.supplier s ON s.id = e.supplier_id'
    + ' LEFT JOIN chain.staff st ON st.id = e.by_staff'
    + ' WHERE ($1::date IS NULL OR e.spent_on >= $1::date)'
    + '   AND ($2::date IS NULL OR e.spent_on <= $2::date)'
    + ' ORDER BY e.spent_on DESC, e.at DESC LIMIT 200', [from || null, to || null]);

  const rows = q.rows.map((r) => ({
    id: r.id, spentOn: r.spent_on, account: r.account_code, accountName: r.account_name,
    amount: money(r.amount), method: r.method, note: r.note,
    supplier: r.supplier, by: r.by_name || null,
    fromSchedule: r.recurring_id !== null,
    spreadMonths: r.spread_months, releasedMonths: r.released_months,
    /* A spread cost's figure is NOT this period's cost, and a list that showed
       it beside ordinary expenses without saying so would be adding up two
       different things. */
    thisPeriod: r.spread_months
      ? money(Number(r.amount) / r.spread_months) : money(r.amount),
    stillPrepaid: r.spread_months
      ? money(Number(r.amount) * (1 - r.released_months / r.spread_months)) : 0,
  }));

  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.account)) {
      byCategory.set(r.account, { account: r.account, name: r.accountName, total: 0, count: 0 });
    }
    const b = byCategory.get(r.account);
    b.total = money(b.total + r.thisPeriod);
    b.count += 1;
  }

  return {
    expenses: rows,
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    total: money(rows.reduce((a, r) => a + r.thisPeriod, 0)),
    prepaid: money(rows.reduce((a, r) => a + r.stillPrepaid, 0)),
  };
}


module.exports = {
  categories, record, release, schedules, setSchedule, stopSchedule, due, list,
  OWNED_ELSEWHERE,
};
