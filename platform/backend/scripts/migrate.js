'use strict';
// Idempotent: every migration is CREATE ... IF NOT EXISTS or CREATE OR REPLACE,
// so Railway can run this on every boot without a lock table.
const fs = require('fs');
const path = require('path');
const { owner, shutdown } = require('../src/db');

// Postgres has no bind parameters in DDL, so a password is quoted literally.
function quote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

(async function () {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.sql'); }).sort();
  const c = await owner().connect();
  try {
    for (const f of files) {
      process.stdout.write('→ ' + f + ' ');
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log('ok');
    }
    // The report role exists once, chain-wide, and can read nothing directly:
    // it may only EXECUTE the aggregate function, which enforces group scope.
    const pw = process.env.REPORT_ROLE_PASSWORD;
    if (!pw) throw new Error("REPORT_ROLE_PASSWORD must be set");
    const has = await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_report'");
    if (!has.rows.length) {
      await c.query("CREATE ROLE kashikeyo_report LOGIN PASSWORD " + quote(pw));
    } else {
      await c.query("ALTER ROLE kashikeyo_report PASSWORD " + quote(pw));
    }
    await c.query("REVOKE ALL ON SCHEMA public FROM kashikeyo_report");
    await c.query("GRANT USAGE ON SCHEMA chain, app TO kashikeyo_report");
    await c.query("GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report");
    await c.query("GRANT EXECUTE ON FUNCTION app.group_scope(), app.current_rank(),"
      + " app.current_outlet(), app.current_actor() TO kashikeyo_report");
    console.log('migrations complete');
  } finally { c.release(); await shutdown(); }
})().catch(function (e) { console.error(e); process.exit(1); });
