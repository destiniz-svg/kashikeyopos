/**
 * Turn `media:{id}` references into URLs, and carry each image's focal point alongside it.
 *
 * Ported from `resolveDeep()` in `prototype/admin/api.js`, including the positional rules: a villa
 * or venue tuple keeps its lead image at index 3 and its focal position at index 6, its further
 * photographs at index 7 and their positions at index 8, and an object carrying `img` gains a
 * sibling `pos`. Those indices are the data model, not an accident — the public site reads them
 * positionally.
 *
 * It runs on the server, so a guest's browser never has to resolve anything and a document can
 * never leak a bucket URL it was not meant to.
 */
import type { MediaRecord } from '../content/types'
import { getMediaStore, isMediaRef, mediaId, type Rendition } from './index'

export type MediaIndex = Map<string, MediaRecord>

const focalOf = (rec: MediaRecord | undefined): string | undefined =>
  rec ? `${rec.focal?.x ?? 50}% ${rec.focal?.y ?? 50}%` : undefined

const sizeFor = (key: string | number | undefined): Rendition => {
  const k = String(key ?? '')
  // A field called `video` wants the clip, not a picture of it. Everything else is a picture, and
  // only the full-bleed ones are worth the 1600 rendition.
  if (/^video$/i.test(k)) return 'video'
  return /hero|poster|storyImg/i.test(k) ? 'hero' : 'card'
}

export function resolveMediaRefs<T>(value: T, index: MediaIndex, key?: string | number): T {
  const store = getMediaStore()

  if (isMediaRef(value)) {
    const id = mediaId(value)
    const rec = index.get(id)
    return (rec ? store.url(id, sizeFor(key), rec.mime) : '') as unknown as T
  }

  if (Array.isArray(value)) {
    const out = value.map((x, i) => resolveMediaRefs(x, index, i)) as unknown[]
    // The positional rules describe a ROW — a villa, a venue. A plain list of photographs is not
    // one, and it announces itself by holding a reference in its first slot, which no tuple in
    // this model does. Without that guard a room with four extra photographs would have its
    // seventh replaced by a focal position, because index 3 of that list is a reference too.
    if (!isMediaRef(value[0])) {
      const ref = value[3]
      if (isMediaRef(ref)) {
        const pos = focalOf(index.get(mediaId(ref)))
        if (pos) out[6] = pos
      }
      const more = value[7]
      if (Array.isArray(more) && more.some(isMediaRef)) {
        out[8] = more.map((r) => (isMediaRef(r) ? focalOf(index.get(mediaId(r))) ?? '50% 50%' : '50% 50%'))
      }
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
