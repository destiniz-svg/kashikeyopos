/**
 * The CMS plane, over HTTP: who may sign in, who may reach what, and whether an edit survives a
 * round trip through the store.
 *
 * The rank is the gate and it is checked on the route, so the tests that matter most here are the
 * refusals — a contributor reaching publish, a sales account reaching the catalogue, a signed-out
 * caller reaching anything, and a cross-site request that carries a stolen cookie.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { OWNER, body, startServer, type Harness } from '../support/server'
import type { SiteBundle } from '@/lib/content/types'

let h: Harness
let owner: string
before(async () => {
  h = await startServer()
  owner = await h.signIn()
})
after(async () => { await h?.stop() })

const json = (method: string, cookie: string, payload?: unknown) => ({
  method,
  cookie,
  headers: { 'content-type': 'application/json' },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
})

/** Create an account at a given role and sign in as it. */
async function member(role: string, email: string): Promise<string> {
  const password = 'a-team-member-password'
  const res = await h.api('/api/users', json('POST', owner, { name: `A ${role}`, email, role, password }))
  assert.equal(res.status, 201, `creating the ${role}: ${await res.text()}`)
  return h.signIn(email, password)
}

describe('signing in', () => {
  it('answers with the account and what it may do', async () => {
    const res = await h.api('/api/auth/login', json('POST', '', { email: OWNER.email, password: OWNER.password }))
    assert.equal(res.status, 200)
    const out = await body<{ user: { email: string; role: string; can: string[] } }>(res)
    assert.equal(out.user.email, OWNER.email)
    assert.equal(out.user.role, 'owner')
    assert.ok(out.user.can.includes('publish'))
  })

  it('never returns a password hash', async () => {
    const res = await h.api('/api/auth/login', json('POST', '', { email: OWNER.email, password: OWNER.password }))
    const raw = await res.text()
    assert.equal(/passwordHash|scrypt\$/.test(raw), false)
  })

  it('the session cookie is HttpOnly, SameSite=Lax and path-scoped', async () => {
    // A token a script can read is a token an injected script can take.
    const res = await h.api('/api/auth/login', json('POST', '', { email: OWNER.email, password: OWNER.password }))
    const set = res.headers.get('set-cookie') || ''
    assert.match(set, /HttpOnly/i)
    assert.match(set, /SameSite=Lax/i)
    assert.match(set, /Path=\//i)
  })

  it('refuses a wrong password and an unknown address in the same words', async () => {
    // A door that answers differently is a door that enumerates the team.
    const wrong = await h.api('/api/auth/login', json('POST', '', { email: OWNER.email, password: 'not-the-password' }))
    const unknown = await h.api('/api/auth/login', json('POST', '', { email: 'nobody@axisjourneys.com', password: 'not-the-password' }))
    assert.equal(wrong.status, 401)
    assert.equal(unknown.status, 401)
    assert.deepEqual(await body(wrong), await body(unknown))
  })

  it('refuses an empty or malformed credential without a stack trace', async () => {
    for (const payload of [{}, { email: '', password: '' }, { email: OWNER.email }, { email: { $ne: null }, password: { $ne: null } }]) {
      const res = await h.api('/api/auth/login', json('POST', '', payload))
      assert.equal(res.status, 401, JSON.stringify(payload))
      const out = await body<{ error: string }>(res)
      assert.equal(/node:internal|at .*:\d+:\d+/.test(out.error), false)
    }
  })

  it('a request with no session is nobody, not an error', async () => {
    const out = await body<{ user: null }>(await h.api('/api/auth/me'))
    assert.equal(out.user, null)
  })

  it('signing out ends the session at once, not when the token happens to expire', async () => {
    // Clearing the cookie only stops the browser sending it. A copy taken from a shared machine
    // must stop working the moment somebody signs out, which is what the `ver` claim is for.
    const cookie = await h.signIn()
    assert.ok((await body<{ user: unknown }>(await h.api('/api/auth/me', { cookie }))).user)
    const out = await h.api('/api/auth/logout', json('POST', cookie))
    assert.equal(out.status, 200)
    const stale = await body<{ user: unknown }>(await h.api('/api/auth/me', { cookie }))
    assert.equal(stale.user, null, 'the old token still authenticates')
    assert.equal((await h.api('/api/properties', { cookie })).status, 401, 'and still reaches the catalogue')
    // Signing out twice is not an error somebody has to understand.
    assert.equal((await h.api('/api/auth/logout', json('POST', cookie))).status, 200)
    owner = await h.signIn()
  })
})

describe('the rank gate', () => {
  it('refuses every admin route to a caller with no session', async () => {
    for (const path of ['/api/properties', '/api/offers', '/api/enquiries', '/api/users', '/api/media', '/api/activity', '/api/lists']) {
      const res = await h.api(path)
      assert.equal(res.status, 401, `${path} answered ${res.status}`)
    }
  })

  it('a contributor may draft but not publish and not delete', async () => {
    const cookie = await member('contributor', 'contributor@axisjourneys.com')
    const list = await h.api('/api/properties', { cookie })
    assert.equal(list.status, 200, 'a contributor reads the catalogue')

    const created = await h.api('/api/properties', json('POST', cookie, { id: 'contributor-draft', draft: { name: 'A draft' } }))
    assert.equal(created.status, 201, 'and writes a draft')

    assert.equal((await h.api('/api/properties/contributor-draft/publish', json('POST', cookie))).status, 403)
    assert.equal((await h.api('/api/properties/contributor-draft', json('DELETE', cookie))).status, 403)
    assert.equal((await h.api('/api/users', { cookie })).status, 403, 'and never reaches the team')
  })

  it('a sales account reaches the enquiries and nothing else', async () => {
    const cookie = await member('sales', 'sales@axisjourneys.com')
    assert.equal((await h.api('/api/enquiries', { cookie })).status, 200)
    assert.equal((await h.api('/api/properties', json('POST', cookie, { id: 'sales-cannot', draft: {} }))).status, 403)
    assert.equal((await h.api('/api/users', { cookie })).status, 403)
    assert.equal((await h.api('/api/media', json('POST', cookie, {}))).status, 403)
  })

  it('an editor publishes but does not administer accounts', async () => {
    const cookie = await member('editor', 'editor@axisjourneys.com')
    assert.equal((await h.api('/api/users', { cookie })).status, 403)
    assert.equal((await h.api('/api/offers', { cookie })).status, 200)
  })

  it('an unknown collection is a 404, not a partition key composed from the URL', async () => {
    // `users`, `media` and `enquiries` are their own routes with their own gates; what must never
    // resolve is a segment the caller invented reaching the collection handler.
    // A traversal in the path is normalised by the URL layer before anything routes, so it never
    // reaches here — that case is proved against the media route in `security.test.ts`. What this
    // pins is that an invented segment cannot become a partition key.
    for (const col of ['secrets', 'passwords', 'PROPERTIES', 'properties;drop', 'COL%23properties']) {
      const res = await h.api(`/api/${encodeURIComponent(col)}`, { cookie: owner })
      assert.equal(res.status, 404, `/api/${col} answered ${res.status}`)
    }
  })
})

describe('cross-site protection', () => {
  it('a write without the app’s own header is refused even with a valid cookie', async () => {
    // SameSite=Lax stops a cross-site form post; this is the second belt, and it is the one that
    // holds if a browser ever relaxes the first.
    const res = await fetch(`${h.base}/api/properties/baros`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: owner },
      body: JSON.stringify({ draft: { name: 'Renamed by a cross-site post' } }),
    })
    assert.equal(res.status, 403)
  })

  it('a write from another origin is refused', async () => {
    const res = await h.api('/api/properties/baros', {
      method: 'PUT',
      cookie: owner,
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ draft: { name: 'Renamed from elsewhere' } }),
    })
    assert.equal(res.status, 403)
  })

  it('a read is not gated on the header, because a read changes nothing', async () => {
    const res = await fetch(`${h.base}/api/properties`, { headers: { cookie: owner } })
    assert.equal(res.status, 200)
  })
})

