/* ═══ A SHEET IS A DIALOG ════════════════════════════════════════════════════
   For the guest and member portals, whose sheets (a dish, the round, the
   card) are drawn as a scrim and a panel. The panel carries role="dialog"
   aria-modal="true" in the markup; this gives it the behaviour a keyboard and
   a screen reader expect, the same as the till's one dialog frame:

     · focus moves into the sheet when it appears, and back to whatever
       opened it when it goes;
     · Tab stays inside it — the page behind the scrim is not there;
     · Escape closes it, by tapping the scrim the sheet already closes on
       (the element just before the dialog, marked data-dismiss), so there
       is one way to close a sheet, not two.

   Watched rather than wired into each opener, so a sheet added later gets
   all three by carrying the two attributes. */
(function () {
  "use strict";
  var open = null, opener = null;
  function current() { return document.querySelector('[role="dialog"][aria-modal="true"]'); }

  new MutationObserver(function () {
    var d = current();
    if (d && d !== open) {
      if (!open) opener = document.activeElement;
      open = d;
      if (!d.contains(document.activeElement)) d.focus({ preventScroll: true });
    } else if (!d && open) {
      open = null;
      var o = opener;
      opener = null;
      if (o && o.isConnected && o.focus) o.focus({ preventScroll: true });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("keydown", function (e) {
    var d = current();
    if (!d || e.defaultPrevented) return;
    if (e.key === "Escape") {
      var s = d.previousElementSibling;
      if (s && s.hasAttribute("data-dismiss")) { e.preventDefault(); s.click(); }
      return;
    }
    if (e.key !== "Tab") return;
    var f = Array.prototype.filter.call(d.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    function (x) { return !x.disabled && x.offsetParent !== null; });
    if (!f.length) { e.preventDefault(); d.focus(); return; }
    var a = document.activeElement, first = f[0], last = f[f.length - 1];
    var out = !d.contains(a);
    if (out || (e.shiftKey ? (a === first || a === d) : a === last)) {
      e.preventDefault();
      (e.shiftKey && !out ? last : first).focus();
    }
  });
})();
