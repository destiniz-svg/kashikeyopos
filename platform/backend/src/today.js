'use strict';
/* Today — 02-POS-SPEC.md §2 (`today`):
 *
 *   "The manager's morning screen: decisions waiting — unpriced deliveries,
 *    overdue suppliers, failed dockets, margin bleeders. NOT a dashboard of
 *    numbers; a list of things to do, each linking to where it is done."
 *
 * The emphasis is the spec's own and it is the whole design. A dashboard tells
 * a manager that takings were 12,400 — which is not a decision, and on a busy
 * morning it is not even interesting. This screen answers one question: what
 * needs somebody, right now, and where do I go to deal with it.
 *
 * Three rules follow from that, and every check below obeys them:
 *
 *   1. NOTHING WITHOUT AN ACTION. If a manager cannot do anything about it, it
 *      is not on this list. There is no "sales are down" row.
 *   2. EVERY ROW POINTS SOMEWHERE. Each carries the module it is dealt with in,
 *      so the screen is a set of doors rather than a set of complaints.
 *   3. AN EMPTY LIST IS A RESULT, NOT AN ERROR. "Nothing is waiting" is the
 *      most useful thing this screen can say, and it must be able to say it —
 *      which means no check may fire on a healthy, quiet, brand-new outlet.
 *      A screen that always has something on it is a screen people stop
 *      reading.
 *
 * Severity is what it costs to leave it: `now` is money or law moving in the
 * wrong direction, `today` is something that will be wrong by tonight, `watch`
 * is worth knowing. Sorted by that, then by size.
 */

const costing = require('./costing');

const SEVERITY_ORDER = { now: 0, today: 1, watch: 2 };

/* A margin this thin is a mistake somewhere — a mispriced dish, a recipe with a
   quantity in the wrong unit, or a cost that has run away. Not a target: a
   restaurant chooses its own margins, and this is the line below which the
   number stops being a business decision and starts being a defect. */
const BLEEDING_GP_PCT = 20;

/* One laari of variance is a miscount; a hundred rufiyaa is a conversation.
   Kept explicit and named rather than buried in a comparison. */
const DRAWER_VARIANCE_LAARI = 5000;      // MVR 50.00

const mvr = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Everything waiting on somebody, for one business date.
 * `taxRatePct` is the rate in force today, needed to measure margin against a
 * price net of tax.
 */
