'use strict';
/* The estate — 08-BUILD-STAGES §25, 11-OWNER-DASHBOARD-SPEC.
 *
 * THE ONE CROSS-OUTLET READ. Everything below comes from four SECURITY DEFINER
 * functions (migration 028) that reduce each outlet's own rows to sums INSIDE
 * that outlet, and from `backend/src/accounts.js`, which decides what those
 * sums mean. Nothing here joins across outlets and nothing here can name a
 * receipt, a ticket, a guest or a member: the functions do not return an id of
 * anything, so no drill-through is possible to add by accident. That is the
 * spec's §4 rule made structural instead of remembered.
 *
 * WHY THE GROUPING IS NOT DONE IN SQL. `chain.estate_ledger()` returns account
 * balances, not "cost of sales" and "labour". If it decided that, the estate
 * would hold a second copy of a judgement that already exists twice over in the
 * P&L and the CFO screen, and the three would drift where no reader could see
 * it — an owner's dashboard saying prime cost is 61% while the branch's own P&L
 * says 64%, with nothing on either screen to explain the gap. The balances
 * cross the boundary; `accounts.js` groups them, once, for all three.
 *
 * WHAT IT REFUSES TO GUESS. A dashboard's job is to be trusted at a glance, so
 * every figure it cannot honestly produce says so instead of showing a zero:
 *   · No revenue on the day → the health score is an em dash, not a number.
 *     A day that has not happened is not a judgement (spec §3.1).
 *   · No food cost target configured → food cost is reported but not scored,
 *     and setting one appears in the list of things waiting on the owner.
 *   · Fewer than two trading days in the fortnight → the trend is a sentence,
 *     not thirteen empty columns.
 *   · Either half of the fortnight with no trading → growth is suppressed
 *     entirely. A percentage against zero is not a percentage.
 *   · Writes still sitting in a till's outbox → reported as unknown, because
 *     they are on the device by definition and a server that could count them
 *     would already have them. A zero that cannot be wrong is not a check.
 */

const accounts = require('./accounts');

const mvr = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** n days before an ISO date, as an ISO date. Arithmetic in UTC so a server's
 *  timezone cannot move a business date. */
function minusDays(iso, n) {
  const t = Date.parse(iso + 'T00:00:00Z') - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/* ── the targets ─────────────────────────────────────────────────────────── */

/** Read on the OUTLET connection, not the reporting one — see migration 028
 *  for why the reporting role is left with no table grant at all. */
async function targets(c) {
  const q = await c.query(
    'SELECT food_cost_target_pct, labour_target_pct, prime_target_pct,'
    + ' w_food_over, w_labour_over, w_prime_over, w_silent_site,'
    + ' w_service_overdue, w_house_over_limit, w_sale_unjournalled,'
    + ' set_by, set_at FROM chain.estate_target');
  const r = q.rows[0] || {};
  return {
    /* NULL is not zero and not a default. It means nobody has said what this
       kitchen is aiming at, and the screen has to say that rather than judge
       against a number it invented. */
    foodCostTargetPct: r.food_cost_target_pct === null || r.food_cost_target_pct === undefined
      ? null : Number(r.food_cost_target_pct),
    labourTargetPct: Number(r.labour_target_pct),
    primeTargetPct: Number(r.prime_target_pct),
    weights: {
      foodOver: Number(r.w_food_over),
      labourOver: Number(r.w_labour_over),
      primeOver: Number(r.w_prime_over),
      silentSite: Number(r.w_silent_site),
      serviceOverdue: Number(r.w_service_overdue),
      houseOverLimit: Number(r.w_house_over_limit),
      saleUnjournalled: Number(r.w_sale_unjournalled),
    },
    setAt: r.set_at || null,
  };
}

const TARGET_FIELDS = {
  foodCostTargetPct: 'food_cost_target_pct',
  labourTargetPct: 'labour_target_pct',
  primeTargetPct: 'prime_target_pct',
  foodOver: 'w_food_over',
  labourOver: 'w_labour_over',
  primeOver: 'w_prime_over',
  silentSite: 'w_silent_site',
  serviceOverdue: 'w_service_overdue',
  houseOverLimit: 'w_house_over_limit',
  saleUnjournalled: 'w_sale_unjournalled',
};

/** Set targets and weights. Rank 5 — the policy enforces it, this validates
 *  the shape. Only the keys present are touched, so a screen that edits one
 *  field cannot blank the rest by omission. */
async function setTargets(c, body, ctx) {
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(TARGET_FIELDS)) {
    if (!(key in body)) continue;
    const raw = body[key];
    /* Clearing the food cost target back to "nobody has decided" is a real
       act, so null is accepted for it and refused for everything else. */
    if (raw === null || raw === '') {
      if (key !== 'foodCostTargetPct') {
        throw Object.assign(new Error(col + ' cannot be cleared'), { status: 400 });
      }
      vals.push(null);
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw Object.assign(new Error(col + ' must be a number'), { status: 400 });
      }
      if (key.endsWith('TargetPct') && (n <= 0 || n >= 100)) {
        throw Object.assign(new Error(col + ' must be a percentage between 0 and 100'),
          { status: 400 });
      }
      vals.push(n);
    }
    sets.push(col + ' = $' + vals.length);
  }
  if (!sets.length) throw Object.assign(new Error('nothing to set'), { status: 400 });
  vals.push(ctx && ctx.actor ? ctx.actor : null);
  await c.query('UPDATE chain.estate_target SET ' + sets.join(', ')
    + ', set_by = $' + vals.length + ', set_at = now()', vals);
  return targets(c);
}

