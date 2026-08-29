'use strict';

/* ── CLEARING WHAT A STORE TRADED, AND KEEPING WHAT IT IS ────────────────────
   Asked for in one sentence: "reset only data. not menu. reset to the state
   where a new outlet is created. keep a record of the data and delete data."

   That is a different act from `npm run reset:database`, which drops the whole
   schema and takes the menu, the recipes, the floor plan and the staff with it
   — the way out of a store set up WRONG. This is the way out of a store set up
   RIGHT that has been traded on: a shop that spent a fortnight in training, or
   a demo that is about to become a real business. Its menu is the work; its
   takings are the thing to be rid of.

   THE LINE IS DRAWN BY THE SCHEMA, NOT BY A LIST SOMEBODY MAINTAINS. Every
   table in an outlet schema is on exactly one side of it, and the classifier
   below is asserted complete against the catalog on every run of the suite —
   a table added by a later migration and named on neither side FAILS the test
   rather than being silently kept (which would leave a store's old sales
   behind) or silently dropped (which would take a store's setup with it).

   AND ONE TRUNCATE, WITHOUT CASCADE. Every trade table goes in one statement,
   so Postgres itself checks the classification: if any table NOT on the list
   references one that is, the statement is refused and nothing is destroyed.
   CASCADE would paper over exactly the mistake worth catching — it would
   follow the reference out into a setup table and empty that too. Measured on
   a real outlet: 42 trade tables, 22 setup tables, and not one setup table
   references trade.

   THE RECORD IS WRITTEN BEFORE THE DELETE, and to `chain.audit`, which this
   build never prunes. "Keep a record of the data and delete data" is the whole
   instruction: afterwards nobody can count what was there, so the count has to
   be taken while it still exists and kept where a trail is kept. It carries
   every table's row count, the trading period, the gross taken and the number
   of bills — enough to answer "what did we throw away" a year later.
   ═══════════════════════════════════════════════════════════════════════ */

/* Everything trading produced. In one TRUNCATE, so the classification is
   checked by the database rather than trusted. */
const TRADE = [
  'bank_line', 'bank_opening', 'batch', 'clock_entry', 'count_line', 'credit_note',
  'delivery', 'depreciation_run', 'dispatch', 'dispatch_line', 'document',
  'door_line', 'door_receipt', 'drawer_session', 'grn_line', 'guest_order',
  'guest_request', 'indent', 'indent_line', 'journal', 'journal_line',
  'kds_ticket', 'op_log', 'opex_payment', 'payment', 'payroll_line',
  'payroll_run', 'period', 'po_line', 'print_job', 'production_batch',
  'purchase_order', 'reservation', 'sale', 'sale_line', 'settlement_batch',
  'stock_count', 'stock_move', 'ticket', 'ticket_line', 'vendor_invoice',
  'vendor_payment'
];

/* Everything the outlet IS. Named rather than derived as "the rest", so a
   table added later belongs to nobody until somebody decides — see the test. */
const SETUP = [
  'account', 'asset', 'banner', 'employee', 'ingredient', 'ingredient_unit',
  'item', 'item_modifier', 'location', 'maintenance_log', 'menu_category',
  'menu_section', 'modifier', 'modifier_group', 'opex', 'price_override',
  'promo', 'recipe_line', 'rota_shift', 'setting', 'table_def', 'zone'
];

function ident(s) {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('bad identifier: ' + s);
  return '"' + s + '"';
}

/* EVERY NAME IS QUALIFIED, and on this path that is not style. Most of this
   build runs under an outlet's own login role, whose `search_path` is PINNED
   to its own schema — so an unqualified name cannot resolve anywhere else even
   if somebody got the id wrong. The reset does not (see below), and an
   unqualified TRUNCATE on a connection that can reach every schema in the
   database is exactly the mistake worth making unavailable. */
function outletSchema(outletId) {
  const n = Number(outletId);
  if (!Number.isInteger(n) || n <= 0) throw new Error('not an outlet id: ' + outletId);
  return 'outlet_' + n;
}
const at = (outletId, t) => outletSchema(outletId) + '.' + ident(t);

/* What is about to go — counted while it still exists, because afterwards
   nobody can. Rows per table, plus the three figures a person actually asks
   about later: what was taken, over how many bills, between which dates. */
async function census(c, outletId) {
  const rows = {};
  for (const t of TRADE) {
    const q = await c.query('SELECT count(*)::int AS n FROM ' + at(outletId, t));
    if (q.rows[0].n) rows[t] = q.rows[0].n;
  }
  const took = await c.query('SELECT count(*)::int AS bills, coalesce(sum(total),0) AS gross,'
    + ' min(business_date) AS since, max(business_date) AS until'
    + ' FROM ' + at(outletId, 'sale') + ' WHERE voided_at IS NULL');
  const t = took.rows[0] || {};
  return {
    rows: rows,
    bills: Number(t.bills) || 0,
    gross: Number(t.gross) || 0,
    from: t.since ? String(t.since).slice(0, 10) : null,
    to: t.until ? String(t.until).slice(0, 10) : null
  };
}

