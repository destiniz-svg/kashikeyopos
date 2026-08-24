'use strict';
/* ═══ THE ACCOUNT PLANE ═════════════════════════════════════════════════════
   Above the outlet, and deliberately separate from it.

     an ACCOUNT signs up on the website with an email address and owns the
     business; a STAFF MEMBER taps their face at the till and keys four digits.

   Different people, different moments, different credentials. Conflating them
   is how a waiter ends up able to change the company's TIN.

   Four ways in, all landing on the same account row:
     · email + password
     · a six-digit code to that inbox (also how a new address is verified)
     · Google
     · Apple

   Everything here runs on the OWNER connection, because the account plane sits
   above every outlet and no outlet's login role is granted a single privilege
   on these tables (migration 011 revokes them explicitly). There is therefore
   no policy to get wrong here — only this file.

   What is never done: telling a stranger whether an address has an account.
   Sign-up, code-request and password-reset all answer identically either way.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const crypto = require('crypto');
const { owner } = require('../db');
const { hashPin, pinMatches, signAccount, verifyAccount } = require('../secrets');
const email = require('../email');
const { baseDomain } = require('../handle');
const apple = require('../apple');
const { gate } = require('../limit');

const r = express.Router();

const CODE_MINS = 10;
const CODE_TRIES = 5;
const LOCK_TRIES = 8;
const LOCK_MINS = 15;
const TOKEN_DAYS = 30;

const clean = (s) => String(s == null ? '' : s).trim();
const lower = (s) => clean(s).toLowerCase();
// Deliberately permissive: an address this fails is one no provider would
// accept, and being clever about the local part rejects real people.
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

function code6() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

function mint(account) {
  return signAccount({ a: account.id, exp: Date.now() + TOKEN_DAYS * 24 * 3600e3 });
}

async function byEmail(addr) {
  const q = await owner().query(
    'SELECT * FROM chain.account WHERE lower(email) = lower($1)', [addr]);
  return q.rows[0] || null;
}

async function logAccount(action, accountId, detail) {
  await owner().query(
    "INSERT INTO chain.audit (outlet_id, action, entity, entity_id, after, scope)"
    + " VALUES (NULL,$1,'account',$2,$3,'group')",
    [action, accountId, JSON.stringify(detail || {})]).catch(() => {});
}

/* Issue a code and get it to the person. Returns what the caller may safely
   say out loud — never whether the address is known. */
async function issueCode(account, purpose, brand) {
  const value = code6();
  const h = hashPin(value, null);
  await owner().query(
    'UPDATE chain.account SET code_hash = $2, code_salt = $3,'
    + " code_exp = now() + ($4 || ' minutes')::interval, code_tries = 0,"
    + ' code_purpose = $5 WHERE id = $1',
    [account.id, h.hash, h.salt, String(CODE_MINS), purpose]);

  let out = { sent: false, via: 'none' };
  try {
    out = await email.send(email.signInCode({
      to: account.email, code: value, mins: CODE_MINS, purpose: purpose, brand: brand
    }));
  } catch (e) {
    // A transport that answered and refused is worth recording; the code is
    // still valid, and an administrator can still read it from the trail.
    await logAccount('account_code_failed', account.id, { error: e.message });
  }
  await logAccount('account_code', account.id, { purpose: purpose, sent: out.sent, via: out.via });
  return { delivery: out, code: value };
}

// The same answer whether or not the address is a customer here.
function ackCode(res, extra) {
  res.json(Object.assign({
    ok: true, sent: true, mins: CODE_MINS,
    note: 'If that address has an account, a code is on its way.'
  }, extra || {}));
}

// Development only: returns the code in the response, which turns an email
// address into a login. Never set this anywhere real.
const echoing = () => process.env.ACCOUNT_CODE_ECHO === '1';

