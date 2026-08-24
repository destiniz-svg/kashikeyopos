/* ═══ WHAT A KILO AS PURCHASED ACTUALLY PLATES — ONE TABLE, TWO RUNTIMES ════
   A recipe asks for 180g of reef fish on the plate. The kitchen does not take
   180g off the shelf to get it there — it takes a whole fish, fillets it, and
   throws most of the frame away. The fraction that survives is the YIELD, and
   the difference between the two figures is the difference between a stock
   ledger that ties and one that drifts a little every service.

   This file is loaded BOTH ways, for exactly the reason kashikeyo-rules.js is:

     · the browser reads it as a plain script (window.KPOS_YIELD), because the
       till expands the recipe when it settles a bill;
     · the server requires it as a module, because it re-derives that same
       expansion to check the till's arithmetic — and a check computed from a
       DIFFERENT table is not a check, it is a second opinion nobody asked
       for. Two copies of "how much of an onion is onion" is two answers, and
       the disagreement would present as a stock discrepancy on every sale.

   The table is an ESTIMATE and says so. An outlet that measures its own yield
   (`yield_test`) publishes the measurement, and the measurement wins — this is
   only what to assume until somebody has weighed it.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KPOS_YIELD = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* Matched on the ingredient's NAME, first hit wins, so the order is the
     rule: `fish` last among the fish so `reef fish` reaches its own row. */
  var TABLE = [
    [/tuna|reef fish|grouper|snapper|fish/i, 0.55, 0.04, 'whole fish, filleted in house'],
    [/octopus|squid|calamari/i, 0.62, 0.05, 'cleaned and beaked'],
    [/prawn|shrimp|lobster/i, 0.5, 0.05, 'shell on, deveined'],
    [/chicken/i, 0.7, 0.04, 'bone in, jointed'],
    [/beef|lamb|mutton|pork/i, 0.82, 0.05, 'primal, trimmed of fat'],
    [/onion|garlic|shallot|ginger/i, 0.85, 0.04, 'peeled'],
    [/potato|taro|yam|cassava|carrot|pumpkin/i, 0.8, 0.04, 'peeled'],
    [/coconut/i, 0.6, 0.05, 'husked and grated'],
    [/leaf|spinach|lettuce|herb|coriander|curry leaf|moringa/i, 0.72, 0.08, 'picked, stalks discarded'],
    [/tomato|pepper|capsicum|chilli|aubergine|brinjal/i, 0.88, 0.05, 'cored and deseeded'],
    [/lime|lemon|mango|papaya|pineapple|banana/i, 0.65, 0.05, 'peeled and stoned'],
    [/rice|flour|sugar|salt|oil|spice|powder|masala|pasta|lentil|dhal/i, 1, 0.02, 'dry store, measured'],
    [/milk|cream|yoghurt|butter|cheese|egg/i, 0.98, 0.02, 'chilled, portioned']
  ];

  /* An ingredient nobody has assessed is assumed WHOLE with a token trim loss.
     Assuming a loss nobody measured would be inventing a cost. */
  function shipped(name) {
    var hit = null;
    for (var i = 0; i < TABLE.length; i++) {
      if (TABLE[i][0].test(String(name || ''))) { hit = TABLE[i]; break; }
    }
    return hit
      ? { y: hit[1], w: hit[2], why: hit[3], set: false }
      : { y: 1, w: 0.02, why: 'no assessment yet', set: false };
  }

  /* The measurement if there is one, the estimate if there is not. `measured`
     is whatever the outlet published — `{ y, w }`, either half nullable. */
  function assess(name, measured) {
    if (measured && measured.y != null) {
      return { y: Number(measured.y),
        w: measured.w == null ? 0 : Number(measured.w),
        why: measured.why || 'measured at this outlet', set: true };
    }
    return shipped(name);
  }

  // The fraction of what you buy that reaches a plate. Floored, because a
  // yield of zero would make the gross quantity infinite.
  function netFactor(a) { return Math.max(0.05, a.y * (1 - a.w)); }

  // Purchased quantity needed to plate a given usable quantity.
  function grossQty(a, net) { return net / netFactor(a); }

  return { TABLE: TABLE, shipped: shipped, assess: assess,
    netFactor: netFactor, grossQty: grossQty };
});
