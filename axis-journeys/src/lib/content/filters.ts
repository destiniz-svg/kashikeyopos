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

/**
 * Which atoll a property is in, read from its own area line ("Baa Atoll · Kunfunadhoo Island").
 *
 * Derived rather than stored, for the reason the Rooms filter is: the agency already writes the
 * atoll into every property, and a second field would be a second thing to keep in step. A line
 * with no atoll in it answers "Maldives", which is where the property is.
 */
export const atollOf = (p: Property): string =>
  (p.area || '').split('·')[0].replace(/\s*Atoll.*$/i, '').trim() || 'Maldives'

/**
 * The hotel group behind a property. `brand` where a specialist set one; otherwise read from the
 * name, which is how the agency writes it — "Conrad Maldives Rangali Island" is a Conrad.
 *
 * The list is the groups this agency actually represents. A name it does not recognise falls back
 * to the first word, which groups a small independent with itself rather than with everybody else.
 */
const BRANDS =
  /^(Sun Siyam|Adaaran|Cinnamon|Conrad|Waldorf Astoria|Soneva|Anantara|Four Seasons|Six Senses|One&Only|Ritz-Carlton|St\. Regis|JW Marriott|W Maldives|Sheraton|Le Méridien|Westin|Hilton|InterContinental|Kandima|Atmosphere|OBLU|Cheval Blanc|Patina|COMO|Raffles|Park Hyatt|Fairmont|Emerald|Pullman|Mercure|Hard Rock|Centara|Cora Cora|JOALI|Velaa|Milaidhoo|Amilla|Vakkaru|Kudadoo|Hurawalhi|Kuredu|Komandoo|Constance|Diamonds|Lily|Niyama|Ozen|Taj|Radisson|Kurumba|Velassaru|Dusit|Heritance|Movenpick|Alila|Baglioni|Banyan Tree|Gili|Huvafen|Cocoon|You & Me)/i

export function brandOf(p: Property): string {
  if (p.brand) return p.brand.split('·')[0].trim()
  const m = (p.name || '').match(BRANDS)
  if (m) return m[1]
  return (p.name || '').split(/\s+(?:Maldives|Island|Resort)/i)[0].split(' ')[0]
}

export type PropertyFacet = 'tier' | 'theme' | 'transfer' | 'room' | 'atoll' | 'brand'
export type PropertyFilters = Partial<Record<PropertyFacet, string>>

/** The Refine panel: one value per group, every group ANDed. */
export function matchRefine(p: Property, pf: PropertyFilters): boolean {
  if (pf.tier && p.tier !== pf.tier) return false
  if (pf.theme && !(p.themes || []).includes(pf.theme)) return false
  if (pf.transfer && transferKind(p) !== pf.transfer) return false
  if (pf.room && !roomKinds(p).includes(pf.room)) return false
  if (pf.atoll && atollOf(p) !== pf.atoll) return false
  if (pf.brand && brandOf(p) !== pf.brand) return false
  return true
}

/**
 * The category quick-filters above the Refine panel.
 *
 * They are shortcuts through the same catalogue, not a second taxonomy: each is a predicate over
 * fields the agency already fills in, so a category can never contain a property whose profile
 * does not justify it. A category nothing matches is not drawn — an empty tab is a promise the
 * catalogue cannot keep.
 */
export const CATEGORIES: [string, ((p: Property, offers: Offer[]) => boolean) | null][] = [
  ['All', null],
  ['Best reefs', (p) => /exceptional|excellent|vibrant|world-class/i.test(p.reef || '')],
  ['Honeymoon', (p) => (p.themes || []).includes('Honeymoon') || (p.themes || []).includes('Adults Only')],
  ['Family', (p) => (p.themes || []).includes('Family') || roomKinds(p).includes('Family')],
  ['All-inclusive', (p) => /all.inclusive/i.test(p.board || '') || (p.themes || []).includes('All-Inclusive')],
  ['Quick transfer', (p) => /speedboat/i.test(p.transferShort || '')],
  ['Remote', (p) => /seaplane|flight/i.test(p.transferShort || '')],
  ['Live offers', (p, offers) => offers.some((o) => o.resort === p.id && !!o.from)],
]

/**
 * The four questions, and what an answer is worth.
 *
 * This RE-RANKS; it never filters. A quiz that hid islands would answer "no match" to a guest who
 * gave four honest answers, and the catalogue is nine islands — the useful thing is an order, not
 * a shorter list. Every clause reads a field a specialist wrote, so a high score is a claim the
 * profile itself supports.
 */
export const QUIZ: [string, [string, string][]][] = [
  [
    'What matters most?',
    [
      ['reef', 'Wild reef & marine life'],
      ['quiet', 'Total seclusion'],
      ['polish', 'Polished luxury'],
      ['value', 'Barefoot value'],
    ],
  ],
  [
    'Who is travelling?',
    [
      ['couple', 'Just us two'],
      ['family', 'Family'],
      ['group', 'Friends or group'],
    ],
  ],
  [
    'How important is the reef?',
    [
      ['must', 'Must be amazing'],
      ['big', 'Big marine life'],
      ['no', 'Not a priority'],
    ],
  ],
  [
    'Getting there?',
    [
      ['quick', 'Quick & easy'],
      ['scenic', 'Scenic seaplane'],
      ['any', 'Either'],
    ],
  ],
]

export type QuizAnswers = Record<number, string | null | undefined>

export function quizScore(p: Property, answers: QuizAnswers): number {
  let n = 0
  const themes = p.themes || []
  const reefGood = /exceptional|excellent|vibrant|world-class/i.test(p.reef || '')
  const bySea = /seaplane|flight/i.test(p.transferShort || '')
  const lux = /luxury|ultra/i.test(p.tier || '')
  const prose = [p.love, p.about, (p.nearby || []).map((x) => x.join(' ')).join(' ')].join(' ')

  if (answers[0] === 'reef' && reefGood) n += 3
  if (answers[0] === 'quiet' && (bySea || themes.includes('Adults Only'))) n += 3
  if (answers[0] === 'polish' && lux) n += 3
  if (answers[0] === 'value' && /premium|five/i.test(p.tier || '')) n += 3

  if (answers[1] === 'couple' && (themes.includes('Honeymoon') || themes.includes('Adults Only'))) n += 2
  if (answers[1] === 'family' && (themes.includes('Family') || roomKinds(p).includes('Family'))) n += 3
  if (answers[1] === 'group' && roomKinds(p).includes('Family')) n += 1

  if (answers[2] === 'must' && reefGood) n += 3
  if (answers[2] === 'big' && /whale|manta/i.test(prose)) n += 3

  if (answers[3] === 'quick' && !bySea) n += 2
  if (answers[3] === 'scenic' && bySea) n += 2
  return n
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
