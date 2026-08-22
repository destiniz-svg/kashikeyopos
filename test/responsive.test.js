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
          .filter((e) => {
            const r = e.getBoundingClientRect();
            // Zero-sized candidates are off-screen furniture — the onboarding
            // panel's hidden rail matches the rank words too, and picking one
            // failed this test against an install that was simply not set up
            // yet rather than against a bar that had actually broken.
            if (r.width < 1 || r.height < 1) return false;
            return r.top < 70
              && /OWNER|ADMIN|MANAGER|CASHIER|KITCHEN|LOCKED/i.test(e.textContent)
              && e.textContent.length < 90;
          });
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
      // getClientRects(), not offsetParent: a position:fixed element has NO
      // offsetParent, so the moment the action bar was pinned to the bottom of
      // the phone the primary button stopped being measured at all. The one
      // control that must never be too small was the one this stopped checking.
      small: [...document.querySelectorAll('#stage button, #stage input, #stage select')]
        .filter((e) => e.getClientRects().length && Math.min(
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

/* ═══ THE PANEL MUST SCROLL ═════════════════════════════════════════════════
   This is a STATIC check on purpose. The browser test above skips whenever the
   install it is pointed at has already been set up — which is most of the time
   — and that is exactly how this shipped:

     kashikeyo.css locks the document down for the TERMINAL, which is an app
     shell with its own internal scroll panes:  html,body{overflow:hidden}.
     The onboarding panel loads the same stylesheet and is not a shell; it is a
     long form, taller than a phone at every single step. It inherited the lock,
     could not scroll, and left "Save and continue" stranded below the fold —
     an install nobody on a phone could complete.

   A skipped test is not a passing test, so this one cannot skip.
   ═══════════════════════════════════════════════════════════════════════ */
const path = require('path');
const APP = path.join(__dirname, '..', 'app');

test('the onboarding panel restores document scrolling', () => {
  const shared = fs.readFileSync(path.join(APP, 'kashikeyo.css'), 'utf8');
  const panel = fs.readFileSync(path.join(APP, 'onboarding.html'), 'utf8');

  // The shell rule is still there — the terminal needs it.
  assert.match(shared, /html,body\{[^}]*overflow:hidden/,
    'the shared stylesheet still locks the shell (the terminal relies on it)');

  // ...so the panel must override it, or it cannot be scrolled on a phone.
  const own = panel.match(/html,body\{[^}]*\}/g) || [];
  assert.ok(own.length, 'the panel declares its own html,body rule');
  assert.ok(own.some((r) => /overflow-y:\s*(auto|scroll|visible)/.test(r)),
    'the panel must re-enable vertical scrolling: ' + own.join(' '));
  assert.ok(own.some((r) => /height:\s*auto/.test(r)),
    'and must not pin itself to the viewport height');
});

test('a table editor cannot drag the panel sideways', () => {
  // A grid track defaults to min-width:auto and will not shrink below its
  // widest content, so the step editors — which are tables — grew the page to
  // 819px inside a 390px phone and made .scroll's overflow-x:auto useless.
  const panel = fs.readFileSync(path.join(APP, 'onboarding.html'), 'utf8');
  // The PAGE SHELL only. `.grid` inside a card is repeat(auto-fit,minmax(220px,1fr))
  // and is supposed to have a floor — that one wraps instead of overflowing.
  const shells = panel.match(/\.wrap\{[^}]*\}/g) || [];
  assert.ok(shells.length, 'the panel lays out on a grid');
  shells.forEach((r) => {
    const track = (r.match(/grid-template-columns:[^;}]+/) || [''])[0];
    assert.match(track, /minmax\(0,\s*1fr\)/,
      'the shell\'s flexible track must be minmax(0,1fr) so it can shrink: ' + track);
  });
  assert.match(panel, /\.stage\{[^}]*min-width:0/,
    'the stage must be allowed to shrink below its content');
});