/* ── the doorman ─────────────────────────────────────────────────────────
   These four doors are open to the internet, and each call either sends an
   email or burns a guess. The identity bucket is keyed on the ADDRESS, so one
   inbox cannot be flooded from many connections; the IP bucket is wider, so
   an office behind one NAT is not read as an attacker. The refusal reveals
   nothing about whether the address is a customer — the same 429 either way.

   The per-account guards underneath (five tries per code, the lock after
   eight failed passwords) still stand; this door just makes reaching them
   expensive. */
const who = (req) => lower((req.body || {}).email);
const sendsMail = { id: [3, 10 * 60e3], ip: [12, 10 * 60e3] };
const guesses = { id: [10, 10 * 60e3], ip: [40, 10 * 60e3] };

/* ── sign up ─────────────────────────────────────────────────────────────── */
r.post('/signup', gate('acct-code', sendsMail, who), async function (req, res, next) {
  const b = req.body || {};
  const addr = lower(b.email);
  const name = clean(b.name);
  const password = String(b.password || '');
  try {
    if (!looksLikeEmail(addr)) return res.status(400).json({ error: 'that does not look like an email address' });
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'a password needs at least eight characters' });
    }

    const existing = await byEmail(addr);
    if (existing) {
      /* An address that is already registered is NOT told so — that is how you
         enumerate a customer list. A code goes to the inbox instead: the person
         who owns it discovers the account exists, and nobody else does. */
      await issueCode(existing, 'signin', b.brand);
      return ackCode(res, { next: 'code' });
    }

    const h = password ? hashPin(password, null) : { hash: null, salt: null };
    const q = await owner().query(
      'INSERT INTO chain.account (email, name, password_hash, password_salt)'
      + ' VALUES ($1,$2,$3,$4) RETURNING *',
      [addr, name || null, h.hash, h.salt]);
    const account = q.rows[0];
    const issued = await issueCode(account, 'verify', b.brand);
    await logAccount('account_signup', account.id, { email: addr });
    ackCode(res, {
      next: 'code',
      // Only ever present in development.
      code: echoing() ? issued.code : undefined,
      delivered: issued.delivery.sent ? 'email' : 'not-sent'
    });
  } catch (e) { next(e); }
});

/* ── a code to the inbox: sign in, or verify a new address ───────────────── */
r.post('/code', gate('acct-code', sendsMail, who), async function (req, res, next) {
  const b = req.body || {};
  const addr = lower(b.email);
  try {
    if (!looksLikeEmail(addr)) return res.status(400).json({ error: 'that does not look like an email address' });
    const account = await byEmail(addr);
    if (!account) return ackCode(res, { next: 'code' });   // same answer, no account
    if (account.status !== 'active') return ackCode(res, { next: 'code' });
    const issued = await issueCode(account, account.verified_at ? 'signin' : 'verify', b.brand);
    ackCode(res, {
      next: 'code',
      code: echoing() ? issued.code : undefined,
      delivered: issued.delivery.sent ? 'email' : 'not-sent'
    });
  } catch (e) { next(e); }
});

r.post('/code/verify', gate('acct-guess', guesses, who), async function (req, res, next) {
  const b = req.body || {};
  const addr = lower(b.email);
  const value = clean(b.code);
  try {
    const account = await byEmail(addr);
    const no = { error: 'that code does not match' };
    if (!account || !account.code_hash) return res.status(401).json(no);
    if (account.code_exp && new Date(account.code_exp).getTime() < Date.now()) {
      await clearCode(account.id);
      return res.status(401).json({ error: 'that code has expired — ask for another' });
    }
    if (account.code_tries >= CODE_TRIES) {
      await clearCode(account.id);
      return res.status(429).json({ error: 'too many attempts — ask for a new code' });
    }
    if (!pinMatches(value, account.code_hash, account.code_salt)) {
      await owner().query('UPDATE chain.account SET code_tries = code_tries + 1 WHERE id = $1',
        [account.id]);
      await logAccount('account_code_failed', account.id, { tries: account.code_tries + 1 });
      return res.status(401).json(no);
    }
    await clearCode(account.id, true);
    await logAccount('account_sign_in', account.id, { by: 'code' });
    res.json(await session(account.id));
  } catch (e) { next(e); }
});

