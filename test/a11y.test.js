'use strict';
/* ═══ MEASURED, NOT ASSUMED ═════════════════════════════════════════════════
   The readiness audit could confirm that controls now carry names, and could
   not confirm anything a person actually experiences. These are the two
   properties that a screen reader and a keyboard reveal, and both of them are
   computable — so they are computed, in a real browser, against the shipped
   pages, exactly like the responsive suite measures layout rather than judging
   it by eye.

     CONTRAST — every visible run of text, against the background it is really
     drawn on (walked up the ancestors, because a transparent element inherits
     what is behind it). WCAG AA: 4.5:1 for body text, 3:1 for large.

     THE KEYBOARD — a till is touched, but the back office is typed, and a
     person who cannot use a mouse must still be able to reach a control and
     SEE where they are. Tabbing must move focus, land on something visible,
     and never trap.

   Needs a browser and a running server, and skips cleanly without them.
   No axe: this repo ships two runtime dependencies and no dev ones, so the
   check is written out rather than imported.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const PW = '/opt/pw-browsers/chromium';
const BASE = process.env.KPOS_URL || 'http://127.0.0.1:4090';

let chromium = null;
try { chromium = require('/opt/node22/lib/node_modules/playwright/index.js').chromium; }
catch (e) { chromium = null; }

const reachable = async () => {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
};

const skip = (!chromium || !fs.existsSync(PW)) ? 'no browser available' : false;

/* The contrast walk, run inside the page. Returns the failures, not a verdict:
   a test that only says "12 problems" cannot be acted on. */
const CONTRAST = `(() => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (s) => {
    const m = /rgba?\\(\\s*([0-9.]+)[,\\s]+([0-9.]+)[,\\s]+([0-9.]+)(?:[,\\s/]+([0-9.]+))?\\s*\\)/.exec(s || '');
    if (!m) return null;
    return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  };
  /* WHAT IS REALLY BEHIND THE TEXT. A panel painted with a gradient has a
     TRANSPARENT background-color, so walking colours alone falls through it to
     whatever is below — which is how near-white text on a near-black gradient
     reads as 1:1 and a passing design fails a naive check.

     So every paint in the ancestor chain is collected: solid colours AND the
     colour stops of any gradient. The text is then judged against the WORST of
     them. That is a conservative bound rather than a simulation: if it clears
     the worst stop it clears every point of the gradient. */
  const paints = (el) => {
    const found = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const img = cs.backgroundImage || 'none';
      let painted = false;
      if (img !== 'none') {
        const stops = img.match(/rgba?\\([^)]*\\)/g) || [];
        stops.forEach((c) => {
          const p = parse(c);
          if (p && p.a > 0.85) { found.push(p.rgb); painted = true; }  // opaque stops only
        });
      }
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0.85) { found.push(bg.rgb); painted = true; }
      // An opaque paint HIDES everything behind it, and a gradient paints just
      // as opaquely as a colour does. Collecting past it is what made near-white
      // text on a near-black panel read against the light body underneath.
      if (painted) break;
      n = n.parentElement;
    }
    if (!found.length) {
      const body = parse(getComputedStyle(document.body).backgroundColor);
      found.push(body && body.a > 0 ? body.rgb : [255, 255, 255]);
    }
    return found;
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const out = [];
  document.querySelectorAll('body *').forEach((el) => {
    const own = Array.from(el.childNodes).some((n) =>
      n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) return;
    const fg = parse(cs.color);
    if (!fg || fg.a < 0.5) return;
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = Math.min.apply(null, paints(el).map((bg) => ratio(fg.rgb, bg)));
    if (got + 0.05 < need) {
      out.push({
        text: el.textContent.trim().slice(0, 42),
        got: Math.round(got * 100) / 100, need,
        size: Math.round(size * 10) / 10, weight,
        color: cs.color
      });
    }
  });
  return out;
})()`;

async function open(page, path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
}

test('every visible run of text clears WCAG AA against what is behind it',
  { skip }, async (t) => {
    if (!(await reachable())) return t.skip('no server on ' + BASE);
    const b = await chromium.launch({ executablePath: PW });
    try {
      const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
      for (const path of ['/', '/onboarding', '/account']) {
        await open(page, path);
        const bad = await page.evaluate(CONTRAST);
        assert.deepStrictEqual(bad, [],
          path + ' has text below AA:\n' + bad.map((x) =>
            '  ' + x.got + ':1 (needs ' + x.need + ') ' + x.size + 'px/' + x.weight
            + ' ' + x.color + ' — "' + x.text + '"').join('\n'));
      }
    } finally { await b.close(); }
  });

test('the keyboard reaches the controls, shows where it is, and is never trapped',
  { skip }, async (t) => {
    if (!(await reachable())) return t.skip('no server on ' + BASE);
    const b = await chromium.launch({ executablePath: PW });
    try {
      const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
      await open(page, '/');

      const seen = [];
      let invisible = 0;
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        const at = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          /* Focus must be SEEN, and it is asserted as an OUTLINE rather than
             "any box-shadow", which was the first version of this check and
             passed every button in the app on the strength of its decorative
             drop shadow — a shadow that is there whether focus is or not
             indicates nothing.

             :focus-visible is the browser's own answer to "did focus arrive by
             keyboard", which is the case this test is about; a ring on a tap
             would be noise. Asserting both together means the ring is real AND
             the browser agrees this is the moment to draw it. */
          const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
            && (el.matches(':focus-visible') || el.matches(':focus'));
          return { tag: el.tagName, id: el.id || '', w: Math.round(r.width),
            h: Math.round(r.height), ring: !!ring,
            label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) };
        });
        if (!at) continue;                       // focus left the document
        seen.push(at);
        if (!at.ring) invisible++;
      }

      assert.ok(seen.length >= 5,
        'tabbing reached only ' + seen.length + ' controls — the app is not keyboard-navigable');
      // Never stuck on one control: that is the trap a keyboard user cannot escape.
      const unique = new Set(seen.map((x) => x.tag + '#' + x.id + '|' + x.label));
      assert.ok(unique.size >= 3,
        'focus did not move — trapped on ' + JSON.stringify(seen[0]));
      assert.strictEqual(invisible, 0,
        invisible + ' of ' + seen.length + ' focused controls draw no visible focus:\n'
        + seen.filter((x) => !x.ring).map((x) => '  ' + x.tag + ' "' + x.label + '"').join('\n'));
    } finally { await b.close(); }
  });

test('the guest portal and member card meet the same bar', { skip }, async (t) => {
  if (!(await reachable())) return t.skip('no server on ' + BASE);
  const b = await chromium.launch({ executablePath: PW });
  try {
    // A guest holds a phone, so it is measured at a phone's width.
    const page = await b.newPage({ viewport: { width: 390, height: 844 } });
    for (const path of ['/g/load-outlet', '/m/load-outlet']) {
      await open(page, path);
      const bad = await page.evaluate(CONTRAST);
      assert.deepStrictEqual(bad, [],
        path + ' has text below AA:\n' + bad.map((x) =>
          '  ' + x.got + ':1 (needs ' + x.need + ') ' + x.size + 'px/' + x.weight
          + ' — "' + x.text + '"').join('\n'));
    }
  } finally { await b.close(); }
});
