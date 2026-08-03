/* Regression suite for the app-shell route guard (serveProto).

   Why this file exists: the sub-resource guard (C-M1) and the register's
   offline service worker (A-C1) were each correct in isolation and took every
   iOS till offline together. The guard demanded positive proof of a document
   (Sec-Fetch-Dest of "", "document" or "iframe"); the service worker re-issues
   every navigation through fetch(), and WebKit sends Sec-Fetch-Dest: empty for
   a worker-issued navigation. /app therefore answered `not found` as
   text/plain, which Safari rendered bare and offered to save as "app.txt".

   The rule these tests lock in: a navigation is served whatever the engine
   labels it, and only a POSITIVELY identified sub-resource is refused. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

/* The Sec-Fetch-Dest values a real navigation has been observed to carry.
   "empty" is the one that broke production: a service-worker-issued
   navigation. "" covers clients that send no Sec-Fetch headers at all. */
const NAVIGATION_DESTS = ["", "empty", "document", "iframe"];

/* Destinations that are unambiguously a sub-resource. Refusing these is what
   stopped the five unresolved "{{ d.src }}" bindings each returning ~460 KB of
   register HTML and re-running the whole data collection. */
const SUB_RESOURCE_DESTS = ["image", "style", "script", "font", "manifest"];

const get = (path, cookie, dest, accept) =>
  H.req("GET", path, {
    cookie,
    headers: {
      ...(dest ? { "Sec-Fetch-Dest": dest } : {}),
      Accept: accept || "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });

describe("app shell route guard", () => {
  let org;
  before(async () => { org = await H.registerOrg({ tag: "shell" }); });

  for (const dest of NAVIGATION_DESTS) {
    const label = dest || "(no Sec-Fetch headers)";
    test(`/app serves the register for a navigation with Sec-Fetch-Dest: ${label}`, async () => {
      const r = await get("/app", org.cookie, dest);
      assert.equal(r.status, 200, `/app must not 404 a navigation (dest="${dest}")`);
      assert.match(
        r.headers.get("content-type") || "", /text\/html/,
        `/app must answer HTML, never text/plain — text/plain at /app is what Safari saves as "app.txt" (dest="${dest}")`,
      );
    });

    test(`/admin serves the cockpit for a navigation with Sec-Fetch-Dest: ${label}`, async () => {
      const r = await get("/admin", org.cookie, dest);
      assert.equal(r.status, 200, `/admin must not 404 a navigation (dest="${dest}")`);
      assert.match(r.headers.get("content-type") || "", /text\/html/);
    });
  }

  test("a service worker re-issuing a navigation with Accept: */* still gets the page", async () => {
    const r = await get("/app", org.cookie, "empty", "*/*");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /text\/html/);
  });

  for (const dest of SUB_RESOURCE_DESTS) {
    test(`/app refuses a sub-resource request with Sec-Fetch-Dest: ${dest}`, async () => {
      const r = await get("/app", org.cookie, dest, "*/*");
      assert.equal(r.status, 404, `a ${dest} request must not be served the full register page`);
    });
  }

  test("unresolved {{ }} template bindings under /app are refused", async () => {
    const r = await get("/app/" + encodeURIComponent("{{ d.src }}"), org.cookie, "image", "image/*,*/*");
    assert.equal(r.status, 404);
  });

  test("an extension-bearing path under /app is refused", async () => {
    const r = await get("/app/missing-asset.png", org.cookie, "image", "image/*");
    assert.equal(r.status, 404);
  });

  test("the guest portal serves a service-worker-issued navigation", async () => {
    const r = await get(`/?s=${org.slug}`, "", "empty");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /text\/html/);
  });
});
