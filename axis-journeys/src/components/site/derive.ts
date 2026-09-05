'use client'

/**
 * The pure half of the prototype's `renderVals()`: everything the sections read that is a function
 * of the bundle and the current state, and nothing that touches the DOM.
 *
 * Split by section rather than kept as one 100-line object, because the original was unreadable and
 * because a section that only needs the offers should not re-derive the whole floor to get them.
 */
import { useMemo } from 'react'
import {
  atollOf,
  brandOf,
  CATEGORIES,
  quizScore,
  formatMoney,
  match,
  matchRefine,
  roomKinds,
  sortForGrid,
  transferKind,
  type Filters,
  type PropertyFilters,
  type QuizAnswers,
} from '@/lib/content/filters'
import { MONTHS, PKGS, THEMES, TIERS, type Destination, type Offer, type Property, type SiteBundle } from '@/lib/content/types'

export const TIER_BLURB: Record<string, string> = {
  'Ultra-Luxury Collection': "Maldives' most exclusive settings.",
  'Luxury Collection': 'Retreats crafted for escape.',
  'Five-Star Escapes': 'World-class comfort, lasting memories.',
  'Premium Resorts': 'Comfort meets island elegance.',
}

/** The on/off palette every chip and option in the prototype shares. */
export const chipColours = (on: boolean) => ({
  bg: on ? 'rgba(224,185,79,.14)' : 'transparent',
  fg: on ? '#E0B94F' : 'var(--ink)',
  bd: on ? '#E0B94F' : 'var(--line-14)',
})

export const optionColours = (on: boolean) => ({
  bg: on ? 'rgba(224,185,79,.14)' : 'transparent',
  fg: on ? '#E0B94F' : 'var(--ink)',
  bd: on ? '#E0B94F' : 'var(--line-18)',
})

export const segColours = (on: boolean) => ({ bg: on ? '#E0B94F' : 'transparent', fg: on ? '#00102F' : 'var(--muted)' })

export const ON = { bg: 'rgba(224,185,79,.18)', fg: 'var(--gold-ink)', bd: 'var(--gold-ink)' }
export const OFF = { bg: 'transparent', fg: 'var(--ink)', bd: 'var(--line-18)' }

// ---------------------------------------------------------------- the intent bar

export interface IntentOption {
  label: string
  meta: string
  value: string
}

export function useIntentOptions(properties: Property[], liveDestinations: Destination[], f: Filters) {
  return useMemo(() => {
    const destOptions: IntentOption[] = ['Anywhere', ...liveDestinations.map((d) => d.name)].map((d) => ({
      label: d,
      value: d,
      meta: d === 'Anywhere' ? `${properties.length} properties` : `${properties.filter((r) => r.dest === d).length} properties`,
    }))
    // A package type nobody sells is not offered: an empty filter is a dead end wearing a label.
    const pkgOptions: IntentOption[] = ['Any type', ...PKGS.filter((p) => properties.some((r) => r.pkg === p))].map((p) => ({
      label: p,
      value: p,
      meta: p === 'Any type' ? '' : `${properties.filter((r) => r.pkg === p).length} properties`,
    }))
    const themeOptions: IntentOption[] = THEMES.map((t) => ({ label: t, value: t, meta: '' }))
    const monthOptions: IntentOption[] = ['Any month', ...MONTHS.map((m) => m.slice(0, 3))].map((m, i) => ({
      label: m,
      value: i === 0 ? 'Any month' : MONTHS[i - 1],
      meta: '',
    }))
    const themesLabel = f.themes.length ? f.themes.join(', ') : 'Any experience'
    const sheetSummary = [
      f.dest !== 'Anywhere' ? f.dest : 'Anywhere',
      f.month !== 'Any month' ? f.month : 'any month',
      f.themes.length ? f.themes.join(' · ') : 'any experience',
    ].join(' · ')
    return { destOptions, pkgOptions, themeOptions, monthOptions, themesLabel, sheetSummary }
  }, [properties, liveDestinations, f])
}

