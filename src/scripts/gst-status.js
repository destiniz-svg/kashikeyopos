'use strict';
/* ═══ WHAT IS THIS INSTALL'S GST POSITION? ══════════════════════════════════
   Registration is conditional and it changes over a business's life, so "are we
   registered, and does the whole install agree?" is a question worth being able
   to ask of a running environment rather than inferred from a screenshot.

   It reports, and then it PROVES the guards are live — by attempting the writes
   that must fail, inside a transaction it rolls back. Nothing here changes a
   single row: an install being diagnosed is not an install to experiment on.

     npm run gst:status
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, shutdown } = require('../db');

async function run(say) {
  const log = say || console.log;                        // eslint-disable-line no-console
  const pool = owner();

  const who = await pool.query('SELECT current_database() AS db');
  log('[gst] database   : ' + who.rows[0].db);

  const co = await pool.query('SELECT legal_name, gst_registered, tin FROM chain.company WHERE id = 1');
  if (!co.rows.length) {
    log('[gst] company    : none yet — this install has not been onboarded');
  } else {
    const c = co.rows[0];
    log('[gst] company    : ' + c.legal_name);
    log('[gst] registered : ' + (c.gst_registered ? 'YES' : 'no'));
    log('[gst] tin        : ' + (c.tin ? c.tin : '(none — correct for an unregistered business)'));
  }

  const fn = await pool.query('SELECT chain.gst_registered() AS on');
  log('[gst] gst_registered() -> ' + fn.rows[0].on);

  const outs = await pool.query('SELECT id, name, tax_code FROM chain.outlet ORDER BY id');
  if (!outs.rows.length) log('[gst] outlets    : none yet');
  outs.rows.forEach((o) => log('[gst] outlet ' + o.id + '    : ' + o.name + ' -> ' + o.tax_code));

  const rates = await pool.query(
    'SELECT outlet_id, code, rate, effective_from FROM chain.tax_version'
    + ' WHERE outlet_id IS NOT NULL ORDER BY outlet_id, effective_from');
  rates.rows.forEach((r) => log('[gst] rate       : outlet ' + r.outlet_id + ' ' + r.code
    + ' ' + r.rate + '% from ' + String(r.effective_from).slice(0, 10)));
  const statutory = await pool.query(
    'SELECT count(*)::int AS n FROM chain.tax_version WHERE outlet_id IS NULL');
  log('[gst] statutory  : ' + statutory.rows[0].n + ' row(s) of the country\'s own rates');

  /* ── are the guards even installed? ──────────────────────────────────────
     Asked of the catalogue, so it is answerable on an EMPTY install — which is
     the state a fresh environment is in, and exactly when you want to know
     that a migration landed. The live probe below needs a business to probe
     against; this does not. */
  const parts = await pool.query(
    "SELECT 'constraint company_tin_iff_registered' AS what,"
    + "        EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_tin_iff_registered') AS ok"
    + ' UNION ALL SELECT \'trigger outlet_tax_guard\','
    + "        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'outlet_tax_guard' AND NOT tgisinternal)"
    + ' UNION ALL SELECT \'trigger tax_version_guard\','
    + "        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tax_version_guard' AND NOT tgisinternal)"
    + ' UNION ALL SELECT \'function chain.gst_registered()\','
    + "        to_regprocedure('chain.gst_registered()') IS NOT NULL"
    + ' UNION ALL SELECT \'function chain.register_for_gst()\','
    + "        to_regprocedure('chain.register_for_gst(text,text,numeric,date)') IS NOT NULL"
    + ' UNION ALL SELECT \'company.tin is nullable\','
    + '        (SELECT NOT attnotnull FROM pg_attribute'
    + "          WHERE attrelid = 'chain.company'::regclass AND attname = 'tin')"
    + ' UNION ALL SELECT \'provision_outlet follows the company\','
    + "        (SELECT prosrc LIKE '%gst_registered()%' FROM pg_proc p"
    + '          JOIN pg_namespace n ON n.oid = p.pronamespace'
    + "          WHERE n.nspname = 'chain' AND p.proname = 'provision_outlet')");
  const absent = parts.rows.filter((r) => !r.ok);
  parts.rows.forEach((r) => log('[gst] installed  : ' + r.what + ' -> '
    + (r.ok ? 'yes' : '*** MISSING ***')));
  if (absent.length) {
    throw new Error('not installed: ' + absent.map((a) => a.what).join(', ')
      + ' — this environment has not run migration 014');
  }

  /* ── the guards, proven rather than asserted ─────────────────────────────
     Every write below is expected to FAIL, and the whole block is rolled back
     whatever happens. If one of them succeeds, this install would let a
     business charge tax it is not registered to collect — which is the entire
     point of the feature and worth failing loudly over. */
  const c = await pool.connect();
  const results = [];
  const mustFail = async (what, sql, params) => {
    try {
      await c.query('SAVEPOINT probe');
      await c.query(sql, params || []);
      await c.query('ROLLBACK TO SAVEPOINT probe');
      results.push({ what: what, guarded: false });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT probe').catch(() => {});
      results.push({ what: what, guarded: true, why: e.message.split('\n')[0] });
    }
  };

  try {
    await c.query('BEGIN');
    if (!co.rows.length) {
      log('[gst] guards     : not probed — nothing onboarded to probe against');
    } else {
      // Put the transaction into the unregistered state, whatever it is now.
      await c.query("UPDATE chain.outlet SET tax_code = 'NONE'");
      await c.query("DELETE FROM chain.tax_version WHERE outlet_id IS NOT NULL AND code <> 'NONE'");
      await c.query('UPDATE chain.company SET gst_registered = false, tin = NULL WHERE id = 1');

      await mustFail('registered with no TIN',
        'UPDATE chain.company SET gst_registered = true WHERE id = 1');
      if (outs.rows.length) {
        await mustFail('an outlet charging GGST',
          "UPDATE chain.outlet SET tax_code = 'GGST' WHERE id = $1", [outs.rows[0].id]);
        await mustFail('a GGST rate version',
          'INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from)'
          + " VALUES ($1,'GGST',8,current_date)", [outs.rows[0].id]);
      }
      results.forEach((r) => log('[gst] guard      : ' + r.what + ' -> '
        + (r.guarded ? 'REFUSED (' + r.why + ')' : '*** ALLOWED — NOT GUARDED ***')));
    }
  } finally {
    // Always. This script diagnoses; it does not change anything.
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }

  const holes = results.filter((r) => !r.guarded);
  if (holes.length) {
    throw new Error('these writes were NOT refused: ' + holes.map((h) => h.what).join(', '));
  }
  log('[gst] every guard held, and nothing was changed');
  return { registered: fn.rows[0].on, outlets: outs.rows.length, guards: results.length };
}

if (require.main === module) {
  run().then(() => shutdown()).then(() => process.exit(0))
    .catch((e) => {
      console.error('[gst] ' + e.message);                // eslint-disable-line no-console
      process.exit(1);
    });
}

module.exports = { run };
