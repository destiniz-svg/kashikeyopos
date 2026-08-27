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
    pending: function () { return api.pending(); },
    // The dead-letter lane: ops the replay gave up on, and the two decisions
    // an operator can make about one.
    parked: function () { return api.parked(); },
    retryOp: function (opId) { return api.retryOp(opId); },
    discardOp: function (opId, by) { return api.discardOp(opId, by); },
    // The outlet's clock, not this browser's outbox. See kashikeyo-api.js:
    // monotonic, persisted, and raised by every poll past whatever the outlet
    // has already accepted from anybody.
    tick: function (atLeast) { return api.tick(atLeast); }
  };
  root.KPOS_SYNC = SYNC;

  /* ── 2 · masters and state, from this outlet's own database ───────────── */
  function hydrate(boot) {
    if (!boot) return false;
    var K = root.KPOS || {};
    var live = boot.kpos || {};

    /* The client tells the outlet what build it is running, on every push.
       Held on the API object so the header is set from the one place the
       version is known rather than threaded through every call site. */
    if (live.APPVER) api.appVersion = live.APPVER;

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
    /* Who works here. Signed in, ask the roll that carries the WHOLE row —
       whether the account is active, which outlets it reaches, whether it is
       locked out — because Users & Roles has to render a suspended account as
       suspended rather than as absent. The anonymous roster is the fallback
       for the lock screen, which is the one moment nobody is signed in; it
       carries only the faces standing in front of the terminal. */
    root.KPOS.USERS = [];
    try {
      var full = api.token ? await api.staff() : null;
      if (full && full.staff) {
        root.KPOS.USERS = full.staff.map(function (u) {
          var locked = u.locked_until && new Date(u.locked_until) > new Date();
          return {
            id: u.id, name: u.name, user: "", role: u.role_key, rank: u.rank,
            outlet: u.outlet_id || pick.id, outlets: u.outlets || [], pin: "",
            status: !u.active ? "Suspended" : locked ? "Locked" : "Active",
            last: ""
          };
        });
      }
    } catch (e) { /* rank below manager, or offline — fall through */ }
    if (!root.KPOS.USERS.length) {
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
  }

  // The terminal re-renders on its own 15-second tick; a fresh sign-in or a
  // fresh bootstrap should not wait that long to appear. A resize is the one
  // signal the component already listens to, and it costs one render.
  function repaint(patch) {
    if (typeof root.KPOS_REPAINT === "function") { root.KPOS_REPAINT(patch || null); return; }
    try { root.dispatchEvent(new Event("resize")); } catch (e) {}
  }

  /* ── the five-second answer, and what it cannot answer ─────────────────
     Every signed-in terminal has always asked its outlet what changed every
     five seconds. The answer was dispatched as `kpos-tick` and NOTHING
     LISTENED TO IT — grep the three app pages and there is no handler — so
     the request was paid for twelve times a minute and thrown away, and the
     only thing that ever re-read the outlet was a bootstrap. A bootstrap
     happens on sign-in, after THIS device's own material push, and on an
     explicit refresh; so a table opened on the handheld stayed invisible at
     the counter until the counter wrote something of its own, and a bill
     settled on one till never reached the other till's takings at all.

     The tick now carries the floor (see buildLive) and is merged through the
     SAME path a bootstrap uses — `KPOS_REAL.state` and the `kpos-live` event
     — so the terminal grows no second code path for the same rows. */
  function absorb(t) {
    var slice = t && t.state;
    if (!slice) return;
    /* Only ONTO a bootstrap, never instead of one. A tick that landed before
       the first bootstrap resolved would otherwise install a KPOS_REAL with
       no session on it, and the session is what the terminal adopts to know
       who is signed in. The bootstrap is moments away; five seconds later
       there is another tick. */
    if (!root.KPOS_REAL || !root.KPOS_REAL.state) return;
    var prev = root.KPOS_REAL.state;
    // MERGED, never replaced: the bootstrap's sixty days of settled sales,
    // its journals and its stock moves are not in this answer, and a slice
    // assigned over them would delete two months of history every five
    // seconds. `settledToday` is a different key for exactly that reason.
    root.KPOS_REAL = {
      session: root.KPOS_REAL.session || null,
      state: Object.assign({}, prev, slice),
      at: t.now || Date.now()
    };
    try {
      root.dispatchEvent(new CustomEvent("kpos-live", { detail: { state: slice } }));
    } catch (e) {}
    tellMe(t);
  }

  /* WHAT THE SLICE DOES NOT CARRY, A BOOTSTRAP RE-READS. A dish priced, a
     section created, a customer taken, a rank changed, an ingredient
     delivered: none of those are on the floor, so no tick will ever mention
     them and this terminal would show yesterday's menu until somebody
     reloaded it.

     `TICK_COVERS` is the closed list of kinds whose whole consequence the
     slice already carries. It FAILS OPEN: a kind nobody has classified falls
     through to a re-read, so the list can cost an extra read and can never
     cost staleness — which is the only direction it is safe to be wrong in.

     A sale is covered because its takings, its ticket and its docket are all
     in the slice. What it also did — to a member's points, to the credit
     balance, to the stock ledger and to the journal — is not, and rides the
     slow refresh above rather than making every terminal re-read the whole
     outlet twelve times a minute during service. */
  var TICK_COVERS = {
    add_line: 1, void_line: 1, line_note: 1, close_ticket: 1, move_table: 1,
    covers_update: 1, park_bill: 1, resume_bill: 1, table_status: 1,
    ticket_status: 1, fulfil_stage: 1, fire_course: 1, split_payment: 1,
    sale: 1, open_register: 1, close_register: 1,
    kds_bump: 1, kds_bump_all: 1, kds_recall: 1, kds_station: 1,
    qr_order: 1, guest_add: 1, guest_signal: 1, member_signal: 1,
    discount_applied: 1, discount_cleared: 1
  };
  // A bootstrap is the expensive read, so it is not started twice at once and
  // not started twice inside the throttle. Both are latency, not correctness:
  // the next tick asks again.
  var READ_GAP_MS = 10000;
  var SLOW_MS = 300000;
  var reading = false, lastRead = 0;
  function reread() {
    if (reading) return;
    var now = Date.now();
    if (now - lastRead < READ_GAP_MS) return;
    reading = true; lastRead = now;
    api.bootstrap().then(hydrate)
      .catch(function () {})
      .then(function () { reading = false; });
  }
  // An op this terminal has not accounted for, that the slice does not carry.
  function tellMe(t) {
    var ops = (t && t.ops) || [];
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      // Audit-only ops changed nothing to re-read; the rest are judged by
      // whether the slice already said what they did.
      if (o.result && o.result.audited) continue;
      if (TICK_COVERS[o.kind]) continue;
      reread();
      return;
    }
  }

  /* ── 4 · the tick ─────────────────────────────────────────────────────── */
  var started = false;
  function start() {
    if (started) return;
    started = true;
    api.flush();
    api.onTick(function (t) {
      try { root.dispatchEvent(new CustomEvent("kpos-tick", { detail: t })); } catch (e) {}
      absorb(t);
    });
    // After a push lands, the masters may have moved — a dish was priced, a
    // delivery was received. Re-read rather than guess what changed.
    root.addEventListener("kpos-sync-done", function (e) {
      var results = (e.detail || []);
      var material = results.some(function (x) {
        return x.result && !x.result.audited && !x.replay;
      });
      if (material) reread();
    });
    /* THE FLOOR OF THE GUARANTEE. Everything the tick does not carry — what a
       sale did to a member's points, to the stock ledger and to the journal —
       reaches this terminal on the next bootstrap, and a bootstrap it has to
       WAIT for is a bootstrap that may never come on a till nobody is writing
       at. So there is a slow one, and it is slow on purpose: five minutes is
       far inside the window in which any of that matters, and twelve reads an
       hour is a cost a shop will not notice. */
    setInterval(function () { if (api.signedIn()) reread(); }, SLOW_MS);
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
    /* Where a customer's card lives, and a code to get into it. Email is a
       real transport when one is configured; Viber and WhatsApp are recorded
       but not wired, so the code is read out at the counter — and the answer
       says which of the two happened rather than claiming a send. */
    inviteMember: function (id, via, to) { return api.inviteMember(id, via, to); },
    revokeMember: function (id) { return api.revokeMember(id); },
    /* Ending every other session is a real call, and it answers with a real
       count. The old control queued an audit-only op and toasted a number it
       had invented. */
    revokeSessions: function () { return api.revokeSessions(); },
    /* Staff are a control-plane fact, not an outbox op. The screen used to
       write a local row and queue `users_update`, which has no handler: a
       cashier "removed" on screen kept their rank and their PIN. These are
       the endpoints that were there the whole time. */
    addStaff: function (body) { return api.addStaff(body); },
    editStaff: function (id, body) { return api.editStaff(id, body); },
    /* Devices are the outlet's roll, not this browser's. The Sync screen used
       to render seven hardcoded terminals belonging to outlets that exist on
       no real install, while chain.device — which the bootstrap has always
       published — went unread. */
    registerDevice: function (body) { return api.registerDevice(body); },
    changePin: function (cur, next) { return api.changePin(cur, next); },
    claimDevice: function (code) { return api.claimDevice(code); },
    /* END THIS SESSION. Different from the lock screen, which is a handover:
       this drops the token, stops the poll, and POSTs /api/auth/signout so the
       session row is revoked — a copy of this browser's storage stops being a
       way into the till. The client method has existed since the API was
       written and NOTHING has ever called it, which is why the sheet offered
       "Switch user" and no way to actually leave. */
    signOut: function () { return api.signOut(); },
    signOutDevice: function (id) { return api.signOutDevice(id); },
    deregisterDevice: function (id) { return api.deregisterDevice(id); },
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
