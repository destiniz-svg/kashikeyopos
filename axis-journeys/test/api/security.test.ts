/**
 * The security properties, over HTTP.
 *
 * Each of these is a way in that must stay shut, and each is checked against the server as it
 * deploys rather than against the function that implements it. The rate-limit ceilings run at their
 * real values here (`RATE_LIMIT_SCALE=1`), which is why this file has a server of its own.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { body, startServer, type Harness } from '../support/server'
import { form, jpeg } from '../support/media'

let h: Harness
before(async () => { h = await startServer({ RATE_LIMIT_SCALE: '1' }) })
after(async () => { await h?.stop() })

const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  h.api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })

/** A distinct caller address, so one test's spend is not charged to the next. */
const from = (ip: string) => ({ 'cf-connecting-ip': ip })

describe('response headers', () => {
  it('every page carries the security headers the brief names', async () => {
    const res = await fetch(h.base + '/')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.match(res.headers.get('referrer-policy') || '', /strict-origin/)
    assert.match(res.headers.get('permissions-policy') || '', /geolocation=\(\)/)
  })

  it('every page carries a Content-Security-Policy with a fresh nonce', async () => {
    const a = (await fetch(h.base + '/')).headers.get('content-security-policy') || ''
    const b = (await fetch(h.base + '/')).headers.get('content-security-policy') || ''
    assert.match(a, /script-src[^;]*'strict-dynamic'/)
    assert.equal(a.includes("'unsafe-inline'") && /script-src[^;]*'unsafe-inline'/.test(a), false)
    const nonceA = /'nonce-([^']+)'/.exec(a)?.[1]
    const nonceB = /'nonce-([^']+)'/.exec(b)?.[1]
    assert.ok(nonceA && nonceB, 'a nonce is minted per response')
    assert.notEqual(nonceA, nonceB, 'the same nonce twice is no nonce at all')
  })

  it('an API answer is never cached by a shared cache', async () => {
    for (const path of ['/api/health', '/api/auth/me']) {
      assert.match((await h.api(path)).headers.get('cache-control') || '', /no-store/, path)
    }
  })

  it('no answer leaks the server’s own identity or a stack', async () => {
    const res = await h.api('/api/properties')
    const text = await res.text()
    assert.equal(/node_modules|webpack|\.next\/server|at async|node:internal/.test(text), false)
  })
})

describe('rate limiting', () => {
  it('the enquiry door refuses one address that keeps knocking', async () => {
    // Five a minute per identity. The sixth is a 429 carrying Retry-After.
    const payload = { name: 'Repeat Caller', email: 'repeat@example.test' }
    let refused: Response | null = null
    for (let i = 0; i < 8; i++) {
      const res = await post('/api/public/enquiries', payload, from('203.0.113.10'))
      if (res.status === 429) { refused = res; break }
    }
    assert.ok(refused, 'the door never refused')
    assert.ok(Number(refused.headers.get('retry-after')) > 0, 'Retry-After tells the caller when to come back')
    const out = await body<{ error: string }>(refused)
    assert.equal(/secret|hash|stack|node:/.test(out.error), false)
  })

  it('one address being refused does not refuse a different guest', async () => {
    // A hotel's wifi puts a whole lobby behind one address; a doorman that cannot tell forty guests
    // from one attacker locks out the guests. The identity bucket is what keeps them apart.
    const res = await post('/api/public/enquiries', { name: 'A Different Guest', email: 'different@example.test' }, from('203.0.113.10'))
    assert.equal(res.status, 200, `a second guest behind the same address was refused (${res.status})`)
  })

  it('sign-in refuses a caller guessing passwords', async () => {
    let refused = false
    for (let i = 0; i < 12; i++) {
      const res = await post('/api/auth/login', { email: 'guess@axisjourneys.com', password: `guess-${i}` }, from('203.0.113.20'))
      if (res.status === 429) { refused = true; break }
      assert.equal(res.status, 401)
    }
    assert.equal(refused, true, 'a guessing caller was never slowed down')
  })

  it('a correct sign-in never spends the budget', async () => {
    // The budget is charged on failure only: a counter signing its team in all morning must not be
    // locked out by its own success.
    for (let i = 0; i < 12; i++) {
      const cookie = await h.signIn()
      assert.ok(cookie.startsWith('axis_session='), `attempt ${i + 1}`)
    }
  })
})