/* ── the derivation ──────────────────────────────────────────────────────── */

/**
 * The whole owner dashboard for one day.
 *
 * `est` is a client on the reporting connection (aggregates only); `own` is the
 * owner's ordinary outlet connection, used for the one thing the reporting role
 * deliberately cannot read — the targets it is judged against.
 */
async function overview(est, own, requestedDate) {
  const requested = isoDay(requestedDate);

  /* §2: if today has not traded, fall back to the last business date that did
     — and SAY SO. A dashboard silently showing yesterday is how a closed
     Friday gets read as a quiet one. */
  const lastQ = await est.query('SELECT chain.estate_last_trading($1) AS d', [requested]);
  const lastTraded = lastQ.rows[0].d ? isoDay(lastQ.rows[0].d) : null;
  const date = lastTraded || requested;
  const fellBack = Boolean(lastTraded) && lastTraded !== requested;

  const from14 = minusDays(date, 13);
  const [dayQ, prevDayQ, ledgerQ, positionQ, seriesQ, alertQ, target] = await Promise.all([
    est.query('SELECT * FROM chain.estate_day($1)', [date]),
    /* The day before is only meaningful if it traded; the fallback finds it. */
    est.query('SELECT * FROM chain.estate_day(chain.estate_last_trading($1))',
      [minusDays(date, 1)]),
    est.query('SELECT * FROM chain.estate_ledger($1, $1)', [date]),
    /* A balance-sheet figure is everything ever posted, not the day's movement:
       the cash in the drawer this morning was put there over months. */
    est.query('SELECT * FROM chain.estate_ledger(NULL, $1)', [date]),
    est.query('SELECT * FROM chain.estate_series($1, $2)', [from14, date]),
    est.query('SELECT * FROM chain.estate_alerts($1)', [date]),
    targets(own),
  ]);

  const days = dayQ.rows.map(dayRow);
  const prev = prevDayQ.rows.map(dayRow);
  const alerts = new Map(alertQ.rows.map((r) => [r.outlet_id, alertRow(r)]));

  const pnl = profitAndLoss(ledgerQ.rows);
  const position = moneyPosition(positionQ.rows);

  /* Per-outlet food cost from the SALE side, because the ledger's cost of sales
     is not split by outlet in a way the day's own cogs is — and `sale.cogs` is
     the cost captured at the moment each dish sold, which is the figure a
     branch is actually accountable for. The estate total still comes off the
     ledger; where the two disagree the difference is reported rather than
     reconciled, exactly as the CFO screen does it. */
  const revenue = mvr(days.reduce((a, d) => a + d.revenue, 0));
  const cogsFromSales = mvr(days.reduce((a, d) => a + d.cogs, 0));
  const covers = days.reduce((a, d) => a + d.covers, 0);
  const anyTrading = days.some((d) => d.bills > 0);

  const outlets = days.map((d) => ({
    ...d,
    sharePct: pct(d.revenue, revenue),
    foodCostPct: pct(d.cogs, d.revenue),
    /* A site is only SILENT if it took nothing while others were trading. On a
       public holiday every branch is shut and none of them is a problem. */
    silent: d.bills === 0 && anyTrading,
    alerts: alerts.get(d.id) || null,
  }));

  const prevRevenue = mvr(prev.reduce((a, d) => a + d.revenue, 0));
  const prevCovers = prev.reduce((a, d) => a + d.covers, 0);
  const prevCogs = mvr(prev.reduce((a, d) => a + d.cogs, 0));

  const figures = {
    netSales: { value: revenue, deltaPct: change(revenue, prevRevenue),
      against: 'the last trading day' },
    covers: { value: covers, deltaPct: change(covers, prevCovers),
      against: 'the last trading day' },
    foodCost: {
      value: pct(cogsFromSales, revenue), money: cogsFromSales,
      deltaPct: change(pct(cogsFromSales, revenue) || 0, pct(prevCogs, prevRevenue) || 0),
      target: target.foodCostTargetPct,
      /* Judged only against a target somebody chose. */
      over: target.foodCostTargetPct === null ? null
        : (pct(cogsFromSales, revenue) || 0) > target.foodCostTargetPct,
      against: target.foodCostTargetPct === null
        ? 'no target set — food cost is reported but not scored'
        : 'a target of ' + target.foodCostTargetPct + '%',
    },
    labour: {
      value: pnl.labourPct, money: pnl.labour,
      target: target.labourTargetPct,
      over: pnl.labourPct === null ? null : pnl.labourPct > target.labourTargetPct,
      /* Said rather than implied — prime cost with no labour in it is not a
         good prime cost, it is an incomplete one. */
      posted: pnl.labour !== 0,
      against: pnl.labour === 0
        ? 'no payroll posted for this day — labour is missing, not zero'
        : 'a target of ' + target.labourTargetPct + '%',
    },
    primeCost: {
      value: pnl.primeCostPct, money: pnl.primeCost,
      target: target.primeTargetPct,
      over: pnl.primeCostPct === null ? null : pnl.primeCostPct > target.primeTargetPct,
      complete: pnl.labour !== 0,
      against: 'a target of ' + target.primeTargetPct + '%',
    },
    profit: { value: pnl.netProfit, pct: pnl.netMarginPct,
      against: 'revenue for the same day' },
  };

  const series = buildSeries(seriesQ.rows, from14, date);
  const waiting = waitingOn(outlets, figures, target, pnl);
  const health = score(revenue, outlets, figures, target);

  return {
    requested, date, fellBack, tradedToday: !fellBack && anyTrading,
    target,
    briefing: briefing(health, date, fellBack, revenue, outlets, waiting),
    figures,
    series,
    outlets,
    pnl,
    position,
    waiting,
    controls: controls(date, outlets, alerts),
    /* Reported, never reconciled: the ledger's cost of sales for the day and
       the cost captured on the sales themselves are two measures of one thing.
       If they disagree, somebody needs to know which sale is missing a line. */
    reconciliation: {
      cogsFromSales,
      cogsFromLedger: pnl.costOfSales,
      difference: mvr(cogsFromSales - pnl.costOfSales),
      agrees: mvr(cogsFromSales - pnl.costOfSales) === 0,
    },
  };
}

