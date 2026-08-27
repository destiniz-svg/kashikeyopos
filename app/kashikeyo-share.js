/* ═══ HANDING A DOCUMENT TO A GUEST ═════════════════════════════════════════
   Loaded by the browser as a script and by the server as a module, exactly
   like `kashikeyo-invite.js` and `kashikeyo-rules.js`. There is ONE copy of
   this text, and that matters here for the same reason it matters there: the
   till shows the cashier the message before it goes, and the server is what
   sends it. Two copies means a till that proofreads one sentence and a guest
   who receives another.

   THREE CHANNELS, ONE MECHANISM. A receipt is a page at a permanent address;
   sharing it is handing over that address. Email carries the link, and so do
   WhatsApp and Viber — as a CLICK-TO-CHAT handoff opened from the staff
   member's own app, which is the only WhatsApp or Viber send this build can
   honestly make. Every till in this category works this way: nobody sends
   WhatsApp from a POS without Business API approval, and pretending otherwise
   is the "a control does what it says" defect wearing a green tick.

   So the channel decides the transport and nothing else. The document, its
   link and its wording are identical down all three.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.KASHIKEYO_SHARE = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CHANNELS = [
    ["email", "Email", "the address on their record"],
    ["whatsapp", "WhatsApp", "opens WhatsApp with the message ready"],
    ["viber", "Viber", "opens Viber with the message ready"]
  ];

  /* A phone number reaches wa.me and viber as DIGITS ONLY, with the country
     code and no plus. "+960 771 2345" and "00960 7712345" are the same
     number and neither works verbatim: wa.me answers 404 on a space and
     Viber ignores the argument entirely. A local Maldivian number typed with
     no country code gets 960, because that is the only country this build
     ships a currency, a tax office and a threshold for — and a wrong guess
     here sends somebody's receipt to a stranger, so anything that does not
     resolve to a plausible number is refused rather than dialled. */
  function msisdn(phone) {
    let d = String(phone == null ? "" : phone).replace(/[^\d]/g, "");
    if (!d) return "";
    d = d.replace(/^0+/, "");
    if (d.length === 7) d = "960" + d;          // a bare Maldivian mobile
    return d.length >= 8 && d.length <= 15 ? d : "";
  }

  const money = (cur, n) => String(cur || "MVR") + " "
    + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

  /* WHAT THE GUEST READS. Short, because it arrives on a phone beside a
     hundred other messages, and specific, because a bare link from a number
     they do not have saved reads as spam. The outlet's name and the figure
     are what make it recognisable in one glance — they were standing in that
     room ten minutes ago. */
  function receiptText(o) {
    const s = o || {};
    const shop = String(s.outlet || "").trim();
    const who = String(s.name || "").trim().split(/\s+/)[0];
    const lines = [];
    lines.push((who ? who + ", y" : "Y") + "our receipt from "
      + (shop || "us") + (s.docNo ? " — " + s.docNo : "") + ".");
    if (s.total != null) lines.push(money(s.currency, s.total) + " on " + (s.when || "today") + ".");
    if (s.link) lines.push(s.link);
    return lines.join("\n");
  }

  /* A STATEMENT is a period, not a moment, so it says which period — an
     account summary with no dates on it is a figure the customer cannot
     check against anything. */
  function statementText(o) {
    const s = o || {};
    const shop = String(s.outlet || "").trim();
    const who = String(s.name || "").trim().split(/\s+/)[0];
    const lines = [];
    lines.push((who ? who + ", y" : "Y") + "our account statement from "
      + (shop || "us") + ".");
    if (s.from && s.to) lines.push(s.from + " to " + s.to + ".");
    if (s.balance != null) {
      lines.push(Number(s.balance) > 0
        ? "Outstanding: " + money(s.currency, s.balance) + "."
        : "Nothing outstanding.");
    }
    if (s.link) lines.push(s.link);
    return lines.join("\n");
  }

  function subjectFor(kind, o) {
    const s = o || {};
    const shop = String(s.outlet || "").trim();
    return kind === "statement"
      ? "Your account statement" + (shop ? " from " + shop : "")
      : "Your receipt" + (s.docNo ? " " + s.docNo : "") + (shop ? " from " + shop : "");
  }

  function bodyFor(kind, o) {
    return kind === "statement" ? statementText(o) : receiptText(o);
  }

  /* WHERE THE CHANNEL OPENS. `wa.me` and `viber://forward` are both the
     vendors' own published share entry points; neither sends anything by
     itself, both hand the composed message to an app the person is already
     signed into. Viber's takes no recipient — it opens the share sheet — so
     the number only narrows WhatsApp. */
  function channelUrl(channel, o) {
    const text = bodyFor((o || {}).kind, o);
    const enc = encodeURIComponent(text);
    if (channel === "whatsapp") {
      const to = msisdn((o || {}).phone);
      return "https://wa.me/" + to + "?text=" + enc;
    }
    if (channel === "viber") return "viber://forward?text=" + enc;
    if (channel === "email") {
      const to = encodeURIComponent(String((o || {}).email || ""));
      return "mailto:" + to + "?subject="
        + encodeURIComponent(subjectFor((o || {}).kind, o)) + "&body=" + enc;
    }
    return "";
  }

  /* CAN THIS CHANNEL BE USED AT ALL, and if not, in words that name the fix.
     A control that is offered and then refuses is worse than one that says
     up front what it needs — and "add an email on the customer first" is only
     useful next to somewhere to add one, which is what the till does with it. */
  function why(channel, o) {
    const s = o || {};
    if (!s.link) return "this document has no address yet";
    if (channel === "email" && !String(s.email || "").trim()) return "no email address on file";
    if (channel === "whatsapp" && !msisdn(s.phone)) return "no usable mobile number on file";
    return "";
  }

  return {
    CHANNELS: CHANNELS, msisdn: msisdn, money: money,
    receiptText: receiptText, statementText: statementText,
    subjectFor: subjectFor, bodyFor: bodyFor, channelUrl: channelUrl, why: why
  };
}));
