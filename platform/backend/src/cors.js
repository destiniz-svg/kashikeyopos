'use strict';
/* Who is allowed to call this API from a browser.
 *
 * Deployed, the POS and the guest portal are static sites on their OWN origins
 * and the API is somewhere else, so every call a screen makes is cross-origin.
 * That makes this file load-bearing in production and invisible everywhere
 * else: server-to-server callers — including this build's whole integration
 * suite — send no Origin header, so they never ask for the one thing that can
 * be wrong here.
 *
 * A LITERAL '*' MEANS ANY ORIGIN. Unset already meant that, so
 * `ALLOWED_ORIGINS=*` — the obvious way to write "allow everything" — was the
 * single value that allowed NOTHING: it matched no origin, no header went out,
 * and the browser blocked every request. The only symptom was a CORS error in a
 * console nobody deploying reads.
 *
 * It lives in its own file so a test can check the decision itself rather than
 * a retyped copy of it — requiring server.js would start a listener.
 */

/** Parse ALLOWED_ORIGINS into a decision. */
function policy(value) {
  const raw = String(value || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    any: !raw.length || raw.indexOf('*') >= 0,
    list: raw.filter(function (s) { return s !== '*'; }),
  };
}

/**
 * The value for access-control-allow-origin, or null to send no CORS headers.
 * Never returns '*': the header echoes the caller's own origin, which keeps the
 * response usable if credentials are ever added and keeps `vary: origin` honest.
 */
function allowOrigin(value, origin) {
  if (!origin) return null;
  const p = policy(value);
  return (p.any || p.list.indexOf(origin) >= 0) ? origin : null;
}

module.exports = { policy, allowOrigin };
