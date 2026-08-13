/* Test harness for the KashikeyoPOS sync server.
   Boots the real index.js as a child process against a Postgres it reads from
   PG* env (defaults suit a standard local Postgres; the sandbox harness runs
   with PGPORT=54329). Every test registers its own throwaway org, so tests are
   isolated from each other and from any existing data by Postgres RLS — no
   database creation or teardown privileges required.

   Requires: a reachable Postgres. Run e.g.
     PGPORT=54329 PGUSER=postgres PGDATABASE=kash node --test test/ */
const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.TEST_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;

const childEnv = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: "test",
  SECRET: "test-secret",
  JWT_SECRET: "test-secret",
  ALLOWED_ORIGINS: "*",
  PGHOST: process.env.PGHOST || "127.0.0.1",
  PGPORT: process.env.PGPORT || "5432",
  PGDATABASE: process.env.PGDATABASE || "kash",
  PGUSER: process.env.PGUSER || "postgres",
  PGPASSWORD: process.env.PGPASSWORD || "",
  /* Seed a platform-admin account so the cross-tenant surfaces (the developer
     panel, /api/metrics) can be exercised at all. Without these the server
     provisions no admin and every one of those endpoints is permanently 401 —
     which is the right production default, and is itself pinned in
     metrics.test.js, but leaves the payloads untested. */
  PLATFORM_ADMIN_EMAIL: "ops@test.mv",
  PLATFORM_ADMIN_PASSWORD: "platform-admin-test-pw",
};

let child = null;

async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  /* Wait for READINESS, not just a live socket. /api/health used to answer
     ok:true the moment SELECT 1 worked — which on a brand-new database is
     before schema apply, role grants and seeding have run. The harness then
     registered an org against a schema that did not exist, the failure landed
     in a top-level before() hook, and node:test cancelled every test in the
     file with "cancelledByParent". On a cold database that silently reported
     78/95 passing instead of 95/95 — and in CI, where the database is always
     fresh, that was the normal path. /api/health now 503s until boot init
     finishes, so this simply waits for it.

     60s because a cold boot applies the whole schema and seeds a 300-dish
     starter menu; a warm one is milliseconds. */
  const deadline = Date.now() + 60000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/api/health");
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok && j.db && j.ready) return;
      last = `HTTP ${r.status} ${JSON.stringify(j)}`;
      if (j.phase === "boot-failed") throw new Error("server boot failed: " + j.error + "\nLog:\n" + log);
    } catch (e) {
      if (/boot failed/.test(e.message)) throw e;   // real failure, not "not up yet"
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`server did not become ready in 60s (last: ${last}). Log:\n` + log);
}

function stopServer() {
  if (child) { child.kill("SIGTERM"); child = null; }
}

/* SIGKILL — no graceful shutdown, no in-flight request finished, no chance to
   flush anything. Used by the fault-injection suite to model the tablet's
   server dying mid-transaction, which SIGTERM does NOT model: SIGTERM lets
   Node unwind, and a crash that unwinds cleanly proves nothing about a crash
   that doesn't. Resolves once the process is actually gone, so a restart cannot
   race the old listener for the port. */
function killServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const dying = child;
    child = null;
    dying.once("exit", () => resolve());
    dying.kill("SIGKILL");
    setTimeout(resolve, 3000);                 // never hang the suite on a stuck child
  });
}

/* ── HTTP helpers ─────────────────────────────────────────────────────── */
async function req(method, path, { body, token, cookie, headers: extra, redirect } = {}) {
  const headers = { "Content-Type": "application/json", ...(extra || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    // fetch FOLLOWS redirects by default, which turns an assertion about a 301
    // into an assertion about whatever it landed on. Pass redirect:"manual" to
    // test the redirect itself.
    redirect: redirect || "follow",
  });
  // Read the body ONCE as text, then try to parse it — a response can only be
  // consumed once, and some assertions are about the HTML itself (what the /v2
  // page injects for a given session), not about a JSON envelope.
  const text = await r.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. a page) */ }
  return { status: r.status, json, text, headers: r.headers };
}

const uniqEmail = (tag = "t") => `${tag}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}@test.mv`;

/* Register a fresh org; returns { token, slug, email, password, cookie }. */
async function registerOrg(opts = {}) {
  const email = opts.email || uniqEmail(opts.tag);
  const password = opts.password || "pass1234";
  const r = await req("POST", "/api/register", {
    body: { email, password, storeName: opts.storeName || "Test Store", currency: "MVR", pin: "1234" },
  });
  if (r.status !== 200 || !r.json || !r.json.token) throw new Error("register failed: " + JSON.stringify(r.json));
  const setCookie = r.headers.get("set-cookie") || "";
  const cookie = (setCookie.match(/kashikeyo_session=[^;]+/) || [""])[0];
  return { token: r.json.token, slug: r.json.slug, email, password, cookie };
}

const ops = (token, opsArr) => req("POST", "/api/ops", { token, body: { ops: opsArr } });
const pull = (token, since = 0) => req("GET", `/api/pull?since=${since}`, { token });
/* Inventory auth: destructive /api/inv routes are back-office (cookie) only
   since SEC-2, so callers may pass a bearer token string (reads) or an org
   object / { cookie } for writes. */
const invAuth = (a) => (typeof a === "string" ? { token: a } : a && a.cookie ? { cookie: a.cookie } : a && a.token ? { token: a.token } : {});
const invGet = (a, p) => req("GET", "/api/inv" + p, invAuth(a));
const invPost = (a, p, body) => req("POST", "/api/inv" + p, { ...invAuth(a), body });
const invPut = (a, p, body) => req("PUT", "/api/inv" + p, { ...invAuth(a), body });

/* Poll a predicate until true or timeout — used to wait for the post-commit
   inventory deduction (processSales runs after the /api/ops response). */
async function until(fn, { timeout = 5000, step = 150 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((res) => setTimeout(res, step));
  }
  throw new Error("condition not met within " + timeout + "ms");
}

/* Poll pull(since=0) until an entity matching (kind, pred) is visible, then
   return it. A single pull can transiently miss a freshly-committed row while
   an unrelated concurrent transaction holds the cluster snapshot xmin down —
   the never-skip visibility guard the sync cursor depends on. The till's real
   5s poll (and SSE re-poke) ride straight over that window with no data loss;
   a read-back assertion in a suite that registers many orgs concurrently must
   do the same instead of asserting on one immediate pull. */
async function pullEntity(token, kind, pred = () => true) {
  return until(async () => {
    const e = ((await pull(token, 0)).json.entities || []).find((x) => x.kind === kind && !x.deleted && pred(x));
    return e || null;
  });
}

/* Sign in to the platform-admin panel (see PLATFORM_ADMIN_* above) and return
   its session cookie, for the cross-tenant endpoints. */
async function platformAdminCookie() {
  const r = await req("POST", "/api/dev/login", {
    body: { email: childEnv.PLATFORM_ADMIN_EMAIL, password: childEnv.PLATFORM_ADMIN_PASSWORD },
  });
  if (r.status !== 200) throw new Error("platform admin login failed: " + JSON.stringify(r.json));
  return ((r.headers.get("set-cookie") || "").match(/kdev_session=[^;]+/) || [""])[0];
}

module.exports = { BASE, startServer, stopServer, killServer, req, registerOrg, ops, pull, invGet, invPost, invPut, until, pullEntity, uniqEmail, platformAdminCookie };
