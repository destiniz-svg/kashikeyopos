/* ═══ THE BRIDGE ════════════════════════════════════════════════════════════
   The terminal reads window.KPOS (masters) and its own state (the record). The
   server holds both, in SQL, per outlet. This file is the only thing that
   knows about both, and it does four jobs:

     1 · decide, on load, between onboarding and the PIN pad
     2 · replace the empty shipped structure with THIS outlet's records
     3 · take every op the terminal queues and drive it to the server through
         the durable outbox, so a dropped link is a delay and never a loss
     4 · fold what the server has since applied back into the running screen

   It deliberately does not reach into the terminal's rendering. The terminal
   is the reference build, ported not interpreted; if this file needed to know
   about a screen, the seam would be in the wrong place.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  var api = new root.KashikeyoAPI({ baseUrl: "" });
  root.KPOS_API = api;

  var SYNC = {
    // The terminal's queue() calls this for every mutation, 115 kinds of them.
    enqueue: function (op) { return api.queue(op); },
    flush: function () { return api.flush(); },
    pending: function () { return api.pending(); }
  };
  root.KPOS_SYNC = SYNC;

  /* ── 2 · masters and state, from this outlet's own database ───────────── */
  function hydrate(boot) {
    if (!boot) return false;
    var K = root.KPOS || {};
    var live = boot.kpos || {};

    // Replace only what the server actually sent. A key the server has no
    // opinion on keeps the shipped structure — which is how the labels, the
    // reason codes and the chart survive a bootstrap that carries no trade.
    Object.keys(live).forEach(function (k) {
      // `undefined` means "the server has no opinion" — the shipped structure
      // stands. That is how MODULES, the reason codes and the chart survive a
      // bootstrap that carries no trade.
      if (live[k] === undefined || live[k] === null) return;
      if (Array.isArray(live[k]) && !live[k].length && Array.isArray(K[k]) && K[k].length) {
        // The server says "none". On a structural key that is the shipped
        // list; on a trade key it is the truth. Trade keys win either way
        // because the shipped list is already empty.
        K[k] = live[k];
        return;
      }
      K[k] = live[k];
    });

    if (boot.raw) {
      Object.keys(boot.raw).forEach(function (k) { root.KPOS_RAW[k] = boot.raw[k]; });
    }

    root.KPOS_REAL = {
      session: boot.session || null,
      state: boot.state || null,
      at: boot.at || Date.now()
    };
    try { root.dispatchEvent(new CustomEvent("kpos-live", { detail: boot })); } catch (e) {}
    // The data file fires this on load; firing it again after a bootstrap is
    // what tells a terminal that came up empty that it now has records.
    try { root.dispatchEvent(new Event("kpos-data-ready")); } catch (e) {}
    return true;
  }

  /* ── 1 · the front door ───────────────────────────────────────────────── */
  async function boot() {
    var install = null;
    try { install = await api.install(); } catch (e) { install = null; }

    // Offline with a cached session: come straight up on the cache. A till
    // that refuses to open because the link is down is the failure the whole
    // design exists to prevent.
    if (!install && api.signedIn()) {
      hydrate(api.local("bootstrap"));
      start();
      return;
    }

    root.KPOS_INSTALL = install;

    /* An empty install lands on onboarding, not on the floor — a terminal that
       opens on a floor with no tables, no menu and no register teaches nothing
       except that the app is broken.

       But onboarding creates a BUSINESS, and a business belongs to somebody.
       So an empty install with no account signed in on this browser goes to the
       front door first: sign up, then set up, then trade. A browser that
       already holds an account goes straight through. */
    if (install && !install.ready) {
      root.KPOS_ONBOARDING = true;
      try { root.dispatchEvent(new CustomEvent("kpos-onboarding", { detail: install })); } catch (e) {}
      var held = "";
      try { held = localStorage.getItem("kashikeyo.account.token") || ""; } catch (e) {}
      var to = held ? "/onboarding" : "/account";
      if (location.pathname !== to) location.replace(to);
      return;
    }

    if (!api.signedIn()) {
      // The lock screen shows faces, so the roster has to be readable before
      // anyone is signed in. It carries a name, a role label and an initial —
      // no id that grants anything, and never a PIN.
      await loadRoster(install);
      try { root.dispatchEvent(new CustomEvent("kpos-signin", { detail: install })); } catch (e) {}
      repaint({ outletId: api.outletId });
      return;
    }

    hydrate(await api.bootstrap());
    start();
    repaint({ outletId: api.outletId });
  }

  /* ── the sign-in roster ───────────────────────────────────────────────── */
  async function loadRoster(install) {
    var outlets = (install && install.outlets) || [];
    if (!outlets.length) return;
    var last = null;
    try { last = Number(localStorage.getItem("kashikeyo.outlet")) || null; } catch (e) {}
    var pick = outlets.filter(function (o) { return o.id === last; })[0] || outlets[0];
    api.outletId = pick.id;
    // The fascia, before anyone signs in. The name and the mark only — the
    // registration number, the TIN and the address arrive with a session.
    if (install.merchant) {
      root.KPOS.CHAIN = Object.assign({}, root.KPOS.CHAIN, {
        name: install.merchant.name, country: install.merchant.country,
        currency: install.merchant.currency,
        brand: Object.assign({}, (root.KPOS.CHAIN || {}).brand, {
          name: install.merchant.name, tagline: install.merchant.tagline,
          colour: install.merchant.colour || ((root.KPOS.CHAIN || {}).brand || {}).colour
        })
      });
    }
    root.KPOS.OUTLETS = outlets.map(function (o) {
      return {
        id: o.id, code: o.code, name: o.name, type: "restaurant", loc: "restaurant",
        parent: 0, region: "", tax: o.tax_code, rate: Number(o.rate) || 0,
        sc: Number(o.service_pct) || 0,
        addr: "", mgr: "", pos: true, seats: 0, tables: 0,
        currency: o.currency, active: o.active
      };
    });
    try {
      var r = await api._fetch("/api/auth/roster?outletId=" + pick.id, { anon: true });
      root.KPOS.USERS = (r.staff || []).map(function (u) {
        return {
          id: u.id, name: u.name, user: u.user, role: u.roleKey, rank: u.rank,
          outlet: pick.id, outlets: [], pin: "",
          status: u.locked ? "Locked" : "Active", last: ""
        };
      });
    } catch (e) { root.KPOS.USERS = []; }
  }

  // The terminal re-renders on its own 15-second tick; a fresh sign-in or a
  // fresh bootstrap should not wait that long to appear. A resize is the one
  // signal the component already listens to, and it costs one render.
  function repaint(patch) {
    if (typeof root.KPOS_REPAINT === "function") { root.KPOS_REPAINT(patch || null); return; }
    try { root.dispatchEvent(new Event("resize")); } catch (e) {}
  }

  /* ── 4 · the tick ─────────────────────────────────────────────────────── */
  var started = false;
  function start() {
    if (started) return;
    started = true;
    api.flush();
    api.onTick(function (t) {
      try { root.dispatchEvent(new CustomEvent("kpos-tick", { detail: t })); } catch (e) {}
    });
    // After a push lands, the masters may have moved — a dish was priced, a
    // delivery was received. Re-read rather than guess what changed.
    root.addEventListener("kpos-sync-done", function (e) {
      var results = (e.detail || []);
      var material = results.some(function (x) {
        return x.result && !x.result.audited && !x.replay;
      });
      if (material) api.bootstrap().then(hydrate);
    });
  }

  root.KPOS_BRIDGE = {
    boot: boot,
    hydrate: hydrate,
    api: api,
    signIn: async function (outletId, pin) {
      var r = await api.signIn({ outletId: outletId, pin: pin });
      try { localStorage.setItem("kashikeyo.outlet", String(r.outletId)); } catch (e) {}
      hydrate(await api.bootstrap());
      start();
      repaint({ outletId: r.outletId });
      return r;
    },
    roster: loadRoster,
    refresh: async function () { return hydrate(await api.bootstrap()); },
    /* The store's public address. Renaming keeps the old one pointing here —
       the cards are already on the tables — so the terminal re-reads the
       bootstrap afterwards rather than patching a slug it half knows. */
    handle: function (want) { return api.handle(want); },
    rename: async function (h) {
      var r = await api.rename(h);
      hydrate(await api.bootstrap());
      repaint(null);
      return r;
    },
    // The network pill's "go offline" is a real switch, not a simulation: the
    // queue holds durably and nothing is POSTed until it is flipped back.
    setOffline: function (off) { root.__kposForceOffline = !!off; if (!off) api.flush(); }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
