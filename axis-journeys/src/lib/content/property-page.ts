/**
 * The property page, derived.
 *
 * Everything this page shows is either a field a specialist filled in or a reading of the profile
 * they already wrote — never a figure invented to fill a section. That distinction is the whole
 * design of this file: `scales`, `marine`, `ideal`, `notFor` and `pricing` each have a derivation
 * AND an override, so a page is complete on the day a property is created and gets better the day
 * somebody knows more. Where nothing can be derived the page says so in words rather than
 * printing a number nobody measured.
 *
 * Ported from `propPage()` in `prototype/Axis Journeys.dc.html` (handoff 2026-09-05). It is a pure
 * function of the property, the bundle and the currency so it can be read by a test without a
 * browser; what depends on where the reader has got to — the open villa tab, the open question —
 * stays in the component.
 */
import { formatMoney } from './filters'
import type { Award, Nearby, Property, Scale as ScaleTuple, SiteBundle, Venue, Villa } from './types'

/** Malé, Velana International. The origin every transfer is measured from. */
const MALE: [number, number] = [4.19, 73.53]

/**
 * The stylised map is not a projection, it is a diagram: the Maldives archipelago fitted to a
 * 100 × 115 box so the atoll labels sit where a reader expects them. Longitude 72.5–73.9 and
 * latitude 5.7–3.3 are the bounds of the inhabited atolls this agency sells.
 */
const mapX = (lng: number): number => Math.round(((lng - 72.5) / 1.4) * 1000) / 10
const mapY = (lat: number): number => Math.round(((5.7 - lat) / 2.4) * 1000) / 10

