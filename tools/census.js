#!/usr/bin/env node
/* Re-skin no-regression harness (docs/reskin-plan.md, guards 1-4 and 6).
 *
 * The failure mode of a re-skin is not a screen that looks wrong — that is
 * visible and cheap. It is a button that stopped existing, a label that got
 * reworded into the prototype's vocabulary, or a Dhivehi string that fell out
 * of a rewritten block, and nobody notices for three weeks.
 *
 * So the contract is mechanical: take a census of the things a restyle must
 * never remove, commit it, and diff every phase against it.
 *
 *   node tools/census.js            report the current census
 *   node tools/census.js --check    fail if anything regressed vs the baseline
 *   node tools/census.js --update   re-baseline (only with a stated reason)
 *
 * --check is the gate. It is deliberately one-directional: ADDING strings,
 * handlers or screens is fine and expected; REMOVING them has to be justified
 * by moving the item into ALLOW_REMOVED below with a note.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FILES = ["web2/proto/index.html", "web2/proto/admin.html"];
const BASELINE = path.join(__dirname, "census-baseline.json");

/* Strings that a phase legitimately removed. Each entry needs a reason; this
   list is the audit trail for every deliberate wording change in the re-skin. */
const ALLOW_REMOVED = {
  // "old label": "phase 5 — renamed to X because Y",
};

/* ── Guard 1: user-visible strings ───────────────────────────────────────
   Two sources: text nodes in the markup, and the quoted JS literals that feed
   labels. Heuristics, deliberately: this is a DIFF tool, so a stable
   over-collection is far more useful than a clever under-collection. */
function visibleStrings(src) {
  const out = new Set();

  /* Reject anything that is code or CSS rather than something a human reads.
     This matters more than completeness: a census that drifts every time a
     line of JS is touched produces false failures, and a guard people learn
     to ignore is worse than no guard. */
  const isCode = (t) =>
    /[|&<>{}\\=;]/.test(t) ||                 // operators, markup, CSS separators
    /^[,+:.*/-]/.test(t) || /[,+:|]$/.test(t) || // a fragment sliced mid-expression
    (/[()]/.test(t) && !/ /.test(t)) ||        // call syntax; real prose with () has spaces
    /^[a-z-]+:\s*\S/.test(t) ||                // css declaration
    /\d(px|em|rem|%|vh|vw|dvh|deg|ms|s)\b/.test(t) ||
    /^[a-z][a-zA-Z0-9_]*$/.test(t) ||          // identifier / state key
    /^[-\w./#]+$/.test(t) ||                   // path, class, hex, token name
    /^(var|rgba?|linear-gradient|calc|https?|data|blob):/i.test(t) ||
    /^[MmLlHhVvCcSsQqTtAaZz][\d\s.,-]/.test(t);  // SVG path data — icons get swapped

  const add = (s) => {
    const t = String(s).replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 90) return;
    if (!/[A-Za-zހ-޿]/.test(t)) return;       // needs a letter (latin or thaana)
    if (/^\{\{.*\}\}$/.test(t)) return;                  // a pure binding is not a string
    if (isCode(t)) return;
    out.add(t);
  };

  /* Text nodes, from the MARKUP only — script bodies are stripped first, or
     every `a > b` comparison in the JS reads as a text node. */
  const markup = src.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  for (const m of markup.matchAll(/>([^<>{}]{2,90})</g)) add(m[1]);

  /* Quoted literals anywhere (labels, toasts, placeholders live in the JS).
     This must match a COMPLETE JS string literal — quote, body allowing the
     other quote type and escapes, matching quote — with no length bound. An
     earlier version capped the body at 90 chars, so any longer string failed
     to match, the scanner resumed INSIDE it, and every quote after that point
     paired up wrongly. Editing one string then shifted the mis-pairing and
     reported ~37 phantom removals. Length is filtered after matching, never
     during it. */
  for (const m of src.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) add(m[2]);

  return out;
}

