/** `PATCH|DELETE /api/media/{id}` — alt text, credit, name and the focal point; or remove it. */
import type { NextRequest } from 'next/server'
import { deleteDoc, getDoc, logActivity, putDoc } from '@/lib/content/repository'
import type { MediaRecord } from '@/lib/content/types'
import { clean } from '@/lib/content/sanitize'
import { getMediaStore } from '@/lib/media'
import { assertSameOrigin, need, readJson } from '@/lib/http/request'
import { json, notFound, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }
const pct = (v: unknown, dflt: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : dflt
}

export const PATCH = route('media:patch', async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params
  const actor = await need('media')
  assertSameOrigin(req)
  const doc = await getDoc<MediaRecord>('media', id)
  if (!doc) throw notFound('That image is not in the library')
  const body = await readJson(req)
  const next: MediaRecord = { ...doc.draft }
  if (body.name !== undefined) next.name = clean(body.name, 120)
  if (body.alt !== undefined) next.alt = clean(body.alt, 200)
  if (body.credit !== undefined) next.credit = clean(body.credit, 200)
  if (body.focal !== undefined) {
    const f = (body.focal ?? {}) as Record<string, unknown>
    next.focal = { x: pct(f.x, next.focal.x), y: pct(f.y, next.focal.y) }
  }
  doc.draft = next
  doc.live = next
  doc.updatedAt = Date.now()
  doc.updatedBy = actor.name
  await putDoc('media', doc)
  return json(next)
})

export const DELETE = route('media:delete', async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params
  const actor = await need('media')
  assertSameOrigin(req)
  const doc = await getDoc<MediaRecord>('media', id)
  if (!doc) throw notFound('That image is not in the library')
  await getMediaStore().remove(id)
  await deleteDoc('media', id)
  await logActivity(actor.name, `Removed ${doc.draft.name} from the library`)
  return json({ ok: true })
})