/** Great-circle distance in whole kilometres. */
function distanceKm(a: [number, number], b: [number, number]): number {
  const R = 6371
  const dLat = ((b[0] - a[0]) * Math.PI) / 180
  const dLng = ((b[1] - a[1]) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

/**
 * The CMS writes coordinates as a one-row list, which is `[[lat, lng]]`; the seed writes the pair
 * directly. Both are read, and anything that is not two finite numbers falls back to the centre of
 * the archipelago — a pin in the wrong place is worse than a pin in the middle, because only one
 * of the two looks like an answer.
 */
export function readGeo(raw: unknown): { at: [number, number]; known: boolean } {
  let g: unknown = raw
  if (Array.isArray(g) && Array.isArray(g[0])) g = g[0]
  if (Array.isArray(g) && g.length >= 2) {
    const lat = Number(g[0])
    const lng = Number(g[1])
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { at: [lat, lng], known: true }
  }
  return { at: [4.19, 73.53], known: false }
}

const sentences = (t: string): string[] => (t || '').split(/(?<=[.!?])\s+/).filter(Boolean)
const sqmOf = (meta: string): string => {
  const m = (meta || '').match(/(\d[\d,]*)\s*(sqm|m²|sq ?m)/i)
  return m ? m[1] + ' sqm' : ''
}
const capitalise = (t: string): string => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t)

/** Where each tier sits on the budget↔ultra-luxury scale. The ladder the agency itself publishes. */
const TIER_POSITION: Record<string, number> = {
  'Premium Resorts': 22,
  'Five-Star Escapes': 45,
  'Luxury Collection': 70,
  'Ultra-Luxury Collection': 92,
}

/** What a tier's week costs a couple, used only where no offer carries a real figure. */
const TIER_BASE: Record<string, number> = {
  'Premium Resorts': 3200,
  'Five-Star Escapes': 4800,
  'Luxury Collection': 7500,
  'Ultra-Luxury Collection': 14000,
}

/** The travel windows and what each does to a rate. Published as a guide, and labelled as one. */
const PRICE_WINDOWS: [string, number][] = [
  ['17 Sep – 10 Oct 2026', 1],
  ['11 Oct – 19 Dec 2026', 1.25],
  ['20 Dec – 10 Jan 2027', 2.1],
  ['11 Jan – 9 Apr 2027', 1.6],
  ['10 Apr – 10 May 2027', 1.2],
  ['11 May – 10 Oct 2027', 1.05],
]

const SEASONS: [string, string][] = [
  ['20 Dec – 10 Jan', 'Peak · highest rates'],
  ['11 Jan – 15 Apr', 'High · +40–60%'],
  ['16 Apr – 30 Jun', 'Shoulder · +10–20%'],
  ['1 Jul – 19 Dec', 'Low · best value'],
]

/**
 * What counts as a mention of each species, and why each pattern is the animal rather than its
 * first word.
 *
 * The prototype matched on `species.split(' ')[0]`, which for "Reef sharks" is "Reef" — a word in
 * every reef description this catalogue holds. Measured on the nine published islands: all nine
 * claimed reef sharks, including one whose house reef is described in two words that do not
 * mention a shark. "Regularly seen here" is a claim about wildlife somebody will go looking for,
 * so it has to come from a word a specialist actually wrote about the animal.
 */
const SPECIES: [string, RegExp][] = [
  ['Reef sharks', /reef shark|blacktip|whitetip|nurse shark/i],
  ['Sea turtles', /turtle/i],
  ['Rays', /stingray|eagle ray/i],
  ['Tropical fish', /tropical fish|reef fish|shoal/i],
  ['Dolphins', /dolphin/i],
  ['Manta rays', /manta/i],
  ['Whale sharks', /whale shark/i],
  ['Octopus', /octopus/i],
]

/** What a theme means for the person it suits. Read only where nobody has written `idealFor`. */
const THEME_IDEAL: Record<string, string> = {
  Honeymoon: 'Honeymooners wanting privacy and destination dining',
  Luxury: 'Travellers who value polished service over buzz',
  'Adults Only': 'Couples who want a child-free island',
  Diving: 'Divers and snorkellers — the reef is the reason to come',
  Family: 'Families needing space, a kids club and shallow lagoons',
  Surf: 'Surfers chasing an uncrowded break',
  Surfing: 'Surfers chasing an uncrowded break',
  'All-Inclusive': 'Guests who want one price and no bill shock',
  'All Inclusive': 'Guests who want one price and no bill shock',
  Value: 'First-timers who want the Maldives without the ultra-luxury tag',
  Wellness: 'Wellness-led stays and spa programmes',
  Snorkelling: 'Snorkellers who want a house reef off the beach',
}

/** What Axis does that a rack rate does not. The agency's own claim, stated once. */
export const VS_AXIS = [
  'Best-rate guarantee — we match or beat any published rate',
  'Axis exclusives negotiated directly with the island',
  'Transfers, green tax and meal plan quoted upfront',
  'A named specialist on WhatsApp, in your time zone',
  'If something needs fixing we call the resort manager',
]
export const VS_OTHER = [
  'Published rack rate, no negotiated extras',
  'Standard inclusions only',
  'Transfer and tax added at checkout',
  'Generic support across dozens of destinations',
  'Issues routed through a ticket queue',
]

export interface Scale { lo: string; hi: string; pos: string }
/** Re-exported so a caller reading the override does not have to import from two places. */
export type { ScaleTuple }
export interface VillaTab { label: string; name: string; index: number }
export interface VillaView {
  name: string
  meta: string
  sqm: string
  desc: string
  feats: string[]
  imgs: { img: string; pos: string; galleryIndex: number }[]
  upgrade: string
}
export interface DiningView { name: string; cuisine: string; setting: string; img: string; pos: string; desc: string; when: string }
export interface PriceRow { window: string; entry: string; mid: string; perNight: string }
export interface SimilarView { id: string; name: string; area: string; tier: string; transferShort: string; img: string; pos?: string }

export interface PropertyPageView {
  property: Property
  /** The breadcrumb and the hero. */
  sub: string
  posBig: string
  posSmall: string
  video: string
  price: string
  hasPrice: boolean
  priceIncl: string
  barPrice: string
  /** The at-a-glance strip. */
  transit: string
  reef: string
  bestFor: string
  meals: string
  scales: Scale[]
  awards: Award[]
  tabs: VillaTab[]
  villaAt: (tab: number) => VillaView
  dining: DiningView[]
  diningCount: string
  plans: { name: string; note: string }[]
  included: { text: string; exclusive: boolean }[]
  marine: string[]
  nearby: Nearby[]
  /** The stylised atoll map. Percentages, already formatted for CSS. */
  map: { x: string; y: string; maleX: string; maleY: string; km: string; known: boolean }
  transfers: { mode: string; detail: string; label: string; cost: string }[]
  ideal: string[]
  notFor: string[]
  seasons: { when: string; note: string }[]
  pricing: PriceRow[]
  pricingIsGuide: boolean
  entryVilla: string
  midVilla: string
  similar: SimilarView[]
  faq: [string, string][]
  instagram: { handle: string; href: string } | null
  igTiles: { img: string; pos: string; index: number }[]
  gallery: { img: string; cap: string; pos?: string }[]
  whatsapp: string
}

const SECTION_IDS = ['pp-villas', 'pp-dining', 'pp-incl', 'pp-reef', 'pp-transfer', 'pp-verdict', 'pp-faq'] as const
const SECTION_LABELS = ['Villas', 'Dining', 'Inclusions', 'Reef', 'Transfer', 'Verdict', 'FAQ'] as const
/** The sticky nav's seven rungs. Numbered because the page genuinely is read in this order. */
export const PP_SECTIONS = SECTION_IDS.map((id, i) => ({
  id,
  n: String(i + 1).padStart(2, '0'),
  label: SECTION_LABELS[i],
}))

export function propertyPage(p: Property, bundle: SiteBundle, currency: 'USD' | 'EUR', whatsappNumber: string): PropertyPageView {
  const money = (usd: number) => formatMoney(usd, currency)
  const offer = bundle.offers.find((o) => o.resort === p.id && !!o.from) || null

  const villas: Villa[] = p.villas || []
  const gallery = (p.gallery || []).filter((g) => g.img)

  // Three tabs where there are three or more room types — entry, the middle of the range, the top
  // — because that is the decision a guest is actually making. Fewer, and each keeps its own name.
  const n = villas.length
  const pickIdx = n >= 3 ? [0, Math.floor(n / 2), n - 1] : villas.map((_, i) => i)
  const tabNames = n >= 3 ? ['Entry', 'Mid-tier', 'Premium'] : pickIdx.map((i) => villas[i][0])
  const tabs: VillaTab[] = pickIdx.map((i, k) => ({ label: tabNames[k], name: villas[i][0], index: i }))

  const villaAt = (tab: number): VillaView => {
    const i = pickIdx[Math.min(Math.max(tab, 0), Math.max(0, pickIdx.length - 1))] ?? 0
    const v: Villa = villas[i] || (['', '', 0] as Villa)
    const lead = v[3] || p.img
    // The room's own photographs first, then the property gallery. Index 7 is where a specialist
    // puts further shots of the same room, so a room that has them shows them rather than falling
    // through to whatever the island's gallery happens to open with.
    const own = (v[7] || []).filter(Boolean)
    const ownPos = v[8] || []
    const seen = new Set<string>()
    const imgs: VillaView['imgs'] = []
    const push = (img: string, pos: string, galleryIndex: number) => {
      if (!img || seen.has(img) || imgs.length >= 4) return
      seen.add(img)
      imgs.push({ img, pos, galleryIndex })
    }
    push(lead, v[6] || '50% 50%', gallery.findIndex((g) => g.img === lead))
    own.forEach((img, k) => push(img, ownPos[k] || '50% 50%', gallery.findIndex((g) => g.img === img)))
    gallery.forEach((g, k) => push(g.img, g.pos || '50% 50%', k))
    const delta = v[2] || 0
    return {
      name: v[0] || '',
      meta: v[1] || '',
      sqm: sqmOf(v[1] || ''),
      desc: v[4] || '',
      feats: v[5] || [],
      imgs,
      upgrade:
        tab === 0
          ? 'Included in the entry package'
          : delta > 0
            ? 'Upgrade for + ' + money(delta) + ' per package'
            : 'Upgrade quoted by your specialist',
    }
  }

  // --- what the package carries -------------------------------------------------------------
  const first: Villa = villas[0] || (['', '', 0] as Villa)
  const mealIncl = (p.board || '').split('·')[0].trim()
  const included: PropertyPageView['included'] = [
    first[0] ? `${p.nights} nights in a ${first[0]}` : '',
    p.transfers?.[0] ? `Round-trip ${p.transfers[0][0].toLowerCase()} transfers · ${p.transfers[0][1]}` : '',
    mealIncl ? `${capitalise(mealIncl)} meal plan` : '',
  ]
    .filter(Boolean)
    .map((text) => ({ text, exclusive: false }))
  for (const t of p.exclusives || []) included.push({ text: t, exclusive: true })

  // --- where it is ---------------------------------------------------------------------------
  const geo = readGeo(p.geo)
  const map = {
    x: mapX(geo.at[1]) + '%',
    y: mapY(geo.at[0]) + '%',
    maleX: mapX(MALE[1]) + '%',
    maleY: mapY(MALE[0]) + '%',
    km: geo.known ? `${distanceKm(MALE, geo.at)} km from Malé` : 'Distance from Malé on request',
    known: geo.known,
  }

  // --- the five scales -----------------------------------------------------------------------
  const themes = p.themes || []
  const mins = parseInt(((p.transferShort || '').match(/(\d+)\s*min/) || [])[1] || '45', 10)
  const bySea = /seaplane|flight/i.test(p.transferShort || '')
  const familyPos = themes.some((t) => /family/i.test(t)) ? 78 : themes.some((t) => /adults|honeymoon/i.test(t)) ? 18 : 45
  const reefText = (p.reef || '').toLowerCase()
  const reefPos = /exceptional|world-class|one of the best/.test(reefText)
    ? 92
    : /excellent|vibrant|great/.test(reefText)
      ? 78
      : /good|healthy/.test(reefText)
        ? 60
        : reefText && reefText !== '—'
          ? 45
          : 30
  const clamp = (v: number) => Math.min(92, Math.max(10, v))
  const derivedScales: [string, string, number][] = p.scales && p.scales.length ? p.scales.map((x) => [x[0], x[1], x[2]] as [string, string, number]) : [
    ['Budget', 'Ultra-luxury', TIER_POSITION[p.tier] ?? 50],
    [
      'Lively',
      'Secluded',
      clamp(
        (bySea ? 60 : 30) +
          (themes.some((t) => /adults|honeymoon|luxury/i.test(t)) ? 20 : 0) -
          (themes.some((t) => /family|surf|value/i.test(t)) ? 15 : 0),
      ),
    ],
    ['Easy access', 'Remote', clamp(bySea ? 55 + mins / 2 : mins * 1.2)],
    ['Couples', 'Family', familyPos],
    ['Poor reef', 'Exceptional reef', reefPos],
  ]
  const scales: Scale[] = derivedScales.map(([lo, hi, pos]) => ({ lo, hi, pos: pos + '%' }))

  // --- dining ---------------------------------------------------------------------------------
  const venues: Venue[] = (p.dining || []).slice(0, 6)
  const dining: DiningView[] = venues.map((d) => ({
    name: d[0],
    cuisine: d[1],
    setting: d[2] || '',
    img: d[3] || p.img,
    pos: d[6] || '50% 50%',
    desc: d[4] || '',
    when: (d[5] || []).join(' · '),
  }))
  const plans = (p.board || '')
    .split('·')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((plan, i) => ({
      name: capitalise(plan).replace(/ on request$/i, ''),
      note:
        i === 0
          ? 'Included in the entry package'
          : /request/i.test(plan)
            ? 'On request — quoted for your dates'
            : 'Upgrade quoted by your specialist',
    }))

  // --- the reef and what swims on it -----------------------------------------------------------
  const prose = [p.reef, p.love, p.about, (p.nearby || []).map((x) => x.join(' ')).join(' ')].join(' ')
  const marine = p.marine && p.marine.length ? p.marine : SPECIES.filter(([, re]) => re.test(prose)).map(([label]) => label)

  // --- getting there ---------------------------------------------------------------------------
  const transfers = (p.transfers || []).map((t, i) => ({
    mode: t[0],
    detail: t[1],
    label: i === 0 ? 'Recommended' : 'Alternative',
    cost: t[2] ? money(t[2]) + ' pp return' : 'Quoted with your package',
  }))

  // --- who it is for -----------------------------------------------------------------------------
  const ideal = (p.idealFor && p.idealFor.length ? p.idealFor : themes.map((t) => THEME_IDEAL[t] || t)).slice(0, 4)
  const notFor =
    p.notFor && p.notFor.length
      ? p.notFor
      : [
          familyPos < 30
            ? 'Families with young children — this is an adults-focused island'
            : 'Couples seeking total seclusion — the island is lively',
          bySea
            ? 'Late-evening arrivals — seaplanes fly in daylight only'
            : 'Guests wanting a remote outer-atoll feel — Malé is close',
          /ultra|luxury/i.test(p.tier)
            ? 'Budget travellers — pricing sits at the top of the market'
            : 'Ultra-luxury seekers — service is warm rather than white-glove',
        ]

  // --- what the same week costs across the year ---------------------------------------------------
  const base = offer?.from || TIER_BASE[p.tier] || 5000
  const round10 = (v: number) => Math.round(v / 10) * 10
  const rows: [string, number, number][] =
    p.pricing && p.pricing.length
      ? p.pricing.map((x) => [x[0], Number(x[1]), Number(x[2])] as [string, number, number])
      : PRICE_WINDOWS.map(([w, m]) => [w, round10(base * m), round10(base * m * 1.28)] as [string, number, number])
  const pricing: PriceRow[] = rows.map(([w, a, b]) => ({
    window: w,
    entry: money(a),
    mid: b ? money(b) : '—',
    perNight: '+' + money(Math.round(a / Math.max(1, p.nights))) + ' / extra night',
  }))

  // --- islands like this one -----------------------------------------------------------------------
  const similar: SimilarView[] = bundle.properties
    .filter((x) => x.id !== p.id && x.dest === p.dest)
    .sort((a, b) => (a.tier === p.tier ? 0 : 1) - (b.tier === p.tier ? 0 : 1))
    .slice(0, 3)
    .map((x) => ({ id: x.id, name: x.name, area: x.area, tier: x.tier, transferShort: x.transferShort, img: x.img }))

  const verdict = sentences(p.verdict || '')
  const love = sentences(p.love || '')
  const rest = verdict.slice(1).join(' ')

  return {
    property: p,
    sub: verdict[0] || '',
    posBig: rest || love.slice(0, 2).join(' '),
    posSmall: rest ? p.love || '' : love.slice(2).join(' '),
    video: p.video || '',
    price: offer?.from ? money(offer.from) : '',
    hasPrice: !!offer?.from,
    priceIncl: `${p.nights} nights · ${mealIncl || 'villa & transfers'}`,
    barPrice: offer?.from ? 'Packages from ' + money(offer.from) + ' per couple' : 'Tailored quote within 24 hours',
    transit: p.transferShort,
    reef: p.reef && p.reef !== '—' ? p.reef : 'Ask your specialist',
    bestFor: p.bestFor || themes.join(' · '),
    meals: p.board || 'Quoted with your package',
    scales,
    awards: p.awards || [],
    tabs,
    villaAt,
    dining,
    diningCount: dining.length + (dining.length === 1 ? ' restaurant' : ' restaurants'),
    plans,
    included,
    marine,
    nearby: p.nearby || [],
    map,
    transfers,
    ideal,
    notFor,
    seasons: SEASONS.map(([when, note]) => ({ when, note })),
    pricing,
    pricingIsGuide: !(p.pricing && p.pricing.length),
    entryVilla: first[0] || 'Entry villa',
    midVilla: (villas[Math.floor(n / 2)] || ([] as unknown as Villa))[0] || 'Mid-tier villa',
    similar,
    faq: p.faq || [],
    instagram: p.instagram ? { handle: '@' + p.instagram, href: `https://www.instagram.com/${p.instagram}/` } : null,
    igTiles: gallery.slice(0, 6).map((g, i) => ({ img: g.img, pos: g.pos || '50% 50%', index: i })),
    gallery,
    whatsapp: `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(
      `Hello Axis Journeys — I would like a quote for ${p.name} (${p.nights} nights).`,
    )}`,
  }
}
