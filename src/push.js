'use strict';
/* ===== WEB PUSH, WITH NO PUSH LIBRARY =======================================
   Two RFCs, both implemented against node's own `crypto` because the stack
   carries exactly two runtime dependencies (express, pg) and this is not one
   of them:

     RFC 8292  VAPID — an ES256 JWT in the `Authorization: vapid t=..., k=...`
               header, so a push service can tell this server sent the message
               without a prior handshake.
     RFC 8291  Message encryption — aes128gcm, an ephemeral ECDH over P-256
               with the subscriber's own key, HKDF-SHA256 to derive the
               content-encryption key and nonce, AES-128-GCM over one record.

   THE PROOF IS THE APPENDIX A TEST VECTOR, not a round trip against itself.
   A round trip only proves encrypt and decrypt agree with each other; the
   fixed RFC vector (fixed keys, fixed salt, a published ciphertext) is the
   one check that the framing, the HKDF info strings and the byte order all
   match what an actual push service expects. `test/wiring.test.js` runs it.

   VAPID keys are generated here, once, and read back from the CONTROL
   database's `chain.vapid_key` (control/005) — never typed by a person, never
   logged, never returned in a response. `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` override when set, for an operator who
   wants to supply their own.
   ═══════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const dns = require('dns');
const { URL } = require('url');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || '').replace(/\s+/g, ''), 'base64url');

/* ── raw P-256 key handling ──────────────────────────────────────────────
   A subscription's p256dh and a VAPID key are both spelled as the 65-byte
   uncompressed point (0x04 || X || Y), base64url. node's `crypto` has no
   "give me the raw point" accessor, but JWK export/import IS raw X/Y/D —
   base64url already — so importing and exporting through JWK is the whole
   of the raw<->KeyObject bridge, with no ASN.1 of our own to get wrong. */
function publicKeyFromRaw(raw65) {
  if (!raw65 || raw65.length !== 65 || raw65[0] !== 4) {
    throw Object.assign(new Error('not an uncompressed P-256 point'), { status: 400 });
  }
  const x = raw65.subarray(1, 33), y = raw65.subarray(33, 65);
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk'
  });
}
function rawPublicKey(publicKeyObject) {
  const jwk = publicKeyObject.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
}
function privateKeyFromRawD(dRaw, publicRaw65) {
  const x = publicRaw65.subarray(1, 33), y = publicRaw65.subarray(33, 65);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(dRaw), x: b64u(x), y: b64u(y) }, format: 'jwk'
  });
}
function rawPrivateKey(privateKeyObject) {
  return unb64u(privateKeyObject.export({ format: 'jwk' }).d);
}

function generateP256() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKey, privateKey, publicRaw: rawPublicKey(publicKey), privateRaw: rawPrivateKey(privateKey) };
}

/* ── RFC 8291: aes128gcm content encryption ──────────────────────────────
   The three-info-string HKDF chain, spelled exactly as Appendix A of the
   RFC spells it (each info string is checked, byte for byte, against the
   vector below — the comments quote the RFC's own labels). One record only:
   this build never sends a push payload anywhere near the 4096-byte record
   size, so there is no reason to split one across records. */
const WEBPUSH_INFO_PREFIX = Buffer.from('WebPush: info\0', 'ascii');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'ascii');
const RECORD_SIZE = 4096;

function encrypt(plaintext, p256dhRaw, authRaw, opts) {
  const o = opts || {};
  const salt = o.salt || crypto.randomBytes(16);
  const as = o.asKeyPair || generateP256();
  const uaPublic = publicKeyFromRaw(p256dhRaw);

  const ecdhSecret = crypto.diffieHellman({ privateKey: as.privateKey, publicKey: uaPublic });
  const keyInfo = Buffer.concat([WEBPUSH_INFO_PREFIX, p256dhRaw, as.publicRaw]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authRaw, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, NONCE_INFO, 12));

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([as.publicRaw.length]), as.publicRaw]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // The padding delimiter (0x02: "no records follow") — RFC 8188 section 2.
  const body = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  return Buffer.concat([header, ciphertext]);
}

/* ── RFC 8292: VAPID ──────────────────────────────────────────────────────
   ES256 over `<header>.<payload>`, base64url each, and the signature is
   IEEE P1363 (raw r||s, 64 bytes for P-256) — never the DER a plain
   `crypto.sign` would otherwise hand back. `dsaEncoding: 'ieee-p1363'` is
   the one flag that makes node's crypto speak the JOSE dialect directly, so
   there is no ASN.1-to-raw conversion of our own to get wrong either. */
function signVapidJwt(audienceOrigin, subject, privateKeyObject, ttlSeconds) {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({
    aud: audienceOrigin,
    exp: Math.floor(Date.now() / 1000) + (ttlSeconds || 12 * 3600),
    sub: subject
  })));
  const signingInput = header + '.' + payload;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKeyObject, dsaEncoding: 'ieee-p1363'
  });
  return signingInput + '.' + b64u(sig);
}

/* ── the keys, generated once, never handed over by a person ────────────
   Race-safe across two booting processes: insert-if-absent (the `id boolean
   PRIMARY KEY DEFAULT true` trick makes "at most one row" a constraint, not
   a convention), ON CONFLICT DO NOTHING, then read back whichever row won —
   which may be the one this process just tried to insert, or a peer's. */
let cached = null;

