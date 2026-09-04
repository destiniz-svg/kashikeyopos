/**
 * Every filter on the site is a pure function over the live bundle — `match(resort, f, monthOverride)`
 * in the prototype's logic class, ported here so the intent bar, the Selection carousel, the
 * Properties grid, the destination page and the server-rendered first paint all agree.
 *
 * A second implementation of "does this property match" is how a count in the toast disagrees with
 * the number of cards on the screen.
 */
import { MONTHS, type Offer, type Property } from './types'

export interface Filters {
  dest: string
  pkg: string
  themes: string[]
  /** The duration slider, 3–14. A property matches when it needs no more nights than this. */
  nights: number
  month: string
}

export const DEFAULT_FILTERS: Filters = {
  dest: 'Anywhere',
  pkg: 'Any type',
  themes: [],
  nights: 14,
  month: 'Any month',
}

/**
 * The curated quick paths, in one place because two menus draw them.
 *
 * They were written inline in the desktop header, which is how the phone came to have none at all:
 * the mobile menu is a different component and nobody copied them across. A second copy is also
 * how two menus come to offer different journeys under the same name.
 */
export const QUICK_PATHS: { label: string; apply: Partial<Filters> }[] = [
  { label: 'Overwater icons · Maldives', apply: { dest: 'Maldives', pkg: 'Overwater Villa' } },
  { label: 'Private islands', apply: { pkg: 'Private Island' } },
  { label: 'Honeymoons under 7 nights', apply: { themes: ['Honeymoon'], nights: 7 } },
  { label: 'Family villas', apply: { themes: ['Family'] } },
]

/**
 * The quick paths this catalogue can actually answer.
 *
 * A curated menu entry that lands on "No exact match — try widening" reads as a broken site, and
 * one of the four shipped does exactly that: nothing in the catalogue is classified as an
 * Overwater Villa, though the CMS offers that package type. That is a gap in the CONTENT rather
 * than in the menu, so this does not rewrite the merchant's list — it declines to draw a path that
 * leads nowhere, and the path comes back by itself the moment a specialist tags a property.
 *
 * The whole list is returned rather than nothing when none match, because an empty column under a
 * heading is worse than a path that widens.
 */
export function availableQuickPaths(properties: Property[], offers: Offer[]): { label: string; apply: Partial<Filters> }[] {
  const live = QUICK_PATHS.filter((q) => countMatches(properties, offers, { ...DEFAULT_FILTERS, ...q.apply }, 'insp') > 0)
  return live.length ? live : QUICK_PATHS
}

/**
 * A filter set as a query string, and back.
 *
 * The Selection lives on the home page, so a quick path chosen from anywhere else has to survive a
 * navigation — and a filter that survives a navigation is a filter somebody can also share, which
 * is the better reason to put it in the address rather than in session storage.
 */
export function filtersToQuery(p: Partial<Filters>): string {
  const q = new URLSearchParams()
  if (p.dest && p.dest !== DEFAULT_FILTERS.dest) q.set('dest', p.dest)
  if (p.pkg && p.pkg !== DEFAULT_FILTERS.pkg) q.set('pkg', p.pkg)
  if (p.month && p.month !== DEFAULT_FILTERS.month) q.set('month', p.month)
  if (p.themes?.length) q.set('themes', p.themes.join(','))
  if (typeof p.nights === 'number' && p.nights !== DEFAULT_FILTERS.nights) q.set('nights', String(p.nights))
  return q.toString()
}

/**
 * Read a filter set out of a query string.
 *
 * Every value is bounded, because this arrives from an address anybody can compose. Nothing here
 * can do more than filter a list — but a page that renders whatever it was handed is a page that
 * prints somebody else's sentence in the intent bar, and it costs nothing to refuse.
 */
export function filtersFromQuery(params: URLSearchParams): Partial<Filters> {
  const out: Partial<Filters> = {}
  const text = (v: string | null): string => (v ?? '').replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 40)
  const dest = text(params.get('dest'))
  const pkg = text(params.get('pkg'))
  const month = text(params.get('month'))
  if (dest) out.dest = dest
  if (pkg) out.pkg = pkg
  if (month) out.month = month
  const themes = (params.get('themes') || '')
    .split(',')
    .map((t) => text(t))
    .filter(Boolean)
    .slice(0, 8)
  if (themes.length) out.themes = themes
  const nights = Number(params.get('nights'))
  if (Number.isFinite(nights) && nights >= 3 && nights <= 14) out.nights = Math.round(nights)
  return out
}

