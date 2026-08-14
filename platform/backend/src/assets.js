'use strict';
/* Equipment & Maintenance — 02-POS-SPEC.md §2 (`assets`): "Asset register,
 * depreciation posting, service schedule." 08-BUILD-STAGES §20.
 *
 * AN OVEN IS NOT AN EXPENSE, and that is the whole reason this module exists
 * rather than a line on the Operating Costs screen. Sixty thousand rufiyaa
 * entered as a cost puts the entire amount in one month: that month reads as a
 * catastrophe, the next five years read as better than they were, a manager
 * paid on monthly numbers is judged on both, and the balance sheet never
 * records that the restaurant owns an oven at all. So it capitalises to 1500
 * and is charged to 6300 a month at a time.
 *
 * DEPRECIATION IS IDEMPOTENT PER (ASSET, PERIOD). Written the obvious way — take
 * the next month's slice — a month-end run pressed twice charges the month
 * twice and every downstream figure agrees with itself, because a duplicate is
 * self-consistent. Nothing would ever tell you. The same guard is on the
 * prepaid release in opcosts.js, and it is here from the first line rather than
 * found later.
 *
 * THE LAST MONTH TAKES THE REMAINDER, so an asset's net book value lands
 * exactly on its residual instead of a few laari either side of it for ever.
 *
 * A SERVICE THAT COST MONEY BOOKS ONE EXPENSE ROW — the same `expense` table
 * the Operating Costs screen writes to — and the service points at it. Two
 * tables would mean two places to type the same repair and two answers to what
 * repairs cost this month. "Nothing is entered twice; a figure captured once
 * travels the chain" is the governing principle, and this is where it would
 * have been easiest to break.
 */

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);

/** The last day of a 'YYYY-MM' period. */
function periodEnd(period) {
  const [y, m] = period.split('-').map(Number);
  return iso(new Date(Date.UTC(y, m, 0)));
}

/**
 * The charge for the NEXT month, given how many have been charged already.
 *
 * The last month takes the remainder: sixty equal roundings of an amount that
 * does not divide by sixty leave a few laari of net book value stranded for
 * ever, and an asset that never quite reaches its residual is one somebody has
 * to explain at every year end.
 */
function slice(costL, residualL, life, done) {
  if (done >= life) return 0;                 // nothing left to charge
  const total = costL - residualL;
  const each = Math.round(total / life);
  return done === life - 1 ? total - each * (life - 1) : each;
}

/* ── the register ────────────────────────────────────────────────────────── */

