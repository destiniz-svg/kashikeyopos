/**
 * What a crawler and a share card get, over HTTP against the real server.
 *
 * Every one of these is served rather than rendered client-side, which is the only way a search
 * engine or a link preview sees any of it. Fetching the HTML directly is what tells a
 * server-rendered page from one that paints after hydration.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { body, startServer, type Harness } from '../support/server'
import type { SiteBundle } from '@/lib/content/types'

let h: Harness
let bundle: SiteBundle
before(async () => {
  h = await startServer({ APP_STAGE: 'production', SITE_URL: 'https://axisjourneys.com' })
  bundle = await body<SiteBundle>(await h.api('/api/public/site'))
})
after(async () => { await h?.stop() })

const html = async (path: string): Promise<string> => (await fetch(h.base + path)).text()
const meta = (doc: string, attr: string, value: string): string =>
  new RegExp(`<meta[^>]+${attr}="${value}"[^>]+content="([^"]*)"|<meta[^>]+content="([^"]*)"[^>]+${attr}="${value}"`, 'i').exec(doc)?.slice(1).find(Boolean) ?? ''

describe('robots.txt', () => {
  it('allows the site, keeps the CMS and the API out, and names the sitemap', async () => {
    const txt = await (await fetch(h.base + '/robots.txt')).text()
    assert.match(txt, /User-Agent: \*/i)
    assert.match(txt, /Disallow: \/admin/i)
    assert.match(txt, /Disallow: \/api\//i)
    assert.match(txt, /Sitemap: https:\/\/axisjourneys\.com\/sitemap\.xml/i)
  })

  it('a staging origin disallows everything', async () => {
    // An unpublished staging copy of a real business's site outranking the real one is costly and
    // entirely preventable.
    const staging = await startServer({ APP_STAGE: 'staging' })
    try {
      const txt = await (await fetch(staging.base + '/robots.txt')).text()
      assert.match(txt, /Disallow: \/\s*$/m)
      assert.equal(/Allow: \//.test(txt), false)
    } finally {
      await staging.stop()
    }
  })
})

describe('sitemap.xml', () => {
  it('lists exactly what is published, and nothing that is not', async () => {
    const xml = await (await fetch(h.base + '/sitemap.xml')).text()
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

    assert.ok(urls.includes('https://axisjourneys.com/'), 'the home page')
    for (const p of bundle.properties) {
      assert.ok(urls.includes(`https://axisjourneys.com/properties/${p.id}`), `${p.id} is missing`)
    }
    for (const d of bundle.destinations.filter((x) => x.live)) {
      assert.ok(urls.includes(`https://axisjourneys.com/destinations/${d.slug}`), `${d.slug} is missing`)
    }
    // A destination the agency does not sell yet is not a page worth ranking.
    for (const d of bundle.destinations.filter((x) => !x.live)) {
      assert.equal(urls.includes(`https://axisjourneys.com/destinations/${d.slug}`), false, `${d.slug} should not be listed`)
    }
    // And nothing a crawler would be 404'd on: every URL is one the site serves.
    assert.equal(urls.length, 1 + bundle.properties.length + bundle.destinations.filter((d) => d.live).length)
  })

  it('every URL is absolute and on the canonical origin', async () => {
    const xml = await (await fetch(h.base + '/sitemap.xml')).text()
    for (const [, url] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      assert.match(url, /^https:\/\/axisjourneys\.com\//, url)
    }
  })
})

describe('the served HTML', () => {
  // React 19 streams metadata after `</head>` and hoists it on the client, so these assertions look
  // at the whole response rather than at the head — which is also what a crawler reads.
  it('the home page carries its content, one h1, and a canonical', async () => {
    const doc = await html('/')
    assert.ok(doc.includes(bundle.properties[0].name), 'the catalogue is not in the served markup')
    assert.equal((doc.match(/<h1[\s>]/g) || []).length, 1, 'a page has exactly one h1')
    assert.match(doc, /<link rel="canonical" href="https:\/\/axisjourneys\.com\/?"/)
    assert.ok(meta(doc, 'name', 'description').length > 50, 'no description')
    assert.match(doc, /<title>[^<]{10,70}<\/title>/, 'no title, or one no search result would show whole')
  })

  it('a property page describes that property, not the site', async () => {
    const p = bundle.properties[0]
    const doc = await html(`/properties/${p.id}`)
    assert.match(doc, new RegExp(`<title>[^<]*${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))
    assert.match(doc, new RegExp(`<link rel="canonical" href="https://axisjourneys\\.com/properties/${p.id}/?"`))
    assert.equal(meta(doc, 'property', 'og:title').includes(p.name), true)
  })

  it('a share card image is an absolute URL, or a preview shows nothing', async () => {
    for (const path of ['/', `/properties/${bundle.properties[0].id}`]) {
      const image = meta(await html(path), 'property', 'og:image')
      assert.ok(image, `${path} has no og:image`)
      assert.match(image, /^https?:\/\//, `${path}: og:image "${image}" is not absolute`)
    }
  })

  it('the structured data parses and describes the agency', async () => {
    const doc = await html('/')
    const blocks = [...doc.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))
    assert.ok(blocks.length > 0, 'no structured data')
    const agency = blocks.find((b) => b['@type'] === 'TravelAgency')
    assert.ok(agency, 'no TravelAgency block')
    assert.equal(agency.name.includes('Axis'), true)
    assert.match(agency.url, /^https:\/\//)
  })

  it('a property’s structured data quotes no price the catalogue does not publish', async () => {
    // Every `usd` is 0 in this catalogue. A structured-data price of 0 is a claim the business
    // does not make, and a search result quoting it is worse than one quoting nothing.
    const doc = await html(`/properties/${bundle.properties[0].id}`)
    for (const [, block] of doc.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.equal(/"price"\s*:\s*"?0/.test(block), false, 'structured data quotes a price of zero')
    }
  })

  it('the CMS is kept out of the index at the header as well as in robots.txt', async () => {
    const res = await fetch(h.base + '/admin/login')
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/)
  })

  it('the page declares its language and its viewport', async () => {
    const doc = await html('/')
    assert.match(doc, /<html[^>]+lang="en"/)
    assert.match(doc, /<meta name="viewport"[^>]+width=device-width/)
  })
})