export const isDefaultFilters = (f: Filters): boolean =>
  f.dest === DEFAULT_FILTERS.dest &&
  f.pkg === DEFAULT_FILTERS.pkg &&
  f.themes.length === 0 &&
  f.nights === DEFAULT_FILTERS.nights &&
  f.month === DEFAULT_FILTERS.month

/**
 * `monthOverride` carries a departure's own month: `0` means the offer is valid in any month, so it
 * matches whatever month the guest picked.
 */
export function match(r: Property, f: Filters, monthOverride?: number | null): boolean {
  if (f.dest !== 'Anywhere' && r.dest !== f.dest) return false
  if (f.pkg !== 'Any type' && r.pkg !== f.pkg) return false
  if (f.themes.length && !f.themes.every((t) => r.themes.includes(t))) return false
  if (r.nights > f.nights) return false
  if (f.month !== 'Any month') {
    const m = MONTHS.indexOf(f.month as (typeof MONTHS)[number]) + 1
    if (monthOverride != null) {
      if (monthOverride && monthOverride !== m) return false
    } else if (!r.months.includes(m)) return false
  }
  return true
}

export type SelectionTab = 'insp' | 'dep'

/** How many results the current filters yield, for the toast that follows "Explore Journeys". */
export function countMatches(properties: Property[], offers: Offer[], f: Filters, tab: SelectionTab): number {
  if (tab === 'dep') {
    return offers.filter((d) => {
      const r = properties.find((x) => x.id === d.resort)
      return !!r && match(r, f, d.month)
    }).length
  }
  return properties.filter((r) => match(r, f)).length
}

/** The Rooms filter is derived from villa names — the prototype's own vocabulary, unchanged. */
export const ROOM_RULES: [string, RegExp][] = [
  ['Overwater', /water|ocean|overwater/i],
  ['Beach', /beach/i],
  ['Private pool', /pool/i],
  ['Family', /family|two bed|2 bed|residence/i],
]

export function roomKinds(p: Property): string[] {
  const names = (p.villas || []).map((v) => v[0] || '').join(' ')
  return ROOM_RULES.filter(([, re]) => re.test(names)).map(([label]) => label)
}

/** The Transfer filter reads the first word of the transfer summary ("Speedboat · 45 min"). */
export const transferKind = (p: Property): string => (p.transferShort || '').split(/[\s·]+/)[0] || ''

export type PropertyFacet = 'tier' | 'theme' | 'transfer' | 'room'
export type PropertyFilters = Partial<Record<PropertyFacet, string>>

/** The Refine panel: one value per group, every group ANDed. */
export function matchRefine(p: Property, pf: PropertyFilters): boolean {
  if (pf.tier && p.tier !== pf.tier) return false
  if (pf.theme && !(p.themes || []).includes(pf.theme)) return false
  if (pf.transfer && transferKind(p) !== pf.transfer) return false
  if (pf.room && !roomKinds(p).includes(pf.room)) return false
  return true
}

/** Sort for the Properties grid: photographed first, then by collection order. */
export function sortForGrid(list: Property[], tiers: readonly string[]): Property[] {
  return [...list].sort((a, b) => {
    const ai = a.img ? 0 : 1
    const bi = b.img ? 0 : 1
    if (ai !== bi) return ai - bi
    return tiers.indexOf(a.tier) - tiers.indexOf(b.tier)
  })
}

/** USD is the book currency; EUR is a courtesy conversion, rounded to 10 exactly as prototyped. */
export const EUR_RATE = 0.92

export function formatMoney(usd: number, currency: 'USD' | 'EUR'): string {
  const v = currency === 'EUR' ? Math.round((usd * EUR_RATE) / 10) * 10 : usd
  return (currency === 'EUR' ? '€' : '$') + v.toLocaleString('en-US')
}

export function formatMoneyAlt(usd: number, currency: 'USD' | 'EUR'): string {
  const v = currency === 'EUR' ? usd : Math.round((usd * EUR_RATE) / 10) * 10
  return (currency === 'EUR' ? '$' : '€') + v.toLocaleString('en-US')
}
