/**
 * The document store seam.
 *
 * Two drivers implement it: `file` (local development and the test suite — a real store, not a
 * stub) and `dynamodb` (the deployed one, single-table per ARCHITECTURE.md). Everything above this
 * interface is driver-agnostic, so moving a customer between them is a configuration change.
 */

/** A stored row. `pk` is the partition, `sk` the item within it — the DynamoDB shape, held by both. */
export interface StoredItem<T = unknown> {
  pk: string
  sk: string
  body: T
  /** Unix seconds. The store deletes the row after this — used for activity and rate counters. */
  ttl?: number
}

export interface DocumentStore {
  /** One item, or null. */
  get<T>(pk: string, sk: string): Promise<T | null>
  /** Every item in a partition, in sk order. */
  list<T>(pk: string): Promise<{ sk: string; body: T }[]>
  put<T>(pk: string, sk: string, body: T, ttl?: number): Promise<void>
  /** All-or-nothing. Publishing writes the document and the denormalised bundle together. */
  putMany(items: StoredItem[]): Promise<void>
  delete(pk: string, sk: string): Promise<void>
  /** True when the store is reachable — the readiness probe asks this. */
  health(): Promise<{ ok: boolean; detail: string }>
}

/** Partition keys. One place, so a typo cannot split a collection in two. */
export const PK = {
  collection: (col: string) => `COL#${col}`,
  users: 'USERS',
  activity: 'ACTIVITY',
  /** The denormalised public bundle, rewritten on every publish. */
  live: 'LIVE',
  meta: 'META',
} as const

export const SK = {
  id: (id: string) => `ID#${id}`,
  /** Newest first when the list is reversed: sortable, collision-resistant. */
  ts: (at: number, id: string) => `TS#${String(1e15 - at).padStart(16, '0')}#${id}`,
} as const