async function list(c, opts) {
  const showDisposed = !!(opts && opts.disposed);
  const q = await c.query(
    'SELECT a.*, s.name AS supplier, st.name AS by_name'
    + ' FROM asset a'
    + ' LEFT JOIN chain.supplier s ON s.id = a.supplier_id'
    + ' LEFT JOIN chain.staff st ON st.id = a.by_staff'
    + (showDisposed ? '' : " WHERE a.status = 'active'")
    + ' ORDER BY a.status, a.acquired_on DESC LIMIT 500');

  const services = await c.query(
    'SELECT sv.*, st.name AS done_by_name FROM asset_service sv'
    + ' LEFT JOIN chain.staff st ON st.id = sv.done_by'
    + ' ORDER BY sv.due_on');

  const today = iso(new Date());
  const byAsset = new Map();
  for (const s of services.rows) {
    if (!byAsset.has(s.asset_id)) byAsset.set(s.asset_id, []);
    byAsset.get(s.asset_id).push(s);
  }

  const assets = q.rows.map((a) => {
    const costL = toLaari(a.cost);
    const residualL = toLaari(a.residual);
    const done = a.depreciated_months;
    const accumulatedL = accumulated(costL, residualL, a.life_months, done);
    const mine = byAsset.get(a.id) || [];
    const open = mine.filter((s) => !s.done_on);
    const next = open[0] || null;
    return {
      id: a.id, tag: a.tag, name: a.name, category: a.category,
      acquiredOn: a.acquired_on, cost: money(a.cost), residual: money(a.residual),
      lifeMonths: a.life_months, method: a.method, supplier: a.supplier,
      serial: a.serial, location: a.location, note: a.note, status: a.status,
      by: a.by_name || null,
      monthly: money(slice(costL, residualL, a.life_months, done) / 100),
      depreciatedMonths: done,
      monthsLeft: Math.max(0, a.life_months - done),
      accumulated: money(accumulatedL / 100),
      /* What it is worth on the balance sheet today. The figure an owner
         actually asks for, and the one nobody can work out from a cost and a
         date in their head. */
      netBook: money((costL - accumulatedL) / 100),
      fullyDepreciated: done >= a.life_months,
      disposedOn: a.disposed_on, proceeds: a.proceeds === null ? null : money(a.proceeds),
      services: mine.map((s) => ({
        id: s.id, kind: s.kind, dueOn: s.due_on, everyDays: s.every_days,
        doneOn: s.done_on, doneBy: s.done_by_name || null, note: s.note,
        expenseId: s.expense_id,
        overdue: !s.done_on && s.due_on && iso(new Date(s.due_on)) < today,
      })),
      nextService: next
        ? { id: next.id, kind: next.kind, dueOn: next.due_on,
          overdue: iso(new Date(next.due_on)) < today }
        : null,
    };
  });

  const live = assets.filter((a) => a.status === 'active');
  return {
    assets,
    totals: {
      count: live.length,
      cost: money(live.reduce((s, a) => s + a.cost, 0)),
      netBook: money(live.reduce((s, a) => s + a.netBook, 0)),
      monthly: money(live.filter((a) => !a.fullyDepreciated)
        .reduce((s, a) => s + a.monthly, 0)),
    },
    /* Overdue maintenance is an operations fact before it is a money fact — a
       grease trap nobody serviced is how a kitchen fails an inspection. */
    overdue: assets.flatMap((a) => a.services
      .filter((s) => s.overdue)
      .map((s) => ({ assetId: a.id, name: a.name, kind: s.kind, dueOn: s.dueOn,
        serviceId: s.id, daysLate: Math.max(0, Math.round(
          (new Date(today) - new Date(s.dueOn)) / 86400000)) })))
      .sort((x, y) => (x.dueOn < y.dueOn ? -1 : 1)),
  };
}

/** Σ of every slice charged so far, with the remainder rule applied. */
function accumulated(costL, residualL, life, done) {
  if (done <= 0) return 0;
  if (done >= life) return costL - residualL;
  return Math.round((costL - residualL) / life) * done;
}

/* ── buying one ──────────────────────────────────────────────────────────── */

