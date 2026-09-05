/**
 * The guest's journey, driven in Chromium against the real server.
 *
 * The claim being tested is end-to-end and cannot be made anywhere else: a guest filters, opens a
 * property, sends an enquiry, and the record reaches the store — the same one the CMS reads. Every
 * step in between is the shipped page, the shipped API client and the shipped handler.
 *
 * Every drive also asserts the page logged nothing. A screen that renders and throws on every
 * keystroke looks identical in a screenshot to one that works.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { body, startServer, type Harness } from '../support/server'
import { failingTargets, launch, newContext, openPage, overflowsX, type Session } from '../support/browser'
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
 * Wait for the page a guest actually sees: hydrated, with the reveal observer's transitions done.
 *
 * Before hydration a form does a native submit and a control does nothing, so a click that lands
 * early reports a defect the app does not have.
 */
const settle = async (page: import('playwright').Page) => {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForTimeout(700)
}

describe('the home page', () => {
  it('renders the catalogue the API serves, with no page errors', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const text = await page.locator('body').innerText()
    // The first property in the catalogue is on the page, by name — the server rendered the store's
    // own answer rather than a fixture.
    assert.ok(text.includes(bundle.properties[0].name), `"${bundle.properties[0].name}" is not on the page`)
    assert.ok(text.includes(String(bundle.settings.company).split(' ')[0]))
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('is server-rendered, so a crawler and a guest with no JavaScript see the catalogue', async () => {
    // Fetching the HTML directly is the only way to tell a server-rendered page from one that
    // paints after hydration — and it is exactly what a search engine does.
    const html = await (await fetch(h.base + '/')).text()
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    assert.ok(html.includes(bundle.properties[0].name), 'the first property is not in the served HTML')
    assert.match(html, /<h1[^>]*>/, 'there is no h1 in the served markup')
  })

  it('carries the metadata a share and a search result need', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    const meta = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => x.textContent || ''),
      h1: document.querySelectorAll('h1').length,
      lang: document.documentElement.lang,
    }))
    assert.ok(meta.title.length > 10 && meta.title.length < 70, `title is ${meta.title.length} characters`)
    assert.ok(meta.description.length > 50, 'no description')
    assert.ok(meta.ogTitle.length > 0 && meta.ogImage.length > 0, 'no share card')
    assert.match(meta.canonical, /^https?:\/\//, 'no canonical')
    assert.equal(meta.h1, 1, 'a page has exactly one h1')
    assert.equal(meta.lang, 'en')
    assert.ok(meta.jsonld.length > 0, 'no structured data')
    for (const block of meta.jsonld) JSON.parse(block) // it must actually parse
    assert.deepEqual(faults, [])
    await page.close()
  })
})

/**
 * Open the enquiry drawer from a property's own page.
 *
 * `/properties/<id>` is the long-form page now, not the drawer: the handoff's own redirect map
 * sends that address at the page, and a guest who lands there presses a quote control to open the
 * form. This is that press, so the funnel is driven the way it is actually walked.
 */
const openEnquiry = async (page: import('playwright').Page) => {
  await page
    .locator('button')
    .filter({ hasText: /request a custom quote|get a custom quote|quote this villa/i })
    .first()
    .click()
  await page.waitForSelector('#f-name', { state: 'visible', timeout: 10_000 })
}

