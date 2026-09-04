/**
 * Per-request security: a fresh CSP nonce on every HTML response (Next's `proxy` convention).
 *
 * The app ships no inline script of its own, but React's streaming runtime does, so a nonce is what
 * keeps `'unsafe-inline'` out of `script-src` — SECURITY.md asks for exactly that. It costs static
 * rendering (a nonce cannot be baked into a cached document), which is why HTML carries
 * `must-revalidate` and only the immutable assets are cached hard — the same split the prototype's
 * own `_headers` file already made.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { contentSecurityPolicy } from './lib/http/headers.mjs'
// Aliased because Next reserves the name `config` in this file for its own matcher. Reading
// process.env directly here would be the one place that skipped `src/lib/config.ts` — and with it
// the rule that a dangling `${{…}}` reference is not a value, which would put the literal into the
// Content-Security-Policy as an allowed origin.
import { config as app } from './lib/config'

export const config = {
  // Static assets and the image optimiser carry no HTML, so they skip this entirely.
  matcher: ['/((?!_next/static|_next/image|assets/|favicon.ico).*)'],
}

export default function proxy(req: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const csp = contentSecurityPolicy({
    nonce,
    apiOrigin: app.apiOrigin || undefined,
    mediaOrigin: app.mediaOrigin || undefined,
  })

  const headers = new Headers(req.headers)
  // Passed inward so the layout can hand the same nonce to React.
  headers.set('x-nonce', nonce)

  const res = NextResponse.next({ request: { headers } })
  res.headers.set(csp.header, csp.value)
  return res
}
