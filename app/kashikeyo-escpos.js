/* ═══ WHAT A PRINTER IS TOLD ═════════════════════════════════════════════════
   ESC/POS — the byte dialect nearly every thermal receipt printer speaks,
   Epson TM to the cheapest no-name kitchen bumper. Composed HERE, in one
   module loaded by the browser as a script and by the server as a module,
   exactly like `kashikeyo-rules.js`: the till printing over WebUSB and the
   server printing over the LAN must produce byte-identical dockets, or the
   same bill looks different depending on which path printed it.

   Only the primitives this app uses, spelled out:

     ESC @        initialise (wake, clear modes)
     ESC a n      align 0 left · 1 centre · 2 right
     ESC E n      emphasis on/off
     GS  ! n      character size (width | height, 0-based multipliers)
     ESC d n      feed n lines
     GS  V 66 3   partial cut, feeding first
     ESC p m t1 t2  DRAWER KICK — pulse pin m for t1×2ms on / t2×2ms off.
                    The cash drawer plugs into the RECEIPT PRINTER's RJ11;
                    "open the drawer" is a print command, which is why the
                    drawer can only open where the receipt prints.

   Text is encoded to plain ASCII bytes with anything outside 0x20–0x7E
   replaced by '?'. Thermal printers speak code pages, not UTF-8, and a wrong
   code page prints box-drawing garbage across a real guest's docket — '?' is
   the honest fallback until per-printer code pages are configured. Dhivehi
   (Thaana) therefore cannot print yet; the screen remains the reference.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.KASHIKEYO_ESCPOS = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ESC = 0x1b, GS = 0x1d;

  function ascii(s) {
    const out = [];
    const t = String(s == null ? "" : s);
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      out.push(c === 0x0a ? 0x0a : (c >= 0x20 && c <= 0x7e) ? c : 0x3f);
    }
    return out;
  }

  /* A builder over a plain byte array. 42 columns is the usual 80mm head at
     font A; 32 covers 58mm — the caller says which, once, and every row and
     rule reads it. */
  function doc(cols) {
    const width = Number(cols) || 42;
    const b = [];
    const push = (arr) => { for (const x of arr) b.push(x & 0xff); };
    const api = {
      width: width,
      init() { push([ESC, 0x40]); return api; },
      align(n) { push([ESC, 0x61, n | 0]); return api; },
      bold(on) { push([ESC, 0x45, on ? 1 : 0]); return api; },
      size(w, h) { push([GS, 0x21, (((w | 0) & 7) << 4) | ((h | 0) & 7)]); return api; },
      text(s) { push(ascii(s)); return api; },
      line(s) { push(ascii(s)); push([0x0a]); return api; },
      /* Left text, right figure, dots of space between — the receipt column
         layout. A left side too long is truncated with a single trailing
         space kept, because a number glued to a name reads as a bigger
         number. */
      row(left, right) {
        const r = String(right == null ? "" : right);
        let l = String(left == null ? "" : left);
        const room = width - r.length - 1;
        if (l.length > room) l = l.slice(0, Math.max(0, room));
        return api.line(l + " ".repeat(Math.max(1, width - l.length - r.length)) + r);
      },
      rule() { return api.line("-".repeat(width)); },
      /* A raster image — GS v 0, the store-logo primitive nearly every
         thermal head honours. `data` is the packed 1-bit rows (MSB first,
         ceil(w/8) bytes per row), base64 so the same spec travels as JSON
         through the spool and the LAN relay unchanged. The bitmap is
         prepared ONCE when the logo is published (rasterPrintLogo in the
         till) — this module never rasterises, because the server has no
         canvas and two rasterisers would print two logos. */
      image(w, h, dataB64) {
        const wBytes = Math.ceil((w | 0) / 8);
        if (!wBytes || !(h | 0) || !dataB64) return api;
        let bin = "";
        if (typeof Buffer !== "undefined") bin = Buffer.from(String(dataB64), "base64").toString("binary");
        else { try { bin = atob(String(dataB64)); } catch (e) { return api; } }
        if (bin.length < wBytes * (h | 0)) return api;   // truncated payload: skip, never garble
        push([GS, 0x76, 0x30, 0x00,
          wBytes & 0xff, (wBytes >> 8) & 0xff, (h | 0) & 0xff, ((h | 0) >> 8) & 0xff]);
        for (let i = 0; i < wBytes * (h | 0); i++) b.push(bin.charCodeAt(i) & 0xff);
        return api;
      },
      feed(n) { push([ESC, 0x64, Math.max(1, n | 0)]); return api; },
      cut() { push([ESC, 0x64, 3, GS, 0x56, 66, 3]); return api; },
      kick(pin) { push([ESC, 0x70, pin ? 1 : 0, 60, 120]); return api; },
      bytes() { return b.slice(); }
    };
    return api;
  }

  /* One docket shape for every kind the spool carries. The SPEC is data — the
     till builds it from what it is already holding — and this renders it, so
     a KOT and a receipt differ in content, never in dialect.

       { logo?: {w,h,data}, title, sub?,
         rows?: [ [left,right] | "text" | {big:"text"} | {rule:1} ],
         foot?, cut?: default true, kick?: false } */
  function render(spec, cols) {
    const s = spec || {};
    const d = doc(cols);
    d.init();
    if (s.kick) d.kick(0);
    // The store's mark, centred above its name — the paper leads with the
    // brand exactly as the on-screen receipt does.
    if (s.logo && s.logo.data) {
      d.align(1).image(s.logo.w, s.logo.h, s.logo.data).feed(1);
    }
    d.align(1).bold(true).size(1, 1).line(s.title || "").size(0, 0).bold(false);
    if (s.sub) d.line(s.sub);
    d.align(0).rule();
    (s.rows || []).forEach((r) => {
      if (r == null) return;
      if (Array.isArray(r)) return d.row(r[0], r[1]);
      if (typeof r === "object" && r.rule) return d.rule();
      if (typeof r === "object" && r.big != null) {
        d.bold(true).size(1, 1).line(String(r.big)).size(0, 0).bold(false);
        return;
      }
      d.line(String(r));
    });
    if (s.foot) { d.rule(); d.align(1).line(s.foot).align(0); }
    if (s.cut !== false) d.cut();
    return d.bytes();
  }

  /* The drawer pulse alone — for opening on a cash settle with nothing to
     print, e.g. a no-receipt sale. Still ESC/POS, still through the receipt
     printer, because that is where the drawer is plugged in. */
  function drawerPulse() {
    return [ESC, 0x40, ESC, 0x70, 0, 60, 120];
  }

  function toBase64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let bin = "";
    for (const x of bytes) bin += String.fromCharCode(x & 0xff);
    return btoa(bin);
  }

  return { doc: doc, render: render, drawerPulse: drawerPulse, toBase64: toBase64 };
}));
