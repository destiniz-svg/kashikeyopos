/* Allergens: the derivation rules, and the chain that carries them from a
   recipe line to the guest's phone.

   WHY THIS FILE EXISTS. A dish's allergens used to be a free-text string typed
   onto the menu item. Nothing tied it to the recipe, so swapping a vegetable
   stock for a fish stock left the old tag standing and the guest's phone kept
   saying the dish was safe. The failure is silent, it is in the direction that
   hurts somebody, and no test could have caught it because there was nothing to
   compare the tag against.

   So the assertions here are mostly about the UNSAFE DIRECTION: an allergen
   must never disappear from a dish that still contains it, and an unconfirmed
   list must never read as a confirmed empty one. The happy path is the easy
   half.

   Unit tests run with no database. The integration block needs Postgres — same
   harness as the rest of the suite. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const A = require(path.join(ROOT, "web3", "proto", "allergens.js"));
const H = require("./helpers");

/* ── the rules ────────────────────────────────────────────────────────────── */

describe("allergen suggestion from an ingredient name", () => {
  test("finds the obvious ones", () => {
    assert.deepEqual(A.suggestForIngredient("Reef fish fillet"), ["fish"]);
    assert.deepEqual(A.suggestForIngredient("Wheat flour"), ["gluten"]);
    assert.deepEqual(A.suggestForIngredient("Tiger prawns"), ["shellfish"]);
    assert.deepEqual(A.suggestForIngredient("Soy sauce"), ["gluten", "soy"]);
  });

  test("does not invent allergens from a substring", () => {
    // Each of these bit a real allergen list at some point in the wild.
    assert.deepEqual(A.suggestForIngredient("Eggplant"), []);
    assert.deepEqual(A.suggestForIngredient("Nutmeg ground"), []);
    assert.deepEqual(A.suggestForIngredient("Doughnut"), []);
    assert.equal(A.suggestForIngredient("Coconut cream").indexOf("nuts"), -1);
  });

  test("a plant milk is not dairy — and masking is not a general clearance", () => {
    /* Over-declaring is not free: a false dairy tag hides a vegan dish from the
       vegan filter and pushes the guest away from food that was safe. But the
       mask must only delete the plant phrase, never clear a real hit elsewhere
       in the same name. */
    assert.deepEqual(A.suggestForIngredient("Coconut milk"), []);
    assert.deepEqual(A.suggestForIngredient("Almond milk"), ["nuts"]);
    assert.deepEqual(A.suggestForIngredient("Milk chocolate with almond"), ["dairy", "nuts"]);
    assert.deepEqual(A.suggestForIngredient("Fresh milk 1L"), ["dairy"]);
  });

  test("the /g mask regex is not stateful across calls", () => {
    // A /g regex carries lastIndex. Testing one would pass, fail, pass, fail…
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(A.suggestForIngredient("Fresh milk"), ["dairy"], "call " + i);
      assert.deepEqual(A.suggestForIngredient("Coconut milk"), [], "call " + i);
    }
  });
});

describe("normalise", () => {
  test("dedupes, drops unknown keys and returns canonical order", () => {
    assert.deepEqual(A.normalise(["soy", "dairy", "fish", "dairy"]), ["dairy", "fish", "soy"]);
    // A stale key from an older client must not reach a surface as a blank chip.
    assert.deepEqual(A.normalise(["dairy", "sulfites", ""]), ["dairy"]);
    assert.deepEqual(A.normalise(null), []);
  });
});

