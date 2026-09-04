/**
 * The content repository: every read and write of a document goes through here.
 *
 * It is the only module that knows the store's key layout, so a route handler never composes a
 * partition key and the publish transaction is written once. `readBundle()` is the hot path — it is
 * served from the denormalised `LIVE` item, rewritten inside the same transaction as a publish, so
 * a guest's first paint never fans out across five collections.
 */
import { randomUUID } from 'node:crypto'
import { getStore, PK, SK, type StoredItem } from '../store'
import { config } from '../config'
import { docStatus, isSiteReady, readiness as readinessOf } from './rules'
import type {
  ActivityEvent,
  ContentCollection,
  Destination,
  Doc,
  Enquiry,
  Homepage,
  Lists,
  MediaRecord,
  Offer,
  Property,
  Settings,
  SiteBundle,
} from './types'

export const uid = (): string => randomUUID().replace(/-/g, '').slice(0, 12)
const now = (): number => Date.now()

export type AnyDoc = Doc<Record<string, unknown>>

export interface DocView<T> extends Doc<T> {
  status: 'draft' | 'changed' | 'published'
  ready?: boolean
  missing?: string[]
}

// ---------------------------------------------------------------- documents

export async function listDocs<T>(col: ContentCollection | 'media' | 'enquiries'): Promise<Doc<T>[]> {
  const rows = await getStore().list<Doc<T>>(PK.collection(col))
  return rows.map((r) => r.body).sort(byOrder)
}

export async function getDoc<T>(col: ContentCollection | 'media' | 'enquiries', id: string): Promise<Doc<T> | null> {
  return getStore().get<Doc<T>>(PK.collection(col), SK.id(id))
}

export async function putDoc<T>(col: ContentCollection | 'media' | 'enquiries', doc: Doc<T>): Promise<void> {
  await getStore().put(PK.collection(col), SK.id(doc.id), doc)
}

export async function deleteDoc(col: ContentCollection | 'media' | 'enquiries', id: string): Promise<void> {
  await getStore().delete(PK.collection(col), SK.id(id))
  if (col !== 'enquiries' && col !== 'media') await invalidateBundle()
}

/** A document as the CMS reads it: with its derived status and, for a property, its readiness. */
export function view<T extends Record<string, unknown>>(d: Doc<T>, col?: string): DocView<T> {
  const out: DocView<T> = { ...d, status: docStatus(d) }
  if (col === 'properties' && d.draft) {
    const r = readinessOf(d.draft as unknown as Property)
    out.ready = r.ready
    out.missing = r.missing
  }
  return out
}


export function newDoc<T>(id: string, draft: T, by: string, order = now()): Doc<T> {
  const at = now()
  return { id, draft, live: null, createdAt: at, updatedAt: at, updatedBy: by, publishedAt: null, order }
}

/** Curatorial order first; a document written before this field existed falls back to its id. */
export const byOrder = <T>(a: Doc<T>, b: Doc<T>): number =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// ---------------------------------------------------------------- activity

export async function logActivity(by: string, what: string): Promise<void> {
  const at = now()
  const ev: ActivityEvent = { id: uid(), at, by, what }
  // The feed is a diagnostic, not an archive: rows expire after 90 days, as ARCHITECTURE.md says.
  await getStore().put(PK.activity, SK.ts(at, ev.id), ev, Math.floor(at / 1000) + 90 * 24 * 3600)
}

export async function readActivity(limit = 60): Promise<ActivityEvent[]> {
  const rows = await getStore().list<ActivityEvent>(PK.activity)
  return rows.map((r) => r.body).slice(0, limit)
}

// ---------------------------------------------------------------- the public bundle

/**
 * Compose the bundle from the collections. `preview` serves drafts — the CMS preview iframe asks
 * for it with a session, and the door checks that before calling.
 */
