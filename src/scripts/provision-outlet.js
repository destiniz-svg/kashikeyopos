'use strict';
/* ═══ RE-PROVISION AN OUTLET'S DATABASE ROLE ════════════════════════════════
   Every outlet has its own Postgres schema and its own login role, and that
   role's password is DERIVED from OUTLET_ROLE_SECRET rather than stored:

       password = hmac_sha256(OUTLET_ROLE_SECRET, "outlet:" + id)

   Nothing readable inside the database yields another outlet's credentials.
   The cost of that is a rotation step: change the secret and every derived
   password changes with it, so every role has to be told its new one before
   any outlet can be reached again.

   That is what this does. It re-runs chain.provision_outlet() for an outlet,
   which ALTERs the role's password to the freshly derived value and re-applies
   the grants — idempotent, so it is also the way to repair an outlet whose
   grants have drifted, and the way a new migration's function grants reach
   outlets that were provisioned before it.

     npm run provision:outlet -- --all           every outlet in the chain
     npm run provision:outlet -- --id 3          just outlet 3

   Adding a NEW outlet is not this script's job — a branch is added from the
   cockpit (Chain & Outlets) at rank 5, so that it happens inside the audit
   trail with a person's name on it.
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, shutdown } = require('../db');
const { outletPassword } = require('../secrets');

async function run(say) {
  const log = say || console.log;                       // eslint-disable-line no-console
  const argv = process.argv.slice(2);
  const all = argv.indexOf('--all') >= 0;
  const at = argv.indexOf('--id');
  const only = at >= 0 ? Number(argv[at + 1]) : null;

  if (!all && !only) {
    throw new Error('name what to do: --all, or --id <n>');
  }

  const pool = owner();
  const q = await pool.query(
    'SELECT id, code, name FROM chain.outlet'
    + (only ? ' WHERE id = $1' : '') + ' ORDER BY id',
    only ? [only] : []);
  if (!q.rows.length) throw new Error(only ? 'no outlet ' + only : 'no outlets to provision');

  const done = [];
  for (const o of q.rows) {
    await pool.query('SELECT chain.provision_outlet($1,$2,$3,$4)',
      [o.id, o.code, o.name, outletPassword(o.id)]);
    log('[provision] outlet_' + o.id + ' (' + o.code + ') — role password set, grants re-applied');
    done.push(o.id);
  }
  log('[provision] ' + done.length + ' outlet(s) reachable again');
  return done;
}

if (require.main === module) {
  run().then(() => shutdown()).then(() => process.exit(0))
    .catch((e) => {
      console.error('[provision] ' + e.message);        // eslint-disable-line no-console
      process.exit(1);
    });
}

module.exports = { run };
