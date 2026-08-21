'use strict';
/* ═══ APPLE'S CLIENT SECRET IS NOT A SECRET ═════════════════════════════════
   Every other provider hands you a client secret: a fixed string you paste
   into a variable and forget. Apple does not. What Apple calls the client
   secret is a JWT you MINT, signed ES256 with a .p8 private key you download
   once, and it carries an expiry Apple caps at six months.

   Pasting a pre-minted one into APPLE_CLIENT_SECRET works — until the day it
   expires, when "Continue with Apple" starts failing on a live sign-in page
   with nothing in the deploy log to explain it, months after anybody touched
   this. So it is minted here, from the key material, and re-minted before it
   ages out.

   No dependency: Node signs ES256 natively, and `dsaEncoding: 'ieee-p1363'`
   is exactly the raw r||s form JOSE wants — the default DER encoding is the
   classic way to produce a JWT Apple rejects without saying why.

   What you need from Apple, once:
     APPLE_TEAM_ID      10 characters, top right of the developer portal
     APPLE_CLIENT_ID    the SERVICES ID (e.g. com.kashikeyo.pos.web), not the
                        app id — the app id will not work for the web flow
     APPLE_KEY_ID       10 characters, shown when the key is created
     APPLE_PRIVATE_KEY  the .p8 file's contents, downloadable exactly once
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

// Apple caps this at six months. Ninety days re-mints often enough that a
// clock skew or a slow deploy never lands on the boundary.
const LIFETIME_S = 90 * 24 * 3600;
const RENEW_BEFORE_S = 7 * 24 * 3600;

let cached = null;                  // { jwt, exp, fingerprint }

const env = (n) => String(process.env[n] || '').trim();

/* A .p8 pasted into an environment variable arrives with its newlines mangled
   more often than not — as literal backslash-n by every dashboard that stores
   one on a single line, and sometimes wrapped in quotes. Repair it rather
   than fail with "error:0909006C:PEM routines:get_name:no start line", which
   tells an operator nothing about what they actually did wrong. */
function readKey() {
  let pem = env('APPLE_PRIVATE_KEY');
  if (!pem) return null;
  if ((pem[0] === '"' && pem[pem.length - 1] === '"')
    || (pem[0] === "'" && pem[pem.length - 1] === "'")) pem = pem.slice(1, -1);
  pem = pem.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  // Some dashboards strip newlines entirely; rebuild the PEM from the base64.
  if (pem.indexOf('\n') < 0 && /BEGIN PRIVATE KEY/.test(pem)) {
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    pem = '-----BEGIN PRIVATE KEY-----\n'
      + (body.match(/.{1,64}/g) || []).join('\n')
      + '\n-----END PRIVATE KEY-----';
  }
  return pem;
}

/* Everything Apple needs, or a sentence saying which piece is missing. The
   front door asks this to decide whether to offer the button at all: a button
   that cannot work is worse than no button. */
function configured() { return whyNot() === null; }

function whyNot() {
  if (env('APPLE_CLIENT_SECRET')) {
    // A pre-minted secret is honoured — it just cannot be renewed for you.
    return env('APPLE_CLIENT_ID') ? null : 'APPLE_CLIENT_ID (the Services ID) is not set';
  }
  const missing = ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY']
    .filter((n) => !env(n));
  if (missing.length === 4) return 'Apple sign-in is not configured';
  if (missing.length) return 'Apple sign-in is missing ' + missing.join(', ');
  return null;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/* The client secret Apple expects, minted and cached until it is close to
   expiring. Throws with a readable message rather than returning something
   Apple will reject in a way that reads as "invalid_client". */
function clientSecret(now) {
  const pre = env('APPLE_CLIENT_SECRET');
  if (pre) return pre;

  const why = whyNot();
  if (why) throw Object.assign(new Error(why), { status: 503 });

  const t = Math.floor((now || Date.now()) / 1000);
  const pem = readKey();
  // Re-mint when the key material changes underneath us, not only on expiry —
  // otherwise rotating the .p8 does nothing until the cache ages out.
  const fingerprint = crypto.createHash('sha256')
    .update(pem + '|' + env('APPLE_TEAM_ID') + '|' + env('APPLE_KEY_ID') + '|' + env('APPLE_CLIENT_ID'))
    .digest('hex');
  if (cached && cached.fingerprint === fingerprint && cached.exp - t > RENEW_BEFORE_S) {
    return cached.jwt;
  }

  const header = { alg: 'ES256', kid: env('APPLE_KEY_ID'), typ: 'JWT' };
  const exp = t + LIFETIME_S;
  const claims = {
    iss: env('APPLE_TEAM_ID'),
    iat: t,
    exp: exp,
    aud: 'https://appleid.apple.com',
    sub: env('APPLE_CLIENT_ID')          // the Services ID, not the app id
  };
  const input = b64(header) + '.' + b64(claims);

  let key;
  try { key = crypto.createPrivateKey(pem); }
  catch (e) {
    throw Object.assign(new Error('APPLE_PRIVATE_KEY is not a readable .p8 key: '
      + e.message), { status: 503 });
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw Object.assign(new Error('APPLE_PRIVATE_KEY is a ' + key.asymmetricKeyType
      + ' key; Apple issues an EC (P-256) .p8'), { status: 503 });
  }

  // ieee-p1363, not DER: JOSE wants raw r||s, and Node defaults to DER.
  const sig = crypto.sign('sha256', Buffer.from(input), { key: key, dsaEncoding: 'ieee-p1363' });
  const jwt = input + '.' + sig.toString('base64url');
  cached = { jwt: jwt, exp: exp, fingerprint: fingerprint };
  return jwt;
}

// Tests reach for this; nothing in the request path should.
function forget() { cached = null; }

module.exports = { configured, whyNot, clientSecret, readKey, forget, LIFETIME_S };
