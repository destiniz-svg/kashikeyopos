/* Regression suite: A DEPLOY MUST NOT TOUCH A STORE'S DATA.

   Why this file exists: every deploy re-applies schema.sql and re-runs the boot
   backfills against the live database, with every store's rows sitting in it.
   That is the one moment when a shipped change can quietly rewrite or delete
   something an owner typed — and unlike a bug in a screen, nobody notices until
   the data is already gone. "It only adds columns" is a claim, not a test.

   What is locked in here:
     1. Restarting the server (what a deploy does) leaves an existing store's
        rows byte-identical — same content AND same rowver, because a rewrite
        that happens to produce the same bytes still bumps the version and makes
        every till in the fleet re-sync a phantom change.
     2. A one-time cleanup migration runs ONCE, does exactly what it says, and
        is a no-op on every boot after — the second restart changes nothing at
        all. That is what makes the next deploy safe rather than lucky.
     3. The cleanup's guards hold: it removes starter dishes only from a store
        that DECLINED the starter menu, only where the row still matches the
        seed, and never one that has been sold or edited. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

/* One store's entire visible state, as a comparable object: every row it holds,
   keyed kind/id, with a hash of its content and its rowver. Read through the
   till's own pull, so this measures what a device would actually see change. */
async function fingerprint(org) {
  const r = await H.req("GET", "/api/pull?since=0", { token: org.token });
  assert.equal(r.status, 200, "pull works");
  const rows = (r.json && (r.json.entities || r.json.rows || r.json.changes)) || [];
  const out = {};
  for (const row of rows) {
    const key = row.kind + "/" + row.id;
    out[key] = {
      v: row.rowver != null ? String(row.rowver) : "",
      deleted: !!row.deleted,
      hash: crypto.createHash("md5").update(JSON.stringify(row.data || null)).digest("hex"),
    };
  }
  return out;
}
const diff = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (!x) { changed.push(k + " APPEARED"); continue; }
    if (!y) { changed.push(k + " VANISHED"); continue; }
    if (x.hash !== y.hash) changed.push(k + " CONTENT CHANGED");
    else if (x.v !== y.v) changed.push(k + " REWRITTEN (rowver " + x.v + "→" + y.v + ")");
    else if (x.deleted !== y.deleted) changed.push(k + " DELETED-FLAG CHANGED");
  }
  return changed;
};

