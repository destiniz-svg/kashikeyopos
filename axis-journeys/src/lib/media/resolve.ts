/**
 * Turn `media:{id}` references into URLs, and carry each image's focal point alongside it.
 *
 * Ported from `resolveDeep()` in `prototype/admin/api.js`, including the two positional rules: a
 * villa or venue tuple keeps its image at index 3 and its focal position at index 6, and an object
 * carrying `img` gains a sibling `pos`. Those indices are the data model, not an accident — the
 * public site reads them positionally.
 *
 * It runs on the server, so a guest's browser never has to resolve anything and a document can
 * never leak a bucket URL it was not meant to.
 */
import type { MediaRecord } from '../content/types'
import { getMediaStore, isMediaRef, mediaId, type Size } from './index'

export type MediaIndex = Map<string, MediaRecord>

const focalOf = (rec: MediaRecord | undefined): string | undefined =>
  rec ? `${rec.focal?.x ?? 50}% ${rec.focal?.y ?? 50}%` : undefined

const sizeFor = (key: string | number | undefined): Size =>
  /hero|poster|storyImg/i.test(String(key ?? '')) ? 'hero' : 'card'

export function resolveMediaRefs<T>(value: T, index: MediaIndex, key?: string | number): T {
  const store = getMediaStore()

  if (isMediaRef(value)) {
    const id = mediaId(value)
    return (index.has(id) ? store.url(id, sizeFor(key)) : '') as unknown as T
  }

  if (Array.isArray(value)) {
    const out = value.map((x, i) => resolveMediaRefs(x, index, i)) as unknown[]
    const ref = value[3]
    if (isMediaRef(ref)) {
      const pos = focalOf(index.get(mediaId(ref)))
      if (pos) out[6] = pos
    }
    return out as unknown as T
  }

  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src)) out[k] = resolveMediaRefs(src[k], index, k)
    if (isMediaRef(src.img)) {
      const pos = focalOf(index.get(mediaId(src.img as string)))
      if (pos) out.pos = pos
    }
    return out as unknown as T
  }

  return value
}

export function buildMediaIndex(records: MediaRecord[]): MediaIndex {
  return new Map(records.map((r) => [r.id, r]))
}
