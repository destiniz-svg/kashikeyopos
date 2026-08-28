'use strict';
/* ═══ THE SELLER'S SIDE OF THE CONTRACT ═════════════════════════════════════
   The website takes a store request from anybody on the internet; Mission
   Control turns it into an install a seller monitors. Between those two sit
   the promises this file pins: the setup door cannot be raced, sign-in never
   reveals whether an address is an admin, a platform key never travels back
   to a browser, a duplicate request never stacks, and a provisioned request
   stays linked to the install it became.

   Runs against a REAL Postgres registry, created fresh — the same shared
   database both services boot against, advisory-locked so they cannot race
   each other's CREATEs.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

const HAS_DB = !!(process.env.PGHOST || process.env.DATABASE_URL);
const opts = HAS_DB ? {} : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

const DBNAME = process.env.PGPANELTESTDB || 'kashikeyo_panel_test';

let panel, site, panelBase, siteBase, panelSrv, siteSrv;

test('a fresh registry database', opts, async () => {
  const admin = new Client({ database: 'postgres' });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ' + DBNAME + ' (FORCE)');
  await admin.query('CREATE DATABASE ' + DBNAME);
  await admin.end();

  process.env.DATABASE_URL = 'postgres://' + (process.env.PGUSER || 'postgres')
    + (process.env.PGPASSWORD ? ':' + process.env.PGPASSWORD : '')
    + '@' + (process.env.PGHOST || '127.0.0.1') + ':' + (process.env.PGPORT || 5432)
    + '/' + DBNAME;
  process.env.PANEL_SECRET = 'panel-test-secret-0123456789abcdef!!';
  delete process.env.PANEL_SETUP_TOKEN;
  // The apex belongs to the website; the till's paths forward to its home.
  // Read at module load, so set before the require.
  process.env.APP_URL = 'https://app.example.test';
  process.env.CANONICAL_HOST = 'example.test';
  /* THE DEDICATED-INSTALL PATH IS OFF BY DEFAULT NOW, because customers create
     their own business by signing up and a button that builds an install the
     registry has never heard of is a control that does the wrong thing
     confidently. It is still a supported thing to sell, so most of this file
     exercises it and turns it on deliberately — and one test below asserts
     that the default is off, and refuses BY NAME rather than 404ing. */
  process.env.PANEL_DEDICATED_INSTALLS = '1';

  panel = require('../panel/server');
  site = require('../site/server');
  // Both migrate against one database — the advisory lock is what makes this
  // safe to do concurrently, which is exactly how the two services boot.
  await Promise.all([panel.migrate(), site.migrate()]);
  await new Promise((r) => { panelSrv = panel.app.listen(0, r); });
  await new Promise((r) => { siteSrv = site.app.listen(0, r); });
  panelBase = 'http://127.0.0.1:' + panelSrv.address().port;
  siteBase = 'http://127.0.0.1:' + siteSrv.address().port;
});