describe('editing a document', () => {
  it('a save changes the draft and never the published version', async () => {
    const doc = await body<{ draft: Record<string, unknown>; live: Record<string, unknown>; status: string }>(await h.api('/api/properties/baros', { cookie: owner }))
    assert.equal(doc.status, 'published')
    const saved = await body<{ draft: { verdict: string }; live: { verdict: string }; status: string }>(
      await h.api('/api/properties/baros', json('PUT', owner, { draft: { ...doc.draft, verdict: 'An edited verdict for the test.' } })),
    )
    assert.equal(saved.draft.verdict, 'An edited verdict for the test.')
    assert.equal(saved.live.verdict, doc.live.verdict, 'the published copy is untouched')
    assert.equal(saved.status, 'changed')

    // Discard puts the draft back to what is published, which is what the CMS button promises.
    const back = await body<{ draft: { verdict: string }; status: string }>(await h.api('/api/properties/baros/discard', json('POST', owner)))
    assert.equal(back.draft.verdict, doc.live.verdict)
    assert.equal(back.status, 'published')
  })

  it('the id in the path wins over one in the body', async () => {
    // A draft filed under one name and read back under another is a document that disappears.
    const saved = await body<{ id: string; draft: { id: string } }>(
      await h.api('/api/properties/baros', json('PUT', owner, { draft: { id: 'somewhere-else', name: 'Baros Maldives' } })),
    )
    assert.equal(saved.id, 'baros')
    assert.equal(saved.draft.id, 'baros')
    await h.api('/api/properties/baros/discard', json('POST', owner))
  })

  it('refuses an id that is not a slug', async () => {
    for (const id of ['../escape', 'Has Capitals', 'has spaces', 'has/slash']) {
      const res = await h.api(`/api/properties/${encodeURIComponent(id)}`, json('PUT', owner, { draft: {} }))
      assert.ok(res.status === 400 || res.status === 404, `${id} answered ${res.status}`)
    }
  })
})