/* A TILL CANNOT DESTROY ITS OWN SALES, AND THAT IS THE POINT — so this runs on
   the owner connection, and it is the SEVENTH entry on the list CLAUDE.md keeps
   and `test/wiring.test.js` pins.

   The other six are there because they ask a question no outlet role can answer.
   This one is the opposite shape and justifies itself differently: an outlet's
   login role holds SELECT, INSERT and UPDATE on its own trade tables and NO
   DELETE and NO TRUNCATE — measured, not assumed — so a compromised terminal
   cannot empty a store's sales, and a void is a row it UPDATES rather than one
   it removes. Granting TRUNCATE to make this handler convenient would spend
   that property on every outlet on the estate, permanently, to serve one act a
   rank-5 owner performs at most once in a store's life. Same doctrine as
   `chain.licence`, which no outlet role may write for the same reason: the
   protection IS the absent grant.

   So the bypass is deliberate, and the two fences that make it safe are here
   rather than inherited. Every name is schema-qualified above, because an
   unqualified one on a connection that can reach every schema is the mistake
   worth making unavailable. And the address is `ownerForOutlet()`, never
   `owner()`: in a registry install `owner()` is the database this process
   happens to sit on, which is one nobody trades in — the lock screen, the GST
   registration and the handle rename each paid for that lesson once already. */
async function resetTrade(ctx, opts) {
  const db = require('./db');
  const o = opts || {};
  const pool = await db.ownerForOutlet(ctx.outletId);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    /* The context is what puts the actor, the rank and the device into
       `chain.log()`'s columns. An owner connection has none of it by default —
       it is not carried by the pool, it is set per transaction. */
    await db.setContext(c, ctx);
    const out = await clear(c, ctx, o);
    await db.commit(c);
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function clear(c, ctx, o) {
  const took = await census(c, ctx.outletId);

  /* THE RECORD FIRST. chain.audit is never pruned, and this is the one act
     after which the evidence cannot be re-read.

     Through `chain.log()` rather than `log_anon()`: this runs inside the
     outlet's own transaction context, so the actor, the rank and the device
     land in the COLUMNS a trail is read by. `log_anon` exists for the one
     moment there is no session to read — a failed sign-in — and this is the
     opposite of that moment. The census is the `before`, because that is
     exactly what it is: the state that existed and is about to stop. */
  await c.query("SELECT chain.log('store_trade_reset','outlet',$1,$2,$3)",
    [String(ctx.outletId), JSON.stringify({
      bills: took.bills, gross: took.gross, from: took.from, to: took.to,
      rows: took.rows
    }), JSON.stringify({ why: String(o.why || '').slice(0, 400) })]);

  await c.query('TRUNCATE ' + TRADE.map((t) => at(ctx.outletId, t)).join(', ')
    + ' RESTART IDENTITY');

  /* WHAT THE SHELF HOLDS IS A TRADED FIGURE, and the moves that made it have
     just gone. Leaving on_hand behind would leave a store believing in stock
     no delivery in its records ever brought in — and avg_cost with it, which
     is what a sale is valued at. A new outlet's shelf is empty. */
  await c.query('UPDATE ' + at(ctx.outletId, 'ingredient')
    + ' SET on_hand = 0, avg_cost = 0 WHERE on_hand <> 0 OR avg_cost <> 0');

  /* Documents start at one again. A series that has issued a number can never
     be RENUMBERED — that rule is about the prefix, and it stands — but every
     document this series issued has just been destroyed, so continuing from
     4,312 would number the first receipt of a store with no receipts. */
  await c.query('UPDATE chain.doc_series SET next_no = 1, used = false'
    + ' WHERE outlet_id = $1', [ctx.outletId]);

  /* POINTS AND CREDIT ARE CHAIN-WIDE, and that is why this is conditional
     rather than tidy. A member's balance is one figure across every outlet the
     business has; the sales that built it at THIS outlet are gone, so the
     2350 liability no longer ties — but zeroing a balance a SISTER outlet is
     still trading against would take away points a guest earned somewhere this
     reset never touched. So it happens only where this outlet is the whole
     business, and where it does not, the record says so and the discrepancy is
     named rather than discovered. */
  const outlets = await c.query('SELECT count(*)::int AS n FROM chain.outlet WHERE active');
  const only = Number(outlets.rows[0].n) <= 1;
  let members = 0;
  if (only) {
    const m = await c.query('UPDATE chain.member SET points = 0, credit_used = 0'
      + ' WHERE points <> 0 OR credit_used <> 0 RETURNING id');
    members = m.rowCount;
  }

  return {
    ok: true,
    tables: Object.keys(took.rows).length,
    rows: Object.keys(took.rows).reduce((n, k) => n + took.rows[k], 0),
    bills: took.bills, gross: took.gross, from: took.from, to: took.to,
    membersCleared: members,
    loyaltyKept: !only,
    kept: SETUP.length
  };
}

module.exports = { resetTrade, census, TRADE, SETUP };

