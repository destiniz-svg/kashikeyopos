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

/* Where Chromium and Playwright are. The development container has them at
   these paths; CI installs them somewhere of its own and says where. Neither
   goes into package.json — this repository ships two runtime dependencies and
   no dev ones, and that is a property worth keeping. */
const PW = process.env.KPOS_PW_CHROMIUM || '/opt/pw-browsers/chromium';
const PW_MODULE = process.env.KPOS_PW_MODULE
  || '/opt/node22/lib/node_modules/playwright/index.js';
const BASE = process.env.KPOS_URL || 'http://127.0.0.1:4090';

let chromium = null;
try { chromium = require(PW_MODULE).chromium; }
catch (e) { chromium = null; }

const reachable = async () => {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
};

const { browserSkip, needServer } = require('./browser');
const skip = browserSkip(!!chromium, PW, fs);

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
    if (!needServer(t, await reachable(), BASE)) return;
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
    if (!needServer(t, await reachable(), BASE)) return;
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
  if (!needServer(t, await reachable(), BASE)) return;
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


/* ═══ BEYOND THE LANDING STATE ══════════════════════════════════════════════
   The sweeps above visit each app as it opens, and the readiness audit said so:
   modals, sheets and forms were not visited, and no accessible NAME was ever
   computed for anything. Both are closed here.

   A name is the whole of what a screen reader announces for a control. A button
   whose only content is an icon announces nothing at all — the operator hears
   "button" and has to guess. This walks every interactive element on every rail
   screen and inside every modal that opens, and demands one. */
const NAMED = `(() => {
  const named = (el) => {
    const lab = (el.getAttribute('aria-label') || '').trim();
    if (lab) return lab;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? (n.textContent || '').trim() : '';
      }).join(' ').trim();
      if (t) return t;
    }
    const title = (el.getAttribute('title') || '').trim();
    if (title) return title;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.id) {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && (l.textContent || '').trim()) return (l.textContent || '').trim();
      }
      const wrap = el.closest('label');
      if (wrap && (wrap.textContent || '').trim()) return (wrap.textContent || '').trim();
      const ph = (el.getAttribute('placeholder') || '').trim();
      if (ph) return ph;
      if (el.type === 'submit' || el.type === 'button') return (el.value || '').trim();
      return '';
    }
    const text = (el.textContent || '').trim();
    if (text) return text;
    // An image with alt text names the control it is the whole content of.
    const img = el.querySelector('img[alt], svg[aria-label], svg title');
    if (img) return (img.getAttribute('alt') || img.getAttribute('aria-label')
      || (img.textContent || '')).trim();
    return '';
  };
  const out = [];
  document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')
    .forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;                    // not on screen
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      if (el.type === 'hidden' || el.disabled) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (!named(el)) out.push({
        tag: el.tagName, type: el.type || '', cls: (el.className || '').toString().slice(0, 40),
        html: el.outerHTML.slice(0, 110)
      });
    });
  return out;
})()`;

