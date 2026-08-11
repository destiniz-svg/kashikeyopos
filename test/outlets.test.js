/* Regression suite for PER-OUTLET configuration (D-09).

   Why this file exists: a chain could add outlets, but tables, seats, per-table
   seat capacity, region, manager and type lived only on the org's SETTINGS
   entity — one object describing one store. Every outlet the terminal rendered
   therefore reported the same hardcoded 12 tables / 48 seats, and the Settings
   "Tables & seats" editor, which POSTed to /api/app2/config, rewrote the main
   store's floor no matter which outlet the operator had selected. A 40-table
   branch could not be configured at all.

   The rules these tests lock in:
     1. A store row is the authority for its own floor plan.
     2. Creating an outlet accepts the same configuration editing it does — you
        should not have to add an outlet and then immediately edit it.
     3. Editing a BRANCH never touches the org settings entity.
     4. Editing the PRIMARY store mirrors onto settings, because the legacy /app
        register and the guest portal still read tableCount/seatCount there.
     5. The active outlet the terminal bills against (KPOS_REAL.outlet) is the
        SAME object as outlets[0] — two sources for one store's floor is how the
        floor plan and the outlet card end up disagreeing after an edit.
     6. A NULL column means "never configured": the primary store falls back to
        the org-level value, every other outlet to the platform default. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

/* Pull the injected window.KPOS_REAL out of /v2. The injection is a single
   JSON literal followed by ;window.KPOS_BUILD — slicing to the next
   "</script>" would swallow the rest of the terminal. */
async function kposReal(cookie) {
  const r = await fetch(H.BASE + "/v2", { headers: { Cookie: cookie } });
  const html = await r.text();
  const T = "window.KPOS_REAL=";
  const a = html.indexOf(T);
  assert.ok(a >= 0, "/v2 must inject window.KPOS_REAL for a signed-in owner");
  let b = html.indexOf(";window.KPOS_BUILD", a);
  if (b < 0) b = html.indexOf(";</script>", a);
  return JSON.parse(html.slice(a + T.length, b));
}

const settingsOf = async (token) => (await H.pullEntity(token, "settings")).data;

