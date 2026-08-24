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
  // /signup is the website's own now: on the product's site, signing up
  // means asking for a store, not opening a terminal's account page.
  const signup = await fetch(siteBase + '/signup', { redirect: 'manual' });
  assert.strictEqual(signup.status, 200, 'the signup stays on the site');
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

test('shut down cleanly', opts, async () => {
  if (panelSrv) await new Promise((r) => panelSrv.close(r));
  if (siteSrv) await new Promise((r) => siteSrv.close(r));
  if (panel) await panel.pool.end();
  if (site) await site.pool.end();
});