async function call(base, method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

let token;

test('first-run setup is gated on the environment, then spent', opts, async () => {
  // No PANEL_SETUP_TOKEN in the environment: the door says so, by name.
  let r = await call(panelBase, 'POST', '/api/setup',
    { token: 'anything', email: 'seller@example.com', password: 'a-long-password-12' });
  assert.strictEqual(r.status, 503, JSON.stringify(r.body));
  assert.match(r.body.error, /PANEL_SETUP_TOKEN/);

  process.env.PANEL_SETUP_TOKEN = 'test-setup-token-abc123';
  r = await call(panelBase, 'POST', '/api/setup',
    { token: 'wrong-token-wrong-abc', email: 'seller@example.com', password: 'a-long-password-12' });
  assert.strictEqual(r.status, 401, 'a wrong setup token is refused');

  r = await call(panelBase, 'POST', '/api/setup',
    { token: 'test-setup-token-abc123', email: 'seller@example.com', password: 'a-long-password-12' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
  assert.ok(token, 'setup answers with a session');

  // Spent: a second admin cannot be raced in, even with the right token.
  r = await call(panelBase, 'POST', '/api/setup',
    { token: 'test-setup-token-abc123', email: 'other@example.com', password: 'a-long-password-12' });
  assert.strictEqual(r.status, 409, 'the panel is already set up');
});

/* A WARNING NOBODY SEES IS NOT A WARNING.

   ready() gained a `warn` for a panel with no email transport to pass on —
   which is the gap that made the first live install unclaimable — and the
   state endpoint dropped it on the floor, so the sheet rendered nothing. The
   same defect class as a control that lies: the code was careful and the
   operator learned nothing. */
test('a gap that does not stop a run is still reported before one', opts, async () => {
  const before = { tok: process.env.RAILWAY_API_TOKEN, repo: process.env.INSTALL_REPO,
    key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
  try {
    // Configured to provision, but with no transport to hand on.
    process.env.RAILWAY_API_TOKEN = 'tok_for_this_test';
    process.env.INSTALL_REPO = 'owner/repo';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;

    const r = await call(panelBase, 'GET', '/api/state');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.auto, true, 'still allowed — an install with no email works');
    assert.strictEqual(r.body.autoWhy, null, 'so there is no reason it is off');
    assert.match(r.body.autoWarn, /RESEND_API_KEY/,
      'but the gap reaches the screen, by the name of the variable that closes it');

    // And once it is configured, nothing is warned about.
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'Test <no-reply@example.com>';
    const ok = await call(panelBase, 'GET', '/api/state');
    assert.strictEqual(ok.body.autoWarn, null, 'a configured panel says nothing');
  } finally {
    ['RAILWAY_API_TOKEN', 'INSTALL_REPO', 'RESEND_API_KEY', 'EMAIL_FROM'].forEach((k, i) => {
      const v = [before.tok, before.repo, before.key, before.from][i];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
  }
});

test('sign-in never says whether an address is an admin', opts, async () => {
  const known = await call(panelBase, 'POST', '/api/signin',
    { email: 'seller@example.com', password: 'wrong-password-here' });
  const unknown = await call(panelBase, 'POST', '/api/signin',
    { email: 'nobody@example.com', password: 'wrong-password-here' });
  assert.strictEqual(known.status, 401);
  assert.strictEqual(unknown.status, 401);
  assert.deepStrictEqual(known.body, unknown.body, 'byte-identical either way');

  const good = await call(panelBase, 'POST', '/api/signin',
    { email: 'seller@example.com', password: 'a-long-password-12' });
  assert.strictEqual(good.status, 200);
});

/* ═══ THE ADMIN ACCOUNT, HARDENED ════════════════════════════════════════════
   One password between the internet and every licence and provision button
   was the panel's weakest wall. Three closures, each proven end to end:
   TOTP 2FA (RFC 6238 over node crypto — enrolment is two steps so an
   unscanned secret can never lock the only admin out), a second admin, and
   an epoch-based sign-out that orphans every other token. */
test('the admin account hardens: 2FA, a second admin, sign out everywhere', opts, async () => {
  // The account starts plain, and says so.
  let r = await call(panelBase, 'GET', '/api/account', undefined, token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.totpEnabled, false);
  assert.strictEqual(r.body.admins.length, 1, 'one admin, from setup');
  const meId = r.body.admins[0].id;

  // Enrolment starts: a secret is PENDING, and gates nothing yet — it was
  // never scanned, and enabling it now could lock the only admin out.
  r = await call(panelBase, 'POST', '/api/account/totp/start', {}, token);
  assert.strictEqual(r.status, 200);
  assert.match(r.body.otpauth, /^otpauth:\/\/totp\//, 'the app-scannable URL');
  assert.match(r.body.base32, /^[A-Z2-7]+$/, 'the hand-typable secret');
  let s = await call(panelBase, 'POST', '/api/signin',
    { email: 'seller@example.com', password: 'a-long-password-12' });
  assert.strictEqual(s.status, 200, 'a pending secret does not gate sign-in');

  // Confirm with the authenticator's own arithmetic; a wrong code is refused.
  const pend = (await panel.pool.query(
    'SELECT totp_pending FROM panel.admin WHERE id = $1', [meId])).rows[0].totp_pending;
  const good = () => panel._totpAt(pend, Date.now());
  const bad = String((Number(good()) + 1) % 1e6).padStart(6, '0');
  r = await call(panelBase, 'POST', '/api/account/totp/confirm', { code: bad }, token);
  assert.strictEqual(r.status, 401, 'a wrong code does not confirm');
  r = await call(panelBase, 'POST', '/api/account/totp/confirm', { code: good() }, token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  // Sign-in now demands the second factor, names the need, and honours it.
  s = await call(panelBase, 'POST', '/api/signin',
    { email: 'seller@example.com', password: 'a-long-password-12' });
  assert.strictEqual(s.status, 401);
  assert.strictEqual(s.body.need, 'totp', 'the page is told which step is missing');
  s = await call(panelBase, 'POST', '/api/signin',
    { email: 'seller@example.com', password: 'a-long-password-12', code: bad });
  assert.strictEqual(s.status, 401, 'a wrong code is a refusal');
  s = await call(panelBase, 'POST', '/api/signin',
    { email: 'seller@example.com', password: 'a-long-password-12', code: good() });
  assert.strictEqual(s.status, 200, 'password + code opens the panel');

  // A second admin — added by a signed-in admin, signing in on their own.
  r = await call(panelBase, 'POST', '/api/admins',
    { email: 'second@example.com', password: 'another-long-pass-12' }, token);
  assert.strictEqual(r.status, 200);
  const secondId = r.body.id;
  s = await call(panelBase, 'POST', '/api/signin',
    { email: 'second@example.com', password: 'another-long-pass-12' });
  assert.strictEqual(s.status, 200, 'the second admin has no 2FA yet and gets in');

  // The two removals that end in a locked panel are refused by name.
  r = await call(panelBase, 'DELETE', '/api/admins/' + meId, undefined, token);
  assert.strictEqual(r.status, 400, 'you cannot remove yourself');
  r = await call(panelBase, 'DELETE', '/api/admins/' + secondId, undefined, token);
  assert.strictEqual(r.status, 200, 'another admin can be removed');
  r = await call(panelBase, 'DELETE', '/api/admins/' + secondId, undefined, token);
  assert.strictEqual(r.status, 400, 'and the last admin standing cannot be');

  /* Sign out everywhere: the epoch bumps, every token signed before it is
     orphaned — including the one that asked — and the answer carries a fresh
     token so the session doing the signing-out survives. */
  r = await call(panelBase, 'POST', '/api/account/signout-everywhere', {}, token);
  assert.strictEqual(r.status, 200);
  const fresh = r.body.token;
  assert.ok(fresh, 'a fresh token rides the answer');
  const oldT = await call(panelBase, 'GET', '/api/account', undefined, token);
  assert.strictEqual(oldT.status, 401, 'the old token is dead');
  const newT = await call(panelBase, 'GET', '/api/account', undefined, fresh);
  assert.strictEqual(newT.status, 200, 'the fresh one lives');
  token = fresh;

  // Turning 2FA off needs a current code — a signed-in tab alone is not enough.
  r = await call(panelBase, 'POST', '/api/account/totp/disable', { code: bad }, token);
  assert.strictEqual(r.status, 401);
  r = await call(panelBase, 'POST', '/api/account/totp/disable', { code: good() }, token);
  assert.strictEqual(r.status, 200, 'off again, so the rest of this file signs in plain');
});

test('the overview needs a session, and never carries a platform key', opts, async () => {
  assert.strictEqual((await call(panelBase, 'GET', '/api/overview')).status, 401);

  const add = await call(panelBase, 'POST', '/api/installs', {
    name: 'Test Install', baseUrl: 'http://127.0.0.1:1',
    platformKey: 'a-platform-key-0123456789abcdef-xyz', kind: 'trial', trialEnds: '2030-01-01'
  }, token);
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));

  const o = await call(panelBase, 'GET', '/api/overview', undefined, token);
  assert.strictEqual(o.status, 200);
  assert.strictEqual(o.body.installs.length, 1);
  const text = JSON.stringify(o.body);
  assert.ok(!text.includes('a-platform-key'), 'the key never travels to a browser');
  // Port 1 answers nothing: the probe reports it as an honest state, not a hang.
  assert.ok(['down', 'refused', 'nokey'].includes(o.body.installs[0].live.state),
    JSON.stringify(o.body.installs[0].live));
});

test('the setup code is readable back, and never rides in the dashboard poll',
  opts, async () => {
  /* The code a customer types into their own /onboarding to claim the install.
     The seller has to be able to read it back — that is the whole reason it is
     in the registry rather than only in a Railway variable — but a credential
     that grants ownership of an unclaimed install should be ASKED for, not
     delivered every thirty seconds into a browser left open on a desk. */
  const add = await call(panelBase, 'POST', '/api/installs', {
    name: 'Coded Install', baseUrl: 'http://127.0.0.1:1',
    platformKey: 'a-platform-key-0123456789abcdef-abc',
    claimCode: 'the-setup-code-for-coded-install'
  }, token);
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));

  const o = await call(panelBase, 'GET', '/api/overview', undefined, token);
  assert.ok(!JSON.stringify(o.body).includes('the-setup-code'),
    'the dashboard poll carries no setup code');

  assert.strictEqual((await call(panelBase, 'GET', '/api/installs/' + add.body.id + '/claim'))
    .status, 401, 'and reading one back needs a session');

  const back = await call(panelBase, 'GET', '/api/installs/' + add.body.id + '/claim',
    undefined, token);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.body.claimCode, 'the-setup-code-for-coded-install',
    'the seller can read it back to a customer who lost it');
  assert.strictEqual(back.body.set, true);

  // An install recorded WITHOUT one says so rather than showing an empty box:
  // no code recorded and no code required are the same string and different
  // facts, and the seller is the one who has to tell them apart.
  const bare = await call(panelBase, 'POST', '/api/installs', {
    name: 'Uncoded Install', baseUrl: 'http://127.0.0.1:1',
    platformKey: 'a-platform-key-0123456789abcdef-def'
  }, token);
  const none = await call(panelBase, 'GET', '/api/installs/' + bare.body.id + '/claim',
    undefined, token);
  assert.strictEqual(none.body.set, false, 'an install with no code recorded says so');
});

test('a short or http-in-production base URL is refused', opts, async () => {
  const shortKey = await call(panelBase, 'POST', '/api/installs',
    { name: 'X', baseUrl: 'https://x.example', platformKey: 'short' }, token);
  assert.strictEqual(shortKey.status, 400);
  assert.match(shortKey.body.error, /32/);
});

test('the website records a store request once, however often it is sent', opts, async () => {
  const body = {
    storeName: 'Test Café', contactName: 'A Person', email: 'person@example.mv',
    phone: '+960 700 0000', island: 'Malé', note: 'testing'
  };
  const r1 = await call(siteBase, 'POST', '/api/site/signup', body);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await call(siteBase, 'POST', '/api/site/signup', body);
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r1.body, r2.body, 'byte-identical — no enumeration, no stacking');

  const q = await panel.pool.query("SELECT count(*)::int AS n FROM panel.signup WHERE email = 'person@example.mv'");
  assert.strictEqual(q.rows[0].n, 1, 'one open request per address');

  const missing = await call(siteBase, 'POST', '/api/site/signup', { storeName: 'X' });
  assert.strictEqual(missing.status, 400, 'an incomplete request is refused');
});

test('a request provisioned in the panel stays linked to its install', opts, async () => {
  const list = await call(panelBase, 'GET', '/api/signups', undefined, token);
  assert.strictEqual(list.status, 200);
  const req = list.body.signups.find((s) => s.email === 'person@example.mv');
  assert.ok(req, 'the website request reached the panel');
  assert.strictEqual(req.status, 'new');

  const inst = await call(panelBase, 'POST', '/api/installs', {
    name: req.store_name, baseUrl: 'https://test-cafe.example',
    platformKey: 'another-platform-key-0123456789abcdef', kind: 'trial', trialEnds: '2030-01-01'
  }, token);
  const done = await call(panelBase, 'PATCH', '/api/signups/' + req.id,
    { status: 'provisioned', installId: inst.body.id }, token);
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));

  const after = await call(panelBase, 'GET', '/api/signups', undefined, token);
  const row = after.body.signups.find((s) => s.id === req.id);
  assert.strictEqual(row.status, 'provisioned');
  assert.strictEqual(row.install_id, inst.body.id, 'the request remembers what it became');
  assert.ok(row.decided_at, 'and when it was decided');

  // Decided: a fresh request from the same address may open again.
  const again = await call(siteBase, 'POST', '/api/site/signup', {
    storeName: 'Test Café Two', contactName: 'A Person', email: 'person@example.mv', phone: '+960 700 0000'
  });
  assert.strictEqual(again.status, 200);
  const n = await panel.pool.query("SELECT count(*)::int AS n FROM panel.signup WHERE email = 'person@example.mv'");
  assert.strictEqual(n.rows[0].n, 2, 'a decided request does not block a new one');
});

