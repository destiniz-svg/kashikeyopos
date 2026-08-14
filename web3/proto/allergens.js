/* allergens.js — the ONE allergen and diet derivation for KashikeyoPOS.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A dish's allergens used to be a free-text string typed onto the menu item
 * (`data.allergens`, "fish, dairy"). That is a duplicated fact: change the
 * recipe and the tag silently lies, in the direction that hurts somebody. The
 * kitchen swaps a stock for a fish stock, the recipe row changes, and the
 * guest's phone still says the dish is safe.
 *
 * So the fact is stored ONCE, on the ingredient, and every dish that uses that
 * ingredient inherits it. A recipe edit re-derives the dishes it touched, the
 * product entity's rowver bumps, and the till and the guest's phone both see
 * the new list on their next poll. Nobody re-types anything.
 *
 * Three copies of an allergen rule is three chances to poison somebody, so
 * this module is the only implementation: the browser loads it as a script
 * (there is no build step in this repo), Node `require`s the same file for the
 * server-side derivation and the tests. Same shape as money.js, for the same
 * reason.
 *
 * THE MODEL (decided, not inferred)
 * ---------------------------------
 * 1. The INGREDIENT is authoritative. `ingredients.allergens` is a real column
 *    a chef can edit, not a guess made at render time.
 * 2. A new ingredient is SEEDED from its name by `suggestForIngredient()` and
 *    marked `auto`. That is a starting point so an existing pantry is not
 *    blank, never a verified declaration. A human edit marks the row `manual`
 *    and the seeder never touches it again.
 * 3. A dish's allergens are the UNION over its recipe's ingredients, plus a
 *    per-dish additive override for what no ingredient list can show — a
 *    shared fryer, a dusted worktop. ADDITIVE ONLY: nobody may declare absent
 *    an allergen the recipe says is present.
 * 4. Diets are the ABSENCE of things, derived from the same union rather than
 *    being a second flag someone has to remember to keep in step.
 * 5. A dish with any still-`auto` ingredient is `unreviewed`. The surfaces say
 *    "ask our team to confirm" rather than implying a verified absence, because
 *    a regex on a supplier's product name is a suggestion and presenting it as
 *    a clearance is the one failure mode that puts somebody in hospital.
 *
 * The list is build 4's eleven plus celery and lupin. Those two are majors that
 * must be declared and cost nothing to carry; omitting an allergen is a safety
 * and compliance failure, not a design choice, and the chips render identically.
 *
 * Dual-mode: attaches to window for the browser and exports for CommonJS.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.KPOS_ALLERGENS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* `re` matches an ingredient NAME — the level a chef actually reasons at, and
     the level a delivery note is written at. Word boundaries and lookaheads
     where a substring would otherwise catch an unrelated word: \bEGG(?!PLANT)
     spares the aubergine, \bNUTS?\b spares "NUTMEG", "COCONUT" and "DOUGHNUT".
     Icons are 24×24 path data, drawn in the caller's stroke.
     `mask` is an optional set of phrases DELETED from the name before `re` is
     tested — "coconut milk" is not dairy, and over-declaring it would hide a
     vegan dish from the vegan filter, pushing a guest away from food that was
     safe for them. Masking a phrase is not the same as clearing an allergen:
     "milk chocolate with almond" still reads as dairy, because only the plant
     phrase itself is removed. Written as phrase deletion rather than a
     lookbehind on purpose — Safari only learned lookbehind in 16.4 and a
     SyntaxError here would take down the whole guest page on an older phone. */
  var ALLERGENS = [
    { k: "dairy", label: "Dairy", icon: "M8 2h8l-1 4v14H9V6z",
      mask: /(COCONUT|ALMOND|SOYA?|OAT|RICE|CASHEW|HEMP|PLANT)\s*-?\s*(MILK|CREAM)|NON\s*-?\s*DAIRY|DAIRY\s*-?\s*FREE/gi,
      re: /MILK|CREAM|CHEESE|BUTTER|YOGH|YOGU|GHEE|PANEER|MOZZAR|PARMES|CHEDDAR|MASCARP|RICOTTA|CUSTARD|CONDENSED|EVAPORATED/i },
    { k: "gluten", label: "Gluten", icon: "M12 3v18M12 7c-3-2-5 0-5 0s2 3 5 1M12 12c3-2 5 0 5 0s-2 3-5 1",
      re: /FLOUR|BREAD|PASTA|NOODLE|WHEAT|CRUMB|\bBUN|ROTI|CHAPATI|PASTRY|BATTER|SEMOL|COUSCOUS|BARLEY|\bRYE\b|SPELT|BISCUIT|CRACKER|SOY SAUCE|SEITAN/i },
    { k: "fish", label: "Fish", icon: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM17 11h.01",
      re: /FISH|TUNA|SNAPPER|REEF|SALMON|ANCHOV|SARDIN|MAAS|GARUDHIY|RIHAAKUR|\bCOD\b|MACKEREL|GROUPER|WAHOO|BONITO|KATSU/i },
    { k: "shellfish", label: "Shellfish", icon: "M12 3a7 7 0 0 0-7 7c0 5 7 11 7 11s7-6 7-11a7 7 0 0 0-7-7z",
      re: /PRAWN|SHRIMP|CRAB|LOBSTER|SQUID|OCTOPUS|CALAMAR|CLAM|MUSSEL|OYSTER|SCALLOP|CRAYFISH|\bKRILL/i },
    { k: "egg", label: "Egg", icon: "M12 2c-4 5-6 8-6 12a6 6 0 0 0 12 0c0-4-2-7-6-12z",
      re: /\bEGG(?!PLANT)|MAYON|MERINGUE|AIOLI|HOLLANDAISE/i },
    { k: "nuts", label: "Tree nuts", icon: "M12 2C8 6 6 9 6 13a6 6 0 0 0 12 0c0-4-2-7-6-11zM12 8v8",
      re: /CASHEW|ALMOND|WALNUT|PISTACH|HAZELNUT|PECAN|MACADAM|BRAZIL NUT|PINE NUT|\bNUTS\b/i },
    { k: "peanut", label: "Peanut", icon: "M9 4a4 4 0 1 0 0 8 4 4 0 1 0 0 8 4 4 0 1 0 6-3 4 4 0 1 0-6-3z",
      re: /PEANUT|GROUNDNUT/i },
    { k: "soy", label: "Soy", icon: "M4 12c4-8 12-8 16 0-4 8-12 8-16 0z",
      re: /\bSOY|SOYA|TOFU|EDAMAME|MISO|TERIYAKI|TEMPEH/i },
    { k: "sesame", label: "Sesame", icon: "M12 4v16M6 8v8M18 8v8", re: /SESAME|TAHINI|\bHALVA/i },
    { k: "mustard", label: "Mustard", icon: "M7 3h10l-1 18H8z", re: /MUSTARD/i },
    { k: "sulphite", label: "Sulphites", icon: "M12 3l9 16H3z", re: /\bWINE\b|VINEGAR|DRIED FRUIT|SULPH|SULFIT/i },
    { k: "celery", label: "Celery", icon: "M9 3v14a3 3 0 0 0 6 0V3M12 8h3", re: /CELERY|CELERIAC/i },
    { k: "lupin", label: "Lupin", icon: "M12 21V9M12 9l-4-3M12 9l4-3M12 14l-4-3M12 14l4-3", re: /LUPIN/i },
  ];

  /* Diets are the absence of things. `meat: true` additionally requires that no
     ingredient reads as flesh — "vegetarian" is not merely "no fish allergen". */
  var DIETS = [
    { k: "veg", label: "Vegetarian", blocks: ["fish", "shellfish"], meat: true },
    { k: "vegan", label: "Vegan", blocks: ["fish", "shellfish", "dairy", "egg"], meat: true },
    { k: "gf", label: "No gluten", blocks: ["gluten"] },
    { k: "nutfree", label: "No nuts", blocks: ["nuts", "peanut"] },
    { k: "dairyfree", label: "No dairy", blocks: ["dairy"] },
  ];

  var MEAT_RE = /BEEF|CHICKEN|MUTTON|LAMB|PORK|BACON|SAUSAGE|\bHAM\b|TURKEY|\bDUCK\b|VENISON|\bVEAL\b|GELATIN|LARD|\bMEAT/i;

  var BY_KEY = {};
  ALLERGENS.forEach(function (a) { BY_KEY[a.k] = a; });
  var VALID = function (k) { return Object.prototype.hasOwnProperty.call(BY_KEY, k); };

  /* Keep a caller's arbitrary list to keys this module knows, deduplicated and
     in the canonical display order — so two dishes never render the same set of
     allergens in a different order, and a stale key from an older client is
     dropped rather than rendered as an empty chip. */
  function normalise(keys) {
    var seen = {};
    (keys || []).forEach(function (k) { k = String(k || "").trim().toLowerCase(); if (VALID(k)) seen[k] = 1; });
    return ALLERGENS.filter(function (a) { return seen[a.k]; }).map(function (a) { return a.k; });
  }

  /* The seed for a NEW ingredient, from its name. A suggestion, never a
     clearance — see the header. Returns canonical order. */
  function suggestForIngredient(name) {
    var s = String(name || "");
    if (!s.trim()) return [];
    return ALLERGENS.filter(function (a) {
      // `mask` carries the /g flag, so replace() is safe but test() would be
      // stateful — never test a /g regex, and rebuild the string per allergen.
      return a.re.test(a.mask ? s.replace(a.mask, " ") : s);
    }).map(function (a) { return a.k; });
  }

  function nameHasMeat(name) { return MEAT_RE.test(String(name || "")); }

  /* A dish's allergens: the union over its recipe's ingredients, plus the
     dish's own additive override. `ingredients` is the recipe's ingredient rows
     as [{ allergens: [keys], name, reviewed: bool }]. `addKeys` is the manual
     addition for what no ingredient list can show.
     `unreviewed` is true when any contributing ingredient is still the
     name-derived guess, so the surfaces can say so instead of implying a
     verified absence. A dish with NO recipe is unreviewed by definition: we
     know nothing about it, and "no allergens" would be a lie of omission. */
  function dishAllergens(ingredients, addKeys) {
    var rows = ingredients || [], keys = [], unreviewed = !rows.length, meat = false;
    rows.forEach(function (r) {
      if (!r) return;
      normalise(r.allergens).forEach(function (k) { keys.push(k); });
      if (r.reviewed !== true) unreviewed = true;
      if (nameHasMeat(r.name)) meat = true;
    });
    normalise(addKeys).forEach(function (k) { keys.push(k); });
    return { keys: normalise(keys), meat: meat, unreviewed: !!unreviewed };
  }

  /* Does a dish suit a diet? `dish` is { allergens: [keys], meat: bool }.
     Unknown diet key → true, so a stale filter from an older client never hides
     the whole menu. An UNREVIEWED dish is not filtered out here: the caller
     decides whether to show it with a caveat (the guest portal does) or hide
     it. Hiding silently would tell a guest the dish does not exist, which is
     its own kind of wrong answer. */
  function dishSuits(dish, dietKey) {
    var d = null;
    DIETS.forEach(function (x) { if (x.k === dietKey) d = x; });
    if (!d) return true;
    if (d.meat && dish && dish.meat) return false;
    var have = normalise(dish && dish.allergens);
    return !d.blocks.some(function (b) { return have.indexOf(b) >= 0; });
  }

  function labelsFor(keys) {
    return normalise(keys).map(function (k) { return BY_KEY[k].label; });
  }

  return {
    ALLERGENS: ALLERGENS, DIETS: DIETS, MEAT_RE: MEAT_RE, BY_KEY: BY_KEY,
    normalise: normalise, suggestForIngredient: suggestForIngredient,
    nameHasMeat: nameHasMeat, dishAllergens: dishAllergens, dishSuits: dishSuits,
    labelsFor: labelsFor,
  };
});
