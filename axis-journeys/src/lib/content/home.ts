/**
 * The home page's own derivations — the atoll cards, the comparison table, the guides and the
 * questions the 2026-09-05 handoff added.
 *
 * Pure functions of the bundle for the same reason `property-page.ts` is: a test can read them
 * without a browser, and there is one place to look when a figure on the home page is wrong.
 *
 * The rule this file keeps throughout: a section that has nothing to say does not appear. An
 * atoll rail with one atoll in it, or a comparison of one island, is a layout with a hole in it
 * rather than an answer, and the caller is told so rather than being handed an empty list to draw.
 */
import { atollOf, brandOf, formatMoney } from './filters'
import type { Property, SiteBundle } from './types'

/**
 * What each atoll is known for. Facts about the country rather than about a property, which is why
 * they are here and not in the CMS: an atoll's character does not change when a resort is added.
 * An atoll not on this list says "Maldives", which is true and says nothing more than it knows.
 */
const ATOLL_TAGS: Record<string, string> = {
  'North Malé': 'Easiest access',
  'South Malé': 'Speedboat islands',
  Baa: 'UNESCO biosphere',
  'South Ari': 'Whale sharks',
  'North Ari': 'Diving channels',
  Raa: 'Quiet north',
  Lhaviyani: 'Long reefs',
  Noonu: 'Ultra-luxury',
}

export interface AtollCard {
  /** The filter value — the bare atoll name, as `atollOf` reads it. */
  value: string
  name: string
  tag: string
  count: string
  transfer: string
  img: string
}

/**
 * The four atolls this catalogue has most of, largest first.
 *
 * Four because the rail is four columns; fewer than two and there is no "explore by atoll" to do,
 * so the caller gets an empty list and draws nothing.
 */
export function atollCards(properties: Property[]): AtollCard[] {
  if (properties.length === 0) return []
  const groups = new Map<string, Property[]>()
  for (const p of properties) {
    const key = atollOf(p)
    const list = groups.get(key)
    if (list) list.push(p)
    else groups.set(key, [p])
  }
  if (groups.size < 2) return []
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([name, list]) => {
      const lead = list[0]
      return {
        value: name,
        name: `${name} Atoll`,
        tag: ATOLL_TAGS[name] || 'Maldives',
        count: `${list.length} ${list.length === 1 ? 'island' : 'islands'}`,
        transfer: (lead.transferShort || '').split('·')[0].trim(),
        img: lead.img,
      }
    })
}

export interface BrandChip { label: string; count: string }

/** Every group with more than one island, busiest first. One island is a name, not a brand. */
export function brandChips(properties: Property[]): BrandChip[] {
  const counts = new Map<string, number>()
  for (const p of properties) {
    const b = brandOf(p)
    if (b) counts.set(b, (counts.get(b) || 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, n]) => ({ label, count: `${n} ${n === 1 ? 'island' : 'islands'}` }))
}

export interface ComparisonColumn { id: string; name: string; area: string }
export interface ComparisonRow { label: string; cells: string[] }
export interface Comparison { columns: ComparisonColumn[]; rows: ComparisonRow[] }

/**
 * Three islands side by side — a taste of what a property page holds.
 *
 * `FEATURED` is the agency's own pick, and it is a preference rather than a requirement: an id
 * that is not published simply is not there, and the rest of the catalogue fills the gap. A
 * hardcoded id that has been unpublished must not empty a section.
 */
const FEATURED = ['baros', 'conrad-rangali', 'soneva-fushi']

export function comparison(bundle: SiteBundle, currency: 'USD' | 'EUR'): Comparison {
  const live = bundle.properties
  const picked: Property[] = []
  for (const id of FEATURED) {
    const p = live.find((x) => x.id === id)
    if (p) picked.push(p)
  }
  for (const p of live) {
    if (picked.length >= 3) break
    if (!picked.includes(p)) picked.push(p)
  }
  if (picked.length < 2) return { columns: [], rows: [] }

  const price = (p: Property): string => {
    const offer = bundle.offers.find((o) => o.resort === p.id && !!o.from)
    // Only where an Offer carries a real figure. Everything else is quoted, and saying so is the
    // honest cell — a "from" price nobody published would be this table's own invention.
    return offer?.from ? `${formatMoney(offer.from, currency)} · ${p.nights} nights` : `Quoted · ${p.nights} nights`
  }
  const entryVilla = (p: Property): string => {
    const first = (p.villas || [])[0]
    if (!first) return '—'
    const m = (first[1] || '').match(/(\d[\d,]*)\s*(sqm|m²)/i)
    return m ? `${m[1]} sqm · ${first[0]}` : first[0]
  }

  return {
    columns: picked.map((p) => ({ id: p.id, name: p.name, area: (p.area || '').split('·')[0].trim() })),
    rows: [
      { label: 'Packages from', cells: picked.map(price) },
      { label: 'House reef', cells: picked.map((p) => (p.reef && p.reef !== '—' ? p.reef : 'Ask your specialist')) },
      { label: 'Transfer', cells: picked.map((p) => p.transferShort) },
      { label: 'Entry villa', cells: picked.map(entryVilla) },
      {
        label: 'Meal plans',
        cells: picked.map((p) => {
          const first = (p.board || '').split('·')[0].trim()
          return first ? first.charAt(0).toUpperCase() + first.slice(1) : '—'
        }),
      },
    ],
  }
}

