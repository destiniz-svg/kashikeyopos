/**
 * Chromium, against the same server the API tests drive.
 *
 * Playwright is a development dependency and the browser is the one already on this machine, so the
 * suite never downloads one. Everything here is deliberately thin: the tests express what a guest
 * or an editor does, and this file only knows how to open a page and complain usefully when one
 * fails to load.
 */
import pkg from 'playwright'
import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright'

const { chromium } = pkg

/** Playwright's own bundled Chromium is not installed here; the image's is. */
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'

export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  phoneSmall: { width: 320, height: 720 },
  tablet: { width: 820, height: 1180 },
  laptop: { width: 1180, height: 800 },
  desktop: { width: 1440, height: 900 },
} as const

export type ViewportName = keyof typeof VIEWPORTS

export interface Session {
  browser: Browser
  context: BrowserContext
  close(): Promise<void>
}

/**
 * Answer off-site requests without leaving the sandbox.
 *
 * The catalogue's photography is on real hosts — the agency's own domain and Unsplash — and this
 * environment's egress policy refuses both, so a drive would otherwise fail on every image or, worse,
 * stop asserting that the page loaded cleanly. A page that throws on every render looks identical to
 * one that works in a screenshot, so keeping the fault assertion is the point.
 *
 * A request is first tried through node's fetch, which does reach the proxy for hosts it allows.
 * Anything refused is answered with a valid one-pixel image, at the network layer and nowhere else:
 * the app, the markup and the CSS are untouched. What that does NOT prove is that the real
 * photography loads — that is stated as a limitation rather than implied to be covered.
 */
const wire = new Map<string, { status: number; type: string; buffer: Buffer }>()

/** A valid 1×1 transparent PNG, so a substituted image decodes rather than becoming a broken one. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Off-site URLs this run could not reach. Reported by the tests that care, never silently.  */
export const unreachable = new Set<string>()

async function installNet(context: BrowserContext): Promise<void> {
  // Only off-site traffic is intercepted: routing every local asset through a JavaScript handler
  // slows a drive enough to change what a timing-sensitive test sees.
  await context.route(/^https:\/\//, async (route) => {
    const url = route.request().url()
    try {
      if (!wire.has(url)) {
        const res = await fetch(url, { headers: { accept: '*/*' } })
        if (!res.ok) throw new Error(`upstream ${res.status}`)
        wire.set(url, { status: res.status, type: res.headers.get('content-type') || 'application/octet-stream', buffer: Buffer.from(await res.arrayBuffer()) })
      }
      const hit = wire.get(url)!
      return route.fulfill({ status: hit.status, contentType: hit.type, body: hit.buffer })
    } catch {
      unreachable.add(url)
      const isImage = route.request().resourceType() === 'image' || /\.(jpe?g|png|webp|avif|gif|svg)(\?|$)/i.test(url)
      return isImage
        ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
        : route.fulfill({ status: 200, contentType: 'text/plain', body: '' })
    }
  })
}

export async function newContext(session: Session, viewport: { width: number; height: number }, extra: Record<string, unknown> = {}): Promise<BrowserContext> {
  const ctx = await session.browser.newContext({ viewport, deviceScaleFactor: 1, ...extra })
  await installNet(ctx)
  return ctx
}

export async function launch(viewport: ViewportName = 'desktop'): Promise<Session> {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: 1 })
  await installNet(context)
  return {
    browser,
    context,
    async close() {
      await context.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    },
  }
}

export interface Watched {
  page: Page
  /** Closes the context when the page was opened in one of its own. */
  dispose(): Promise<void>
  /** Anything the page logged as an error, and any request that failed outright. */
  faults: string[]
}

/**
 * A page that records its own faults.
 *
 * A test that only asserts on what it can see passes over a page throwing on every render, so every
 * drive here collects console errors and failed requests and asserts they are empty.
 */
export async function openPage(session: Session, context?: BrowserContext): Promise<Watched> {
  const page = await (context ?? session.context).newPage()
  const faults: string[] = []
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') faults.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e: Error) => faults.push(`uncaught: ${e.message}`))
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || 'failed'
    // A navigation the test itself aborted is not a fault.
    if (why !== 'net::ERR_ABORTED') faults.push(`request: ${r.url()} — ${why}`)
  })
  return { page, faults, dispose: async () => { if (context) await context.close().catch(() => undefined) } }
}

/**
 * A page in a context of its own.
 *
 * Cookies are per context, so two drives that share one share a session — which is how a test that
 * expects a signed-out screen finds a signed-in one, and reports a defect nobody has.
 */
