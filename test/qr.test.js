'use strict';
/* ═══ A QR CODE IS BYTES, OR IT IS DECORATION ════════════════════════════════
   The encoder was verified against an independent decoder (jsQR) before it
   shipped: fifty payloads across versions 1–10, all four EC levels and all
   eight masks, every one decoding back to its input byte for byte. That
   decoder is not a dependency this build ships, so what CI pins instead is a
   KNOWN-ANSWER set — matrices whose hashes were captured from the verified
   run. A regression in the encoder cannot pass as a cosmetic change, because
   a QR that is subtly wrong looks exactly like one that is right; that is how
   the Math.random() fake survived as long as it did.
   ═══════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const QR = require('../app/kashikeyo-qr.js');

function hash(mx) {
  const flat = mx.grid.map((r) => r.join('')).join('|');
  return crypto.createHash('sha256').update(flat).digest('hex').slice(0, 16);
}

// Captured from the jsQR-verified run. If the encoder changes on purpose,
// re-verify against a real decoder BEFORE updating these.
const KNOWN = [
  ['https://loy052255.kashikeyopos.com/?t=12', 'M', 3, 3, '430bfb66cd1e074c'],
  ['HELLO WORLD', 'L', 1, 3, 'd308784b6ee5697d'],
  ['x'.repeat(200), 'L', 9, 0, '0e070801e11c1a4e']
];

test('known-answer matrices match the decoder-verified run', () => {
  for (const [text, ecl, version, mask, h] of KNOWN) {
    const mx = QR.matrix(text, ecl);
    assert.ok(mx, 'encodes');
    assert.strictEqual(mx.version, version, text.slice(0, 20) + ' version');
    assert.strictEqual(mx.mask, mask, text.slice(0, 20) + ' mask');
    assert.strictEqual(hash(mx), h, text.slice(0, 20) + ' matrix');
  }
});

test('structure: finders, timing, dark module, quiet refusal', () => {
  const mx = QR.matrix('https://a.kashikeyopos.com/?t=7', 'M');
  const g = mx.grid, n = mx.size;
  assert.strictEqual(n, 17 + mx.version * 4, 'size follows the version');
  // The three finder centres are dark and their inner ring is light.
  for (const [r, c] of [[3, 3], [3, n - 4], [n - 4, 3]]) {
    assert.strictEqual(g[r][c], 1, 'finder centre dark');
    assert.strictEqual(g[r - 2][c - 2], 0, 'finder inner ring light');
  }
  // The timing lines alternate.
  for (let t = 8; t < n - 8; t++) {
    assert.strictEqual(g[6][t], t % 2 === 0 ? 1 : 0, 'row timing');
    assert.strictEqual(g[t][6], t % 2 === 0 ? 1 : 0, 'col timing');
  }
  assert.strictEqual(g[n - 8][8], 1, 'dark module');
  // Too long for the table is a null, never a truncated code.
  assert.strictEqual(QR.matrix('y'.repeat(1000), 'H'), null);
});

test('the svg is one path on a quiet zone, and the data url has no semicolon', () => {
  const s = QR.svg('https://a.kashikeyopos.com/?t=7', { quiet: 4 });
  assert.ok(s.startsWith('<svg'), 'svg');
  assert.ok(s.indexOf('shape-rendering="crispEdges"') > 0, 'crisp for print');
  assert.strictEqual((s.match(/<path/g) || []).length, 1, 'one path, not a rect per module');
  const u = QR.dataUrl('anything');
  /* `data:image/svg+xml;utf8,` truncates at its own semicolon inside an
     inline style — the documented defect that turned the dish glyphs into
     solid blocks. The composed URL must be the percent-encoded form. */
  assert.ok(u.startsWith('data:image/svg+xml,'), 'percent-encoded form');
  assert.strictEqual(u.indexOf(';'), -1, 'no semicolon anywhere in the url');
});