/* ── Guard 2: Dhivehi ─────────────────────────────────────────────────── */
function dhivehi(src) {
  const thaana = (src.match(/[ހ-޿]/g) || []).length;
  let keys = 0;
  const m = /\bdv\s*:\s*\{/.exec(src);
  if (m) {
    let i = m.index + m[0].length, depth = 1;
    while (depth && i < src.length) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    keys = (src.slice(m.index + m[0].length, i).match(/['"]?[\w.]+['"]?\s*:/g) || []).length;
  }
  return { thaana, keys };
}

/* ── Guard 3: wired behaviour ─────────────────────────────────────────── */
function handlers(src) {
  const count = (re) => (src.match(re) || []).length;
  /* Word-bounded: without \b, renaming onClick to onClickX still matched and
     the guard sat there reporting green while a handler had been detached. */
  return {
    onClick: count(/\bonClick\b/g),
    onChangeInput: count(/\bonChange\b|\bonInput\b/g),
    onSubmit: count(/\bonSubmit\b/g),
    fetch: count(/\bfetch\(/g),
    /* A dropped screen is the loudest possible feature regression. */
    scIf: count(/<sc-if[\s>]/g),
    scFor: count(/<sc-for[\s>]/g),
  };
}

/* ── Guard 4: structure ───────────────────────────────────────────────── */
function structure(file, src) {
  const problems = [];
  const open = (t) => (src.match(new RegExp("<" + t + "[\\s>]", "g")) || []).length;
  const close = (t) => (src.match(new RegExp("</" + t + ">", "g")) || []).length;
  for (const t of ["sc-if", "sc-for"]) {
    if (open(t) !== close(t)) problems.push(`${t} unbalanced: ${open(t)} open / ${close(t)} close`);
  }
  const blocks = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) problems.push("no <script> block found");
  else {
    const big = blocks.reduce((a, b) => (b.length > a.length ? b : a));
    const tmp = path.join(require("os").tmpdir(), "census-" + path.basename(file) + ".js");
    fs.writeFileSync(tmp, big);
    try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
    catch (e) { problems.push("script syntax error: " + String(e.stderr || e).split("\n")[0]); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  return problems;
}

/* ── Guard 6: hardcoded colour literals (should only ever fall) ───────── */
const literals = (src) => (src.match(/#[0-9A-Fa-f]{6}\b/g) || []).length;

function census() {
  const out = {};
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    out[f] = {
      strings: [...visibleStrings(src)].sort(),
      dhivehi: dhivehi(src),
      handlers: handlers(src),
      literals: literals(src),
      problems: structure(f, src),
    };
  }
  return out;
}

function main() {
  const mode = process.argv[2] || "--report";
  const now = census();

  if (mode === "--update") {
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
    console.log("baseline written:", path.relative(ROOT, BASELINE));
    for (const f of FILES) {
      const c = now[f];
      console.log(`  ${f}: ${c.strings.length} strings, ${c.dhivehi.keys} dv keys, ` +
        `${c.dhivehi.thaana} thaana, ${c.handlers.onClick} onClick, ${c.literals} literals`);
    }
    return;
  }

  if (mode === "--report") {
    for (const f of FILES) {
      const c = now[f];
      console.log(`\n${f}`);
      console.log(`  strings   ${c.strings.length}`);
      console.log(`  dhivehi   ${c.dhivehi.keys} keys / ${c.dhivehi.thaana} thaana chars`);
      console.log(`  handlers  onClick ${c.handlers.onClick}, onChange/Input ${c.handlers.onChangeInput}, ` +
        `fetch ${c.handlers.fetch}, sc-if ${c.handlers.scIf}, sc-for ${c.handlers.scFor}`);
      console.log(`  literals  ${c.literals}`);
      console.log(`  structure ${c.problems.length ? "FAIL — " + c.problems.join("; ") : "ok"}`);
    }
    return;
  }

  if (!fs.existsSync(BASELINE)) {
    console.error("no baseline — run: node tools/census.js --update");
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  let failed = 0;
  const fail = (m) => { console.error("  FAIL " + m); failed++; };
  const ok = (m) => console.log("  ok   " + m);

  for (const f of FILES) {
    console.log("\n" + f);
    const b = base[f], c = now[f];
    if (!b) { fail("no baseline entry"); continue; }

    // Guard 4 first — a broken file makes every other number meaningless.
    if (c.problems.length) c.problems.forEach((p) => fail("structure: " + p));
    else ok("structure (syntax + sc-if/sc-for balance)");

    // Guard 1
    const bs = new Set(b.strings), cs = new Set(c.strings);
    const removed = [...bs].filter((s) => !cs.has(s) && !(s in ALLOW_REMOVED));
    const added = [...cs].filter((s) => !bs.has(s));
    if (removed.length) {
      fail(`${removed.length} user-visible string(s) removed:`);
      removed.slice(0, 25).forEach((s) => console.error(`         − ${JSON.stringify(s)}`));
      if (removed.length > 25) console.error(`         … and ${removed.length - 25} more`);
    } else ok(`strings (${cs.size}, +${added.length} new)`);

    // Guard 2
    if (c.dhivehi.keys < b.dhivehi.keys) fail(`dv keys ${b.dhivehi.keys} → ${c.dhivehi.keys}`);
    else if (c.dhivehi.thaana < b.dhivehi.thaana) fail(`thaana chars ${b.dhivehi.thaana} → ${c.dhivehi.thaana}`);
    else ok(`dhivehi (${c.dhivehi.keys} keys / ${c.dhivehi.thaana} thaana)`);

    // Guard 3
    for (const k of Object.keys(b.handlers)) {
      if (c.handlers[k] < b.handlers[k]) fail(`${k} ${b.handlers[k]} → ${c.handlers[k]} (dropped behaviour?)`);
    }
    if (Object.keys(b.handlers).every((k) => c.handlers[k] >= b.handlers[k])) ok("handlers + screen blocks");

    // Guard 6 — informational; rising is a smell, not yet a failure.
    const d = c.literals - b.literals;
    console.log(`  ${d > 0 ? "warn" : "ok  "} literals ${b.literals} → ${c.literals}` +
      (d > 0 ? "  (should only fall during the re-skin)" : d < 0 ? `  (−${-d})` : ""));
  }

  console.log(failed ? `\nCENSUS FAILED — ${failed} regression(s)` : "\nCENSUS CLEAN");
  process.exit(failed ? 1 : 0);
}

main();