test("the website forwards the till's paths and keeps its own", opts, async () => {
  // The bare domain served the terminal for months: its paths are typed,
  // bookmarked and printed. Moved, not killed — path and query intact.
  for (const p of ['/pos', '/kds', '/admin', '/onboarding', '/account', '/g/reef-grill?t=4', '/join/MV-abc-123']) {
    const r = await fetch(siteBase + p, { redirect: 'manual' });
    assert.strictEqual(r.status, 308, p + ' forwards to the till');
    assert.strictEqual(r.headers.get('location'),
      'https://app.example.test' + p, p);
  }
  /* THE ACCOUNT IS ASKED FOR ONCE. This used to assert the opposite — that
     /signup stayed on the site — and that is what produced the double entry
     the customer hit: a business name, a name and an address here, then the
     same name and address again on the app, because the app is the only place
     an address can be verified and therefore the only place a business can be
     created. Both front doors land on that one form now. 302 rather than 308:
     they land on a form rather than repeating a POST, and this site may want
     the path back. */
  const signup = await fetch(siteBase + '/signup', { redirect: 'manual' });
  assert.strictEqual(signup.status, 302, '/signup goes to the app');
  assert.strictEqual(signup.headers.get('location'), 'https://app.example.test/account');
  // Signing in is the returning half of the same door, and says so, or the
  // form opens headed "Create your account".
  const login = await fetch(siteBase + '/login', { redirect: 'manual' });
  assert.strictEqual(login.status, 302, '/login goes to the app');
  assert.strictEqual(login.headers.get('location'),
    'https://app.example.test/account?mode=signin');
  // A lookalike prefix is not a till path.
  const look = await fetch(siteBase + '/membership-terms', { redirect: 'manual' });
  assert.notStrictEqual(look.status, 308, 'prefix lookalikes stay on the site');

  // www is the site under another name, and 301s to the bare domain.
  const http = require('http');
  const u = new URL(siteBase + '/docs?x=1');
  const www = await new Promise((resolve, reject) => {
    const rq = http.request({ host: u.hostname, port: u.port, method: 'GET',
      path: u.pathname + u.search, headers: { host: 'www.example.test' } }, (rs) => {
      rs.resume();
      rs.on('end', () => resolve({ status: rs.statusCode, location: rs.headers.location }));
    });
    rq.on('error', reject);
    rq.end();
  });
  assert.strictEqual(www.status, 301);
  assert.strictEqual(www.location, 'https://example.test/docs?x=1');
});

