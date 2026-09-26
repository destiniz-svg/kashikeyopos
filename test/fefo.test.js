'use strict';
/* ═══ A LOT IS DRAWN DOWN (060) ═════════════════════════════════════════════
   Stock that leaves the shelf is taken from the item's lots, earliest use-by
   first, and a void puts back exactly what it took. Allocation only: the
   move's value is avg_cost × qty whichever lot it came from.

   Its own registry and business database, like test/reset.test.js. */
const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const crypto = require('crypto');
const DB = require('./db');

DB.secrets();
process.env.BUSINESS_DB_PREFIX = 'kfefo_biz_';
const CONTROL = process.env.PGTESTCONTROL_FEFO || 'kashikeyo_control_fefo';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

async function sql(database, text, params) {
  const c = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: database
  });
  await c.connect();
  try { return (await c.query(text, params || [])).rows; } finally { await c.end(); }
}

let dbmod, apply, DBNAME, O, ctx, S;
const op = (kind, payload) => dbmod.withOutlet(ctx, (cl) => apply.applyOp(cl,
  { opId: crypto.randomUUID(), kind: kind, lamport: 1, payload: payload }, ctx));
const lots = async () => (await sql(DBNAME, 'SELECT lot, qty::float8 AS qty, state FROM '
  + S + '.batch ORDER BY lot')).reduce((a, r) => { a[r.lot] = [r.qty, r.state]; return a; }, {});

test('a store with three lots of one item', opts, async () => {
  process.env.CONTROL_DB = await DB.freshControl(CONTROL);
  await DB.dropBusinessDatabases();
  await require('../src/scripts/migrate').migrateControl(() => {});
  dbmod = require('../src/db');
  apply = require('../src/apply');
  const business = await require('../src/business').createBusiness({ name: 'FEFO Drill Pvt Ltd' });
  DBNAME = business.db_name;
  const o = await require('../src/provision').provisionOutlet({ db: DBNAME, code: 'FEFO',
    name: 'Lots', slug: 'fefo' + String(Date.now()).slice(-6), tz: 'Indian/Maldives' });
  O = o.id || o;
  S = 'outlet_' + O;
  const staff = await sql(DBNAME, "INSERT INTO chain.staff (name, rank, role_key, outlet_id,"
    + " pin_hash, pin_salt) VALUES ('Owner', 5, 'SuperAdmin', $1, 'x', 'y') RETURNING id", [O]);
  ctx = { outletId: O, rank: 5, actor: staff[0].id, scope: 'outlet', db: DBNAME };

  await sql(DBNAME, 'INSERT INTO ' + S + '.menu_category (id, name, pos) VALUES (\'m\', \'Mains\', 1)');
  await sql(DBNAME, 'INSERT INTO ' + S + '.item (id, name, price, category_id)'
    + " VALUES ('d1', 'Mas Riha', 85, 'm')");
  // 12 kg on the shelf, at 90 a kg, in three lots. B expires first.
  await sql(DBNAME, 'INSERT INTO ' + S + '.ingredient (id, name, base_unit, stock_unit, on_hand, avg_cost)'
    + " VALUES ('i1', 'Reef fish', 'kg', 'kg', 12, 90)");
  await sql(DBNAME, 'INSERT INTO ' + S + '.batch (ingredient_id, lot, qty, unit_cost, use_by, received_at) VALUES'
    + " ('i1', 'A', 4, 80, current_date + 5, now() - interval '2 days'),"
    + " ('i1', 'B', 3, 95, current_date + 2, now() - interval '1 day'),"
    + " ('i1', 'C', 5, 90, NULL, now() - interval '3 days')");
  assert.deepStrictEqual(await lots(), { A: [4, 'holding'], B: [3, 'holding'], C: [5, 'holding'] });
});

test('waste is taken earliest use-by first, and the lot it empties is used', opts, async () => {
  await op('stock_adjust', { ing: 'i1', qty: -5, reason: 'waste', value: 450, note: 'dropped' });
  assert.deepStrictEqual(await lots(), { A: [2, 'open'], B: [0, 'used'], C: [5, 'holding'] },
    'B (use by +2) gives all 3, then A (+5) gives 2; C, with no date, is last');
  const mv = await sql(DBNAME, 'SELECT value::float8 AS v FROM ' + S + ".stock_move WHERE reason = 'waste'");
  assert.strictEqual(mv[0].v, 450, 'the money that moved is what it was: allocation only');
});

let saleId;
test('a sale draws the rest of A, then C', opts, async () => {
  const r = await op('sale', { bizDate: null, covers: 1, sub: 85, disc: 0, net: 85, svc: 0,
    tax: 0, round: 0, total: 85, sold: [{ id: 'd1', name: 'Mas Riha', qty: 1, price: 85, amount: 85 }],
    payments: [{ method: 'cash', amt: 85 }],
    stockMoves: [{ ing: 'i1', qty: 3, cost: 90, value: 270 }] });
  saleId = r.saleId || r.id || (await sql(DBNAME, 'SELECT id FROM ' + S + '.sale'))[0].id;
  assert.deepStrictEqual(await lots(), { A: [0, 'used'], B: [0, 'used'], C: [4, 'open'] });
  const draws = await sql(DBNAME, 'SELECT b.lot, d.qty::float8 AS qty FROM ' + S + '.batch_draw d JOIN '
    + S + '.batch b ON b.id = d.batch_id JOIN ' + S + ".stock_move m ON m.id = d.move_id"
    + " WHERE m.reason = 'sale' ORDER BY b.lot");
  assert.deepStrictEqual(draws, [{ lot: 'A', qty: 2 }, { lot: 'C', qty: 1 }]);
});

test('a void puts back exactly what the sale took, onto the lots it came from, once', opts, async () => {
  await op('void_sale', { saleId: saleId, reason: 'wrong table' });
  assert.deepStrictEqual(await lots(), { A: [2, 'open'], B: [0, 'used'], C: [5, 'open'] });
  const open = await sql(DBNAME, 'SELECT count(*)::int AS n FROM ' + S + '.batch_draw WHERE undone_by IS NULL'
    + ' AND move_id IN (SELECT id FROM ' + S + ".stock_move WHERE reason = 'sale')");
  assert.strictEqual(open[0].n, 0, 'both draws are marked as undone, not deleted');
});

test('a transfer inside the outlet draws nothing; throwing a lot away draws only that lot', opts, async () => {
  await op('transfer', { ing: 'i1', qty: 1, from: null, to: null, value: 90 });
  assert.deepStrictEqual(await lots(), { A: [2, 'open'], B: [0, 'used'], C: [5, 'open'] },
    'the stock never left the outlet');
  const c = (await sql(DBNAME, 'SELECT id FROM ' + S + ".batch WHERE lot = 'C'"))[0].id;
  await op('batch_close', { batchId: c, state: 'wasted', note: 'freezer failed' });
  assert.deepStrictEqual(await lots(), { A: [2, 'open'], B: [0, 'used'], C: [0, 'wasted'] },
    'A keeps its 2: the write-off named its lot');
});

test('stops the pools', opts, async () => { await dbmod.shutdown(); });