describe('publishing', () => {
  it('refuses an incomplete property and says exactly what is missing', async () => {
    await h.api('/api/properties', json('POST', owner, { id: 'half-written', draft: { name: 'Half Written' } }))
    const res = await h.api('/api/properties/half-written/publish', json('POST', owner))
    assert.equal(res.status, 422)
    const out = await body<{ error: string; fields: { missing: string } }>(res)
    // The same words the CMS's completeness bar shows, from the same function.
    for (const want of ['destination', 'hero photo', 'day-by-day itinerary', 'transfer options', 'themes']) {
      assert.ok(out.fields.missing.includes(want), `"${want}" is not in "${out.fields.missing}"`)
    }
  })

  it('a refused publish leaves the property off the site', async () => {
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.some((p) => p.id === 'half-written'), false)
  })

  it('publishing a complete property puts it on the site in the same act', async () => {
    // The document and the recomposed bundle are committed together: a published property the
    // bundle does not carry is a publish that did not happen.
    const source = await body<{ draft: Record<string, unknown> }>(await h.api('/api/properties/baros', { cookie: owner }))
    const draft = { ...source.draft, id: 'test-island', name: 'Test Island Resort' }
    await h.api('/api/properties', json('POST', owner, { id: 'test-island', draft }))
    const res = await h.api('/api/properties/test-island/publish', json('POST', owner))
    assert.equal(res.status, 200, await res.text())

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.some((p) => p.id === 'test-island'), true, 'the bundle was rewritten in the same transaction')
  })

  it('unpublishing takes it off the site and keeps the draft', async () => {
    assert.equal((await h.api('/api/properties/test-island/unpublish', json('POST', owner))).status, 200)
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.some((p) => p.id === 'test-island'), false)
    const doc = await body<{ draft: { name: string }; live: unknown; status: string }>(await h.api('/api/properties/test-island', { cookie: owner }))
    assert.equal(doc.draft.name, 'Test Island Resort')
    assert.equal(doc.live, null)
    assert.equal(doc.status, 'draft')
  })

  it('refuses an offer that does not name a property this site holds', async () => {
    await h.api('/api/offers', json('POST', owner, { id: 'orphan-offer', draft: { resort: 'no-such-resort', badge: 'Deal', date: 'May 2026', perk: 'A perk' } }))
    const res = await h.api('/api/offers/orphan-offer/publish', json('POST', owner))
    assert.equal(res.status, 422)
    assert.match((await body<{ fields: { missing: string } }>(res)).fields.missing, /a property/)
  })

  it('deleting a published document takes it off the site too', async () => {
    assert.equal((await h.api('/api/properties/test-island', json('DELETE', owner))).status, 200)
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.some((p) => p.id === 'test-island'), false)
    assert.equal((await h.api('/api/properties/test-island', { cookie: owner })).status, 404)
  })
})

