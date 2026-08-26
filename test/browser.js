'use strict';
/* ═══ A SKIP NOBODY SEES IS THE SAME AS NOT HAVING THE TEST ═════════════════
   Fifteen tests in this suite need a real browser and a running server, and
   every one of them skipped cleanly when either was missing. That is the right
   behaviour on a developer's machine, where nobody has three services up to
   run one unit test.

   It was NOT the right behaviour in CI, and the audit proved the cost. Those
   tests had never run there — the workflow starts Postgres and nothing else —
   and the first time they were allowed to run they found two defects on the
   spot: the Lamport clock was not persisted before sign-in (a static test had
   pinned the CALL, not the storage, and stayed green for months), and the till
   could sign nobody in on a correctly configured install.

   So the skip stays, and it becomes a FAILURE where it matters:

     KPOS_REQUIRE_BROWSER=1   a missing browser or server fails the run

   CI sets it. A developer does not. The rule is the same one this codebase
   keeps everywhere else — a thing that quietly does nothing has to say so
   somewhere a person will read it, and "somewhere" for a test is the build.
   ═══════════════════════════════════════════════════════════════════════ */

const REQUIRED = () => String(process.env.KPOS_REQUIRE_BROWSER || '') === '1';

/* Why a browser test cannot run, or false. Called once per file at load. */
function browserSkip(haveChromium, exePath, fs) {
  if (haveChromium && fs.existsSync(exePath)) return false;
  const why = 'no browser available (' + exePath + ')';
  if (REQUIRED()) {
    throw new Error('KPOS_REQUIRE_BROWSER=1 but ' + why
      + ' — install Playwright\'s Chromium, or unset the variable to skip');
  }
  return why;
}

/* Inside a test: skip, or fail, when a server is not answering. Returns true
   when the test should carry on. */
function needServer(t, up, base) {
  if (up) return true;
  const why = 'no server on ' + base;
  if (REQUIRED()) {
    throw new Error('KPOS_REQUIRE_BROWSER=1 but ' + why
      + ' — start it before the suite, or unset the variable to skip');
  }
  t.skip(why);
  return false;
}

module.exports = { browserSkip, needServer, REQUIRED };