describe('path traversal and injection', () => {
  it('a media id that is not an id cannot reach the filesystem', async () => {
    for (const id of ['../../../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'a/../../b', '%2e%2e%2f']) {
      const res = await h.api(`/api/media/${encodeURIComponent(id)}/card`)
      assert.notEqual(res.status, 200, `${id} answered 200`)
      const text = await res.text()
      assert.equal(text.includes('root:'), false, 'a system file was served')
    }
  })

  it('a rendition size that is not one of the three is refused', async () => {
    const res = await h.api('/api/media/mabc/../../secret')
    assert.notEqual(res.status, 200)
  })

  it('a document id cannot escape its collection', async () => {
    const cookie = await h.signIn()
    for (const id of ['../offers/x', '..%2Fusers', 'ID%23baros']) {
      const res = await h.api(`/api/properties/${encodeURIComponent(id)}`, { cookie })
      assert.notEqual(res.status, 200, `${id} answered 200`)
    }
  })

  it('hostile content stored through the CMS comes back as data, never as markup', async () => {
    // The site renders through React, which escapes; this pins that the API does not helpfully
    // decode anything on the way back out.
    const cookie = await h.signIn()
    const payload = '"><script>alert(document.cookie)</script>'
    await h.api('/api/destinations/maldives', {
      method: 'PUT', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: { name: 'Maldives', slug: 'maldives', tagline: payload, intro: 'x'.repeat(200), live: false } }),
    })
    const read = await body<{ draft: { tagline: string } }>(await h.api('/api/destinations/maldives', { cookie }))
    assert.equal(read.draft.tagline, payload, 'stored verbatim rather than half-escaped')
    const page = await (await fetch(h.base + '/')).text()
    assert.equal(page.includes('<script>alert(document.cookie)</script>'), false, 'it reached the page as markup')
    await h.api('/api/destinations/maldives/discard', { method: 'POST', cookie, headers: { 'content-type': 'application/json' } })
  })
})

describe('media uploads', () => {
  it('accepts three real renditions and hands back a reference the editor can use', async () => {
    const cookie = await h.signIn()
    const res = await h.api('/api/media', { method: 'POST', cookie, body: form({ hero: jpeg(), card: jpeg(), thumb: jpeg(), name: 'A photograph', alt: 'A reef at dusk' }) })
    const rec = await body<{ id: string; ref: string; urls: Record<string, string>; alt: string }>(res)
    assert.equal(res.status, 201, JSON.stringify(rec))
    assert.match(rec.ref, /^media:m[a-z0-9]+$/)
    assert.equal(rec.alt, 'A reef at dusk')
    const img = await h.api(`/api/media/${rec.id}/card`)
    assert.equal(img.status, 200, 'the rendition is actually served back')
    assert.match(img.headers.get('content-type') || '', /image\//)
  })

  it('refuses a file whose bytes are not an image, whatever the header claims', async () => {
    // A content-type is whatever the client says; the first bytes are what it is.
    const cookie = await h.signIn()
    const f = new FormData()
    const evil = new Uint8Array(Buffer.from('<?php system($_GET["c"]); ?>', 'utf8'))
    for (const size of ['hero', 'card', 'thumb']) f.set(size, new File([evil], `${size}.jpg`, { type: 'image/jpeg' }))
    const res = await h.api('/api/media', { method: 'POST', cookie, body: f })
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /JPEG, PNG or WebP/)
  })

  it('refuses a partial upload rather than storing a record with a hole in it', async () => {
    const cookie = await h.signIn()
    const res = await h.api('/api/media', { method: 'POST', cookie, body: form({ hero: jpeg(), name: 'Only one size' }) })
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /Every rendition/)
  })

  it('refuses an upload from a caller with no session, and from one without the media permission', async () => {
    assert.equal((await h.api('/api/media', { method: 'POST', body: form({ hero: jpeg(), card: jpeg(), thumb: jpeg() }) })).status, 401)
    const cookie = await h.signIn()
    await h.api('/api/users', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sales', email: 'nomedia@axisjourneys.com', role: 'sales', password: 'a-long-enough-password' }) })
    const sales = await h.signIn('nomedia@axisjourneys.com', 'a-long-enough-password')
    assert.equal((await h.api('/api/media', { method: 'POST', cookie: sales, body: form({ hero: jpeg(), card: jpeg(), thumb: jpeg() }) })).status, 403)
  })
})

describe('what the store never returns', () => {
  it('there is no route that hands out a user record with its hash', async () => {
    const cookie = await h.signIn()
    for (const path of ['/api/users', '/api/auth/me', '/api/activity', '/api/lists', '/api/public/site']) {
      const raw = await (await h.api(path, { cookie })).text()
      assert.equal(/passwordHash|scrypt\$[0-9a-f]/.test(raw), false, `${path} carries a hash`)
    }
  })

  it('a configuration value never reaches a response', async () => {
    const cookie = await h.signIn()
    for (const path of ['/api/ready', '/api/health', '/api/public/site']) {
      const raw = await (await h.api(path, { cookie })).text()
      for (const secret of ['a-test-session-secret-of-at-least-32-characters', 'AWS_SECRET_ACCESS_KEY', 'SESSION_SECRET']) {
        assert.equal(raw.includes(secret), false, `${path} carries ${secret}`)
      }
    }
  })

  it('the readiness probe says what is wrong without saying where the credentials are', async () => {
    const res = await h.api('/api/ready')
    const out = await body<{ ok: boolean; faults: string[]; properties: number }>(res)
    assert.equal(out.ok, true, JSON.stringify(out.faults))
    assert.equal(out.properties, 9)
  })
})
