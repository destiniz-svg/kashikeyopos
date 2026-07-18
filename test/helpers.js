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
};

let child = null;

async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  // Wait for /api/health to report db:true, up to ~20s.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) { const j = await r.json(); if (j.ok && j.db) return; }
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error("server did not become healthy in time. Log:\n" + log);
}

function stopServer() {
  if (child) { child.kill("SIGTERM"); child = null; }
}

/* ── HTTP helpers ─────────────────────────────────────────────────────── */
async function req(method, path, { body, token, cookie, headers: extra } = {}) {
  const headers = { "Content-Type": "application/json", ...(extra || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON (e.g. redirect html) */ }
  return { status: r.status, json, headers: r.headers };
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
const invGet = (token, p) => req("GET", "/api/inv" + p, { token });
const invPost = (token, p, body) => req("POST", "/api/inv" + p, { token, body });
const invPut = (token, p, body) => req("PUT", "/api/inv" + p, { token, body });

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

module.exports = { BASE, startServer, stopServer, req, registerOrg, ops, pull, invGet, invPost, invPut, until, uniqEmail };
