'use strict';
/* ═══ NO DISH IS EVER A BLANK TILE ══════════════════════════════════════════
   The menu-visuals changeset, pinned. Most of it is layout and would be
   noticed by eye, so what is asserted here is the part that would NOT be:
   the seeded composition, the two traps that make an image silently vanish,
   the single glyph set both apps read, and the caps that keep a
   three-hundred-dish menu interactive.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const APP = path.join(__dirname, '..', 'app');
const TILL = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const GUEST = fs.readFileSync(path.join(APP, 'guest.html'), 'utf8');
const DATA = fs.readFileSync(path.join(APP, 'kashikeyo-data.js'), 'utf8');

const CATS = [
  { id: 'starters', name: 'Breakfast & Maldivian Specialties', icon: 'starter' },
  { id: 'mains', name: 'Mains', icon: 'main' },
  { id: 'drinks', name: 'Cold Drinks', icon: 'drink' }
];
const menuOf = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'd' + (i + 1), name: 'Dish ' + (i + 1),
  desc: i % 3 ? 'A house dish, described.' : '',
  cat: CATS[i % CATS.length].id, price: 50 + i, station: i % 2 ? 'hot' : 'grill',
  veg: i % 7 === 0, recipe: []
}));
const till = (n) => {
  const F = H.makeInstance({ kpos: { MENU: menuOf(n || 12), MENU_CATEGORIES: CATS } });
  F.state.outletId = 1; F.state.pane = 'menu';
  return F;
};

/* ═══ THE SEED ══════════════════════════════════════════════════════════════
   A dish's tile has to be STABLE — the same plate at the till, in the editor
   and on the guest's phone, or the artifact stops being a way to recognise a
   dish and becomes decoration. And two dishes in one section must not resolve
   to the same tile, or a section of forty reads as forty copies of one thing. */
test('the artifact is seeded from the dish, so it is stable and it varies', () => {
  const F = till();
  const a1 = F.artifact({ id: 'd1', cat: 'starters', name: 'Aluvi Mashuni' });
  const a2 = F.artifact({ id: 'd1', cat: 'starters', name: 'Aluvi Mashuni' });
  assert.strictEqual(a1.glyph, a2.glyph, 'the same dish resolves to the same tile every time');

  // Four rotations, and across a realistic id set every one is reached.
  const rots = new Set();
  for (let i = 1; i <= 40; i++) {
    const g = F.artifact({ id: 'd' + i, cat: 'starters', name: 'Dish ' + i }).glyph;
    rots.add(/rotate\((-?[\d.]+)deg\)/.exec(g)[1]);
  }
  assert.strictEqual(rots.size, 4,
    'all four rotations are in play across one section: ' + [...rots].join(', '));

  // Same dish, different section: the hue changes, so the tile does.
  const s = F.artifact({ id: 'd1', cat: 'starters', name: 'X' });
  const m = F.artifact({ id: 'd1', cat: 'mains', name: 'X' });
  assert.notStrictEqual(s.plate, m.plate, "a dish's plate follows its section's hue");
});

/* ═══ TRAP 1 · A SEMICOLON ENDS AN INLINE DECLARATION ════════════════════════
   `data:image/svg+xml;utf8,…` and `data:image/jpeg;base64,…` both truncate at
   their own semicolon when concatenated into a style string. The glyph then
   paints as a solid block of hue and the photograph paints nothing at all —
   silently, with no error anywhere. */
test('no image URL this build composes carries a semicolon', () => {
  const F = till();
  const g = F.artifact({ id: 'd1', cat: 'starters', name: 'X' }).glyph;
  const url = /mask:url\("([^"]*)"/.exec(g);
  assert.ok(url, 'the glyph is a mask, not a per-tile <svg>: ' + g.slice(0, 80));
  assert.ok(url[1].indexOf(';') < 0,
    'a semicolon in the mask URL truncates the declaration and the glyph'
    + ' becomes a solid block: ' + url[1].slice(0, 90));
  assert.match(url[1], /^data:image\/svg\+xml,/,
    'which is why the payload form is `+xml,` and never `+xml;utf8,`');
});

test('a photograph is rendered from a blob URL, never from the data URL', () => {
  const F = till();
  // A one-pixel JPEG, base64 — the shape an upload produces.
  const data = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const url = F.photoUrl(data);
  assert.notStrictEqual(url, data,
    'the data URL contains `image/jpeg;base64` and cannot go in a style value');
  assert.match(url, /^blob:/, 'a blob: URL is what CSS is given: ' + url);
  assert.strictEqual(F.photoUrl(data), url, 'and it is minted once per session, not per paint');
  assert.strictEqual(F.photoUrl('https://x/y.jpg'), 'https://x/y.jpg',
    'an ordinary URL passes through untouched');
  assert.strictEqual(F.photoUrl(''), '', 'and nothing stays nothing');
});