// ---------------------------------------------------------------- the Selection carousel

export interface SelectionCard {
  id: string
  resort: Property
  dep: Offer | null
  dest: string
  name: string
  area: string
  tier: string
  nights: number
  transferShort: string
  photoHint?: string
  img: string
  pos?: string
  credit?: string
  creditHref?: string
  /** The package type, or the offer's own line. Never a money figure — rates are on request. */
  priceLabel: string
  /** The collection name, or the offer's badge. */
  price: string
  /** The departure label, on the Offers tab only. */
  dateLabel: string | null
  saved: boolean
}

export function useSelection(bundle: SiteBundle, applied: Filters, tab: 'insp' | 'dep', saved: string[]) {
  return useMemo(() => {
    const properties = bundle.properties
    const insp = properties.filter((r) => match(r, applied))
    const deps = bundle.offers
      .map((d) => ({ dep: d, r: properties.find((r) => r.id === d.resort) }))
      .filter((x): x is { dep: Offer; r: Property } => !!x.r && match(x.r, applied, x.dep.month))

    const cards: SelectionCard[] =
      tab === 'insp'
        ? insp.map((r) => ({
            id: r.id,
            resort: r,
            dep: null,
            dest: r.dest,
            name: r.name,
            area: r.area,
            tier: r.tier,
            nights: r.nights,
            transferShort: r.transferShort,
            photoHint: r.photoHint,
            img: r.img,
            pos: (r as Property & { pos?: string }).pos,
            credit: r.credit,
            creditHref: r.creditHref,
            priceLabel: r.pkg,
            price: r.tier,
            dateLabel: null,
            saved: saved.includes(r.id),
          }))
        : deps.map(({ dep, r }) => ({
            id: dep.id,
            resort: r,
            dep,
            dest: r.dest,
            name: r.name,
            area: r.area,
            tier: r.tier,
            nights: r.nights,
            transferShort: r.transferShort,
            photoHint: r.photoHint,
            img: dep.img || r.img,
            pos: (r as Property & { pos?: string }).pos,
            credit: r.credit,
            creditHref: r.creditHref,
            priceLabel: 'Offer · availability on request',
            price: dep.badge || 'On request',
            dateLabel: dep.label,
            saved: saved.includes(r.id),
          }))

    const hasActiveFilters =
      applied.dest !== 'Anywhere' || applied.pkg !== 'Any type' || applied.themes.length > 0 || applied.nights !== 14 || applied.month !== 'Any month'

    const total = cards.length
    const resultLine =
      total === 0
        ? 'No exact matches'
        : hasActiveFilters
          ? `${total} ${tab === 'insp' ? 'journeys' : 'departures'} match your filters`
          : tab === 'insp'
            ? `${total} hand-picked journeys`
            : `${total} offers · availability on request`

    return { cards, total, hasActiveFilters, resultLine }
  }, [bundle, applied, tab, saved])
}

// ---------------------------------------------------------------- offers

export interface OfferCard {
  id: string
  offer: Offer
  resort: Property
  badge: string
  title: string
  dest: string
  date: string
  perk: string
  price: string
  was: string
  img: string
}

export function useOffers(bundle: SiteBundle, offerDest: string, currency: 'USD' | 'EUR', destFilter?: string) {
  return useMemo(() => {
    const rows: OfferCard[] = []
    for (const o of bundle.offers) {
      const r = bundle.properties.find((p) => p.id === o.resort)
      if (!r) continue
      if (destFilter && r.dest !== destFilter) continue
      if (!destFilter && offerDest !== 'All' && r.dest !== offerDest) continue
      const price = o.from ? 'From ' + formatMoney(o.from, currency) : o.off ? 'Save ' + Math.round(o.off * 100) + '%' : 'On request'
      // The struck-through figure is derived from the discount, never stored: a "was" price that
      // does not follow the offer it sits on is a claim nobody can check.
      const was = o.from && o.off ? formatMoney(Math.round(o.from / (1 - o.off)), currency) : ''
      rows.push({
        id: o.id,
        offer: o,
        resort: r,
        badge: o.badge || o.label,
        title: o.title || r.name,
        dest: r.dest,
        date: o.date,
        perk: o.perk,
        price,
        was,
        img: o.img || r.img,
      })
    }
    return rows
  }, [bundle, offerDest, currency, destFilter])
}