test('a phone tap target is never under 40px in the panel', () => {
  const panel = fs.readFileSync(path.join(APP, 'onboarding.html'), 'utf8');
  // There is more than one phone block; take the one that styles the editors.
  const blocks = panel.match(/@media \(max-width:900px\)\{[\s\S]*?\n\}/g) || [];
  const block = blocks.filter((b) => /td input/.test(b))[0];
  assert.ok(block, 'the panel has a phone block that sizes the table editors');
  assert.match(block, /td input,td select\{[^}]*min-height:4[0-9]px/,
    'in-table inputs are at least 40px on a phone');
  assert.match(block, /button\.mini\{[^}]*min-height:40px/, 'and so is the mini button');
  assert.match(block, /button\.mini\{[^}]*min-width:40px/,
    'including its WIDTH — a single-glyph delete was 34px across');
});

/* ═══ THE ICON RAIL ═════════════════════════════════════════════════════════
   Overlay, not push. Both of these were real defects and both are invisible to
   a feature test: content auto-placing into the 60px track, and a rail whose
   whole justification is touch shipping 34 × 36 targets.
   ═══════════════════════════════════════════════════════════════════════ */
test('opening the menu panel does not move or resize the content', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server at ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    for (const [w, h, name] of [[924, 900, 'tablet'], [1440, 900, 'desktop']]) {
      const p = await b.newPage({ viewport: { width: w, height: h } });
      await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2600);
      if (PIN) {
        for (const d of PIN) { await p.keyboard.press(d); await p.waitForTimeout(90); }
        await p.waitForTimeout(2600);
      }

      // Anything wide sitting in the content pane will do: what is being
      // measured is whether the pane moved, not what is in it.
      const box = () => p.evaluate(() => {
        const el = [...document.querySelectorAll('div')]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > window.innerWidth * 0.5 && r.top > 60 && r.height > 40;
          })[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), w: Math.round(r.width) };
      });

      const before = await box();
      if (!before) { await p.close(); continue; }

      // The content pane must be at least most of the window: with the aside
      // `position:fixed` and no explicit track, the content auto-places into
      // track 1 — the 60px rail — and the whole app collapses to 60px, only
      // still looking right because it overflows.
      assert.ok(before.w > w * 0.5,
        name + ': the content pane is ' + before.w + 'px of a ' + w + 'px window '
        + '— it collapsed into the rail track');

      const opened = await p.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .filter((e) => (e.getAttribute('title') || '') === 'Menu')[0];
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!opened) { await p.close(); continue; }
      await p.waitForTimeout(400);

      const after = await box();
      assert.strictEqual(after.x, before.x,
        name + ': the content moved when the panel opened (' + before.x + ' → ' + after.x + ')');
      assert.strictEqual(after.w, before.w,
        name + ': the content resized when the panel opened (' + before.w + ' → ' + after.w + ')');

      // Faded in, never transformed: a transform-based entrance parks the
      // element off screen if the animation is throttled or never starts.
      const panel = await p.evaluate(() => {
        const el = [...document.querySelectorAll('aside')][0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), w: Math.round(r.width) };
      });
      assert.ok(panel && panel.x >= 0 && panel.w > 100,
        name + ': the panel is off screen — ' + JSON.stringify(panel));
      await p.close();
    }
  } finally { await b.close(); }
});

test('every rail target is at least 44px on its short axis', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server at ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2600);
    if (PIN) {
      for (const d of PIN) { await p.keyboard.press(d); await p.waitForTimeout(90); }
      await p.waitForTimeout(2600);
    }
    const small = await p.evaluate(() => {
      const aside = document.querySelector('aside');
      if (!aside) return [];
      return [...aside.querySelectorAll('button')].map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height),
          t: (e.getAttribute('title') || e.textContent || '').trim().slice(0, 20) };
      }).filter((r) => r.w > 0 && r.h > 0 && Math.min(r.w, r.h) < 44);
    });
    assert.deepStrictEqual(small, [],
      'a rail whose justification is touch cannot ship targets under 44px: '
      + JSON.stringify(small));
  } finally { await b.close(); }
});
