/* ═══════════════════════════════════════════════════════════════════════
   WHAT THIS PAGE IS RUNNING — src/build.js

   `APPVER` is `package.json`'s version, and that file has read 3.0.0 since
   the rebuild. Every install therefore published the same string, and
   `app/kpos-bridge.js` took it straight off the bootstrap and reported it
   BACK as this device's own app version — so `chain.device.app_version`
   (migration 036) held one value for every terminal on every install, for
   ever, and the Sync screen's "behind" verdict could never fire. Two
   literals agreeing with each other, one router along from the `4.2.1` that
   publishing APPVER was meant to end.

   It matters because of how this product is held. A terminal is a home-screen
   shortcut, and a shortcut RESUMES a frozen page: no navigation, no reload,
   so a deploy reaches it only when the operating system finally evicts it or
   somebody force-quits. A till can run a build from weeks ago while the
   outlet beside it runs today's, and nothing on any screen said so — which is
   why "I applied your fix and nothing changed" was undiagnosable from either
   end.

   The stamp is a hash of THE FILES THE BROWSER ACTUALLY RUNS — every .html
   and .js under app/. Scoped that way on purpose: a reload fixes a stale
   PAGE and does nothing at all about a server-side change, so a stamp that
   moved on every deploy would be asking operators to reload for no reason,
   which is how a notice gets ignored. There is no build step here, so there
   is nothing else to read: what ships is the file that was read, and this
   is that file's own fingerprint.
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'app');

let stamped = null;
let stampedAt = 0;

/* Twelve hex characters. Long enough that two builds of one product do not
   collide, short enough to be read aloud down a phone line, which is what a
   support call actually does with it. */
function stamp() {
  // Development edits these files without restarting; production reads once.
  const ttl = process.env.NODE_ENV === 'production' ? Infinity : 2000;
  if (stamped && Date.now() - stampedAt < ttl) return stamped;
  const h = crypto.createHash('sha256');
  try {
    const names = fs.readdirSync(DIR).filter((f) => /\.(html|js)$/.test(f)).sort();
    for (const f of names) {
      const src = fs.readFileSync(path.join(DIR, f));
      // The NAME rides with the bytes: a file renamed is a different build,
      // and hashing contents alone would call it the same one.
      h.update(f).update('\0').update(src).update('\0');
    }
  } catch (e) {
    /* An unreadable app directory fails louder elsewhere — the pages 404. What
       must not happen here is a stamp that LOOKS like a build: null says
       "this install cannot tell you", which the screens render as not said. */
    return null;
  }
  stamped = h.digest('hex').slice(0, 12);
  stampedAt = Date.now();
  return stamped;
}

module.exports = { stamp };
