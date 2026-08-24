/* ═══ MISSION CONTROL — THE PAGE ═════════════════════════════════════════════
   Vanilla DOM, no framework, no build. Everything on screen is a figure the
   server measured or an honest empty state — the panel never invents a
   number, and a status is always an icon AND a label, never a colour alone.
   All content goes through textContent (the `el` helper), so a customer's
   install name cannot script the seller's panel. */
(function () {
  "use strict";

  var TOKEN = null;
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
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var d = new Date(String(dateStr).slice(0, 10) + "T23:59:59");
    return Math.ceil((d - new Date()) / 86400e3);
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
  function statusOf(inst) {
    var l = inst.live || {};
    if (l.state === "archived") return { cls: "mute", label: "Archived" };
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
      figs,
      meta.length ? el("div", { class: "meta" }, meta) : null,
      inst.notes ? el("div", { class: "note", text: inst.notes }) : null,
      el("div", { class: "foot" }, [
        el("a", { href: inst.base_url, target: "_blank", rel: "noopener", style: "text-decoration:none" },
          [el("button", { class: "mini", text: "Open" })]),
        el("span", { class: "grow" }),
        el("button", { class: "mini", text: "Edit", onclick: function () { sheet(inst, reload); } })])]);
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
              sub: "Create their app service and database first (DEPLOYMENT.md), set its PLATFORM_KEY, then enter them here. The trial is pre-set to 14 days from today.",
              prefill: { name: s.store_name, kind: "trial",
                trialEnds: end.toISOString().slice(0, 10),
                notes: s.contact_name + " · " + s.phone + " · " + s.email + (s.island ? " · " + s.island : "") },
              onSaved: function (installId) {
                api("PATCH", "/api/signups/" + s.id, { status: "provisioned", installId: installId }).then(reload);
              }
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
      { k: "Installs", v: String(act.length), s: installs.length > act.length ? (installs.length - act.length) + " archived" : "every one on this page" },
      { k: "Live now", v: String(live.length), s: act.length ? "of " + act.length + " installs" : "nothing to reach yet" },
      { k: "Trials ending ≤7d", v: String(trialsSoon.length), s: trialsSoon.length ? trialsSoon.map(function (i) { return i.name; }).join(", ") : "no deadlines this week" },
      { k: "Unreachable", v: String(unreachable.length), s: unreachable.length ? unreachable.map(function (i) { return i.name; }).join(", ") : "every install answered" }
    ];
    if (curKeys.length) tiles.push({
      k: "Today, all live installs",
      v: curKeys.map(function (c) { return fmtMoney(byCur[c], c); }).join("  ·  "),
      s: "net of " + live.length + " live install" + (live.length === 1 ? "" : "s"), small: true });
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
      notes: el("input", { placeholder: "who this is, contact, anything worth remembering", value: inst ? inst.notes : (pre.notes || "") })
    };
    function field(label, input) { return el("div", { class: "field" }, [el("label", { text: label }), input]); }
    var save = el("button", { class: "cta", text: isNew ? "Add the install" : "Save", onclick: function () {
      var body = { name: f.name.value, baseUrl: f.baseUrl.value, kind: f.kind.value,
        trialEnds: f.trialEnds.value || null, notes: f.notes.value };
      if (isNew || f.platformKey.value) body.platformKey = f.platformKey.value;
      // Written only when typed. Blanking it here would silently un-fence the
      // install's onboarding, which is not what "I left a field alone" means.
      if (f.claimCode.value) body.claimCode = f.claimCode.value;
      var call = isNew ? api("POST", "/api/installs", body)
        : api("PATCH", "/api/installs/" + inst.id, body);
      call.then(function (r) {
        if (r.status !== 200) return fail((r.body && r.body.error) || "save failed");
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

    var kids = [err, field("Name", f.name), field("Base URL", f.baseUrl),
      field("Platform key", f.platformKey),
      field("Setup code", f.claimCode),
      el("div", { class: "row2" }, [field("Kind", f.kind), field("Trial ends", f.trialEnds)]),
      field("Notes", f.notes),
      el("div", { class: "acts" }, [save])];
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
    var page = el("div", { class: "wrap" }, [
      el("div", { class: "top" }, [
        el("div", { class: "brand" }, [el("span", { class: "dot" }),
          el("b", { text: "Mission Control" }), el("span", { text: "KashikeyoPOS" })]),
        el("span", { class: "grow" }),
        el("button", { class: "primary", text: "Add install", onclick: function () { sheet(null, load); } }),
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
          if (openReqs.length) out.push(el("div", { class: "sechead", text: "Installs" }));
          out.push(el("div", { class: "cards" }, installs.map(function (i) { return installCard(i, load); })));
        } else if (!openReqs.length) {
          out.push(el("div", { class: "empty" }, [
            el("b", { text: "No installs registered yet" }),
            document.createTextNode("Add your first customer's install — or wait for a store request from the website.")]));
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
    if (r.body && r.body.setup) return showSetup();
    if (TOKEN) return showDash();
    showSignin();
  });
}());