async function waiting(c, date, taxRatePct) {
  const items = [];
  const add = (x) => items.push(x);

  /* ── the ledger, first, because nothing else matters if this is wrong ──── */

  const balance = await c.query(
    'SELECT coalesce(sum(dr),0) - coalesce(sum(cr),0) AS diff FROM journal_line');
  const diff = mvr(balance.rows[0].diff);
  if (diff !== 0) {
    /* Should be unreachable — the deferred trigger refuses an unbalanced entry
       at COMMIT — which is exactly why it is checked. A guarantee nobody
       verifies is a belief. */
    add({
      id: 'ledger-unbalanced', severity: 'now', count: 1,
      title: 'The ledger does not balance',
      detail: 'Debits and credits differ by ' + diff.toFixed(2)
        + '. This should not be possible; every report built on the ledger is'
        + ' unreliable until it is found.',
      action: 'Open the trial balance', where: { module: 'reports' },
    });
  }

  /* ── cash ─────────────────────────────────────────────────────────────── */

  const stale = await c.query(
    'SELECT count(*)::int AS n, min(opened_at) AS oldest FROM drawer_session'
    + ' WHERE closed_at IS NULL AND opened_at::date < $1::date', [date]);
  if (stale.rows[0].n > 0) {
    add({
      id: 'register-left-open', severity: 'now', count: stale.rows[0].n,
      title: stale.rows[0].n === 1 ? 'A register was never counted'
        : stale.rows[0].n + ' registers were never counted',
      detail: 'Open since ' + new Date(stale.rows[0].oldest).toLocaleDateString('en-GB')
        + '. Until it is counted there is no over/short figure for that day, and'
        + " today's cash is being measured against the wrong opening balance.",
      action: 'Count and close it', where: { module: 'pos' },
    });
  }

  const variance = await c.query(
    'SELECT count(*)::int AS n, coalesce(sum(variance),0) AS total FROM drawer_session'
    + ' WHERE closed_at::date = $1::date AND abs(variance) * 100 >= $2', [date, DRAWER_VARIANCE_LAARI]);
  if (variance.rows[0].n > 0) {
    const total = mvr(variance.rows[0].total);
    add({
      id: 'drawer-variance', severity: 'today', count: variance.rows[0].n,
      title: 'A register counted ' + (total < 0 ? 'short' : 'over')
        + ' by ' + Math.abs(total).toFixed(2),
      detail: 'Posted to 6920 Cash over or short, so the accounts are right either'
        + ' way — but a drawer that misses by this much is a training or a'
        + ' shrinkage question, and it only gets answered while the shift is'
        + ' still remembered.',
      action: "See the day's Z-read", where: { module: 'reports' },
    });
  }

  const mismatch = await c.query(
    'SELECT count(*)::int AS n FROM sale WHERE business_date = $1::date'
    + ' AND client_total IS NOT NULL AND round(client_total,2) <> round(total,2)', [date]);
  if (mismatch.rows[0].n > 0) {
    add({
      id: 'till-disagreed', severity: 'today', count: mismatch.rows[0].n,
      title: mismatch.rows[0].n + ' receipt' + (mismatch.rows[0].n === 1 ? '' : 's')
        + ' where a till computed a different total',
      detail: "The server's figure was banked, so nothing was mischarged. But a"
        + ' terminal that disagrees is running something stale or something'
        + ' broken, and it will keep disagreeing until somebody looks.',
      action: 'Open the receipts', where: { module: 'orders' },
    });
  }

  /* ── the floor ────────────────────────────────────────────────────────── */

  const oldTickets = await c.query(
    "SELECT count(*)::int AS n FROM ticket WHERE status = 'open'"
    + ' AND opened_at::date < $1::date', [date]);
  if (oldTickets.rows[0].n > 0) {
    add({
      id: 'ticket-left-open', severity: 'today', count: oldTickets.rows[0].n,
      title: oldTickets.rows[0].n + ' ticket' + (oldTickets.rows[0].n === 1 ? '' : 's')
        + ' left open from a previous day',
      detail: 'Food went out and no money came back. Either it was settled on'
        + ' paper and never rung up, or it was walked. Both need a decision, and'
        + ' the table cannot be reused until one is made.',
      action: 'Open the floor', where: { module: 'orders' },
    });
  }

  const guestWaiting = await c.query(
    'SELECT count(*)::int AS n FROM guest_order'
    + ' WHERE accepted_at IS NULL AND rejected_reason IS NULL'
    + " AND at < now() - interval '10 minutes'");
  if (guestWaiting.rows[0].n > 0) {
    add({
      id: 'guest-order-waiting', severity: 'now', count: guestWaiting.rows[0].n,
      title: guestWaiting.rows[0].n + ' table order' + (guestWaiting.rows[0].n === 1 ? '' : 's')
        + ' nobody has picked up',
      detail: 'Ordered from a phone more than ten minutes ago and still not'
        + ' accepted at the till. The guest is sitting there believing the'
        + ' kitchen has it.',
      action: 'Open the floor', where: { module: 'pos' },
    });
  }

  /* ── stock ────────────────────────────────────────────────────────────── */

  const oversold = await c.query(
    "SELECT count(*)::int AS n, string_agg(name, ', ' ORDER BY name) AS names"
    + ' FROM ingredient WHERE on_hand < 0');
  if (oversold.rows[0].n > 0) {
    add({
      id: 'stock-negative', severity: 'now', count: oversold.rows[0].n,
      title: oversold.rows[0].n + ' item' + (oversold.rows[0].n === 1 ? '' : 's')
        + ' showing less than nothing in stock',
      detail: named(oversold.rows[0].names)
        + ' — the ledger says more was sold than was ever received. Either a'
        + ' delivery was never entered or a recipe is wrong. Every dish using'
        + ' it is being costed against a quantity that cannot exist.',
      action: 'Open inventory', where: { module: 'inventory' },
    });
  }

  /* A count sitting unapproved is the sharpest kind of decision waiting: the
     stock has NOT moved, so inventory is knowingly wrong until somebody signs,
     and the longer it waits the less anybody remembers about the shelf. */
  const pendingCounts = await c.query(
    'SELECT count(*)::int AS n, coalesce(sum(abs(variance_value)),0) AS value,'
    + ' min(at) AS oldest FROM stock_count'
    + " WHERE status = 'pending'");
  if (pendingCounts.rows[0].n > 0) {
    add({
      id: 'count-awaiting-approval', severity: 'now', count: pendingCounts.rows[0].n,
      title: pendingCounts.rows[0].n + ' stock count'
        + (pendingCounts.rows[0].n === 1 ? '' : 's') + ' waiting to be approved',
      detail: 'Worth ' + mvr(pendingCounts.rows[0].value).toFixed(2)
        + ' in variance, taken ' + new Date(pendingCounts.rows[0].oldest).toLocaleDateString('en-GB')
        + '. Nothing has moved: on-hand still shows the old figure, and every'
        + ' dish costed from it is being costed against stock the counter says'
        + ' is not there.',
      action: 'Review the count', where: { module: 'counts' },
    });
  }

  const belowPar = await c.query(
    "SELECT count(*)::int AS n, string_agg(name, ', ' ORDER BY name) AS names"
    + ' FROM ingredient WHERE par IS NOT NULL AND on_hand >= 0 AND on_hand < par');
  if (belowPar.rows[0].n > 0) {
    add({
      id: 'stock-below-par', severity: 'today', count: belowPar.rows[0].n,
      title: belowPar.rows[0].n + ' item' + (belowPar.rows[0].n === 1 ? '' : 's')
        + ' below par',
      detail: named(belowPar.rows[0].names) + ' — order today or the kitchen runs out.',
      action: 'Open inventory', where: { module: 'inventory' },
    });
  }

  /* "Unpriced deliveries" in this build's terms: stock that was received but
     has no cost against it, so every dish using it is costed short. */
  const uncosted = await c.query(
    "SELECT count(*)::int AS n, string_agg(i.name, ', ' ORDER BY i.name) AS names"
    + ' FROM ingredient i WHERE i.avg_cost = 0'
    + ' AND EXISTS (SELECT 1 FROM recipe_line r WHERE r.ingredient_id = i.id)');
  if (uncosted.rows[0].n > 0) {
    add({
      id: 'ingredient-uncosted', severity: 'today', count: uncosted.rows[0].n,
      title: uncosted.rows[0].n + ' ingredient' + (uncosted.rows[0].n === 1 ? '' : 's')
        + ' in use with no cost',
      detail: named(uncosted.rows[0].names)
        + ' — priced at zero, so every dish containing it reports a margin it is'
        + ' not making. Put the delivery price in and every recipe reprices itself.',
      action: 'Open recipes & costing', where: { module: 'recipes' },
    });
  }

  /* ── the menu ─────────────────────────────────────────────────────────── */

  /* Costed once, here, and reused for both menu checks — itemCost recurses
     through sub-recipes, and running it twice over a large menu is the kind of
     thing that makes a morning screen slow enough that nobody opens it. */
  const menu = await c.query(
    'SELECT i.id, i.name, i.price,'
    + ' (SELECT count(*)::int FROM recipe_line r WHERE r.item_id = i.id) AS lines,'
    + ' (SELECT count(*)::int FROM sale_line s JOIN sale sa ON sa.id = s.sale_id'
    + '   WHERE s.item_id = i.id AND sa.business_date = $1::date) AS sold_today'
    + ' FROM item i WHERE i.active', [date]);

  const noRecipe = [];
  const bleeders = [];
  for (const it of menu.rows) {
    // A dish that has never been ordered and has no recipe is a menu the
    // manager has not finished writing, not a decision waiting this morning.
    if (it.lines === 0) {
      if (it.sold_today > 0) noRecipe.push(it);
      continue;
    }
    const cost = await costing.itemCost(c, it.id);
    const gp = costing.grossProfit(
      Math.round(Number(it.price) * 100), Math.round(cost.cost), taxRatePct);
    if (gp.net > 0 && gp.gpPct < BLEEDING_GP_PCT) bleeders.push({ ...it, gpPct: gp.gpPct });
  }

  if (noRecipe.length) {
    add({
      id: 'sold-without-recipe', severity: 'today', count: noRecipe.length,
      title: noRecipe.length + ' dish' + (noRecipe.length === 1 ? '' : 'es')
        + ' sold today with no recipe',
      detail: named(noRecipe.map((x) => x.name).join(', '))
        + ' — sold at a cost of zero, so today\'s margin is overstated by whatever'
        + ' they actually cost, and no stock came out of the store for them.',
      action: 'Open recipes & costing', where: { module: 'recipes' },
    });
  }

  if (bleeders.length) {
    bleeders.sort((a, b) => a.gpPct - b.gpPct);
    const worst = bleeders[0];
    add({
      id: 'margin-bleeder', severity: 'watch', count: bleeders.length,
      title: bleeders.length === 1
        ? worst.name + ' is making ' + worst.gpPct + '% gross margin'
        : bleeders.length + ' dishes are making under ' + BLEEDING_GP_PCT + '% gross margin',
      detail: 'Worst is ' + worst.name + ' at ' + worst.gpPct + '%.'
        + ' At this level it is usually a recipe quantity in the wrong unit or a'
        + ' price that was never revisited after a cost rise — not a deliberate'
        + ' loss leader.',
      action: 'Open recipes & costing', where: { module: 'recipes' },
    });
  }

  const unpriced = await c.query(
    'SELECT count(*)::int AS n FROM item WHERE active AND price <= 0');
  if (unpriced.rows[0].n > 0) {
    add({
      id: 'item-unpriced', severity: 'today', count: unpriced.rows[0].n,
      title: unpriced.rows[0].n + ' item' + (unpriced.rows[0].n === 1 ? '' : 's')
        + ' on the menu with no price',
      detail: 'They can be rung up for nothing. Price them or take them off the'
        + ' menu — an item at zero is a hole in the till, not a free dish.',
      action: 'Open the menu', where: { module: 'menu' },
    });
  }

  items.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.count - a.count));

  return {
    date,
    items,
    /* Counts by severity, so the screen can say "two things need you now"
       without the client re-deriving it — and so an empty list is explicitly
       empty rather than inferred from a zero-length array. */
    now: items.filter((x) => x.severity === 'now').length,
    todayCount: items.filter((x) => x.severity === 'today').length,
    watch: items.filter((x) => x.severity === 'watch').length,
    clear: items.length === 0,
  };
}

/** Three names and a count, rather than forty names. A list nobody can read is
 *  the same as no list. */
function named(csv) {
  if (!csv) return '';
  const all = String(csv).split(', ');
  if (all.length <= 3) return all.join(', ');
  return all.slice(0, 3).join(', ') + ' and ' + (all.length - 3) + ' more';
}

module.exports = { waiting, BLEEDING_GP_PCT, DRAWER_VARIANCE_LAARI };