/* ═══ ONE GLYPH SET ═════════════════════════════════════════════════════════
   The till and the guest's phone draw the same plates. Two copies is how the
   allergen table ended up with two key vocabularies — "shellfish" in one and
   "crustacean" in the other — so a diet that blocked one never blocked the
   other. */
test('the section glyphs and hues live in the one file both apps load', () => {
  assert.match(DATA, /SECTION_GLYPHS/, 'the set is in app/kashikeyo-data.js');
  assert.match(DATA, /SECTION_HUES/);
  const F = till();
  const K = F.__win.KPOS;
  assert.ok(Object.keys(K.SECTION_GLYPHS).length >= 12, 'twelve sections and "all"');
  assert.strictEqual(K.SECTION_HUES.length, 8, 'eight hues by section index');

  // Neither app may carry its own copy of a path.
  const anyPath = K.SECTION_GLYPHS.seafood;
  assert.ok(TILL.indexOf(anyPath) < 0,
    'the terminal reads the shared set rather than holding a second copy');
  assert.ok(GUEST.indexOf(anyPath) < 0,
    'and so does the guest portal');
});

/* The guest portal is told category NAMES and no icon key, so it matches by
   keyword — a section called "Hedhikaa" gets the starter glyph rather than a
   generic square. */
test('the guest portal can pick a glyph from a section name alone', () => {
  const K = till().__win.KPOS;
  const cases = [
    ['Reef Fish', 'seafood'], ['Rice & Curries', 'rice'], ['Cold Drinks', 'drink'],
    ['Sweets & Puddings', 'dessert'], ['Hedhikaa', 'starter'], ['Soups', 'soup'],
    ['Anything at all', 'main']
  ];
  cases.forEach(([name, want]) => assert.strictEqual(K.glyphFor(name), want,
    '"' + name + '" should read as ' + want));
});

/* ═══ THE TILE ══════════════════════════════════════════════════════════════ */
test('the till tile is a record: a plate, a body and a foot bar', () => {
  const F = till();
  const m = F.posVals().dishes[0];
  assert.match(m.plateStyle, /width:74px;height:74px/, 'the plate leads at 74px');
  assert.match(m.plateStyle, /border-radius:12px/);
  assert.match(m.glyphStyle, /mask:url/, 'and carries the section glyph');
  assert.strictEqual(m.photoStyle, 'display:none', 'with no photo layer until there is one');
  assert.ok(m.station, 'the station is named on the chip: ' + m.station);
  assert.match(m.stationStyle, /color-mix/, 'in its own hue');
  assert.ok('qty' in m && typeof m.dec === 'function' && typeof m.inc === 'function',
    'and the foot bar owns a stepper, so a mis-tap is a correction and not a void');
  assert.match(m.style, /content-visibility:auto/,
    'a three-hundred-dish grid needs the tiles it cannot see to cost nothing');
  // A card is a container and the face is the button: a button cannot contain
  // a button, and nesting them makes the inner taps unreliable.
  assert.ok(TILL.indexOf('<button onClick="{{ m.add }}"') > 0);
  assert.ok(/<div style="{{ m.style }}"/.test(TILL),
    'so the card is a div and the face inside it is the button');
});

test('a dish with no description does not render an empty line for one', () => {
  const F = till();
  const ds = F.posVals().dishes;
  assert.ok(ds.some((d) => d.hasDesc) && ds.some((d) => !d.hasDesc),
    'the fixture has both kinds');
  assert.ok(TILL.indexOf('<sc-if value="{{ m.hasDesc }}">') > 0,
    'and the description is behind a conditional rather than painting a gap');
});

/* ═══ PAGING ════════════════════════════════════════════════════════════════
   Measured on the prototype at 9,230 → 2,123 nodes for the till and
   12,427 → 4,074 for Menu Master. */
test('the till renders sixty dishes and offers the rest', () => {
  const F = till(301);
  const v = F.posVals();
  assert.strictEqual(v.dishes.length, 60);
  assert.strictEqual(v.menuMore, true);
  assert.match(v.menuMoreText, /Showing 60 of 301 dishes/);
  assert.match(v.menuMoreText, /load the rest, or search/,
    'and says what the alternative is — searching narrows, paging does not');
  v.menuMoreGo();
  const v2 = F.posVals();
  assert.strictEqual(v2.dishes.length, 301, 'the cap lifts for the session');
  assert.strictEqual(v2.menuMore, false, 'and the control goes with it');
});

test('a short menu is not paged at all', () => {
  const v = till(12).posVals();
  assert.strictEqual(v.dishes.length, 12);
  assert.strictEqual(v.menuMore, false, 'no control on a menu that fits');
});