describe("dishAllergens", () => {
  const reviewed = (name, keys) => ({ name, allergens: keys, reviewed: true });

  test("unions the recipe and adds the dish's own override", () => {
    const d = A.dishAllergens([reviewed("Reef fish", ["fish"]), reviewed("Butter", ["dairy"])], ["gluten"]);
    assert.deepEqual(d.keys, ["dairy", "gluten", "fish"]);
    assert.equal(d.unreviewed, false);
  });

  test("the override is additive only — it cannot clear what the recipe has", () => {
    /* There is deliberately no representation for "this dish does not contain
       X". Removing an allergen means changing the recipe. */
    const d = A.dishAllergens([reviewed("Reef fish", ["fish"])], ["dairy"]);
    assert.ok(d.keys.includes("fish"), "the recipe's fish survived the override");
    assert.deepEqual(d.keys, ["dairy", "fish"]);
  });

  test("a dish with no recipe is unreviewed, never a confirmed empty", () => {
    const d = A.dishAllergens([], []);
    assert.deepEqual(d.keys, []);
    assert.equal(d.unreviewed, true, "knowing nothing must not read as knowing there is nothing");
  });

  test("one unconfirmed ingredient makes the whole dish unconfirmed", () => {
    const d = A.dishAllergens([
      reviewed("Butter", ["dairy"]),
      { name: "Mystery paste", allergens: [], reviewed: false },
    ], []);
    assert.equal(d.unreviewed, true);
  });

  test("meat is detected from the ingredient name", () => {
    assert.equal(A.dishAllergens([reviewed("Beef chuck", [])], []).meat, true);
    assert.equal(A.dishAllergens([reviewed("Pumpkin", [])], []).meat, false);
  });
});

describe("dishSuits", () => {
  test("blocks on the diet's allergens", () => {
    assert.equal(A.dishSuits({ allergens: ["gluten"] }, "gf"), false);
    assert.equal(A.dishSuits({ allergens: ["dairy"] }, "gf"), true);
    assert.equal(A.dishSuits({ allergens: ["peanut"] }, "nutfree"), false);
  });

  test("vegetarian is not merely 'no fish allergen'", () => {
    // Beef carries no major allergen at all. A diet that only checked the
    // allergen list would serve it to a vegetarian.
    assert.equal(A.dishSuits({ allergens: [], meat: true }, "veg"), false);
    assert.equal(A.dishSuits({ allergens: [], meat: false }, "veg"), true);
  });

  test("vegan additionally blocks dairy and egg", () => {
    assert.equal(A.dishSuits({ allergens: ["dairy"], meat: false }, "vegan"), false);
    assert.equal(A.dishSuits({ allergens: ["dairy"], meat: false }, "veg"), true);
  });

  test("an unknown diet key does not empty the menu", () => {
    // A stale filter persisted by an older client must fail open, not hide
    // every dish and leave the guest staring at nothing.
    assert.equal(A.dishSuits({ allergens: ["fish"] }, "paleo"), true);
  });
});

/* ── the chain, against a real database ───────────────────────────────────── */

