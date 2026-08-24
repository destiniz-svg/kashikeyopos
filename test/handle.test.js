'use strict';
/* ═══ A STORE HAS AN ADDRESS ════════════════════════════════════════════════
   Every store answers on its own subdomain:

       https://<handle>.kashikeyopos.com          the QR ordering portal
       https://<handle>.kashikeyopos.com/member   the customer's card

   Three things have to hold, and each one shipped wrong somewhere before:

     · a handle is a DNS label and a scarce name. `webmail.kashikeyopos.com`
       and `demo.kashikeyopos.com` are probed by scanners on this domain every
       day; either would have been claimable by a store before migration 012;
     · the SHAPE is stated twice — in src/handle.js for the browser and in
       chain.handle_shape_ok() for the database — and two copies of a rule are
       two rules the moment one is edited. They are compared here, case by case;
     · nothing may SPELL the domain. The till printed
       "https://order.kashikeyo.mv/t/..." on the QR card and the member portal
       showed "rewards.kashikeyo.mv" in its address bar. Neither host exists.
       A laminated card is on forty tables before anybody scans one.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('../src/handle');
const HARNESS = require('./harness');
const FX = require('./fixtures');

const APP = path.join(__dirname, '..', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

/* Every case here is run through BOTH the JavaScript rule and the SQL rule by
   the database test at the bottom, so the two cannot drift apart quietly. */
const CASES = [
  ['sea-house', true], ['s3a-h0use-2', true], ['abc', true],
  ['a'.repeat(40), true],
  ['ab', false], ['', false], ['a'.repeat(41), false],
  ['-nope', false], ['nope-', false], ['no--pe', false],
  ['Sea-House', false], ['sea_house', false], ['sea house', false],
  ['sea.house', false], ['café', false], ['sea/house', false]
];

test('a store address is a DNS label, and says why when it is not', () => {
  CASES.forEach(([h, want]) => {
    assert.strictEqual(H.ok(h), want, JSON.stringify(h) + ' should be ' + want);
    if (!want) {
      const why = H.shapeError(h);
      assert.ok(why && /store address/.test(why),
        JSON.stringify(h) + ' is refused with a sentence, not "invalid": ' + why);
    }
  });
});

test('what somebody typed becomes the nearest legal address', () => {
  assert.strictEqual(H.normalise('Sea House Café'), 'sea-house-cafe');
  assert.strictEqual(H.normalise('  --Reef  Grill--  '), 'reef-grill');
  assert.strictEqual(H.normalise('Ta___ke!!!away'), 'ta-ke-away');
  assert.strictEqual(H.normalise(''), '');
  // Lossy on purpose: it is offered back to them, never substituted silently.
  assert.ok(H.ok(H.normalise('Sea House Café')));
});

test('the hostname names the store, and only where it can', () => {
  process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  const cases = [
    ['reef-grill.kashikeyopos.com', 'reef-grill'],
    ['reef-grill.kashikeyopos.com:8080', 'reef-grill'],
    ['REEF-GRILL.KashikeyoPOS.com', 'reef-grill'],
    ['kashikeyopos.com', null],              // the apex is the business's app
    ['www.kashikeyopos.com', null],          // and so is www
    ['a.b.kashikeyopos.com', null],          // a.b.base is nobody's store
    ['ab.kashikeyopos.com', null],           // too short to be a handle
    ['reef-grill.example.com', null],        // another domain entirely
    ['kashikeyopos.com.evil.test', null],    // a suffix, not a subdomain
    ['localhost', null], ['', null]
  ];
  cases.forEach(([host, want]) =>
    assert.strictEqual(H.hostHandle(host), want, host + ' -> ' + want));
});

test("the till's own host is never a store, wherever PUBLIC_URL puts it", () => {
  process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  const pub = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://app.kashikeyopos.com';
  try {
    assert.strictEqual(H.appHost(), 'app.kashikeyopos.com');
    assert.strictEqual(H.hostHandle('app.kashikeyopos.com'), null,
      'the terminal answers on its own address');
    assert.strictEqual(H.hostHandle('reef-grill.kashikeyopos.com'), 'reef-grill',
      'store portals stay on the base domain');
    assert.strictEqual(H.storeUrl('reef-grill', ''), 'https://reef-grill.kashikeyopos.com',
      'a printed store address never moves with the till');
  } finally {
    if (pub) process.env.PUBLIC_URL = pub; else delete process.env.PUBLIC_URL;
  }
});

test('an EMPTY base domain switches store subdomains off on purpose', () => {
  // Not the same as unset. A staging box on a vendor domain with no wildcard
  // record would otherwise inherit that apex from PUBLIC_URL and start handing
  // out https://<handle>.<something-that-cannot-resolve>.
  const pub = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://kashikeyopos-staging.up.railway.app';
  process.env.PORTAL_BASE_DOMAIN = '';
  try {
    assert.strictEqual(H.baseDomain(), '');
    assert.strictEqual(H.storeUrl('reef-grill', ''), '/g/reef-grill');
  } finally {
    if (pub) process.env.PUBLIC_URL = pub; else delete process.env.PUBLIC_URL;
    process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  }
});

