/**
 * The security headers, and the policy that decides what a page may load.
 *
 * A Content-Security-Policy is one long string, which is exactly why it needs a test: a missing
 * directive reads as a policy that is present and is a hole, and nothing on any screen says so.
 * The set here mirrors SECURITY.md and the prototype's own Cloudflare `_headers` file.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { contentSecurityPolicy, longCacheHeaders, noStoreHeaders, securityHeaders } from '@/lib/http/headers.mjs'

const parse = (value: string): Record<string, string[]> =>
  Object.fromEntries(value.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...rest] = d.split(/\s+/)
    return [name, rest]
  }))

const policy = (over = {}) => parse(contentSecurityPolicy({ development: false, ...over }).value)

describe('contentSecurityPolicy', () => {
  it('every directive SECURITY.md names is present', () => {
    const d = policy()
    for (const name of [
      'default-src', 'script-src', 'style-src', 'font-src', 'img-src', 'media-src',
      'frame-src', 'connect-src', 'worker-src', 'object-src', 'base-uri', 'form-action',
      'frame-ancestors', 'upgrade-insecure-requests',
    ]) {
      assert.ok(name in d, `${name} is missing`)
    }
  })

  it('shuts the three that matter most', () => {
    const d = policy()
    assert.deepEqual(d['object-src'], ["'none'"], 'a plugin is an execution context')
    assert.deepEqual(d['base-uri'], ["'self'"], 'an injected <base> re-points every relative URL')
    assert.deepEqual(d['form-action'], ["'self'"], 'or an injected form posts the guest elsewhere')
  })

  it('never allows unsafe-inline in script-src, nonce or not', () => {
    assert.equal(policy()['script-src'].includes("'unsafe-inline'"), false)
    assert.equal(policy({ nonce: 'abc123' })['script-src'].includes("'unsafe-inline'"), false)
  })

  it('a nonce brings strict-dynamic with it', () => {
    const s = policy({ nonce: 'abc123' })['script-src']
    assert.ok(s.includes("'nonce-abc123'"))
    assert.ok(s.includes("'strict-dynamic'"))
  })

  it('unsafe-eval is a development allowance and is never in the shipped policy', () => {
    assert.equal(policy({ development: false })['script-src'].includes("'unsafe-eval'"), false)
    assert.equal(policy({ development: true })['script-src'].includes("'unsafe-eval'"), true)
  })

  it('style-src keeps unsafe-inline, which is the design contract and carries no script', () => {
    // Every measurement in this build is an inline style attribute, ported from the prototype.
    assert.ok(policy()['style-src'].includes("'unsafe-inline'"))
    assert.equal(policy()['style-src'].includes('*'), false)
  })

  it('no directive is a wildcard', () => {
    for (const [name, values] of Object.entries(policy({ nonce: 'n', apiOrigin: 'https://api.axisjourneys.com', mediaOrigin: 'https://media.axisjourneys.com' }))) {
      for (const v of values) assert.notEqual(v, '*', `${name} is wide open`)
      assert.equal(values.includes('http:'), false, `${name} allows plaintext`)
    }
  })

  it('every host it does allow is https', () => {
    const d = policy({ nonce: 'n' })
    for (const [name, values] of Object.entries(d)) {
      for (const v of values) {
        if (v.includes('://')) assert.ok(v.startsWith('https://'), `${name}: ${v}`)
      }
    }
  })

  it('the bot check can load and be reached, or the enquiry form cannot work', () => {
    const d = policy()
    assert.ok(d['script-src'].includes('https://challenges.cloudflare.com'))
    assert.ok(d['frame-src'].includes('https://challenges.cloudflare.com'))
    assert.ok(d['connect-src'].includes('https://challenges.cloudflare.com'))
  })

  it('a separate API origin is allowed to be reached only when one is configured', () => {
    assert.equal(policy()['connect-src'].includes('https://api.axisjourneys.com'), false)
    assert.ok(policy({ apiOrigin: 'https://api.axisjourneys.com' })['connect-src'].includes('https://api.axisjourneys.com'))
  })

  it('a media CDN is allowed for images and media, and for nothing else', () => {
    const d = policy({ mediaOrigin: 'https://cdn.axisjourneys.com' })
    assert.ok(d['img-src'].includes('https://cdn.axisjourneys.com'))
    assert.ok(d['media-src'].includes('https://cdn.axisjourneys.com'))
    assert.equal(d['script-src'].includes('https://cdn.axisjourneys.com'), false)
    assert.equal(d['connect-src'].includes('https://cdn.axisjourneys.com'), false)
  })

  it('lists no host twice', () => {
    const d = policy({ nonce: 'n', mediaOrigin: 'https://media.axisjourneys.com' })
    for (const [name, values] of Object.entries(d)) assert.equal(new Set(values).size, values.length, `${name} repeats a source`)
  })

  it('report-only is a different header, so it cannot be enabled by accident', () => {
    assert.equal(contentSecurityPolicy({ development: false }).header, 'Content-Security-Policy')
    assert.equal(contentSecurityPolicy({ development: false, reportOnly: true }).header, 'Content-Security-Policy-Report-Only')
  })
})

describe('securityHeaders', () => {
  const asMap = (list: { key: string; value: string }[]) => Object.fromEntries(list.map((h) => [h.key, h.value]))

  it('carries the headers the brief names', () => {
    const h = asMap(securityHeaders({ production: true }))
    assert.equal(h['X-Content-Type-Options'], 'nosniff')
    assert.equal(h['X-Frame-Options'], 'SAMEORIGIN')
    assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin')
    assert.match(h['Permissions-Policy'], /camera=\(\)/)
    assert.match(h['Permissions-Policy'], /geolocation=\(\)/)
  })

  it('HSTS is production-only, because it is meaningless and harmful over plain http', () => {
    // Sent from a local http origin it would pin a developer's browser to https for two years.
    assert.equal('Strict-Transport-Security' in asMap(securityHeaders({ production: false })), false)
    assert.match(asMap(securityHeaders({ production: true }))['Strict-Transport-Security'], /max-age=63072000; includeSubDomains; preload/)
  })
})

describe('cache headers', () => {
  it('an immutable asset is cached for a year', () => {
    assert.match(longCacheHeaders()[0].value, /max-age=31536000, immutable/)
  })

  it('a no-store response is also kept out of the index', () => {
    const h = Object.fromEntries(noStoreHeaders().map((x) => [x.key, x.value]))
    assert.match(h['Cache-Control'], /no-store/)
    assert.match(h['X-Robots-Tag'], /noindex/)
  })
})
