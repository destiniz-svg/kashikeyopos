'use strict';
// Usage: npm run provision:outlet -- 3 MAL-01 "Kashikeyo Male'"
//
// Creates the outlet's own schema, its own login role with a derived password,
// its document series and its chart of accounts. Run it again to rotate the
// role's password after changing OUTLET_ROLE_SECRET.
const { owner, shutdown } = require('../src/db');
const { outletPassword } = require('../src/secrets');

(async function () {
  const [id, code, name] = process.argv.slice(2);
  if (!id || !code || !name) {
    console.error('usage: provision-outlet <id> <code> <name>');
    process.exit(2);
  }
  const c = await owner().connect();
  try {
    await c.query('BEGIN');
    const s = await c.query('SELECT chain.provision_outlet($1,$2,$3,$4) AS schema',
      [Number(id), code, name, outletPassword(Number(id))]);
    await c.query('SELECT chain.seed_chart($1)', [s.rows[0].schema]);
    await c.query('GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report');
    await c.query('COMMIT');
    console.log('provisioned ' + s.rows[0].schema + ' with role outlet_' + id + '_app');
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally { c.release(); await shutdown(); }
})().catch(function (e) { console.error(e.message); process.exit(1); });
