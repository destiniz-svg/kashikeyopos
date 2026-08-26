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

     npm run provision:outlet -- --all           every outlet, every business
     npm run provision:outlet -- --id 3          just outlet 3
     npm run provision:outlet -- --business 2    every outlet of one business

   EVERY BUSINESS, because this is the RECOVERY path and it had the same
   defect as the things it recovers. It read chain.outlet through owner() —
   the database this process dialled — which in a registry install is one
   nobody trades in, so it answered `relation "chain.outlet" does not exist`
   and stopped. That is the remedy /readyz names in its own 503, so the
   recovery instruction did not work, which is the worst place in the build
   for a control that says something it cannot do. Found by running the
   restore drill DEPLOYMENT.md asks for.

   Adding a NEW outlet is not this script's job — a branch is added from the
   cockpit (Chain & Outlets) at rank 5, so that it happens inside the audit
   trail with a person's name on it.
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, ownerFor, control, CONTROL_DB, shutdown } = require('../db');
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

  /* WHICH DATABASES HOLD OUTLETS. Without a registry there is one and it is
     this process's own; with one, every live business has its own and an
     outlet id is globally unique across them. A failure in one business is
     REPORTED and does not stop the others — this runs when things are already
     broken, and stopping at the first bad customer would leave every later
     one unrecovered. */
  const bizArg = argv.indexOf('--business');
  const onlyBiz = bizArg >= 0 ? Number(argv[bizArg + 1]) : null;
  const targets = [];
  if (CONTROL_DB()) {
    const b = await control().query(
      "SELECT id, db_name FROM chain.business WHERE status = 'live'"
      + (onlyBiz ? ' AND id = $1' : '') + ' ORDER BY id', onlyBiz ? [onlyBiz] : []);
    if (!b.rows.length) {
      throw new Error(onlyBiz ? 'no live business ' + onlyBiz
        : 'the registry lists no live business — nothing to provision');
    }
    b.rows.forEach((x) => targets.push({ label: x.db_name, pool: ownerFor(x.db_name) }));
  } else {
    targets.push({ label: 'this database', pool: owner() });
  }

  const done = [];
  const failed = [];
  let found = 0;
  for (const t of targets) {
    let rows;
    try {
      const q = await t.pool.query(
        'SELECT id, code, name FROM chain.outlet'
        + (only ? ' WHERE id = $1' : '') + ' ORDER BY id',
        only ? [only] : []);
      rows = q.rows;
    } catch (e) {
      failed.push(t.label + ': ' + e.message);
      log('[provision] ' + t.label + ' — could not be read: ' + e.message);
      continue;
    }
    found += rows.length;
    for (const o of rows) {
      try {
        await t.pool.query('SELECT chain.provision_outlet($1,$2,$3,$4)',
          [o.id, o.code, o.name, outletPassword(o.id)]);
        log('[provision] ' + t.label + ' · outlet_' + o.id + ' (' + o.code
          + ') — role password set, grants re-applied');
        done.push(o.id);
      } catch (e) {
        failed.push(t.label + ' outlet ' + o.id + ': ' + e.message);
        log('[provision] ' + t.label + ' · outlet_' + o.id + ' FAILED: ' + e.message);
      }
    }
  }
  if (!found && !failed.length) {
    throw new Error(only ? 'no outlet ' + only : 'no outlets to provision');
  }
  log('[provision] ' + done.length + ' outlet(s) reachable again'
    + (failed.length ? ', ' + failed.length + ' still broken' : ''));
  // A recovery that half worked must not exit 0: the next thing somebody does
  // is trust it and walk away.
  if (failed.length) {
    throw Object.assign(new Error('could not provision: ' + failed.join('; ')),
      { partial: done });
  }
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
