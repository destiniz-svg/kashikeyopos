/**
 * The property page's derivations, and the home page's.
 *
 * The property under test throughout is the one this page rests on: every soft judgement has a
 * derivation AND an override, and where neither can answer the page says so rather than printing
 * a plausible number. A test that only checked the happy path would let the fallbacks rot, and the
 * fallbacks are what a property created this morning is rendered from.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { propertyPage, readGeo, PP_SECTIONS } from '@/lib/content/property-page'
import { atollCards, brandChips, comparison, homeStats, GUIDES, HOME_FAQ } from '@/lib/content/home'
import { atollOf, brandOf, CATEGORIES, QUIZ, quizScore } from '@/lib/content/filters'
import type { Offer, Property, SiteBundle } from '@/lib/content/types'

const prop = (over: Partial<Property> = {}): Property =>
  ({
    id: 'baros',
    name: 'Baros Maldives',
    dest: 'Maldives',
    area: 'North Malé Atoll',
    pkg: 'Overwater Villa',
    tier: 'Luxury Collection',
    themes: ['Honeymoon', 'Diving'],
    nights: 5,
    months: [1],
    transferShort: 'Speedboat · 25 min',
    img: 'hero.jpg',
    board: 'half board · full board on request',
    reef: 'Exceptional house reef straight off the beach',
    verdict: 'The most romantic island near Malé. Small, polished and adult in feel.',
    love: 'The reef starts at the beach. Dinner on the sandbank. Service that remembers your name.',
    villas: [
      ['Deluxe Villa', '96 sqm · beach', 0, 'deluxe.jpg'],
      ['Water Villa', '120 sqm · overwater', 900, 'water.jpg'],
      ['Water Pool Villa', '160 sqm · overwater', 2400, 'pool.jpg'],
    ],
    transfers: [['Speedboat', '25 minutes, any arrival time', 300]],
    ...over,
  }) as Property

const bundleOf = (properties: Property[], offers: Offer[] = []): SiteBundle =>
  ({ properties, offers, destinations: [], settings: {}, homepage: {}, generatedAt: 0 }) as unknown as SiteBundle

const offer = (over: Partial<Offer> = {}): Offer =>
  ({ id: 'o1', resort: 'baros', badge: 'Offer', date: 'March', month: 3, label: 'March', seats: '2', perk: '', off: 0, from: 4200, ...over }) as Offer

const view = (p = prop(), offers: Offer[] = []) => propertyPage(p, bundleOf([p], offers), 'USD', '9715550000')

describe('where the island is', () => {
  it('reads the pair the seed writes and the one-row list the CMS writes', () => {
    assert.deepEqual(readGeo([4.28, 73.43]), { at: [4.28, 73.43], known: true })
    assert.deepEqual(readGeo([[4.28, 73.43]]), { at: [4.28, 73.43], known: true })
    // The CMS list editor hands back strings; a coordinate typed into a text box is still a number.
    assert.deepEqual(readGeo([['4.28', '73.43']]), { at: [4.28, 73.43], known: true })
  })

  it('an unset or unreadable coordinate is NOT a pin somewhere plausible', () => {
    for (const bad of [undefined, null, [], ['x', 'y'], [4.28], 'somewhere']) {
      assert.equal(readGeo(bad).known, false, `${JSON.stringify(bad)} was read as a coordinate`)
    }
    // The page says so in words rather than measuring a distance from a guess.
    assert.equal(view(prop({ geo: undefined })).map.km, 'Distance from Malé on request')
    assert.match(view(prop({ geo: [4.28, 73.43] })).map.km, /^\d+ km from Malé$/)
  })

  it('the map coordinates are percentages the diagram can place', () => {
    const m = view(prop({ geo: [4.28, 73.43] })).map
    for (const v of [m.x, m.y, m.maleX, m.maleY]) {
      const n = Number(v.replace('%', ''))
      assert.ok(Number.isFinite(n) && n >= 0 && n <= 100, `${v} is off the diagram`)
    }
  })
})

describe('what the package carries', () => {
  it('derives the three lines every package has, and labels an exclusive as one', () => {
    const v = view(prop({ exclusives: ['One sandbank dinner for two'] }))
    assert.deepEqual(
      v.included.filter((x) => !x.exclusive).map((x) => x.text),
      ['5 nights in a Deluxe Villa', 'Round-trip speedboat transfers · 25 minutes, any arrival time', 'Half board meal plan'],
    )
    assert.deepEqual(v.included.filter((x) => x.exclusive).map((x) => x.text), ['One sandbank dinner for two'])
  })

  it('a property with no exclusives still has a package, not an empty box', () => {
    assert.ok(view().included.length >= 3)
  })
})

describe('the villa tabs', () => {
  it('three or more rooms become entry, mid and top; fewer keep their own names', () => {
    assert.deepEqual(view().tabs.map((t) => t.label), ['Entry', 'Mid-tier', 'Premium'])
    const two = view(prop({ villas: [['Beach Villa', '90 sqm', 0], ['Water Villa', '110 sqm', 500]] as Property['villas'] }))
    assert.deepEqual(two.tabs.map((t) => t.label), ['Beach Villa', 'Water Villa'])
  })

  it('the entry tab is included and an upgrade names its supplement', () => {
    assert.equal(view().villaAt(0).upgrade, 'Included in the entry package')
    assert.match(view().villaAt(2).upgrade, /Upgrade for \+ \$2,400/)
  })

  it('a room with no supplement on file says it is quoted rather than showing + $0', () => {
    const p = prop({ villas: [['A', '1', 0], ['B', '2', 0], ['C', '3', 0]] as Property['villas'] })
    assert.equal(view(p).villaAt(1).upgrade, 'Upgrade quoted by your specialist')
  })

  it('the room shows its OWN photographs first, then the island gallery', () => {
    const p = prop({
      villas: [['Deluxe Villa', '96 sqm', 0, 'lead.jpg', 'desc', [], '50% 50%', ['room-a.jpg', 'room-b.jpg']]] as Property['villas'],
      gallery: [{ img: 'island-1.jpg', cap: '' }],
    })
    assert.deepEqual(view(p).villaAt(0).imgs.map((i) => i.img), ['lead.jpg', 'room-a.jpg', 'room-b.jpg', 'island-1.jpg'])
  })
})

describe('the five scales', () => {
  it('are derived from the profile and land inside the track', () => {
    for (const s of view().scales) {
      const n = Number(s.pos.replace('%', ''))
      assert.ok(n >= 10 && n <= 92, `${s.lo}/${s.hi} sits at ${s.pos}`)
    }
  })

  it('a specialist who disagrees with the reading overrides it', () => {
    const v = view(prop({ scales: [['Quiet', 'Busy', 66]] }))
    assert.deepEqual(v.scales, [{ lo: 'Quiet', hi: 'Busy', pos: '66%' }])
  })

  it('the tier decides the budget scale, so two tiers do not read alike', () => {
    const a = view(prop({ tier: 'Premium Resorts' })).scales[0].pos
    const b = view(prop({ tier: 'Ultra-Luxury Collection' })).scales[0].pos
    assert.notEqual(a, b)
  })
})

describe('pricing across the year', () => {
  it('is labelled a guide where it is derived, and is not where a specialist set it', () => {
    assert.equal(view().pricingIsGuide, true)
    assert.equal(view(prop({ pricing: [['Jan', 5000, 6000]] })).pricingIsGuide, false)
  })

  it('a derived table is built from a live offer where there is one', () => {
    const withOffer = view(prop(), [offer({ from: 4200 })])
    // The first window is the base, so it is the offer's own figure rather than a tier average.
    assert.equal(withOffer.pricing[0].entry, '$4,200')
    assert.equal(withOffer.hasPrice, true)
    assert.equal(view().hasPrice, false, 'a property with no live offer must not claim a price')
  })

  it('an override is printed as given', () => {
    const v = view(prop({ pricing: [['11 Jan – 9 Apr 2027', 7180, 7707]] }))
    assert.deepEqual(v.pricing.map((r) => [r.window, r.entry, r.mid]), [['11 Jan – 9 Apr 2027', '$7,180', '$7,707']])
  })
})

describe('who it is for', () => {
  it('reads the themes where nobody has written it, and the override where somebody has', () => {
    assert.ok(view().ideal.some((t) => /Honeymooners/.test(t)))
    assert.deepEqual(view(prop({ idealFor: ['Divers only'] })).ideal, ['Divers only'])
    assert.deepEqual(view(prop({ notFor: ['Anybody in a hurry'] })).notFor, ['Anybody in a hurry'])
  })

  it('always says who should look elsewhere — the section is the point of the page', () => {
    assert.ok(view().notFor.length >= 3)
  })
})

describe('the rest of the page', () => {
  it('marine life is read from the profile and can be overridden', () => {
    assert.deepEqual(view(prop({ marine: ['Nurse sharks'] })).marine, ['Nurse sharks'])
    assert.deepEqual(view(prop({ reef: 'Turtles and reef sharks daily' })).marine, ['Reef sharks', 'Sea turtles'])
  })

  it('names an animal only where somebody wrote about the animal', () => {
    // The word "reef" is in every reef description this catalogue holds, and matching on it made
    // all nine published islands claim reef sharks. Measured before the species table existed.
    assert.deepEqual(view(prop({ reef: 'Exceptional · steps from the beach', love: '', about: '' })).marine, [])
    assert.deepEqual(view(prop({ reef: 'Good · whale sharks nearby', love: '', about: '' })).marine, ['Whale sharks'])
  })

  it('similar islands never include the island you are on', () => {
    const a = prop()
    const b = prop({ id: 'soneva', name: 'Soneva Fushi' })
    const v = propertyPage(a, bundleOf([a, b]), 'USD', '9715550000')
    assert.deepEqual(v.similar.map((x) => x.id), ['soneva'])
  })

  it('the sticky nav is seven numbered rungs, and each names a section on the page', () => {
    assert.deepEqual(PP_SECTIONS.map((s) => s.n), ['01', '02', '03', '04', '05', '06', '07'])
    assert.deepEqual(PP_SECTIONS.map((s) => s.id).filter((id) => id.startsWith('pp-')).length, 7)
  })

  it('the reef reads as an ask rather than an em dash where there is none', () => {
    assert.equal(view(prop({ reef: '—' })).reef, 'Ask your specialist')
  })
})

describe('the atoll and the brand a property belongs to', () => {
  it('the atoll is read from the area line', () => {
    assert.equal(atollOf(prop({ area: 'Baa Atoll · Kunfunadhoo Island' })), 'Baa')
    assert.equal(atollOf(prop({ area: 'South Malé Atoll · three islands' })), 'South Malé')
    assert.equal(atollOf(prop({ area: '' })), 'Maldives')
  })

  it('the brand is the field where set, and the name where not', () => {
    assert.equal(brandOf(prop({ brand: 'Conrad · Hilton' })), 'Conrad')
    assert.equal(brandOf(prop({ name: 'Conrad Maldives Rangali Island' })), 'Conrad')
    assert.equal(brandOf(prop({ name: 'Kandolhu Maldives' })), 'Kandolhu')
  })
})

describe('the matchmaker', () => {
  const reefy = prop({ id: 'reefy', reef: 'Exceptional house reef', transferShort: 'Seaplane · 40 min', themes: ['Diving'] })
  const familyIsland = prop({ id: 'fam', reef: 'Sandy lagoon', themes: ['Family'], villas: [['Family Villa', '2 bed', 0]] as Property['villas'] })

  it('scores what the profile actually says', () => {
    assert.ok(quizScore(reefy, { 0: 'reef' }) > quizScore(familyIsland, { 0: 'reef' }))
    assert.ok(quizScore(familyIsland, { 1: 'family' }) > quizScore(reefy, { 1: 'family' }))
  })

  it('an unanswered quiz scores everything the same, so it can only ever re-order', () => {
    assert.equal(quizScore(reefy, {}), 0)
    assert.equal(quizScore(familyIsland, {}), 0)
  })

  it('has four questions and every option carries a value and a label', () => {
    assert.equal(QUIZ.length, 4)
    for (const [q, options] of QUIZ) {
      assert.ok(q.endsWith('?'), `${q} is not a question`)
      for (const [value, label] of options) assert.ok(value && label, `${q} has an unlabelled option`)
    }
  })
})

describe('the category quick-filters', () => {
  it('every one of them is a predicate over a field somebody fills in', () => {
    assert.equal(CATEGORIES[0][0], 'All')
    assert.equal(CATEGORIES[0][1], null, 'All must not filter')
    const reefy = prop({ reef: 'Exceptional house reef' })
    const test = (name: string) => CATEGORIES.find(([n]) => n === name)![1]!
    assert.equal(test('Best reefs')(reefy, []), true)
    assert.equal(test('Best reefs')(prop({ reef: 'Sandy lagoon' }), []), false)
    assert.equal(test('Quick transfer')(prop({ transferShort: 'Speedboat · 25 min' }), []), true)
    assert.equal(test('Remote')(prop({ transferShort: 'Speedboat · 25 min' }), []), false)
    assert.equal(test('Live offers')(prop(), [offer()]), true)
    assert.equal(test('Live offers')(prop(), [offer({ from: undefined })]), false)
  })
})

describe('the home page derivations', () => {
  const at = (id: string, area: string) => prop({ id, name: id, area, img: `${id}.jpg` })

  it('the atoll rail is the four busiest, largest first', () => {
    const list = [
      at('a', 'Baa Atoll'),
      at('b', 'Baa Atoll'),
      at('c', 'North Malé Atoll'),
      at('d', 'Raa Atoll'),
      at('e', 'Noonu Atoll'),
      at('f', 'Lhaviyani Atoll'),
    ]
    const cards = atollCards(list)
    assert.equal(cards.length, 4)
    assert.equal(cards[0].name, 'Baa Atoll')
    assert.equal(cards[0].count, '2 islands')
    assert.equal(cards[0].tag, 'UNESCO biosphere')
  })

  it('a catalogue that is all one atoll has nothing to explore by, and draws nothing', () => {
    assert.deepEqual(atollCards([at('a', 'Baa Atoll'), at('b', 'Baa Atoll')]), [])
    assert.deepEqual(atollCards([]), [])
  })

  it('an atoll nobody has written a note for says Maldives rather than inventing one', () => {
    const cards = atollCards([at('a', 'Thaa Atoll'), at('b', 'Baa Atoll')])
    assert.equal(cards.find((c) => c.name === 'Thaa Atoll')?.tag, 'Maldives')
  })

  it('a brand with one island is a name, not a filter', () => {
    const chips = brandChips([prop({ id: 'x', brand: 'Adaaran' }), prop({ id: 'y', brand: 'Adaaran' }), prop({ id: 'z', brand: 'Soneva' })])
    assert.deepEqual(chips, [{ label: 'Adaaran', count: '2 islands' }])
  })

  it('the comparison prefers the featured islands and fills the rest from the catalogue', () => {
    const other = prop({ id: 'other', name: 'Other Island' })
    const c = comparison(bundleOf([prop(), other]), 'USD')
    assert.deepEqual(c.columns.map((x) => x.id), ['baros', 'other'])
    assert.deepEqual(c.rows.map((r) => r.label), ['Packages from', 'House reef', 'Transfer', 'Entry villa', 'Meal plans'])
    for (const row of c.rows) assert.equal(row.cells.length, c.columns.length)
  })

  it('a price cell only carries a figure where an Offer publishes one', () => {
    assert.match(comparison(bundleOf([prop(), prop({ id: 'b2' })], [offer()]), 'USD').rows[0].cells[0], /^\$4,200 · 5 nights$/)
    assert.equal(comparison(bundleOf([prop(), prop({ id: 'b2' })]), 'USD').rows[0].cells[0], 'Quoted · 5 nights')
  })

  it('one island cannot be compared, so the section is not drawn', () => {
    assert.deepEqual(comparison(bundleOf([prop()]), 'USD').columns, [])
  })

  it('the hero stat is counted, never asserted', () => {
    assert.deepEqual(homeStats([at('a', 'Baa Atoll'), at('b', 'Baa Atoll'), at('c', 'Raa Atoll')]), { islands: 3, atolls: 2 })
    assert.deepEqual(homeStats([]), { islands: 0, atolls: 0 })
  })

  it('the guides and the questions are complete — a heading with no answer is worse than neither', () => {
    assert.equal(GUIDES.length, 4)
    for (const g of GUIDES) {
      assert.ok(g.title && g.sub && g.intro, `guide ${g.n} is missing copy`)
      assert.ok(g.points.length >= 4, `guide ${g.n} has ${g.points.length} points`)
    }
    assert.ok(HOME_FAQ.length >= 5)
    for (const [q, a] of HOME_FAQ) {
      assert.ok(q.endsWith('?'), `"${q}" is not a question`)
      assert.ok(a.length > 80, `"${q}" is answered in ${a.length} characters`)
    }
  })
})
