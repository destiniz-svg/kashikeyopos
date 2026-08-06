// tour.mjs — visual tour + layout assertions for the customer-facing portals
// (web3/proto/guest.html and member.html). Walks every screen at five viewport
// sizes, screenshots each into ./tour-shots/, and asserts the shell fix: the
// page itself never scrolls and any pinned action bar stays inside the viewport.
//
//   npm i -D playwright && npx playwright install chromium
//   node tour.mjs
//
// Env:
//   TOUR_URL   tour a live deployment instead of the bundled prototype,
//              e.g. TOUR_URL="https://<handle>.kashikeyopos.com/" node tour.mjs
//   HEADED=1   run headed (watch it drive)
//
// In the Railway/sandbox image Chromium is pre-installed and `playwright
// install` is blocked, so this file resolves the browser from the global
// install + /opt/pw-browsers/chromium when a local `playwright` isn't present.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "tour-shots");
const PROTO = path.join(HERE, "web3", "proto");

// ── resolve chromium: local `playwright`, else the image's global install ─────
async function loadChromium() {
  try { return (await import("playwright")).chromium; }
  catch { /* fall back to the sandbox's global install */ }
  const g = "/opt/node22/lib/node_modules/playwright/index.js";
  const mod = await import(pathToFileURL(g).href);
  return (mod.default || mod).chromium;
}
const EXE = fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;

// ── a tiny static server for the bundled prototype (skipped when TOUR_URL set) ─
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/" || p === "/v2" || p === "/v2/") p = "/guest.html";
      if (p === "/m" || p === "/m/") p = "/member.html";
      p = p.replace(/^\/v2\//, "/");
      const f = path.join(PROTO, p);
      if (!f.startsWith(PROTO) || !fs.existsSync(f)) { res.writeHead(404); return res.end("404 " + p); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const VIEWPORTS = [
  { name: "phone",         w: 390,  h: 844 },
  { name: "phone-short",   w: 390,  h: 680 },
  { name: "tablet",        w: 768,  h: 1024 },
  { name: "desktop-short", w: 1280, h: 720 },
  { name: "desktop",       w: 1440, h: 900 },
];

// Measure the active screen: does the PAGE scroll, and is the bottom action bar
// (the screen's last flex-shrink:0 child, when it's a real bar) inside the fold?
const MEASURE = () => {
  const inner = [...document.querySelectorAll("div")].find(
    (d) => getComputedStyle(d).maxWidth === "480px" || d.classList.contains("m-frame"));
  const out = { pageScrolls: document.scrollingElement.scrollHeight > window.innerHeight + 2 };
  if (inner) {
    const screen = [...inner.children].find((c) => c.getBoundingClientRect().height > 0) || inner.firstElementChild;
    if (screen) {
      const kids = [...screen.children];
      const last = kids[kids.length - 1];
      if (last) {
        const cs = getComputedStyle(last);
        const isBar = (cs.flexShrink === "0") && last.querySelector("button") && last.getBoundingClientRect().height < window.innerHeight * 0.4;
        if (isBar) {
          const r = last.getBoundingClientRect();
          out.barText = (last.innerText || "").replace(/\s+/g, " ").trim().slice(0, 32);
          out.barInView = r.bottom <= window.innerHeight + 1 && r.top >= 0;
        }
      }
      const sc = [...screen.querySelectorAll("div")].find((d) => /auto|scroll/.test(getComputedStyle(d).overflowY));
      if (sc) out.bodyScrolls = sc.scrollHeight > sc.clientHeight + 1;
    }
  }
  return out;
};

const clickByText = async (page, re) => {
  for (const el of await page.$$("button")) {
    const t = (await el.innerText().catch(() => "")).trim();
    if (re.test(t)) { await el.click().catch(() => {}); return t; }
  }
  return null;
};
const tapFirstDish = (page) => page.evaluate(() => {
  const g = [...document.querySelectorAll("div")].find(
    (d) => getComputedStyle(d).gridTemplateColumns.split(" ").length === 2 && d.querySelector("button"));
  const b = g && g.querySelector("button"); if (b) { b.click(); return true; } return false;
});

async function main() {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const live = process.env.TOUR_URL;
  const srv = live ? null : await startServer();
  const base = live || `http://127.0.0.1:${srv.address().port}/`;
  const guestURL = live || base;
  const memberURL = live ? new URL("/m", live).href : base + "m";

  const chromium = await loadChromium();
  const browser = await chromium.launch({ executablePath: EXE, headless: !process.env.HEADED });
  const rows = [];

  const visit = async (ctxURL, vp, steps) => {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(ctxURL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1100);
    for (const step of steps) {
      try { await step.go(page); } catch { /* keep touring */ }
      await page.waitForTimeout(550);
      const m = await page.evaluate(MEASURE);
      const file = `${step.name}--${vp.name}.png`;
      await page.screenshot({ path: path.join(SHOTS, file) });
      rows.push({ portal: step.portal, screen: step.name, vp: vp.name, ...m, file });
    }
    await page.close();
  };

  const guestSteps = [
    { portal: "guest", name: "landing", go: async () => {} },
    { portal: "guest", name: "menu",    go: (p) => clickByText(p, /browse the menu|view menu|order/i) },
    { portal: "guest", name: "dish",    go: (p) => tapFirstDish(p) },
    { portal: "guest", name: "add",     go: (p) => clickByText(p, /^add\b|add ·|add to order/i) },
    { portal: "guest", name: "basket",  go: async (p) => { await tapFirstDish(p); await p.waitForTimeout(300);
        await clickByText(p, /^add\b|add ·|add to order/i); await p.waitForTimeout(300);
        await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.querySelector("svg path[d*='M6 2']") || /review order/i.test(x.innerText)); b && b.click(); }); } },
    { portal: "guest", name: "account", go: (p) => clickByText(p, /account|loyalty/i) },
  ];
  const memberSteps = [{ portal: "member", name: "home", go: async () => {} }];

  for (const vp of VIEWPORTS) await visit(guestURL, vp, guestSteps);
  for (const vp of VIEWPORTS) await visit(memberURL, vp, memberSteps);

  await browser.close();
  if (srv) srv.close();

  // ── report ──────────────────────────────────────────────────────────────
  const bad = rows.filter((r) => r.pageScrolls || r.barInView === false);
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n" + pad("portal", 8) + pad("screen", 9) + pad("viewport", 15) +
    pad("pageScroll", 12) + pad("barInView", 11) + "shot");
  console.log("─".repeat(78));
  for (const r of rows) {
    const flag = (r.pageScrolls || r.barInView === false) ? "  ✗" : "";
    console.log(pad(r.portal, 8) + pad(r.screen, 9) + pad(r.vp, 15) +
      pad(r.pageScrolls ? "YES" : "no", 12) +
      pad(r.barInView === undefined ? "—" : (r.barInView ? "yes" : "NO"), 11) + r.file + flag);
  }
  console.log("─".repeat(78));
  console.log(`${rows.length} screens toured across ${VIEWPORTS.length} sizes · shots in ./tour-shots/`);
  if (bad.length) {
    console.log(`\n✗ ${bad.length} FAIL — page scrolled or action bar below the fold:`);
    for (const r of bad) console.log(`   ${r.portal}/${r.screen} @ ${r.vp}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ PASS — no page scrolled; every pinned action bar stayed in view.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