export async function freshPage(session: Session, viewport = VIEWPORTS.desktop): Promise<Watched> {
  const context = await newContext(session, viewport)
  return openPage(session, context)
}

/** Does the page scroll sideways? The one responsive failure a screenshot always shows. */
export const overflowsX = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)

/**
 * Elements a guest can SEE being cut off at the right edge.
 *
 * `overflowsX` is not enough on its own and this is the lesson that cost a round of screenshots
 * from a real phone: the app root sets `overflow-x:hidden`, so an element wider than the viewport
 * never widens the document — the page reports no sideways scroll and the content is sliced off
 * anyway. Reported: a carousel card 24px too wide, a destination row whose name ran over its own
 * count, and a heading clipped mid-word, all on a page this suite called clean.
 *
 * The exclusion is anything with a clipping ancestor OF ITS OWN — a carousel track, a scrolling
 * comparison table, a footer with a bled watermark. Those clip on purpose and the guest sees a
 * deliberate edge. The app root's own `overflow-x:hidden` does not count, which is the whole point:
 * it is the one clip that hides real defects, so it is the one this walk steps past.
 */
export const clippedRight = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const out: { over: number; line: string }[] = []
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || r.left >= vw - 2) continue
      const chain: Element[] = []
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) chain.push(n)
      // Everything but the outermost element under <body>, which is the app root.
      if (chain.slice(0, -1).some((a) => getComputedStyle(a).overflowX !== 'visible')) continue
      const over = Math.round(r.right - vw)
      // 8px of slack: a decorative element bled past the edge on purpose is not a defect, and a
      // sub-pixel rounding difference is not one either.
      if (over > 8) out.push({ over, line: `${el.tagName}${el.id ? '#' + el.id : ''} +${over}px "${(el.textContent || '').trim().slice(0, 40)}"` })
    }
    const seen = new Set<string>()
    return out.sort((a, b) => b.over - a.over).map((x) => x.line).filter((l) => !seen.has(l) && seen.add(l))
  })

/**
 * Targets that fail WCAG 2.5.8, including the standard's own two exceptions.
 *
 * A flat "everything must be 44px" would fail this design on every chip, and the prototype is the
 * visual contract — its segmented toggles, theme pills and filter chips are 34px by design. So the
 * check is the actual rule: a target must be at least `min`×`min`, UNLESS it is inline text inside
 * a sentence (the inline exception) or it has at least `min` of clear space around it, measured
 * centre to centre against every other target (the spacing exception). Both are what the standard
 * says, and both are why a stacked footer of 18px text links is reachable in practice.
 */
export const failingTargets = (page: Page, min = 24): Promise<{ text: string; w: number; h: number; why: string }[]> =>
  page.evaluate((floor) => {
    const SELECTOR = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]'
    const boxes: { el: Element; r: DOMRect; inline: boolean; text: string }[] = []
    for (const el of document.querySelectorAll(SELECTOR)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue
      if (Number(style.opacity) === 0) continue
      // The inline exception: a link in a run of text, sized by the line it sits on.
      const inline = style.display === 'inline' && el.tagName === 'A'
      boxes.push({ el, r, inline, text: (el.textContent || (el as HTMLInputElement).name || el.tagName).trim().slice(0, 40) })
    }
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    const out: { text: string; w: number; h: number; why: string }[] = []
    for (const b of boxes) {
      if (b.inline) continue
      if (Math.min(b.r.width, b.r.height) >= floor) continue
      // The spacing exception: no other target's centre within `floor` of this one's.
      const c = centre(b.r)
      const crowded = boxes.some((o) => {
        if (o.el === b.el) return false
        const oc = centre(o.r)
        return Math.hypot(oc.x - c.x, oc.y - c.y) < floor
      })
      if (crowded) out.push({ text: b.text, w: Math.round(b.r.width), h: Math.round(b.r.height), why: 'undersized and crowded' })
    }
    return out
  }, min)

/** The smallest short axis among the controls somebody presses, for the record. */
export const smallestControl = (page: Page): Promise<number> =>
  page.evaluate(() => {
    let smallest = Infinity
    for (const el of document.querySelectorAll('button, input:not([type="hidden"]), select, [role="button"]')) {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.pointerEvents === 'none') continue
      smallest = Math.min(smallest, r.width, r.height)
    }
    return smallest === Infinity ? 0 : Math.round(smallest)
  })
