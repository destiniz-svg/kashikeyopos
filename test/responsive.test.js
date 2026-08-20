'use strict';
/* ═══ THREE WIDTHS, MEASURED ════════════════════════════════════════════════
   390 · 924 · 1440. Asserted MECHANICALLY, not by eye — the reference's own
   layout bugs were all of this shape: a shared style key made the top bar
   stack into four rows, and a wrapped flex line silently left-aligned the
   identity chip under the page title. Both were invisible to a feature test
   and obvious to a measurement.

   Needs a browser and a running server. Skips cleanly without them, so the
   unit suite still runs anywhere.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const PW = '/opt/pw-browsers/chromium';
const BASE = process.env.KPOS_URL || 'http://127.0.0.1:4090';
const PIN = process.env.KPOS_PIN || '';

let chromium = null;
try { chromium = require('/opt/node22/lib/node_modules/playwright/index.js').chromium; }
catch (e) { chromium = null; }

const reachable = async () => {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
};

const WIDTHS = [
  [390, 780, 'phone'],
  [924, 900, 'tablet'],
  [1440, 900, 'desktop']
];

const skip = (!chromium || !fs.existsSync(PW)) ? 'no browser available' : false;

test('the shell holds its shape at 390, 924 and 1440', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server at ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    for (const [w, h, name] of WIDTHS) {
      const p = await b.newPage({ viewport: { width: w, height: h } });
      await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2600);
      if (PIN) {
        for (const d of PIN) { await p.keyboard.press(d); await p.waitForTimeout(90); }
        await p.waitForTimeout(2600);
      }

      const m = await p.evaluate(() => {
        // The top bar is the row that holds the page title.
        const titles = [...document.querySelectorAll('div,h1,h2')]
          .filter((e) => /^(POS Floor|Owner Dashboard|Start|Settings)/.test(e.textContent.trim())
            && e.getBoundingClientRect().top < 90);
        const title = titles[0];
        if (!title) return { noBar: true };
        let bar = title;
        for (let i = 0; i < 6 && bar.parentElement; i++) {
          bar = bar.parentElement;
          const r = bar.getBoundingClientRect();
          if (r.width > window.innerWidth * 0.6 && r.top < 40) break;
        }
        const br = bar.getBoundingClientRect();
        const kids = [...bar.children].map((c) => {
          const r = c.getBoundingClientRect();
          return { x: r.x, right: r.right, w: r.width, h: r.height, top: r.top,
            text: c.textContent.trim().slice(0, 24) };
        }).filter((k) => k.w > 0 && k.h > 0);

        /* Content escaping its box. An element that SCROLLS (a sub-tab strip)
           or CLIPS (an ellipsised label) is handling its own overflow and is
           not a fault — the fault is content that spills where neither was
           asked for. A long merchant name in a narrow rail is supposed to end
           in an ellipsis; that is the design, not a break. */
        const overflow = [...document.querySelectorAll('*')].filter((e) => {
          const s = getComputedStyle(e);
          if (/auto|scroll|hidden|clip/.test(s.overflowX)) return false;
          if (s.textOverflow === 'ellipsis') return false;
          return e.scrollWidth - e.clientWidth > 2 && e.clientWidth > 60;
        }).slice(0, 6).map((e) => (e.className || e.tagName) + ' '
          + e.scrollWidth + '>' + e.clientWidth + ' "'
          + e.textContent.trim().slice(0, 30) + '"');

        // Tap targets on a phone.
        const small = window.innerWidth > 500 ? [] :
          [...document.querySelectorAll('button, [role="button"], input, select')]
            .filter((e) => {
              if (!e.offsetParent) return false;
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && Math.min(r.width, r.height) < 40;
            }).slice(0, 10).map((e) => {
              const r = e.getBoundingClientRect();
              return (e.textContent.trim().slice(0, 18) || e.getAttribute('title')
                || e.getAttribute('placeholder') || e.tagName)
                + ' [' + Math.round(r.width) + '\u00d7' + Math.round(r.height) + ']';
            });

        /* "One row" is not "every child has the same top" — a bar aligns its
           children on their centres and they are different heights. It is that
           the bar is no TALLER than its tallest child plus its own padding: a
           wrap adds a whole row. */
        const tallest = Math.max.apply(null, kids.map((k) => k.h).concat([0]));
        const span = Math.max.apply(null, kids.map((k) => k.top + k.h))
          - Math.min.apply(null, kids.map((k) => k.top));

        return {
          barHeight: br.height,
          barRows: span > tallest + 6 ? 2 : 1,
          span: span, tallest: tallest,
          kids: kids,
          docScrollX: document.documentElement.scrollWidth > window.innerWidth + 2,
          overflow: overflow,
          small: small
        };
      });

      await p.close();
      if (m.noBar) continue;

      // The top bar NEVER wraps at any width.
      assert.strictEqual(m.barRows, 1,
        name + ' (' + w + '): the top bar wrapped — its children span '
        + Math.round(m.span) + 'px against a tallest child of '
        + Math.round(m.tallest) + 'px: ' + JSON.stringify(m.kids.map((k) => k.text)));
      assert.ok(m.barHeight < 90,
        name + ': the top bar is ' + Math.round(m.barHeight) + 'px, more than one row');

      // The page itself never scrolls sideways.
      assert.strictEqual(m.docScrollX, false, name + ': the page scrolls horizontally');
      assert.deepStrictEqual(m.overflow, [],
        name + ': content overflows its container — ' + m.overflow.join(', '));

      // Phone tap targets.
      if (w <= 500) {
        assert.deepStrictEqual(m.small, [],
          'phone: these are under 40px on their shorter axis — ' + m.small.join(', '));
      }
    }
  } finally {
    await b.close();
  }
});

