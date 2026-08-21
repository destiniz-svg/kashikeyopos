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

/* The handle this request is addressed to, or null for the apex app. `www` is
   the apex under another name and never a store. An unknown subdomain IS
   treated as a store host: the portal then says the address names no store,
   which is the truth, where serving the till would not be. */
function hostHandle(host) {
  const base = baseDomain();
  if (!base) return null;
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!h || h === base || h === 'www.' + base) return null;
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

function memberUrl(handle) { return storeUrl(handle, '/member'); }
function tableUrl(handle, table) {
  return storeUrl(handle, '/?t=' + encodeURIComponent(String(table == null ? '' : table)));
}

module.exports = { MIN, MAX, SHAPE, normalise, shapeError, ok,
  baseDomain, hostHandle, storeUrl, memberUrl, tableUrl };
