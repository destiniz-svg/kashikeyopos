'use strict';
// Idempotent: every migration is CREATE ... IF NOT EXISTS or CREATE OR REPLACE,
// so Railway can run this on every boot without a lock table.
const fs = require('fs');
const path = require('path');
const { owner, shutdown } = require('../src/db');
const { rolePassword } = require('../src/secrets');

// Postgres has no bind parameters in DDL, so a password is quoted literally.
function quote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(name + ' must be set');
  return v;
}

/** Create a login role, or reset its password if it is already there. */
async function ensureRole(c, name, password) {
  const has = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  if (!has.rows.length) {
    await c.query('CREATE ROLE ' + name + ' LOGIN PASSWORD ' + quote(password));
  } else {
    await c.query('ALTER ROLE ' + name + ' PASSWORD ' + quote(password));
  }
}

(async function () {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.sql'); }).sort();
  const c = await owner().connect();
  try {
    /* THE ROLES ARE CREATED FIRST, and their grants are issued afterwards.
       A migration can only GRANT to a role that exists, so a role created at
       the end of this script would have every grant in every migration file
       skipped on the first run and applied on the second — a system that works
       on its second deploy and not its first, which is the worst kind of
       working. Creating the login here and granting later is the ordering that
       has no such gap. */
    await ensureRole(c, 'kashikeyo_report', requiredEnv('REPORT_ROLE_PASSWORD'));
    /* The member role's password is DERIVED, like every outlet role's, so the
       platform needs no additional variable to hold and no way to leak one.
       See migrations/024 for what it may reach. */
    await ensureRole(c, 'kashikeyo_member', rolePassword('member'));

    for (const f of files) {
      process.stdout.write('→ ' + f + ' ');
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log('ok');
    }
    // The report role can read nothing directly: it may only EXECUTE the
    // aggregate function, which enforces group scope. Its grants are here
    // because they name chain.estate_day, which migration 003 creates.
    await c.query("REVOKE ALL ON SCHEMA public FROM kashikeyo_report");
    await c.query("REVOKE ALL ON SCHEMA public FROM kashikeyo_member");
    await c.query("GRANT USAGE ON SCHEMA chain, app TO kashikeyo_report");
    await c.query("GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report");
    await c.query("GRANT EXECUTE ON FUNCTION app.group_scope(), app.current_rank(),"
      + " app.current_outlet(), app.current_actor() TO kashikeyo_report");
    console.log('migrations complete');
  } finally { c.release(); await shutdown(); }
})().catch(function (e) { console.error(e); process.exit(1); });