/* ═══ THE PANEL READS THE REGISTRY ══════════════════════════════════════════
   O-3 of the readiness audit. Mission Control was built for a product sold one
   install per customer: the seller could reach neither the customer's app nor
   their database, so everything arrived over HTTPS from each install's own
   /api/platform/summary with a per-install key.

   That premise is gone — one app, one cluster, a database per business, and
   this panel beside them. Probing over HTTP for figures one query away is a
   control describing a world that no longer exists. */
test('the dedicated-install path is off unless a seller means it', opts, async () => {
  const keep = process.env.PANEL_DEDICATED_INSTALLS;
  delete process.env.PANEL_DEDICATED_INSTALLS;
  try {
    const cfg = await call(panelBase, 'GET', '/api/provision/config', undefined, token);
    assert.strictEqual(cfg.body.dedicated, false);
    assert.match(cfg.body.why, /customers create their own business by signing up/,
      'and says WHY, because a greyed-out control with no reason is one'
      + ' somebody spends an afternoon on');
    assert.match(cfg.body.why, /PANEL_DEDICATED_INSTALLS/, 'naming the switch');

    for (const [path, body] of [
      ['/api/installs', { name: 'X', baseUrl: 'https://x.test', platformKey: 'k'.repeat(32) }],
      ['/api/installs/provision', { name: 'X' }]
    ]) {
      const r = await call(panelBase, 'POST', path, body, token);
      assert.strictEqual(r.status, 409, path + ' refuses rather than builds');
      assert.match(r.body.error, /there is no install to provision or register by hand/,
        path + ' refuses by NAME — a 404 would read as a broken panel');
    }
  } finally {
    if (keep === undefined) delete process.env.PANEL_DEDICATED_INSTALLS;
    else process.env.PANEL_DEDICATED_INSTALLS = keep;
  }
});