async function clearCode(id, verified) {
  await owner().query(
    'UPDATE chain.account SET code_hash = NULL, code_salt = NULL, code_exp = NULL,'
    + ' code_tries = 0, code_purpose = NULL, last_seen_at = now(),'
    + ' verified_at = CASE WHEN $2 THEN coalesce(verified_at, now()) ELSE verified_at END,'
    + ' failed = CASE WHEN $2 THEN 0 ELSE failed END WHERE id = $1',
    [id, !!verified]);
}

/* ── email and password ──────────────────────────────────────────────────── */
r.post('/signin', gate('acct-guess', guesses, who), async function (req, res, next) {
  const b = req.body || {};
  const addr = lower(b.email);
  const password = String(b.password || '');
  try {
    const account = await byEmail(addr);
    // One message for "no such account" and "wrong password", and the same
    // work either way — a fast negative is itself an answer.
    const no = { error: 'that email and password do not match' };
    if (!account || !account.password_hash) {
      hashPin(password || 'x', 'decoy-salt-for-constant-work');
      return res.status(401).json(no);
    }
    if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
      return res.status(429).json({
        error: 'too many attempts — this account is locked for a few minutes'
      });
    }
    if (!pinMatches(password, account.password_hash, account.password_salt)) {
      const n = account.failed + 1;
      // Cast explicitly: the same placeholder is read as a value and as a
      // comparand, and Postgres will not deduce one type for both on its own.
      await owner().query(
        'UPDATE chain.account SET failed = $2::int,'
        + " locked_until = CASE WHEN $2::int >= $3::int"
        + "   THEN now() + ($4::text || ' minutes')::interval"
        + ' ELSE locked_until END WHERE id = $1',
        [account.id, n, LOCK_TRIES, String(LOCK_MINS)]);
      await logAccount('account_sign_in_refused', account.id, { failed: n });
      return res.status(401).json(no);
    }
    if (account.status !== 'active') return res.status(403).json({ error: 'this account is suspended' });
    await owner().query(
      'UPDATE chain.account SET failed = 0, locked_until = NULL, last_seen_at = now()'
      + ' WHERE id = $1', [account.id]);
    await logAccount('account_sign_in', account.id, { by: 'password' });
    res.json(await session(account.id));
  } catch (e) { next(e); }
});

