/**
 * The editor's journey, driven in Chromium.
 *
 * What only a browser can prove here: the sign-in redirect, the autosave that fires on a keystroke,
 * the completeness bar reading the same `readiness()` the publish endpoint refuses with, and a
 * published edit reaching the public site — each through the shipped screens rather than the API.
 */
import { strict as assert } from 'node:assert'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { OWNER, body, startServer, type Harness } from '../support/server'
import { freshPage, launch, newContext, openPage, overflowsX, type Session } from '../support/browser'
import type { Property, SiteBundle } from '@/lib/content/types'

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
  /**
   * The sidebar is the only way to reach seven of the nine sections, and below 820px it was
   * `display:none` with nothing in its place — so the whole workspace was three dashboard cards and
   * no way back but the browser's own button. Reported from a real phone, and invisible to the
   * responsive test that already existed here, because that one navigates by URL: a drive that never
   * clicks cannot notice that the navigation is gone.
   */
  for (const width of [820, 390, 320]) {
    it(`every section is reachable at ${width}px`, async () => {
      const ctx = await newContext(s, { width, height: 844 }, { hasTouch: true })
      const page = await ctx.newPage()
      await page.goto(h.base + '/admin/login', { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle').catch(() => undefined)
      await page.fill('input[type="email"]', OWNER.email)
      await page.fill('input[type="password"]', OWNER.password)
      await page.click('button[type="submit"]')
      await page.waitForURL(/\/admin(?!\/login)/, { timeout: 20_000 })
      await page.waitForTimeout(900)

      const menu = page.locator('#studio-bar button[aria-expanded]')
      assert.equal(await menu.isVisible(), true, 'there is no way to open the sections')
      const box = await menu.boundingBox()
      assert.ok(box && box.height >= 44, `the menu button is ${box?.height}px tall`)
      assert.equal(await menu.getAttribute('aria-expanded'), 'false')

      await menu.click()
      await page.waitForTimeout(450)
      assert.equal(await menu.getAttribute('aria-expanded'), 'true')

      const reachable = await page.locator('#sidebar button, #sidebar a').allInnerTexts()
      for (const section of ['Dashboard', 'Properties', 'Offers', 'Destinations', 'Homepage', 'Enquiries', 'Media', 'Settings', 'Team']) {
        assert.ok(reachable.some((t) => t.trim().startsWith(section)), `${section} cannot be reached at ${width}px`)
      }
      // And the two that are not sections but are the only way out of the workspace.
      assert.ok(reachable.some((t) => /live site/i.test(t)), 'no link to the live site')
      assert.ok(reachable.some((t) => /^Out$/m.test(t.trim())), 'no way to sign out')

      // Tapping one navigates AND closes the drawer: one left open covers the screen it just opened.
      await page.locator('#sidebar button').filter({ hasText: /^Settings/ }).first().click()
      await page.waitForTimeout(1400)
      assert.match(page.url(), /\/admin\/settings$/)
      const stillOpen = await page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().left > -5)
      assert.equal(stillOpen, false, 'the drawer stayed open over the screen it opened')

      // And the scrim dismisses it without going anywhere. The click has to land on the part of the
      // scrim that is actually uncovered — the drawer sits over its left side, and its centre is
      // behind the drawer, which is where a click would go by default and not where a thumb goes.
      await menu.click()
      await page.waitForTimeout(450)
      const drawer = await page.locator('#sidebar').boundingBox()
      assert.ok(drawer && drawer.width < width - 40, `the drawer leaves only ${width - (drawer?.width ?? 0)}px to tap beside it`)
      await page.mouse.click(width - 20, 300)
      await page.waitForTimeout(450)
      assert.equal(await menu.getAttribute('aria-expanded'), 'false')
      assert.match(page.url(), /\/admin\/settings$/, 'dismissing the drawer navigated somewhere')

      // Escape closes it too, and hands focus back to what opened it.
      await menu.click()
      await page.waitForTimeout(450)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(450)
      assert.equal(await menu.getAttribute('aria-expanded'), 'false')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-controls')), 'sidebar')
      await ctx.close()
    })
  }

  it('the sidebar is simply there above 820px, with no menu button', async () => {
    // The desktop rendering is the prototype's and must not change.
    const ctx = await newContext(s, { width: 1440, height: 900 })
    const page = await ctx.newPage()
    await page.goto(h.base + '/admin/login', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.fill('input[type="email"]', OWNER.email)
    await page.fill('input[type="password"]', OWNER.password)
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/admin(?!\/login)/, { timeout: 20_000 })
    await page.waitForTimeout(900)
    assert.equal(await page.locator('#studio-bar').isVisible(), false, 'the narrow bar is showing on a desktop')
    assert.equal(await page.locator('#sidebar').isVisible(), true)
    assert.equal(await page.locator('#studio-scrim').isVisible(), false)
    await ctx.close()
  })

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

/**
 * Several photographs on one room, through the shipped screens and out to a guest.
 *
 * This is the road nothing else covers: the API tests prove the store and the resolver, and the
 * unit tests prove the standard, but neither can notice a field the editor does not draw or a
 * picker that returns one reference where the field expects a list. The room a guest opens at the
 * end of it is the same document this drive typed into.
 */
describe('a room with more than one photograph', () => {
  /**
   * Real files, and that is not fussiness.
   *
   * The first version of this handed the browser the synthetic JPEG the API tests use — a valid
   * frame header and no image data. Chromium refused every one of them at `createImageBitmap`,
   * which is exactly right and left the library empty, so the drive proved nothing. What runs in a
   * browser has to be something a browser can decode.
   */
  let files: string[] = []
  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axis-e2e-media-'))
    files = [join(dir, 'deck.png'), join(dir, 'bathroom.png'), join(dir, 'small.png')]
    await copyFile('public/assets/logo.png', files[0])
    await copyFile('public/assets/logomark-white.png', files[1])
    // 851 × 1007 — a real file, and under the hero width, so the screen has to say so.
    await copyFile('public/assets/logomark.png', files[2])
  })

  it('uploads through the library and names what is below standard', async () => {
    const { page, faults, dispose } = await signedIn()
    await page.goto(h.base + '/admin/media', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)

    await page.setInputFiles('input[type="file"]', files)
    await page.waitForTimeout(4000)

    const text = await page.locator('body').innerText()
    assert.match(text, /Below standard/i, 'the small file was accepted with nothing said about it')
    assert.match(text, /851 × 1007/, 'the note does not name the size it is complaining about')
    assert.match(text, /full-bleed hero is 1600px wide/i)

    const cookie = await h.signIn()
    const lib = await body<{ id: string; name: string; w: number; h: number }[]>(await h.api('/api/media', { cookie }))
    assert.ok(lib.length >= 3, `only ${lib.length} landed`)
    assert.ok(lib.some((m) => m.w === 851 && m.h === 1007), 'the below-standard file was refused rather than kept')
    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })

  it('the editor puts them on a room, and the guest can open them', async () => {
    const { page, faults, dispose } = await signedIn()
    await page.goto(h.base + '/admin/properties/baros', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    await page.click('button:text-is("Accommodation")')
    await page.waitForTimeout(600)
    assert.match(await page.locator('body').innerText(), /More photos/, 'the room editor has nowhere to put a second photograph')

    // The first room's own control, not whichever one sorts first on the page.
    await page.locator('button:has-text("Add photos")').first().click()
    await page.waitForTimeout(800)
    const picker = page.locator('[role="dialog"][aria-label="Choose an image"]')
    await picker.locator('button[aria-pressed]').nth(0).click()
    await picker.locator('button[aria-pressed]').nth(1).click()
    await page.click('button:has-text("Add 2")')
    await page.waitForTimeout(1600)

    await page.click('button:text-is("Publish changes")')
    await page.waitForTimeout(2500)

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const villa = (bundle.properties.find((p) => p.id === 'baros') as Property).villas[0]
    const more = villa[7] as string[] | undefined
    assert.equal(more?.length, 2, `the room carries ${JSON.stringify(more)}`)
    assert.ok(more!.every((u) => u.startsWith('/api/media/')), 'they did not resolve to servable URLs')
    assert.equal((villa[8] as string[]).length, 2, 'their focal points did not come with them')

    // And a guest opens the room and finds them.
    const guest = await freshPage(s)
    await guest.page.goto(`${h.base}/properties/baros`, { waitUntil: 'domcontentloaded' })
    // The first room opens with the drawer — `setRoomOpen` toggles, so clicking it here would
    // close the panel this test is looking into. Found by doing exactly that.
    await guest.page.waitForSelector('#dr-stays', { timeout: 20_000 })
    await guest.page.waitForTimeout(600)
    const labels: string[] = await guest.page
      .locator('#dr-stays [aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''))
    // Asserted on the labels rather than on a locator that either matches or times out with
    // nothing to say. A test that cannot tell you what it did find is a test you debug twice.
    assert.ok(labels.some((l) => /photo 2 of 3/.test(l)), `the room panel offers: ${JSON.stringify(labels.slice(0, 10))}`)

    const strip = guest.page.locator('#dr-stays button[aria-label*="photo 2 of 3"]')
    await strip.click()
    await guest.page.waitForTimeout(700)
    const lightbox = guest.page.locator('[role="dialog"][aria-modal="true"]')
    assert.equal(await lightbox.isVisible(), true, 'the strip did not open the lightbox')
    assert.match(await lightbox.innerText(), /2 \/ 3/, 'it opened on the wrong photograph')

    // The arrows walk the whole set, including the lead photograph the strip does not repeat.
    await guest.page.keyboard.press('ArrowLeft')
    await guest.page.waitForTimeout(400)
    assert.match(await lightbox.innerText(), /1 \/ 3/)
    await guest.page.keyboard.press('Escape')
    await guest.page.waitForTimeout(400)
    assert.equal(await lightbox.isVisible(), false, 'Escape left the lightbox open')

    assert.deepEqual(guest.faults, [])
    await guest.page.close()
    await guest.dispose()

    // Put the room back as the catalogue ships it.
    const cookie = await h.signIn()
    const doc = await body<{ draft: Property }>(await h.api('/api/properties/baros', { cookie }))
    doc.draft.villas[0] = doc.draft.villas[0].slice(0, 7) as Property['villas'][number]
    await h.api('/api/properties/baros', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: doc.draft }) })
    await h.api('/api/properties/baros/publish', { method: 'POST', cookie })

    assert.deepEqual(faults, [])
    await page.close()
    await dispose()
  })
})
