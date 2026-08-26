'use strict';
/* ═══ TAKE A COPY ═══════════════════════════════════════════════════════════
     npm run backup                       the registry, then every live business
     npm run backup -- --business 3       just that one
     npm run backup -- --db kashikeyo_biz_3
     npm run backup -- --list             what is on the shelf
     npm run backup -- --check            is this install able to take one

   The schedule in server.js calls the same function, so a run by hand and a
   run at 3 a.m. cannot differ. Everything it does is recorded in
   chain.backup — including the runs that fail, which are the rows that
   matter: a shelf showing only successes reads as "backed up nightly" on an
   install whose last four nights did not.
   ═══════════════════════════════════════════════════════════════════════ */

const backup = require('../backup');
const { control, shutdown, businessDb } = require('../db');

const MB = (n) => (Number(n || 0) / 1024 / 1024).toFixed(1) + ' MB';

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf('--' + n);
    return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
  };

  if (arg('check')) {
    const h = await backup.health();
    console.log('[backup] destination · ' + (h.driver ? h.driver + ' → ' + h.where : 'NONE'));
    console.log('[backup] tool        · ' + (h.tool || 'NOT FOUND'));
    console.log('[backup] able to run · ' + (h.configured ? 'yes' : 'NO — ' + h.reason));
    if (h.lastGood) {
      console.log('[backup] last good   · ' + h.lastGood.db_name + '  '
        + new Date(h.lastGood.finished_at).toISOString() + '  ' + MB(h.lastGood.bytes));
    } else {
      console.log('[backup] last good   · none on record');
    }
    return h.configured ? 0 : 1;
  }

  if (arg('list')) {
    const rows = await backup.list(Number(arg('limit')) || 30);
    if (!rows.length) { console.log('[backup] nothing on the shelf yet'); return 0; }
    rows.forEach((r) => console.log(
      '  ' + new Date(r.started_at).toISOString()
      + '  ' + (r.ok ? 'ok  ' : 'FAIL')
      + '  ' + String(r.db_name).padEnd(24)
      + '  ' + String(r.ok ? MB(r.bytes) : '').padStart(9)
      + '  ' + (r.ok ? (r.location || '') : (r.why || ''))
      + (r.ok ? '  ' + String(r.id) : '')));
    return 0;
  }

  const h = await backup.health();
  if (!h.configured) {
    console.error('[backup] cannot run: ' + h.reason);
    return 1;
  }

  const only = arg('business');
  const oneDb = arg('db');
  let out;
  if (oneDb && oneDb !== true) {
    const b = await control().query('SELECT id FROM chain.business WHERE db_name = $1',
      [String(oneDb)]);
    const r = await backup.backupOne({ db: String(oneDb),
      businessId: b.rows.length ? Number(b.rows[0].id) : null, by: 'cli' });
    out = { ok: r.ok, runs: [r], failed: r.ok ? [] : [r] };
    console.log('[backup] ' + r.db + (r.ok ? '  ' + MB(r.bytes) + '  ' + r.location
      : '  FAILED  ' + r.why));
  } else if (only && only !== true) {
    const b = await control().query(
      'SELECT id, db_name FROM chain.business WHERE id = $1', [Number(only)]);
    if (!b.rows.length) { console.error('[backup] no business ' + only); return 1; }
    const r = await backup.backupOne({ db: b.rows[0].db_name,
      businessId: Number(b.rows[0].id), by: 'cli' });
    out = { ok: r.ok, runs: [r], failed: r.ok ? [] : [r] };
    console.log('[backup] ' + r.db + (r.ok ? '  ' + MB(r.bytes) + '  ' + r.location
      : '  FAILED  ' + r.why));
  } else {
    out = await backup.backupAll({ by: 'cli', log: () => {} });
    out.runs.forEach((r) => console.log('[backup] ' + String(r.db).padEnd(24)
      + (r.ok ? '  ' + MB(r.bytes) + '  ' + r.location : '  FAILED  ' + r.why)));
  }

  await backup.prune(null, console.log);
  console.log('[backup] ' + out.runs.length + ' archive(s), '
    + out.runs.filter((r) => r.ok).length + ' good, '
    + (out.failed || []).length + ' failed');
  // A run that half worked must not exit 0: the next thing somebody does is
  // trust it and walk away. Same rule as provision-outlet.
  return (out.failed || []).length ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => shutdown().then(() => process.exit(code)))
    .catch((e) => {
      console.error('[backup] ' + (e.message || e));
      shutdown().then(() => process.exit(1), () => process.exit(1));
    });
}
module.exports = { main };
