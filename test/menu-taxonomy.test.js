/* Regression suite for the three-level MENU TAXONOMY and CSV import.

   Why this file exists: re-uploading a reorganised menu CSV left every previous
   category standing. Three separate defects stacked up.

     1. The import wrote settings.catOrder / settings.catGroups. The list every
        surface actually renders comes from mergeCategories(), which reads
        settings.menuCats — a key the import never touched. So "Replace the
        ENTIRE menu" replaced the dishes and left the old sections behind.
     2. mergeCategories emits every saved category whether or not a dish uses
        it. Correct for a manager who makes an empty section by hand; wrong
        after an import that declares the file IS the menu.
     3. The CSV could not express the hierarchy at all. It carried `category`
        but no group, so on every import the top-level group was re-GUESSED by
        keyword (/coffee|tea|juice/ → Drinks), silently discarding whatever the
        manager had chosen under "Show under".

   The rules these tests lock in:
     A. Replace makes the file the whole taxonomy — categories, groups,
        subcategories and the order of all three are exactly what the file says.
        Anything absent from the file is gone.
     B. Merge adds without removing: new sections appear, existing ones survive.
     C. group and subcategory round-trip through export → import unchanged.
     D. A file with no usable rows changes NOTHING — it must not tombstone the
        menu first and then discover it has nothing to put back.
     E. A legacy CSV with no group/subcategory columns still imports, and does
        not wipe the subcategories already on the dishes it doesn't mention. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

const HEAD = "id,name,name_dhivehi,group,category,subcategory,price_mvr,description";
const row = (name, group, cat, sub, price) => `,${name},,${group},${cat},${sub},${price},`;
const csv = (...rows) => [HEAD].concat(rows).join("\n");

const importCsv = (org, text, replace) =>
  H.req("POST", "/api/app2/menu/import", { cookie: org.cookie, body: { csv: text, replace: !!replace } });

/* The taxonomy as the terminal actually receives it, not as it is stored. */
async function categoriesOf(cookie) {
  const r = await fetch(H.BASE + "/v2", { headers: { Cookie: cookie } });
  const html = await r.text();
  const T = "window.KPOS_REAL=";
  const a = html.indexOf(T);
  assert.ok(a >= 0, "/v2 must inject window.KPOS_REAL for a signed-in owner");
  let b = html.indexOf(";window.KPOS_BUILD", a);
  if (b < 0) b = html.indexOf(";</script>", a);
  const real = JSON.parse(html.slice(a + T.length, b));
  return { cats: real.categories || [], menu: real.menu || [] };
}
const names = (cats) => cats.map((c) => c.name);
const byName = (cats, n) => cats.find((c) => c.name === n);