describe("a deploy leaves stored data alone (UPGRADE-SAFETY)", () => {
  let kept, declined, edited;
  let seedIds = [];

  before(async () => {
    // A store that took the starter menu and then traded on it.
    kept = await H.registerOrg({ tag: "upkeep" });
    await H.ops(kept.token, [{ opId: "u1", puts: [
      { kind: "customers", id: "c1", data: { id: "c1", name: "Real Customer", phone: "7771111" } },
      { kind: "sales", id: "s1", data: { id: "s1", no: "INV-K1", at: Date.now(), total: 11000, subtotal: 10185, gst: 815,
        lines: [{ pid: "m24", qty: 1, price: 11000, amount: 10185 }], payments: [{ method: "cash", amount: 11000 }] } },
    ] }]);

    // A store that declined the menu — and, before the fix, got it anyway.
    declined = await H.registerOrg({ tag: "updecl" });
    const fin = await H.req("POST", "/api/onboard/finish", { cookie: declined.cookie,
      body: { menu: "empty", storeName: "Declined", currency: "MVR", pin: "8317", staff: [] } });
    assert.equal(fin.status, 200);

    /* A store in the state the cleanup exists for: it declined the menu, but
       the rows are still there (this is what a pre-fix store looks like). One
       dish has been renamed, one has been sold. Both must survive. */
    edited = await H.registerOrg({ tag: "upedit" });
    const before = await fingerprint(edited);
    seedIds = Object.keys(before).filter((k) => k.startsWith("products/")).map((k) => k.slice(9)).sort();
    assert.ok(seedIds.length > 10, "registration seeded the starter menu: " + seedIds.length);
    const renamed = seedIds[0], sold = seedIds[1];
    const cur = ((await H.req("GET", "/api/pull?since=0", { token: edited.token })).json.entities || [])
      .filter((x) => x.kind === "products" && (x.id === renamed || x.id === sold));
    const byId = Object.fromEntries(cur.map((x) => [x.id, x.data]));
    await H.ops(edited.token, [{ opId: "e1", puts: [
      { kind: "products", id: renamed, data: Object.assign({}, byId[renamed], { name: "MY OWN DISH" }) },
      { kind: "sales", id: "sE", data: { id: "sE", no: "INV-E1", at: Date.now(), total: 9000, subtotal: 8333, gst: 667,
        lines: [{ pid: sold, qty: 1, price: 9000, amount: 8333 }], payments: [{ method: "cash", amount: 9000 }] } },
    ] }]);
    /* Reproduce a PRE-FIX store, which the API can no longer produce: menu
       declined, dishes still sitting there. The flag is what the cleanup keys
       on, so it is set directly, and the migration's claim row is removed so the
       next boot runs it against this state. Constructing the "before" is the
       only way to test a one-time migration at all — it has already run once by
       the time any of this exists. */
    const { Client } = require("pg");
    const db = new Client({ host: process.env.PGHOST || "127.0.0.1", port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "kash", user: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD || "" });
    await db.connect();
    const orgRow = await db.query("SELECT id FROM orgs WHERE slug=$1", [edited.slug]);
    edited.orgId = orgRow.rows[0].id;
    await db.query("UPDATE orgs SET skip_default_menu=true WHERE id=$1", [edited.orgId]);
    await db.query("DELETE FROM app_migrations WHERE id='starter_menu_declined_cleanup_v1'");
    await db.end();
    edited.renamed = renamed; edited.sold = sold;
    edited.untouched = seedIds.filter((id) => id !== renamed && id !== sold).slice(0, 3);
  });

  test("restarting the server changes nothing in a store that is using its data", async () => {
    const before = await fingerprint(kept);
    await H.killServer();
    await H.startServer();                       // a deploy: schema re-applied, backfills re-run
    const after = await fingerprint(kept);
    const changed = diff(before, after);
    assert.deepEqual(changed, [], "a deploy rewrote rows: " + changed.slice(0, 8).join(", "));
    assert.ok(Object.keys(before).length > 100, "and it was a real store, not an empty one");
  });

  test("a second restart changes nothing either — migrations are one-time, not every-boot", async () => {
    const before = await fingerprint(kept);
    const declinedBefore = await fingerprint(declined);
    await H.killServer();
    await H.startServer();
    assert.deepEqual(diff(before, await fingerprint(kept)), [], "the second deploy must be a pure no-op");
    assert.deepEqual(diff(declinedBefore, await fingerprint(declined)), [], "including for the store the cleanup already visited");
  });

  test("the cleanup takes the declined starter dishes, and nothing else", async () => {
    // The two restarts above have re-run the migration against the pre-fix
    // store constructed in before().
    const now = await fingerprint(edited);
    for (const id of edited.untouched) {
      const row = now["products/" + id];
      assert.ok(row && row.deleted, "an untouched starter dish the store declined is gone: " + id);
    }
    const renamed = now["products/" + edited.renamed];
    const sold = now["products/" + edited.sold];
    assert.ok(renamed && !renamed.deleted, "a dish the owner renamed is theirs — it stays");
    assert.ok(sold && !sold.deleted, "a dish that has been sold stays — a receipt reads its name from it");
  });

  test("a store that kept its menu is never visited by the cleanup", async () => {
    const now = await fingerprint(kept);
    const alive = Object.entries(now).filter(([k, v]) => k.startsWith("products/") && !v.deleted).length;
    assert.ok(alive > 100, "the store that chose the starter menu still has it: " + alive);
  });
});
