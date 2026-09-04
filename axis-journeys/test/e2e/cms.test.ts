/**
 * The editor's journey, driven in Chromium.
 *
 * What only a browser can prove here: the sign-in redirect, the autosave that fires on a keystroke,
 * the completeness bar reading the same `readiness()` the publish endpoint refuses with, and a
 * published edit reaching the public site — each through the shipped screens rather than the API.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { OWNER, body, startServer, type Harness } from '../support/server'
import { freshPage, launch, newContext, openPage, overflowsX, type Session } from '../support/browser'
import type { SiteBundle } from '@/lib/content/types'

let h: Harness
let s: Session
before(async () => {
  h = await startServer()
  s = await launch('desktop')
})
after(async () => {
  await s?.close()
  await h?.stop()
})

/**
 * Wait until React has attached.
 *
 * Before hydration a click on the form does a native submit, the page reloads, and the screen looks
 * exactly like one that refused silently — which is a test that reports a defect the app does not
 * have. `networkidle` is the signal that the client bundle has arrived and run.
 */
async function hydrated(page: import('playwright').Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForTimeout(300)
}

async function signedIn() {
  const { page, faults, dispose } = await freshPage(s)
  await page.goto(h.base + '/admin/login', { waitUntil: 'domcontentloaded' })
  await hydrated(page)
  await page.fill('input[type="email"]', OWNER.email)
  await page.fill('input[type="password"]', OWNER.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(/\/admin(?!\/login)/, { timeout: 20_000 })
  await page.waitForTimeout(800)
  return { page, faults, dispose }
}

describe('signing in to the CMS', () => {
  it('an unauthenticated visit lands on the sign-in screen, not on the workspace', async () => {
    const { page, dispose } = await freshPage(s)
    await page.goto(h.base + '/admin', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const text = await page.locator('body').innerText()
    assert.match(text, /sign in/i)
    // Nothing from the workspace may render behind the gate.
    assert.equal(/enquir(y|ies)|Baros Maldives/i.test(text), false, 'workspace content rendered before sign-in')
    await page.close()
    await dispose()
  })

  it('a wrong password says so and does not sign anybody in', async () => {
    const { page, dispose } = await freshPage(s)
    await page.goto(h.base + '/admin/login', { waitUntil: 'domcontentloaded' })
    await hydrated(page)
    await page.fill('input[type="email"]', OWNER.email)
    await page.fill('input[type="password"]', 'not-the-password')
    await page.click('button[type="submit"]')
    await page.waitForTimeout(1500)
    assert.match(await page.locator('body').innerText(), /incorrect|wrong|try again/i)
    assert.match(page.url(), /\/admin\/login/)
    await page.close()
    await dispose()
  })

  it('the right password lands on a dashboard counted from real data', async () => {
    const { page, faults, dispose } = await signedIn()
    const text = await page.locator('body').innerText()
    // 32 properties, 25 offers — the catalogue's own numbers, not a placeholder.
    assert.match(text, /\b32\b/, 'the property count is not on the dashboard')
    assert.match(text, /\b25\b/, 'the offer count is not on the dashboard')
    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })
})

describe('the editor', () => {
  it('lists every property, and autosaves an edit without a save button', async () => {
    const { page, faults, dispose } = await signedIn()
    await page.goto(h.base + '/admin/properties', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await page.click('text=Baros Maldives')
    await page.waitForTimeout(1200)

    const field = page.locator('input').filter({ hasNot: page.locator('[type="file"]') }).first()
    const before = await field.inputValue()
    const edited = `${before} (edited)`
    await field.fill(edited)
    // The autosave debounce is 500ms; this waits well past it and then asks the server.
    await page.waitForTimeout(2500)

    const cookie = await h.signIn()
    const doc = await body<{ draft: { name: string }; status: string }>(await h.api('/api/properties/baros', { cookie }))
    assert.equal(doc.draft.name, edited, 'the keystroke never reached the store')
    assert.equal(doc.status, 'changed', 'the published copy should be untouched')

    // Discard, through the screen, and confirm the store agrees.
    await page.click('button:has-text("Discard")')
    await page.waitForTimeout(1500)
    const back = await body<{ draft: { name: string }; status: string }>(await h.api('/api/properties/baros', { cookie }))
    assert.equal(back.draft.name, before)
    assert.equal(back.status, 'published')
    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })

  it('the completeness bar says what is missing, and Publish is refused until it is not', async () => {
    // The bar and the endpoint read the same function, so what the bar says is what the server does.
    const cookie = await h.signIn()
    await h.api('/api/properties', {
      method: 'POST', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-unfinished', draft: { name: 'Unfinished Island', dest: 'Maldives' } }),
    })

    const { page, faults, dispose } = await signedIn()
    await page.goto(h.base + '/admin/properties/e2e-unfinished', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const text = await page.locator('body').innerText()
    assert.match(text, /Not live yet/i)
    for (const want of ['hero photo', 'day-by-day itinerary', 'transfer options']) {
      assert.ok(text.includes(want), `the bar does not name "${want}"`)
    }
    const publish = page.locator('button:text-is("Publish")').first()
    assert.equal(await publish.isDisabled(), true, 'Publish was offered on an unfinished property')

    // And the endpoint refuses it too, so the screen is not the only thing holding the line.
    const res = await h.api('/api/properties/e2e-unfinished/publish', { method: 'POST', cookie, headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 422)
    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })

  it('publishing through the screen puts the change on the public site', async () => {
    const { page, faults, dispose } = await signedIn()
    await page.goto(h.base + '/admin/properties/baros', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const field = page.locator('input').filter({ hasNot: page.locator('[type="file"]') }).first()
    const before = await field.inputValue()
    const published = `${before} · published in a test`
    await field.fill(published)
    await page.waitForTimeout(1200)
    await page.click('button:text-is("Publish changes")')
    await page.waitForTimeout(2500)

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.equal(bundle.properties.find((p) => p.id === 'baros')?.name, published, 'the publish did not reach the public bundle')

    // And a guest actually sees it.
    const guest = await freshPage(s)
    await guest.page.goto(`${h.base}/properties/baros`, { waitUntil: 'domcontentloaded' })
    await guest.page.waitForTimeout(800)
    assert.match(await guest.page.locator('body').innerText(), /published in a test/)
    await guest.page.close()
    await guest.dispose()

    // Put it back and publish again, so the catalogue ends as it ships.
    await field.fill(before)
    await page.waitForTimeout(1200)
    await page.click('button:text-is("Publish changes")')
    await page.waitForTimeout(2000)
    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })
})

describe('the CRM', () => {
  it('shows an enquiry the site took, and moves it along', async () => {
    const email = `cms-e2e-${Date.now()}@example.test`
    await h.api('/api/public/enquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mariyam CRM', email, month: 'August', message: 'A test enquiry.' }),
    })

    const { page, faults, dispose } = await signedIn()
    await page.goto(h.base + '/admin/enquiries', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    assert.match(await page.locator('body').innerText(), /Mariyam CRM/)

    await page.click('text=Mariyam CRM')
    await page.waitForTimeout(800)
    await page.locator('#enq-detail button:has-text("contacted")').first().click()
    await page.waitForTimeout(1500)

    const cookie = await h.signIn()
    const list = await body<{ email: string; status: string }[]>(await h.api('/api/enquiries', { cookie }))
    assert.equal(list.find((e) => e.email === email)?.status, 'contacted', 'the status change did not persist')
    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })
})

describe('the CMS on a phone', () => {
  it('does not scroll sideways on any of its screens', async () => {
    const ctx = await newContext(s, { width: 390, height: 844 })
    const page = await ctx.newPage()
    await page.goto(h.base + '/admin/login', { waitUntil: 'domcontentloaded' })
    await hydrated(page)
    await page.fill('input[type="email"]', OWNER.email)
    await page.fill('input[type="password"]', OWNER.password)
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/admin(?!\/login)/, { timeout: 20_000 })
    for (const path of ['/admin', '/admin/properties', '/admin/properties/baros', '/admin/enquiries', '/admin/media', '/admin/settings']) {
      await page.goto(h.base + path, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(700)
      assert.equal(await overflowsX(page), false, `${path} scrolls sideways at 390px`)
    }
    await ctx.close()
  })
})