describe("menu taxonomy — CSV import", () => {
  test("Replace makes the file the whole taxonomy: old categories do not survive", async () => {
    const org = await H.registerOrg({ tag: "tax-replace" });
    let r = await importCsv(org, csv(
      row("Flat White", "Drinks", "Coffee", "Hot", 45),
      row("Chicken Biryani", "Food", "Rice", "", 120),
      row("Choc Fudge", "Desserts", "Cakes", "", 80)), true);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    let { cats } = await categoriesOf(org.cookie);
    assert.deepEqual(names(cats), ["Coffee", "Rice", "Cakes"], "first import establishes exactly its own categories");

    // The reorganisation: fewer categories, one renamed, one brand new.
    r = await importCsv(org, csv(
      row("Flat White", "Drinks", "Coffee", "Hot", 45),
      row("Chicken Biryani", "Food", "Mains", "", 120),
      row("Garlic Bread", "Food", "Sides", "", 30)), true);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    ({ cats } = await categoriesOf(org.cookie));
    assert.deepEqual(names(cats), ["Coffee", "Mains", "Sides"],
      "THE BUG: Rice and Cakes are not in the new file, so they must be gone — not left standing beside the new ones");
  });

  test("the file's group wins over the keyword guess", async () => {
    const org = await H.registerOrg({ tag: "tax-group" });
    // "Kurumba" matches the Drinks keyword list. The file says Food; the file wins.
    const r = await importCsv(org, csv(row("Kurumba Salad", "Food", "Kurumba", "", 60)), true);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { cats } = await categoriesOf(org.cookie);
    assert.equal(byName(cats, "Kurumba").group, "Food",
      "the group named in the file must beat catGroupOf()'s keyword guess");
  });

  test("subcategories arrive, in file order, on the right category", async () => {
    const org = await H.registerOrg({ tag: "tax-subs" });
    const r = await importCsv(org, csv(
      row("Margherita", "Food", "Pizza", "Classic", 110),
      row("Truffle", "Food", "Pizza", "Gourmet", 190),
      row("Pepperoni", "Food", "Pizza", "Classic", 130),
      row("Flat White", "Drinks", "Coffee", "Hot", 45)), true);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.subcategories, 3, "two Pizza sections + one Coffee section");

    const { cats, menu } = await categoriesOf(org.cookie);
    assert.deepEqual(byName(cats, "Pizza").subs, ["Classic", "Gourmet"], "file order, de-duplicated");
    assert.deepEqual(byName(cats, "Coffee").subs, ["Hot"]);
    const truffle = menu.find((m) => m.name === "Truffle");
    assert.equal(truffle.subcat, "Gourmet", "the dish carries its own section");
  });

  test("Replace drops a subcategory the new file no longer uses", async () => {
    const org = await H.registerOrg({ tag: "tax-subdrop" });
    await importCsv(org, csv(
      row("Margherita", "Food", "Pizza", "Classic", 110),
      row("Truffle", "Food", "Pizza", "Gourmet", 190)), true);
    let { cats } = await categoriesOf(org.cookie);
    assert.deepEqual(byName(cats, "Pizza").subs, ["Classic", "Gourmet"]);

    await importCsv(org, csv(row("Margherita", "Food", "Pizza", "Classic", 110)), true);
    ({ cats } = await categoriesOf(org.cookie));
    assert.deepEqual(byName(cats, "Pizza").subs, ["Classic"],
      "Gourmet has no dishes and is not in the file — it must not linger");
  });

  test("Merge adds without removing", async () => {
    const org = await H.registerOrg({ tag: "tax-merge" });
    await importCsv(org, csv(
      row("Flat White", "Drinks", "Coffee", "Hot", 45),
      row("Biryani", "Food", "Rice", "", 120)), true);

    const r = await importCsv(org, csv(row("Garlic Bread", "Food", "Sides", "Warm", 30)), false);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const { cats } = await categoriesOf(org.cookie);
    assert.deepEqual(names(cats), ["Coffee", "Rice", "Sides"],
      "a merge appends the new section and keeps the existing ones");
    assert.deepEqual(byName(cats, "Sides").subs, ["Warm"]);
  });

  test("group and subcategory round-trip through export → import", async () => {
    const org = await H.registerOrg({ tag: "tax-round" });
    await importCsv(org, csv(
      row("Kurumba Salad", "Food", "Kurumba", "Cold", 60),
      row("Latte", "Drinks", "Coffee", "Hot", 50)), true);

    const exp = await fetch(H.BASE + "/api/app2/menu/export", { headers: { Cookie: org.cookie } });
    assert.equal(exp.status, 200);
    const text = (await exp.text()).replace(/^﻿/, "");
    const head = text.split(/\r?\n/)[0].toLowerCase();
    assert.ok(head.includes("group"), "the template must carry a group column");
    assert.ok(head.includes("subcategory"), "the template must carry a subcategory column");

    // Re-importing the store's own export must be a no-op on the taxonomy —
    // the group is read back from the file, not re-guessed.
    const r = await importCsv(org, text, true);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { cats } = await categoriesOf(org.cookie);
    assert.equal(byName(cats, "Kurumba").group, "Food", "the exported group survived the round trip");
    assert.deepEqual(byName(cats, "Kurumba").subs, ["Cold"]);
    assert.deepEqual(byName(cats, "Coffee").subs, ["Hot"]);
  });

  test("a file with no usable rows changes nothing at all", async () => {
    const org = await H.registerOrg({ tag: "tax-empty" });
    await importCsv(org, csv(row("Biryani", "Food", "Rice", "", 120)), true);
    const before = await categoriesOf(org.cookie);
    assert.equal(before.menu.length, 1);

    // Every row priced at zero: valid CSV, no usable dish.
    const r = await importCsv(org, csv(row("Broken", "Food", "Rice", "", 0), row("Also broken", "Food", "Rice", "", 0)), true);
    assert.equal(r.status, 400, "a file that yields no dishes must be refused");

    const after = await categoriesOf(org.cookie);
    assert.equal(after.menu.length, 1, "Replace must NOT have tombstoned the menu before discovering it had nothing to put back");
    assert.deepEqual(names(after.cats), names(before.cats));
  });

  test("a legacy CSV with no group or subcategory columns still imports", async () => {
    const org = await H.registerOrg({ tag: "tax-legacy" });
    const legacy = ["id,name,category,price_mvr", ",Biryani,Rice,120", ",Latte,Coffee,45"].join("\n");
    const r = await importCsv(org, legacy, true);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const { cats } = await categoriesOf(org.cookie);
    assert.deepEqual(names(cats), ["Rice", "Coffee"]);
    assert.equal(byName(cats, "Coffee").group, "Drinks", "with no group column the keyword guess still applies");
    assert.deepEqual(byName(cats, "Rice").subs, [], "no subcategory column means no sections, not a crash");
  });

  test("a category a dish still points at is never dropped", async () => {
    const org = await H.registerOrg({ tag: "tax-orphan" });
    await importCsv(org, csv(row("Biryani", "Food", "Rice", "Spicy", 120)), true);
    // Add a dish by hand in a category the last import never mentioned.
    const p = await H.req("POST", "/api/app2/product", {
      cookie: org.cookie, body: { name: "House Salad", cat: "Salads", subcat: "Cold", price: 55 },
    });
    assert.equal(p.status, 200, JSON.stringify(p.json));

    const { cats } = await categoriesOf(org.cookie);
    assert.ok(byName(cats, "Salads"), "a category with a live dish must appear even though no import declared it");
    assert.deepEqual(byName(cats, "Salads").subs, ["Cold"], "and so must its section");
  });
});