function subjectFromPublicUrl() {
  const raw = String(process.env.VAPID_SUBJECT || '').trim();
  if (raw) return raw;
  const pub = String(process.env.PUBLIC_URL || '').trim();
  if (pub) {
    try { return 'https://' + new URL(pub).host; } catch (e) { /* fall through */ }
  }
  return 'mailto:admin@example.com';
}

async function getVapidKeys(controlPool) {
  if (cached) return cached;

  const envPub = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) {
    const publicRaw = unb64u(envPub);
    const privateRaw = unb64u(envPriv);
    cached = {
      publicRaw, privateRaw,
      publicKeyB64u: envPub,
      privateKey: privateKeyFromRawD(privateRaw, publicRaw),
      subject: subjectFromPublicUrl()
    };
    return cached;
  }

  const gen = generateP256();
  await controlPool.query(
    'INSERT INTO chain.vapid_key (id, public_key, private_key) VALUES (true, $1, $2)'
    + ' ON CONFLICT (id) DO NOTHING',
    [b64u(gen.publicRaw), b64u(gen.privateRaw)]);
  const row = (await controlPool.query('SELECT public_key, private_key FROM chain.vapid_key WHERE id = true')).rows[0];
  const publicRaw = unb64u(row.public_key);
  const privateRaw = unb64u(row.private_key);
  cached = {
    publicRaw, privateRaw,
    publicKeyB64u: row.public_key,
    privateKey: privateKeyFromRawD(privateRaw, publicRaw),
    subject: subjectFromPublicUrl()
  };
  return cached;
}

// Test-only: forget the process-cached keys so a fresh control DB is read again.
function _resetCache() { cached = null; }

/* ── sending ──────────────────────────────────────────────────────────────
   AN ALLOW-LIST, NOT A DENY-LIST — the same doctrine the print relay's
   fence already keeps, aimed the other way round. A printer is legitimately
   on a private LAN address; a push service never is — fcm.googleapis.com,
   updates.push.services.mozilla.com and Apple's web push gateway are all
   public HTTPS endpoints. So a subscription endpoint that resolves to a
   loopback, link-local or private address is refused before this process
   dials it: an endpoint is supplied by the SUBSCRIBING DEVICE (a staff
   member's own phone), so trusting it blind would let a compromised or
   malicious till turn this server into a probe against its own network.
   `PUSH_ALLOW_LOOPBACK=1` (non-production only) opens loopback for exactly
   one caller: this build's own test suite, which points a subscription at a
   local HTTP stub to prove a 410 deletes it and an accepted send reaches it. */
async function checkEndpointAllowed(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') {
    const allowHttp = process.env.NODE_ENV !== 'production' && process.env.PUSH_ALLOW_LOOPBACK === '1';
    if (!allowHttp) throw Object.assign(new Error('a push endpoint must be https'), { status: 400 });
  }
  const { address } = await dns.promises.lookup(u.hostname.replace(/^\[|\]$/g, ''));
  const flat = String(address).replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(flat);
  const o = v4 ? v4.slice(1, 5).map(Number) : null;
  const isPrivateV4 = !!o && (
    o[0] === 0 || o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
    || o[0] === 127 || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)
  );
  const isPrivateV6 = /^f[cde][0-9a-f]{2}:/i.test(flat) || flat === '::1' || flat === '::' || /^fe[89ab][0-9a-f]:/i.test(flat);
  const isLoopback = /^127\./.test(flat) || flat === '::1';
  const allowLoop = process.env.NODE_ENV !== 'production'
    && process.env.PUSH_ALLOW_LOOPBACK === '1' && isLoopback;
  if ((isPrivateV4 || isPrivateV6) && !allowLoop) {
    throw Object.assign(new Error('that push endpoint does not resolve to a public address'), { status: 400 });
  }
}

// Bounded timeout, fire-and-forget from the caller's perspective — a push
// send must never hold up the request that triggered it.
function postOnce(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method: 'POST',
      headers: Object.assign({ 'content-length': body.length }, headers)
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 5000, () => req.destroy(new Error('push service timed out')));
    req.end(body);
  });
}

/* sub: { endpoint, p256dh, auth } (base64url strings, as the browser gives
   them). payload: a plain object — the caller decides what may be in it
   (see the "no money, no names" rule at the call sites). Returns
   { ok, status, gone } — `gone` on 404/410 tells the caller to delete the
   subscription; anything else is logged once by the caller, never retried
   in a loop. */
async function sendPush(controlPool, sub, payload, opts) {
  const o = opts || {};
  await checkEndpointAllowed(sub.endpoint);
  const keys = await getVapidKeys(controlPool);
  const audience = new URL(sub.endpoint).origin;
  const jwt = signVapidJwt(audience, keys.subject, keys.privateKey, o.ttlJwt);

  const body = encrypt(Buffer.from(JSON.stringify(payload)), unb64u(sub.p256dh), unb64u(sub.auth));
  const headers = {
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(o.ttl || 60),
    urgency: o.urgency || 'normal',
    authorization: 'vapid t=' + jwt + ', k=' + keys.publicKeyB64u
  };
  const { status } = await postOnce(sub.endpoint, headers, body, o.timeoutMs);
  return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 };
}

module.exports = {
  encrypt, signVapidJwt, getVapidKeys, sendPush, checkEndpointAllowed,
  publicKeyFromRaw, rawPublicKey, privateKeyFromRawD, generateP256,
  _resetCache
};