test('every control a person can reach announces what it is', { skip }, async (t) => {
  if (!needServer(t, await reachable(), BASE)) return;
  const b = await chromium.launch({ executablePath: PW });
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await open(page, '/');

    const unnamed = [];
    const gather = async (where) => {
      const bad = await page.evaluate(NAMED);
      bad.forEach((x) => unnamed.push(where + ' · ' + x.tag
        + (x.type ? '[' + x.type + ']' : '') + ' ' + x.html));
    };
    await gather('/');

    // Every rail screen...
    const rails = await page.evaluate(() => document.querySelectorAll('aside button').length);
    for (let i = 0; i < rails; i++) {
      const label = await page.evaluate((k) => {
        const btns = document.querySelectorAll('aside button');
        if (k >= btns.length) return null;
        const t = (btns[k].getAttribute('aria-label') || btns[k].textContent || '').trim().slice(0, 20);
        btns[k].click(); return t || ('rail ' + k);
      }, i);
      if (label === null) break;
      await page.waitForTimeout(420);
      await gather(label);

      /* ...and every modal that screen can open. A modal is where the unnamed
         icon button hides: it is built once, opened rarely, and never seen by a
         sweep that only visits landing states. */
      /* Not the rail — those navigate, and every one of them is already walked
         above. What is wanted here is the buttons ON the screen, which is where
         an icon-only control with no name hides. */
      const opens = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')]
          .filter((x) => { const r = x.getBoundingClientRect();
            return r.width > 8 && r.height > 8 && !x.closest('aside'); });
        return b.length;
      });
      for (let m = 0; m < Math.min(opens, 6); m++) {
        const opened = await page.evaluate((k) => {
          const b = [...document.querySelectorAll('button')]
            .filter((x) => { const r = x.getBoundingClientRect();
            return r.width > 8 && r.height > 8 && !x.closest('aside'); });
          if (k >= b.length) return null;
          const t = (b[k].textContent || '').trim().slice(0, 22);
          b[k].click(); return t;
        }, m);
        if (opened === null) break;
        await page.waitForTimeout(300);
        /* A modal in this app is a panel carrying the kmodal or ksheet entrance
           animation — that is what its style string is built with, and it is a
           far more reliable signal than hunting for position:fixed, which the
           top bar and the rail also use. */
        const isModal = await page.evaluate(() =>
          !!document.querySelector('[style*="kmodal"], [style*="ksheet"]'));
        if (isModal) {
          await gather(label + ' → ' + opened);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      }
    }

    assert.deepStrictEqual(unnamed, [],
      unnamed.length + ' controls announce nothing to a screen reader:\n  '
      + unnamed.slice(0, 25).join('\n  '));
  } finally { await b.close(); }
});


/* ═══ THE OTHER TWO SERVICES ═════════════════════════════════════════════════
   site/ and panel/ are separate Express services from the same image, on their
   own ports, and the readiness audit said plainly that they were outside this
   suite. A seller signs into Mission Control every day and a customer meets the
   website before anything else, so "outside the suite" is not a reason for
   either to be less legible than the till.

   Same three properties, same code: contrast against what is really behind the
   text, a visible keyboard focus ring, and a name on every control. Skips when
   the service is not running rather than pretending. */
const OTHERS = [
  ['Mission Control', process.env.PANEL_URL || 'http://127.0.0.1:4101'],
  ['the website', process.env.SITE_URL || 'http://127.0.0.1:4102']
];

OTHERS.forEach(([what, base]) => {
  test(what + ' meets the same bar as the till', { skip }, async (t) => {
    let up = false;
    try {
      const r = await fetch(base + '/', { signal: AbortSignal.timeout(1500) });
      up = r.ok;
    } catch (e) { up = false; }
    if (!needServer(t, up, base)) return;

    const b = await chromium.launch({ executablePath: PW });
    try {
      const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      const bad = await page.evaluate(CONTRAST);
      assert.deepStrictEqual(bad, [], what + ' has text below AA:\n' + bad.map((x) =>
        '  ' + x.got + ':1 (needs ' + x.need + ') ' + x.size + 'px/' + x.weight
        + ' ' + x.color + ' — "' + x.text + '"').join('\n'));

      const unnamed = await page.evaluate(NAMED);
      assert.deepStrictEqual(unnamed, [],
        what + ' has controls that announce nothing:\n  '
        + unnamed.map((x) => x.tag + ' ' + x.html).join('\n  '));

      // And the keyboard: focus must move and be seen.
      let seen = 0, invisible = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        const at = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
            && (el.matches(':focus-visible') || el.matches(':focus'));
          return { ring: !!ring, tag: el.tagName,
            label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) };
        });
        if (!at) continue;
        seen++;
        if (!at.ring) invisible.push(at.tag + ' "' + at.label + '"');
      }
      assert.ok(seen >= 3, what + ' reached only ' + seen + ' controls by keyboard');
      assert.deepStrictEqual(invisible, [],
        what + ' draws no visible focus on:\n  ' + invisible.join('\n  '));
    } finally { await b.close(); }
  });
});
