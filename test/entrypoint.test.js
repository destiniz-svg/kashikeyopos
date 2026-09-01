'use strict';
/* ═══ THE MOUNT IS THE ONE THING THIS IMAGE WRITES TO ════════════════════════
   A backup was dumped correctly and then refused on the way in:

     [backup] kashikeyo_biz_1  FAILED  EACCES: permission denied, copyfile
              '/tmp/kashikeyo-….dump' -> '/backups/kashikeyo_biz_1-….dump'

   Four of four, nightly, on an install whose own boot line said the
   destination was configured and named pg_dump 18.6 — the shape this build
   refuses everywhere else: a control reporting it did something it did not.
   The cause is that a platform mounts a volume owned by root and the image
   runs as `node`, and `USER node` in the Dockerfile cannot fix it, because the
   mount does not exist until the container starts.

   So the fix is a shell script, and a shell script is exactly the kind of
   thing that is never tested and quietly stops working. There is no Docker
   daemon in CI, so the IMAGE cannot be built here — what can be run is the
   SHIPPED SCRIPT ITSELF, against a stubbed `chown`, `id` and `su-exec` on
   PATH, which is what these tests do. They assert the four decisions:

     · the mount is handed to `node` before anything else happens;
     · the process is `exec`d as `node`, so no root process is left behind;
     · the three guards hold, because this same image is also Mission Control
       and the public website, neither of which has a volume;
     · and a chown that cannot be done is NOT fatal — the backup itself
       reports EACCES by name, which is a better error than a POS terminal
       that will not start.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'docker-entrypoint.sh');

/* Run the shipped script with a stub PATH. `uid` decides what `id -u` answers,
   `chownFails` makes chown non-zero the way a real one does when we are not
   root, and every stub appends a line to a trace file — so what is asserted is
   the sequence of acts, not a reading of the source. */
function run(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-entry-'));
  const bin = path.join(dir, 'bin');
  const trace = path.join(dir, 'trace');
  fs.mkdirSync(bin);
  fs.writeFileSync(trace, '');

  const stub = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  };
  stub('id', 'echo "id $*" >> ' + trace + '\nexec /usr/bin/id "$@"');
  stub('chown', 'echo "chown $*" >> ' + trace
    + (o.chownFails ? '\nexit 1' : '\nexit 0'));
  stub('su-exec', 'echo "su-exec $*" >> ' + trace + '\nexit 0');
  /* The command the entrypoint is asked to exec. Traced so "was it exec'd at
     all, and as whom" is answerable. */
  stub('node', 'echo "node $*" >> ' + trace + '\nexit 0');

  const env = {
    PATH: bin + ':/usr/bin:/bin',
    /* `id -u` is what the script branches on. Overriding the real uid would
       need a real setuid, so the stub answers instead. */
    _KPOS_TEST: '1'
  };
  if (o.backupDir !== undefined) env.BACKUP_DIR = o.backupDir;
  if (o.uid !== undefined) {
    fs.writeFileSync(path.join(bin, 'id'),
      '#!/bin/sh\necho "id $*" >> ' + trace + '\necho ' + o.uid + '\n',
      { mode: 0o755 });
  }

  let status = 0;
  try {
    execFileSync('/bin/sh', [SCRIPT, 'node', 'server.js'],
      { env: env, stdio: 'pipe' });
  } catch (e) { status = e.status == null ? -1 : e.status; }

  return {
    dir: dir,
    status: status,
    trace: fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)
  };
}

test('the mount is handed to node, and the process is exec\'d as node', () => {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-vol-'));
  const r = run({ uid: 0, backupDir: mount });

  const chown = r.trace.find((l) => l.startsWith('chown '));
  assert.ok(chown, 'the volume is mounted root-owned, so it must be chowned'
    + ' before the process that writes to it drops privileges');
  assert.match(chown, /node:node/,
    'handed to the user the application actually runs as');
  assert.ok(chown.indexOf(mount) >= 0, 'the mount itself, not some other path');

  const su = r.trace.find((l) => l.startsWith('su-exec '));
  assert.ok(su, 'root must not be what serves requests — su-exec drops to node');
  assert.match(su, /^su-exec node node server\.js$/,
    'the command is passed through unchanged; only the user changes');

  /* Order is the whole point: a chown after the drop is a chown that fails. */
  assert.ok(r.trace.indexOf(chown) < r.trace.indexOf(su),
    'the chown happens BEFORE privileges are dropped, or it cannot happen');
});

test('a chown that cannot be done does not stop the terminal booting', () => {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-vol-'));
  const r = run({ uid: 0, backupDir: mount, chownFails: true });

  assert.strictEqual(r.status, 0,
    'a restaurant losing its till over a backup directory is a worse failure'
    + ' than a backup that reports EACCES by name');
  assert.ok(r.trace.some((l) => l.startsWith('su-exec ')),
    'and it still drops to node rather than serving as root');
});

test('no BACKUP_DIR is nothing to do — the panel and the site have no volume',
  () => {
    const r = run({ uid: 0 });
    assert.ok(!r.trace.some((l) => l.startsWith('chown ')),
      'this same image is Mission Control and the website; neither mounts one');
    assert.ok(r.trace.some((l) => l.startsWith('su-exec ')),
      'they still run as node');
  });

test('a BACKUP_DIR that is not a directory is nothing to do', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-vol-')), 'f');
  fs.writeFileSync(f, 'not a directory');
  const r = run({ uid: 0, backupDir: f });
  assert.ok(!r.trace.some((l) => l.startsWith('chown ')),
    'an unmounted or misspelled path is reported by the backup, not chowned');
  /* Asserted so this cannot pass vacuously against an image with no entrypoint
     at all, which is the version that shipped: absence of a chown is only an
     answer if the script ran. */
  assert.ok(r.trace.some((l) => l.startsWith('su-exec ')),
    'and the process still starts, as node');
});

test('an already-unprivileged container execs directly, never through su-exec',
  () => {
    /* A platform that pins the user, or a local `docker run -u`. su-exec would
       only fail there, and failing to start is the one outcome not allowed. */
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-vol-'));
    const r = run({ uid: 1000, backupDir: mount });
    assert.ok(!r.trace.some((l) => l.startsWith('su-exec ')),
      'there is nothing to drop to');
    assert.ok(r.trace.some((l) => l === 'node server.js'),
      'and the process still runs');
  });
