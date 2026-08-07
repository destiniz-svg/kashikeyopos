/* Client-side menu artwork — the browser twin of menuArtifact() in index.js.
 * Every dish tile layers its photo OVER a category-keyed placeholder (CSS
 * multi-background), so a photo that fails to load — an unreachable external
 * URL, a hotlink block, an offline till — falls through to a branded tile
 * instead of a blank square. Shared by the QR portal, the v2 terminal and the
 * member portal so all three agree on the artwork. window.kposCatArt(category)
 * returns a `data:image/svg+xml` URI, memoised per category (≤ a few dozen). */
(function () {
  if (window.kposCatArt) return;
  var ICONS = {
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
    cup: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z"/><path d="M6 1v3M10 1v3"/>',
    glass: '<path d="M5 3h14l-1.4 8a4 4 0 0 1-3.95 3.3h-3.3A4 4 0 0 1 6.4 11Z"/><path d="M12 14.3V21M8 21h8"/>',
    pizza: '<path d="m2 16 20 6-6-20A20 20 0 0 0 2 16"/><path d="M5.7 17.1a17 17 0 0 1 11.4-11.4"/><path d="M15 11h.01M11 15h.01"/>',
    burger: '<path d="M3 8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M3 12h18M3 16h18"/><path d="M4 16a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4"/>',
    fish: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/><path d="M18 12v.01"/><path d="M2.5 6C4 8 4 16 2.5 18"/>',
    bowl: '<path d="M2 12h20a10 10 0 0 1-20 0Z"/><path d="M4 9c1.5-2 5-2 6.5 0M13 9c1.5-2 5-2 6.5 0"/>',
    egg: '<path d="M12 3c4.5 0 7 7 7 11a7 7 0 0 1-14 0c0-4 2.5-11 7-11Z"/>',
    cake: '<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20M12 4v7M12 4h.01"/>',
    utensils: '<path d="M3 2v7a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2V2M6 2v20"/><path d="M18 2a4 4 0 0 0-4 4v5a2 2 0 0 0 2 2h2Zm0 0v20"/>',
    plate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>'
  };
  function theme(cat) {
    var s = String(cat || '').toLowerCase(), t = function (re) { return re.test(s); };
    if (t(/coffee|espresso|lavazza|illy|nescaf|crema|latte|cappucc|americano|macchiato|mocha/)) return { i: 'coffee', a: '#3f2617', b: '#7a4a26' };
    if (t(/\btea\b|local-tea|local tea/)) return { i: 'cup', a: '#5a4a1e', b: '#94793a' };
    if (t(/juice|smoothie|shake|milkshake|mojito|mocktail|frappe|soft|soda|water|drink/)) return { i: 'glass', a: '#155e50', b: '#2fa07f' };
    if (t(/pizza/)) return { i: 'pizza', a: '#9a3d1a', b: '#cf6a2c' };
    if (t(/burger|sandwich|submarine|panini|wrap/)) return { i: 'burger', a: '#6f4218', b: '#a86e2c' };
    if (t(/fish|seafood|grill/)) return { i: 'fish', a: '#175066', b: '#2f86a8' };
    if (t(/rice|noodle|biryani|nasi|bami|kottu|pasta/)) return { i: 'bowl', a: '#7a4e18', b: '#b3812c' };
    if (t(/curry|special/)) return { i: 'bowl', a: '#8a3418', b: '#bf5e2c' };
    if (t(/breakfast/)) return { i: 'egg', a: '#7a5c16', b: '#c19a2c' };
    if (t(/sweet|dessert|treat|cake|pastr|bakery/)) return { i: 'cake', a: '#8a2450', b: '#c74a86' };
    if (t(/savory|savoury|baked|fried|snack|side|condiment/)) return { i: 'utensils', a: '#6f5218', b: '#a8862c' };
    return { i: 'plate', a: '#4a3a2a', b: '#836a4e' };
  }
  var CACHE = {};
  window.kposCatArt = function (cat) {
    var key = String(cat || '').toLowerCase();
    if (CACHE[key]) return CACHE[key];
    var th = theme(cat), icon = ICONS[th.i] || ICONS.plate;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
      + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + th.a + '"/><stop offset="1" stop-color="' + th.b + '"/></linearGradient></defs>'
      + '<rect width="400" height="300" fill="url(#g)"/>'
      + '<g transform="translate(200 150) scale(4.6)" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(-12 -12)">' + icon + '</g></g>'
      + '</svg>';
    var uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    CACHE[key] = uri;
    return uri;
  };
})();
