/**
 * The business rules, against the cases that decide whether something reaches the public site.
 *
 * These four functions have three callers each — the publish endpoint, the public bundle and the
 * CMS completeness bar — so a change here that nobody notices is a property that publishes and then
 * fails to render. The cases below are the ones the prototype's own `api.js` encodes.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { docStatus, isSiteReady, readiness, validateOffer } from '@/lib/content/rules'
import type { Property } from '@/lib/content/types'

/** A property with every field `readiness()` asks for, so a test can take exactly one away. */
const complete = (over: Partial<Property> = {}): Partial<Property> => ({
  id: 'p1',
  name: 'Baros Maldives',
  dest: 'Maldives',
  area: 'North Malé Atoll',
  verdict: 'The one to book for a quiet, grown-up week.',
  transferShort: 'Speedboat · 25 min',
  img: 'https://example.test/hero.jpg',
  villas: [['Deluxe Villa', '60 sqm', 0]],
  days: [['Day 1', 'Arrival', 'Speedboat to the island, then a late lunch.']],
  transfers: [['Speedboat', '25 min', 0]],
  themes: ['Honeymoon'],
  ...over,
})

describe('readiness', () => {
  it('a complete property is ready and names nothing missing', () => {
    const r = readiness(complete() as Property)
    assert.equal(r.ready, true)
    assert.deepEqual(r.missing, [])
  })

  it('a missing document is refused rather than treated as empty', () => {
    assert.deepEqual(readiness(null), { ready: false, missing: ['document'] })
    assert.deepEqual(readiness(undefined), { ready: false, missing: ['document'] })
  })

  it('names each missing field in the words the editor is shown', () => {
    const cases: [Partial<Property>, string][] = [
      [{ name: '   ' }, 'name'],
      [{ dest: '' }, 'destination'],
      [{ area: '' }, 'area'],
      [{ verdict: '' }, 'verdict'],
      [{ transferShort: '' }, 'transfer summary'],
      [{ img: '' }, 'hero photo'],
      [{ villas: [] }, 'at least one room type'],
      [{ days: [] }, 'day-by-day itinerary'],
      [{ transfers: [] }, 'transfer options'],
      [{ themes: [] }, 'themes'],
    ]
    for (const [over, label] of cases) {
      const r = readiness(complete(over) as Property)
      assert.equal(r.ready, false, `${label} should not be ready`)
      assert.deepEqual(r.missing, [label])
    }
  })

  it('whitespace is not content', () => {
    assert.deepEqual(readiness(complete({ verdict: '\n\t  ' }) as Property).missing, ['verdict'])
  })

  it('a value of the wrong shape is missing, not a crash', () => {
    const r = readiness(complete({ villas: 'not an array' as unknown as Property['villas'] }) as Property)
    assert.deepEqual(r.missing, ['at least one room type'])
  })

  it('reports every fault at once, in field order', () => {
    const r = readiness({ id: 'p2' } as Property)
    assert.deepEqual(r.missing, [
      'name',
      'destination',
      'area',
      'verdict',
      'transfer summary',
      'hero photo',
      'at least one room type',
      'day-by-day itinerary',
      'transfer options',
      'themes',
    ])
  })
})

describe('isSiteReady', () => {
  it('a complete property is served', () => {
    assert.equal(isSiteReady(complete() as Property), true)
  })

  it('the legacy stub flags keep a complete property off the site', () => {
    assert.equal(isSiteReady(complete({ draft: true }) as Property), false)
    assert.equal(isSiteReady(complete({ detailPending: true }) as Property), false)
  })

  it('an incomplete property is never served, flags or not', () => {
    assert.equal(isSiteReady(complete({ days: [] }) as Property), false)
  })

  it('nothing is not ready', () => {
    assert.equal(isSiteReady(null), false)
  })
})

describe('validateOffer', () => {
  const ids = new Set(['baros', 'soneva-fushi'])
  const good = { resort: 'baros', badge: 'Stay 5 Pay 4', date: 'May – Sep 2026', perk: 'Free half board' }

  it('accepts an offer that names a property this site holds', () => {
    assert.deepEqual(validateOffer(good, ids), [])
  })

  it('refuses an offer whose property does not exist', () => {
    assert.deepEqual(validateOffer({ ...good, resort: 'not-a-resort' }, ids), ['a property'])
  })

  it('refuses an offer that names no property at all', () => {
    assert.deepEqual(validateOffer({ ...good, resort: '' }, ids), ['a property'])
    assert.deepEqual(validateOffer(null, ids), ['a property', 'badge', 'departure/validity', 'perks'])
  })

  it('names each missing piece of copy', () => {
    assert.deepEqual(validateOffer({ ...good, badge: ' ' }, ids), ['badge'])
    assert.deepEqual(validateOffer({ ...good, date: '' }, ids), ['departure/validity'])
    assert.deepEqual(validateOffer({ ...good, perk: '' }, ids), ['perks'])
  })
})

describe('docStatus', () => {
  it('never published is a draft', () => {
    assert.equal(docStatus({ draft: { a: 1 }, live: null }), 'draft')
  })

  it('draft identical to live is published', () => {
    assert.equal(docStatus({ draft: { a: 1, b: [2] }, live: { a: 1, b: [2] } }), 'published')
  })

  it('an edited draft is changed', () => {
    assert.equal(docStatus({ draft: { a: 2 }, live: { a: 1 } }), 'changed')
  })

  it('key order does not make an unchanged document look edited', () => {
    // The comparison is structural, and the editor rewrites the whole object on every save.
    assert.equal(docStatus({ draft: { a: 1, b: 2 }, live: { a: 1, b: 2 } }), 'published')
  })
})
