/**
 * The public plane, over HTTP against a real server and a real store.
 *
 * Two questions run through all of it. Does the site actually serve the catalogue end to end — not
 * a fixture, not a static file, the store's own answer? And does the one door open to the internet
 * that writes a record hold: sanitising, rate-limiting, and never handing a stranger anything the
 * store knows that they should not.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { body, startServer, type Harness } from '../support/server'
import type { SiteBundle } from '@/lib/content/types'

let h: Harness
before(async () => { h = await startServer() })
after(async () => { await h?.stop() })

const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  h.api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })

describe('GET /api/public/site', () => {
  it('serves the published catalogue from the store', async () => {
    const res = await h.api('/api/public/site')
    assert.equal(res.status, 200)
    const bundle = await body<SiteBundle>(res)
    assert.equal(bundle.properties.length, 9, 'the nine site-ready properties')
    assert.ok(bundle.offers.length > 0)
    assert.ok(bundle.destinations.length > 0)
    assert.ok(bundle.settings, 'the company settings')
    assert.equal(bundle.preview, false)
  })

  it('serves only properties that are actually ready — the rule is applied server-side', async () => {
    // A stub hidden only by the browser is a stub one view-source away from being read.
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    for (const p of bundle.properties) {
      assert.equal(p.draft ?? false, false, `${p.id} is a draft`)
      assert.equal(p.detailPending ?? false, false, `${p.id} is pending detail`)
      assert.ok(p.villas.length && p.days.length && p.transfers.length && p.themes.length, `${p.id} is incomplete`)
    }
  })

  it('every offer it publishes names a property it also publishes', async () => {
    // An offer whose resort is not live is an offer card that opens onto nothing.
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const ids = new Set(bundle.properties.map((p) => p.id))
    for (const o of bundle.offers) assert.equal(ids.has(o.resort), true, `offer ${o.id} points at ${o.resort}`)
  })

  it('carries nothing a guest may not see', async () => {
    // The public bundle is the whole of what an anonymous caller gets, so it is the one place a
    // staff record, a password hash or an enquiry could leak wholesale.
    const raw = await (await h.api('/api/public/site')).text()
    for (const forbidden of ['passwordHash', 'scrypt$', 'tokenVersion', 'assignedTo', 'axis_session', 'SESSION_SECRET']) {
      assert.equal(raw.includes(forbidden), false, `the public bundle carries ${forbidden}`)
    }
  })

  it('refuses a preview to a caller with no session', async () => {
    // `?preview=1` serves drafts. Without a session it must serve the published catalogue instead
    // of refusing — a guest who happens on the parameter sees the site, not an error.
    const bundle = await body<SiteBundle>(await h.api('/api/public/site?preview=1'))
    assert.equal(bundle.preview, false)
    assert.equal(bundle.properties.length, 9)
  })

  it('serves a preview to a signed-in editor, and it is the draft', async () => {
    // The claim that matters is not a flag: an unpublished edit must be visible in the preview and
    // invisible to the public, or the CMS's iframe is showing an editor the site they already had.
    const cookie = await h.signIn()
    const before = await body<SiteBundle>(await h.api('/api/public/site'))
    const target = before.properties[0]
    const doc = await body<{ draft: Record<string, unknown> }>(await h.api(`/api/properties/${target.id}`, { cookie }))
    const edited = `${target.name} — unpublished edit`
    const saved = await h.api(`/api/properties/${target.id}`, {
      method: 'PUT', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: { ...doc.draft, name: edited } }),
    })
    assert.equal(saved.status, 200)

    const preview = await body<SiteBundle>(await h.api('/api/public/site?preview=1', { cookie }))
    assert.equal(preview.preview, true)
    assert.equal(preview.properties.find((p) => p.id === target.id)?.name, edited)

    const live = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(live.preview, false)
    assert.equal(live.properties.find((p) => p.id === target.id)?.name, target.name, 'the public site still shows the published name')

    // Put it back, so the tests that follow read the catalogue as it ships.
    await h.api(`/api/properties/${target.id}`, {
      method: 'PUT', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: doc.draft }),
    })
  })
})

describe('POST /api/public/enquiries', () => {
  const good = { name: 'Aminath Hassan', email: 'aminath@example.test', phone: '+9607771234', month: 'March', party: 'Couple', budget: '$5k–8k' }

  it('takes an enquiry and answers with a reference the guest can quote', async () => {
    const res = await post('/api/public/enquiries', { ...good, email: 'lead1@example.test' })
    assert.equal(res.status, 200)
    const out = await body<{ id: string; ref: string; assignedTo: string }>(res)
    assert.match(out.ref, /^AXJ-[0-9A-Z]{6}$/)
    assert.ok(out.id.startsWith('q'))
    assert.ok(out.assignedTo.length > 0)
  })

  it('persists it — the CMS reads back the same record', async () => {
    // The whole point: a form that answers 200 and stores nothing is the failure this suite exists
    // to catch, and only reading it back from the other plane proves otherwise.
    const created = await body<{ id: string; ref: string }>(await post('/api/public/enquiries', { ...good, email: 'lead2@example.test', message: 'Nine nights in March, overwater.' }))
    const cookie = await h.signIn()
    const list = await body<{ id: string; email: string; message: string; status: string }[]>(await h.api('/api/enquiries', { cookie }))
    const found = list.find((e) => e.id === created.id)
    assert.ok(found, 'the enquiry is in the CMS')
    assert.equal(found.email, 'lead2@example.test')
    assert.equal(found.message, 'Nine nights in March, overwater.')
    assert.equal(found.status, 'new')
  })

  it('assigns the specialist named on the property the guest was reading', async () => {
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const p = bundle.properties.find((x) => x.specialist)!
    const out = await body<{ assignedTo: string }>(await post('/api/public/enquiries', { ...good, email: 'lead3@example.test', propertyId: p.id }))
    assert.equal(out.assignedTo, p.specialist)
  })

  it('reads the specialist from the document, never from the body', async () => {
    // The form is open to the internet: a caller must not be able to route a lead to a name of
    // their choosing, or to invent an assignee that no rota knows.
    const out = await body<{ assignedTo: string }>(await post('/api/public/enquiries', { ...good, email: 'lead4@example.test', assignedTo: 'Attacker', specialist: 'Attacker' }))
    assert.notEqual(out.assignedTo, 'Attacker')
  })

  it('refuses a nameless or address-less enquiry, naming both fields at once', async () => {
    const res = await post('/api/public/enquiries', { name: 'A', email: 'nope' })
    assert.equal(res.status, 422)
    const out = await body<{ error: string; fields: Record<string, string> }>(res)
    assert.deepEqual(Object.keys(out.fields).sort(), ['email', 'name'])
    assert.match(out.fields.name, /name/i)
  })

  it('strips markup and control characters before storing', async () => {
    const created = await body<{ id: string }>(await post('/api/public/enquiries', {
      name: '<script>alert(1)</script>Hostile Guest',
      email: 'lead5@example.test',
      message: '<img src=x onerror=alert(1)>Take me diving',
    }))
    const cookie = await h.signIn()
    const list = await body<{ id: string; name: string; message: string }[]>(await h.api('/api/enquiries', { cookie }))
    const found = list.find((e) => e.id === created.id)!
    assert.equal(found.name.includes('<script>'), false)
    assert.equal(found.message.includes('<img'), false)
    assert.match(found.message, /Take me diving/)
  })

  it('a caller cannot set its own status, notes or created time', async () => {
    const created = await body<{ id: string }>(await post('/api/public/enquiries', {
      ...good, email: 'lead6@example.test', status: 'won', notes: [{ by: 'x', at: 0, text: 'forged' }], createdAt: 0, id: 'q-chosen-by-the-caller',
    }))
    assert.notEqual(created.id, 'q-chosen-by-the-caller')
    const cookie = await h.signIn()
    const list = await body<{ id: string; status: string; notes: unknown[]; createdAt: number }[]>(await h.api('/api/enquiries', { cookie }))
    const found = list.find((e) => e.id === created.id)!
    assert.equal(found.status, 'new')
    assert.deepEqual(found.notes, [])
    assert.ok(found.createdAt > 0)
  })

  it('the honeypot answers like a success and stores nothing', async () => {
    // Telling a bot it was caught is telling it what to change.
    const before = await countEnquiries()
    const res = await post('/api/public/enquiries', { ...good, email: 'bot@example.test', website: 'http://spam.test' })
    assert.equal(res.status, 200)
    const out = await body<{ ref: string }>(res)
    assert.match(out.ref, /^AXJ-[0-9A-Z]{6}$/, 'a plausible reference, so the answer is indistinguishable')
    assert.equal(await countEnquiries(), before)
  })

  it('refuses a body that is not an object, without a stack trace', async () => {
    for (const payload of ['[]', '"a string"', 'null', 'not json at all']) {
      const res = await h.api('/api/public/enquiries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
      assert.equal(res.status, 400, payload)
      const out = await body<{ error: string }>(res)
      assert.equal(/at .*\(.*:\d+:\d+\)|node:internal/.test(out.error), false, 'a stack reached the caller')
    }
  })

  it('refuses an oversized body', async () => {
    const res = await post('/api/public/enquiries', { ...good, email: 'big@example.test', message: 'x'.repeat(300_000) })
    assert.equal(res.status, 400)
  })

  it('answers no-store, so a shared cache never holds somebody’s lead', async () => {
    const res = await post('/api/public/enquiries', { ...good, email: 'lead7@example.test' })
    assert.match(res.headers.get('cache-control') || '', /no-store/)
  })
})

describe('POST /api/public/newsletter', () => {
  it('takes a subscription and refuses an address that is not one', async () => {
    assert.equal((await post('/api/public/newsletter', { email: 'reader@example.test' })).status, 200)
    assert.equal((await post('/api/public/newsletter', { email: 'not-an-address' })).status, 422)
  })

  it('the same address twice is not an error the reader has to understand', async () => {
    await post('/api/public/newsletter', { email: 'twice@example.test' })
    assert.equal((await post('/api/public/newsletter', { email: 'twice@example.test' })).status, 200)
  })
})

async function countEnquiries(): Promise<number> {
  const cookie = await h.signIn()
  const list = await body<unknown[]>(await h.api('/api/enquiries', { cookie }))
  return list.length
}

describe('a publish reaches the pages, not only the API', () => {
  it('the rendered page carries a change the API is already serving', async () => {
    /**
     * The warm-up is the test. This passed on a cold server and failed on a warm one, because the
     * pages and the route handlers are separate server bundles: each got its own copy of the
     * store, its own partition cache and its own bundle memo. Measured on the shipped build before
     * the fix — the API served the change 25 times out of 25, and `/properties/{id}` served the
     * previous page 12 times out of 12, with `no-store` on it, for the life of the process.
     */
    const cookie = await h.signIn()
    for (let i = 0; i < 6; i++) await (await fetch(`${h.base}/properties/baros`)).text()

    const doc = await body<{ draft: { name: string } }>(await h.api('/api/properties/baros', { cookie }))
    const was = doc.draft.name
    const now = `${was} · publish reach ${Date.now()}`
    await h.api('/api/properties/baros', {
      method: 'PUT', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: { ...doc.draft, name: now } }),
    })
    assert.equal((await h.api('/api/properties/baros/publish', { method: 'POST', cookie })).status, 200)

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.find((p) => p.id === 'baros')?.name, now, 'the API did not take the publish')

    const page = await (await fetch(`${h.base}/properties/baros`)).text()
    assert.ok(page.includes(now), 'the API has the change and the rendered page does not')

    // Put the catalogue back the way it ships.
    await h.api('/api/properties/baros', {
      method: 'PUT', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: { ...doc.draft, name: was } }),
    })
    await h.api('/api/properties/baros/publish', { method: 'POST', cookie })
  })
})
