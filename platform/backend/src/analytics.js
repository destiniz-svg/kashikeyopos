'use strict';
/* Analytics & CFO — 02-POS-SPEC.md §2 (`analytics`): "Prime cost, margin by
 * dish, variance trend."
 *
 * 08-BUILD-STAGES §22 sets the rule this file is built to: "Prime cost and net
 * margin are computed from posted journals, not from a parallel calculation."
 * So the headline figures come from reports.balances() — the same function the
 * P&L and the trial balance use — and this module adds no second arithmetic for
 * them. What it adds is the DIMENSION the ledger does not have: the ledger knows
 * revenue and cost of sales, it does not know which dish.
 *
 * WHICH MEANS THERE ARE TWO SOURCES HERE, AND THEY ARE RECONCILED RATHER THAN
 * BLENDED. Dish-level figures come from `sale_line`, because that is the only
 * place the dish exists. Their sum must equal what the ledger holds, and where
 * it does not the difference is reported. Two numbers that should agree and do
 * not is a finding; quietly preferring one is how a discrepancy survives.
 *
 * MARGIN BY DISH IS RANKED BY CONTRIBUTION, NOT BY PERCENTAGE. A dish with a
 * 90% margin that sells twice a week contributes nothing; a 55% dish that sells
 * two hundred times pays the rent. Menu engineering that sorts by percentage
 * tells a kitchen to promote the wrong things, and it is the default in almost
 * every POS that offers this screen.
 */

const reports = require('./reports');

const money = (n) => Math.round(Number(n) * 100) / 100;
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);

/* Cost of sales and labour, by account, matching reports.js exactly — the same
   sets, so prime cost cannot mean one thing on the P&L and another here. */
const COST_OF_SALES = new Set(['5000', '5010', '5100']);
const LABOUR = new Set(['6000', '6010']);
/* What a variance trend is made of: stock that went missing, a drawer that
   miscounted, and a price correction on stock already sold. Each is a loss
   nobody decided on, which is exactly what makes a trend in them worth
   watching. */
const VARIANCE = new Set(['5100', '6920']);

/**
 * The CFO view for a period.
 * `weeks` is how many buckets the trend carries.
 */
async function cfo(c, from, to) {
  const rows = await reports.balances(c, from, to);
  const by = new Map(rows.map((r) => [r.code, r]));
  const bal = (code) => (by.get(code) ? by.get(code).balance : 0);
  const sumOf = (set) => money(rows.filter((r) => set.has(r.code))
    .reduce((a, r) => a + r.balance, 0));

  const revenue = money(rows.filter((r) => r.type === 'income')
    .reduce((a, r) => a + r.balance, 0));
  const cogs = sumOf(COST_OF_SALES);
  const labour = sumOf(LABOUR);
  const expenses = money(rows.filter((r) => r.type === 'expense')
    .reduce((a, r) => a + r.balance, 0));
  const primeCost = money(cogs + labour);
  const gross = money(revenue - cogs);
  const net = money(revenue - expenses);

  const [dishes, ledgerCheck, trend, variance] = await Promise.all([
    dishMargins(c, from, to),
    c.query(
      'SELECT coalesce(sum(gross - discount),0) AS revenue, coalesce(sum(cogs),0) AS cogs'
      + ' FROM sale WHERE voided_at IS NULL'
      + ' AND ($1::date IS NULL OR business_date >= $1::date)'
      + ' AND ($2::date IS NULL OR business_date <= $2::date)', [from || null, to || null]),
    weekly(c, from, to),
    varianceTrend(c, from, to),
  ]);

  const dishRevenue = money(dishes.reduce((a, d) => a + d.revenue, 0));
  const dishCost = money(dishes.reduce((a, d) => a + d.cost, 0));

  return {
    from: from || null, to: to || null,

    /* Straight off the ledger. No parallel calculation — §22. */
    headline: {
      revenue, costOfSales: cogs, labour,
      primeCost,
      primeCostPct: pct(primeCost, revenue),
      grossProfit: gross,
      grossMarginPct: pct(gross, revenue),
      operatingCosts: money(expenses - cogs - labour),
      netProfit: net,
      netMarginPct: pct(net, revenue),
      /* Said rather than implied. Prime cost with no labour in it is not a good
         prime cost, and a restaurant reading 28% when payroll has never been
         run is reading a number that will roughly double. */
      labourPosted: labour !== 0,
      cashInDrawer: bal('1000'),
      owedToSuppliers: bal('2000'),
      owedToStaff: money(bal('2300') + bal('2310')),
    },

    dishes,
    /* The reconciliation, reported rather than hidden. sale_line is the only
       place a dish exists, so it has to be summed separately — but its total is
       the same money the ledger holds, and if the two drift somebody needs to
       know which sale is missing a line. */
    reconciliation: {
      dishRevenue,
      ledgerRevenue: money(ledgerCheck.rows[0].revenue),
      revenueDifference: money(dishRevenue - Number(ledgerCheck.rows[0].revenue)),
      dishCost,
      ledgerCogs: money(ledgerCheck.rows[0].cogs),
      costDifference: money(dishCost - Number(ledgerCheck.rows[0].cogs)),
      agrees: money(dishRevenue - Number(ledgerCheck.rows[0].revenue)) === 0
        && money(dishCost - Number(ledgerCheck.rows[0].cogs)) === 0,
    },

    trend,
    variance,
  };
}