test('the identity control is the last thing in the bar, at every width', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server at ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    for (const [w, h, name] of WIDTHS) {
      const p = await b.newPage({ viewport: { width: w, height: h } });
      await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2600);
      const ok = await p.evaluate(() => {
        // The identity control carries the rank pip; find it by that, then ask
        // whether it is the LAST CHILD OF THE BAR — not the rightmost thing on
        // the page, which at phone width includes the ribbon underneath.
        const cand = [...document.querySelectorAll('button, div')]
          .filter((e) => e.getBoundingClientRect().top < 70
            && /OWNER|ADMIN|MANAGER|CASHIER|KITCHEN|LOCKED/i.test(e.textContent)
            && e.textContent.length < 90);
        if (!cand.length) return { none: true };
        const me = cand[cand.length - 1];
        // Walk up to the child of the bar that contains it.
        let node = me, bar = me.parentElement;
        while (bar && bar.getBoundingClientRect().width < window.innerWidth * 0.6) {
          node = bar; bar = bar.parentElement;
        }
        if (!bar) return { none: true };
        const kids = [...bar.children].filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        return {
          none: false,
          isLast: kids[kids.length - 1] === node,
          mine: node.getBoundingClientRect().right,
          max: Math.max.apply(null, kids.map((c) => c.getBoundingClientRect().right))
        };
      });
      await p.close();
      if (ok.none) continue;
      // The law, as the test plan states it: the identity control's right edge
      // is the greatest of the bar's children. Whether the DOM wraps it in one
      // more div is not the point — where it lands on screen is.
      assert.ok(ok.mine >= ok.max - 2,
        name + ': the identity control is not the last item in the bar ('
        + Math.round(ok.mine) + ' vs ' + Math.round(ok.max) + ')');
    }
  } finally {
    await b.close();
  }
});

test('the onboarding panel works on a phone', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server at ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    const p = await b.newPage({ viewport: { width: 390, height: 780 } });
    await p.goto(BASE + '/onboarding', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    const m = await p.evaluate(() => ({
      // A finished install sends you to the floor rather than back through the
      // wizard, so this measures the panel only when the panel is what is on
      // screen.
      onPanel: !!document.getElementById('stage') && location.pathname === '/onboarding',
      scrollX: document.documentElement.scrollWidth > window.innerWidth + 2,
      small: [...document.querySelectorAll('#stage button, #stage input, #stage select')]
        .filter((e) => e.offsetParent && Math.min(
          e.getBoundingClientRect().width, e.getBoundingClientRect().height) < 36)
        .slice(0, 6).map((e) => e.textContent.trim().slice(0, 18))
    }));
    await p.close();
    if (!m.onPanel) return t.skip('this install is already set up');
    assert.strictEqual(m.scrollX, false, 'the panel scrolls sideways on a phone');
    assert.deepStrictEqual(m.small, [], 'controls under 36px: ' + m.small.join(', '));
  } finally {
    await b.close();
  }
});