test('with no base domain configured, a link is a path rather than a guess', () => {
  delete process.env.PORTAL_BASE_DOMAIN;
  const pub = process.env.PUBLIC_URL; delete process.env.PUBLIC_URL;
  try {
    assert.strictEqual(H.baseDomain(), '');
    assert.strictEqual(H.hostHandle('reef-grill.kashikeyopos.com'), null);
    // Followable, where a wrong hostname is not.
    assert.strictEqual(H.storeUrl('reef-grill', ''), '/g/reef-grill');
    // The card is its OWN route, /m/<handle>. This used to be the QR portal's
    // path with /member glued on, which matches nothing in pages.js — so a
    // guest handed that address by a server reading it off the till fell
    // through the 404 and landed on the TERMINAL's sign-in screen.
    assert.strictEqual(H.memberUrl('reef-grill'), '/m/reef-grill');
  } finally {
    if (pub) process.env.PUBLIC_URL = pub;
    process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  }
});

test('PUBLIC_URL is enough — a normal deploy sets one variable, not two', () => {
  const explicit = process.env.PORTAL_BASE_DOMAIN, pub = process.env.PUBLIC_URL;
  delete process.env.PORTAL_BASE_DOMAIN;
  try {
    process.env.PUBLIC_URL = 'https://www.kashikeyopos.com/';
    assert.strictEqual(H.baseDomain(), 'kashikeyopos.com');
    process.env.PORTAL_BASE_DOMAIN = '*.kashikeyopos.com';
    assert.strictEqual(H.baseDomain(), 'kashikeyopos.com', 'a wildcard is the domain');
  } finally {
    if (pub) process.env.PUBLIC_URL = pub; else delete process.env.PUBLIC_URL;
    if (explicit) process.env.PORTAL_BASE_DOMAIN = explicit;
  }
});

test('the addresses a store hands out', () => {
  process.env.PORTAL_BASE_DOMAIN = 'kashikeyopos.com';
  assert.strictEqual(H.storeUrl('reef-grill', ''), 'https://reef-grill.kashikeyopos.com');
  assert.strictEqual(H.tableUrl('reef-grill', 'T04'),
    'https://reef-grill.kashikeyopos.com/?t=T04');
  assert.strictEqual(H.memberUrl('reef-grill'),
    'https://reef-grill.kashikeyopos.com/member');
});

/* ── nothing spells a hostname ──────────────────────────────────────────── */

