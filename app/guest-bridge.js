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
    if (o.headers) {
      Object.keys(o.headers).forEach(function (k) { headers[k] = o.headers[k]; });
    }
    return fetch(path, {
      method: o.method || "GET",
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          // The STATUS matters to a caller deciding whether to retry: a 401
          // before this device has its table token is a "try again in a
          // moment", and a 404 is an answer.
          var err = new Error((d && d.error) || ("HTTP " + r.status));
          err.status = r.status;
          throw err;
        }
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
      // The store's FACE (chain.outlet.brand): the logo both portal headers
      // wear and the cover photograph across the top of the QR menu.
      brand: {
        logo: (o.brand || {}).logo || "",
        cover: (o.brand || {}).cover || ""
      },
      // The room as it really is, not a guessed twelve.
      tables: floor.length,
      seats: floor.reduce(function (a, t) { return a + t.seats; }, 0),
      floor: floor
    }];
    K.MENU_CATEGORIES = (snap.categories || []).map(function (c) {
      /* The published icon and colour ride AS PUBLISHED — a person picked
         them in the section editor. Null stays null, so the portal
         classifies the section by NAME into its typed glyph and hue. The
         old literal `icon: "main"` here stamped cutlery onto every section,
         which made the whole classification unreachable on a phone. */
      return { id: c.id, name: c.name, icon: c.icon || null, colour: c.colour || null };
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
    if (snap.tiers && snap.tiers.length) {
      /* The SHIPPED rows survive as presentation — the mark and the card
         gradient — exactly as the tier doctrine says. A store that publishes
         its own ladder publishes THRESHOLDS; its rows carry no colours, and a
         card drawn from them alone paints white on white (measured: a
         published two-rung ladder rendered the whole membership card blank).
         Stashed rather than copied, so there is still one ladder to drift. */
      if (!K.TIERS_SHIPPED) K.TIERS_SHIPPED = K.TIERS;
      K.TIERS = snap.tiers;
    }
    K.REWARDS = snap.rewards || [];
    K.LOYALTY = snap.loyalty || {};
    /* The outlet's OWN tender set and add-ons. Without these the phone read a
       till's localStorage — absent on any real guest's device — and fell back
       to a hardcoded three tenders and the SHIPPED demo modifiers, which
       offered every store's guests somebody else's extra cheese. */
    if (snap.tenders && snap.tenders.length) K.TENDERS_PUBLISHED = snap.tenders;
    K.MODIFIERS = snap.modifiers || [];
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
        // Where this order is, on the outlet's own record: 0 taking the order,
        // 1 in the kitchen, 2 ready at the pass, 3 served.
        stage: Number(t.stage) || 0,
        lines: (t.lines || []).map(function (l) {
          return { id: l.id, name: l.name, qty: Number(l.qty) || 0,
            price: Number(l.price) || 0, note: l.note || "",
            sent: !!l.sent, ready: !!l.ready };
        })
      };
    });
    K.STAGES = (snap.stages || []).map(function (k) {
      return { ticket: k.ticket_id, station: k.station, stage: k.stage,
        target: k.target_mins, at: k.fired_at };
    });
    /* THE BILL THAT HAS BEEN PAID, from the outlet. The open-ticket list is
       the floor, so a settled table simply disappears from it — and the
       tracker then read the last stage this PHONE had recorded, which is
       "Received". A guest who had paid and left was still being told the
       kitchen had their order. */
    K.SETTLED = (snap.settled || []).map(function (s) {
      return { table: s.table_no, no: s.receipt_no,
        total: Number(s.total) || 0, at: s.at,
        /* WHAT WAS ON IT. The row carried a total and a number, so a guest's
           own record of what they paid for named nothing they had eaten.
           These are the SALE's lines, so they are what was delivered by
           construction: a line the counter declined never reached the ticket
           and was never on the bill. */
        lines: (s.lines || []).map(function (l) {
          return { name: l.name, qty: Number(l.qty) || 0,
            amt: Number(l.amt) || 0 };
        }) };
    });
    /* AND A ROUND THE COUNTER DECLINED, for the same reason one line up: it
       leaves every other list the outlet publishes, so without this the phone
       falls back to what it last SENT and says "Received" for food nobody is
       cooking. `decided` is when the counter answered, which is what the
       phone's own guard compares against its last round. */
    K.DECLINED = (snap.declined || []).map(function (d) {
      return { id: d.id, table: d.table_no, why: d.rejected_reason || "",
        at: d.at, decided: d.decided_at,
        /* `partial` is the outlet's own answer to "is any of this coming" —
           a round with a ticket had most of it accepted — and `lines` names
           the dishes that were not, so the phone drops exactly those rather
           than reading the sentence and guessing. Absent on a whole-round
           decline and on a decision an older build took, which is why the
           phone still falls through to the sentence. */
        partial: !!d.partial,
        lines: (d.rejected_lines || []).map(function (l) {
          return { i: Number(l.i), id: l.id == null ? null : String(l.id),
            name: l.name || "", qty: Number(l.qty) || 1 };
        }) };
    });
    /* AND A ROUND THE COUNTER HAS NOT ANSWERED YET. The third state, and the
       only one the phone used to infer: a round it had sent and could not find
       in either list above was assumed to be waiting, which is unanswerable
       once two phones share a table or one guest orders the same dish twice.
       The outlet says it, with the dish NAMES resolved there — a second phone
       at this table holds no record of what the first one sent. */
    K.PENDING = (snap.pending || []).map(function (g) {
      return { id: g.id, table: g.table_no, at: g.at,
        lines: (g.lines || []).map(function (l) {
          return { i: Number(l.i) || 0, id: l.id == null ? null : String(l.id),
            name: l.name || "", qty: Number(l.qty) || 1,
            price: l.price == null ? null : Number(l.price),
            addons: Number(l.addons) || 0, note: l.note || "" };
        }) };
    });
    /* WHAT THIS STORE ACTUALLY SELLS — a ranking measured off settled bills,
       never a shape the phone works out for itself. An outlet that has sold
       nothing publishes an empty list and the rail draws no tab at all. */
    K.POPULAR = (snap.popular || []).map(String);
    if (snap.table) state.table = snap.table;
    root.KPOS_GUEST.snapshot = snap;
    try { root.dispatchEvent(new Event("kpos-data-ready")); } catch (e) {}
    if (typeof root.KPOS_REPAINT === "function") root.KPOS_REPAINT();
  }

  function refresh() {
    if (!state.token) return Promise.resolve(null);
    /* WHEN THIS ASK BEGAN, not when it landed. A round the phone sent is drawn
       from the phone until the OUTLET has had a chance to mention it, and
       "had a chance" is a question about when the server ran the query — a
       snapshot whose request started after the order POST answered certainly
       contains that round, where one already in flight may not. Comparing
       arrival times instead loses the race, and a round that appears on send
       and vanishes for eight seconds is worse than one that is slow. */
    var began = Date.now();
    return api("/api/g/" + encodeURIComponent(state.slug) + "/menu")
      .then(function (s) {
        hydrate(s);
        root.KPOS_GUEST.polledFrom = began;
        return s;
      })
      .catch(function () { return null; });
  }

  /* ── intent, never money ──────────────────────────────────────────────── */
  var saidNoCsprng = false;
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r;
      if (root.crypto && root.crypto.getRandomValues) {
        r = root.crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      } else {
        // Said, never silent — same rule as the till's newId().
        if (!saidNoCsprng) { saidNoCsprng = true; try { console.error("[kpos-guest] no CSPRNG — ids are degraded on this browser"); } catch (e) {} }
        r = Math.floor(Math.random() * 16);
      }
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
      /* Object.assign with `table: undefined` CLOBBERS the bound table — which
         is how every order from the member card went out table-less and was
         refused 400 while the screen said "sent". A caller's table wins only
         where the caller actually names one. The membership rides as a
         HEADER, never a body field: the server attributes the order from the
         token, because a client-claimed member id on an anonymous door would
         let anybody earn on anybody's card. */
      var e = extra || {};
      /* THE CALLER'S OWN OP ID WHERE IT HAS ONE, so a round that has to be
         sent again is the same round. `/order` looks the op up and answers
         with the order it already made; minting a fresh id per CALL — which
         is what this did — made every retry a second dinner, so there could
         be no retry at all and "it will send when you are back online" was a
         sentence nothing kept. */
      var b = { table: e.table || state.table, lines: lines,
        opId: e.opId || uuid(),
        promo: e.promo, name: e.name, phone: e.phone, note: e.note };
      return api("/api/g/" + encodeURIComponent(state.slug) + "/order",
        { method: "POST", body: b,
          headers: state.member ? { "x-member-token": state.member } : undefined });
    },
    /* Sitting down IS minting: the table token is scoped to one table, and the
       menu projection filters the room to it — so keying a table number on the
       member card re-mints the token for that table, which is what lets the
       card read its own round back. token() already caches per (slug, table)
       and the mint endpoint takes ?t=. */
    bindTable: function (t) {
      state.table = String(t == null ? "" : t);
      state.token = null;
      return token().then(refresh).catch(function () { return null; });
    },
    // A raised hand, the bill, water, help.
    request: function (kind, detail, table, pay) {
      /* A signal with no table is still a signal — "at the counter" is where a
         member scanning their card stands, and the floor board names the
         person rather than the table for member traffic. 'card' is the same
         placeholder the sign-in code lane already files under. `pay` is the
         bill ask's whole decision — tender, tip, split, share — which used to
         survive only in localStorage and so never reached a till on another
         machine. */
      return api("/api/g/" + encodeURIComponent(state.slug) + "/request",
        { method: "POST", body: { table: table || state.table || "card",
          kind: kind, detail: detail || "", pay: pay || undefined } });
    },
    /* ── the member portal ──────────────────────────────────────────────────
       A member holds a card, not a table. Signing in is a code checked like a
       staff PIN, traded for a token that names ONE member id and carries no
       rank — so a stolen one reads one card and can neither order nor settle.
       The token outlives the table token deliberately: a loyalty card that
       signs you out every few hours is a loyalty card nobody carries. */
    /* ARRIVING BY INVITATION. The phone hands the token over and the server
       answers with ONE membership — never a roster lookup, which would mean
       every device holding the keys to every account. */
    memberJoin: function (token) {
      return api("/api/g/" + encodeURIComponent(state.slug) + "/member/join",
        { method: "POST", body: { token: token } });
    },
    /* "Send my code". The token is spent server-side and the code goes to the
       address ON THE MEMBERSHIP, so a forwarded link cannot sign in whoever
       it was forwarded to. */
    memberJoinCode: function (token) {
      return api("/api/g/" + encodeURIComponent(state.slug) + "/member/join/code",
        { method: "POST", body: { token: token } });
    },
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
      // Where the order is, on the outlet's own record.
      stage: Number(d.ticket.stage) || 0,
      lines: (d.ticket.lines || []).map(function (l) {
        return { id: l.id, name: l.name, qty: Number(l.qty) || 0,
          price: Number(l.price) || 0, sent: !!l.sent, ready: !!l.ready };
      })
    } : null;
    // The docket: which station has it and how long it was told to take. It is
    // not where the order IS — that rides on the ticket, so it survives the
    // moment the table is served.
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
