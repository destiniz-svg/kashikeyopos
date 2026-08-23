'use strict';
/* ═══ THE DOORS THAT SEND THINGS GET A DOORMAN ══════════════════════════════
   The endpoints this file guards share one shape: anybody on the internet may
   call them, and every call either sends something (an email with a code in
   it) or burns an attempt at guessing a credential (a password, a six-digit
   code, an invitation token). Unlimited, each one is a different attack for
   free — an inbox-flooder on someone else's address, a password sprayer, a
   code-space walk — and the email ones now cost real money per call, billed
   to the business.

   Two buckets per door, and BOTH must have room:

     the IDENTITY bucket   keyed on who the request is ABOUT — the email, the
                           phone — so one address cannot be hammered from a
                           botnet's worth of IPs;
     the IP bucket         keyed on where it came FROM, so one connection
                           cannot walk the identity space by changing the
                           address on every call. Its ceiling is deliberately
                           several times the identity's: a restaurant's wifi
                           puts every guest in the room behind ONE address,
                           and a doorman who cannot tell forty guests from one
                           attacker locks the room's members out of their own
                           cards.

   Classic token bucket: capacity refills continuously over the window, so a
   burst is allowed and a sustained hammer is not. Refusal is a 429 with
   Retry-After and wording that says what to do — it reveals nothing about
   whether the address is a customer, which keeps the enumeration promise the
   endpoints themselves make.

   IN MEMORY, ON PURPOSE. This build is one process; a table would make every
   sign-in cost a write, and a limiter that fails open on a cold restart is
   the correct failure — the window is minutes, restarts are rare, and the
   credential guards underneath (five tries per code, the outlet-wide PIN
   lockout) never left. If this app ever runs as several replicas, this file
   is the one seam to move onto something shared.

   Identity keys are HASHED before they are held: a heap dump should not be a
   list of the email addresses that signed in this hour.
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const BUCKETS = new Map();

/* Tests multiply the ceilings so 194 of them from one loopback address do not
   read as an attack, then set the scale to 1 to test the limiter itself.
   Production ignores the knob: a scaled-up doorman is no doorman. */
function scale() {
  if (process.env.NODE_ENV === 'production') return 1;
  const n = Number(process.env.RATE_LIMIT_SCALE || 1);
  return n >= 1 ? n : 1;
}

function take(key, burst, windowMs) {
  const cap = burst * scale();
  const now = Date.now();
  let b = BUCKETS.get(key);
  if (!b) { b = { tokens: cap, at: now, cap: cap, win: windowMs }; BUCKETS.set(key, b); }
  b.tokens = Math.min(cap, b.tokens + (now - b.at) * (cap / windowMs));
  b.at = now;
  b.cap = cap;
  if (b.tokens < 1) {
    return { ok: false, retry: Math.ceil(((1 - b.tokens) * windowMs) / cap / 1000) };
  }
  b.tokens -= 1;
  return { ok: true };
}

function idHash(v) {
  return crypto.createHash('sha256').update(String(v).toLowerCase()).digest('hex').slice(0, 24);
}

/* gate(name, opts, keyFn) → middleware.

     name    namespaces the buckets, so /signin and /code do not share one
     opts    { ip: [burst, windowMs], id: [burst, windowMs] } — either optional
     keyFn   (req) → the identity the request is about, or '' for none

   The buckets are walked in order and a refusal stops the walk — so a call
   the CONNECTION refuses never touches the identity's allowance, while a call
   refused for the identity has already counted against the connection. That
   asymmetry is deliberate: a refusal is still traffic from that connection. */
function gate(name, opts, keyFn) {
  return function (req, res, next) {
    const checks = [];
    if (opts.ip) {
      checks.push(['ip:' + name + ':' + (req.ip || 'unknown'), opts.ip]);
    }
    const who = keyFn ? String(keyFn(req) || '').trim() : '';
    if (opts.id && who) {
      checks.push(['id:' + name + ':' + idHash(who), opts.id]);
    }
    for (const [key, [burst, win]] of checks) {
      const t = take(key, burst, win);
      if (!t.ok) {
        res.set('retry-after', String(Math.max(1, t.retry)));
        return res.status(429).json({
          error: 'Too many attempts — wait '
            + (t.retry > 90 ? Math.ceil(t.retry / 60) + ' minutes' : 'a minute')
            + ' and try again'
        });
      }
    }
    next();
  };
}

/* A full bucket that has sat past its own window is indistinguishable from a
   missing one, so it is dropped rather than held for ever. */
const sweeper = setInterval(function () {
  const now = Date.now();
  for (const [k, b] of BUCKETS) {
    if (b.tokens >= b.cap - 0.01 && now - b.at > b.win) BUCKETS.delete(k);
  }
}, 10 * 60e3);
if (sweeper.unref) sweeper.unref();

function _reset() { BUCKETS.clear(); }

module.exports = { gate, take, _reset, _buckets: BUCKETS };
