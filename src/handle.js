'use strict';
/* ═══ A STORE'S ADDRESS ═════════════════════════════════════════════════════
   Every store has a handle, and the handle is a subdomain:

       https://<handle>.kashikeyopos.com          the QR ordering portal
       https://<handle>.kashikeyopos.com/member   the customer's card

   This file is the only place that knows how to spell one and the only place
   that knows what the base domain is. A hostname hardcoded in a page is a
   hostname that is wrong in staging, and a QR card printed with a wrong
   hostname is a laminated mistake on forty tables.

   The SHAPE is stated here and in chain.handle_shape_ok() — the browser needs
   to reject "Sea House" before asking, and the database needs to reject it
   whoever asks. test/handle.test.js runs the same cases through both.

   The RESERVED list is NOT here. It lives in chain.reserved_handle, one copy,
   because it grows with the product and a list you have to redeploy to extend
   is a list that gets worked around.
   ═══════════════════════════════════════════════════════════════════════ */

const MIN = 3, MAX = 40;
const SHAPE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/* Turn what somebody typed into the nearest legal handle. Deliberately lossy:
   it is a suggestion offered back to them, never a silent substitution. */
function normalise(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/, '');
}

/* Why this handle cannot be used — as a sentence, because "invalid" sends
   somebody hunting for a typo in a handle that is spelled perfectly. Returns
   null when the shape is fine; whether it is FREE is a question for the
   database, which owns both the reserved list and the outlets. */
function shapeError(h) {
  const s = String(h == null ? '' : h);
  if (!s) return 'a store address is required';
  if (s.length < MIN) return 'a store address needs at least ' + MIN + ' characters';
  if (s.length > MAX) return 'a store address can be at most ' + MAX + ' characters';
  if (s !== s.toLowerCase()) return 'a store address is all lower case';
  if (/[^a-z0-9-]/.test(s)) return 'a store address may use only letters, numbers and hyphens';
  if (/^-|-$/.test(s)) return 'a store address cannot start or end with a hyphen';
  if (/--/.test(s)) return 'a store address cannot contain two hyphens in a row';
  if (!SHAPE.test(s)) return 'that is not a usable store address';
  return null;
}

const ok = (h) => shapeError(h) === null;

/* The domain stores hang off. PORTAL_BASE_DOMAIN wins when it is set;
   PUBLIC_URL is the fallback, so a normal deploy needs one variable, not two.

   Setting PORTAL_BASE_DOMAIN to an EMPTY value turns store subdomains off
   deliberately, and that is not the same as leaving it unset. An environment
   whose apex has no wildcard record — a staging box on a shared vendor domain,
   say — would otherwise inherit that apex from PUBLIC_URL and start handing out
   https://<handle>.<something-that-cannot-resolve>. Off, every link falls back
   to its path form, which is followable. */
function baseDomain() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'PORTAL_BASE_DOMAIN')) {
    return clean(process.env.PORTAL_BASE_DOMAIN);
  }
  const pub = String(process.env.PUBLIC_URL || '').trim();
  if (!pub) return '';
  try { return new URL(pub).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return ''; }
}

function clean(v) {
  return String(v == null ? '' : v).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/^\*\./, '');
}

/* The till's OWN hostname — the host of PUBLIC_URL. It used to be assumed
   equal to the base domain, which was true while the software sat on the
   apex; now the apex is the product's website and the till lives at
   app.<base>, so the two are different names and this is the only place
   that knows the till's. Configuration, never the request's Host header. */
function appHost() {
  const pub = String(process.env.PUBLIC_URL || '').trim();
  if (!pub) return '';
  try { return new URL(pub).hostname.toLowerCase(); } catch (e) { return ''; }
}

/* The handle this request is addressed to, or null for the till itself.
   The till answers on its own host (PUBLIC_URL), on the bare base domain and
   on `www.` — the latter two so a deploy whose apex still points here keeps
   working through a domain move. An unknown subdomain IS treated as a store
   host: the portal then says the address names no store, which is the truth,
   where serving the till would not be. */
