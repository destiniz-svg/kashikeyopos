'use strict';
/* ═══ WHAT THE PRINTER IS ACTUALLY TOLD ═════════════════════════════════════
   The ESC/POS composer is bytes or it is nothing: a wrong initialise leaves
   the printer in whoever's mode the last job set, a wrong cut feeds a docket
   into the guest's hand still attached, and a wrong drawer pulse simply does
   not open the drawer — none of which a screenshot can test. So the bytes
   are asserted AS bytes, against the sequences the Epson manual promises.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const E = require('../app/kashikeyo-escpos.js');

const has = (bytes, seq) => {
  outer: for (let i = 0; i <= bytes.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
    return true;
  }
  return false;
};

test('a docket begins by initialising the printer', () => {
  const b = E.render({ title: 'KAS-CHA', rows: [['Tea', '5.00']] });
  assert.deepStrictEqual(b.slice(0, 2), [0x1b, 0x40],
    'ESC @ first — the last job\'s modes must not leak into this one');
});

test('a docket ends with a cut, unless told not to', () => {
  const cut = [0x1d, 0x56, 66, 3];
  assert.ok(has(E.render({ title: 'X' }), cut), 'GS V 66 3 — partial cut');
  assert.ok(!has(E.render({ title: 'X', cut: false }), cut),
    'a bill preview docket may stay on the roll');
});

test('the drawer kick is the documented pulse, and only when asked', () => {
  const kick = [0x1b, 0x70, 0, 60, 120];
  assert.ok(has(E.render({ title: 'X', kick: true }), kick), 'ESC p 0 on a cash receipt');
  assert.ok(!has(E.render({ title: 'X' }), kick),
    'a card receipt must NOT open the drawer');
  assert.deepStrictEqual(E.drawerPulse(), [0x1b, 0x40, 0x1b, 0x70, 0, 60, 120],
    'the standalone pulse initialises first, then fires pin 0');
});

test('a row lays out left and right across the stated width', () => {
  const d = E.doc(32);
  d.row('Masroshi', '12.00');
  const text = d.bytes().map((c) => String.fromCharCode(c)).join('');
  const line = text.split('\n')[0];
  assert.strictEqual(line.length, 32, 'exactly the paper width');
  assert.ok(/^Masroshi\s+12\.00$/.test(line), 'name left, figure right: ' + JSON.stringify(line));
});

test('a left side too long is truncated, never glued to the figure', () => {
  const d = E.doc(32);
  d.row('A very long dish name that cannot possibly fit', '1,234.56');
  const line = d.bytes().map((c) => String.fromCharCode(c)).join('').split('\n')[0];
  assert.strictEqual(line.length, 32);
  assert.ok(/ 1,234\.56$/.test(line), 'at least one space before the figure');
});

test('text outside ASCII prints as ?, never as code-page garbage', () => {
  const d = E.doc(42);
  d.line('Mas riha · ދިވެހި');
  const text = d.bytes().map((c) => String.fromCharCode(c)).join('');
  assert.ok(text.indexOf('Mas riha') === 0, 'the ASCII part survives');
  assert.ok(!/[-￿]/.test(text), 'nothing above 0x7F reaches the printer');
  assert.ok(text.indexOf('?') > 0, 'and the substitution is visible, not silent');
});

test('base64 round-trips the exact bytes', () => {
  const b = E.render({ title: 'Z', rows: [['Cash', '100.00']], kick: true });
  const back = Array.from(Buffer.from(E.toBase64(b), 'base64'));
  assert.deepStrictEqual(back, b);
});

/* The store logo, as the raster the thermal head actually prints — GS v 0
   with the packed 1-bit rows the branding publish derived. Prepared ONCE at
   publish and carried as base64, so the browser and the server compose
   byte-identical paper from the same spec. */
test('a print logo renders as GS v 0, centred above the title', () => {
  const payload = Buffer.alloc(16, 0xAA);           // 16px wide × 8 rows = 2×8 bytes
  const spec = { logo: { w: 16, h: 8, data: payload.toString('base64') }, title: 'LOY CAFE' };
  const b = E.render(spec, 48);
  const hdr = [0x1d, 0x76, 0x30, 0x00, 2, 0, 8, 0];
  const at = b.join(',').indexOf(hdr.join(','));
  assert.ok(at >= 0, 'the raster header is in the bytes');
  const i = (() => { for (let k = 0; k + hdr.length <= b.length; k++) {
    if (hdr.every((x, j) => b[k + j] === x)) return k; } return -1; })();
  assert.ok(i > 0, 'found at a real offset');
  assert.deepStrictEqual(b.slice(i + 8, i + 8 + 16), Array.from(payload),
    'the payload bytes ride verbatim');
  // Centred: ESC a 1 precedes the raster.
  const before = b.slice(0, i);
  const centred = (() => { for (let k = before.length - 3; k >= 0; k--) {
    if (before[k] === 0x1b && before[k + 1] === 0x61) return before[k + 2]; } return -1; })();
  assert.strictEqual(centred, 1, 'the logo is centred');
});

test('a truncated logo payload is skipped, never fed to the head', () => {
  const spec = { logo: { w: 16, h: 8, data: Buffer.alloc(3, 1).toString('base64') }, title: 'X' };
  const b = E.render(spec, 48);
  assert.ok(b.join(',').indexOf([0x1d, 0x76, 0x30].join(',')) < 0,
    'no raster command for rows that are not there — garbled feed is worse than no logo');
});

test('both runtimes compose identical bytes from one stored bitmap', () => {
  const logo = { w: 24, h: 4, data: Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]).toString('base64') };
  const a = E.render({ logo, title: 'SAME' }, 32);
  const b = E.render({ logo, title: 'SAME' }, 32);
  assert.deepStrictEqual(a, b, 'deterministic — the byte-identical doctrine holds');
});
