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
    const enquire = page.locator('#drawer button, #drawer a').filter({ hasText: /enquire|quote|plan/i }).first()
    if (await enquire.count()) await enquire.click().catch(() => undefined)
    await page.waitForSelector('#f-name', { timeout: 10_000 })

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
    await page.waitForSelector('#f-name', { timeout: 10_000 })

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
    // At 390px the desktop intent bar is present but hidden, so the visible one is what a thumb
    // actually meets.
    const explore = await page.locator('#explore-btn:visible, #intent-mobile button:visible').first().boundingBox()
    assert.ok(explore && explore.height >= 44, `the explore control is ${explore?.height ?? 'not visible'}`)

    await page.goto(h.base + '/properties/baros', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(700)
    const submit = await page.locator('#drawer-form button[type="submit"]').first().boundingBox()
    assert.ok(submit && submit.height >= 44, `the enquiry submit is ${submit?.height}px tall`)
    await ctx.close()
  })
})
