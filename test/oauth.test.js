'use strict';
/* ═══ SIGNING IN WITH SOMEBODY ELSE'S IDENTITY PROVIDER ═════════════════════
   Two things about this are easy to get wrong and expensive to discover late.

   APPLE'S CLIENT SECRET IS NOT A SECRET. Every other provider hands you a
   fixed string. Apple hands you a .p8 and expects a JWT you signed yourself,
   with an expiry it caps at six months. Paste a pre-minted one into a variable
   and "Continue with Apple" works right up until the day it silently stops,
   months after anybody touched the code, with Apple reporting only
   "invalid_client".

   AN EMAIL FROM A PROVIDER IS A CLAIM, NOT A FACT. Matching an incoming social
   identity to an existing account by address is only safe when the provider
   says it VERIFIED that address. Without that check, signing in with an
   unverified provider account bearing somebody else's address walks straight
   into their business.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const apple = require('../src/apple');

const APPLE_MAX_S = 6 * 30 * 24 * 3600;          // Apple's own ceiling

function freshKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec',
    { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

function withApple(env, fn) {
  const keys = ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID',
    'APPLE_PRIVATE_KEY', 'APPLE_CLIENT_SECRET'];
  const was = {};
  keys.forEach((k) => { was[k] = process.env[k]; delete process.env[k]; });
  Object.keys(env).forEach((k) => { process.env[k] = env[k]; });
  apple.forget();
  try { return fn(); }
  finally {
    keys.forEach((k) => {
      if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k];
    });
    apple.forget();
  }
}

const good = (pem) => ({
  APPLE_CLIENT_ID: 'com.kashikeyo.pos.web',
  APPLE_TEAM_ID: 'ABCDE12345',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: pem
});

test('the Apple client secret is a real ES256 JWT Apple would accept', () => {
  const k = freshKey();
  withApple(good(k.pem), () => {
    const jwt = apple.clientSecret();
    const [h, c, sig] = jwt.split('.');
    assert.strictEqual(jwt.split('.').length, 3, 'three parts');

    const header = JSON.parse(Buffer.from(h, 'base64url'));
    assert.strictEqual(header.alg, 'ES256', 'Apple accepts ES256 and nothing else');
    assert.strictEqual(header.kid, 'KEY1234567', 'and needs the key id to find the key');

    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.strictEqual(claims.iss, 'ABCDE12345', 'issuer is the TEAM');
    assert.strictEqual(claims.aud, 'https://appleid.apple.com');
    assert.strictEqual(claims.sub, 'com.kashikeyo.pos.web',
      'subject is the SERVICES id — an app id here fails the web flow');
    assert.ok(claims.exp > claims.iat, 'it expires after it is issued');
    assert.ok(claims.exp - claims.iat <= APPLE_MAX_S,
      'and within Apple\'s six-month ceiling (' + (claims.exp - claims.iat) + 's)');

    /* The one that bites: JOSE wants the raw r||s pair, and Node's ECDSA
       default is DER. A DER signature here is a JWT Apple rejects as
       invalid_client without ever saying why. */
    const ok = crypto.verify('sha256', Buffer.from(h + '.' + c),
      { key: k.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    assert.ok(ok, 'the signature verifies against the key that made it');
  });
});

test('it is cached, and re-minted when the key underneath it changes', () => {
  const a = freshKey(), b = freshKey();
  withApple(good(a.pem), () => {
    const first = apple.clientSecret();
    assert.strictEqual(apple.clientSecret(), first, 'not re-signed on every request');
    // Rotating the .p8 must take effect now, not when the cache happens to age.
    process.env.APPLE_PRIVATE_KEY = b.pem;
    assert.notStrictEqual(apple.clientSecret(), first, 'a new key mints a new secret');
    process.env.APPLE_PRIVATE_KEY = a.pem;
    process.env.APPLE_KEY_ID = 'OTHER12345';
    assert.notStrictEqual(apple.clientSecret(), first, 'so does a new key id');
  });
});

test('a .p8 mangled by a dashboard is repaired, not rejected', () => {
  const k = freshKey();
  const oneLine = k.pem.replace(/\n/g, '');
  const escaped = k.pem.replace(/\n/g, '\\n');
  const quoted = '"' + escaped + '"';
  [escaped, quoted, oneLine].forEach((form, i) => {
    withApple(good(form), () => {
      const jwt = apple.clientSecret();
      const [h, c, sig] = jwt.split('.');
      assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c),
        { key: k.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')),
      'form ' + i + ' produced a valid signature');
    });
  });
});

test('a half-configured Apple names the variable that is missing', () => {
  const k = freshKey();
  withApple({}, () => {
    assert.strictEqual(apple.configured(), false);
    assert.match(apple.whyNot(), /not configured/);
  });
  const partial = good(k.pem);
  delete partial.APPLE_KEY_ID;
  withApple(partial, () => {
    assert.strictEqual(apple.configured(), false);
    // The whole point: "invalid_client" from Apple tells you nothing.
    assert.match(apple.whyNot(), /APPLE_KEY_ID/);
    assert.throws(() => apple.clientSecret(), /APPLE_KEY_ID/);
  });
});

test('key material that is not an Apple key is refused by name', () => {
  withApple(Object.assign(good('not a pem at all'), {}), () => {
    assert.throws(() => apple.clientSecret(), /not a readable \.p8 key/);
  });
  // An RSA key is a PEM, and parses — and is still the wrong kind of key.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' });
  withApple(good(rsa), () => {
    assert.throws(() => apple.clientSecret(), /Apple issues an EC \(P-256\)/);
  });
});

test('a pre-minted secret is honoured, because somebody may already have one', () => {
  withApple({ APPLE_CLIENT_ID: 'com.kashikeyo.pos.web',
    APPLE_CLIENT_SECRET: 'a.pre.minted' }, () => {
    assert.strictEqual(apple.configured(), true);
    assert.strictEqual(apple.clientSecret(), 'a.pre.minted');
  });
  // ...but it is still useless without the Services id to send alongside it.
  withApple({ APPLE_CLIENT_SECRET: 'a.pre.minted' }, () => {
    assert.strictEqual(apple.configured(), false);
    assert.match(apple.whyNot(), /APPLE_CLIENT_ID/);
  });
});

/* ── proving you own the domain ─────────────────────────────────────────── */

test('/.well-known is served, and it does not open the door to dotfiles', () => {
  const fs = require('fs');
  const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Apple will not enable Sign in with Apple until it can fetch its
  // verification file from this path, and express.static ignores dotfiles.
  assert.match(server, /app\.use\('\/\.well-known',/,
    'the URL is routed explicitly, because static would 404 it');

  // Mapped from a directory without a leading dot: flipping dotfiles on for
  // the whole app directory would also start serving .env and .git.
  const block = (server.match(/app\.use\('\/\.well-known',[\s\S]*?\}\)\);/) || [''])[0];
  assert.match(block, /'well-known'/, 'served from app/well-known, not app/.well-known');
  assert.ok(!/dotfiles:\s*'allow'/.test(server),
    'dotfiles are never allowed wholesale');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'app', 'well-known')),
    'and the directory exists, so the path answers rather than 404ing');
});
