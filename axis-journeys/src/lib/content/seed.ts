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
