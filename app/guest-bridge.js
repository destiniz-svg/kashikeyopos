/* ═══ THE GUEST BRIDGE ══════════════════════════════════════════════════════
   The QR portal is the same app the reference shipped, pointed at a real
   outlet instead of a demo on the same device.

   Two things change and nothing else:

     · the menu comes from THIS outlet's own database, over a table token
       minted from the QR's slug — so a guest cannot retype a URL onto another
       table's bill, and cannot see another outlet at all
     · an order is POSTED as INTENT. The phone never takes money, never sees a
       cost and never sees a margin: the projection it reads does not contain
       them, so there is nothing to leak even if the page is opened by someone
       who should not have it.

   Everything the till decides stays with the till.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  var TOKEN_KEY = "kashikeyo.table";
  var MEMBER_KEY = "kashikeyo.member.token";

  function slugFromPath() {
    // /g/<slug> is the QR portal, /m/<slug> the member card, /p/<slug> the
    // legacy path. All three name the same store.
    //
    // A store's own address — https://<handle>.kashikeyopos.com — names it in
    // the HOSTNAME instead, and this file does not try to read it there. Only
    // the server knows where the base domain ends, and a page that guessed
    // would read "kashikeyopos-staging" off a Railway URL and go looking for a
    // store by that name. With no slug, token() asks the server instead.
    var m = String(location.pathname || "").match(/^\/(?:g|m|p)\/([a-z0-9-]+)/i);
    if (m) return m[1];
    var q = new URLSearchParams(location.search);
    return q.get("s") || q.get("slug") || "";
  }
  /* Could this hostname be naming a store? A single label (localhost) or an
     apex (example.com) cannot; www is the apex under another name. Anything
     else might, and the server decides — this only avoids a pointless request
     on a page that plainly has no store in its address. */
  function hostCouldName() {
    var parts = String(location.hostname || "").toLowerCase().split(".");
    if (parts.length < 3) return false;
    return parts[0] !== "www";
  }
  function tableFromUrl() {
    var q = new URLSearchParams(location.search);
    return q.get("t") || q.get("table") || "";
  }

  var kept = null;
  try { kept = localStorage.getItem(MEMBER_KEY); } catch (e) {}
  var state = { slug: slugFromPath(), table: tableFromUrl(), token: null,
    outlet: null, member: kept || null };
  root.KPOS_GUEST = state;

  function api(path, opts) {
    var o = opts || {};
    var headers = { "content-type": "application/json" };
    if (state.token) headers["x-table-token"] = state.token;
    return fetch(path, {
      method: o.method || "GET",
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
        return d;
      });
    });
  }

  // A token is scoped to one outlet and one table, and it expires. Cached so a
  // guest refreshing the page mid-order does not lose their round.
  function token() {
    // Either the path named the store, or the address bar did. When it is the
    // address bar there is no slug to send: /api/g/token resolves the store
    // from the Host header and answers with the handle it settled on, and
    // every call after this one is by handle again.
    var hosted = !state.slug;
    if (hosted && !hostCouldName()) {
      return Promise.reject(new Error("no store in this link"));
    }
    try {
      var kept = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
      if (kept && kept.slug && (hosted ? kept.host === location.hostname
        : kept.slug === state.slug) && kept.table === state.table
        && kept.exp > Date.now()) {
        state.slug = kept.slug;
        state.token = kept.token;
        state.outlet = kept.outlet;
        return Promise.resolve(kept.token);
      }
    } catch (e) {}
    return api("/api/g/" + (hosted ? "" : encodeURIComponent(state.slug) + "/") + "token"
      + (state.table ? "?t=" + encodeURIComponent(state.table) : ""))
      .then(function (r) {
        state.token = r.token;
        state.outlet = r.outlet;
        if (r.outlet && r.outlet.slug) state.slug = r.outlet.slug;
        if (r.table) state.table = r.table;
        try {
          localStorage.setItem(TOKEN_KEY, JSON.stringify({
            slug: state.slug, host: location.hostname, table: state.table,
            token: r.token, outlet: r.outlet, exp: Date.now() + 3.5 * 3600e3
          }));
        } catch (e) {}
        return r.token;
      });
  }

  /* ── the menu, as this outlet has it ──────────────────────────────────── */
  function hydrate(snap) {
    if (!snap) return;
    var K = root.KPOS || (root.KPOS = {});
    var o = snap.outlet || {};
    var rate = snap.tax ? Number(snap.tax.rate) : 0;
    var floor = (snap.floor || []).map(function (t) {
      return { id: t.id, label: t.label, seats: Number(t.seats) || 0, zone: t.zone || "" };
    });
    K.OUTLETS = [{
      id: o.id, code: o.slug || "", name: o.name, type: "restaurant",
      loc: "restaurant", parent: 0, region: "", tax: (snap.tax || {}).code || o.tax_code,
      rate: rate, sc: Number(o.service_pct) || 0, addr: "", mgr: "",
      pos: true, currency: o.currency,
      // The room as it really is, not a guessed twelve.
      tables: floor.length,
      seats: floor.reduce(function (a, t) { return a + t.seats; }, 0),
      floor: floor
    }];
    K.MENU_CATEGORIES = (snap.categories || []).map(function (c) {
      return { id: c.id, name: c.name, icon: "main" };
    });
    K.MENU = (snap.items || []).map(function (i) {
      return {
        id: i.id, cat: i.category_id, name: i.name, desc: i.description || "",
        price: Number(i.price) || 0, veg: (i.diets || []).indexOf("veg") >= 0,
        img: i.image || "", allergens: i.allergens || [], diets: i.diets || [],
        offMenu: i.off_menu, soldOutReason: i.sold_out_reason || "",
        recipe: []            // a guest device holds no recipe and no cost
      };
    });
    K.BANNERS = (snap.banners || []).map(function (b) {
      return { id: b.id, outlet: o.id, title: b.title, sub: b.body || "",
        code: b.link || "", img: b.image || "", active: true };
    });
    // Whose restaurant this is. The portals print the trading name, and the
    // "Powered by" line is the merchant's to switch off.
    var co = snap.company;
    if (co) {
      var brand = co.brand || {};
      K.CHAIN = {
        id: "ch", name: brand.name || co.name, country: co.country,
        currency: co.currency, tin: "", regNo: "", hq: "",
        brand: {
          mark: brand.mark || "brand/kashikeyo-mark.png",
          name: brand.name || co.name,
          tagline: brand.tagline || "",
          poweredBy: brand.poweredBy !== false,
          accent: brand.accent || ""
        }
      };
    }
    // The card's own terms. TIERS falls back to the shipped ladder, which is
    // structure; REWARDS is the merchant's catalogue and starts empty.
    // The currency table, so the phone formats money the way the till does.
    if (snap.currencies && snap.currencies.length) K.CURRENCIES = snap.currencies;
    if (snap.tiers && snap.tiers.length) K.TIERS = snap.tiers;
    K.REWARDS = snap.rewards || [];
    K.LOYALTY = snap.loyalty || {};
    K.PROMOS = (snap.promos || []).map(function (p) {
      return { id: p.id, name: p.name, kind: p.kind,
        pct: p.kind === "percent" ? Number(p.value) : 0,
        off: p.kind === "amount" ? Number(p.value) : 0,
        code: p.code || "", maxPct: Number(p.max_pct) || 100 };
    });
    // The bill this table is actually holding, as the till holds it. A phone
    // that computes its own bill can disagree with the counter; this one
    // cannot, because it has no copy of its own.
    K.TICKETS = (snap.tickets || []).map(function (t) {
      return {
        id: t.id, table: t.table_no, split: t.split, covers: t.covers,
        lines: (t.lines || []).map(function (l) {
          return { id: l.id, name: l.name, qty: Number(l.qty) || 0,
            price: Number(l.price) || 0, note: l.note || "", sent: !!l.sent };
        })
      };
    });
    K.STAGES = (snap.stages || []).map(function (k) {
      return { ticket: k.ticket_id, station: k.station, stage: k.stage,
        target: k.target_mins, at: k.fired_at };
    });
    if (snap.table) state.table = snap.table;
    root.KPOS_GUEST.snapshot = snap;
    try { root.dispatchEvent(new Event("kpos-data-ready")); } catch (e) {}
    if (typeof root.KPOS_REPAINT === "function") root.KPOS_REPAINT();
  }

  function refresh() {
    if (!state.token) return Promise.resolve(null);
    return api("/api/g/" + encodeURIComponent(state.slug) + "/menu")
      .then(function (s) { hydrate(s); return s; })
      .catch(function () { return null; });
  }

  /* ── intent, never money ──────────────────────────────────────────────── */
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (root.crypto && root.crypto.getRandomValues)
        ? root.crypto.getRandomValues(new Uint8Array(1))[0] % 16
        : Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  root.KPOS_GUEST_API = {
    ready: function () { return !!state.token; },
    slug: function () { return state.slug; },
    table: function () { return state.table; },
    refresh: refresh,
    // A round from the phone. The opId means a guest who taps twice on a bad
    // connection sends one order, not two.
    order: function (lines, extra) {
      var b = Object.assign({ table: state.table, lines: lines, opId: uuid() }, extra || {});
      return api("/api/g/" + encodeURIComponent(state.slug) + "/order",
        { method: "POST", body: b });
    },
    // A raised hand, the bill, water, help.
    request: function (kind, detail) {
      return api("/api/g/" + encodeURIComponent(state.slug) + "/request",
        { method: "POST", body: { table: state.table, kind: kind, detail: detail || "" } });
    },
    member: function (phone) {
      return api("/api/g/" + encodeURIComponent(state.slug) + "/member?phone="
        + encodeURIComponent(phone));
    },

    /* ── the member portal ──────────────────────────────────────────────────
       A member holds a card, not a table. Signing in is a code checked like a
       staff PIN, traded for a token that names ONE member id and carries no
       rank — so a stolen one reads one card and can neither order nor settle.
       The token outlives the table token deliberately: a loyalty card that
       signs you out every few hours is a loyalty card nobody carries. */
    memberStart: function (id) {
      return api("/api/g/" + encodeURIComponent(state.slug) + "/member/start",
        { method: "POST", body: { id: id } });
    },
    memberVerify: function (id, code) {
      return api("/api/g/" + encodeURIComponent(state.slug) + "/member/verify",
        { method: "POST", body: { id: id, code: code } })
        .then(function (r) {
          if (r && r.token) {
            state.member = r.token;
            try { localStorage.setItem(MEMBER_KEY, r.token); } catch (e) {}
          }
          return r;
        });
    },
    memberToken: function () { return state.member; },
    memberSignOut: function () {
      state.member = null;
      try { localStorage.removeItem(MEMBER_KEY); } catch (e) {}
    },
    memberMe: function () {
      if (!state.member) return Promise.resolve(null);
      return fetch("/api/g/" + encodeURIComponent(state.slug) + "/member/me",
        { headers: { "x-member-token": state.member } })
        .then(function (r) {
          if (r.status === 401) { root.KPOS_GUEST_API.memberSignOut(); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          if (d) hydrateMember(d);
          return d;
        });
    }
  };

  // The card, as this outlet's books have it. One record — the list the
  // terminal holds is a roster, and a roster does not belong on a phone.
  function hydrateMember(d) {
    var K = root.KPOS || (root.KPOS = {});
    var m = d.member;
    K.CUSTOMERS = [{
      id: m.id, name: m.name || m.phone, phone: m.phone, email: m.email || "",
      since: String(m.joined_at || "").slice(0, 10),
      visits: Number(m.visits) || 0, spent: Number(m.spent) || 0,
      points: Number(m.points) || 0, tier: m.tier,
      credit: Number(m.credit_limit) || 0, used: 0,
      last: m.last || "", home: state.outlet ? state.outlet.id : null
    }];
    K.MEMBER_RECEIPTS = (d.receipts || []).map(function (r) {
      return { no: r.receipt_no, date: r.business_date, at: r.at,
        covers: r.covers, net: Number(r.net), service: Number(r.service),
        tax: Number(r.tax), total: Number(r.total) };
    });
    K.MEMBER_TICKET = d.ticket ? {
      id: d.ticket.id, table: d.ticket.table_no, covers: d.ticket.covers,
      lines: (d.ticket.lines || []).map(function (l) {
        return { id: l.id, name: l.name, qty: Number(l.qty) || 0,
          price: Number(l.price) || 0 };
      })
    } : null;
    K.MEMBER_STAGE = d.stage ? {
      station: d.stage.station,
      stage: d.stage.stage === "Cooking" ? "In the kitchen" : d.stage.stage,
      target: d.stage.target_mins, at: d.stage.fired_at
    } : null;
    // `state.member` is the TOKEN. The card goes somewhere else — writing the
    // record here overwrote the token with an object and the next poll signed
    // the member straight back out.
    root.KPOS_GUEST.card = K.CUSTOMERS[0];
    try { root.dispatchEvent(new Event("kpos-member-ready")); } catch (e) {}
    if (typeof root.KPOS_REPAINT === "function") root.KPOS_REPAINT();
  }

  function fail(msg) {
    // A link with no store in it, or a handle nobody answers to. Say so — a
    // guest staring at an empty menu has no way to know the link is at fault.
    root.KPOS_GUEST.error = msg || "This code does not name a store.";
    try { root.dispatchEvent(new Event("kpos-guest-error")); } catch (e) {}
  }

  function boot() {
    if (!state.slug && !hostCouldName()) return fail();
    token().then(refresh).then(function () {
      if (state.member) root.KPOS_GUEST_API.memberMe();
      // A table's own round can change under the guest — the till accepts it,
      // the kitchen fires it. Poll gently: this is a phone on a restaurant's
      // wifi, not a terminal on a wire.
      setInterval(function () {
        refresh();
        if (state.member) root.KPOS_GUEST_API.memberMe();
      }, 8000);
    }).catch(function (e) {
      root.KPOS_GUEST.error = e.message;
      try { root.dispatchEvent(new Event("kpos-guest-error")); } catch (e2) {}
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else { boot(); }
})(typeof window !== "undefined" ? window : globalThis);
