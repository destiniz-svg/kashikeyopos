'use strict';
/* ═══ PUT IT BACK ═══════════════════════════════════════════════════════════
     npm run restore -- --db kashikeyo_biz_3
         restores the newest good archive of that database BESIDE it, into a
         new database, and re-applies the outlet roles. Nothing a customer can
         see changes: the registry still routes every request to the original.

     npm run restore -- --id <uuid>              a particular archive
     npm run restore -- --db X --into Y          name the copy yourself
     npm run restore -- --db X --into X --over   OVER the live one. Destroys
                                                 everything rung since.
     npm run restore -- --adopt 3 --into Y       point business 3 at the copy

   IT IS A CLI AND NOT A BUTTON, deliberately. An earlier pass found the
   Restore card in Settings promising that the tills would lock while it ran,
   over an op that did nothing — "the worst kind of invented figure, because
   it is a destructive action reporting that it ran". The answer to that is
   not a button that works; it is that this decision belongs to whoever holds
   the database, with the archive named out loud and the target typed.

   THE ARCHIVE IS VERIFIED BEFORE IT IS TRUSTED — sha256 against the manifest,
   because a truncated upload restores most of a database and reports success
   on the part that arrived.
   ═══════════════════════════════════════════════════════════════════════ */

const backup = require('../backup');
const { shutdown } = require('../db');

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf('--' + n);
    return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
  };
  const say = console.log;                             // eslint-disable-line no-console

  const adoptId = arg('adopt');
  if (adoptId && adoptId !== true) {
    const into = arg('into');
    if (!into || into === true) {
      console.error('[restore] --adopt needs --into <database> — the copy to'
        + ' point the business at');
      return 1;
    }
    const r = await backup.adopt(Number(adoptId), String(into), say);
    say('[restore] done · business ' + r.businessId + ': ' + r.was + ' → ' + r.now);
    return 0;
  }

  const id = arg('id');
  const db = arg('db');
  if ((!id || id === true) && (!db || db === true)) {
    console.error('[restore] name an archive: --db <database> for its newest'
      + ' good one, or --id <uuid> for a particular one.'
      + ' `npm run backup -- --list` shows what there is.');
    return 1;
  }

  const over = !!arg('over');
  const into = arg('into');
  if (over && (!into || into === true)) {
    console.error('[restore] --over needs --into <database> spelled out. It'
      + ' discards everything in that database, so it is not something a'
      + ' default gets to choose.');
    return 1;
  }

  const r = await backup.restore({
    backupId: (id && id !== true) ? String(id) : null,
    db: (db && db !== true) ? String(db) : null,
    into: (into && into !== true) ? String(into) : null,
    over: over, log: say
  });

  say('');
  say('[restore] restored into  ' + r.into);
  say('[restore] from archive   ' + r.from);
  say('[restore] schema version ' + (r.schemaVersion == null ? 'unknown' : r.schemaVersion));
  say('[restore] outlet roles   ' + r.outlets + ' re-applied');
  if (r.pgRestoreExit !== 0) {
    say('[restore] pg_restore exited ' + r.pgRestoreExit + ' — the copy exists;'
      + ' read the lines above before trusting it');
  }
  if (!over) {
    say('');
    say('  Nothing a customer can see has changed: the registry still routes'
      + ' every request to the original. Check this copy, then point the'
      + ' business at it with:');
    say('    npm run restore -- --adopt <businessId> --into ' + r.into);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => shutdown().then(() => process.exit(code)))
    .catch((e) => {
      console.error('[restore] ' + (e.message || e));
      shutdown().then(() => process.exit(1), () => process.exit(1));
    });
}
module.exports = { main };