r.post('/password', requireAccount, async function (req, res, next) {
  const b = req.body || {};
  const next_ = String(b.password || '');
  try {
    if (next_.length < 8) return res.status(400).json({ error: 'a password needs at least eight characters' });
    const h = hashPin(next_, null);
    await owner().query(
      'UPDATE chain.account SET password_hash = $2, password_salt = $3 WHERE id = $1',
      [req.account.id, h.hash, h.salt]);
    await logAccount('account_password_set', req.account.id, {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ── Google and Apple ────────────────────────────────────────────────────────
   Both are OpenID Connect. The flow is the same for each and the differences
   are entirely configuration, so there is one implementation and a table of
   endpoints. Credentials come from the environment; with none set the provider
   is simply not offered, and /providers says so rather than showing a button
   that cannot work. */
const PROVIDERS = {
  google: {
    id: () => clean(process.env.GOOGLE_CLIENT_ID),
    secret: () => clean(process.env.GOOGLE_CLIENT_SECRET),
    ready: () => !!(clean(process.env.GOOGLE_CLIENT_ID)
      && clean(process.env.GOOGLE_CLIENT_SECRET)),
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    // Somebody signing a business up on a shared machine should be asked WHICH
    // Google account, not silently handed whichever one the browser remembers.
    extra: { prompt: 'select_account' }
  },
  apple: {
    id: () => clean(process.env.APPLE_CLIENT_ID),
    // Not a fixed string: Apple's client secret is a JWT this app mints from
    // the .p8 and re-mints before it expires. See src/apple.js.
    secret: () => apple.clientSecret(),
    ready: () => apple.configured(),
    auth: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    scope: 'openid email name',
    // Apple posts the callback back as a form rather than a query string, and
    // it only does that at all when a scope beyond openid was asked for.
    formPost: true
  }
};

// `ready` rather than "has an id and a secret": Apple's secret is minted, and
// minting it throws when the key material is wrong — which is a thing to
// report, not a thing to crash the providers list with.
const enabled = (k) => {
  try { return !!(PROVIDERS[k] && PROVIDERS[k].ready()); }
  catch (e) { return false; }
};

r.get('/providers', function (req, res) {
  res.json({
    password: true,
    code: true,
    emailTransport: email.configured(),
    google: enabled('google'),
    apple: enabled('apple'),
    /* Why a provider is off, for whoever is setting this up. Never the values
       — only which NAMES are missing, which is the one thing a half-configured
       install cannot tell you from the outside. Apple in particular fails in a
       way that reads as "invalid_client" from Apple's own error page, months
       after anybody touched it. */
    why: {
      google: enabled('google') ? null
        : (clean(process.env.GOOGLE_CLIENT_ID) || clean(process.env.GOOGLE_CLIENT_SECRET)
          ? 'Google sign-in is missing '
            + ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
              .filter((n) => !clean(process.env[n])).join(', ')
          : 'Google sign-in is not configured'),
      apple: apple.whyNot()
    },
    // The domain stores hang off, so the front door can name a real address
    // instead of spelling one. Empty where host routing is off, and the page
    // then says nothing rather than something that will not resolve.
    base: baseDomain()
  });
});

function callbackUrl(req, provider) {
  const base = process.env.PUBLIC_URL
    || (req.protocol + '://' + req.get('host'));
  return base.replace(/\/+$/, '') + '/api/account/oauth/' + provider + '/callback';
}

r.get('/oauth/:provider/start', function (req, res) {
  const key = String(req.params.provider);
  if (!enabled(key)) return res.status(404).json({ error: 'that sign-in method is not configured' });
  const p = PROVIDERS[key];
  /* The state is signed rather than stored: it has to survive a redirect to
     another site and back without a session to hang it on. The NONCE travels
     inside it and comes back inside the id_token, which is what ties the token
     we are handed to the request we actually made. */
  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = signAccount({ n: crypto.randomBytes(9).toString('base64url'),
    p: key, nn: nonce, exp: Date.now() + 10 * 60e3 });

  const params = {
    client_id: p.id(),
    redirect_uri: callbackUrl(req, key),
    response_type: 'code',
    scope: p.scope,
    state: state,
    nonce: nonce
  };
  // form_post only where the provider asks for it. Sending a parameter a
  // provider does not know is how a working sign-in becomes invalid_request.
  if (p.formPost) params.response_mode = 'form_post';
  Object.assign(params, p.extra || {});

  let url;
  try { url = p.auth + '?' + new URLSearchParams(params).toString(); }
  catch (e) { return res.status(503).json({ error: 'that sign-in method is misconfigured' }); }
  res.redirect(url);
});

async function oauthCallback(req, res, next) {
  const key = String(req.params.provider);
  const src = Object.assign({}, req.query || {}, req.body || {});
  try {
    if (!enabled(key)) return res.status(404).send('That sign-in method is not configured.');
    const claims = verifyAccount(String(src.state || ''));
    if (!claims || claims.p !== key) return res.status(400).send('That sign-in did not complete. Please start again.');
    if (src.error) return res.redirect('/account?error=' + encodeURIComponent(String(src.error).slice(0, 60)));

    const p = PROVIDERS[key];
    let secret;
    // Apple's is minted, and minting can fail on bad key material. That is a
    // configuration fault, not a signed-in person's fault — say so on the page
    // they are standing on rather than 500ing at them.
    try { secret = p.secret(); }
    catch (e) {
      console.error('[oauth] ' + key + ': ' + e.message);   // eslint-disable-line no-console
      return res.redirect('/account?error=' + encodeURIComponent('that sign-in method is misconfigured'));
    }
    const body = new URLSearchParams({
      client_id: p.id(), client_secret: secret,
      code: String(src.code || ''), grant_type: 'authorization_code',
      redirect_uri: callbackUrl(req, key)
    });
    const tk = await fetch(p.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10000)
    });
    const payload = await tk.json().catch(() => ({}));
    if (!tk.ok || !payload.id_token) {
      return res.redirect('/account?error=' + encodeURIComponent('the provider refused'));
    }

    /* The id_token is read, not trusted for authorisation: it arrived over TLS
       directly from the provider's token endpoint in exchange for our client
       secret, which is what makes it good enough to identify a person. We do
       not mint anything from it beyond our own account token. */
    const idc = readJwtClaims(payload.id_token);
    const subject = clean(idc.sub);
    const addr = lower(idc.email);
    if (!subject) return res.redirect('/account?error=' + encodeURIComponent('no identity returned'));

    // The nonce we sent must be the nonce that came back, or this id_token
    // belongs to some other authorization request than the one we started.
    if (claims.nn && clean(idc.nonce) !== claims.nn) {
      return res.redirect('/account?error=' + encodeURIComponent('that sign-in did not complete — please start again'));
    }

    /* Apple sends the name ONCE, on the very first authorization, as a form
       field beside the code — never in the id_token and never again. Miss it
       here and it is gone for good, so it is read carefully rather than
       optimistically: a malformed value must not take the sign-in down with it. */
    let account;
    try {
      account = await linkIdentity(key, subject, addr,
        clean(idc.name) || clean(idc.given_name) || appleName(src.user),
        emailVerified(idc));
    } catch (e) {
      if (e && e.status === 409) {
        return res.redirect('/account?error=' + encodeURIComponent(e.message));
      }
      throw e;
    }
    await logAccount('account_sign_in', account.id, { by: key });
    const s = await session(account.id);
    // The token goes to the page in the fragment, which is never sent to a
    // server or written to a proxy log.
    res.redirect('/account#token=' + encodeURIComponent(s.token));
  } catch (e) { next(e); }
}
r.get('/oauth/:provider/callback', oauthCallback);
r.post('/oauth/:provider/callback', express.urlencoded({ extended: false }), oauthCallback);

/* Apple's `user` field, which arrives once and only once. */
function appleName(raw) {
  if (!raw) return '';
  try {
    const u = JSON.parse(String(raw));
    const n = (u && u.name) || {};
    return clean([clean(n.firstName), clean(n.lastName)].filter(Boolean).join(' '));
  } catch (e) { return ''; }
}

/* Has the provider actually PROVED this address? Google sends a boolean;
   Apple has been known to send the string "true". Anything else is a no —
   an address the provider has not verified is a claim, not a fact, and the
   difference decides whether it may reach an account somebody else made. */
function emailVerified(idc) {
  const v = idc && idc.email_verified;
  return v === true || v === 'true';
}

function readJwtClaims(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString()) || {};
  } catch (e) { return {}; }
}

/* A social identity is matched on the provider's own subject, never on the
   email — a person can change their address at the provider, and matching on
   it would either lock them out or hand them somebody else's account. The
   address is still used to JOIN an existing account the first time, because
   somebody who signed up with a password and later taps "Continue with
   Google" means to reach the same business. */
async function linkIdentity(provider, subject, addr, name, verified) {
  const found = await owner().query(
    'SELECT a.* FROM chain.account_identity i JOIN chain.account a ON a.id = i.account_id'
    + ' WHERE i.provider = $1 AND i.subject = $2', [provider, subject]);
  if (found.rows.length) {
    await owner().query('UPDATE chain.account_identity SET last_seen_at = now(),'
      + ' email = coalesce($3, email) WHERE provider = $1 AND subject = $2',
    [provider, subject, addr || null]);
    return found.rows[0];
  }

  /* Joining by address is only safe when the provider has PROVED the address.
     Unverified, "sign in with Google" as somebody else's email would walk
     straight into their account — the provider is asserting an address it has
     not checked, and we would be treating that assertion as proof of identity.
     Google and Apple do verify in practice; this is the guard for the day one
     of them, or a future provider, does not. */
  let account = (addr && verified) ? await byEmail(addr) : null;

  if (!account && addr && !verified) {
    const taken = await byEmail(addr);
    if (taken) {
      // Refused by name. They have an account; they just have to prove the
      // address the ordinary way, and then this identity can be attached.
      throw Object.assign(new Error('that address already has an account — sign in'
        + ' with your password or a code, and it will be linked'), { status: 409 });
    }
  }

  if (!account) {
    const q = await owner().query(
      'INSERT INTO chain.account (email, name, verified_at) VALUES ($1,$2,$3)'
      + ' RETURNING *',
      [addr || (provider + ':' + subject), name || null,
        // A brand-new account is verified only if the provider verified it. An
        // unverified one still exists and can still sign in with this identity;
        // it simply has not proved its inbox yet.
        (addr && verified) ? new Date() : null]);
    account = q.rows[0];
    await logAccount('account_signup', account.id, { by: provider });
  } else if (!account.verified_at) {
    // The provider has already proved the address; that is what verification is.
    await owner().query('UPDATE chain.account SET verified_at = now() WHERE id = $1',
      [account.id]);
  }
  await owner().query(
    'INSERT INTO chain.account_identity (account_id, provider, subject, email)'
    + ' VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING',
    [account.id, provider, subject, addr || null]);
  return account;
}

/* ── who am I, and what do I own ─────────────────────────────────────────── */
async function requireAccount(req, res, next) {
  /* THE HEADER, AND ONLY THE HEADER. This used to fall back to `?at=`, and
     nothing has ever sent it — but a credential in a query string is a
     credential in the proxy's access log, in the browser's history, in the
     bookmark somebody shares, and in every Referer the page emits that a
     no-referrer policy does not happen to cover. A fallback nobody uses is
     all cost. */
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = verifyAccount(raw);
  if (!claims || !claims.a) return res.status(401).json({ error: 'sign in again' });
  try {
    const q = await owner().query('SELECT * FROM chain.account WHERE id = $1', [claims.a]);
    const account = q.rows[0];
    if (!account || account.status !== 'active') {
      return res.status(401).json({ error: 'sign in again' });
    }
    req.account = account;
    next();
  } catch (e) { next(e); }
}

async function session(accountId) {
  const q = await owner().query('SELECT * FROM chain.account WHERE id = $1', [accountId]);
  const account = q.rows[0];
  const owned = await owner().query(
    'SELECT ao.outlet_id, ao.role, o.code, o.name, o.slug, o.currency, o.tax_code'
    + ' FROM chain.account_outlet ao JOIN chain.outlet o ON o.id = ao.outlet_id'
    + ' WHERE ao.account_id = $1 ORDER BY ao.outlet_id', [accountId]);
  const co = await owner().query(
    'SELECT id, legal_name, base_currency FROM chain.company WHERE owner_account_id = $1',
    [accountId]);
  return {
    token: mint(account),
    account: {
      id: account.id, email: account.email, name: account.name,
      verified: !!account.verified_at,
      hasPassword: !!account.password_hash
    },
    company: co.rows[0] || null,
    outlets: owned.rows,
    // What the browser should do next, decided here rather than guessed there.
    next: owned.rows.length ? 'terminal' : 'onboarding'
  };
}

r.get('/me', requireAccount, async function (req, res, next) {
  try { res.json(await session(req.account.id)); } catch (e) { next(e); }
});

r.post('/signout', requireAccount, async function (req, res, next) {
  try {
    await logAccount('account_sign_out', req.account.id, {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = r;
module.exports.requireAccount = requireAccount;
module.exports.accountSession = session;