export async function composeBundle(preview: boolean): Promise<SiteBundle> {
  const pick = <T>(d: Doc<T>): T | null => (preview ? d.draft : d.live)
  const [props, offers, dests, homepages, settings] = await Promise.all([
    listDocs<Property>('properties'),
    listDocs<Offer>('offers'),
    listDocs<Destination>('destinations'),
    listDocs<Homepage>('homepage'),
    listDocs<Settings>('settings'),
  ])

  // The rule is applied server-side, never by the client: a stub hidden only by the browser is a
  // stub that is one view-source away from being read.
  const properties = props.map(pick).filter((p): p is Property => !!p && isSiteReady(p))
  const liveIds = new Set(properties.map((p) => p.id))
  const liveOffers = offers.map(pick).filter((o): o is Offer => !!o && liveIds.has(o.resort))
  const destinations = dests.map(pick).filter((d): d is Destination => !!d)
  const homepage = (homepages.map(pick).find(Boolean) ?? null) as Homepage | null
  const site = (settings.map(pick).find(Boolean) ?? null) as Settings | null

  return {
    properties,
    offers: liveOffers,
    destinations,
    homepage: homepage as Homepage,
    settings: site as Settings,
    generatedAt: now(),
    preview,
  }
}

interface CachedBundle { at: number; bundle: SiteBundle }
let memo: CachedBundle | null = null

/**
 * The published bundle. Read from the denormalised item first — one round trip rather than five
 * queries — and recomposed when it is missing, which is what makes the store self-healing after a
 * restore. Held in memory for `BUNDLE_TTL_MS` so a burst of guests costs one read.
 */
export async function readBundle(): Promise<SiteBundle> {
  if (memo && now() - memo.at < config.bundleTtlMs) return memo.bundle
  const stored = await getStore().get<SiteBundle>(PK.live, 'BUNDLE')
  const bundle = stored ?? (await rebuildBundle())
  memo = { at: now(), bundle }
  return bundle
}

/** Recompose and store the denormalised bundle. Called inside publish, and by the seeder. */
export async function rebuildBundle(): Promise<SiteBundle> {
  const bundle = await composeBundle(false)
  await getStore().put(PK.live, 'BUNDLE', bundle)
  memo = { at: now(), bundle }
  return bundle
}

/** Drop the in-process copy so the next read recomposes. */
export async function invalidateBundle(): Promise<void> {
  memo = null
  await rebuildBundle()
}

/** The items a publish writes, so the caller can commit them in one transaction. */
export async function bundleItem(): Promise<StoredItem> {
  const bundle = await composeBundle(false)
  memo = { at: now(), bundle }
  return { pk: PK.live, sk: 'BUNDLE', body: bundle }
}

// ---------------------------------------------------------------- lists

const DEFAULT_LISTS: Lists = {
  THEMES: ['Honeymoon', 'Family', 'Adults Only', 'Luxury', 'All-Inclusive', 'Diving', 'Surfing', 'Wellness'],
  PKGS: ['Beach Villa', 'Overwater Villa', 'Private Island', 'All-Inclusive Island', 'Dive & Surf Island'],
  MONTHS: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  TIERS: ['Ultra-Luxury Collection', 'Luxury Collection', 'Five-Star Escapes', 'Premium Resorts'],
  SPECIALISTS: ['Axis Maldives Specialist'],
}

export async function readLists(): Promise<Lists> {
  const stored = await getStore().get<Lists>(PK.meta, 'LISTS')
  return stored ?? DEFAULT_LISTS
}

export async function writeLists(lists: Lists): Promise<void> {
  await getStore().put(PK.meta, 'LISTS', lists)
}

// ---------------------------------------------------------------- enquiries & media

export async function listEnquiries(): Promise<Enquiry[]> {
  const docs = await listDocs<Enquiry>('enquiries')
  return docs.map((d) => d.draft).sort((a, b) => b.createdAt - a.createdAt)
}

export async function listMedia(): Promise<MediaRecord[]> {
  const docs = await listDocs<MediaRecord>('media')
  return docs.map((d) => d.draft).sort((a, b) => b.createdAt - a.createdAt)
}
