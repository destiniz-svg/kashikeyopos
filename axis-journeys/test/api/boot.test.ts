/**
 * A container that brings its own workspace up.
 *
 * The runtime image carries the standalone server and no source, so there is no seed script inside
 * it to run by hand — which means a container whose store is a fresh disk has no way to get its
 * catalogue at all. `SEED_ON_BOOT` closes that, and the property being tested is the one that
 * matters at three in the morning: an instance must not answer the readiness probe green while its
 * store is still empty.
 *
 * The store here is genuinely empty — the harness is told not to run the seed script — so nothing
 * but the boot hook can put the catalogue there.
 */
import { strict as assert } from 'node:assert'
import { readdir } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { OWNER, body, startServer, type Harness } from '../support/server'
import type { SiteBundle } from '@/lib/content/types'

describe('SEED_ON_BOOT on an empty store', () => {
  let h: Harness
  before(async () => { h = await startServer({ SEED_ON_BOOT: '1' }, { skipSeed: true }) })
  after(async () => { await h?.stop() })

  it('is ready by the time it answers, with the catalogue already in place', async () => {
    // `register()` is awaited before Next serves a request, so a green probe cannot precede the seed.
    const ready = await body<{ ok: boolean; properties: number; faults: string[] }>(await h.api('/api/ready'))
    assert.equal(ready.ok, true, JSON.stringify(ready.faults))
    assert.equal(ready.properties, 9)
  })

  it('serves the real catalogue, not an empty site', async () => {
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.length, 9)
    assert.equal(bundle.offers.length, 25)
    assert.ok(bundle.settings, 'the company settings')
  })

  it('wrote it to the store rather than holding it in memory', async () => {
    // The point of the volume is that the next container finds it there.
    const files = await readdir(h.dir)
    assert.ok(files.some((f) => f.includes('properties')), `the store directory holds: ${files.join(', ')}`)
  })

  it('created the owner, so somebody can actually sign in', async () => {
    const cookie = await h.signIn()
    assert.ok(cookie.startsWith('axis_session='))
    const me = await body<{ user: { email: string; role: string } }>(await h.api('/api/auth/me', { cookie }))
    assert.equal(me.user.email, OWNER.email)
    assert.equal(me.user.role, 'owner')
  })

  it('the drafts are drafts — booting does not publish what a specialist has not finished', async () => {
    const cookie = await h.signIn()
    const docs = await body<{ id: string; status: string }[]>(await h.api('/api/properties', { cookie }))
    assert.equal(docs.length, 32)
    assert.equal(docs.filter((d) => d.status === 'published').length, 9)
  })
})

describe('without SEED_ON_BOOT', () => {
  let h: Harness
  before(async () => { h = await startServer({ SEED_ON_BOOT: '0' }, { skipSeed: true }) })
  after(async () => { await h?.stop() })

  it('an empty workspace stays empty, and the probe says why rather than reporting green', async () => {
    // An install that seeds from a checkout must not have a catalogue written underneath it by a
    // boot hook nobody asked for. And an empty store is a fresh install on its way to being set up,
    // which `/api/ready` names rather than pretending to serve.
    const res = await h.api('/api/ready')
    const ready = await body<{ ok: boolean; properties: number; faults: string[] }>(res)
    assert.equal(ready.properties, 0)
    assert.equal(res.status, 503)
    assert.ok(ready.faults.some((f) => /seed/.test(f)), `the remedy is not named: ${ready.faults.join(' | ')}`)
  })

  it('the public site answers rather than erroring on an empty catalogue', async () => {
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.deepEqual(bundle.properties, [])
  })
})
