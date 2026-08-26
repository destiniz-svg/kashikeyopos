'use strict';
/* ═══ THE ROAD A CUSTOMER WALKS, IN A BROWSER ════════════════════════════════
   test/e2e.test.js already walks signup → verify → business → onboarding, and
   it walks it over HTTP with the headers written by hand. That is the right
   test for the server and it is blind to the one thing that broke here: the
   PAGE forgetting a header the test remembered.

   What shipped: `api()` in app/account.html attached the account token only
   where a caller passed it, and exactly one caller did (`/me`). So
   `POST /api/account/business` — the call made the instant a code verifies, to
   create the business the account is about to onboard into — went out with no
   credential and was refused "sign in again".

   Every new customer hit it, at the moment they finished typing the six
   digits. And it reads as the CODE being rejected, because that is the last
   thing they did: the code worked, and the request after it had no
   credential. Reported as "receives the OTP, but it says the OTP does not
   match" — which is what a defect one call further on looks like from the
   outside.

   So this drives the shipped page in real Chromium and asserts the customer
   arrives at step one of onboarding. No unit test of `api()` would have caught
   it; the header is only missing when nobody passes one.

   Needs the dev echo (ACCOUNT_CODE_ECHO=1) so the code can be read off the
   screen instead of out of an inbox. CI sets it; the harness sets it.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const PW = process.env.KPOS_PW_CHROMIUM || '/opt/pw-browsers/chromium';
const PW_MODULE = process.env.KPOS_PW_MODULE
  || '/opt/node22/lib/node_modules/playwright/index.js';
const BASE = process.env.KPOS_URL || 'http://127.0.0.1:4090';

let chromium = null;
try { chromium = require(PW_MODULE).chromium; }
catch (e) { chromium = null; }

const { browserSkip, needServer } = require('./browser');
const skip = browserSkip(!!chromium, PW, fs);

const reachable = async () => {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
};

/* The echo is a development-only convenience and the reason this suite can run
   at all. Without it the code exists only in an inbox and on the audit trail,
   and neither is something a browser test may reach into. */
const echoing = async () => {
  try {
    const r = await fetch(BASE + '/api/account/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'echo-probe-' + Date.now() + '@example.mv' })
    });
    return !!(await r.json()).code;
  } catch (e) { return false; }
};

test('a new customer gets from the sign-up form to step one', { skip }, async (t) => {
  if (!needServer(t, await reachable(), BASE)) return;
  if (!(await echoing())) {
    // Not a skip that hides anything: without the echo there is no code to
    // type, so the walk cannot be driven at all. Say which variable.
    return needServer(t, false, BASE + ' (ACCOUNT_CODE_ECHO=1 is not set)');
  }

  const b = await chromium.launch({ executablePath: PW });
  try {
    const p = await (await b.newContext()).newPage();
    const posts = [];
    p.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/account')) {
        posts.push({ path: r.url().replace(BASE, ''),
          auth: !!(r.headers().authorization || '') });
      }
    });

    await p.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#email');
    await p.fill('#email', 'walk-' + Date.now() + '@example.mv');
    await p.fill('#bizName', 'The Walk Cafe');
    await p.click('#submit');

    await p.waitForFunction(
      () => document.getElementById('codeWrap').style.display === 'block',
      null, { timeout: 20000 });

    const code = ((await p.evaluate(
      () => document.getElementById('msg').textContent)).match(/\b(\d{6})\b/) || [])[1];
    assert.ok(code, 'the development echo put a six-digit code on the screen');

    // Typed the way a person types it, one box at a time — the six inputs and
    // the hidden field they sync into are part of what is under test.
    await p.evaluate(() => {
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].forEach(
        (d) => { document.getElementById(d).value = ''; });
      document.getElementById('code').value = '';
    });
    await p.click('#d1');
    for (const ch of code) await p.keyboard.type(ch);

    /* THE WHOLE POINT. Not "verify answered 200" — the customer has to LAND
       somewhere they can work. Onboarding step one is that place. */
    await p.waitForURL(/\/onboarding/, { timeout: 20000 });
    // The URL is the navigation; the heading is the panel having actually come
    // up. Waiting for the text rather than reading it once is the difference
    // between testing the app and testing how fast this box is today.
    await p.waitForFunction(
      () => /\S/.test((document.querySelector('h1, h2') || {}).textContent || ''),
      null, { timeout: 20000 });
    const heading = await p.evaluate(
      () => (document.querySelector('h1, h2') || {}).textContent || '');
    assert.match(heading, /Who is trading\?/,
      'and on step one of the panel, not on a page that asks them to sign in again');

    const business = posts.find((x) => x.path === '/api/account/business');
    assert.ok(business, 'the business the account will onboard into was created');
    assert.ok(business.auth,
      'and that call carried the account token — it is the request made the'
      + ' instant a code verifies, and going out bare is what made a working'
      + ' sign-in read as a rejected code');
  } finally { await b.close(); }
});

