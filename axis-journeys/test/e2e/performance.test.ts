/**
 * What the page actually costs, measured against the built server in a real browser.
 *
 * These are budgets rather than benchmarks. A number from one run on one machine proves nothing
 * about a guest's phone in Malé, so what is asserted is the shape a slow connection cannot recover
 * from: how much JavaScript has to arrive before anything is interactive, how many round trips the
 * critical path takes, whether the layout moves after it paints, and whether the largest thing on
 * the screen is the hero rather than something below the fold.
 *
 * The catalogue's photography is unreachable from this environment, so image WEIGHT is not measured
 * — that is stated in `docs/DECISIONS.md` rather than implied to be covered.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { startServer, type Harness } from '../support/server'
import { launch, newContext, type Session } from '../support/browser'

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

interface Weight { js: number; css: number; fonts: number; html: number; requests: number }

/**
 * What crossed the wire, from the browser's own Resource Timing.
 *
 * `encodedBodySize` is the compressed size — what a guest's connection actually pays for. Reading a
 * response body instead measures the DECOMPRESSED bytes, which on this build reads 735 KB against
 * the 207 KB that is really sent, and would set a budget against a number nobody experiences.
 */
async function weigh(path: string, viewport = { width: 1440, height: 900 }): Promise<Weight> {
  const ctx = await newContext(s, viewport)
  const page = await ctx.newPage()
  await page.goto(h.base + path, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForTimeout(500)
  const w = await page.evaluate(() => {
    const out = { js: 0, css: 0, fonts: 0, html: 0, requests: 0 }
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceResourceTiming | undefined
    out.html = nav?.encodedBodySize ?? 0
    for (const r of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      if (new URL(r.name, location.href).origin !== location.origin) continue
      out.requests++
      const size = r.encodedBodySize || 0
      // Classified by what the file IS. `initiatorType` says 'link' for a stylesheet and equally
      // for every `<link rel="preload">` — which counted the preloaded scripts and fonts as CSS and
      // read 170 KB against the 4.5 KB of stylesheet actually served.
      const path = new URL(r.name, location.href).pathname
      if (/\.m?js$/.test(path)) out.js += size
      else if (/\.css$/.test(path)) out.css += size
      else if (/\.(woff2?|ttf|otf)$/.test(path)) out.fonts += size
    }
    return out
  })
  await ctx.close()
  return w
}

describe('what has to arrive before the page works', () => {
  it('the home page sends around 210 KB of JavaScript, and the budget is 280', async () => {
    // Measured: 207 KB compressed across the whole client bundle. The budget has headroom for the
    // catalogue growing and none for a dependency arriving — which is the thing worth noticing,
    // since four runtime packages is what keeps the figure here at all.
    const w = await weigh('/')
    const kb = Math.round(w.js / 1024)
    assert.ok(kb < 280, `${kb} KB of JavaScript reaches the browser on the home page`)
  })

  it('the server-rendered HTML stays under 100 KB compressed', async () => {
    // The whole published catalogue is in the first response, which is what makes the page work
    // without JavaScript and what a crawler reads. It is also what would grow silently.
    const kb = Math.round((await weigh('/')).html / 1024)
    assert.ok(kb > 0 && kb < 100, `the home page's HTML is ${kb} KB compressed`)
  })

  it('a property page costs no more than the home page', async () => {
    // Every route shares one bundle; a property page that costs materially more means something
    // route-specific has been pulled into the client.
    const home = await weigh('/')
    const property = await weigh('/properties/baros')
    assert.ok(property.js <= home.js * 1.25, `the property page ships ${Math.round(property.js / 1024)} KB against the home page's ${Math.round(home.js / 1024)} KB`)
  })

  it('the stylesheet is small, because almost all of the design is inline', async () => {
    // Measured: 4.5 KB compressed. The prototype's measurements travel as style attributes in the
    // markup, so the stylesheet carries only the tokens, the resets and the media queries.
    const kb = (await weigh('/')).css / 1024
    assert.ok(kb > 0 && kb < 20, `${kb.toFixed(1)} KB of CSS`)
  })

  it('the fonts are subset and self-hosted, not a webfont download', async () => {
    // Two families at the weights the design uses. `next/font` subsets them, which is what keeps
    // this under a hundred kilobytes and lets the CSP forbid a font CDN outright.
    const kb = (await weigh('/')).fonts / 1024
    assert.ok(kb < 200, `${kb.toFixed(0)} KB of fonts`)
  })

  it('the fonts are served from this origin, so no third party is on the critical path', async () => {
    // `next/font` self-hosts them, which is also what lets the CSP forbid a font CDN outright.
    const ctx = await newContext(s, { width: 1440, height: 900 })
    const page = await ctx.newPage()
    const offSite: string[] = []
    page.on('request', (r) => {
      if (r.resourceType() === 'font' && !r.url().startsWith(h.base)) offSite.push(r.url())
    })
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    assert.deepEqual(offSite, [], `fonts fetched from elsewhere: ${offSite.join(', ')}`)
    await ctx.close()
  })

  it('nothing third-party is render-blocking', async () => {
    const ctx = await newContext(s, { width: 1440, height: 900 })
    const page = await ctx.newPage()
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    const blocking = await page.evaluate(() =>
      [...document.querySelectorAll('script[src]:not([async]):not([defer]), link[rel="stylesheet"]')]
        .map((el) => (el as HTMLScriptElement).src || (el as HTMLLinkElement).href)
        .filter((u) => new URL(u, location.href).origin !== location.origin),
    )
    assert.deepEqual(blocking, [], `render-blocking third parties: ${blocking.join(', ')}`)
    await ctx.close()
  })
})

describe('how it behaves once it is there', () => {
  it('the layout does not move after it paints', async () => {
    // Cumulative Layout Shift is the one Core Web Vital a test on one machine can measure honestly:
    // it is about the document, not about the network. Google's "good" threshold is 0.1.
    const ctx = await newContext(s, { width: 390, height: 844 })
    const page = await ctx.newPage()
    await page.addInitScript(() => {
      ;(window as unknown as { __cls: number }).__cls = 0
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value
        }
      }).observe({ type: 'layout-shift', buffered: true })
    })
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(1500)
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls)
    assert.ok(cls < 0.1, `cumulative layout shift is ${cls.toFixed(3)}`)
    await ctx.close()
  })

  it('the largest thing painted is the hero, not something further down', async () => {
    const ctx = await newContext(s, { width: 1440, height: 900 })
    const page = await ctx.newPage()
    await page.addInitScript(() => {
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1) as unknown as { element?: Element; startTime: number }
        ;(window as unknown as { __lcp: unknown }).__lcp = { top: last?.element?.getBoundingClientRect().top ?? null, at: last?.startTime ?? null }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    })
    await page.goto(h.base + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(1200)
    const lcp = await page.evaluate(() => (window as unknown as { __lcp?: { top: number | null } }).__lcp)
    // An LCP element below the fold means the browser is waiting on something the guest cannot see.
    if (lcp?.top != null) assert.ok(lcp.top < 900, `the largest paint is ${Math.round(lcp.top)}px down the page`)
    await ctx.close()
  })

  it('the public bundle is small enough to be the hot path it is', async () => {
    // Every guest fetches this. It is served from one denormalised item held in memory, and it must
    // not quietly grow into a megabyte as the catalogue does.
    const res = await h.api('/api/public/site')
    const bytes = (await res.arrayBuffer()).byteLength
    assert.ok(bytes < 1_500_000, `the public bundle is ${Math.round(bytes / 1024)} KB`)
    assert.match(res.headers.get('cache-control') || '', /s-maxage=\d+/, 'the edge is not told how long to hold it')
    assert.match(res.headers.get('cache-control') || '', /stale-while-revalidate/, 'a store hiccup would be visible to a guest')
  })

  it('an immutable asset says so, and the HTML never does', async () => {
    const asset = await fetch(`${h.base}/assets/logomark.png`)
    assert.match(asset.headers.get('cache-control') || '', /immutable/)
    const page = await fetch(h.base + '/')
    assert.equal(/immutable/.test(page.headers.get('cache-control') || ''), false, 'the HTML is cached hard, and it carries a per-request nonce')
  })
})
