/* ═══ ALLERGEN AND DIET RULES — ONE TABLE, TWO RUNTIMES ═════════════════════
   The EU 14 declarable allergens, the diets a guest can filter by, and the
   single implementation that derives one from a recipe.

   This file is loaded BOTH ways on purpose:

     · the browser reads it as a plain script (window.KPOS_RULES), for the
       till and the back office, which hold recipes
     · the server requires it as a module, to derive what a dish contains and
       publish that onto the item — because a GUEST PHONE HOLDS NO RECIPE and
       must never be asked to work an allergen out for itself

   Two copies of "what counts as a nut" is two chances to poison somebody, so
   there is one copy and it lives here. A rule change reaches the till, the
   guest portal and the printed card in the same deploy.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KPOS_RULES = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Regulation 1169/2011 Annex II, in the order it is written there. `re`
  // matches an ingredient's NAME, `cat` an ingredient CATEGORY id — a dairy
  // category catches a cheese nobody spelled recognisably.
  var ALLERGENS = [
    { k: 'gluten', label: 'Gluten', icon: 'M12 3v18M12 7c-3-2-5 0-5 0s2 3 5 1M12 12c3-2 5 0 5 0s-2 3-5 1',
      re: /FLOUR|BREAD|PASTA|NOODLE|WHEAT|RYE\b|CRUMB|BUN\b|ROTI|CHAPATI|PASTRY|BATTER|SEMOL|COUSCOUS|BARLEY|BISCUIT|CRACKER|MALT/i },
    { k: 'crustacean', label: 'Crustaceans', icon: 'M12 3a7 7 0 0 0-7 7c0 5 7 11 7 11s7-6 7-11a7 7 0 0 0-7-7z',
      re: /PRAWN|SHRIMP|CRAB|LOBSTER|CRAYFISH|SCAMPI/i },
    { k: 'egg', label: 'Egg', icon: 'M12 2c-4 5-6 8-6 12a6 6 0 0 0 12 0c0-4-2-7-6-12z',
      re: /\bEGG|MAYON|MAYO\b|MERINGUE|AIOLI/i },
    { k: 'fish', label: 'Fish', icon: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM17 11h.01',
      re: /FISH|TUNA|SNAPPER|GROUPER|REEF|SALMON|ANCHOV|SARDIN|MAAS|GARUDHIY|RIHAAKURU|COD\b/i },
    { k: 'peanut', label: 'Peanut', icon: 'M9 4a4 4 0 1 0 0 8 4 4 0 1 0 0 8 4 4 0 1 0 6-3 4 4 0 1 0-6-3z',
      re: /PEANUT|GROUNDNUT/i },
    { k: 'soy', label: 'Soy', icon: 'M4 12c4-8 12-8 16 0-4 8-12 8-16 0z',
      re: /\bSOY|SOYA|TOFU|EDAMAME|MISO|TERIYAKI/i },
    // `not` is the exception list: coconut milk and coconut cream are not
    // dairy, and a vegan curry wrongly flagged is a dish a guest cannot order.
    { k: 'milk', label: 'Milk', icon: 'M8 2h8l-1 4v14H9V6z', cat: [3],
      catRe: /DAIRY|MILK/i,
      re: /MILK|CREAM|CHEESE|BUTTER|YOGH|GHEE|PANEER|MOZZAR|PARMES|CHEDDAR|MASCARP|CUSTARD/i,
      not: /COCONUT|ALMOND|SOY|SOYA|OAT|RICE MILK|CASHEW|PEANUT BUTTER|CACAO BUTTER|COCOA BUTTER|SHEA/i },
    { k: 'nuts', label: 'Tree nuts', icon: 'M12 2C8 6 6 9 6 13a6 6 0 0 0 12 0c0-4-2-7-6-11zM12 8v8',
      re: /CASHEW|ALMOND|WALNUT|PISTACH|HAZELNUT|PECAN|MACADAM|\bNUT\b|NUTS\b/i },
    { k: 'celery', label: 'Celery', icon: 'M12 3v18M8 7l4 4 4-4', re: /CELERY|CELERIAC/i },
    { k: 'mustard', label: 'Mustard', icon: 'M7 3h10l-1 18H8z', re: /MUSTARD|DIJON/i },
    { k: 'sesame', label: 'Sesame', icon: 'M12 4v16M6 8v8M18 8v8', re: /SESAME|TAHINI/i },
    { k: 'sulphite', label: 'Sulphites', icon: 'M12 3l9 16H3z',
      re: /WINE|VINEGAR|DRIED FRUIT|DRIED APRICOT|SULPH|SULFIT/i },
    { k: 'lupin', label: 'Lupin', icon: 'M12 3c3 4 3 8 0 12-3-4-3-8 0-12zM12 15v6', re: /LUPIN/i },
    { k: 'mollusc', label: 'Molluscs', icon: 'M4 18c2-9 14-9 16 0zM12 9V4',
      re: /SQUID|OCTOPUS|CALAMAR|MUSSEL|CLAM|OYSTER|SCALLOP|SNAIL/i }
  ];

  // `blocks` names allergens the diet cannot contain; `meat`, `pork` and
  // `alcohol` are the rules no ingredient regex expresses as an allergen.
  var DIETS = [
    { k: 'veg', label: 'Vegetarian', blocks: ['fish', 'crustacean', 'mollusc'], meat: true },
    { k: 'vegan', label: 'Vegan', blocks: ['fish', 'crustacean', 'mollusc', 'milk', 'egg'], meat: true },
    { k: 'halal', label: 'Halal', blocks: [], pork: true, alcohol: true },
    { k: 'gf', label: 'No gluten', blocks: ['gluten'] },
    { k: 'nutfree', label: 'No nuts', blocks: ['nuts', 'peanut'] },
    { k: 'dairyfree', label: 'No dairy', blocks: ['milk'] }
  ];

  var MEAT_RE = /BEEF|CHICKEN|MUTTON|LAMB|PORK|BACON|SAUSAGE|HAM\b|TURKEY|DUCK|VENISON|MEAT/i;
  var PORK_RE = /PORK|BACON|LARD|GAMMON|PANCETTA|CHORIZO|PROSCIUTTO|HAM\b/i;
  var ALCOHOL_RE = /WINE|BEER|RUM\b|VODKA|WHISK|BRANDY|LIQUEUR|SHERRY|MIRIN|VERMOUTH/i;

  // A "part" is one ingredient of a dish: { name, cat }, where `cat` is a
  // category id (the browser's raw tuple) or a category name (the server's
  // ingredient row) — both are matched. Both runtimes build
  // that list from where they keep recipes — the browser from KPOS_RAW, the
  // server from recipe_line — and nothing below knows which.
  function allergenKeys(parts, add) {
    var hit = {};
    (parts || []).forEach(function (p) {
      var name = String((p && p.name) || ''), cat = p && p.cat;
      ALLERGENS.forEach(function (a) {
        if (a.not && a.not.test(name)) return;
        var byCat = (a.cat && cat !== undefined && a.cat.indexOf(cat) >= 0)
          || (a.catRe && cat && a.catRe.test(String(cat)));
        if (byCat || a.re.test(name)) hit[a.k] = 1;
      });
    });
    // Additive only. A kitchen may declare a shared fryer that no ingredient
    // list shows; nobody may declare absent what the recipe says is present.
    (add || []).forEach(function (k) { hit[k] = 1; });
    return ALLERGENS.filter(function (a) { return hit[a.k]; }).map(function (a) { return a.k; });
  }

  function matches(parts, re) {
    return (parts || []).some(function (p) { return re.test(String((p && p.name) || '')); });
  }
  function hasMeat(parts) { return matches(parts, MEAT_RE); }

  // The diets a dish SUITS. Empty is the honest answer for a dish nobody has
  // written a recipe for: an unearned "Vegetarian" on a reef fish is worse
  // than no label at all.
  function dietKeys(parts, add, veg) {
    if (!parts || !parts.length) return [];
    var have = allergenKeys(parts, add);
    var meat = veg === true ? false : hasMeat(parts);
    return DIETS.filter(function (d) {
      if (d.meat && meat) return false;
      if (d.pork && matches(parts, PORK_RE)) return false;
      if (d.alcohol && matches(parts, ALCOHOL_RE)) return false;
      return !d.blocks.some(function (b) { return have.indexOf(b) >= 0; });
    }).map(function (d) { return d.k; });
  }

  return {
    ALLERGENS: ALLERGENS, DIETS: DIETS,
    MEAT_RE: MEAT_RE, PORK_RE: PORK_RE, ALCOHOL_RE: ALCOHOL_RE,
    allergenKeys: allergenKeys, hasMeat: hasMeat, dietKeys: dietKeys
  };
});
