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

/* EVERY TOKEN SAYS WHAT PLANE IT IS FOR, and every check demands the plane it
   expects. Without that a token is only "a signed blob", and which credential
   it IS gets decided by which fields the reader happens to look at — which is
   how a member's 30-day portal token turned out to satisfy the table check and
   order onto any table in the shop, and how a guest's table token — minted
   anonymously by scanning a QR — read the entire back-office bootstrap on any
   install where PORTAL_SECRET was not set.

   `typ` is one letter, checked on the way in. A token minted before this
   carries none and is refused, which costs everybody one sign-in: a till keys
   a PIN, a guest rescans, a member asks for a code. That is the correct price. */
const TYPE = { staff: 's', account: 'a', table: 't', member: 'm', doc: 'd' };

function signWith(secret, typ, payload) {
  const body = b64url(JSON.stringify(Object.assign({ typ: typ }, payload)));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

/* `sealed` is the MAC and the plane, WITHOUT the clock — never a token, only
   the two facts a caller may need separately. Every credential path uses
   verifyWith() and an expired token is simply not one; the single exception is
   a document link, where the difference between "wrong" and "merely old" is
   worth telling the person holding it. Nothing is weakened by asking: the
   signature and the plane still have to hold before a claim is believed. */
function sealed(secret, typ, token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const cut = token.lastIndexOf('.');
  const body = token.slice(0, cut), mac = token.slice(cut + 1);
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch (e) { return null; }
  if (!claims) return null;
  // The plane is not negotiable and it is not inferred from the payload.
  if (claims.typ !== typ) return null;
  return claims;
}

function verifyWith(secret, typ, token) {
  const claims = sealed(secret, typ, token);
  if (!claims || !claims.exp || claims.exp < Date.now()) return null;
  return claims;
}

/* The guest plane's secret is DERIVED when it is not configured, never
   borrowed. `PORTAL_SECRET || SESSION_SECRET` meant an install that had not
   set one signed a stranger's table token with the same key as a manager's
   session — proved on a live install: the anonymous token from a QR scan
   verified as a staff session and returned a 2.6 MB bootstrap carrying every
   recipe, cost, sale and staff record. Deriving costs no configuration and
   makes the two keys different by construction, so `typ` is a second fence
   rather than the only one. */
function portalSecret() {
  if (process.env.PORTAL_SECRET) return process.env.PORTAL_SECRET;
  return crypto.createHmac('sha256', need('SESSION_SECRET'))
    .update('kashikeyo:portal:v1').digest('hex');
}

const sign = (p) => signWith(need('SESSION_SECRET'), TYPE.staff, p);
const verify = (t) => verifyWith(need('SESSION_SECRET'), TYPE.staff, t);

// The guest portal never holds a staff session. A QR carries a table token
// scoped to one outlet and one table, so a guest cannot post an order onto
// somebody else's bill by editing a URL.
const signTable = (p) => signWith(portalSecret(), TYPE.table, p);
const verifyTable = (t) => verifyWith(portalSecret(), TYPE.table, t);

/* An ACCOUNT token names the person who owns the business — the plane above
   the outlet. It is signed with the session secret because it is a first-party
   credential like a staff session, and it carries an account id and nothing
   else: no rank, no outlet. What that account may reach is looked up per
   request, so revoking an outlet takes effect on the next call rather than
   whenever a token happens to expire. */
const signAccount = (p) => signWith(need('SESSION_SECRET'), TYPE.account, p);
const verifyAccount = (t) => verifyWith(need('SESSION_SECRET'), TYPE.account, t);

// A member token is the same shape, minted only after a code is verified. It
// carries a member id and nothing else, so a stolen one reads one card and
// cannot order, price or settle.
const signMember = (p) => signWith(portalSecret(), TYPE.member, p);
const verifyMember = (t) => verifyWith(portalSecret(), TYPE.member, t);

/* A DOCUMENT LINK — an account statement handed to a customer. Signed rather
   than stored, because unlike a receipt it is DERIVED and it EXPIRES: a
   statement is a period of activity, and a permanent link to "this customer's
   account" is a standing window into somebody's spending. It carries an
   outlet, a member and the period, and grants nothing else — it cannot order,
   cannot see another customer, and cannot be traded for a session.

   A RECEIPT is deliberately not this shape. It is one document that never
   changes, the guest keeps it, and a link that expires is a receipt you cannot
   produce at the moment you need it. That one is a stored token (042). */
const signDoc = (p) => signWith(portalSecret(), TYPE.doc, p);
const verifyDoc = (t) => verifyWith(portalSecret(), TYPE.doc, t);

/* AND "WRONG" IS NOT "OLD". A statement link that has aged out is refused by
   verifyDoc() exactly like a forged one, so the guest holding it is told the
   link could not be found — and goes to check whether they copied it properly,
   or concludes the store deleted their record, rather than asking for a new
   one. The page already carries the right sentence; nothing could ever reach
   it. This answers which of the two it is, and ONLY for a document link: the
   MAC and the plane must still hold, so an expired answer is proof the store
   really did issue this, once. */
function docExpired(t) {
  const claims = sealed(portalSecret(), TYPE.doc, t);
  return !!(claims && claims.exp && Number(claims.exp) < Date.now());
}

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

/* THE INVITATION'S TOKEN. Shaped `MV-<secret>-<minted at>` so every reader can
   hold it to one pattern, with 128 bits of CSPRNG in the middle: the tail only
   makes a reissued token visibly different from the one it replaced, and is
   not relied on for anything.

   A code a person reads out loud is four digits and safe because it expires in
   ten minutes and dies after five tries. This is not read out — it travels in
   a message and lives seven days — so its safety has to be its entropy. */
/* A RECEIPT'S ADDRESS. Thirty-two characters from the platform CSPRNG — the
   token IS the credential for one bill, and it is public in the sense that it
   travels through an inbox and a message app, so its whole defence is that it
   cannot be guessed or walked. Prefixed so a reader can tell what a link is
   from the link, which is what stops a receipt token being pasted into a field
   that wants a member token. */
function receiptToken() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += A[crypto.randomInt(0, A.length)];
  return 'RC' + s;
}

function inviteToken() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 22; i++) s += A[crypto.randomInt(0, A.length)];
  return 'MV-' + s + '-' + Date.now();
}

/* Stored as a hash, never as itself — the same discipline as a PIN and a
   member code. This one is looked up BY value, so it is a plain digest rather
   than a salted one: a per-row salt would make the lookup a table scan, and a
   128-bit random has nothing a rainbow table can precompute. */
function tokenHash(t) {
  return crypto.createHash('sha256').update(String(t || ''), 'utf8').digest('hex');
}

module.exports = {
  outletPassword, sign, verify, signTable, verifyTable, signMember, verifyMember,
  signAccount, verifyAccount, signDoc, verifyDoc, docExpired,
  hashPin, pinMatches, randomPin, pairCode, need,
  inviteToken, receiptToken, tokenHash
};