/* AND THE PATH EVERY CUSTOMER CAUGHT BY THAT DEFECT IS NOW ON.

   Their account verified — the code always worked — and no business was ever
   created, so they come back to a verified account that owns nothing. The page
   handled that by dropping into SIGN UP mode and asking for the business name
   on the create-account form, which means the next press posts /signup, issues
   a SECOND code, and walks them through the six boxes again to learn one word.

   Somebody who has just proved who they are should not be asked to prove it
   twice. One question, one answer, straight to step one. */
test('a verified account with no business is asked one thing, not asked again', { skip }, async (t) => {
  if (!needServer(t, await reachable(), BASE)) return;
  if (!(await echoing())) return needServer(t, false, BASE + ' (ACCOUNT_CODE_ECHO=1 is not set)');

  const addr = 'stranded-' + Date.now() + '@example.mv';
  const post = async (path, body) => (await fetch(BASE + '/api/account' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })).json();

  // Put an account in exactly that state: verified, owning nothing.
  const up = await post('/signup', { email: addr, name: 'Stranded' });
  const v = await post('/code/verify', { email: addr, code: up.code });
  assert.strictEqual(v.account.verified, true);
  assert.strictEqual(v.businesses.length, 0, 'verified, and owning nothing');

  const b = await chromium.launch({ executablePath: PW });
  try {
    const p = await (await b.newContext()).newPage();
    const posts = [];
    p.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/account')) {
        posts.push(r.url().replace(BASE, '').replace('/api/account', ''));
      }
    });

    await p.goto(BASE + '/account', { waitUntil: 'domcontentloaded' });
    await p.click('#segSignin');
    await p.fill('#email', addr);
    await p.click('#submit');                        // blank password asks for a code
    await p.waitForFunction(
      () => document.getElementById('codeWrap').style.display === 'block',
      null, { timeout: 20000 });

    const code = ((await p.evaluate(
      () => document.getElementById('msg').textContent)).match(/\b(\d{6})\b/) || [])[1];
    assert.ok(code, 'a code was issued');
    await p.evaluate(() => {
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].forEach(
        (d) => { document.getElementById(d).value = ''; });
      document.getElementById('code').value = '';
    });
    await p.click('#d1');
    for (const ch of code) await p.keyboard.type(ch);

    await p.waitForFunction(
      () => (document.getElementById('title') || {}).textContent === 'One more thing',
      null, { timeout: 20000 });
    await p.fill('#bizName', 'The Stranded Cafe');
    await p.click('#submit');

    await p.waitForURL(/\/onboarding/, { timeout: 20000 });
    await p.waitForFunction(
      () => /\S/.test((document.querySelector('h1, h2') || {}).textContent || ''),
      null, { timeout: 20000 });

    assert.deepStrictEqual(posts, ['/code', '/code/verify', '/business'],
      'one code, one verification, one business — not a second trip through'
      + ' the six boxes to learn the name of a shop');
  } finally { await b.close(); }
});