describe('the team', () => {
  it('never returns a password hash in any answer', async () => {
    const raw = await (await h.api('/api/users', { cookie: owner })).text()
    assert.equal(/passwordHash|scrypt\$/.test(raw), false)
  })

  it('refuses a second account on one address', async () => {
    const res = await h.api('/api/users', json('POST', owner, { name: 'Twice', email: OWNER.email, role: 'editor', password: 'another-long-password' }))
    assert.equal(res.status, 409)
  })

  it('refuses a short password by name rather than storing it', async () => {
    const res = await h.api('/api/users', json('POST', owner, { name: 'Short', email: 'short@axisjourneys.com', role: 'editor', password: 'short' }))
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /12 characters/)
  })

  it('refuses a role that is not one of the four', async () => {
    for (const role of ['admin', 'root', '__proto__', '']) {
      const res = await h.api('/api/users', json('POST', owner, { name: 'Bad Role', email: `role-${encodeURIComponent(role)}@axisjourneys.com`, role, password: 'a-long-enough-password' }))
      assert.equal(res.status, 400, `role "${role}" answered ${res.status}`)
    }
  })

  it('an invited account with no password exists and cannot sign in', async () => {
    const created = await body<{ id: string; invited: boolean }>(
      await h.api('/api/users', json('POST', owner, { name: 'Invited', email: 'invited@axisjourneys.com', role: 'editor' })),
    )
    assert.equal(created.invited, true)
    for (const password of ['', 'anything', 'a-long-enough-password']) {
      const res = await h.api('/api/auth/login', json('POST', '', { email: 'invited@axisjourneys.com', password }))
      assert.equal(res.status, 401, `signed in with "${password}"`)
    }
  })

  it('refuses the two removals that end in a workspace nobody can sign in to', async () => {
    const users = await body<{ id: string; email: string; role: string }[]>(await h.api('/api/users', { cookie: owner }))
    const me = users.find((u) => u.email === OWNER.email)!
    const res = await h.api(`/api/users/${me.id}`, json('DELETE', owner))
    assert.equal(res.status, 400, 'removing yourself')
    assert.match((await body<{ error: string }>(res)).error, /your own account/i)

    const demote = await h.api(`/api/users/${me.id}`, json('PATCH', owner, { role: 'editor' }))
    assert.equal(demote.status, 400, 'demoting the last owner')
  })

  it('a new password ends every session signed with the old one', async () => {
    const cookie = await member('editor', 'rotating@axisjourneys.com')
    assert.ok((await body<{ user: unknown }>(await h.api('/api/auth/me', { cookie }))).user)
    const users = await body<{ id: string; email: string }[]>(await h.api('/api/users', { cookie: owner }))
    const them = users.find((u) => u.email === 'rotating@axisjourneys.com')!
    assert.equal((await h.api(`/api/users/${them.id}`, json('PATCH', owner, { password: 'a-brand-new-long-password' }))).status, 200)
    // A revocation that is recorded but not read is not a revocation.
    const after = await body<{ user: unknown }>(await h.api('/api/auth/me', { cookie }))
    assert.equal(after.user, null)
  })

  it('a demotion takes effect at once, without waiting for the token to expire', async () => {
    const cookie = await member('editor', 'demoted@axisjourneys.com')
    assert.equal((await h.api('/api/offers', json('POST', cookie, { id: 'editor-can', draft: {} }))).status, 201)
    const users = await body<{ id: string; email: string }[]>(await h.api('/api/users', { cookie: owner }))
    const them = users.find((u) => u.email === 'demoted@axisjourneys.com')!
    assert.equal((await h.api(`/api/users/${them.id}`, json('PATCH', owner, { role: 'sales' }))).status, 200)
    assert.equal((await h.api('/api/offers', json('POST', cookie, { id: 'sales-cannot-now', draft: {} }))).status, 403)
  })
})

describe('the CRM', () => {
  it('moves an enquiry along and keeps the note', async () => {
    const created = await body<{ id: string }>(
      await h.api('/api/public/enquiries', json('POST', '', { name: 'Ibrahim Waheed', email: 'crm@example.test', month: 'July' })),
    )
    const patched = await body<{ status: string; notes: { by: string; text: string }[] }>(
      await h.api(`/api/enquiries/${created.id}`, json('PATCH', owner, { status: 'contacted', note: 'Called; sending two options.' })),
    )
    assert.equal(patched.status, 'contacted')
    assert.equal(patched.notes.at(-1)?.text, 'Called; sending two options.')
    assert.ok(patched.notes.at(-1)?.by, 'the note records who wrote it')
  })

  it('a caller cannot patch a field the CRM does not own', async () => {
    const created = await body<{ id: string }>(
      await h.api('/api/public/enquiries', json('POST', '', { name: 'Fathimath Ali', email: 'crm2@example.test' })),
    )
    const patched = await body<{ email: string; createdAt: number; id: string }>(
      await h.api(`/api/enquiries/${created.id}`, json('PATCH', owner, { email: 'moved@example.test', createdAt: 0, id: 'renamed' })),
    )
    assert.equal(patched.email, 'crm2@example.test', 'the guest’s own address is not editable here')
    assert.equal(patched.id, created.id)
    assert.ok(patched.createdAt > 0)
  })

  it('refuses a status that is not one of the five', async () => {
    const created = await body<{ id: string }>(
      await h.api('/api/public/enquiries', json('POST', '', { name: 'Hawwa Moosa', email: 'crm3@example.test' })),
    )
    const res = await h.api(`/api/enquiries/${created.id}`, json('PATCH', owner, { status: 'invented' }))
    assert.equal(res.status, 400)
  })
})