/**
 * Margin by dish, from `sale_line` — the only place the dish exists.
 *
 * `line_total` is NET of tax and `line_cost` is the cost captured at the moment
 * of sale, so the margin here is the margin that was actually made, not one
 * recomputed from today's ingredient prices. Recomputing would make last
 * month's profit change when a supplier does.
 */
async function dishMargins(c, from, to) {
  const q = await c.query(
    'SELECT l.item_id, l.name, i.category,'
    + ' sum(l.qty) AS qty,'
    + ' sum(l.line_total) AS revenue,'
    + ' sum(l.line_cost) AS cost'
    + ' FROM sale_line l'
    + ' JOIN sale s ON s.id = l.sale_id AND s.voided_at IS NULL'
    + ' LEFT JOIN item i ON i.id = l.item_id'
    + ' WHERE ($1::date IS NULL OR s.business_date >= $1::date)'
    + '   AND ($2::date IS NULL OR s.business_date <= $2::date)'
    + ' GROUP BY l.item_id, l.name, i.category', [from || null, to || null]);

  const rows = q.rows.map((r) => {
    const revenue = money(r.revenue);
    const cost = money(r.cost);
    const margin = money(revenue - cost);
    return {
      itemId: r.item_id, name: r.name, category: r.category || null,
      qty: money(r.qty), revenue, cost, margin,
      marginPct: pct(margin, revenue),
      /* A dish with no cost is not a dish with a 100% margin. It is a dish
         nobody has costed, and reporting it as the best performer on the menu
         is how a recipe never gets written. */
      costed: cost > 0,
    };
  });

  /* Ranked by CONTRIBUTION — total margin in money — not by percentage. A 90%
     dish that sells twice a week contributes nothing; a 55% dish that sells two
     hundred times pays the rent. */
  rows.sort((a, b) => b.margin - a.margin);
  const total = rows.reduce((a, r) => a + r.margin, 0);
  return rows.map((r) => ({ ...r, shareOfMargin: pct(r.margin, total) }));
}

/* ── the trend ───────────────────────────────────────────────────────────── */

/**
 * Revenue, cost of sales and labour by week, from the LEDGER. One measure per
 * axis and one axis: these three are all money, so they belong on one scale and
 * one chart. A second y-axis is how a chart lies about a relationship.
 */
async function weekly(c, from, to) {
  const q = await c.query(
    "SELECT date_trunc('week', j.entry_date)::date AS wk,"
    + ' coalesce(sum(CASE WHEN a.type = \'income\''
    + "   THEN l.cr - l.dr ELSE 0 END), 0) AS revenue,"
    + ' coalesce(sum(CASE WHEN l.account_code IN (\'5000\',\'5010\',\'5100\')'
    + '   THEN l.dr - l.cr ELSE 0 END), 0) AS cogs,'
    + ' coalesce(sum(CASE WHEN l.account_code IN (\'6000\',\'6010\')'
    + '   THEN l.dr - l.cr ELSE 0 END), 0) AS labour'
    + ' FROM journal_line l'
    + ' JOIN journal j ON j.id = l.journal_id'
    + ' JOIN account a ON a.code = l.account_code'
    + ' WHERE ($1::date IS NULL OR j.entry_date >= $1::date)'
    + '   AND ($2::date IS NULL OR j.entry_date <= $2::date)'
    + " GROUP BY date_trunc('week', j.entry_date) ORDER BY wk", [from || null, to || null]);

  return q.rows.map((r) => {
    const revenue = money(r.revenue);
    const cogs = money(r.cogs);
    const labour = money(r.labour);
    return {
      week: r.wk, revenue, costOfSales: cogs, labour,
      primeCost: money(cogs + labour),
      primeCostPct: pct(cogs + labour, revenue),
    };
  });
}

/**
 * §2's "variance trend". Losses nobody decided on: stock that went missing
 * (5100) and drawers that miscounted (6920), by week.
 *
 * A single number for the month says "you lost 400". A trend says "you lost 40
 * a week until the 12th and 200 since", which is a question somebody can
 * actually go and answer.
 */
async function varianceTrend(c, from, to) {
  const q = await c.query(
    "SELECT date_trunc('week', j.entry_date)::date AS wk, l.account_code,"
    + ' coalesce(sum(l.dr - l.cr), 0) AS amount'
    + ' FROM journal_line l JOIN journal j ON j.id = l.journal_id'
    + ' WHERE l.account_code = ANY($3)'
    + '   AND ($1::date IS NULL OR j.entry_date >= $1::date)'
    + '   AND ($2::date IS NULL OR j.entry_date <= $2::date)'
    + " GROUP BY date_trunc('week', j.entry_date), l.account_code ORDER BY wk",
    [from || null, to || null, [...VARIANCE]]);

  const byWeek = new Map();
  for (const r of q.rows) {
    const k = String(r.wk);
    if (!byWeek.has(k)) byWeek.set(k, { week: r.wk, stock: 0, cash: 0 });
    const bucket = byWeek.get(k);
    if (r.account_code === '5100') bucket.stock = money(r.amount);
    else bucket.cash = money(r.amount);
  }
  const weeks = [...byWeek.values()].map((w) => ({ ...w, total: money(w.stock + w.cash) }));
  return {
    weeks,
    total: money(weeks.reduce((a, w) => a + w.total, 0)),
    /* Whether it is getting worse. Half the point of a trend is the direction,
       and a reader should not have to compute it from the bars. */
    worsening: weeks.length >= 2
      && weeks[weeks.length - 1].total > weeks[weeks.length - 2].total,
  };
}

module.exports = { cfo, dishMargins, weekly, varianceTrend };