/* ═══ THE RAILS ═════════════════════════════════════════════════════════════ */
test('the till section rail fills the selected tab with its own hue', () => {
  const F = till();
  const cats = F.posVals().cats;
  const on = cats.find((c) => /catFill|--cat-|#/.test(c.style) && c.dot === 'display:none');
  assert.ok(on, 'the selected tab is filled and drops its dot — its whole field is the hue');
  const off = cats.find((c) => c.dot !== 'display:none');
  assert.match(off.dot, /width:8px;height:8px/, 'an unselected tab leads with the dot instead');
  // "19 dishes" was on every tab, so the word said nothing on any of them.
  cats.forEach((c) => assert.ok(!/dishes/.test(String(c.count)),
    'the count is a bare numeral: ' + c.count));
  assert.match(F.posVals().catRailStyle, /scroll-snap-type:x proximity/,
    'and the rail scrolls rather than wrapping');
});

test('the back-office strip is a track, and the native picker is gone', () => {
  assert.ok(TILL.indexOf('tabPicker') < 0,
    'any strip past five tabs used to collapse into a card with an invisible'
    + ' <select> over it, which hid the counts and the hues and showed nothing'
    + ' until it was tapped');
  assert.ok(TILL.indexOf('asPicker') < 0);
  const F = till();
  const v = F.moduleShellVals
    ? null
    : null;
  // The track's own shape, read off the source: it is built in one place.
  assert.match(TILL, /tabRailStyle: !tabList\.length \? "display:none"/);
  assert.match(TILL, /background:var\(--bg-2\);border:1px solid var\(--line\);"\s*\n\s*\+ "border-radius:12px;padding:3px 4px;flex:1 1 auto;min-width:0;/,
    'a recessed groove that is the thing that yields');
  assert.match(TILL, /flex:0 0 auto;min-width:max-content/,
    'while the actions do NOT shrink — letting them overflow leftwards put'
    + ' their nowrap buttons on top of the tabs and swallowed the taps');
});

test('Menu Master gives every tab its section hue and count', () => {
  const F = till(30);
  F.state.view = 'menu';
  const tabs = F.g_menu().tabs;
  assert.strictEqual(tabs[0].label, 'All dishes');
  assert.strictEqual(tabs[0].count, 30);
  tabs.slice(1).forEach((t) => {
    assert.ok(t.hue, t.label + ' carries its hue');
    assert.ok(typeof t.count === 'number', t.label + ' carries its count');
  });
});

/* ═══ THE PHOTOGRAPH BLOCK ══════════════════════════════════════════════════ */
test('the dish editor can attach, replace and remove a photograph', () => {
  const F = till();
  F.openDish('d1');
  const v = F.modalVals(F.state.modal);
  assert.match(v.dbArtStyle, /width:74px;height:74px/, 'the preview is the tile size');
  assert.match(v.dbArtGlyph, /mask:url/, 'and shows the artifact until there is a photo');
  assert.notStrictEqual(v.dbArtRing, 'display:none',
    'the RICH variant, because a single tile can afford the gradient and ring'
    + ' that a grid of three hundred cannot');
  assert.strictEqual(v.dbImgRemoveStyle, 'display:none', 'nothing to remove yet');
  assert.match(v.dbArtNote, /No photograph/);
  assert.match(v.dbImgPlaceholder, /paste an image URL/);
  assert.strictEqual(typeof v.dbUpload, 'function');

  // With an upload held on the draft.
  F.state.modal.d.img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const v2 = F.modalVals(F.state.modal);
  assert.match(v2.dbArtPhoto, /blob:/, 'the preview paints from a blob URL');
  assert.strictEqual(v2.dbImgUrl, '',
    'and the URL field shows EMPTY rather than 90 KB of base64 — a stray'
    + ' keystroke in it would otherwise destroy the upload');
  assert.match(v2.dbImgPlaceholder, /Uploaded from this device/, 'saying so instead');
  assert.notStrictEqual(v2.dbImgRemoveStyle, 'display:none', 'and Remove appears');
  assert.match(v2.dbArtNote, /Photograph set/);
});

test('the image saves with the dish, or the block is a control that does nothing', () => {
  assert.match(TILL, /img: String\(d\.img \|\| ""\)/,
    'dbSave carries img alongside name, price and the rest');
});

/* ═══ THE GUEST SIDE ════════════════════════════════════════════════════════ */
test('the guest plate is one background layer, not an extra element', () => {
  // The hue is baked into the glyph's own stroke, so there is no masked span
  // over a tinted box — a phone painting twenty of these while the guest
  // scrolls has a frame budget the counter does not.
  assert.match(GUEST, /artifact\(catId, glyphSize, base, ink, tintAlpha\)/);
  assert.match(GUEST, /background-image:url/);
  assert.ok(GUEST.indexOf('data:image/svg+xml,') > 0, 'comma, not `;utf8,`');
  assert.ok(!/data:image\/svg\+xml;/.test(GUEST),
    'a semicolon here truncates the declaration and the plate goes blank');
  assert.match(GUEST, /photoUrl\(src\)/, 'and photos are minted as blobs here too');
});

test('the guest hero stays a dark field whether or not there is a photograph', () => {
  assert.match(GUEST, /this\.artifact\(d\.cat, "26%", "#241f1c", "#ffffff", "6b"\)/,
    "the phone's own white status bar and back button sit on top of it");
});