// ---------------------------------------------------------------- the Properties grid

export interface PropertyCard {
  id: string
  resort: Property
  name: string
  dest: string
  area: string
  tier: string
  pkg: string
  transfer: string
  img: string
  pos?: string
  blurb: string
  villaList: string
  roomCount: string
  tags: string[]
  noImg: boolean
  credit?: string
  creditHref?: string
  photoHint?: string
  saved: boolean
}

export interface FilterGroup {
  name: string
  facet: 'tier' | 'theme' | 'transfer' | 'room'
  chips: { label: string; value: string; count: number }[]
}

const toCard = (r: Property, saved: string[]): PropertyCard => ({
  id: r.id,
  resort: r,
  name: r.name,
  dest: r.dest,
  area: r.area,
  tier: r.tier,
  pkg: r.pkg,
  transfer: r.transferShort,
  img: r.img,
  pos: (r as Property & { pos?: string }).pos,
  // The card carries the first sentence of the verdict: enough to choose by, and it never runs on.
  blurb: (r.verdict || '').split(/(?<=[.!?])\s/)[0] || '',
  villaList: (r.villas || []).map((v) => v[0]).join(' · '),
  roomCount: (r.villas || []).length ? `${r.villas.length} room type${r.villas.length === 1 ? '' : 's'}` : '',
  tags: (r.tags || []).slice(0, 3),
  noImg: !r.img,
  credit: r.credit,
  creditHref: r.creditHref,
  photoHint: r.photoHint,
  saved: saved.includes(r.id),
})

export function useProperties(
  bundle: SiteBundle,
  propDest: string,
  pf: PropertyFilters,
  saved: string[],
  cat: string = 'All',
  qz: QuizAnswers = {},
) {
  return useMemo(() => {
    const pool = sortForGrid(
      bundle.properties.filter((r) => propDest === 'All' || r.dest === propDest),
      TIERS,
    )
    // A group with one chip is not a filter, it is a label — the prototype hides it and so does this.
    const groups: FilterGroup[] = ([
      {
        name: 'Collection',
        facet: 'tier',
        chips: TIERS.filter((t) => pool.some((r) => r.tier === t)).map((t) => ({ label: t, value: t, count: pool.filter((r) => r.tier === t).length })),
      },
      {
        name: 'Style',
        facet: 'theme',
        chips: THEMES.filter((t) => pool.some((r) => r.themes.includes(t))).map((t) => ({
          label: t,
          value: t,
          count: pool.filter((r) => r.themes.includes(t)).length,
        })),
      },
      {
        name: 'Transfer',
        facet: 'transfer',
        chips: ['Speedboat', 'Seaplane']
          .filter((t) => pool.some((r) => transferKind(r) === t))
          .map((t) => ({ label: t, value: t, count: pool.filter((r) => transferKind(r) === t).length })),
      },
      {
        name: 'Rooms',
        facet: 'room',
        chips: ['Overwater', 'Beach', 'Private pool', 'Family']
          .filter((t) => pool.some((r) => roomKinds(r).includes(t)))
          .map((t) => ({ label: t, value: t, count: pool.filter((r) => roomKinds(r).includes(t)).length })),
      },
      {
        name: 'Atoll',
        facet: 'atoll',
        // Whichever atolls the catalogue actually holds, in the order it holds them — the
        // alternative is a list of every atoll in the country with nothing behind most of them.
        chips: [...new Set(pool.map(atollOf))].filter(Boolean).map((t) => ({
          label: `${t} Atoll`,
          value: t,
          count: pool.filter((r) => atollOf(r) === t).length,
        })),
      },
      {
        name: 'Brand',
        facet: 'brand',
        // A group with one island is not a brand filter, it is that island's name twice.
        chips: [...new Set(pool.map(brandOf))]
          .filter((b) => b && pool.filter((r) => brandOf(r) === b).length > 1)
          .map((b) => ({ label: b, value: b, count: pool.filter((r) => brandOf(r) === b).length })),
      },
    ] as FilterGroup[]).filter((g) => g.chips.length > 1)

    // Category, then Refine, then the quiz's ORDER. The quiz never removes an island — see
    // `quizScore` — so the count under the grid is the same whether or not a guest has answered.
    const category = CATEGORIES.find(([n]) => n === cat) || CATEGORIES[0]
    const test = category[1]
    const kept = pool.filter((r) => matchRefine(r, pf)).filter((r) => !test || test(r, bundle.offers))
    const answered = Object.values(qz).filter(Boolean).length
    const ranked = answered ? [...kept].sort((a, b) => quizScore(b, qz) - quizScore(a, qz)) : kept
    const cards = ranked.map((r) => toCard(r, saved))

    const cats = CATEGORIES.filter(([, f]) => !f || pool.some((r) => f(r, bundle.offers))).map(([label]) => label)

    const active = Object.values(pf).filter(Boolean) as string[]
    return {
      pool,
      groups,
      cards,
      cats,
      answered,
      hasPf: active.length > 0,
      // The group names actually drawn, rather than a sentence listing them: adding a facet used to
      // mean editing this string too, and the version that shipped with Atoll and Brand in it was
      // long enough to be ellipsised at the first comma on a phone.
      summary: active.length ? active.join(' · ') : groups.map((g) => g.name).join(' · '),
    }
  }, [bundle, propDest, pf, saved, cat, qz])
}

