/**
 * Seeding the workspace from the canonical content.
 *
 * `src/data/seed.json` is the output of `buildSeed()` in the handoff package — the real Axis
 * Journeys catalogue, not sample data: 32 properties (9 of them complete enough to publish), 25
 * offers, three destinations, the homepage and the company settings, with the legal documents.
 *
 * The same rule the publish endpoint keeps decides what goes live: a property carrying `draft` or
 * `detailPending`, or missing anything `readiness()` asks for, is created as an unpublished draft
 * for a specialist to finish. Nothing here bypasses that.
 */
import seedData from '../../data/seed'
import { getStore, PK, SK, type StoredItem } from '../store'
import { isSiteReady } from './rules'
import { logActivity, rebuildBundle, writeLists } from './repository'
import type { Destination, Doc, Homepage, Lists, Offer, Property, Settings } from './types'

interface SeedFile {
  properties: Property[]
  offers: Offer[]
  destinations: Destination[]
  homepage: Homepage
  settings: Settings
  lists: Lists
}

export const seed = seedData as unknown as SeedFile

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function doc<T extends { id: string }>(data: T, at: number, published: boolean, order: number): Doc<T> {
  return {
    id: data.id,
    draft: data,
    live: published ? clone(data) : null,
    createdAt: at,
    updatedAt: at,
    updatedBy: 'seed',
    publishedAt: published ? at : null,
    // The catalogue's own order. It is the order the agency curated, and the carousel reads it.
    order,
  }
}

/**
 * The fields the 2026-09-05 handoff added, and the only ones this backfill will write.
 *
 * A closed list rather than "merge everything the seed has": the seed is a snapshot of the
 * catalogue on the day it was generated, and merging it wholesale would quietly undo every edit a
 * specialist has made since. These eight are new — no document written before this can hold an
 * opinion about them — so filling them in cannot overwrite anybody's work.
 */
const PAGE_FIELDS = ['geo', 'exclusives', 'nearby', 'video', 'brand', 'instagram', 'awards', 'pricing'] as const

/**
 * Give existing property documents the fields the seed has since gained.
 *
 * Without this a store seeded before the handoff keeps serving properties with no coordinates, no
 * exclusives and no recognition — the page renders, because every one of them has a derived
 * fallback, and the real content the agency wrote sits in the repository being read by nobody.
 *
 * Two rules make it safe to run on every boot. It only fills a field that is ABSENT (`null` or
 * `undefined`); an empty array is a decision somebody made and is left alone. And it writes to
 * `live` as well as `draft`, because the alternative is a site that shows none of this until
 * somebody republishes nine properties by hand — the content is the same content the seed would
 * have published on a fresh install.
 */
export async function backfillPageFields(): Promise<{ documents: number; fields: number }> {
  const store = getStore()
  const rows = await store.list(PK.collection('properties'))
  const bySeed = new Map(seed.properties.map((p) => [p.id, p as unknown as Record<string, unknown>]))
  const items: StoredItem[] = []
  let fields = 0

  for (const row of rows) {
    const d = row.body as Doc<Record<string, unknown>>
    const from = bySeed.get(String(d.id))
    if (!from) continue
    let touched = false
    for (const key of PAGE_FIELDS) {
      const value = from[key]
      if (value == null) continue
      for (const side of ['draft', 'live'] as const) {
        const target = d[side] as Record<string, unknown> | null
        if (!target || target[key] != null) continue
        target[key] = clone(value)
        touched = true
        fields++
      }
    }
    if (touched) items.push({ pk: PK.collection('properties'), sk: row.sk, body: d })
  }

  if (items.length) {
    await store.putMany(items)
    await rebuildBundle()
    await logActivity('System', `Property-page fields filled in on ${items.length} propert${items.length === 1 ? 'y' : 'ies'}`)
  }
  return { documents: items.length, fields }
}

export interface SeedReport {
  properties: number
  published: number
  offers: number
  destinations: number
}

/**
 * Write the catalogue. `force` replaces what is there — used by the test suite and by a deliberate
 * re-seed; without it an existing document is left exactly as the team has since edited it.
 */
export async function seedWorkspace({ force = false }: { force?: boolean } = {}): Promise<SeedReport> {
  const store = getStore()
  const at = Date.now()
  const items: StoredItem[] = []

  const existing = new Set<string>()
  if (!force) {
    for (const col of ['properties', 'offers', 'destinations', 'homepage', 'settings'] as const) {
      for (const row of await store.list(PK.collection(col))) existing.add(`${col}:${row.sk}`)
    }
  }

  const add = <T extends { id: string }>(col: string, data: T, published: boolean, order: number): void => {
    const sk = SK.id(data.id)
    if (existing.has(`${col}:${sk}`)) return
    items.push({ pk: PK.collection(col), sk, body: doc(data, at, published, order) })
  }

  let published = 0
  seed.properties.forEach((p, i) => {
    const live = isSiteReady(p)
    if (live) published++
    add('properties', p, live, i)
  })
  // An offer is only live where its property is: the bundle drops the rest anyway, and a published
  // offer pointing at nothing is a card with no destination.
  const liveIds = new Set(seed.properties.filter(isSiteReady).map((p) => p.id))
  seed.offers.forEach((o, i) => add('offers', o, liveIds.has(o.resort), i))
  seed.destinations.forEach((d, i) => add('destinations', d, true, i))
  add('homepage', seed.homepage, true, 0)
  add('settings', seed.settings, true, 0)

  if (items.length) await store.putMany(items)
  await writeLists(seed.lists)
  await rebuildBundle()
  await logActivity('System', `Workspace seeded — ${published} of ${seed.properties.length} properties published`)

  return {
    properties: seed.properties.length,
    published,
    offers: seed.offers.length,
    destinations: seed.destinations.length,
  }
}