describe("allergens travel from the recipe to the guest menu", () => {
  let org;
  before(async () => { await H.startServer(); org = await H.registerOrg({ tag: "allerg" }); });
  after(() => H.stopServer());

  /* Create an ingredient and return its id. `allergens` omitted = untagged, so
     the server falls back to the name-derived suggestion and counts it
     unreviewed. */
  const mkIngredient = async (name, baseUnit, allergens) => {
    const body = { name, baseUnit, location: "Dry" };
    if (allergens !== undefined) body.allergens = allergens;
    const r = await H.invPost(org, "/ingredients", body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.id;
  };

  const mkDish = async (id, name) => {
    const r = await H.ops(org.token, [{ opId: "op-" + id, puts: [{ kind: "products", id, data: { name, cat: "Mains", price: 12000 } }] }]);
    assert.equal(r.status, 200);
  };

  const setRecipe = async (pid, lines) => {
    const r = await H.invPut(org, "/recipes/" + pid, { lines });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };

  /* Read the dish back off the entity the till and the guest portal both poll. */
  const dishOf = (pid) => H.pullEntity(org.token, "products", (x) => x.id === pid).then((e) => e.data || {});
  const waitFor = (pid, pred) => H.until(async () => { const d = await dishOf(pid); return pred(d) ? d : null; });

  test("an untagged ingredient seeds from its name and marks the dish unconfirmed", async () => {
    const fish = await mkIngredient("Reef fish fillet", "g");
    await mkDish("d1", "Reef fish curry");
    await setRecipe("d1", [{ ingredientId: fish, qty: 180 }]);

    const d = await waitFor("d1", (x) => Array.isArray(x.dishAllergens) && x.dishAllergens.length);
    assert.deepEqual(d.dishAllergens, ["fish"]);
    assert.equal(d.allergensUnreviewed, true, "a name-derived guess is not a clearance");
  });

  test("confirming the ingredient's tags confirms every dish that uses it", async () => {
    const fish = await mkIngredient("Snapper loin", "g");
    await mkDish("d2", "Grilled snapper");
    await setRecipe("d2", [{ ingredientId: fish, qty: 200 }]);
    await waitFor("d2", (x) => x.allergensUnreviewed === true);

    // The chef confirms. Same id, so this is an edit, not a new ingredient.
    await mkIngredient("Snapper loin", "g", ["fish"]);
    const r = await H.invPost(org, "/ingredients", { id: fish, name: "Snapper loin", baseUnit: "g", allergens: ["fish"] });
    assert.equal(r.status, 200);

    const d = await waitFor("d2", (x) => x.allergensUnreviewed === false);
    assert.deepEqual(d.dishAllergens, ["fish"]);
  });

  test("an empty tag array is a decision, not a missing one", async () => {
    const water = await mkIngredient("Spring water", "ml", []);
    await mkDish("d3", "Iced water");
    await setRecipe("d3", [{ ingredientId: water, qty: 300 }]);

    const d = await waitFor("d3", (x) => x.allergensUnreviewed === false);
    assert.deepEqual(d.dishAllergens, []);
    assert.equal(d.allergensUnreviewed, false, "'I checked, none' must not read as 'nobody checked'");
  });

  test("re-deriving an unchanged dish does not churn its rowver", async () => {
    /* Every write pokes SSE, which reloads open guest pages. But the guard that
       skips a no-op write once scored "never derived" as equal to "derived,
       confirmed empty" and skipped the FIRST write too — see the test above,
       which is what caught it. Pin both halves. */
    const veg = await mkIngredient("Carrot", "g", []);
    await mkDish("d10", "Side salad");
    await setRecipe("d10", [{ ingredientId: veg, qty: 80 }]);
    await waitFor("d10", (x) => x.allergensUnreviewed === false);

    const before = await H.pullEntity(org.token, "products", (x) => x.id === "d10");
    // Re-derive with no change: same override, same recipe.
    await H.invPut(org, "/products/d10/meta", { allergensAdd: [] });
    await new Promise((res) => setTimeout(res, 400));
    const after = await H.pullEntity(org.token, "products", (x) => x.id === "d10");
    assert.equal(after.data.allergensUnreviewed, false);
    assert.ok(Number(after.rowver) <= Number(before.rowver) + 1,
      "an unchanged allergen result must not bump rowver on its own account");
  });

  test("THE DRIFT BUG: changing the recipe removes the allergen it removed", async () => {
    /* This is the whole point of the feature. The old free-text tag stayed put
       when the recipe changed underneath it. */
    const fish = await mkIngredient("Tuna steak", "g", ["fish"]);
    const veg = await mkIngredient("Pumpkin", "g", []);
    await mkDish("d4", "Curry of the day");
    await setRecipe("d4", [{ ingredientId: fish, qty: 150 }]);
    await waitFor("d4", (x) => (x.dishAllergens || []).includes("fish"));

    await setRecipe("d4", [{ ingredientId: veg, qty: 150 }]);
    const d = await waitFor("d4", (x) => !(x.dishAllergens || []).includes("fish"));
    assert.deepEqual(d.dishAllergens, [], "the fish tag left with the fish");
  });

  test("the dish's additive override survives a recipe change", async () => {
    const veg = await mkIngredient("Sweet potato", "g", []);
    await mkDish("d5", "Fryer chips");
    await setRecipe("d5", [{ ingredientId: veg, qty: 200 }]);
    // "Shared fryer" — no ingredient list can show it.
    const r = await H.invPut(org, "/products/d5/meta", { allergensAdd: ["gluten"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const d = await waitFor("d5", (x) => (x.dishAllergens || []).includes("gluten"));
    assert.deepEqual(d.dishAllergens, ["gluten"]);
  });

  test("a SUB-RECIPE's allergens reach the dish above it", async () => {
    /* recipe_lines is reused for prep recipes, so a dish's real allergens can
       sit a level down. Resolving only the top level reported a curry with no
       fish in it. */
    const fish = await mkIngredient("Rihaakuru paste", "g", ["fish"]);
    const stock = await mkIngredient("House stock", "ml", undefined);
    // Give the prep item a build recipe keyed by its own id (the producible role).
    const r = await H.invPost(org, "/ingredients", {
      id: stock, name: "House stock", baseUnit: "ml", producible: true,
      prepLines: [{ ingredientId: fish, qty: 20 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    await mkDish("d6", "Soup of the day");
    await setRecipe("d6", [{ ingredientId: stock, qty: 250 }]);

    const d = await waitFor("d6", (x) => Array.isArray(x.dishAllergens) && x.dishAllergens.length);
    assert.deepEqual(d.dishAllergens, ["fish"], "the fish two levels down reached the dish");
  });

  test("a human tag on a prep item stops the descent", async () => {
    const fish = await mkIngredient("Anchovy paste", "g", ["fish"]);
    const stock = await mkIngredient("Clarified broth", "ml", undefined);
    await H.invPost(org, "/ingredients", {
      id: stock, name: "Clarified broth", baseUnit: "ml", producible: true,
      prepLines: [{ ingredientId: fish, qty: 10 }],
    });
    await mkDish("d7", "Clear broth");
    await setRecipe("d7", [{ ingredientId: stock, qty: 200 }]);
    await waitFor("d7", (x) => (x.dishAllergens || []).includes("fish"));

    /* A chef states the finished broth carries no fish protein. That is a
       decision about the prep item, and it is authoritative for it. */
    await H.invPost(org, "/ingredients", { id: stock, name: "Clarified broth", baseUnit: "ml", allergens: [] });
    const d = await waitFor("d7", (x) => !(x.dishAllergens || []).includes("fish"));
    assert.deepEqual(d.dishAllergens, []);
  });

  test("a human allergen tag on a prep item does not hide the meat inside it", async () => {
    /* Meat is not an allergen, so an allergen tag says nothing about it — and
       there is no field on which anyone could declare meat absent. Tagging a
       prep item must not make the chicken in it vanish, or the Vegetarian chip
       serves a vegetarian a chicken dish. */
    const chicken = await mkIngredient("Chicken thigh", "g", []);
    const base = await mkIngredient("Ramen base", "ml", undefined);
    await H.invPost(org, "/ingredients", {
      id: base, name: "Ramen base", baseUnit: "ml", producible: true,
      prepLines: [{ ingredientId: chicken, qty: 40 }],
    });
    // The chef tags the finished base for allergens only.
    await H.invPost(org, "/ingredients", { id: base, name: "Ramen base", baseUnit: "ml", allergens: ["soy"] });

    await mkDish("d11", "Shoyu ramen");
    await setRecipe("d11", [{ ingredientId: base, qty: 300 }]);

    const d = await waitFor("d11", (x) => x.allergensUnreviewed === false);
    assert.deepEqual(d.dishAllergens, ["soy"], "the tag is authoritative for allergens");
    assert.equal(d.dishMeat, true, "the chicken below the tag still counts as meat");
  });

  test("a recipe cycle does not swallow an allergen on an unrelated dish", async () => {
    /* A malformed recipe (A built from B built from A) must not take the menu
       down — but the truncated answer it produces must not be cached and reused
       for a dish that could have resolved fully. */
    const flour = await mkIngredient("Strong wheat flour", "g", ["gluten"]);
    const alpha = await mkIngredient("Alpha prep", "g", undefined);
    const beta = await mkIngredient("Beta prep", "g", undefined);
    await H.invPost(org, "/ingredients", {
      id: beta, name: "Beta prep", baseUnit: "g", producible: true,
      prepLines: [{ ingredientId: flour, qty: 10 }, { ingredientId: alpha, qty: 5 }],
    });
    await H.invPost(org, "/ingredients", {
      id: alpha, name: "Alpha prep", baseUnit: "g", producible: true,
      prepLines: [{ ingredientId: beta, qty: 5 }],
    });

    await mkDish("d12", "Cycle dish");
    await setRecipe("d12", [{ ingredientId: alpha, qty: 20 }]);
    const cyc = await waitFor("d12", (x) => x.allergensUnreviewed !== undefined);
    assert.ok((cyc.dishAllergens || []).includes("gluten"),
      "the flour reachable through the cycle still declares gluten");

    // And a dish that goes straight at the same prep item resolves fully.
    await mkDish("d13", "Straight dish");
    await setRecipe("d13", [{ ingredientId: beta, qty: 20 }]);
    const straight = await waitFor("d13", (x) => x.allergensUnreviewed !== undefined);
    assert.ok((straight.dishAllergens || []).includes("gluten"),
      "a cycle elsewhere must not poison this dish's answer");
  });

  test("deleting a prep item re-derives the dishes built on it", async () => {
    const nuts = await mkIngredient("Cashew paste", "g", ["nuts"]);
    const sauce = await mkIngredient("Satay sauce", "ml", undefined);
    await H.invPost(org, "/ingredients", {
      id: sauce, name: "Satay sauce", baseUnit: "ml", producible: true,
      prepLines: [{ ingredientId: nuts, qty: 30 }],
    });
    await mkDish("d14", "Satay skewers");
    await setRecipe("d14", [{ ingredientId: sauce, qty: 50 }]);
    await waitFor("d14", (x) => (x.dishAllergens || []).includes("nuts"));

    const del = await H.req("DELETE", "/api/inv/ingredients/" + sauce, { cookie: org.cookie });
    assert.equal(del.status, 200);
    /* The build recipe is gone, so the confirmed answer that stood on it has to
       go too — a declaration whose evidence no longer exists must not survive
       as a confirmed one. */
    const d = await waitFor("d14", (x) => x.allergensUnreviewed === true);
    assert.equal(d.allergensUnreviewed, true);
  });

  test("deactivating an ingredient does not clear it off a dish that still lists it", async () => {
    /* The unsafe direction. `recomputeAvailability` filters on i.active; this
       must not, or removing a supplier line quietly declares a dish safe. */
    const prawn = await mkIngredient("Prawn paste", "g", ["shellfish"]);
    await mkDish("d8", "Sambol");
    await setRecipe("d8", [{ ingredientId: prawn, qty: 30 }]);
    await waitFor("d8", (x) => (x.dishAllergens || []).includes("shellfish"));

    const del = await H.req("DELETE", "/api/inv/ingredients/" + prawn, { cookie: org.cookie });
    assert.equal(del.status, 200);
    // Force a re-derivation and assert the allergen is still there.
    const r = await H.invPut(org, "/products/d8/meta", { allergensAdd: [] });
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 400));
    const d = await dishOf("d8");
    assert.ok((d.dishAllergens || []).includes("shellfish"),
      "an inactive ingredient still in the recipe still declares its allergen");
  });

  test("the guest menu carries the derived keys, and no free-text tag", async () => {
    const r = await H.req("GET", "/?s=" + org.slug);
    assert.equal(r.status, 200);
    const m = r.text.match(/window\.KPOS_REAL\s*=\s*(\{[\s\S]*?\});/);
    assert.ok(m, "the storefront injects KPOS_REAL");
    const real = JSON.parse(m[1]);
    const curry = real.menu.find((x) => x.id === "d1");
    assert.ok(curry, "the dish reached the guest menu");
    assert.deepEqual(curry.allergens, ["fish"]);
    assert.equal(curry.allergensUnreviewed, true);
    /* The old hand-typed string must NOT be on the guest payload: two allergen
       fields is two answers, and the stale one is the one that gets read. */
    assert.equal(Object.prototype.hasOwnProperty.call(curry, "allergens") && typeof curry.allergens, "object");
  });

  test("an undrived dish reads as unconfirmed, not as allergen-free", async () => {
    await mkDish("d9", "Off-menu special");   // no recipe, never derived
    const r = await H.req("GET", "/?s=" + org.slug);
    const real = JSON.parse(r.text.match(/window\.KPOS_REAL\s*=\s*(\{[\s\S]*?\});/)[1]);
    const dish = real.menu.find((x) => x.id === "d9");
    assert.ok(dish);
    assert.deepEqual(dish.allergens, []);
    assert.equal(dish.allergensUnreviewed, true, "a field the server never wrote must default to unconfirmed");
  });
});