/** The destination page's own grid: the same refine panel over one destination's properties. */
export function useDestinationProperties(bundle: SiteBundle, dest: string | null, destTheme: string | null, pf: PropertyFilters, saved: string[]) {
  return useMemo(() => {
    if (!dest) return { all: [], cards: [], themes: [] as { label: string; count: number; img: string }[] }
    const all = bundle.properties.filter((r) => r.dest === dest)
    const cards = all
      .filter((r) => !destTheme || r.themes.includes(destTheme))
      .filter((r) => matchRefine(r, pf))
      .map((r) => toCard(r, saved))
    const themes = THEMES.filter((t) => all.some((r) => r.themes.includes(t))).map((t) => ({
      label: t,
      count: all.filter((r) => r.themes.includes(t)).length,
      img: '',
    }))
    return { all, cards, themes }
  }, [bundle, dest, destTheme, pf, saved])
}

// ---------------------------------------------------------------- the collection tiers

export function useTiers(properties: Property[]) {
  return useMemo(
    () =>
      TIERS.map((name) => {
        const n = properties.filter((r) => r.tier === name).length
        return { name, desc: TIER_BLURB[name] || '', from: `${n}${n === 1 ? ' property' : ' properties'} · rates on request`, count: n }
      }),
    [properties],
  )
}

// ---------------------------------------------------------------- the destination index

export function useDestinationRows(destinations: Destination[], properties: Property[], hover: string | null) {
  return useMemo(() => {
    const live = destinations.filter((d) => d.live !== false)
    const hovered = hover || live[0]?.name || ''
    return live.map((d, i) => ({
      num: '0' + (i + 1),
      name: d.name,
      count: properties.filter((r) => r.dest === d.name).length,
      tagline: d.tagline || '',
      img: d.card,
      on: hovered === d.name,
    }))
  }, [destinations, properties, hover])
}

export function useThemeTiles(properties: Property[], homepageThemeImages: [string, string][], appliedThemes: string[]) {
  return useMemo(() => {
    const images = new Map(homepageThemeImages || [])
    return THEMES.map((t) => ({
      label: t,
      count: properties.filter((r) => r.themes.includes(t)).length,
      img: images.get(t) || '',
      active: appliedThemes.includes(t),
    }))
  }, [properties, homepageThemeImages, appliedThemes])
}
