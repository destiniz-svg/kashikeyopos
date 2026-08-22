/* ═══ WHAT AN INVITATION SAYS ═══════════════════════════════════════════════
   Loaded by the browser as a script and by the server as a module, exactly
   like `kashikeyo-rules.js`. There is ONE copy of this text.

   That matters more here than anywhere else in the build: the till shows the
   guest the message before sending it, and the server is what actually sends
   it. Two copies of the same paragraph means a till that proofreads one
   sentence and a guest who receives another.

   A loyalty link arriving cold reads as phishing, and a guest who suspects
   phishing does not tap it. So the copy is composed HERE rather than typed by
   whoever is at the till, and it proves provenance with four things a bulk
   sender would not have:

     the guest's own name          a bulk sender rarely has it
     the OUTLET's name             not the chain's — the room they were in
     their actual points balance   nobody outside the restaurant knows this
     the person who sent it        a name to ask for at the counter

   The balance does most of that work and costs nothing to include. It is
   dropped entirely at zero, where it would argue against the invitation
   rather than for it.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.KASHIKEYO_INVITE = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* A minted token has a shape, and every branch that reads one is held to it.
     `MV-<random>-<minted at>`: the middle is the secret, the tail only makes a
     reissued token visibly different from the one it replaced. */
  const TOKEN_RE = /^MV-[A-Za-z0-9]+-\d+$/;

  function cleanToken(v) {
    const t = String(v == null ? "" : v).trim();
    return TOKEN_RE.test(t) ? t : "";
  }

  /* `/join/<token>` is the canonical form. Nothing here spells a hostname —
     the base comes from `src/handle.js` on the server and from `PORTAL.base`
     in the terminal, because a domain typed into a page is right in production
     and wrong in staging. */
  function inviteLink(base, token) {
    const b = String(base || "").replace(/\/+$/, "");
    return (b ? b : "") + "/join/" + encodeURIComponent(token || "");
  }

  const CHANNELS = [
    { key: "email", label: "Email", needs: "email address", field: "email" },
    { key: "viber", label: "Viber", needs: "mobile number", field: "phone" },
    { key: "whatsapp", label: "WhatsApp", needs: "mobile number", field: "phone" }
  ];

  function channel(k) {
    return CHANNELS.filter((c) => c.key === k)[0] || null;
  }

  /* `1842` is a serial number; `1,842` is a quantity. A guest reading their own
     balance should be reading the second one. */
  function figure(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function firstNameOf(name) {
    return String(name || "").trim().split(/\s+/)[0] || "there";
  }

  /* opts: { chan, name, outlet, chain, points, worth, sender, link }
     `worth` arrives already formatted, because what a point is worth is the
     outlet's currency and this module has no business knowing one. */
  function compose(opts) {
    const o = opts || {};
    const chan = o.chan === "email" ? "email" : "app";
    const first = firstNameOf(o.name);
    const outlet = String(o.outlet || "").trim();
    const chain = String(o.chain || "Kashikeyo").trim() || "Kashikeyo";
    const pts = Number(o.points || 0);
    const ptsW = figure(pts);
    const worth = String(o.worth || "").trim();
    const who = String(o.sender || "").trim() || "the team";
    const link = String(o.link || "");
    const where = outlet || chain;

    if (chan === "email") {
      const held = pts
        ? "You have " + ptsW + " points already on your account, worth " + worth
          + " off a bill."
        : "You have points on every visit from here on.";
      return {
        subject: chain + " Rewards · "
          + (pts ? ptsW + " points are already yours" : "your membership is ready"),
        body: [
          "Hello " + first + ",",
          "",
          held + " This link opens your account, where you can see every receipt,"
            + " follow an order from the kitchen, and spend points at the table:",
          "",
          link,
          "",
          "It works once and expires in seven days. If it lapses, ask any of us at "
            + where + " and we will send another.",
          "",
          "Sent by " + who + " at " + where + ".",
          "If you were not expecting this, nothing has been opened and you can ignore it."
        ].join("\n"),
        link: link
      };
    }

    /* One paragraph, because the app shows two lines in a notification and the
       rest only if it is opened. The outlet's name LEADS, so the preview
       identifies itself before anyone has to decide whether to trust it. */
    const body = where + " here, " + first + " — your rewards account is ready"
      + (pts ? ", with " + ptsW + " points on it already (" + worth + " off a bill)" : "")
      + ". Open it here: " + link
      + "\nOne use, seven days. Sent by " + who + ".";
    return { subject: "", body: body, link: link };
  }

  /* WhatsApp's click-to-chat: the only WhatsApp send this build can honestly
     make, because it is the STAFF MEMBER's own app that sends it. A server
     cannot post to it, and pretending otherwise is the defect this build keeps
     refusing to ship. Viber's equivalent (`viber://`) only works from a device
     that already has the app, so a server-composed Viber invite has no link
     form at all and the message is handed over instead. */
  function whatsappHandoff(phone, body) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "";
    return "https://wa.me/" + digits + "?text=" + encodeURIComponent(String(body || ""));
  }

  return {
    TOKEN_RE: TOKEN_RE,
    cleanToken: cleanToken,
    inviteLink: inviteLink,
    CHANNELS: CHANNELS,
    channel: channel,
    figure: figure,
    firstNameOf: firstNameOf,
    compose: compose,
    whatsappHandoff: whatsappHandoff
  };
}));