async function add(c, p, ctx) {
  const name = String(p.name || '').trim();
  if (!name) throw Object.assign(new Error('what is it?'), { status: 400 });

  const cost = toLaari(p.cost || 0);
  if (!(cost > 0)) throw Object.assign(new Error('an amount above zero, please'), { status: 400 });

  const life = Number(p.lifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 600) {
    throw Object.assign(new Error('a life of 1 to 600 months'), { status: 400 });
  }
  const residual = toLaari(p.residual || 0);
  if (residual < 0 || residual >= cost) {
    /* Residual at or above cost means nothing to depreciate, which is not an
       asset, it is a note to self. */
    throw Object.assign(new Error(
      'what it will be worth at the end must be less than what it cost'), { status: 400 });
  }
  const on = String(p.acquiredOn || iso(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    throw Object.assign(new Error('acquiredOn must be YYYY-MM-DD'), { status: 400 });
  }
  const method = ['cash', 'bank', 'credit'].includes(p.method) ? p.method : 'credit';

  const ins = await c.query(
    'INSERT INTO asset (tag, name, category, acquired_on, cost, life_months, residual,'
    + ' method, supplier_id, serial, location, note, by_staff)'
    + ' VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
    [p.tag ? String(p.tag).slice(0, 40) : null, name.slice(0, 120),
      p.category ? String(p.category).slice(0, 60) : null, on,
      toMVR(cost), life, toMVR(residual), method, p.supplierId || null,
      p.serial ? String(p.serial).slice(0, 80) : null,
      p.location ? String(p.location).slice(0, 80) : null,
      p.note ? String(p.note).slice(0, 200) : null, ctx.actor]);
  const id = ins.rows[0].id;

  /* CAPITALISED, not expensed: Dr 1500 Equipment. Nothing reaches the P&L
     today — the whole point of the register. */
  await journal(c, {
    date: on, memo: 'Bought — ' + name, source: 'asset', sourceId: id,
    lines: [
      { account: '1500', dr: cost, cr: 0 },
      { account: method === 'cash' ? '1000' : method === 'bank' ? '1010' : '2000',
        dr: 0, cr: cost },
    ],
  }, ctx);

  await c.query("SELECT chain.log('asset_add','asset',$1,NULL,$2)",
    [id, JSON.stringify({ name, cost: toMVR(cost), life, residual: toMVR(residual) })]);

  return {
    id, name, cost: money(cost / 100), lifeMonths: life,
    monthly: money(slice(cost, residual, life, 0) / 100),
    message: 'Capitalised to 1500 Equipment. It costs the P&L '
      + toMVR(slice(cost, residual, life, 0)) + ' a month for ' + life
      + ' months, not ' + toMVR(cost) + ' today.',
  };
}

/* ── the monthly charge ──────────────────────────────────────────────────── */

/**
 * Charge one month against every active asset that still owes one.
 * Dr 6300 Depreciation, Cr 1510 Accumulated depreciation.
 *
 * p = { period } — 'YYYY-MM'
 */
async function depreciate(c, p, ctx) {
  const period = String(p.period || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw Object.assign(new Error('period must be YYYY-MM'), { status: 400 });
  }
  const date = periodEnd(period);

  const due = await c.query(
    'SELECT id, name, cost, residual, life_months, depreciated_months'
    + ' FROM asset'
    + " WHERE status = 'active' AND depreciated_months < life_months"
    + '   AND acquired_on <= $1::date'
    + '   AND (depreciated_upto IS NULL OR depreciated_upto < $2)'
    + ' ORDER BY acquired_on FOR UPDATE', [date, period]);

  const charged = [];
  let total = 0;
  for (const a of due.rows) {
    const amount = slice(toLaari(a.cost), toLaari(a.residual),
      a.life_months, a.depreciated_months);
    if (amount <= 0) continue;
    total += amount;

    await journal(c, {
      date, memo: 'Depreciation — ' + a.name, source: 'asset', sourceId: a.id,
      lines: [
        { account: '6300', dr: amount, cr: 0 },
        { account: '1510', dr: 0, cr: amount },
      ],
    }, ctx);
    await c.query('UPDATE asset SET depreciated_months = depreciated_months + 1,'
      + ' depreciated_upto = $2 WHERE id = $1', [a.id, period]);

    charged.push({
      id: a.id, name: a.name, amount: money(amount / 100),
      month: a.depreciated_months + 1, of: a.life_months,
      last: a.depreciated_months + 1 >= a.life_months,
    });
  }

  if (charged.length) {
    await c.query("SELECT chain.log('asset_depreciate','asset',$1,NULL,$2)",
      [charged[0].id, JSON.stringify({ period, count: charged.length, total: toMVR(total) })]);
  }
  return { period, charged, total: money(total / 100) };
}

/* ── selling or scrapping one ────────────────────────────────────────────── */

/**
 * p = { id, on, proceeds, method }
 *
 * Dr the money received, Dr the accumulated depreciation back off, Cr the cost.
 * Whatever is left is the gain or loss, and it goes to 6310 rather than being
 * quietly buried in repairs or, worse, in sales.
 */
async function dispose(c, p, ctx) {
  const q = await c.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [p.id]);
  if (!q.rows.length) throw Object.assign(new Error('no such asset'), { status: 404 });
  const a = q.rows[0];
  if (a.status !== 'active') {
    throw Object.assign(new Error('that one has already gone'), { status: 409 });
  }
  const on = String(p.on || iso(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    throw Object.assign(new Error('a date, YYYY-MM-DD'), { status: 400 });
  }
  const proceeds = toLaari(p.proceeds || 0);
  if (proceeds < 0) throw Object.assign(new Error('proceeds cannot be negative'), { status: 400 });
  const method = ['cash', 'bank', 'credit'].includes(p.method) ? p.method : 'bank';

  const costL = toLaari(a.cost);
  const accL = accumulated(costL, toLaari(a.residual), a.life_months, a.depreciated_months);
  const netBook = costL - accL;
  const result = proceeds - netBook;          // + gain, − loss

  const lines = [
    { account: '1500', dr: 0, cr: costL },     // the asset leaves
  ];
  if (accL > 0) lines.push({ account: '1510', dr: accL, cr: 0 });
  if (proceeds > 0) {
    lines.push({ account: method === 'cash' ? '1000' : method === 'bank' ? '1010' : '1020',
      dr: proceeds, cr: 0 });
  }
  if (result !== 0) {
    lines.push(result < 0
      ? { account: '6310', dr: -result, cr: 0 }   // a loss is an expense
      : { account: '6310', dr: 0, cr: result });  // a gain is a negative one
  }

  await journal(c, {
    date: on,
    memo: (proceeds > 0 ? 'Sold — ' : 'Scrapped — ') + a.name,
    source: 'asset', sourceId: a.id, lines,
  }, ctx);

  await c.query("UPDATE asset SET status = 'disposed', disposed_on = $2::date,"
    + ' proceeds = $3 WHERE id = $1', [a.id, on, toMVR(proceeds)]);
  await c.query("SELECT chain.log('asset_dispose','asset',$1,NULL,$2)",
    [a.id, JSON.stringify({ on, proceeds: toMVR(proceeds), result: toMVR(result) })]);

  return {
    id: a.id, name: a.name, on, proceeds: money(proceeds / 100),
    netBook: money(netBook / 100),
    result: money(result / 100),
    message: result === 0 ? 'Sold for exactly what it was worth on the books.'
      : result > 0
        ? 'A gain of ' + toMVR(result) + ' — credited to 6310, not to sales.'
        : 'A loss of ' + toMVR(-result) + ' — it was worth ' + toMVR(netBook)
          + ' on the books.',
  };
}

/* ── maintenance ─────────────────────────────────────────────────────────── */

async function schedule(c, p, ctx) {
  const has = await c.query("SELECT id, name, status FROM asset WHERE id = $1", [p.assetId]);
  if (!has.rows.length) throw Object.assign(new Error('no such asset'), { status: 404 });
  if (has.rows[0].status !== 'active') {
    throw Object.assign(new Error('that one has gone — nothing left to service'), { status: 409 });
  }
  const kind = ['service', 'repair', 'inspection'].includes(p.kind) ? p.kind : 'service';
  const due = String(p.dueOn || iso(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw Object.assign(new Error('a due date, YYYY-MM-DD'), { status: 400 });
  }
  const every = p.everyDays ? Number(p.everyDays) : null;
  if (every !== null && (!Number.isInteger(every) || every < 1 || every > 3650)) {
    throw Object.assign(new Error('every 1 to 3650 days, or one-off'), { status: 400 });
  }

  const q = await c.query(
    'INSERT INTO asset_service (asset_id, kind, every_days, due_on, note)'
    + ' VALUES ($1,$2,$3,$4::date,$5) RETURNING id',
    [p.assetId, kind, every, due, p.note ? String(p.note).slice(0, 200) : null]);
  await c.query("SELECT chain.log('service_schedule','asset_service',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ asset: has.rows[0].name, kind, dueOn: due, every })]);
  return { id: q.rows[0].id, assetId: p.assetId, kind, dueOn: due, everyDays: every };
}

/**
 * Mark one done. If it cost money it books an ordinary operating cost against
 * 6190 Repairs — THE SAME expense row the Operating Costs screen writes — and
 * the service points at it. And if it repeats, the next one is created now,
 * because the moment a recurring job is most likely to be forgotten is the
 * moment somebody has just finished it.
 *
 * p = { id, doneOn, cost, method, note }
 */
async function complete(c, p, ctx, opcosts) {
  const q = await c.query(
    'SELECT sv.*, a.name AS asset_name FROM asset_service sv'
    + ' JOIN asset a ON a.id = sv.asset_id WHERE sv.id = $1 FOR UPDATE OF sv', [p.id]);
  if (!q.rows.length) throw Object.assign(new Error('no such service'), { status: 404 });
  const s = q.rows[0];
  if (s.done_on) throw Object.assign(new Error('that one is already done'), { status: 409 });

  const on = String(p.doneOn || iso(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    throw Object.assign(new Error('a date, YYYY-MM-DD'), { status: 400 });
  }
  const cost = toLaari(p.cost || 0);

  let expense = null;
  if (cost > 0) {
    expense = await opcosts.record(c, {
      account: '6190', amount: money(cost / 100), spentOn: on,
      method: p.method, note: (s.asset_name + ' — ' + s.kind).slice(0, 200),
    }, ctx);
  }

  await c.query('UPDATE asset_service SET done_on = $2::date, done_by = $3,'
    + ' expense_id = $4, note = coalesce($5, note) WHERE id = $1',
    [s.id, on, ctx.actor, expense ? expense.id : null,
      p.note ? String(p.note).slice(0, 200) : null]);

  let next = null;
  if (s.every_days) {
    const d = new Date(on + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + s.every_days);
    const ins = await c.query(
      'INSERT INTO asset_service (asset_id, kind, every_days, due_on, note)'
      + ' VALUES ($1,$2,$3,$4::date,$5) RETURNING id',
      [s.asset_id, s.kind, s.every_days, iso(d), s.note]);
    next = { id: ins.rows[0].id, dueOn: iso(d) };
  }

  await c.query("SELECT chain.log('service_done','asset_service',$1,NULL,$2)",
    [s.id, JSON.stringify({ asset: s.asset_name, on, cost: toMVR(cost) })]);

  return {
    id: s.id, doneOn: on, cost: money(cost / 100),
    expenseId: expense ? expense.id : null, next,
    message: cost > 0
      ? 'Booked ' + toMVR(cost) + ' to 6190 Repairs — it is on the Operating Costs'
        + ' list too, as the same entry rather than a second one.'
      : undefined,
  };
}

async function dropService(c, id, ctx) {
  const q = await c.query(
    'DELETE FROM asset_service WHERE id = $1 AND done_on IS NULL RETURNING id', [id]);
  if (!q.rows.length) {
    /* A completed service is a record of something that happened, and possibly
       of money that was spent. It does not get tidied away. */
    throw Object.assign(new Error('no such job waiting — a completed one stays'),
      { status: 404 });
  }
  await c.query("SELECT chain.log('service_drop','asset_service',$1,NULL,NULL)", [id]);
  return { id, dropped: true };
}

/* ── one asset's story ───────────────────────────────────────────────────── */

async function history(c, id) {
  const a = await c.query('SELECT * FROM asset WHERE id = $1', [id]);
  if (!a.rows.length) throw Object.assign(new Error('no such asset'), { status: 404 });

  const j = await c.query(
    'SELECT j.jv_no, j.entry_date, j.memo, l.account_code, l.dr, l.cr, ac.name'
    + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
    + ' JOIN account ac ON ac.code = l.account_code'
    + " WHERE j.source = 'asset' AND j.source_id = $1"
    + ' ORDER BY j.entry_date, j.jv_no, l.id', [id]);

  return {
    entries: j.rows.map((r) => ({
      jvNo: r.jv_no, date: r.entry_date, memo: r.memo,
      account: r.account_code, accountName: r.name,
      dr: money(r.dr), cr: money(r.cr),
    })),
  };
}

/* ── the one journal helper this module needs ────────────────────────────── */

async function journal(c, j, ctx) {
  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
  const h = await c.query(
    'INSERT INTO journal (jv_no, entry_date, memo, source, source_id, posted_by)'
    + ' VALUES ($1,$2::date,$3,$4,$5,$6) RETURNING id',
    [no.rows[0].no, j.date, j.memo, j.source, j.sourceId, ctx.actor]);
  for (const l of j.lines) {
    await c.query(
      'INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,$3,$4)',
      [h.rows[0].id, l.account, toMVR(l.dr), toMVR(l.cr)]);
  }
  return h.rows[0].id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

module.exports = {
  list, add, depreciate, dispose, schedule, complete, dropService, history,
  slice, accumulated,
};