describe("per-outlet configuration", () => {
  test("an outlet is created with its own floor plan in one call", async () => {
    const org = await H.registerOrg({ tag: "out-create" });
    const r = await H.req("POST", "/api/app2/outlets", {
      cookie: org.cookie,
      body: { name: "Addu Branch", code: "KOADD", address: "Hithadhoo", tables: 40,
        seats: 160, region: "Addu", manager: "Aish", tableSeats: { 1: 6, 2: 8 } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const real = await kposReal(org.cookie);
    const branch = real.outlets.find((o) => o.storeId === "koadd");
    assert.ok(branch, "the new outlet must appear in the injected outlet list");
    assert.equal(branch.tables, 40, "the branch keeps the 40 tables it was created with, not the 12-table default");
    assert.equal(branch.seats, 160);
    assert.deepEqual(branch.tableSeats, { 1: 6, 2: 8 });
    assert.equal(branch.region, "Addu");
    assert.equal(branch.mgr, "Aish");
  });

  test("each outlet carries its own floor — a branch edit leaves the main store alone", async () => {
    const org = await H.registerOrg({ tag: "out-iso" });
    await H.req("POST", "/api/app2/outlets", { cookie: org.cookie, body: { name: "Branch", code: "BR", tables: 40, seats: 160 } });
    await H.req("PATCH", "/api/app2/outlets/main", { cookie: org.cookie, body: { tables: 30, seats: 120 } });
    const r = await H.req("PATCH", "/api/app2/outlets/br", { cookie: org.cookie, body: { tables: 7, seats: 21, tableSeats: { 5: 9 } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const real = await kposReal(org.cookie);
    const main = real.outlets.find((o) => o.storeId === "main");
    const branch = real.outlets.find((o) => o.storeId === "br");
    assert.equal(main.tables, 30, "the branch edit must not have reached the main store");
    assert.equal(main.seats, 120);
    assert.equal(branch.tables, 7);
    assert.equal(branch.seats, 21);
    assert.deepEqual(branch.tableSeats, { 5: 9 });
  });

  test("a branch edit never rewrites the org settings entity", async () => {
    const org = await H.registerOrg({ tag: "out-nomirror" });
    await H.req("POST", "/api/app2/config", { cookie: org.cookie, body: { cfg: { tableCount: 14, seatCount: 56, tableSeats: { 1: 3 } } } });
    await H.req("POST", "/api/app2/outlets", { cookie: org.cookie, body: { name: "Branch", code: "BR" } });
    await H.req("PATCH", "/api/app2/outlets/br", { cookie: org.cookie, body: { tables: 7, seats: 21, tableSeats: { 5: 9 } } });

    const st = await settingsOf(org.token);
    assert.equal(st.tableCount, 14, "settings describes the MAIN store — a branch must not overwrite it");
    assert.equal(st.seatCount, 56);
    assert.deepEqual(st.tableSeats, { 1: 3 });
  });

  test("editing the primary outlet mirrors onto settings, so the legacy register agrees", async () => {
    const org = await H.registerOrg({ tag: "out-mirror" });
    const r = await H.req("PATCH", "/api/app2/outlets/main", { cookie: org.cookie, body: { tables: 30, seats: 120, tableSeats: { 1: 2, 2: 4 } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const st = await H.until(async () => {
      const s = await settingsOf(org.token);
      return s.tableCount === 30 ? s : null;
    });
    assert.equal(st.seatCount, 120);
    assert.deepEqual(st.tableSeats, { 1: 2, 2: 4 });
  });

  test("the billed outlet and outlets[0] describe the same floor", async () => {
    const org = await H.registerOrg({ tag: "out-same" });
    await H.req("PATCH", "/api/app2/outlets/main", { cookie: org.cookie, body: { tables: 33, seats: 111, tableSeats: { 4: 6 } } });
    const real = await kposReal(org.cookie);
    assert.equal(real.outlet.storeId, real.outlets[0].storeId);
    assert.equal(real.outlet.tables, real.outlets[0].tables);
    assert.equal(real.outlet.seats, real.outlets[0].seats);
    assert.deepEqual(real.outlet.tableSeats, real.outlets[0].tableSeats);
    assert.equal(real.outlet.tables, 33);
  });

  test("an unconfigured store falls back: primary to the org setting, others to the default", async () => {
    const org = await H.registerOrg({ tag: "out-fallback" });
    await H.req("POST", "/api/app2/config", { cookie: org.cookie, body: { cfg: { tableCount: 14, seatCount: 56, tableSeats: { 1: 3 } } } });
    await H.req("POST", "/api/app2/outlets", { cookie: org.cookie, body: { name: "Branch", code: "BR" } });

    const real = await kposReal(org.cookie);
    const main = real.outlets.find((o) => o.storeId === "main");
    const branch = real.outlets.find((o) => o.storeId === "br");
    assert.equal(main.tables, 14, "a NULL column on the primary store falls back to the org setting");
    assert.equal(main.seats, 56);
    assert.deepEqual(main.tableSeats, { 1: 3 });
    assert.equal(branch.tables, 12, "an unconfigured branch gets the platform default, not the main store's floor");
    assert.equal(branch.seats, 48);
    assert.deepEqual(branch.tableSeats, {});
  });

  test("out-of-range floor configuration is refused, not clamped silently", async () => {
    const org = await H.registerOrg({ tag: "out-valid" });
    const bad = [
      [{ tables: 0 }, /Tables must be between/],
      [{ tables: 201 }, /Tables must be between/],
      [{ seats: 0 }, /Seats must be between/],
      [{ seats: 5000 }, /Seats must be between/],
      [{ kind: "nope" }, /Unknown outlet type/],
      [{ tableSeats: [1, 2] }, /must be a map/],
    ];
    for (const [body, re] of bad) {
      const r = await H.req("PATCH", "/api/app2/outlets/main", { cookie: org.cookie, body });
      assert.equal(r.status, 400, `PATCH ${JSON.stringify(body)} should be refused`);
      assert.match(r.json.error, re);
      const c = await H.req("POST", "/api/app2/outlets", { cookie: org.cookie, body: { name: "X", code: "X" + Math.random().toString(36).slice(2, 6), ...body } });
      assert.equal(c.status, 400, `POST ${JSON.stringify(body)} should be refused the same way`);
    }
  });

  test('outlet type "store" is normalised to the terminal\'s own main_store token', async () => {
    const org = await H.registerOrg({ tag: "out-kind" });
    await H.req("POST", "/api/app2/outlets", { cookie: org.cookie, body: { name: "Warehouse", code: "WH", kind: "store" } });
    const real = await kposReal(org.cookie);
    const wh = real.outlets.find((o) => o.storeId === "wh");
    assert.equal(wh.type, "main_store", "two spellings for one type would render an unlabelled outlet");
    assert.equal(wh.pos, false, "a store is not a trading outlet — it must not appear as a till");
  });
});
