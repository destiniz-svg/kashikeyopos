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
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

module.exports = { outletPassword, sign, verify, hashPin, pinMatches };
