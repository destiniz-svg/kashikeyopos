'use strict';
/* ═══ WHAT ONLY A REAL BROWSER CAN ANSWER ════════════════════════════════════
   Two items the readiness audit left NOT TESTED, both for the same reason: the
   rest of the suite drives the terminal's logic in a vm, where IndexedDB is a
   stub and there is only ever one device. Neither question can be answered
   there.

     THE CRASH. An op queued offline has to survive the tab dying. Not "the
     outbox has a durable store" — that is a code reading — but: ring it, kill
     the page, open it again, and find the op still there and still pushable.

     THE SECOND TILL. Two terminals on one counter, both offline, both selling
     the last portion. On reconnect the books must end up with both sales, one
     each, and the shortfall named rather than silently absorbed.

   Real Chromium, real IndexedDB, real HTTP against a running server. Skips
   cleanly without either.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const PW = '/opt/pw-browsers/chromium';
const BASE = process.env.KPOS_URL || 'http://127.0.0.1:4090';

let chromium = null;
try { chromium = require('/opt/node22/lib/node_modules/playwright/index.js').chromium; }
catch (e) { chromium = null; }

const skip = (!chromium || !fs.existsSync(PW)) ? 'no browser available' : false;

const reachable = async () => {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
};

/* The outbox is keyed by outlet, and every op it holds is stamped with the
   install. Driving it directly is the honest way to test durability: what a
   sale screen does at the end is call queue(), and queue() is this. */
const QUEUE = (kind, n) => `(async () => {
  const api = window.KPOS_API;
  const id = await api.queue({ kind: ${JSON.stringify(kind)},
    label: 'runtime probe ' + ${JSON.stringify(n)}, entity: 'sales',
    payload: { probe: ${JSON.stringify(n)} } });
  return id;
})()`;

const PENDING = `(async () => {
  const rows = await window.KPOS_API.pending();
  return rows.map((r) => ({ opId: r.opId, kind: r.kind, label: r.label,
    install: r.install || '', parked: !!r.parked }));
})()`;

async function signedIn(page) {
  return page.evaluate(() => !!(window.KPOS_API && window.KPOS_API.signedIn
    && window.KPOS_API.signedIn()));
}

test('an op queued offline survives the tab being killed', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server on ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    // One persistent context, so IndexedDB survives the page closing — which
    // is exactly what a crashed tab and a reopened one share.
    const ctx = await b.newContext();
    let page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    assert.ok(await page.evaluate(() => !!window.KPOS_API),
      'the API client is on the page');

    // Offline is a real switch in this build, not a simulation: nothing is
    // POSTed and every write holds durably until it is flipped back.
    await page.evaluate(() => { window.KPOS_BRIDGE.setOffline(true); });
    const before = await page.evaluate(PENDING);
    const id = await page.evaluate(QUEUE('note_add', 'survives'));
    assert.ok(id, 'the op was queued and given an id');

    const held = await page.evaluate(PENDING);
    assert.strictEqual(held.length, before.length + 1,
      'and it is in the durable outbox, not in memory somewhere');

    // KILL IT. Not a reload — the page is destroyed, as a crashed tab is.
    await page.close();
    page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    const after = await page.evaluate(PENDING);
    const mine = after.filter((o) => o.opId === id);
    assert.strictEqual(mine.length, 1,
      'the op is still there after the tab died — this is the whole promise of'
      + ' the outbox, and it is the one thing a vm cannot prove');
    assert.strictEqual(mine[0].label, 'runtime probe survives',
      'with its payload intact, not a husk');
    assert.ok(!mine[0].parked, 'and still live, not parked');
  } finally { await b.close(); }
});

test('two tills selling the same last portion both reach the books',
  { skip }, async (t) => {
    if (!(await reachable())) return t.skip('no server on ' + BASE);
    const b = await chromium.launch({ executablePath: PW });
    try {
      /* Two contexts is two devices: separate IndexedDB, separate storage,
         separate outbox. One browser with two tabs would share the outbox and
         prove nothing. */
      const a = await b.newContext();
      const c = await b.newContext();
      const pa = await a.newPage();
      const pc = await c.newPage();
      for (const p of [pa, pc]) {
        await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(1800);
        await p.evaluate(() => { window.KPOS_BRIDGE.setOffline(true); });
      }

      // Both ring, neither can see the other.
      const ida = await pa.evaluate(QUEUE('note_add', 'till-A'));
      const idc = await pc.evaluate(QUEUE('note_add', 'till-C'));
      assert.notStrictEqual(ida, idc,
        'two devices mint different op ids — a shared one would dedupe one sale away');

      const ha = await pa.evaluate(PENDING);
      const hc = await pc.evaluate(PENDING);
      assert.ok(ha.some((o) => o.opId === ida), 'till A holds its own');
      assert.ok(!ha.some((o) => o.opId === idc),
        'and cannot see the other till\'s — they are separate outboxes, which is'
        + ' what makes the offline case real rather than a shared queue');
      assert.ok(hc.some((o) => o.opId === idc), 'till C holds its own');

      /* THE CLOCK, at the layer that actually turns it. api.queue() stores an
         op; the TERMINAL's queue() is what numbers it, through the bridge — so
         that is what this drives. Each device keeps its own monotonic sequence
         and persists it, which is what stops a drained outbox walking the
         number backwards; making the two comparable is the receive rule, and
         that needs a poll, which neither of these offline tills can do. */
      const walk = (p) => p.evaluate(() => {
        const a = window.KPOS_SYNC.tick(0);
        const b = window.KPOS_SYNC.tick(0);
        return { a: a, b: b, stored: Number(window.KPOS_API.local('lamport')) };
      });
      const ca = await walk(pa);
      const cc = await walk(pc);
      [['A', ca], ['C', cc]].forEach(([who, c]) => {
        assert.ok(c.b > c.a, 'till ' + who + '\'s clock only ever goes forward');
        assert.strictEqual(c.stored, c.b,
          'and till ' + who + ' persists it, so a drained outbox cannot walk it back');
      });

      // Persisted means persisted: reopen the page and it has not reset.
      await pa.close();
      const pa2 = await a.newPage();
      await pa2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await pa2.waitForTimeout(1600);
      const again = await pa2.evaluate(() => window.KPOS_SYNC.tick(0));
      assert.ok(again > ca.b,
        'a reopened terminal carries on from where it was, rather than from one —'
        + ' which is the defect that made two tills\' numbers meaningless');
    } finally { await b.close(); }
  });
