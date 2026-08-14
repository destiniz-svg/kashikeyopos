'use strict';
const crypto = require('crypto');

// A per-outlet database password is derived, never stored. Nothing in the
// database can be read to obtain another outlet's credentials; the only way to
// hold them is to hold OUTLET_ROLE_SECRET, which lives in Railway's variables.
function outletPassword(outletId) {
  const secret = process.env.OUTLET_ROLE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('OUTLET_ROLE_SECRET must be set and at least 32 chars');
  }
  return crypto.createHmac('sha256', secret)
    .update('outlet:' + outletId).digest('hex');
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const want = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch (e) { return null; }
  if (!claims.exp || claims.exp < Date.now()) return null;
  return claims;
}

function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), s, 32).toString('hex');
  return { hash: h, salt: s };
}

function pinMatches(pin, hash, salt) {
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(String(hash || ''));
  // timingSafeEqual THROWS on a length mismatch, so a malformed or empty stored
  // hash would raise instead of returning false. Compare lengths first — and
  // still compare the bytes in constant time when they do match.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* A fast, keyed lookup key for (outlet, PIN) — see migration 007 for why it
   exists. Keyed with a pepper from the environment so that reading every row
   of chain.staff gives no way to test a PIN offline; the pepper is never
   stored beside the data it protects.
   Falls back to SESSION_SECRET so an existing deployment does not need a new
   variable to boot, but PIN_PEPPER should be set and rotated independently:
   rotating it invalidates every lookup, which is why it is separate from the
   thing that also signs tokens. */
function pinLookup(outletId, pin) {
  const pepper = process.env.PIN_PEPPER || process.env.SESSION_SECRET;
  if (!pepper || pepper.length < 32) {
    throw new Error('PIN_PEPPER (or SESSION_SECRET) must be set and at least 32 chars');
  }
  return crypto.createHmac('sha256', pepper)
    .update('pin:' + outletId + ':' + String(pin)).digest('hex');
}

module.exports = { outletPassword, sign, verify, hashPin, pinMatches, pinLookup };
