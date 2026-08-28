/* ═══ MISSION CONTROL — THE PAGE ═════════════════════════════════════════════
   Vanilla DOM, no framework, no build. Everything on screen is a figure the
   server measured or an honest empty state — the panel never invents a
   number, and a status is always an icon AND a label, never a colour alone.
   All content goes through textContent (the `el` helper), so a customer's
   install name cannot script the seller's panel. */
(function () {
  "use strict";

  var TOKEN = null;
  /* Whether this panel can build an install by itself, answered by /api/state
     before sign-in. Off is a deployment that never configured it — the manual
     sheet is still the whole feature, and the reason is shown rather than the
     control being greyed out for nothing. */
  var AUTO = { ok: false, why: "", warn: "" };
  try { TOKEN = localStorage.getItem("panel.token"); } catch (e) {}
  var root = document.getElementById("app");
  var timer = null;

  /* ── tiny DOM builder: attributes set, text set, nothing parsed ───────── */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "onclick") n.addEventListener("click", attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function frag(kids) { var f = document.createDocumentFragment(); kids.forEach(function (c) { if (c) f.appendChild(c); }); return f; }
  function mount(view) { root.className = view.cls || ""; root.replaceChildren(view.node); }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ "content-type": "application/json" },
        TOKEN ? { authorization: "Bearer " + TOKEN } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = null; }
        return { status: r.status, body: b };
      });
    });
  }

  function setToken(t) {
    TOKEN = t;
    try { t ? localStorage.setItem("panel.token", t) : localStorage.removeItem("panel.token"); } catch (e) {}
  }

  function fmtMoney(n, cur) {
    var v = Number(n) || 0;
    return (cur || "") + " " + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* CALENDAR DAYS, counted the same way the install counts them. It used to
     measure to the end of the last day and round up, so a trial the customer's
     own till called "2 days left" this panel called three — the same trial,
     two answers, on the two screens most likely to be open at once during the
     conversation about it. Midnight to midnight, floored, exactly as
     src/bootstrap.js does it.

     The seller's clock rather than the outlet's, which is a real limitation
     and a small one: the two are the same date for all but a few hours a day,
     and the figure the CUSTOMER is shown is the outlet's own. */
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var end = Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z");
    var now = new Date();
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((end - today) / 86400e3);
  }

  /* ── gate screens ─────────────────────────────────────────────────────── */
  function gateCard(title, sub, fields, ctaLabel, onSubmit) {
    var err = el("div", { class: "err", style: "display:none" });
    var inputs = {};
    /* The label has to be ASSOCIATED with its field, not merely next to it. A
       <label> sibling with no `for` is a caption a sighted person reads and a
       screen reader never mentions — so the seller signing in hears "edit text,
       edit text" and has to guess which is the password. */
    var form = el("form", {}, [err].concat(fields.map(function (f, i) {
      var id = "mc-" + f.name + "-" + i;
      inputs[f.name] = el("input", { id: id, type: f.type || "text",
        placeholder: f.ph || "", autocomplete: f.auto || "off", required: "" });
      return el("div", { class: "field" },
        [el("label", { for: id, text: f.label }), inputs[f.name]]);
    })).concat([el("button", { class: "cta", type: "submit", text: ctaLabel })]));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      err.style.display = "none";
      var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value; });
      onSubmit(vals, function (msg) { err.textContent = msg; err.style.display = "block"; });
    });
    return { cls: "center", node: el("div", { class: "gatecard" }, [
      el("div", { class: "brand", style: "margin-bottom:16px" }, [
        el("span", { class: "dot" }), el("b", { text: "Mission Control" })]),
      el("h1", { text: title }), el("div", { class: "sub", text: sub }), form]) };
  }

  function showSetup() {
    mount(gateCard("Set up the panel",
      "First run. The setup token is the PANEL_SETUP_TOKEN value from this service's environment — proof you are the person who deployed it.",
      [{ name: "token", label: "Setup token", type: "password" },
       { name: "email", label: "Your email", type: "email", auto: "username" },
       { name: "password", label: "Password (12+ characters)", type: "password", auto: "new-password" }],
      "Create the admin", function (v, fail) {
        api("POST", "/api/setup", v).then(function (r) {
          if (r.status !== 200) return fail((r.body && r.body.error) || "setup failed");
          setToken(r.body.token); showDash();
        });
      }));
  }

  function showSignin() {
    mount(gateCard("Sign in", "The seller's view across every install.",
      [{ name: "email", label: "Email", type: "email", auto: "username" },
       { name: "password", label: "Password", type: "password", auto: "current-password" }],
      "Sign in", function (v, fail) {
        api("POST", "/api/signin", v).then(function (r) {
          if (r.status !== 200) return fail((r.body && r.body.error) || "sign-in failed");
          setToken(r.body.token); showDash();
        });
      }));
  }

  /* ── the dashboard ────────────────────────────────────────────────────── */
  // What each provisioning step is called on screen. The keys are the step
  // keys panel/railway.js reports, so a step renamed there shows its raw key
  // here rather than vanishing.
  var STEP_WORDS = {
    starting: "starting",
    project: "creating the project",
    database: "creating the database",
    volume: "attaching its disk",
    "database-url": "waiting for the database",
    app: "building the app",
    domain: "generating its address",
    settings: "setting the health check",
    live: "waiting for the first deploy"
  };

  /* WHAT A ROW IS, in this panel's two worlds. Beside a registry a row is a
     BUSINESS a customer created by signing up; on a dedicated deployment it is
     an INSTALL a seller registered. Calling both "install" is how a screen
     ends up describing a world that no longer exists — which is the whole
     reason this file changed. Set from the overview's own answer, never
     guessed. */
  var WORD = { one: "install", many: "installs", One: "Install", Many: "Installs" };
  var REGMODE = false;
  function setWord(mode) {
    REGMODE = mode === "registry";
    WORD = REGMODE
      ? { one: "business", many: "businesses", One: "Business", Many: "Businesses" }
      : { one: "install", many: "installs", One: "Install", Many: "Installs" };
  }
  var DEDICATED = true;      // until /api/provision/config says otherwise

  function statusOf(inst) {
    var l = inst.live || {};
    if (l.state === "archived") return { cls: "mute", label: "Archived" };
    /* Being built. The step is the row's own progress column, written before
       each piece is made, so a panel that died mid-run still says how far it
       got rather than showing an unreachable install nobody can explain. */
    if (l.state === "building") {
      var st = String(l.step || "");
      if (st.indexOf("failed") === 0) {
        return { cls: "bad", label: "Provisioning failed", note: st.slice(7).trim() };
      }
      return { cls: "onb", label: "Building \u00b7 " + (STEP_WORDS[st] || st || "starting") };
    }
    if (l.state === "live") {
      if (!l.summary || !l.summary.company) return { cls: "onb", label: "Onboarding open" };
      return { cls: "live", label: "Live" };
    }
    if (l.state === "nokey") return { cls: "warn", label: "No platform key", note: l.note };
    if (l.state === "refused") return { cls: "bad", label: "Key refused", note: l.note };
    return { cls: "bad", label: "Unreachable", note: l.note };
  }

  function trialChip(inst) {
    if (inst.kind !== "trial") return null;
    var d = daysUntil(inst.trial_ends);
    if (d === null) return el("span", { class: "chip mute" }, [el("span", { class: "pip" }),
      document.createTextNode("Trial · no end date")]);
    if (d < 0) return el("span", { class: "chip bad" }, [el("span", { class: "pip" }),
      document.createTextNode("Trial ended " + (-d) + "d ago")]);
    if (d <= 7) return el("span", { class: "chip warn" }, [el("span", { class: "pip" }),
      document.createTextNode("Trial · " + (d === 0 ? "ends today" : d + "d left"))]);
    return el("span", { class: "chip mute" }, [el("span", { class: "pip" }),
      document.createTextNode("Trial · ends " + String(inst.trial_ends).slice(0, 10))]);
  }

  /* One hue, 2px, honest about zero — the standard stat-tile trend mark. */
  function sparkline(days) {
    var W = 100, H = 34, PAD = 3;
    var nets = (days || []).map(function (d) { return Number(d.net) || 0; });
    if (!nets.length) return null;
    var max = Math.max.apply(null, nets), min = 0;
    var span = (max - min) || 1;
    var pts = nets.map(function (v, i) {
      var x = PAD + (i / Math.max(1, nets.length - 1)) * (W - 2 * PAD);
      var y = H - PAD - ((v - min) / span) * (H - 2 * PAD);
      return [x, y];
    });
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("height", "44");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Last 14 days of net takings");
    var pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("points", pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "));
    pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", "var(--fwd)");
    pl.setAttribute("stroke-width", "2");
    pl.setAttribute("stroke-linejoin", "round");
    pl.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(pl);
    var last = pts[pts.length - 1];
    var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", last[0].toFixed(1)); dot.setAttribute("cy", last[1].toFixed(1));
    dot.setAttribute("r", "2.6"); dot.setAttribute("fill", "var(--fwd-bright)");
    svg.appendChild(dot);
    return svg;
  }

  /* THE CUSTOMER ASKED TO BE PUT ON A PLAN. This is the whole point of the
     panel for a trial that is running out, so it is on the card rather than
     behind the edit sheet — a request nobody sees is a customer nobody rang
     back. It comes back on the install's own summary, which means it needs no
     outbound call from the install and survives the panel being closed for a
     week. */
  var WANTS = { monthly: "a monthly plan", yearly: "a yearly plan",
    permanent: "to buy it outright", talk: "to talk it through" };

  function planAsk(inst) {
    var pr = ((inst.live || {}).summary || {}).planRequest;
    if (!pr) return null;
    var who = pr.by ? " \u00b7 " + pr.by : "";
    var line = "Asked for " + (WANTS[pr.want] || "a plan") + " " + ageOf(pr.at) + who;
    return el("div", { class: "note ask" }, [
      el("b", { text: line }),
      pr.note ? el("div", { text: pr.note }) : null]);
  }

  /* ── THE LICENCE SHEET, for a business beside a registry ────────────────────
     Registry mode used to open the dedicated-install sheet here — base URL,
     platform key, setup code — three fields that mean nothing for a business
     whose database this panel opens directly, around the four that do. This is
     those four: what they are on, when the trial ends, extending it, and the
     note the customer reads on their own Settings screen. */
  function licenceSheet(inst, reload) {
    var err = el("div", { class: "err", style: "display:none" });
    function fail(m) { err.textContent = m; err.style.display = "block"; }
    var f = {
      kind: el("select", {}, ["trial", "paid", "internal"].map(function (k) {
        var opt = el("option", { value: k, text: k[0].toUpperCase() + k.slice(1) });
        if (inst.kind === k) opt.setAttribute("selected", "");
        return opt;
      })),
      trialEnds: el("input", { type: "date",
        value: inst.trial_ends ? String(inst.trial_ends).slice(0, 10) : "" }),
      customerNote: el("input", {
        placeholder: "shown to the customer on their own Settings screen — optional",
        value: inst.customer_note || "" })
    };
    function field(label, input) {
      return el("div", { class: "field" }, [el("label", { text: label }), input]);
    }
    /* Extending by DAYS, not by typing a date: the server moves the deadline
       forward from today or from where it stood, whichever is later, so an
       expired trial gets the days rather than a date in the past. */
    function extendBtn(days) {
      var b = el("button", { class: "mini", text: "+" + days + " days" });
      b.onclick = function () {
        b.disabled = true; b.textContent = "Extending…";
        api("PATCH", "/api/installs/" + inst.id, { extendDays: days }).then(function (r) {
          if (r.status !== 200) { b.disabled = false; b.textContent = "+" + days + " days";
            return fail((r.body && r.body.error) || "could not extend"); }
          close(); reload();
        });
      };
      return b;
    }
    var save = el("button", { class: "cta", text: "Save", onclick: function () {
      api("PATCH", "/api/installs/" + inst.id, {
        kind: f.kind.value, trialEnds: f.trialEnds.value || null,
        customerNote: f.customerNote.value
      }).then(function (r) {
        if (r.status !== 200) return fail((r.body && r.body.error) || "save failed");
        close(); reload();
      });
    } });
    var scrim = el("div", { class: "scrim" }, [
      el("div", { class: "sheet" }, [
        el("h2", { text: inst.name }),
        el("div", { class: "sub", text: "The licence is written into the business's"
          + " own database, where the till reads its countdown. Paid and internal"
          + " carry no end date." }),
        err,
        el("div", { class: "row2" }, [field("Kind", f.kind), field("Trial ends", f.trialEnds)]),
        inst.kind === "trial"
          ? el("div", { class: "field" }, [el("label", { text: "Extend the trial" }),
            el("div", { style: "display:flex;gap:8px" },
              [extendBtn(7), extendBtn(14), extendBtn(30)])])
          : null,
        field("Note to the customer", f.customerNote),
        el("div", { class: "acts" }, [save])])]);
    scrim.addEventListener("click", function (ev) { if (ev.target === scrim) close(); });
    function close() { scrim.remove(); }
    document.body.appendChild(scrim);
  }

  /* ── THE USAGE REPORT, OUTLET BY OUTLET ─────────────────────────────────────
     The card sums a business into one line; this is the conversation — each
     outlet's windows, its daily trend, its devices, its QR uptake. Every
     figure is the server's; an outlet with nothing traded says so. */
  function fmtAge(ts) {
    if (!ts) return "never";
    var h = Math.floor((Date.now() - new Date(ts).getTime()) / 3600e3);
    if (h < 1) return "under an hour ago";
    if (h < 48) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  function usageSheet(inst) {
    var body = el("div", { class: "sub", text: "Reading…" });
    var head = el("h2", { text: "Usage · " + inst.name });
    var dl = el("button", { class: "mini", text: "Download CSV", onclick: function () {
      dl.disabled = true; dl.textContent = "Preparing…";
      fetch("/api/installs/" + inst.id + "/usage?format=csv", {
        headers: { authorization: "Bearer " + TOKEN } })
        .then(function (r) { return r.blob(); })
        .then(function (b) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(b);
          a.download = "usage-" + String(inst.name).replace(/[^A-Za-z0-9._-]+/g, "-") + ".csv";
          document.body.appendChild(a); a.click(); a.remove();
          dl.disabled = false; dl.textContent = "Download CSV";
        })
        .catch(function () { dl.disabled = false; dl.textContent = "Could not download"; });
    } });
    var scrim = el("div", { class: "scrim" }, [
      el("div", { class: "sheet", style: "max-width:640px" }, [head,
        el("div", { class: "sub", text: "30 days per outlet — aggregates only,"
          + " and the read is on the business's own audit trail." }),
        body,
        el("div", { class: "acts" }, [dl])])]);
    scrim.addEventListener("click", function (ev) { if (ev.target === scrim) scrim.remove(); });
    document.body.appendChild(scrim);

    function stat(k, v, s) {
      return el("div", { class: "kpi", style: "min-width:96px;padding:10px 12px" }, [
        el("div", { class: "k", text: k }),
        el("div", { class: "v mono", text: v, style: "font-size:15px" }),
        s ? el("div", { class: "s", text: s }) : null]);
    }
    api("GET", "/api/installs/" + inst.id + "/usage").then(function (r) {
      if (r.status !== 200 || !r.body) {
        body.textContent = (r.body && r.body.error) || "could not read the report";
        return;
      }
      var u = r.body;
      if (u.state !== "live") { body.textContent = "That business is " + u.state + "."; return; }
      var cur = u.currency || "";
      var kids = [];
      (u.outlets || []).forEach(function (ot) {
        var w30 = ot.last30 || {};
        kids.push(el("div", { style: "margin-top:14px;padding-top:12px;border-top:1px solid var(--line)" }, [
          el("div", { style: "display:flex;align-items:baseline;gap:10px" }, [
            el("b", { text: ot.name }),
            el("span", { class: "sub", text: ot.slug + " · " + ot.tz })]),
          el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" }, [
            stat("Today", fmtMoney((ot.today || {}).net, cur), ((ot.today || {}).tickets || 0) + " bills"),
            stat("Last 7d", fmtMoney((ot.last7 || {}).net, cur), ((ot.last7 || {}).tickets || 0) + " bills"),
            stat("Last 30d", fmtMoney(w30.net, cur),
              (w30.tickets || 0) + " bills · avg " + fmtMoney(w30.avgTicket, "")),
            stat("This month", fmtMoney((ot.thisMonth || {}).net, cur),
              ((ot.thisMonth || {}).covers || 0) + " covers"),
            stat("Last month", fmtMoney((ot.lastMonth || {}).net, cur),
              ((ot.lastMonth || {}).tickets || 0) + " bills")]),
          (function () {
            var s = sparkline((ot.days || []).slice(-14));
            return s ? el("div", { style: "margin-top:6px" }, [s]) : null;
          })(),
          /* `.meta` is styled under `.card` only, and this sits in a sheet —
             without its own flex the spans run together into one word. */
          el("div", { style: "display:flex;flex-wrap:wrap;gap:6px 14px;"
            + "font-size:11.5px;color:var(--text-muted);margin-top:6px" }, [
            el("span", { text: (ot.devices || {}).writers
              ? ot.devices.writers + " till" + (ot.devices.writers === 1 ? "" : "s")
                + (ot.devices.quiet ? " · " + ot.devices.quiet + " quiet >1h" : " · all pushing")
              : "no tills paired" }),
            el("span", { text: "last push " + fmtAge((ot.devices || {}).lastPush) }),
            el("span", { text: (ot.qrOrders30 || 0) + " QR orders in 30d" })])]));
      });
      if (!kids.length) kids.push(el("div", { class: "sub", text: "No outlets yet." }));
      body.className = ""; body.replaceChildren(frag(kids));
    });
  }

  function installCard(inst, reload) {
    var st = statusOf(inst);
    var s = (inst.live || {}).summary || null;
    var today = s && s.days && s.days.length ? s.days[s.days.length - 1] : null;
    var cur = s && s.company ? s.company.currency : "";

    var meta = [];
    if (s) {
      meta.push(el("span", { text: (s.outlets || []).length + " outlet" + ((s.outlets || []).length === 1 ? "" : "s") }));
      var dv = s.devices || {};
      if (dv.writers) {
        var t = dv.writers + " till" + (dv.writers === 1 ? "" : "s");
        meta.push(dv.quiet ? el("span", { class: "warn-t", text: t + " · " + dv.quiet + " quiet >1h" })
          : el("span", { text: t + " · all pushing" }));
      } else meta.push(el("span", { text: "no tills paired yet" }));
      if (today) meta.push(el("span", { text: today.covers + " covers today" }));
      if (s.commit) meta.push(el("span", { class: "mono", text: String(s.commit).slice(0, 7) }));
      /* A business behind schema head is one whose requests are being refused
         by name until the fleet runner catches it up — a warning, not trivia. */
      if (s.schema && s.schema.behind) {
        meta.push(el("span", { class: "warn-t", text: "schema " + s.schema.version
          + " of " + s.schema.head + " — behind head" }));
      }
      /* The backup shelf, from the registry. No rows is a stated state — an
         install with no destination takes no copies and says so at boot — so
         it reads as fact, not alarm. */
      if (s.backup) {
        if (!s.backup.lastOk) {
          meta.push(el("span", { class: "warn-t",
            text: "last backup FAILED" + (s.backup.lastGoodAt
              ? " · last good " + fmtAge(s.backup.lastGoodAt) : "") }));
        } else if (s.backup.ageHours !== null && s.backup.ageHours > 48) {
          meta.push(el("span", { class: "warn-t",
            text: "backup " + fmtAge(s.backup.lastGoodAt) }));
        } else if (s.backup.lastGoodAt) {
          meta.push(el("span", { text: "backup " + fmtAge(s.backup.lastGoodAt) }));
        }
      } else if (REGMODE) {
        meta.push(el("span", { text: "no backup recorded" }));
      }
    } else if (st.note) {
      meta.push(el("span", { class: "warn-t", text: st.note }));
    }
    if (inst.kind === "paid") meta.push(el("span", { text: "Paid" }));
    if (inst.kind === "internal") meta.push(el("span", { text: "Internal" }));

    var figs = null;
    if (s) {
      figs = el("div", { class: "figs" }, [
        el("div", { class: "today" }, [
          el("div", { class: "k", text: "Today, net" }),
          el("div", { class: "v mono", text: today ? fmtMoney(today.net, cur) : "—" })]),
        sparkline(s.days)]);
    }

    return el("div", { class: "card" + (inst.archived ? " archived" : "") }, [
      el("div", { class: "head" }, [
        el("div", { class: "nm" }, [
          el("b", { text: inst.name }),
          el("span", { text: s && s.company ? s.company.name + " · " + inst.base_url.replace(/^https:\/\//, "")
            : inst.base_url.replace(/^https:\/\//, "") })]),
        el("span", { class: "chip " + st.cls }, [el("span", { class: "pip" }),
          document.createTextNode(st.label)])]),
      trialChip(inst) ? el("div", {}, [trialChip(inst)]) : null,
      planAsk(inst),
      figs,
      meta.length ? el("div", { class: "meta" }, meta) : null,
      inst.notes ? el("div", { class: "note", text: inst.notes }) : null,
      el("div", { class: "foot" }, [
        el("a", { href: inst.base_url, target: "_blank", rel: "noopener", style: "text-decoration:none" },
          [el("button", { class: "mini", text: "Open" })]),
        el("span", { class: "grow" }),
        /* The one routine act, one press. The panel has no toast, so the
           button reports its own outcome: on success the reload redraws the
           chip with the new date, which is the feedback that matters. */
        inst.kind === "trial"
          ? (function () {
            var b = el("button", { class: "mini", text: "+14 days" });
            b.onclick = function () {
              b.disabled = true; b.textContent = "Extending\u2026";
              api("PATCH", "/api/installs/" + inst.id, { extendDays: 14 })
                .then(function (r) {
                  if (r.body && r.body.error) {
                    b.disabled = false; b.textContent = r.body.error.slice(0, 40);
                    return;
                  }
                  reload();
                })
                .catch(function () { b.disabled = false; b.textContent = "Did not save"; });
            };
            return b;
          })()
          : null,
        REGMODE && s
          ? el("button", { class: "mini", text: "Usage",
            onclick: function () { usageSheet(inst); } })
          : null,
        el("button", { class: "mini", text: "Edit", onclick: function () {
          if (REGMODE) licenceSheet(inst, reload);
          else sheet(inst, reload);
        } })])]);
  }

  /* ── store requests from the website ──────────────────────────────────── */
  function ageOf(ts) {
    var ms = Date.now() - new Date(ts).getTime();
    var h = Math.floor(ms / 3600e3);
    if (h < 1) return "just now";
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function requestCard(s, reload) {
    var open = s.status === "new" || s.status === "contacted";
    var chip = s.status === "new" ? ["warn", "New request"]
      : s.status === "contacted" ? ["onb", "Contacted"]
      : s.status === "provisioned" ? ["live", "Provisioned"] : ["mute", "Declined"];
    var meta = [el("span", { class: "mono", text: s.email }),
      el("span", { class: "mono", text: s.phone })];
    if (s.island) meta.push(el("span", { text: s.island }));
    meta.push(el("span", { text: ageOf(s.created_at) }));

    var foot = null;
    if (open) {
      var decline = el("button", { class: "mini", text: "Decline" });
      decline.addEventListener("click", function () {
        if (decline.dataset.armed) {
          api("PATCH", "/api/signups/" + s.id, { status: "declined" }).then(reload);
        } else {
          decline.dataset.armed = "1";
          decline.textContent = "Really decline?";
          decline.style.color = "var(--danger-bright)";
        }
      });
      var kids = [];
      if (s.status === "new") kids.push(el("button", { class: "mini", text: "Mark contacted",
        onclick: function () { api("PATCH", "/api/signups/" + s.id, { status: "contacted" }).then(reload); } }));
      kids.push(decline, el("span", { class: "grow" }),
        el("button", { class: "mini", text: "Provision →",
          style: "border-color:var(--go-line);color:var(--go-bright)",
          onclick: function () {
            var end = new Date(Date.now() + 14 * 86400e3);
            sheet(null, reload, {
              heading: "Provision " + s.store_name,
              sub: AUTO.ok
                ? "The panel builds the service, the database and the address, mints every secret, and emails them once it is live. The trial is pre-set to 14 days from today."
                : "Create their app service and database first (DEPLOYMENT.md), set its PLATFORM_KEY, then enter them here. The trial is pre-set to 14 days from today.",
              prefill: { name: s.store_name, kind: "trial",
                trialEnds: end.toISOString().slice(0, 10),
                // Carried through so the handover message can be addressed and
                // sent in the same act that creates the install. Provisioning
                // and telling the customer are one step, not two.
                contactEmail: s.email, contactName: s.contact_name, signupId: s.id,
                notes: s.contact_name + " · " + s.phone + " · " + s.email + (s.island ? " · " + s.island : "") },
              onSaved: function () { reload(); }
            });
          } }));
      foot = el("div", { class: "foot" }, kids);
    }

    return el("div", { class: "card" + (open ? "" : " archived") }, [
      el("div", { class: "head" }, [
        el("div", { class: "nm" }, [
          el("b", { text: s.store_name }),
          el("span", { text: s.contact_name })]),
        el("span", { class: "chip " + chip[0] }, [el("span", { class: "pip" }),
          document.createTextNode(chip[1])])]),
      meta.length ? el("div", { class: "meta" }, meta) : null,
      s.note ? el("div", { class: "note", text: s.note }) : null,
      foot]);
  }

  function kpis(installs, signups) {
    var act = installs.filter(function (i) { return !i.archived; });
    var live = act.filter(function (i) { var c = statusOf(i).cls; return c === "live" || c === "onb"; });
    var unreachable = act.filter(function (i) { var c = statusOf(i).cls; return c === "bad" || c === "warn"; });
    var trialsSoon = act.filter(function (i) {
      if (i.kind !== "trial") return false;
      var d = daysUntil(i.trial_ends);
      return d !== null && d <= 7;
    });
    var byCur = {};
    live.forEach(function (i) {
      var s = (i.live || {}).summary;
      if (!s || !s.company || !s.days || !s.days.length) return;
      var last = s.days[s.days.length - 1];
      byCur[s.company.currency] = (byCur[s.company.currency] || 0) + (Number(last.net) || 0);
    });
    var curKeys = Object.keys(byCur);
    var tiles = [
      { k: WORD.Many, v: String(act.length), s: installs.length > act.length ? (installs.length - act.length) + " archived" : "every one on this page" },
      { k: "Live now", v: String(live.length), s: act.length ? "of " + act.length + " " + WORD.many : "nothing to reach yet" },
      { k: "Trials ending ≤7d", v: String(trialsSoon.length), s: trialsSoon.length ? trialsSoon.map(function (i) { return i.name; }).join(", ") : "no deadlines this week" },
      { k: "Unreachable", v: String(unreachable.length), s: unreachable.length ? unreachable.map(function (i) { return i.name; }).join(", ") : "every " + WORD.one + " answered" }
    ];
    if (curKeys.length) tiles.push({
      k: "Today, all live " + WORD.many,
      v: curKeys.map(function (c) { return fmtMoney(byCur[c], c); }).join("  ·  "),
      s: "net of " + live.length + " live " + (live.length === 1 ? WORD.one : WORD.many), small: true });
    var fresh = (signups || []).filter(function (s) { return s.status === "new"; });
    if (fresh.length) tiles.unshift({
      k: "New store requests", v: String(fresh.length),
      s: fresh.map(function (s) { return s.store_name; }).join(", ") });
    return el("div", { class: "kpis" }, tiles.map(function (t) {
      return el("div", { class: "kpi" }, [
        el("div", { class: "k", text: t.k }),
        el("div", { class: "v", text: t.v, style: t.small ? "font-size:17px" : "" }),
        el("div", { class: "s", text: t.s })]);
    }));
  }

  /* ── when the handover could not be sent ────────────────────────────────
     With no transport configured (RESEND_API_KEY / EMAIL_FROM), or with one
     that refused, the install still exists and the customer still needs the
     two things in that message. So it is shown, in full, to be copied into
     whatever the seller actually uses — and it says which of the two happened
     rather than implying an email is on its way. */
  function handoverFallback(inst, installId, h, reload) {
    var box = el("textarea", { readonly: "readonly",
      style: "width:100%;height:230px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;"
        + "font-size:12px;line-height:1.6;padding:11px 12px;border-radius:10px;"
        + "background:var(--bg-2);border:1px solid var(--line);color:var(--text)" });
    box.value = h.message || "";
    var copied = el("div", { class: "sub", style: "margin-top:6px" });
    var scrim = el("div", { class: "scrim" }, [
      el("div", { class: "sheet" }, [
        el("h2", { text: "Send this to them yourself" }),
        el("div", { class: "sub", text: h.reason === 'no transport configured'
          ? "The install is created. No email transport is configured on this panel "
            + "(RESEND_API_KEY and EMAIL_FROM), so nothing was sent \u2014 here is the "
            + "message, word for word."
          : "The install is created, but the email was refused: " + (h.reason || "unknown")
            + ". Here is the message, word for word." }),
        box,
        copied,
        el("div", { class: "acts" }, [
          el("button", { class: "cta", text: "Copy it", onclick: function () {
            box.select();
            var ok = false;
            try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
            copied.textContent = ok ? "Copied." : "Select the text above and copy it.";
          } }),
          el("button", { class: "mini", text: "Done", onclick: function () {
            document.body.removeChild(scrim); reload();
          } })])])]);
    scrim.addEventListener("click", function (ev) {
      if (ev.target === scrim) { document.body.removeChild(scrim); reload(); }
    });
    document.body.appendChild(scrim);
  }

  /* ── add / edit sheet ─────────────────────────────────────────────────────
     opts (optional): { prefill, heading, sub, onSaved(installId) } — used by
     "Provision" on a store request, which pre-fills what the request said. */
  function sheet(inst, reload, opts) {
    var o = opts || {};
    var pre = o.prefill || {};
    var isNew = !inst;
    var err = el("div", { class: "err", style: "display:none" });
    function fail(m) { err.textContent = m; err.style.display = "block"; }
    var f = {
      name: el("input", { placeholder: "Seaside Café", value: inst ? inst.name : (pre.name || "") }),
      baseUrl: el("input", { placeholder: "https://pos-customer.up.railway.app", value: inst ? inst.base_url : (pre.baseUrl || "") }),
      platformKey: el("input", { type: "password", placeholder: isNew ? "the PLATFORM_KEY set on that install" : "leave blank to keep the current key" }),
      claimCode: el("input", { placeholder: isNew ? "the ONBOARDING_CLAIM_TOKEN set on that install" : "leave blank to keep the current code", value: pre.claimCode || "" }),
      kind: el("select", {}, ["trial", "paid", "internal"].map(function (k) {
        var sel = inst ? inst.kind === k : (pre.kind || "trial") === k;
        var opt = el("option", { value: k, text: k[0].toUpperCase() + k.slice(1) });
        if (sel) opt.setAttribute("selected", "");
        return opt;
      })),
      trialEnds: el("input", { type: "date", value: inst && inst.trial_ends ? String(inst.trial_ends).slice(0, 10) : (pre.trialEnds || "") }),
      notes: el("input", { placeholder: "who this is, contact, anything worth remembering", value: inst ? inst.notes : (pre.notes || "") }),
      /* Who to hand it over TO. Without this the install is created and the
         customer is never told it exists, which was the gap between "the
         seller provisions" and "the customer onboards themselves". */
      contactEmail: el("input", { type: "email", placeholder: "where to send the address and setup code",
        value: inst ? (inst.contact_email || "") : (pre.contactEmail || "") }),
      /* What the CUSTOMER reads beside their own trial countdown. Separate
         from Notes above, which is the seller's private file on the account —
         one column for both is how "chased twice, no answer" ends up on an
         owner's Settings screen. */
      customerNote: el("input", { placeholder: "shown to the customer on their own Settings screen \u2014 optional",
        value: inst ? (inst.customer_note || "") : (pre.customerNote || "") })
    };
    function field(label, input) { return el("div", { class: "field" }, [el("label", { text: label }), input]); }
    var save = el("button", { class: "cta", text: isNew ? "Add the install" : "Save", onclick: function () {
      var body = { name: f.name.value, baseUrl: f.baseUrl.value, kind: f.kind.value,
        trialEnds: f.trialEnds.value || null, notes: f.notes.value,
        contactEmail: f.contactEmail.value, customerNote: f.customerNote.value,
        contactName: pre.contactName || "", signupId: pre.signupId || null };
      if (isNew || f.platformKey.value) body.platformKey = f.platformKey.value;
      // Written only when typed. Blanking it here would silently un-fence the
      // install's onboarding, which is not what "I left a field alone" means.
      if (f.claimCode.value) body.claimCode = f.claimCode.value;
      var call = isNew ? api("POST", "/api/installs", body)
        : api("PATCH", "/api/installs/" + inst.id, body);
      call.then(function (r) {
        if (r.status !== 200) return fail((r.body && r.body.error) || "save failed");
        /* THE HANDOVER IS THE POINT of provisioning, so its outcome is not a
           toast that disappears. A send that could not be made shows the
           message itself, to be copied — the same discipline the app's own
           invitation uses, and for the same reason: a screen that reports a
           send it did not make is worse than one offering no send at all. */
        var h = r.body && r.body.handover;
        if (h && !h.sent) { close(); handoverFallback(inst, r.body.id, h, reload); return; }
        close();
        if (isNew && o.onSaved && r.body && r.body.id) o.onSaved(r.body.id);
        else reload();
      });
    } });
    /* The code the CUSTOMER types into their own /onboarding. It is stored
       here for one reason: when somebody rings up having lost it, the seller
       has to be able to read it back — and a Railway variable is not something
       anyone can find at nine on a Sunday. Shown only when asked for. */
    var codeOut = el("div", { class: "sub", style: "margin-top:6px" });
    var reveal = el("button", { class: "mini", text: "Show setup code", onclick: function () {
      api("GET", "/api/installs/" + inst.id + "/claim").then(function (r) {
        if (r.status !== 200) { codeOut.textContent = "could not read it back"; return; }
        codeOut.textContent = r.body.set
          ? "Setup code: " + r.body.claimCode
          : "No setup code recorded — this install's onboarding is open unless "
            + "ONBOARDING_CLAIM_TOKEN was set on it by hand.";
      });
    } });

    /* ── AUTOMATIC OR BY HAND ───────────────────────────────────────────────
       On a new install where this panel is configured to build one, the three
       fields that exist only because a human had to copy values out of Railway
       — base URL, platform key, setup code — are not asked for at all. They
       are outputs of the run, not inputs to it, and asking for an output is
       how the setup code came to be typed twice into two places that nothing
       compared.

       By hand stays the whole feature underneath, because an install built
       before this existed, or on somebody else's infrastructure, still has to
       be registrable. */
    var auto = isNew && AUTO.ok;
    var manual = [field("Base URL", f.baseUrl), field("Platform key", f.platformKey),
      field("Setup code", f.claimCode)];

    var build = el("button", { class: "cta", text: "Provision it", onclick: function () {
      build.disabled = true;
      build.textContent = "Starting\u2026";
      api("POST", "/api/installs/provision", {
        name: f.name.value, kind: f.kind.value,
        trialEnds: f.trialEnds.value || null, notes: f.notes.value,
        contactEmail: f.contactEmail.value, customerNote: f.customerNote.value,
        contactName: pre.contactName || "", signupId: pre.signupId || null
      }).then(function (r) {
        if (r.status !== 202) {
          build.disabled = false;
          build.textContent = "Provision it";
          return fail((r.body && r.body.error) || "could not start");
        }
        /* Nobody waits here: a first deploy takes minutes. The install appears
           on the dashboard immediately and reports each step as it lands. */
        close();
        reload();
      });
    } });

    var toggle = el("button", { class: "mini", text: "I built this one by hand",
      onclick: function () {
        auto = !auto;
        render();
      } });

    var body = el("div");
    function render() {
      body.textContent = "";
      var kids = [err, field("Name", f.name)];
      if (!auto) manual.forEach(function (x) { kids.push(x); });
      kids.push(el("div", { class: "row2" }, [field("Kind", f.kind), field("Trial ends", f.trialEnds)]),
        field("Their email", f.contactEmail),
        field("Note to the customer", f.customerNote),
        field("Notes (private)", f.notes));

      if (auto) {
        kids.push(el("div", { class: "sub", style: "margin-top:10px;line-height:1.6" },
          [el("span", { text: "Creates the project, the database and its disk, the app "
            + "service and its address; mints every secret; waits for the first deploy; "
            + "then emails the address and setup code. It spends money on your Railway "
            + "account." })]));
        /* A gap that does not STOP the run still has to be seen before it. The
           email transport is the one that matters: without it the install comes
           up fine and the first person to sign up never gets a code, which is
           how it was found. */
        if (AUTO.warn) {
          kids.push(el("div", { class: "err", style: "margin-top:10px;display:block" },
            [el("span", { text: AUTO.warn })]));
        }
        kids.push(el("div", { class: "acts" }, [build]));
        kids.push(el("div", { style: "margin-top:12px;text-align:center" }, [toggle]));
      } else {
        kids.push(el("div", { class: "acts" }, [save]));
        if (isNew && AUTO.ok) {
          kids.push(el("div", { style: "margin-top:12px;text-align:center" },
            [el("button", { class: "mini", text: "Let the panel build it",
              onclick: function () { auto = true; render(); } })]));
        } else if (isNew && AUTO.why) {
          kids.push(el("div", { class: "sub", style: "margin-top:12px;text-align:center" },
            [el("span", { text: "Automatic provisioning is off: " + AUTO.why })]));
        }
      }
      kids.forEach(function (k) { body.appendChild(k); });
    }
    render();
    var kids = [body];
    if (!isNew) kids.push(el("div", { style: "margin-top:10px;text-align:center" },
      [reveal, codeOut]));
    if (!isNew) kids.push(el("div", { style: "margin-top:14px;text-align:center" }, [
      el("button", { class: "mini", text: inst.archived ? "Restore this install" : "Archive this install",
        onclick: function () {
          api("PATCH", "/api/installs/" + inst.id, { archived: !inst.archived }).then(function (r) {
            if (r.status !== 200) return fail((r.body && r.body.error) || "failed");
            close(); reload();
          });
        } })]));
    var scrim = el("div", { class: "scrim" }, [
      el("div", { class: "sheet" }, [
        el("h2", { text: o.heading || (isNew ? "Add an install" : inst.name) }),
        el("div", { class: "sub", text: o.sub || (isNew
          ? "One customer, one install: their app service's address and the PLATFORM_KEY you set on it."
          : "The platform key is held server-side and never shown back. The "
            + "setup code can be — it is the customer's to type.") })].concat(kids))]);
    scrim.addEventListener("click", function (ev) { if (ev.target === scrim) close(); });
    function close() { scrim.remove(); }
    document.body.appendChild(scrim);
  }

  /* ── dashboard shell + refresh loop ───────────────────────────────────── */
  function showDash() {
    if (timer) clearInterval(timer);
    var body = el("div", {});
    var updated = el("div", { class: "updated" });
    /* Filled after the first load, because whether a seller can add anything
       is the server's answer and not this page's assumption. Beside a registry
       the customer creates their own business by signing up, and a button
       whose only outcome is a refusal is the control this panel exists to stop
       shipping. */
    var addSlot = el("span", {});
    var page = el("div", { class: "wrap" }, [
      el("div", { class: "top" }, [
        el("div", { class: "brand" }, [el("span", { class: "dot" }),
          el("b", { text: "Mission Control" }), el("span", { text: "KashikeyoPOS" })]),
        el("span", { class: "grow" }),
        /* Only where a seller can actually add one. Beside a registry the
           customer creates their own business by signing up, and a button
           whose only outcome is a refusal is the control this panel exists to
           stop shipping. */
        addSlot,
        el("button", { class: "ghost", text: "Sign out", onclick: function () {
          setToken(null); if (timer) clearInterval(timer); showSignin();
        } })]),
      body, updated]);
    mount({ cls: "", node: page });

    function load() {
      Promise.all([api("GET", "/api/overview"), api("GET", "/api/signups")]).then(function (rs) {
        var r = rs[0], rq = rs[1];
        if (r.status === 401) { setToken(null); if (timer) clearInterval(timer); return showSignin(); }
        if (r.status !== 200) {
          body.replaceChildren(el("div", { class: "empty" }, [
            el("b", { text: "The panel could not read its registry" }),
            document.createTextNode((r.body && r.body.error) || "try again in a moment")]));
          return;
        }
        setWord(r.body.mode);
        DEDICATED = r.body.dedicated !== false;
        addSlot.replaceChildren(DEDICATED
          ? el("button", { class: "primary", text: "Add install",
            onclick: function () { sheet(null, load); } })
          : el("span", { class: "hint", text: "customers sign themselves up" }));
        var installs = r.body.installs || [];
        var signups = (rq.status === 200 && rq.body.signups) || [];
        var openReqs = signups.filter(function (s) { return s.status === "new" || s.status === "contacted"; });
        var out = [];
        if (installs.length || openReqs.length) out.push(kpis(installs, signups));
        if (openReqs.length) {
          out.push(el("div", { class: "sechead", text: "Store requests" }));
          out.push(el("div", { class: "cards" }, openReqs.map(function (s) { return requestCard(s, load); })));
        }
        if (installs.length) {
          if (openReqs.length) out.push(el("div", { class: "sechead", text: WORD.Many }));
          out.push(el("div", { class: "cards" }, installs.map(function (i) { return installCard(i, load); })));
        } else if (!openReqs.length) {
          out.push(el("div", { class: "empty" }, [
            el("b", { text: DEDICATED ? "No installs registered yet" : "No businesses yet" }),
            document.createTextNode(DEDICATED
              ? "Add your first customer's install — or wait for a store request from the website."
              : "A customer creates their own the moment they sign up on the website and confirm their email. Nothing here to press.")]));
        }
        body.replaceChildren(frag(out));
        updated.textContent = "Updated " + new Date(r.body.at).toLocaleTimeString();
      });
    }
    load();
    timer = setInterval(load, 60e3);
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */
  api("GET", "/api/state").then(function (r) {
    if (r.body) {
      AUTO = { ok: !!r.body.auto, why: r.body.autoWhy || "",
        warn: r.body.autoWarn || "" };
    }
    if (r.body && r.body.setup) return showSetup();
    if (TOKEN) return showDash();
    showSignin();
  });
}());
