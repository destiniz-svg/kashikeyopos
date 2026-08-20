'use strict';
const crypto = require('crypto');

/* ═══ SECRETS ═══════════════════════════════════════════════════════════════
   Three separate secrets, deliberately not one:

     OUTLET_ROLE_SECRET   derives a per-outlet database password
     SESSION_SECRET       signs a session token
     PORTAL_SECRET        signs a guest/QR table token

   A leak of one must not mint the others. In particular a stolen session
   secret can forge a session but cannot open a database connection, because
   the database password is derived from a secret the web tier holds but never
   sends anywhere.
   ═══════════════════════════════════════════════════════════════════════ */

function need(name, min) {
  const v = process.env[name];
  if (!v || v.length < (min || 32)) {
    throw new Error(name + ' must be set and at least ' + (min || 32) + ' characters');
  }
  return v;
}

// A per-outlet database password is derived, never stored. Nothing readable
// inside the database yields another outlet's credentials; the only way to
// hold them is to hold OUTLET_ROLE_SECRET.
function outletPassword(outletId) {
  return crypto.createHmac('sha256', need('OUTLET_ROLE_SECRET'))
    .update('outlet:' + outletId).digest('hex');
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signWith(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

function verifyWith(secret, token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const cut = token.lastIndexOf('.');
  const body = token.slice(0, cut), mac = token.slice(cut + 1);
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch (e) { return null; }
  if (!claims || !claims.exp || claims.exp < Date.now()) return null;
  return claims;
}

const sign = (p) => signWith(need('SESSION_SECRET'), p);
const verify = (t) => verifyWith(need('SESSION_SECRET'), t);

// The guest portal never holds a staff session. A QR carries a table token
// scoped to one outlet and one table, so a guest cannot post an order onto
// somebody else's bill by editing a URL.
const signTable = (p) => signWith(process.env.PORTAL_SECRET || need('SESSION_SECRET'), p);
const verifyTable = (t) => verifyWith(process.env.PORTAL_SECRET || need('SESSION_SECRET'), t);

/* PINs are hashed with scrypt and a per-row salt. A PIN is short by nature, so
   the work factor and the sign-in lockout are what make it safe — never the
   entropy. A visible or shared PIN would make every "who voided this" answer
   in the audit log a guess. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), s, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash: h, salt: s };
}

function pinMatches(pin, hash, salt) {
  if (!hash || !salt) return false;
  let h;
  try { h = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, SCRYPT).toString('hex'); }
  catch (e) { return false; }
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomPin() {
  // 4 digits, uniform, from the CSPRNG — never Math.random().
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function pairCode() {
  // Six characters, no vowels (no accidental words) and no 0/O/1/I.
  const A = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(0, A.length)];
  return s;
}

module.exports = {
  outletPassword, sign, verify, signTable, verifyTable,
  hashPin, pinMatches, randomPin, pairCode, need
};
