/* ═══ A QR CODE IS BYTES, OR IT IS DECORATION ════════════════════════════════
   The till used to draw a 13×13 grid of Math.random() cells under the words
   "scan to order" — a picture of a QR code that no camera on earth could read,
   printed beside a URL that was real. This file is the real thing: a complete
   QR encoder (ISO/IEC 18004, byte mode, versions 1–10, all four EC levels),
   dependency-free because this build ships two runtime dependencies and a
   barcode library is not becoming the third.

   Loaded by the BROWSER as a script and by the SERVER as a module, exactly
   like kashikeyo-rules.js — one composer, so a card printed from the till and
   one rendered anywhere else carry byte-identical modules.

   Verified against an independent decoder (jsQR) before it shipped, and
   test/qr.test.js pins known-answer matrices so a regression cannot pass as a
   cosmetic change: a QR that is subtly wrong LOOKS exactly like one that is
   right, which is how the fake survived as long as it did.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  /* ── GF(256), the arithmetic Reed–Solomon lives in ─────────────────────── */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

  // Generator polynomial for `n` EC codewords: (x-α^0)(x-α^1)…(x-α^(n-1)).
  function rsGenerator(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }
  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var rem = data.concat(new Array(ecLen).fill(0));
    for (var i = 0; i < data.length; i++) {
      var f = rem[i];
      if (!f) continue;
      for (var j = 1; j < gen.length; j++) rem[i + j] ^= gmul(gen[j], f);
    }
    return rem.slice(data.length);
  }

  /* ── the capacity tables (ISO 18004, versions 1–10) ─────────────────────
     Per version+level: EC codewords PER BLOCK, then the blocks as
     [count, dataCodewords] pairs — group two, where a version has one,
     carries one more data codeword than group one. */
  var BLOCKS = {
    L: [[7, [[1, 19]]], [10, [[1, 34]]], [15, [[1, 55]]], [20, [[1, 80]]],
      [26, [[1, 108]]], [18, [[2, 68]]], [20, [[2, 78]]], [24, [[2, 97]]],
      [30, [[2, 116]]], [18, [[2, 68], [2, 69]]]],
    M: [[10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]],
      [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]],
      [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]],
    Q: [[13, [[1, 13]]], [22, [[1, 22]]], [18, [[2, 17]]], [26, [[2, 24]]],
      [18, [[2, 15], [2, 16]]], [24, [[4, 19]]], [18, [[2, 14], [4, 15]]],
      [22, [[4, 18], [2, 19]]], [20, [[4, 16], [4, 17]]], [24, [[6, 19], [2, 20]]]],
    H: [[17, [[1, 9]]], [28, [[1, 16]]], [22, [[2, 13]]], [16, [[4, 9]]],
      [22, [[2, 11], [2, 12]]], [28, [[4, 15]]], [26, [[4, 13], [1, 14]]],
      [26, [[4, 14], [2, 15]]], [24, [[4, 12], [4, 13]]], [28, [[6, 15], [2, 16]]]]
  };
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  // Format info: 2 EC-level bits + 3 mask bits, BCH(15,5), XOR 0x5412.
  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function dataCapacity(version, ecl) {
    return BLOCKS[ecl][version - 1][1]
      .reduce(function (a, g) { return a + g[0] * g[1]; }, 0);
  }

  /* ── the payload: byte mode, UTF-8 ──────────────────────────────────────── */
  function toBytes(text) {
    if (typeof TextEncoder !== "undefined") {
      return Array.prototype.slice.call(new TextEncoder().encode(text));
    }
    // Node without TextEncoder in scope, or a very old engine.
    var b = [], s = unescape(encodeURIComponent(text));
    for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xff);
    return b;
  }

  function pickVersion(byteLen, ecl) {
    for (var v = 1; v <= 10; v++) {
      var countBits = v <= 9 ? 8 : 16;
      var need = Math.ceil((4 + countBits + byteLen * 8) / 8);
      if (need <= dataCapacity(v, ecl)) return v;
    }
    return 0;   // too long for this table — the caller refuses by name
  }

  function buildCodewords(bytes, version, ecl) {
    var cap = dataCapacity(version, ecl);
    var countBits = version <= 9 ? 8 : 16;
    var bits = [], push = function (val, n) {
      for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(4, 4);                        // byte-mode indicator
    push(bytes.length, countBits);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
    // Terminator, pad to a byte boundary, then the two alternating pad bytes.
    var term = Math.min(4, cap * 8 - bits.length);
    push(0, term);
    if (bits.length % 8) push(0, 8 - (bits.length % 8));
    var cw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var x = 0;
      for (var k = 0; k < 8; k++) x = (x << 1) | bits[b + k];
      cw.push(x);
    }
    var pads = [0xec, 0x11], p = 0;
    while (cw.length < cap) cw.push(pads[(p++) % 2]);

    // Split into RS blocks, then interleave data and EC column-wise.
    var spec = BLOCKS[ecl][version - 1], ecLen = spec[0];
    var blocks = [], at = 0;
    spec[1].forEach(function (g) {
      for (var n = 0; n < g[0]; n++) {
        var d = cw.slice(at, at + g[1]);
        at += g[1];
        blocks.push({ d: d, e: rsEncode(d, ecLen) });
      }
    });
    var out = [], maxD = 0;
    blocks.forEach(function (bl) { maxD = Math.max(maxD, bl.d.length); });
    for (var c = 0; c < maxD; c++) {
      blocks.forEach(function (bl) { if (c < bl.d.length) out.push(bl.d[c]); });
    }
    for (var e = 0; e < ecLen; e++) {
      blocks.forEach(function (bl) { out.push(bl.e[e]); });
    }
    return out;
  }

  /* ── the matrix ─────────────────────────────────────────────────────────── */
  function formatBits(ecl, mask) {
    var data = (ECL_BITS[ecl] << 3) | mask;
    var v = data << 10;
    var g = 0x537;
    for (var i = 14; i >= 10; i--) {
      if ((v >> i) & 1) v ^= g << (i - 10);
    }
    return (((data << 10) | v) ^ 0x5412) & 0x7fff;
  }
  function versionBits(version) {
    var v = version << 12, g = 0x1f25;
    for (var i = 17; i >= 12; i--) {
      if ((v >> i) & 1) v ^= g << (i - 12);
    }
    return (version << 12) | v;
  }

  function buildMatrix(codewords, version, ecl, forcedMask) {
    var size = 17 + version * 4;
    // m: -1 unset data cell · 0/1 function or data. fn: true where a function
    // pattern owns the cell, so masking and placement both step around it.
    var m = [], fn = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(-1));
      fn.push(new Array(size).fill(false));
    }
    function set(r, c, v, isFn) { m[r][c] = v ? 1 : 0; if (isFn) fn[r][c] = true; }

    function finder(r0, c0) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = r0 + r, cc = c0 + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var on = r >= 0 && r <= 6 && c >= 0 && c <= 6
            && !((r === 1 || r === 5) && c >= 1 && c <= 5)
            && !((c === 1 || c === 5) && r >= 1 && r <= 5);
          set(rr, cc, on, true);
        }
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // Timing patterns.
    for (var t = 8; t < size - 8; t++) {
      if (m[6][t] === -1) set(6, t, t % 2 === 0, true);
      if (m[t][6] === -1) set(t, 6, t % 2 === 0, true);
    }

    /* Alignment patterns. Only the three FINDER corners are excluded — an
       alignment pattern whose centre falls on a timing line (v7 up: (6,22),
       (22,6), …) is REQUIRED and overwrites it, and skipping "already
       painted" cells silently dropped exactly those, which decoded fine to
       v6 and never at v7. */
    var centers = ALIGN[version] || [], last = size - 7;
    centers.forEach(function (cr) {
      centers.forEach(function (cc) {
        if ((cr === 6 && cc === 6) || (cr === 6 && cc === last)
          || (cr === last && cc === 6)) return;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            set(cr + r, cc + c,
              Math.max(Math.abs(r), Math.abs(c)) !== 1, true);
          }
        }
      });
    });

    // Reserve the format areas (filled after masking) and the dark module.
    for (var i = 0; i < 9; i++) {
      if (i !== 6) {
        if (m[8][i] === -1) set(8, i, 0, true);
        if (m[i][8] === -1) set(i, 8, 0, true);
      }
    }
    for (var j = 0; j < 8; j++) {
      if (m[8][size - 1 - j] === -1) set(8, size - 1 - j, 0, true);
      if (m[size - 1 - j][8] === -1) set(size - 1 - j, 8, 0, true);
    }
    set(size - 8, 8, 1, true);   // the dark module

    // Version info, v7 up: two 6×3 blocks.
    if (version >= 7) {
      var vb = versionBits(version);
      for (var k = 0; k < 18; k++) {
        var bit = (vb >> k) & 1;
        var a = Math.floor(k / 3), b = k % 3;
        set(size - 11 + b, a, bit, true);
        set(a, size - 11 + b, bit, true);
      }
    }

    // Data, zig-zag in two-module columns from the bottom right, skipping the
    // vertical timing column.
    var bitAt = 0, total = codewords.length * 8;
    function nextBit() {
      var bit = bitAt < total
        ? (codewords[bitAt >> 3] >> (7 - (bitAt & 7))) & 1 : 0;
      bitAt++;
      return bit;
    }
    var col = size - 1, up = true;
    while (col > 0) {
      if (col === 6) col--;
      for (var step = 0; step < size; step++) {
        var row = up ? size - 1 - step : step;
        for (var d = 0; d < 2; d++) {
          var cc2 = col - d;
          if (m[row][cc2] === -1) m[row][cc2] = nextBit();
        }
      }
      up = !up;
      col -= 2;
    }

    function applyMask(mask) {
      var out = m.map(function (row) { return row.slice(); });
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (fn[r][c]) continue;
          var inv;
          switch (mask) {
            case 0: inv = (r + c) % 2 === 0; break;
            case 1: inv = r % 2 === 0; break;
            case 2: inv = c % 3 === 0; break;
            case 3: inv = (r + c) % 3 === 0; break;
            case 4: inv = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
            case 5: inv = ((r * c) % 2 + (r * c) % 3) === 0; break;
            case 6: inv = ((r * c) % 2 + (r * c) % 3) % 2 === 0; break;
            default: inv = ((r + c) % 2 + (r * c) % 3) % 2 === 0;
          }
          if (inv) out[r][c] ^= 1;
        }
      }
      // Format info, both copies, over the reserved cells.
      var f = formatBits(ecl, mask);
      var fi = function (n) { return (f >> n) & 1; };
      for (var i2 = 0; i2 <= 5; i2++) out[i2][8] = fi(i2);
      out[7][8] = fi(6); out[8][8] = fi(7); out[8][7] = fi(8);
      for (var i3 = 9; i3 < 15; i3++) out[8][14 - i3] = fi(i3);
      for (var i4 = 0; i4 < 8; i4++) out[8][size - 1 - i4] = fi(i4);
      for (var i5 = 8; i5 < 15; i5++) out[size - 15 + i5][8] = fi(i5);
      out[size - 8][8] = 1;
      return out;
    }

    function penalty(g) {
      var score = 0, r, c;
      // N1: runs of five or more, both directions.
      for (r = 0; r < size; r++) {
        var runC = 1, runR = 1;
        for (c = 1; c < size; c++) {
          if (g[r][c] === g[r][c - 1]) { runC++; if (c === size - 1 && runC >= 5) score += 3 + runC - 5; }
          else { if (runC >= 5) score += 3 + runC - 5; runC = 1; }
          if (g[c][r] === g[c - 1][r]) { runR++; if (c === size - 1 && runR >= 5) score += 3 + runR - 5; }
          else { if (runR >= 5) score += 3 + runR - 5; runR = 1; }
        }
      }
      // N2: 2×2 blocks of one colour.
      for (r = 0; r < size - 1; r++) {
        for (c = 0; c < size - 1; c++) {
          var v = g[r][c];
          if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3;
        }
      }
      // N3: the finder-like 1011101 with four clear on a side.
      var pat = [1, 0, 1, 1, 1, 0, 1];
      function n3At(get) {
        var s3 = 0;
        for (var a = 0; a < size; a++) {
          for (var b = 0; b < size - 6; b++) {
            var hit = true;
            for (var k = 0; k < 7; k++) if (get(a, b + k) !== pat[k]) { hit = false; break; }
            if (!hit) continue;
            var before = true, after = true;
            for (var k2 = 1; k2 <= 4; k2++) {
              if (b - k2 < 0 || get(a, b - k2) !== 0) { before = false; break; }
            }
            for (var k3 = 1; k3 <= 4; k3++) {
              if (b + 6 + k3 >= size || get(a, b + 6 + k3) !== 0) { after = false; break; }
            }
            if (before || after) s3 += 40;
          }
        }
        return s3;
      }
      score += n3At(function (a, b) { return g[a][b]; });
      score += n3At(function (a, b) { return g[b][a]; });
      // N4: dark-module proportion.
      var dark = 0;
      for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += g[r][c];
      score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
      return score;
    }

    if (forcedMask !== undefined && forcedMask !== null) {
      return { size: size, grid: applyMask(forcedMask), mask: forcedMask };
    }
    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mk = 0; mk < 8; mk++) {
      var g2 = applyMask(mk);
      var s2 = penalty(g2);
      if (s2 < bestScore) { bestScore = s2; best = g2; bestMask = mk; }
    }
    return { size: size, grid: best, mask: bestMask };
  }

  /* ── the public face ────────────────────────────────────────────────────── */
  function matrix(text, ecl, forcedMask) {
    var level = BLOCKS[ecl] ? ecl : "M";
    var bytes = toBytes(String(text == null ? "" : text));
    var version = pickVersion(bytes.length, level);
    if (!version) return null;   // too long — the caller says so by name
    var cw = buildCodewords(bytes, version, level);
    var out = buildMatrix(cw, version, level, forcedMask);
    out.version = version;
    out.ecl = level;
    return out;
  }

  /* One <path>, so a printed card is a single crisp vector — a grid of rects
     is what makes a print driver rasterise. quiet is in modules (the spec
     says four). */
  function svg(text, opts) {
    var o = opts || {};
    var q = o.quiet === undefined ? 4 : Math.max(0, o.quiet | 0);
    var mx = matrix(text, o.ecl || "M");
    if (!mx) return "";
    var n = mx.size + q * 2, d = "";
    for (var r = 0; r < mx.size; r++) {
      for (var c = 0; c < mx.size; c++) {
        if (mx.grid[r][c]) d += "M" + (c + q) + " " + (r + q) + "h1v1h-1z";
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n
      + '" shape-rendering="crispEdges">'
      + (o.light === "none" ? "" : '<rect width="' + n + '" height="' + n + '" fill="'
        + (o.light || "#ffffff") + '"/>')
      + '<path d="' + d + '" fill="' + (o.dark || "#000000") + '"/></svg>';
  }

  /* For a style attribute: percent-encoded, and NEVER the ;utf8 form — a
     semicolon ends an inline declaration, which is the documented defect that
     turned the dish glyphs into solid blocks. */
  function dataUrl(text, opts) {
    var s = svg(text, opts);
    return s ? "data:image/svg+xml," + encodeURIComponent(s) : "";
  }

  var API = { matrix: matrix, svg: svg, dataUrl: dataUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.KPOS_QR = API;
})(typeof window !== "undefined" ? window : globalThis);
