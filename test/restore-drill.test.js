/* DISASTER-RECOVERY DRILL (D-04).

   Why this file exists: the audit could see that backup/reset/restore code
   existed, but "the code exists" is not "the business comes back". Nothing had
   ever taken a snapshot, destroyed the store and checked what actually
   returned — so the restore path's real failure modes (a sync cursor that no
   longer moves, an inventory ledger that comes back without its stock, a
   backup another tenant can read) were untested claims.

   This is the drill, run on every suite execution:
     1. Build a store with sales, products, customers and stock.
     2. Snapshot it.
     3. Destroy it (the account-wide reset).
     4. Restore, and check the business is actually back — entity by entity,
        including the inventory tables, which live outside `entities`.
     5. Check a till that was mid-sync still converges instead of sitting on a
        cursor the restore has moved past.

   It also pins the guards, because a recovery tool that anyone can fire is
   itself the disaster: restore is owner-only, needs the owner's password, and
   is scoped to the tenant that owns the backup. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

const PW = "pass1234";

/* Build a store worth losing: menu, customers, sales, and stock behind a
   recipe, so the drill covers both the `entities` sync store and the inventory
   tables the restore has to bring back with it. */
async function seedStore(org) {
  const r = await H.ops(org.token, [{ opId: "seed-1", puts: [
    { kind: "products", id: "p1", data: { id: "p1", name: "Mas Huni", price: 4500, cat: 1 } },
    { kind: "products", id: "p2", data: { id: "p2", name: "Kulhi Boakibaa", price: 3500, cat: 1 } },
    { kind: "customers", id: "c1", data: { id: "c1", name: "Aish", phone: "7771234" } },
    { kind: "sales", id: "sale-1", data: { id: "sale-1", no: "KO-1", at: Date.now(), t: Date.now(),
      total: 4500, subtotal: 4167, gst: 333, tender: "cash",
      lines: [{ pid: "p1", qty: 1, price: 4500, amount: 4500 }], payments: [{ method: "cash", amount: 4500 }] } },
  ] }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const ing = await H.invPost(org, "/ingredients", { name: "Tuna", baseUnit: "g", minStock: 500, location: "Kitchen" });
  assert.equal(ing.status, 200, JSON.stringify(ing.json));
  const ingId = ing.json.id || (ing.json.ingredient && ing.json.ingredient.id);
  assert.ok(ingId, "expected an ingredient id: " + JSON.stringify(ing.json));
  const inv = await H.invPost(org, "/invoices", {
    supplier: "Fish Market", invoiceNo: "INV-1",
    lines: [{ ingredientId: ingId, qty: 2000, cost: 20 }],
  });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  return { ingId };
}

/* The facts the merchant would notice were gone. Read through the app's own
   endpoints, not the database, so the drill measures what the business sees. */
async function census(org) {
  const ents = ((await H.pull(org.token, 0)).json.entities || []).filter((e) => !e.deleted);
  const byKind = {};
  for (const e of ents) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  const ings = (await H.invGet(org, "/ingredients")).json;
  const list = Array.isArray(ings) ? ings : (ings.ingredients || ings.items || []);
  return {
    byKind,
    ids: ents.map((e) => e.kind + ":" + e.id).sort(),
    ingredients: list.map((i) => i.name + "@" + Math.round(Number(i.current_stock ?? i.currentStock ?? 0))).sort(),
  };
}

describe("disaster-recovery drill", () => {
  test("a destroyed store comes back from its own backup, stock included", async () => {
    const org = await H.registerOrg({ tag: "dr" });
    await seedStore(org);
    const before = await census(org);
    assert.ok(before.byKind.sales >= 1, "the drill needs a sale to lose");
    /* Assert the census actually READS the stock figure. If the field were ever
       renamed this would silently become "Tuna@0" on both sides and the
       comparison below would pass while proving nothing. */
    assert.deepEqual(before.ingredients, ["Tuna@2000"], "the drill needs stock to lose, and must be reading it");

    const backup = await H.req("POST", "/api/app2/backup", { cookie: org.cookie, body: { label: "drill" } });
    assert.equal(backup.status, 200, JSON.stringify(backup.json));
    assert.ok(backup.json.id);

    const reset = await H.req("POST", "/api/app2/reset", { cookie: org.cookie, body: { password: PW, backup: false } });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    const wiped = await census(org);
    assert.ok(!wiped.byKind.sales, "the reset must actually destroy the store, or the drill proves nothing");

    const restore = await H.req("POST", "/api/app2/restore", { cookie: org.cookie, body: { password: PW, id: backup.json.id } });
    assert.equal(restore.status, 200, JSON.stringify(restore.json));

    const after = await census(org);
    assert.deepEqual(after.ids, before.ids, "every entity must come back, by kind and id");
    assert.deepEqual(after.ingredients, before.ingredients,
      "inventory lives outside `entities` — a restore that forgets it returns a store with a menu and no stock");
  });

  test("a till mid-sync converges after a restore instead of stalling on its cursor", async () => {
    const org = await H.registerOrg({ tag: "dr-sync" });
    await seedStore(org);
    /* What a device that was up to date before the disaster holds. */
    const firstPull = (await H.pull(org.token, 0)).json;
    const cursor = firstPull.rowver;
    assert.ok(cursor > 0);

    const backup = await H.req("POST", "/api/app2/backup", { cookie: org.cookie, body: { label: "drill" } });
    assert.equal(backup.status, 200);
    assert.equal((await H.req("POST", "/api/app2/reset", { cookie: org.cookie, body: { password: PW, backup: false } })).status, 200);
    assert.equal((await H.req("POST", "/api/app2/restore", { cookie: org.cookie, body: { password: PW, id: backup.json.id } })).status, 200);

    /* The restore re-stamps every row ABOVE the sequence high-water mark for
       exactly this reason: a till asking "what changed since <cursor>" must be
       handed the restored store, not an empty delta that leaves it showing the
       wiped one forever. */
    const delta = (await H.pull(org.token, cursor)).json;
    const kinds = new Set((delta.entities || []).map((e) => e.kind));
    assert.ok(kinds.has("sales") && kinds.has("products"),
      "a device holding a pre-disaster cursor must be served the restored rows, not an empty delta");
    assert.ok(delta.rowver > cursor, "the cursor must move past the restore");
  });

  test("restore is owner-only, password-gated, and cannot reach another tenant's backup", async () => {
    const org = await H.registerOrg({ tag: "dr-guard" });
    await seedStore(org);
    const backup = await H.req("POST", "/api/app2/backup", { cookie: org.cookie, body: { label: "drill" } });
    assert.equal(backup.status, 200);

    const noPw = await H.req("POST", "/api/app2/restore", { cookie: org.cookie, body: { id: backup.json.id } });
    assert.equal(noPw.status, 403, "a recovery tool anyone can fire is itself the disaster");

    const wrongPw = await H.req("POST", "/api/app2/restore", { cookie: org.cookie, body: { password: "nope", id: backup.json.id } });
    assert.equal(wrongPw.status, 403);

    const anon = await H.req("POST", "/api/app2/restore", { body: { password: PW, id: backup.json.id } });
    assert.equal(anon.status, 401);

    /* Another tenant, holding a real backup id, must not be able to pull this
       store's data into their own account. */
    const other = await H.registerOrg({ tag: "dr-other" });
    const crossed = await H.req("POST", "/api/app2/restore", { cookie: other.cookie, body: { password: PW, id: backup.json.id } });
    assert.equal(crossed.status, 404, "a backup id from another org must not resolve");

    // The store is still intact after all of that.
    const still = await census(org);
    assert.ok(still.byKind.sales >= 1);
  });

  test("the backup list reports what a restore would bring back", async () => {
    const org = await H.registerOrg({ tag: "dr-list" });
    await seedStore(org);
    assert.equal((await H.req("POST", "/api/app2/backup", { cookie: org.cookie, body: { label: "drill" } })).status, 200);
    const list = await H.req("GET", "/api/app2/backups", { cookie: org.cookie });
    assert.equal(list.status, 200);
    const b = (list.json.backups || [])[0];
    assert.ok(b, "a backup that cannot be listed cannot be chosen in an incident");
    assert.ok(b.createdAt > 0, "recovery-point objective is unanswerable without a timestamp on the copy");
    assert.ok(b.counts && Object.keys(b.counts).length,
      "an operator picking a restore point needs to see what is in it before firing it");
  });
});