function dayRow(r) {
  return {
    id: r.outlet_id, name: r.outlet, code: r.code,
    takings: mvr(r.takings), revenue: mvr(r.revenue),
    covers: Number(r.covers), bills: Number(r.bills),
    cogs: mvr(r.cogs), tax: mvr(r.tax),
    discount: mvr(r.discount), service: mvr(r.service),
    lastSaleAt: r.last_sale_at || null,
  };
}

function alertRow(r) {
  const low = r.receipt_low === null ? null : Number(r.receipt_low);
  const high = r.receipt_high === null ? null : Number(r.receipt_high);
  const count = Number(r.receipt_count);
  return {
    servicesOverdue: Number(r.services_overdue),
    houseOverLimit: Number(r.house_over_limit),
    houseOverLimitValue: mvr(r.house_over_limit_value),
    salesUnjournalled: Number(r.sales_unjournalled),
    receipts: {
      low, high, count,
      /* A run of receipt numbers with a hole in it is a missing receipt, and
         it is the first thing an inspection looks for. Duplicates cannot
         happen — receipt_no is UNIQUE per outlet — so the honest control is
         the gap, not the duplicate. */
      missing: low === null ? 0 : (high - low + 1) - count,
    },
  };
}

/** Percentage change, or null when there is no base to change from. */
function change(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

/* ── the P&L, from the ledger, grouped by accounts.js ─────────────────────── */

function profitAndLoss(rows) {
  /* Sum each account ACROSS outlets first. Every outlet keeps its own books on
     the same chart, so 5000 in Malé and 5000 in Hulhumalé are the same line of
     the same P&L — this is the consolidation, and it is addition. */
  const byCode = new Map();
  for (const r of rows) {
    const cur = byCode.get(r.code)
      || { code: r.code, name: r.name, type: r.type, balance: 0 };
    cur.balance = mvr(cur.balance + Number(r.balance));
    byCode.set(r.code, cur);
  }
  const all = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  const income = all.filter((r) => r.type === 'income');
  const expense = all.filter((r) => r.type === 'expense');

  const revenue = accounts.sumWhere(income, () => true);
  const costOfSales = accounts.sumWhere(expense, accounts.isCostOfSales);
  const labour = accounts.sumWhere(expense, accounts.isLabour);
  const overheads = accounts.sumWhere(expense,
    (code) => !accounts.isCostOfSales(code) && !accounts.isLabour(code));
  const grossProfit = mvr(revenue - costOfSales);
  const primeCost = mvr(costOfSales + labour);
  const netProfit = mvr(grossProfit - labour - overheads);

  return {
    revenue, revenueLines: income,
    costOfSales, costOfSalesPct: pct(costOfSales, revenue),
    grossProfit, grossMarginPct: pct(grossProfit, revenue),
    labour, labourPct: pct(labour, revenue),
    primeCost, primeCostPct: pct(primeCost, revenue),
    overheads, overheadsPct: pct(overheads, revenue), overheadLines:
      expense.filter((r) => !accounts.isCostOfSales(r.code) && !accounts.isLabour(r.code)),
    netProfit, netMarginPct: pct(netProfit, revenue),
    /* §3.5's four-segment bar. Shares of REVENUE, and profit is what is left —
       so a loss makes the profit segment zero and the bar stops short of full
       rather than wrapping, which is the honest picture of a bad day. */
    bar: revenue > 0 ? [
      { key: 'food', pct: pct(costOfSales, revenue) || 0 },
      { key: 'labour', pct: pct(labour, revenue) || 0 },
      { key: 'overheads', pct: pct(overheads, revenue) || 0 },
      { key: 'profit', pct: Math.max(0, pct(netProfit, revenue) || 0) },
    ] : [],
  };
}

/* ── the money position ──────────────────────────────────────────────────── */

function moneyPosition(rows) {
  const byCode = new Map();
  for (const r of rows) {
    byCode.set(r.code, mvr((byCode.get(r.code) || 0) + Number(r.balance)));
  }
  const at = (code) => byCode.get(code) || 0;
  const P = accounts.POSITION;

  /* The last four are money the business is HOLDING, not money it has. GST
     belongs to MIRA, service charge and tips belong to the people who earned
     them, and the supplier balance is somebody's unpaid invoice. A cash figure
     that quietly nets them in reads healthy on the morning payroll empties it,
     so they are labelled here rather than on the screen — a label that lives in
     the UI is one a second screen can forget. */
  return {
    ours: [
      { key: 'cashInDrawer', label: 'Cash in drawers', value: at(P.cashInDrawer) },
      { key: 'bank', label: 'Bank', value: at(P.bank) },
      { key: 'cardAwaitingSettlement', label: 'Card awaiting settlement',
        value: at(P.cardAwaitingSettlement) },
      { key: 'houseAccount', label: 'House accounts owed to us',
        value: at(P.houseAccount) },
    ],
    heldForOthers: [
      { key: 'gstHeld', label: 'GST collected, held for MIRA', value: at(P.gstHeld) },
      { key: 'serviceChargeOwed', label: 'Service charge owed to staff',
        value: at(P.serviceChargeOwed) },
      { key: 'tipsOwed', label: 'Tips owed to staff', value: at(P.tipsOwed) },
      { key: 'owedToSuppliers', label: 'Owed to suppliers', value: at(P.owedToSuppliers) },
    ],
  };
}

/* ── the fortnight ───────────────────────────────────────────────────────── */

function buildSeries(rows, from, to) {
  const byDate = new Map();
  for (const r of rows) {
    const d = isoDay(r.business_date);
    byDate.set(d, mvr((byDate.get(d) || 0) + Number(r.revenue)));
  }
  const bars = [];
  for (let i = 13; i >= 0; i--) {
    const d = minusDays(to, i);
    /* An ABSENT row is a day that did not trade; a present zero is a day that
       opened and took nothing. The two are different facts and the growth rule
       below depends on telling them apart. */
    bars.push({ date: d, revenue: byDate.has(d) ? byDate.get(d) : null,
      traded: byDate.has(d) });
  }
  const traded = bars.filter((b) => b.traded);
  const recent = bars.slice(7);
  const earlier = bars.slice(0, 7);
  const sum = (xs) => mvr(xs.reduce((a, b) => a + (b.revenue || 0), 0));
  const recentTraded = recent.some((b) => b.traded);
  const earlierTraded = earlier.some((b) => b.traded);

  return {
    from, to, bars,
    /* Fewer than two trading days and there is no shape to see. Thirteen empty
       columns carry less information than one sentence saying so. */
    plottable: traded.length >= 2,
    tradingDays: traded.length,
    lastSeven: sum(recent), previousSeven: sum(earlier),
    /* Suppressed ENTIRELY when either week has no trading. A percentage against
       zero is not a percentage — it is a division that happens to have a
       number on one side. */
    growthPct: recentTraded && earlierTraded && sum(earlier) > 0
      ? Math.round(((sum(recent) - sum(earlier)) / sum(earlier)) * 1000) / 10
      : null,
    growthSuppressed: recentTraded && earlierTraded && sum(earlier) > 0 ? null
      : (!earlierTraded ? 'the earlier week has no trading to compare against'
        : !recentTraded ? 'the recent week has no trading yet'
          : 'the earlier week took nothing'),
  };
}

/* ── the score ───────────────────────────────────────────────────────────── */

/**
 * Health, 0–100, by DEDUCTION from a clean slate — never a curve fitted to look
 * reassuring. Each deduction names its own cause, so the number can always be
 * taken apart into the sentences underneath it.
 *
 * With no revenue it is null, and the screen shows an em dash. A day that has
 * not happened is not a judgement (§3.1).
 */
function score(revenue, outlets, figures, target) {
  if (!revenue) return { value: null, why: [], reason: 'nothing has traded' };
  const w = target.weights;
  const why = [];
  let value = 100;
  const deduct = (points, cause) => {
    if (points <= 0) return;
    const p = Math.round(points * 10) / 10;
    value -= p;
    why.push({ points: p, cause });
  };

  if (target.foodCostTargetPct !== null && figures.foodCost.value !== null) {
    const over = figures.foodCost.value - target.foodCostTargetPct;
    if (over > 0) deduct(over * w.foodOver,
      'food cost is ' + figures.foodCost.value + '% against a target of '
      + target.foodCostTargetPct + '%');
  }
  if (figures.labour.value !== null) {
    const over = figures.labour.value - target.labourTargetPct;
    if (over > 0) deduct(over * w.labourOver,
      'labour is ' + figures.labour.value + '% of revenue');
  }
  if (figures.primeCost.value !== null) {
    const over = figures.primeCost.value - target.primeTargetPct;
    if (over > 0) deduct(over * w.primeOver,
      'prime cost is ' + figures.primeCost.value + '%');
  }
  for (const o of outlets) {
    if (o.silent) deduct(w.silentSite, o.name + ' took nothing while others traded');
    const a = o.alerts;
    if (!a) continue;
    if (a.salesUnjournalled) {
      deduct(w.saleUnjournalled * a.salesUnjournalled,
        a.salesUnjournalled + ' sale(s) at ' + o.name + ' never reached the ledger');
    }
    if (a.servicesOverdue) {
      deduct(w.serviceOverdue * a.servicesOverdue,
        a.servicesOverdue + ' equipment service(s) overdue at ' + o.name);
    }
    if (a.houseOverLimit) {
      deduct(w.houseOverLimit * a.houseOverLimit,
        a.houseOverLimit + ' house account(s) over their limit at ' + o.name);
    }
  }

  return { value: Math.max(0, Math.round(value)), why, reason: null };
}

/* ── the sentences ───────────────────────────────────────────────────────── */

function briefing(health, date, fellBack, revenue, outlets, waiting) {
  const trading = outlets.filter((o) => o.bills > 0).length;
  const headline = !revenue
    ? 'Nothing has traded yet.'
    : 'MVR ' + revenue.toFixed(2) + ' across '
      + trading + (trading === 1 ? ' outlet.' : ' outlets.');

  const bits = [];
  /* Never silently. §2: if the day being shown is not the day asked for, the
     chip says which day it is and why. */
  if (fellBack) bits.push('Showing ' + date + ', the last day that traded.');
  if (health.value === null) bits.push('No score — a day that has not happened is not a judgement.');
  if (waiting.length) {
    bits.push(waiting.length === 1
      ? 'One thing is waiting on you.'
      : waiting.length + ' things are waiting on you.');
  } else if (revenue) {
    bits.push('Nothing is waiting on you.');
  }
  return { score: health.value, why: health.why, headline, context: bits.join(' ') };
}

/* ── what only a rank 5 can answer ───────────────────────────────────────── */

/* §3.6: "Only what a rank 5 must answer; anything a manager can clear is
   absent." Built from live data every time — a fixed list would be a screen
   that keeps asking after the thing is done. */
function waitingOn(outlets, figures, target, pnl) {
  const out = [];
  const push = (kind, text, value, goTo) => out.push({ kind, text, value, goTo });

  if (target.foodCostTargetPct === null) {
    push('target', 'No food cost target has been set, so food cost is reported '
      + 'but never scored. It is the one number on this screen nobody has told '
      + 'the system what to expect.', null, 'owner');
  }
  for (const o of outlets) {
    if (o.silent) {
      push('silent', o.name + ' took nothing while other outlets traded.', null, 'chain');
    }
    const a = o.alerts;
    if (!a) continue;
    if (a.salesUnjournalled) {
      push('ledger', a.salesUnjournalled + ' sale(s) at ' + o.name
        + ' took money and never reached the ledger.', a.salesUnjournalled, 'accounting');
    }
    if (a.receipts.missing > 0) {
      push('receipts', a.receipts.missing + ' receipt number(s) missing from '
        + o.name + "'s series for the day.", a.receipts.missing, 'reports');
    }
    if (a.servicesOverdue) {
      push('equipment', a.servicesOverdue + ' equipment service(s) overdue at '
        + o.name + '.', a.servicesOverdue, 'assets');
    }
    if (a.houseOverLimit) {
      push('house', a.houseOverLimit + ' house account(s) over their limit at '
        + o.name + ', by MVR ' + a.houseOverLimitValue.toFixed(2) + '.',
      a.houseOverLimitValue, 'customers');
    }
  }
  if (figures.foodCost.over) {
    /* With its MVR value, per §3.6 — a percentage over target tells an owner
       there is a problem and not how big it is. */
    const excess = mvr(figures.foodCost.money
      - (figures.netSales.value * target.foodCostTargetPct) / 100);
    push('foodcost', 'Food cost is ' + figures.foodCost.value + '% against a target of '
      + target.foodCostTargetPct + '% — MVR ' + excess.toFixed(2) + ' more than the '
      + 'target allows.', excess, 'analytics');
  }
  if (figures.labour.over) {
    push('labour', 'Labour is ' + figures.labour.value + '% of revenue, against a target of '
      + target.labourTargetPct + '%.', pnl.labour, 'payroll');
  }
  return out;
}

/* ── controls, checked not claimed ───────────────────────────────────────── */

function controls(date, outlets, alerts) {
  const reporting = outlets.filter((o) => o.bills > 0).length;
  const missing = [...alerts.values()].reduce((a, x) => a + Math.max(0, x.receipts.missing), 0);
  const unjournalled = [...alerts.values()].reduce((a, x) => a + x.salesUnjournalled, 0);

  /* Days to the GST return. MIRA's monthly return is due on the 28th of the
     following month; that is a filing deadline, not a configurable, and it is
     computed from the date being shown rather than from the wall clock so the
     figure matches the rest of the screen. */
  const d = new Date(Date.parse(date + 'T00:00:00Z'));
  const due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 28));
  const daysToReturn = Math.round((due - d) / 86400000);

  return [
    { key: 'receipts',
      label: 'Receipt series integrity',
      state: missing > 0 ? 'attention' : 'ok',
      detail: missing > 0
        ? missing + ' number(s) missing from the day\'s runs'
        : 'every receipt number issued on ' + date + ' accounted for' },
    { key: 'ledger',
      label: 'Every sale reached the ledger',
      state: unjournalled > 0 ? 'attention' : 'ok',
      detail: unjournalled > 0
        ? unjournalled + ' sale(s) took money with no journal behind them'
        : 'no sale on ' + date + ' is missing its journal' },
    { key: 'outbox',
      label: 'Writes waiting to reach the cloud',
      /* Unknown, and said so. They are in a till's outbox on the device, which
         is what makes offline work at all. A server confident there are none
         would be a server that already had them. */
      state: 'unknown',
      detail: 'held on each till until it reconnects — the server cannot count '
        + 'what has not reached it' },
    { key: 'gst',
      label: 'Days to the GST return',
      state: daysToReturn <= 7 ? 'attention' : 'ok',
      detail: daysToReturn + ' day(s) until the return for this month is due' },
    { key: 'isolation',
      label: 'Outlet isolation',
      state: 'ok',
      detail: 'each figure above was computed inside the outlet that owns it; '
        + 'this screen received sums, never rows' },
    { key: 'reporting',
      label: 'Sites reporting',
      state: reporting === outlets.length ? 'ok' : 'attention',
      detail: reporting + ' of ' + outlets.length + ' outlets traded on ' + date },
  ];
}

module.exports = { overview, targets, setTargets, profitAndLoss, buildSeries, score };