export interface Guide { n: string; title: string; sub: string; intro: string; points: [string, string][] }

/**
 * The four things every first-timer asks. Agency knowledge about the country, written once.
 *
 * They are here rather than in the CMS because they are not about any property: seasons, transfer
 * modes, what a week costs and how the agency chooses. A specialist who wants to change one edits
 * this file, which is the honest place for a claim the whole site makes.
 */
export const GUIDES: Guide[] = [
  {
    n: '01',
    title: 'Best time to visit',
    sub: 'Seasons, monsoons and what they do to prices.',
    intro:
      'December to April is dry and calm with the highest rates; May to November brings afternoon showers, emptier islands and the manta season in Baa Atoll. The Christmas fortnight books out four months ahead.',
    points: [
      ['Dec 20 – Jan 10', 'Peak · highest rates, minimum stays'],
      ['Jan – Apr', 'High · best weather, +40–60%'],
      ['May – Jun', 'Shoulder · calm mornings, +10–20%'],
      ['Jul – Nov', 'Low · best value, mantas in Baa'],
    ],
  },
  {
    n: '02',
    title: 'Getting there',
    sub: 'Speedboat, seaplane or domestic flight — and when each one fits.',
    intro:
      'Every island is reached from Velana International (MLE). Speedboats serve North and South Malé around the clock; seaplanes reach the outer atolls in 25–60 minutes but fly in daylight only; domestic flights plus a short boat cover late arrivals.',
    points: [
      ['Speedboat', '15–60 min · 24 hours · USD 150–400 pp return'],
      ['Seaplane', '25–60 min · daylight only · USD 400–900 pp return'],
      ['Domestic + boat', 'Works after dark · similar cost to seaplane'],
      ['Our rule', 'We quote the transfer with the package, never at checkout'],
    ],
  },
  {
    n: '03',
    title: 'Budget & costs',
    sub: 'What a week really costs per couple, line by line.',
    intro:
      'Villa, transfer, meal plan and tax move independently. A five-star week with half board typically lands between USD 6,000 and 12,000 per couple; ultra-luxury starts above 15,000. Green tax is USD 12 per person per night.',
    points: [
      ['Premium resorts', 'USD 3,000–6,000 per couple per week'],
      ['Luxury collection', 'USD 6,000–12,000'],
      ['Ultra-luxury', 'USD 15,000+'],
      ['Add on top', 'Transfers, meal plan upgrades, 12% service + 17% GST on extras'],
    ],
  },
  {
    n: '04',
    title: 'How we choose',
    sub: 'The questions we ask before we recommend an island.',
    intro:
      'Reef first, then transfer, then villa. We ask who is travelling, how much the water matters, and whether you want buzz or silence — then match against islands we have stayed at and contracts we hold directly.',
    points: [
      ['Reef', 'Entry from the beach, coral health, what you will see'],
      ['Transfer', 'Total journey time and daylight cut-offs'],
      ['Villa', 'Beach or overwater, pool, sunset side'],
      ['Board', 'Which plan actually pays off at this island'],
    ],
  },
]

/** The questions the counter is asked every week, and the agency's own answers. */
export const HOME_FAQ: [string, string][] = [
  [
    'How do I choose the right island?',
    'Start with what matters most — reef, seclusion, dining or budget — then narrow by atoll and transfer. Speedboat islands near Malé suit short stays and late flights; seaplane atolls feel more remote. Our verdict on each property page says who it suits.',
  ],
  [
    'What does a week in the Maldives cost?',
    'Roughly USD 4,000–20,000 per couple depending on tier. Transfers, meal plan and excursions add 20–40% on top of the villa — which is why we quote them upfront.',
  ],
  [
    'Seaplane or speedboat?',
    'Speedboats (North and South Malé) run 24 hours and cost less. Seaplanes fly in daylight only, cost USD 400–900 per person return, and open up the quieter outer atolls. Late arrivals can often use a domestic flight instead.',
  ],
  [
    'Can I snorkel from the beach?',
    'Not everywhere. House-reef quality ranges from sand to world-class coral you can swim to. We describe each reef honestly and flag the islands where you need a boat.',
  ],
  [
    'What is included in an Axis package?',
    'Villa, the meal plan you choose, and the Axis exclusives listed on the property page. Transfers and green tax are itemised in your quote; flights are quoted separately.',
  ],
  [
    'How fast is a quote?',
    'A first reply within 15 minutes in Dubai hours and a full shortlist of three within 24 hours, refined together on WhatsApp.',
  ],
]

/**
 * The hero's one-line stat.
 *
 * Counted from what the site actually publishes rather than from what the agency represents: the
 * prototype carries a literal 38, and a figure a visitor can disprove by counting the grid is
 * worse than a smaller true one.
 */
export function homeStats(properties: Property[]): { islands: number; atolls: number } {
  return { islands: properties.length, atolls: new Set(properties.map(atollOf)).size }
}