function hostHandle(host) {
  const base = baseDomain();
  if (!base) return null;
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!h || h === base || h === 'www.' + base) return null;
  const own = appHost();
  if (own && h === own) return null;             // the till's own address
  if (h.slice(-(base.length + 1)) !== '.' + base) return null;
  const label = h.slice(0, h.length - base.length - 1);
  if (label.indexOf('.') >= 0) return null;      // a.b.base is nobody's store
  return ok(label) ? label : null;
}

/* The public address of a store, absolute where we know the domain and a path
   where we do not — so a link is always followable, never a broken guess. */
function storeUrl(handle, path) {
  const p = path || '';
  const base = baseDomain();
  if (!base || !ok(handle)) return '/g/' + encodeURIComponent(handle || '') + p;
  return 'https://' + handle + '.' + base + p;
}

/* The card. On a store's own subdomain it is /member; where we do not know the
   domain the path form is /m/<handle> — a DIFFERENT shape, not /g/<handle>
   with /member glued on, which routes nowhere and lands a guest on the till's
   own sign-in screen. The till reads this address out to customers, so a link
   that only works in production is a link that sends people nowhere in
   staging. */
function memberUrl(handle) {
  const base = baseDomain();
  if (!base || !ok(handle)) return '/m/' + encodeURIComponent(handle || '');
  return 'https://' + handle + '.' + base + '/member';
}
function tableUrl(handle, table) {
  return storeUrl(handle, '/?t=' + encodeURIComponent(String(table == null ? '' : table)));
}

/* Where an invitation lands. `/join/<token>` on the store's own address, and
   the path form everywhere the base domain is not known — the same shape as
   the card, because a link printed in a message outlives the environment that
   composed it.

   The parameter is NEVER called `t`. `?t=` is the table on the QR portal and
   the tracking parameter most email click-wrappers append, and a reader that
   accepted one there would be taking a foreign credential into a membership
   lookup. The path is canonical; `?invite=` is the fallback. */
/* WHERE A LINK IN A MESSAGE POINTS. Everything else in this file may fall back
   to a path form, because a path is followable from a page the guest is already
   on. An invitation is not: it travels to an inbox, and `/join/MV-...` in an
   inbox resolves against nothing.

   Two absolute forms, in order:

     the store's own subdomain, when the base domain is known;
     PUBLIC_URL, when subdomains are deliberately off (PORTAL_BASE_DOMAIN set
     empty) or the deploy has no wildcard record — the slug then rides `?s=`,
     which the guest bridge already reads.

   And NOT the request's `Host`. That header is client-supplied, so deriving the
   link from it would let anyone who can reach the API put their own domain into
   an invitation a guest has been told to trust. A link this build asks somebody
   to tap comes from configuration or it does not come at all. */
function portalOrigin(handle) {
  const base = baseDomain();
  if (base && ok(handle)) return 'https://' + handle + '.' + base;
  return String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
}

/* An absolute `/join/<token>`, or an EMPTY STRING when this deploy cannot spell
   one. The caller refuses rather than composing a message around a link that
   goes nowhere — the same rule that stopped a screen claiming it had sent an
   SMS. `s`, never `t`: `t` is the table on the QR portal and the tracking
   parameter every email click-wrapper appends. */
function joinUrl(handle, token) {
  const origin = portalOrigin(handle);
  if (!origin) return '';
  const t = encodeURIComponent(String(token || ''));
  const base = baseDomain();
  if (base && ok(handle)) return origin + '/join/' + t;
  return origin + '/join/' + t
    + (handle ? '?s=' + encodeURIComponent(handle) : '');
}

module.exports = { MIN, MAX, SHAPE, normalise, shapeError, ok,
  baseDomain, appHost, hostHandle, storeUrl, memberUrl, tableUrl, joinUrl, portalOrigin };