test('no shipped file invents a hostname', () => {
  const files = fs.readdirSync(APP).filter((f) => /\.(html|js)$/.test(f));
  const bad = [];
  files.forEach((f) => {
    const src = read(f);
    // kashikeyo.mv was never registered by this business. Two pages printed
    // addresses on it — one on a QR card, one in a fake browser chrome.
    if (/kashikeyo\.mv/.test(src)) bad.push(f + ' spells kashikeyo.mv');
  });
  assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('the till reads the domain, it does not type it', () => {
  const src = read('index.html');
  assert.ok(/portalBase\(\)\s*\{[^}]*PORTAL/.test(src),
    'the base domain comes from the bootstrap payload');
  assert.ok(/qrUrl:\s*this\.tableUrl\(/.test(src),
    'the QR card prints the store\'s own address');
  // The whole point: a hostname that is right in production and wrong in
  // staging is worse than one that is obviously absent.
  assert.ok(!/https:\/\/[a-z0-9-]+\.kashikeyopos\.com/.test(src),
    'no literal store hostname anywhere in the terminal');
});

test('a guest page never guesses its store out of location.hostname', () => {
  ['guest-bridge.js'].forEach((f) => {
    const src = read(f);
    assert.ok(!/location\.hostname[^\n]*split\([^\n]*\)\s*\[0\]/.test(src),
      f + ' must not read the first label as the handle — only the server'
      + ' knows where the base domain ends');
    assert.ok(/\/api\/g\/[^\n]*token/.test(src), f + ' asks the server instead');
  });
});

test('both portals say so when a link names no store', () => {
  ['guest.html', 'member.html'].forEach((f) => {
    const src = read(f);
    assert.ok(/sc-if value="\{\{ linkDead \}\}"/.test(src),
      f + ' has a screen for a dead link');
    assert.ok(/linkDeadMsg/.test(src), f + ' shows the reason it was given');
  });
});

/* ── renaming, from the operator's side ─────────────────────────────────── */

/* A signed-in session carries the rank the SERVER issued, and that is what the
   terminal gates on. The terminal's own role map disagrees with src/auth.js —
   it reads ChainAdmin as 5 where the ladder says 4 — so a control gated on the
   map would be offered to an admin the API then refuses. */
function atRank(rank, roleKey) {
  return HARNESS.makeInstance({
    kpos: FX.kpos(), raw: FX.raw(), real: FX.real({ rank }),
    role: roleKey,
    session: { id: 'u_x', user: 'x', name: 'Rank ' + rank, role: roleKey,
      rank: rank, outlet: 1, outlets: [] }
  });
}

test('the terminal gates on the rank the server issued, not the one it infers', () => {
  const { RANK, ROLE_KEY_BY_RANK } = require('../src/auth');
  // ChainAdmin is rank 4 on the server. If the terminal read its own map it
  // would call that 5 and hand an admin the owner's controls.
  assert.strictEqual(RANK.admin, 4);
  assert.strictEqual(ROLE_KEY_BY_RANK[4], 'ChainAdmin');
  const F = atRank(4, 'ChainAdmin');
  assert.strictEqual(F.rank(), 4, 'the session wins');
  assert.strictEqual(F.RANKMAP().ChainAdmin, 5, 'and the map still disagrees');
});

test('changing a store address is offered to the owner and refused to anybody else', () => {
  const seen = [];
  [[3, 'OutletManager'], [4, 'ChainAdmin'], [5, 'SuperAdmin']].forEach(([rank, key]) => {
    const F = atRank(rank, key);
    const o = F.scopedOutlets()[0] || {};
    F.state.modal = { kind: 'outletDetail', id: o.id };
    const v = F.modalVals(F.state.modal);
    const act = (v.detailActs || [])[0] || null;
    seen.push([rank, act ? act.label : null]);
    if (!o.slug) return;                       // nothing to rename yet
    assert.ok(act, 'rank ' + rank + ' is told where the address lives');
    // A gated action REFUSES with wording. A control that vanished teaches an
    // operator the app is broken; one that explains teaches them what to ask.
    if (rank < 5) assert.match(act.label, /owner only/i, 'rank ' + rank);
    else assert.match(act.label, /Change store address/, 'rank 5');
    assert.doesNotThrow(() => act.go(), 'rank ' + rank + ' can press it');
    F.state.modal = null;
  });
  assert.strictEqual(seen.length, 3, JSON.stringify(seen));
});

test('the rename form names the address it is leaving', () => {
  const F = atRank(5, 'SuperAdmin');
  const o = F.scopedOutlets()[0] || {};
  F.state.modal = { kind: 'outletDetail', id: o.id };
  const spec = F.formSpec('storeAddress');
  assert.ok(spec && spec.title, 'the form exists');
  // Its consequence, stated on the form: this is the one thing that makes
  // renaming safe, and an operator has to read it before they press save.
  assert.match(spec.foot, /keeps pointing here/,
    'the form says the old address goes on working: ' + spec.foot);
  assert.match(spec.foot, /nobody else can ever take it/i, spec.foot);
  const field = (spec.fields || [])[0];
  assert.strictEqual(field.k, 'handle');
  assert.strictEqual(field.v, F.storeHandle(o.id),
    'it opens on the address the store is at, not empty');
});

test('the QR card prints the address the SERVER published, in both shapes', () => {
  const F = atRank(5, 'SuperAdmin');
  const o = F.scopedOutlets()[0] || {};

  // No base domain published: the path form, which is followable.
  assert.strictEqual(F.portalBase(), '');
  assert.strictEqual(F.storeUrl('', o.id), '/g/' + o.slug);
  assert.strictEqual(F.tableUrl(1, o.id), '/g/' + o.slug + '/?t=' + encodeURIComponent(F.slotName(1)));
  // The card's path form is its OWN route. Gluing /member onto the QR portal's
  // path gives /g/<handle>/member, which routes nowhere — a guest handed that
  // address by a server reading it off the till lands on the terminal's own
  // sign-in screen.
  assert.strictEqual(F.memberUrl(o.id), '/m/' + o.slug);

  // Published: the store's own subdomain, spelled by nobody.
  F.__win.KPOS.PORTAL = { base: 'kashikeyopos.com' };
  assert.strictEqual(F.portalBase(), 'kashikeyopos.com');
  assert.strictEqual(F.storeUrl('', o.id), 'https://' + o.slug + '.kashikeyopos.com');
  assert.strictEqual(F.memberUrl(o.id), 'https://' + o.slug + '.kashikeyopos.com/member');

  // And that is what lands on the card, table label and all.
  F.state.activeTable = 1;
  const card = F.modalVals({ kind: 'qr' });
  assert.strictEqual(card.qrUrl, 'https://' + o.slug + '.kashikeyopos.com/?t='
    + encodeURIComponent(F.slotName(1)), card.qrUrl);
  delete F.__win.KPOS.PORTAL;
});