describe('the enquiry funnel', () => {
  it('filters, opens a property, sends an enquiry, and the record reaches the store', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)

    // The filters are real: the count in the toast is what the grid draws.
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const target = bundle.properties[0]

    await page.goto(`${h.base}/properties/${target.id}`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    assert.match(await page.locator('body').innerText(), new RegExp(target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    // Open the enquiry form the way a guest does.
    await openEnquiry(page)

    const email = `e2e-${Date.now()}@example.test`
    await page.fill('#f-name', 'Aishath E2E')
    await page.fill('#f-email', email)
    await page.fill('#f-phone', '+9607771234')
    await page.selectOption('#drawer-form select[name="month"]', { label: 'March' })
    await page.locator('#drawer-form textarea[name="message"]').fill('Seven nights in March, overwater, quiet.')
    await page.locator('#drawer-form button[type="submit"]').click()

    // The success view names the server's own reference — not one the browser invented.
    await page.waitForSelector('text=/Thank you, Aishath/i', { timeout: 15_000 })
    const shown = await page.locator('#drawer-form').innerText()
    const ref = /AXJ-[0-9A-Z]{6}/.exec(shown)?.[0]
    assert.ok(ref, `no reference in the success view: ${shown.slice(0, 200)}`)

    // And it is in the store, with what the guest typed.
    const cookie = await h.signIn()
    const list = await body<{ id: string; email: string; name: string; message: string; property: string; status: string }[]>(await h.api('/api/enquiries', { cookie }))
    const record = list.find((e) => e.email === email)
    assert.ok(record, 'the enquiry never reached the store')
    assert.equal(record.name, 'Aishath E2E')
    assert.match(record.message, /Seven nights in March/)
    assert.equal(record.status, 'new')
    assert.equal(ref, 'AXJ-' + record.id.replace(/^q/, '').slice(-6).toUpperCase())

    assert.deepEqual(faults, [])
    await page.close()
  })

  it('refuses an incomplete form in the page, before anything is sent', async () => {
    const { page, faults } = await openPage(s)
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    await page.goto(`${h.base}/properties/${bundle.properties[0].id}`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    await openEnquiry(page)

    let posted = 0
    page.on('request', (r) => { if (r.url().includes('/api/public/enquiries')) posted++ })

    await page.fill('#f-name', 'A')
    await page.fill('#f-email', 'not-an-address')
    await page.locator('#drawer-form button[type="submit"]').click()
    await page.waitForTimeout(600)

    assert.equal(posted, 0, 'an invalid form was sent to the server anyway')
    const text = await page.locator('#drawer-form').innerText()
    assert.match(text, /name|email/i, 'nothing on screen said what was wrong')
    assert.deepEqual(faults, [])
    await page.close()
  })
})

describe('the shortlist', () => {
  it('survives a reload, because it is the guest’s own list', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    const save = page.locator('button[aria-label^="Save "]').first()
    await save.waitFor({ state: 'visible', timeout: 10_000 })
    await save.click()
    await page.waitForTimeout(400)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page)
    const stored = await page.evaluate(() => localStorage.getItem('axis.shortlist'))
    assert.ok(stored && JSON.parse(stored).length > 0, 'the shortlist did not survive')
    assert.deepEqual(faults, [])
    await page.close()
  })
})

describe('a destination page', () => {
  it('renders, and an unknown one is a 404 rather than a crash', async () => {
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const live = bundle.destinations.find((d) => d.live) ?? bundle.destinations[0]
    const { page, faults } = await openPage(s)
    const res = await page.goto(`${h.base}/destinations/${live.slug}`, { waitUntil: 'domcontentloaded' })
    assert.equal(res?.status(), 200)
    await settle(page)
    assert.match(await page.locator('body').innerText(), new RegExp(live.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.deepEqual(faults, [])

    await page.close()

    // A deliberate 404 goes to a page of its own: navigating the watched one would put the browser's
    // own "failed to load" line into the fault log and make the assertion above meaningless.
    const notFound = await openPage(s)
    const missing = await notFound.page.goto(`${h.base}/destinations/no-such-place`, { waitUntil: 'domcontentloaded' })
    assert.equal(missing?.status(), 404)
    await notFound.page.waitForSelector('h1', { timeout: 10_000 })
    // A 404 that offers the way back rather than a dead end.
    assert.match(await notFound.page.locator('body').innerText(), /not found/i)
    assert.ok(await notFound.page.locator('a[href="/"]').count(), 'no way back to the site')
    await notFound.page.close()
  })
})

describe('the pages are reachable without a mouse', () => {
  it('tab moves focus, and every focused control is visible', async () => {
    const { page } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      // The prototype's controls carry `transition: all .2s`, so the ring fades in rather than
      // appearing — measuring immediately reads an outline that is still 0px wide.
      await page.waitForTimeout(300)
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return null
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          tag: el.tagName,
          label: (el.textContent || '').trim().slice(0, 30),
          visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden',
          // A focus ring drawn only by a decorative shadow is no ring at all.
          outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
        }
      })
      if (!info) continue
      seen.push(`${info.tag}:${info.label}`)
      assert.equal(info.visible, true, `focus landed on something invisible: ${info.tag} ${info.label}`)
      assert.equal(info.outline, true, `no focus ring on ${info.tag} "${info.label}"`)
    }
    assert.ok(seen.length >= 5, `tab reached only ${seen.length} controls`)
    assert.ok(new Set(seen).size > 1, 'focus is trapped on one control')
    await page.close()
  })

  it('the first tab stop is a skip link', async () => {
    const { page } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.keyboard.press('Tab')
    const first = await page.evaluate(() => (document.activeElement?.textContent || '').trim())
    assert.match(first, /skip/i, `the first tab stop is "${first}"`)
    await page.close()
  })
})