test('a business is read from the registry, and its licence written to it', opts, async () => {
  const DB = require('./db');
  if (!DB.configured()) return;
  DB.secrets();       // the outlet-role secret a business database is built with

  // A registry with one business in it, made the way the app makes them.
  const keepControl = process.env.CONTROL_DB;
  const keepPrefix = process.env.BUSINESS_DB_PREFIX;
  process.env.BUSINESS_DB_PREFIX = 'kp_biz_';
  await DB.freshControl('kashikeyo_control_panel');
  const db = require('../src/db');
  const REG = require('../panel/registry');
  try {
    await require('../src/scripts/migrate').migrateControl(() => {});
    assert.strictEqual(REG.registryMode(), true,
      'the panel knows which world it is in rather than inferring it from'
      + ' whether a query happened to work');

    const made = await require('../src/business').createBusiness({ name: 'Panel Cafe' });
    const rows = await REG.overview();
    const mine = rows.find((r) => r.db === made.db_name);
    assert.ok(mine, 'the business is on the seller\'s list without anyone registering it');
    assert.strictEqual(mine.state, 'live');
    assert.strictEqual(mine.licence, null, 'and carries no licence it was never given');

    /* THE LICENCE IS ONE COPY. The old design kept the seller's registry
       authoritative and pushed a copy to the install over HTTP, reconciled on
       every dashboard load — necessary only because they were two databases
       the seller could not both reach. */
    const out = await REG.writeLicence(made.db_name,
      { kind: 'trial', trialEnds: '2026-12-31', note: 'Panel test' });
    assert.strictEqual(out.pushed, true);

    const back = await db.ownerFor(made.db_name).query(
      'SELECT kind, trial_ends, set_by FROM chain.licence WHERE id = 1');
    assert.strictEqual(back.rows[0].kind, 'trial');
    assert.strictEqual(String(back.rows[0].trial_ends).slice(0, 10), '2026-12-31',
      'written into the till\'s OWN database, which is where the countdown is read');
    assert.strictEqual(back.rows[0].set_by, 'panel');

    const again = await REG.writeLicence(made.db_name,
      { kind: 'trial', trialEnds: '2026-12-31', note: 'Panel test' });
    assert.strictEqual(again.same, true,
      'and writing the same licence again is a comparison, never a row —'
      + ' reconciling on every dashboard load must cost nothing');

    const trail = await db.ownerFor(made.db_name).query(
      "SELECT count(*)::int AS n FROM chain.audit WHERE action = 'licence_set'");
    assert.strictEqual(trail.rows[0].n, 1, 'one change, one trail row');

    /* ═══ THE SYSTEM REPORT, OUTLET BY OUTLET — AND NEVER A SALE FIGURE ════
       This is the DEVELOPER'S panel: it reads traffic, health and size, and
       a customer's takings are their own back office's to report. Provision
       a real outlet, land two sync ops and one guest order (system events),
       pair a till, put a good copy on the registry's backup shelf — then
       read it all back the way the panel does, and assert no money field
       ever appears in the answer. */
    const { provisionOutlet } = require('../src/provision');
    const made2 = await provisionOutlet({
      db: made.db_name, code: 'PNL', name: 'Panel Outlet',
      slug: 'panelusage' + String(Date.now()).slice(-6), tz: 'Indian/Maldives' });
    const own = db.ownerFor(made.db_name);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Indian/Maldives' })
      .format(new Date());
    await own.query(
      'INSERT INTO outlet_' + made2.id + '.op_log (op_id, kind, client_at)'
      + " VALUES (gen_random_uuid(), 'sale', now()),"
      + " (gen_random_uuid(), 'ticket_open', now())");
    await own.query(
      'INSERT INTO outlet_' + made2.id + '.guest_order (table_no, lines)'
      + " VALUES ('T01', '[]'::jsonb)");
    await own.query(
      'INSERT INTO chain.device (outlet_id, label, kind, paired_at, last_push_at)'
      + " VALUES ($1, 'Panel Till', 'till', now(), now())", [made2.id]);
    const bizRow = await db.control().query(
      'SELECT id FROM chain.business WHERE db_name = $1', [made.db_name]);
    const bizId = Number(bizRow.rows[0].id);
    await db.control().query(
      'INSERT INTO chain.backup (business_id, db_name, ok, finished_at, bytes)'
      + ' VALUES ($1, $2, true, now(), 12345)', [bizId, made.db_name]);

    const u = await REG.usage(bizId);
    assert.strictEqual(u.state, 'live');
    assert.strictEqual(u.outlets.length, 1, 'one outlet, reported by itself');
    const ot = u.outlets[0];
    assert.strictEqual(ot.name, 'Panel Outlet');
    assert.strictEqual(ot.ops24h, 2, 'the sync lane carried two ops today');
    assert.strictEqual(ot.ops30d, 2);
    assert.strictEqual(ot.qr24h, 1, 'and one order came through the QR portal');
    assert.strictEqual(ot.qrOrders30, 1);
    assert.strictEqual(ot.devices.writers, 1, 'the till is counted');
    assert.strictEqual(ot.devices.quiet, 0, 'and it is pushing');
    assert.strictEqual(ot.days.length, 30, 'a 30-day series, zero-filled');
    assert.strictEqual(ot.days[29].ops, 2, 'today\'s bucket carries the ops');
    assert.ok(Number(u.dbBytes) > 0, 'the database size is measured');
    assert.strictEqual(u.sessions, 0, 'nobody is signed in, and it says so');
    /* THE FENCE: no money field anywhere in the system report. A developer
       panel that grows a `net` again should fail here by name. */
    const flat = JSON.stringify(u);
    ['"net"', '"total"', '"covers"', '"avgTicket"', '"tickets"', 'currency']
      .forEach((w) => assert.ok(flat.indexOf(w) < 0,
        'the system report carries no trade field: found ' + w));

    // The read is on the business's own trail — a developer looking in is
    // never invisible, on the drill-in exactly as on the card.
    const seen = await own.query(
      "SELECT count(*)::int AS n FROM chain.audit"
      + " WHERE action = 'platform_read' AND entity = 'usage'");
    assert.strictEqual(seen.rows[0].n, 1);

    // And the card: backup shelf, schema state, traffic series — no money.
    const card = await REG.readBusiness((await db.control().query(
      'SELECT * FROM chain.business WHERE id = $1', [bizId])).rows[0]);
    assert.strictEqual(card.backup.lastOk, true, 'the last run was good');
    assert.ok(card.backup.ageHours <= 1, 'and it just finished');
    assert.strictEqual(card.behind, false,
      'a business createBusiness just migrated is at head');
    assert.strictEqual(card.days[card.days.length - 1].ops, 2,
      'the card\'s series is sync traffic');
    assert.ok(card.days.every((d) => d.net === undefined),
      'and carries no takings');

    /* Over HTTP, with the admin's own session — and as CSV, one row per
       outlet per day of TRAFFIC. */
    const viaHttp = await call(panelBase, 'GET', '/api/installs/' + bizId + '/usage',
      undefined, token);
    assert.strictEqual(viaHttp.status, 200, JSON.stringify(viaHttp.body));
    assert.strictEqual(viaHttp.body.outlets[0].ops24h, 2);
    const csv = await fetch(panelBase + '/api/installs/' + bizId + '/usage?format=csv',
      { headers: { authorization: 'Bearer ' + token } });
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const lines = (await csv.text()).trim().split('\n');
    assert.strictEqual(lines[0], 'business,outlet,date,ops,qrOrders');
    assert.strictEqual(lines.length, 31, 'a header and thirty days');
    assert.ok(lines.some((l) => l.indexOf('"Panel Outlet",' + day + ',2,1') >= 0),
      'today\'s traffic is in the file: ' + lines[lines.length - 1]);

    /* The overview carries the app's own /readyz probe — here APP_URL points
       at a host that does not exist, and the probe says so rather than
       blanking the dashboard. */
    const ov = await call(panelBase, 'GET', '/api/overview', undefined, token);
    assert.strictEqual(ov.status, 200);
    assert.ok(ov.body.appHealth, 'the overview carries the app health probe');
    assert.strictEqual(ov.body.appHealth.ok, false,
      'an unreachable app reads as down, never as silence');

    /* ═══ THE PULSE — health history, not a point-in-time probe ═══════════
       Three sweeps: up (the panel's own /readyz), down (a port nothing
       listens on), up again. The first observation records state and no
       event — a fresh process re-observes before it says anything changed —
       and each TRANSITION is one event on the timeline. Uptime in the
       overview is computed from the rows: measured, never asserted. */
    const keepApp = process.env.APP_URL;
    try {
      process.env.APP_URL = panelBase;
      await panel._sweepPulse();
      process.env.APP_URL = 'http://127.0.0.1:9';
      await panel._sweepPulse();
      process.env.APP_URL = panelBase;
      await panel._sweepPulse();
      const pu = await panel.pool.query(
        'SELECT count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS up FROM panel.pulse');
      assert.ok(pu.rows[0].n >= 3, 'every sweep is a row');
      assert.strictEqual(pu.rows[0].n - pu.rows[0].up, 1, 'one of them saw it down');
      const ev = await panel.pool.query('SELECT kind FROM panel.event ORDER BY at');
      assert.deepStrictEqual(ev.rows.map((x) => x.kind), ['app_down', 'app_recovered'],
        'transitions are events; steady states are not');
      const ov2 = await call(panelBase, 'GET', '/api/overview', undefined, token);
      assert.ok(ov2.body.uptime && ov2.body.uptime.samples >= 3,
        'uptime is measured from the pulse rows');
      assert.ok(ov2.body.uptime.d7 > 0 && ov2.body.uptime.d7 < 100,
        'and an outage shows in the figure: ' + ov2.body.uptime.d7 + '%');
      assert.strictEqual(ov2.body.events.length, 2, 'the timeline rides the overview');
    } finally {
      if (keepApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = keepApp;
    }
  } finally {
    await db.shutdown().catch(() => {});
    await DB.dropBusinessDatabases().catch(() => {});
    if (keepControl === undefined) delete process.env.CONTROL_DB;
    else process.env.CONTROL_DB = keepControl;
    if (keepPrefix === undefined) delete process.env.BUSINESS_DB_PREFIX;
    else process.env.BUSINESS_DB_PREFIX = keepPrefix;
  }
});

test('shut down cleanly', opts, async () => {
  if (panelSrv) await new Promise((r) => panelSrv.close(r));
  if (siteSrv) await new Promise((r) => siteSrv.close(r));
  if (panel) await panel.pool.end();
  if (site) await site.pool.end();
});
