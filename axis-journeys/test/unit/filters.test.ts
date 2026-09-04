/**
 * The filter functions, which the intent bar, the Selection carousel, the Properties grid, the
 * destination page and the server-rendered first paint all read.
 *
 * The property under test throughout is agreement: the toast says "N journeys match" from
 * `countMatches`, and the grid draws `match` — so a case where those two disagree is a number on
 * screen that the screen itself contradicts.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  DEFAULT_FILTERS,
  QUICK_PATHS,
  availableQuickPaths,
  filtersFromQuery,
  filtersToQuery,
  EUR_RATE,
  countMatches,
  formatMoney,
  formatMoneyAlt,
  isDefaultFilters,
  match,
  matchRefine,
  roomKinds,
  sortForGrid,
  transferKind,
  type Filters,
} from '@/lib/content/filters'
import type { Offer, Property } from '@/lib/content/types'
import { seed } from '@/lib/content/seed'

const prop = (over: Partial<Property> = {}): Property =>
  ({
    id: 'baros',
    name: 'Baros Maldives',
    dest: 'Maldives',
    pkg: 'Overwater Villa',
    tier: 'Luxury Collection',
    themes: ['Honeymoon', 'Diving'],
    nights: 7,
    months: [1, 2, 3],
    transferShort: 'Speedboat · 25 min',
    img: 'hero.jpg',
    villas: [['Water Villa with Pool', '90 sqm', 0]],
    ...over,
  }) as Property

const filters = (over: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...over })

describe('match', () => {
  it('the default filters match everything', () => {
    assert.equal(match(prop(), DEFAULT_FILTERS), true)
    assert.equal(match(prop({ dest: 'Sri Lanka', nights: 14, months: [] }), DEFAULT_FILTERS), true)
  })

  it('destination and package are exact', () => {
    assert.equal(match(prop(), filters({ dest: 'Maldives' })), true)
    assert.equal(match(prop(), filters({ dest: 'Sri Lanka' })), false)
    assert.equal(match(prop(), filters({ pkg: 'Overwater Villa' })), true)
    assert.equal(match(prop(), filters({ pkg: 'Beach Villa' })), false)
  })

  it('themes are ANDed, not ORed — every chosen theme must be present', () => {
    assert.equal(match(prop(), filters({ themes: ['Honeymoon'] })), true)
    assert.equal(match(prop(), filters({ themes: ['Honeymoon', 'Diving'] })), true)
    assert.equal(match(prop(), filters({ themes: ['Honeymoon', 'Surfing'] })), false)
  })

  it('the duration slider is a ceiling: a property needing more nights drops out', () => {
    assert.equal(match(prop({ nights: 7 }), filters({ nights: 7 })), true)
    assert.equal(match(prop({ nights: 7 }), filters({ nights: 6 })), false)
    assert.equal(match(prop({ nights: 3 }), filters({ nights: 14 })), true)
  })

  it('a month matches the property’s own season list', () => {
    assert.equal(match(prop({ months: [1, 2] }), filters({ month: 'January' })), true)
    assert.equal(match(prop({ months: [1, 2] }), filters({ month: 'March' })), false)
    assert.equal(match(prop({ months: [12] }), filters({ month: 'December' })), true)
  })

  it('a departure overrides the season list, and 0 means any month', () => {
    // The offer's own month is the answer for a departure card: the resort may be seasonal, the
    // departure is a date.
    const seasonal = prop({ months: [1] })
    assert.equal(match(seasonal, filters({ month: 'July' }), 7), true)
    assert.equal(match(seasonal, filters({ month: 'July' }), 8), false)
    assert.equal(match(seasonal, filters({ month: 'July' }), 0), true)
  })

  it('an unknown month name matches nothing rather than everything', () => {
    assert.equal(match(prop({ months: [1] }), filters({ month: 'Smarch' })), false)
  })
})

describe('isDefaultFilters', () => {
  it('is true only when every facet is untouched', () => {
    assert.equal(isDefaultFilters(DEFAULT_FILTERS), true)
    assert.equal(isDefaultFilters(filters({ themes: ['Diving'] })), false)
    assert.equal(isDefaultFilters(filters({ nights: 13 })), false)
    assert.equal(isDefaultFilters(filters({ month: 'May' })), false)
  })
})

describe('countMatches', () => {
  const properties = [
    prop({ id: 'a', nights: 5, themes: ['Honeymoon'] }),
    prop({ id: 'b', nights: 10, themes: ['Family'] }),
    prop({ id: 'c', nights: 7, themes: ['Honeymoon', 'Family'] }),
  ]
  const offers = [
    { resort: 'a', month: 5 },
    { resort: 'b', month: 0 },
    { resort: 'gone', month: 5 },
  ] as Offer[]

  it('the inspiration tab counts properties', () => {
    assert.equal(countMatches(properties, offers, DEFAULT_FILTERS, 'insp'), 3)
    assert.equal(countMatches(properties, offers, filters({ themes: ['Honeymoon'] }), 'insp'), 2)
    assert.equal(countMatches(properties, offers, filters({ nights: 6 }), 'insp'), 1)
  })

  it('the departures tab counts offers, and an offer whose property is gone counts nothing', () => {
    assert.equal(countMatches(properties, offers, DEFAULT_FILTERS, 'dep'), 2)
  })

  it('a departure is counted against its own month', () => {
    // Offer `a` departs in May; offer `b` is valid in any month.
    assert.equal(countMatches(properties, offers, filters({ month: 'May' }), 'dep'), 2)
    assert.equal(countMatches(properties, offers, filters({ month: 'June' }), 'dep'), 1)
  })

  it('agrees with match(), which is what makes the toast and the grid say the same thing', () => {
    for (const f of [DEFAULT_FILTERS, filters({ themes: ['Family'] }), filters({ nights: 7 }), filters({ month: 'January' })]) {
      assert.equal(countMatches(properties, offers, f, 'insp'), properties.filter((p) => match(p, f)).length)
    }
  })
})

describe('roomKinds', () => {
  it('reads the villa names, in the prototype’s own vocabulary', () => {
    assert.deepEqual(roomKinds(prop({ villas: [['Water Villa with Pool', '', 0]] })), ['Overwater', 'Private pool'])
    assert.deepEqual(roomKinds(prop({ villas: [['Beach Villa', '', 0]] })), ['Beach'])
    assert.deepEqual(roomKinds(prop({ villas: [['Two Bedroom Residence', '', 0]] })), ['Family'])
  })

  it('is case-insensitive and reads every villa on the property', () => {
    assert.deepEqual(roomKinds(prop({ villas: [['BEACH BUNGALOW', '', 0], ['Family Suite', '', 0]] })), ['Beach', 'Family'])
  })

  it('a property with no rooms claims no room kinds', () => {
    assert.deepEqual(roomKinds(prop({ villas: [] })), [])
  })
})

describe('transferKind', () => {
  it('is the first word of the transfer summary', () => {
    assert.equal(transferKind(prop({ transferShort: 'Speedboat · 45 min' })), 'Speedboat')
    assert.equal(transferKind(prop({ transferShort: 'Seaplane · 30 min' })), 'Seaplane')
  })

  it('an unset summary yields no kind rather than a stray token', () => {
    assert.equal(transferKind(prop({ transferShort: '' })), '')
  })
})

describe('matchRefine', () => {
  const p = prop({ tier: 'Luxury Collection', themes: ['Diving'], transferShort: 'Seaplane · 30 min', villas: [['Beach Villa', '', 0]] })

  it('an empty panel matches everything', () => {
    assert.equal(matchRefine(p, {}), true)
  })

  it('each group is exact, and every group is ANDed', () => {
    assert.equal(matchRefine(p, { tier: 'Luxury Collection', theme: 'Diving', transfer: 'Seaplane', room: 'Beach' }), true)
    assert.equal(matchRefine(p, { tier: 'Luxury Collection', theme: 'Surfing' }), false)
    assert.equal(matchRefine(p, { transfer: 'Speedboat' }), false)
    assert.equal(matchRefine(p, { room: 'Overwater' }), false)
  })
})

describe('sortForGrid', () => {
  const tiers = ['Ultra-Luxury Collection', 'Luxury Collection', 'Five-Star Escapes']

  it('photographed properties lead, then collection order', () => {
    const list = [
      prop({ id: 'no-photo', img: '', tier: 'Ultra-Luxury Collection' }),
      prop({ id: 'five-star', tier: 'Five-Star Escapes' }),
      prop({ id: 'ultra', tier: 'Ultra-Luxury Collection' }),
    ]
    assert.deepEqual(sortForGrid(list, tiers).map((p) => p.id), ['ultra', 'five-star', 'no-photo'])
  })

  it('does not mutate the list it was handed', () => {
    const list = [prop({ id: 'b', tier: 'Five-Star Escapes' }), prop({ id: 'a', tier: 'Ultra-Luxury Collection' })]
    sortForGrid(list, tiers)
    assert.deepEqual(list.map((p) => p.id), ['b', 'a'])
  })
})

describe('formatMoney', () => {
  it('USD is the book currency and prints exactly', () => {
    assert.equal(formatMoney(1250, 'USD'), '$1,250')
    assert.equal(formatMoney(985, 'USD'), '$985')
  })

  it('EUR is converted and rounded to ten, as the prototype does', () => {
    assert.equal(formatMoney(1000, 'EUR'), '€920')
    assert.equal(formatMoney(1250, 'EUR'), '€1,150')
    assert.equal(EUR_RATE, 0.92)
  })

  it('the alternate line shows the other currency', () => {
    assert.equal(formatMoneyAlt(1000, 'USD'), '€920')
    assert.equal(formatMoneyAlt(1000, 'EUR'), '$1,000')
  })
})

describe('the curated quick paths', () => {
  it('are four real journeys, each of which narrows something', () => {
    assert.equal(QUICK_PATHS.length, 4)
    for (const q of QUICK_PATHS) {
      assert.ok(q.label.trim().length > 4, `${q.label} is not a label`)
      assert.ok(Object.keys(q.apply).length > 0, `${q.label} filters nothing`)
    }
  })

  it('only the ones this catalogue can answer are offered', () => {
    // A curated entry that lands on "No exact match — try widening" reads as a broken site. The
    // shipped list contains one that does: nothing in the catalogue is classified as an Overwater
    // Villa. The menu declines to draw it rather than the list being quietly rewritten.
    const live = seed.properties.filter((p) => !p.draft && !p.detailPending)
    const offered = availableQuickPaths(live, seed.offers)
    for (const q of offered) {
      assert.ok(countMatches(live, seed.offers, { ...DEFAULT_FILTERS, ...q.apply }, 'insp') > 0, `"${q.label}" matches nothing`)
    }
    assert.ok(offered.length < QUICK_PATHS.length, 'the content gap this guards has been filled — good, and this test should be reconsidered')
    assert.equal(offered.some((q) => q.apply.pkg === 'Overwater Villa'), false)
  })

  it('falls back to the whole list rather than drawing an empty column', () => {
    assert.deepEqual(availableQuickPaths([], []), QUICK_PATHS)
  })
})

describe('a filter set in the address', () => {
  it('round-trips everything that is not a default', () => {
    const f = { dest: 'Maldives', pkg: 'Overwater Villa', themes: ['Honeymoon', 'Diving'], nights: 7, month: 'August' }
    const back = filtersFromQuery(new URLSearchParams(filtersToQuery(f)))
    assert.deepEqual(back, f)
  })

  it('writes nothing for a default, so a plain link stays plain', () => {
    assert.equal(filtersToQuery(DEFAULT_FILTERS), '')
    assert.deepEqual(filtersFromQuery(new URLSearchParams('')), {})
  })

  it('carries a quick path across a navigation', () => {
    for (const q of QUICK_PATHS) {
      const back = filtersFromQuery(new URLSearchParams(filtersToQuery({ ...DEFAULT_FILTERS, ...q.apply })))
      for (const [k, v] of Object.entries(q.apply)) assert.deepEqual(back[k as keyof typeof back], v, `${q.label} lost ${k}`)
    }
  })

  it('bounds what it reads, because anybody can compose an address', () => {
    const hostile = new URLSearchParams()
    hostile.set('dest', '<script>alert(1)</script>' + 'x'.repeat(200))
    hostile.set('themes', new Array(40).fill('Honeymoon').join(','))
    hostile.set('nights', '9999')
    const out = filtersFromQuery(hostile)
    assert.equal(out.dest!.length <= 40, true, 'an unbounded string reached the intent bar')
    assert.equal(/[<>]/.test(out.dest!), false, 'angle brackets were kept')
    assert.equal(out.themes!.length, 8, 'the theme list is unbounded')
    assert.equal(out.nights, undefined, 'a duration outside the slider was accepted')
  })

  it('drops a value that is only whitespace or control characters', () => {
    const p = new URLSearchParams()
    p.set('pkg', '   ')
    p.set('month', '\u0000\u001F')
    assert.deepEqual(filtersFromQuery(p), {})
  })
})
