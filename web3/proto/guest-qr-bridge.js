/* guest-qr-bridge — wire the reference "Kashikeyo Guest QR" app to a real store.
 *
 * The app (its inline scripts) reads window.KASHIKEYO_QR for its config + data,
 * and talks to the outside world only through a small adapter (push/ticket/
 * prefs/subscribe/…). serveGuestV3 injects window.KPOS_REAL (the store's real
 * menu, branding, tax, slug and table) into the page head just before this
 * file. Here we translate KPOS_REAL into the app's data shape and hand it an
 * adapter that posts orders + service calls to the public /p/:slug endpoints —
 * the same endpoints the previous guest portal used. No auth: guests are
 * anonymous.
 *
 * With no KPOS_REAL (the file opened on its own) we do nothing and the app
 * falls back to its bundled seed menu, so the design still previews standalone.
 */
(function () {
  var R = window.KPOS_REAL;
  if (!R || !R.menu) return; // standalone/demo preview → app uses its own seed

  function qp(k) { try { return new URLSearchParams(location.search).get(k) || ""; } catch (e) { return ""; } }
  var SLUG = qp("s") || R.slug || "";
  var TABLE = R.table || qp("t") || "";
  var OUTLET_ID = 3; // the portal is a single outlet; the app keys its ticket on this

  var o = R.outlet || {}, brand = R.brand || {}, fiscal = R.fiscal || {};
  var currency = o.currency === "USD" ? "USD" : "MVR";
  var storeName = brand.name || o.name || "Restaurant";

  /* One outlet row, carrying the store's real tax + service-charge rates so the
     app's bill math and the "GGST 8% / service charge 10%" copy are the store's,
     not the demo chain's. */
  var OUTLET = {
    id: OUTLET_ID,
    code: (R.outlets && R.outlets[0] && R.outlets[0].code) || "KO",
    name: storeName, region: "",
    tax: o.tax || "GGST", rate: Number(o.rate) || 0, sc: Number(o.sc) || 0,
    addr: fiscal.address || "", pos: true, tables: 20
  };

  /* Categories carry a parent `group` (Drinks/Food/Desserts/…). A store with
     21 categories collapses to a handful of groups so the guest sees a short,
     legible tab row instead of a wall of sections — the till floor does the
     same. `groups` is the ordered group list; CAT_GROUP maps each category id
     to its group so a menu item can inherit its category's group. */
  var CATS = (R.categories || []).map(function (c) { return { id: c.id, name: c.name, group: c.group || "" }; });
  var GROUPS = (R.groups || []).slice();
  var CAT_GROUP = {};
  CATS.forEach(function (c) { CAT_GROUP[c.id] = c.group || ""; });

  /* Real products → the app's menu-item shape. Price is already in MVR (major
     units) from buildGuestReal. Images are absolute ("/api/img/…" or a full
     URL), so imageBase is "" and the value is used verbatim. */
  var MENU = (R.menu || []).map(function (m) {
    return {
      id: m.id, cat: m.cat, group: CAT_GROUP[m.cat] || "", name: m.name, desc: m.desc || "",
      price: Number(m.price) || 0, veg: !!m.veg, img: m.img || "",
      best: !!m.bestSeller,
      /* Item tags the guest design renders: `spice` 0-3 is a read-only fact
         (0 shows nothing); `heat` true offers a single-select heat choice from
         the chain-wide HEAT scale below. */
      spice: Math.max(0, Math.min(3, Math.round(Number(m.spice) || 0))), heat: !!m.heat,
      /* per-product add-ons (name + MVR price) drive the dish modal's Add Ons
         group; the server re-prices each by name at order time */
      addons: Array.isArray(m.addons) ? m.addons : [], comments: !!m.comments
    };
  });
  /* One chain-wide heat scale — the words the card badge, the dish tag and the
     "vary the heat" choice all print. Never per-dish, never chilli glyphs alone. */
  var HEAT = [
    { id: "none", name: "Not spicy", level: 0 },
    { id: "mild", name: "Mild", level: 1 },
    { id: "med", name: "Medium", level: 2 },
    { id: "hot", name: "Hot", level: 3 },
    { id: "xhot", name: "Extra hot", level: 4 }
  ];
  var SOLD = (R.menu || []).filter(function (m) { return m.soldOut; }).map(function (m) { return m.id; });

  var CHAIN = {
    id: "org", name: storeName, country: "MV", currency: currency, tin: fiscal.tin || "",
    brand: { name: storeName, receiptFoot: brand.footer || "Thank you", poweredBy: !brand.whiteLabel }
  };

  function post(path, body) {
    if (!SLUG) return false;
    try {
      fetch("/p/" + encodeURIComponent(SLUG) + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          /* A server rejection (e.g. sold out, bad table, too large) used to be
             swallowed here, so the guest saw "order sent" while the till got
             nothing. Surface it so the app can tell the guest it didn't send. A
             network failure stays silent — the app already queued it optimistically
             and says it will send when the connection returns. */
          if (!r.ok || (j && j.error)) {
            try { window.dispatchEvent(new CustomEvent("kpos-post-error", { detail: { path: path, error: (j && j.error) || ("Couldn't reach the store (" + r.status + ")") } })); } catch (e) {}
            return;
          }
          // Remember a placed order so a table-less portal can follow it to
          // settlement (a table QR follows the table feed instead).
          if (path === "/order" && j && j.order && j.order.id) trackOrder(j.order.id);
        });
      }).catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  var SKEY = "kashikeyo.qr." + (SLUG || "x");

  /* Order ids this phone has placed. A table QR tracks by table; a table-less
     (takeaway) order has no table, so we remember the ids we placed and ask the
     till about them by id — that's how the portal learns the bill was settled and
     can close its own screen. Persisted so a reload keeps tracking. */
  var TKEY = SKEY + ".ids";
  function loadTrack() { try { return JSON.parse(localStorage.getItem(TKEY) || "[]") || []; } catch (e) { return []; } }
  function saveTrack(a) { try { localStorage.setItem(TKEY, JSON.stringify(a.slice(-12))); } catch (e) {} }
  var TRACK = loadTrack();
  function trackOrder(id) { id = String(id || ""); if (!id) return; if (TRACK.indexOf(id) < 0) { TRACK.push(id); saveTrack(TRACK); } ensurePoll(); }

  /* ── Live order status from the till ─────────────────────────────────────────
     The app reads adapter.ticket() to show each round's progress (sent → at the
     till → in the kitchen → served). We mirror the store's own open orders for
     THIS table from the public /p/:slug/orders?t= feed and shape them into the
     ticket the app expects: one line per order item, carrying the till's status
     as fired/done so the tracker moves the moment a cashier advances the order.
       new       → on the ticket, not fired          (Accepted at the till)
       preparing → fired                             (In the kitchen)
       ready     → fired                             (In the kitchen)
       completed → done, or a per-line KDS bump      (Served)
     A poll (every 5s) keeps it live even without SSE, and calls subscribers on
     any change so the app repaints. */
  var liveTicket = null, tSubs = [], tPoll = 0, tLast = "";
  function buildTicket(orders, calls) {
    var lines = [], anyBillAck = false, hadOrder = false, allSettled = true;
    (orders || []).forEach(function (o) {
      var st = String((o && o.status) || "new");
      if (st === "cancelled") return;
      hadOrder = true;
      var settledOne = st === "settled" || st === "completed";
      if (!settledOne) allSettled = false;
      if (o.billAck) anyBillAck = true;
      // Drive every line from the ORDER status so the guest's stage matches the
      // till exactly: new → received, preparing → preparing, ready → ready,
      // served/settled → served. (We deliberately don't read per-line `done`:
      // the kitchen sets all lines done when it marks a ticket ready, which
      // would otherwise read as "served" before it actually is.) A settled order
      // stays on the ticket as done so the bill never vanishes mid-service — it
      // is the `settled` flag below (not the lines going away) that closes it.
      var fired = st === "preparing" || st === "ready" || st === "served" || settledOne;
      var ready = st === "ready";
      var done = st === "served" || settledOne;
      var firedAt = Number(o.readyAt || o.updatedAt || o.createdAt) || 0;
      (o.items || []).forEach(function (it) {
        if (!it) return;
        lines.push({
          id: it.pid || it.id,
          qty: Number(it.qty || it.q) || 1,
          // Prefix "QR" so the app credits it to this phone's own rounds (it keys
          // its own lines off a leading "QR"); the till's own added lines won't.
          note: "QR" + (it.note ? " · " + it.note : ""),
          fired: fired, ready: ready, firedAt: firedAt, done: done
        });
      });
    });
    // A cashier can acknowledge a floor call ("On my way") without clearing it.
    // An acked BILL call is the same promise as an order-level billAck; an acked
    // ASSIST call ("call a server") shows its own "a server is on the way".
    var assistAck = false, billCallAck = false;
    (calls || []).forEach(function (cl) {
      if (!cl || !cl.acked) return;
      if (cl.kind === "assist") assistAck = true;
      else if (cl.kind === "bill") billCallAck = true;
    });
    var settled = hadOrder && allSettled;
    // settled = every open order for this table has been paid off at the till;
    // billAck = a cashier acknowledged a bill request (from an order OR a bill
    // call) and is on the way; assistAck = a server acknowledged a waiter call.
    return { lines: lines, settled: settled, billAck: (anyBillAck || billCallAck) && !settled, assistAck: assistAck && !settled };
  }
  function pollTicket() {
    if (!SLUG) return;
    // Table QR → follow the table feed; table-less → follow the ids we placed.
    var qs = TABLE ? "t=" + encodeURIComponent(TABLE)
      : (TRACK.length ? "o=" + encodeURIComponent(TRACK.join(",")) : "");
    if (!qs) return;
    fetch("/p/" + encodeURIComponent(SLUG) + "/orders?" + qs, { headers: { "Accept": "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        var tk = buildTicket(j.orders || [], j.calls || []);
        var sig = JSON.stringify(tk);
        if (sig !== tLast) {                              // changed → repaint
          tLast = sig; liveTicket = tk;
          for (var i = 0; i < tSubs.length; i++) { try { tSubs[i](); } catch (e) {} }
        }
        // Once a table-less order is finalised at the till (settled/served/
        // cancelled), stop tracking it so polling winds down and the next order
        // starts clean. The settled ticket was delivered to subscribers above.
        if (!TABLE && TRACK.length) {
          var st = {};
          (j.orders || []).forEach(function (o) { if (o) st[String(o.id)] = String(o.status || ""); });
          var open = TRACK.filter(function (id) { var s = st[id]; return !(s === "settled" || s === "completed" || s === "cancelled"); });
          if (open.length !== TRACK.length) {
            TRACK = open; saveTrack(TRACK);
            if (!TRACK.length && tPoll) { clearInterval(tPoll); tPoll = 0; }
          }
        }
      })
      .catch(function () {});
  }
  function ensurePoll() { if (!tPoll && (TABLE || TRACK.length)) { pollTicket(); tPoll = setInterval(pollTicket, 5000); } }
  if (TABLE || TRACK.length) ensurePoll();

  window.KASHIKEYO_QR = {
    outletId: OUTLET_ID,
    table: TABLE,
    greeting: "",
    showBanner: false,          // real promos aren't modelled yet → no demo banner
    showBrowserChrome: false,   // this is a real page, not a device mock
    imageBase: "",              // real image URLs are already absolute
    data: {
      CHAIN: CHAIN, OUTLETS: [OUTLET], MENU_CATEGORIES: CATS, MENU_GROUPS: GROUPS,
      MENU: MENU, MODIFIERS: [], BANNERS: [], HEAT: HEAT
    },
    adapter: {
      /* The store's real fiscal rates + brand drive the bill and the fascia. */
      prefs: function () {
        return { tax: OUTLET.tax, rate: OUTLET.rate, sc: OUTLET.sc, kdsSla: 18,
          brand: CHAIN.brand, tipLine: false };
      },
      live: function () { return true; },
      soldOut: function () { return SOLD; },
      banners: function () { return []; },
      promoCodes: null,
      /* The live till mirror for this table (built above from /p/:slug/orders):
         null until the first poll answers, then the real order lines with their
         status, so the app's progress tracker reflects the cashier's updates. */
      ticket: function () { return liveTicket; },
      subscribe: function (fn) { tSubs.push(fn); ensurePoll(); return function () { tSubs = tSubs.filter(function (x) { return x !== fn; }); }; },
      saveSession: function (d) { try { localStorage.setItem(SKEY, JSON.stringify(d)); } catch (e) {} },
      loadSession: function () { try { return JSON.parse(localStorage.getItem(SKEY) || "null"); } catch (e) { return null; } },
      /* order → /p/:slug/order (lands on KDS + Orders); assist/bill → /call
         (raises a hand / bill request on the floor terminal). */
      push: function (intent) {
        if (!intent) return false;
        if (intent.kind === "order") {
          var items = (intent.lines || []).map(function (l) {
            /* addons ride as structured picks (server prices each by name);
               the guest's free-text note rides as `note`. The server builds the
               kitchen line note (add-on names · note) itself. */
            return { pid: l.id, qty: Number(l.qty) || 1,
              addons: Array.isArray(l.addons) ? l.addons : [], note: l.comment || "" };
          });
          if (!items.length) return false;
          /* Order type follows the QR: a table QR (?t=) is dine-in; a table-less
             link (general menu / pickup QR) is takeaway. Sending "dinein" with no
             table is rejected by the server ("select your table"), which is why a
             table-less QR order never reached the till. */
          var gtype = TABLE ? "dinein" : "pickup";
          return post("/order", { items: items, table: TABLE, gtype: gtype, note: "" });
        }
        return post("/call", { kind: intent.kind === "bill" ? "bill" : "assist", table: TABLE });
      }
    }
  };
})();