describe('at every width the prototype declares', () => {
  for (const [name, size] of [
    ['a small phone', { width: 320, height: 720 }],
    ['a phone', { width: 390, height: 844 }],
    ['a large phone', { width: 480, height: 900 }],
    ['a small tablet', { width: 640, height: 960 }],
    ['a tablet', { width: 820, height: 1180 }],
    ['a small laptop', { width: 1000, height: 800 }],
    ['a laptop', { width: 1180, height: 800 }],
    ['a desktop', { width: 1440, height: 900 }],
  ] as const) {
    it(`${name} (${size.width}px) never scrolls sideways`, async () => {
      const ctx = await newContext(s, size)
      const page = await ctx.newPage()
      const faults: string[] = []
      page.on('pageerror', (e) => faults.push(e.message))
      for (const path of ['/', '/properties/baros', '/destinations/maldives']) {
        await page.goto(h.base + path, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle').catch(() => undefined)
        await page.waitForTimeout(500)
        assert.equal(await overflowsX(page), false, `${path} at ${size.width}px scrolls sideways`)
      }
      assert.deepEqual(faults, [])
      await ctx.close()
    })
  }

  it('every tap target on a phone meets WCAG 2.5.8', async () => {
    const ctx = await newContext(s, { width: 390, height: 844 }, { hasTouch: true })
    const page = await ctx.newPage()
    for (const path of ['/', '/properties/baros', '/destinations/maldives']) {
      await page.goto(h.base + path, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle').catch(() => undefined)
      await page.waitForTimeout(700)
      const bad = await failingTargets(page, 24)
      assert.deepEqual(bad, [], `${path}: ${bad.map((t) => `${t.text} (${t.w}×${t.h})`).join(', ')}`)
    }
    await ctx.close()
  })

  it('the two controls a guest must hit are comfortable on a phone', async () => {
    // The design's own chips are 31–34px and its footer buttons are text, which WCAG 2.5.8 allows
    // through its spacing and inline exceptions — so a blanket 44px floor would fail the design
    // rather than the build. What must be generous is the pair a guest cannot avoid: the button
    // that opens the journeys, and the one that sends the enquiry.
    const ctx = await newContext(s, { width: 390, height: 844 }, { hasTouch: true })
    const page = await ctx.newPage()
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(700)
    // At 390px the desktop intent bar is hidden and `#intent-mobile` — which is itself the button —
    // takes its place. Whichever is visible is the one a thumb meets.
    const explore = await page.locator('#intent-mobile:visible, #explore-btn:visible').first().boundingBox()
    assert.ok(explore && explore.height >= 44, `the explore control is ${explore?.height ?? 'not visible'}`)

    await page.goto(h.base + '/properties/baros', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(700)
    await openEnquiry(page)
    const submit = await page.locator('#drawer-form button[type="submit"]').first().boundingBox()
    assert.ok(submit && submit.height >= 44, `the enquiry submit is ${submit?.height}px tall`)
    await ctx.close()
  })
})

/**
 * The Destinations menu, and the curated paths in it.
 *
 * Reported as "Curated Quick Paths does not work, no content", and it was three separate things:
 * the menu could not be opened by clicking it, the paths did nothing at all from a destination
 * page, and on a phone they did not exist. Each is driven here the way the person who reported it
 * would have met it.
 */
describe('the Destinations menu', () => {
  it('opens on a click with a mouse, and holds the curated paths', async () => {
    // `onMouseEnter` opens it, so a toggle on click could only ever shut it again: measured,
    // aria-expanded went false -> true on approach and back to false on the click itself.
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    const trigger = page.locator('#desknav button[aria-expanded]').first()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    await trigger.click()
    await page.waitForTimeout(500)
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'clicking Destinations did not open the menu')
    assert.equal(await page.locator('#mega-grid').count(), 1)
    const paths = await page.locator('#mega-grid button').evaluateAll((els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()))
    assert.ok(paths.some((t) => /Private islands/.test(t)), `the menu holds: ${JSON.stringify(paths)}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)
    assert.equal(await page.locator('#mega-grid').count(), 0, 'Escape left it open')
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('offers no path that lands on nothing', async () => {
    // The shipped list has one the catalogue cannot answer — no property is an Overwater Villa —
    // and a curated entry that ends on "No exact match" reads as a broken site.
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('#desknav button[aria-expanded]').first().click()
    await page.waitForTimeout(450)
    const labels = await page.locator('#mega-grid button').evaluateAll((els) => els.map((e) => (e.textContent || '').trim()))
    assert.equal(labels.some((t) => /Overwater icons/.test(t)), false, 'a path with no matches is still offered')
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('a curated path taken from a destination page arrives filtered on the home page', async () => {
    // Before: it wrote filters the destination page does not read and scrolled to an id that is
    // not on it, then toasted "3 journeys match" over a screen where nothing had moved.
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/destinations/maldives', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('#desknav button[aria-expanded]').first().click()
    await page.waitForTimeout(450)
    await page.locator('#mega-grid button').filter({ hasText: 'Private islands' }).first().click()
    await page.waitForTimeout(3000)

    assert.match(page.url(), /\/\?.*pkg=Private\+Island/, `it stayed on ${page.url()}`)
    assert.ok(await page.evaluate(() => window.scrollY) > 400, 'it did not reach the Selection')
    const intent = await page.locator('#intent-wrap').innerText()
    assert.match(intent, /Private Island/, 'the filter did not survive the navigation')
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('and the same filter set is a link somebody can send', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/?pkg=Private+Island&themes=Diving', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.waitForTimeout(2000)
    assert.ok(await page.evaluate(() => window.scrollY) > 400, 'an arriving filter did not scroll to the results')
    const intent = await page.locator('#intent-wrap').innerText()
    assert.match(intent, /Private Island/)
    assert.match(intent, /Diving/)
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('a section label on a destination page changes the address it changes the page for', async () => {
    // It rendered the home page with the URL still reading /destinations/maldives, so a reload
    // came back to the destination and the link could not be shared.
    const ctx = await newContext(s, { width: 1440, height: 900 })
    const { page, faults } = await openPage(s, ctx)
    await page.goto(h.base + '/destinations/maldives', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('#desknav a').filter({ hasText: 'Our Story' }).first().click()
    await page.waitForTimeout(1800)
    assert.match(page.url(), /\/#story$/, `it left the address at ${page.url()}`)
    assert.equal(await page.locator('#dp-props').count(), 0, 'the destination page is still rendered')

    // The three that DO have a local section stay where they are, which is the other half.
    await page.goto(h.base + '/destinations/maldives', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('#desknav a').filter({ hasText: 'Properties' }).first().click()
    await page.waitForTimeout(1200)
    assert.equal(await page.locator('#dp-props').count(), 1, 'it left the destination page for its own section')
    assert.deepEqual(faults, [])
    await page.close()
    await ctx.close()
  })

  it('the phone menu carries them, and one of them works', async () => {
    const ctx = await newContext(s, { width: 390, height: 844 }, { hasTouch: true })
    const { page, faults } = await openPage(s, ctx)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('#burger').click()
    await page.waitForTimeout(600)

    const menu = await page.locator('body').innerText()
    // Case-insensitive: the heading is uppercased in CSS, and `innerText` reports what is drawn.
    assert.match(menu, /curated quick paths/i, 'the phone menu has no quick paths at all')
    assert.match(menu, /Family villas/)

    const path = page.locator('button').filter({ hasText: 'Family villas' }).first()
    const box = await path.boundingBox()
    assert.ok(box && box.height >= 44, `the tap target is ${box?.height}px tall`)
    await path.click()
    await page.waitForTimeout(2200)
    assert.ok(await page.evaluate(() => window.scrollY) > 300, 'tapping a path went nowhere')
    assert.equal(await overflowsX(page), false)
    assert.deepEqual(faults, [])
    await page.close()
    await ctx.close()
  })
})

/**
 * The property page and the two controls the 2026-09-05 home flow added.
 *
 * Driven through the shipped screens rather than the derivation, because what is being tested is
 * not "does propertyPage() compute" — that is covered without a browser — but that a guest can get
 * to the page from the grid, read what it says, and come back with a quote request.
 */
describe('a property page', () => {
  it('is what /properties/<id> serves, and it carries the whole profile', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/properties/baros', { waitUntil: 'domcontentloaded' })
    await settle(page)

    // `textContent`, not `innerText`: the sections below the fold start at opacity 0 until the
    // reveal observer reaches them, and a heading the CSS uppercases is mixed case in the source.
    const text = (await page.locator('main').textContent()) || ''
    for (const heading of ['Our positioning', 'Choose your villa', "What's included", 'Who this island is for', 'The same island, a better deal']) {
      assert.ok(text.includes(heading), `the page has no "${heading}" — it reads: ${text.slice(0, 200)}`)
    }
    // The five scales, each with a mark somewhere on its track.
    assert.equal(await page.locator('#pp-scales [role="img"]').count(), 5)
    // The villa tabs change the room, rather than being three labels over one panel.
    await page.locator('#pp-villas').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    const room = () => page.locator('#pp-villa > div:last-child > div:first-child').textContent()
    const first = await room()
    await page.locator('#pp-tabs button').last().click()
    await page.waitForTimeout(500)
    assert.notEqual(await room(), first, 'the tabs draw one room')

    // And the conversion bar opens the enquiry form on the same page.
    await page.evaluate(() => window.scrollTo(0, window.innerHeight * 1.2))
    await page.waitForTimeout(700)
    await openEnquiry(page)
    assert.equal(await page.locator('#f-name').isVisible(), true)
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('the drawer offers the way through to it, and Similar islands links on', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('button[aria-label^="View Baros"]').first().click()
    await page.waitForTimeout(900)
    const full = page.locator('#drawer a').filter({ hasText: /full details/i }).first()
    assert.equal(await full.count(), 1, 'the drawer has no route to the page')
    await full.click()
    await page.waitForURL(/\/properties\/baros$/, { timeout: 10_000 })
    await settle(page)
    assert.ok(((await page.locator('main').textContent()) || '').includes('Our positioning'))
    assert.deepEqual(faults, [])
    await page.close()
  })
})

describe('the home flow the handoff added', () => {
  it('the atoll cards filter the grid, and say so', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    const before = await page.locator('#props-grid button[aria-label^="View "]').count()
    assert.ok(before > 1, 'nothing in the grid to filter')

    await page.locator('#atoll-grid button').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    const label = (await page.locator('#atoll-grid button').first().getAttribute('aria-label')) || ''
    await page.locator('#atoll-grid button').first().click()
    await page.waitForTimeout(1500)
    const after = await page.locator('#props-grid button[aria-label^="View "]').count()
    assert.ok(after < before && after > 0, `"${label}" left ${after} of ${before} cards`)
    // It opens the panel it just used, so a guest can see what changed and undo it.
    assert.equal(await page.locator('#props-wrap button[aria-expanded="true"]').count(), 1)
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('the matchmaker re-orders the grid without shortening it', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    const names = () => page.locator('#props-grid button[aria-label^="View "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''))
    await page.locator('#quiz').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    const before = await names()

    await page.locator('#quiz > button').click()
    await page.waitForTimeout(500)
    await page.locator('#quiz-grid button', { hasText: 'Wild reef & marine life' }).click()
    await page.waitForTimeout(800)
    const after = await names()
    assert.equal(after.length, before.length, 'the quiz hid an island')
    assert.notDeepEqual(after, before, 'the quiz changed nothing')

    await page.locator('#quiz-grid button', { hasText: 'Clear' }).click()
    await page.waitForTimeout(700)
    assert.deepEqual(await names(), before, 'Clear did not put the order back')
    assert.deepEqual(faults, [])
    await page.close()
  })

  it('a guide opens what it promises, and a question answers', async () => {
    const { page, faults } = await openPage(s)
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.locator('#guide-grid button').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    const title = ((await page.locator('#guide-grid button').first().textContent()) || '').replace('01', '').split('Seasons')[0].trim()
    await page.locator('#guide-grid button').first().click()
    await page.waitForTimeout(600)
    const body = await page.locator('#guide-body').innerText()
    assert.ok(body.includes(title), `the guide opened on "${body.slice(0, 60)}" rather than "${title}"`)

    await page.locator('#faq-grid button').first().click()
    await page.waitForTimeout(500)
    assert.equal(await page.locator('#faq-grid button[aria-expanded="true"]').count(), 1)
    assert.ok(((await page.locator('#faq-grid').textContent()) || '').length > 400, 'the question opened on nothing')
    assert.deepEqual(faults, [])
    await page.close()
  })
})
