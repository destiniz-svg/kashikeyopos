// Security headers. Shared by next.config.mjs (static headers) and the middleware (per-request CSP).
// The set mirrors design_handoff_axis_journeys/SECURITY.md and the prototype's Cloudflare `_headers`
// file byte for byte, so a deploy behind Cloudflare Pages and a deploy behind AWS agree.

/**
 * Hosts the browser is allowed to reach. Kept in one place so the CSP and next.config agree.
 *
 * `img` is the list the CATALOGUE actually publishes from — the agency's own domain, Unsplash, and
 * each resort that hosts its own photography. It is not derived from the content at runtime, which
 * would let an editor widen a security policy by pasting a URL; it is a decision, and
 * `test/unit/content-integrity.test.ts` fails when the catalogue names a host that is not on it. A
 * blocked image is otherwise invisible: the card renders, the photograph does not, and only the
 * browser console says why.
 */
export const ORIGINS = {
  turnstile: 'https://challenges.cloudflare.com',
  fonts: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  img: [
    'https://images.unsplash.com',
    'https://axisjourneys.com',
    'https://media.axisjourneys.com',
    // Resorts that serve their own photography.
    'https://www.sunsiyam.com',
  ],
  media: ['https://media.axisjourneys.com', 'https://videos.pexels.com'],
  maps: ['https://maps.google.com', 'https://www.google.com'],
}

/**
 * Content-Security-Policy.
 * `nonce` is minted per response by the middleware: the app ships no inline script of its own, but
 * the React streaming runtime does, so a nonce is the only way to keep `unsafe-inline` out of
 * script-src. `connect-src` carries the extra API origin only when the API is deployed apart.
 */
export function contentSecurityPolicy({ nonce, apiOrigin, mediaOrigin, reportOnly = false, development = process.env.NODE_ENV !== 'production' } = {}) {
  const script = ["'self'", ORIGINS.turnstile]
  if (nonce) script.push(`'nonce-${nonce}'`, "'strict-dynamic'")
  // React's development build compiles with eval for its debugging tools. It is never in the
  // production bundle, so the allowance is scoped to development rather than shipped.
  if (development) script.push("'unsafe-eval'")
  const connect = ["'self'", ORIGINS.turnstile]
  if (apiOrigin) connect.push(apiOrigin)
  const img = ["'self'", 'data:', 'blob:', ...ORIGINS.img]
  const media = ["'self'", ...ORIGINS.media]
  if (mediaOrigin) { img.push(mediaOrigin); media.push(mediaOrigin) }

  const directives = [
    `default-src 'self'`,
    `script-src ${dedupe(script).join(' ')}`,
    // Inline style attributes are the design contract of this build — every measurement in the
    // prototype is an inline declaration — so style-src keeps 'unsafe-inline'. It carries no script.
    `style-src 'self' 'unsafe-inline' ${ORIGINS.fonts[0]}`,
    `font-src 'self' ${ORIGINS.fonts[1]}`,
    `img-src ${dedupe(img).join(' ')}`,
    `media-src ${dedupe(media).join(' ')}`,
    `frame-src ${ORIGINS.maps.join(' ')} ${ORIGINS.turnstile}`,
    `connect-src ${dedupe(connect).join(' ')}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
    `upgrade-insecure-requests`,
  ]
  return { header: reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', value: directives.join('; ') }
}

const dedupe = (a) => [...new Set(a)]

/** Headers every response carries. HSTS is only meaningful over TLS, so it is production-only. */
export function securityHeaders({ production = process.env.NODE_ENV === 'production' } = {}) {
  const h = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'X-DNS-Prefetch-Control', value: 'on' },
  ]
  if (production) h.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' })
  return h
}

export function longCacheHeaders() {
  return [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]
}

export function noStoreHeaders() {
  return [
    { key: 'Cache-Control', value: 'no-store, max-age=0' },
    { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ]
}
