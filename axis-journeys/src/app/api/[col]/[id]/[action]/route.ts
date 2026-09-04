/**
 * `POST /api/{col}/{id}/{publish|unpublish|discard}`.
 *
 * Publish is the gate. A property that is not site-ready is refused 422 with what is missing, and
 * an offer that does not name a property, a badge, a date and a perk is refused the same way —
 * both by the same functions the public bundle filters with, so a document cannot publish and then
 * fail to render.
 *
 * The document and the rewritten public bundle are committed together: a published property that
 * the bundle does not carry is a publish that did not happen, and half of it is worse than neither.
 */
import type { NextRequest } from 'next/server'
import { getStore, PK, SK, type StoredItem } from '@/lib/store'
import { bundleItem, getDoc, listDocs, logActivity, view } from '@/lib/content/repository'
import { readiness, validateOffer } from '@/lib/content/rules'
import type { Offer, Property } from '@/lib/content/types'
import { assertSameOrigin, need } from '@/lib/http/request'
import { json, notFound, route, unprocessable } from '@/lib/http/respond'
import { assertCollection } from '../../route'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ col: string; id: string; action: string }> }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

export const POST = route('document:action', async (req: NextRequest, ctx: Params) => {
  const { col: rawCol, id, action } = await ctx.params
  const col = assertCollection(rawCol)
  assertSameOrigin(req)

  const doc = await getDoc<Record<string, unknown>>(col, id)
  if (!doc) throw notFound('That document does not exist')

  if (action === 'publish') {
    const actor = await need('publish')
    if (col === 'properties') {
      const r = readiness(doc.draft as unknown as Property)
      if (!r.ready) throw unprocessable('Not ready to publish — add ' + r.missing.join(', '), { missing: r.missing.join(', ') })
      // Publishing is what clears the legacy stub flags: a document that renders is not a stub.
      delete (doc.draft as Record<string, unknown>).draft
      delete (doc.draft as Record<string, unknown>).detailPending
    }
    if (col === 'offers') {
      const props = await listDocs<Property>('properties')
      const ids = new Set(props.map((p) => p.id))
      const miss = validateOffer(doc.draft as unknown as Offer, ids)
      if (miss.length) throw unprocessable('Offer needs ' + miss.join(', '), { missing: miss.join(', ') })
    }
    doc.live = clone(doc.draft)
    doc.publishedAt = Date.now()
    doc.updatedAt = doc.publishedAt
    doc.updatedBy = actor.name

    const items: StoredItem[] = [{ pk: PK.collection(col), sk: SK.id(id), body: doc }]
    // Write the document first so the recomposed bundle sees it, then commit both as one unit.
    await getStore().put(PK.collection(col), SK.id(id), doc)
    items.push(await bundleItem())
    await getStore().putMany(items)

    await logActivity(actor.name, `Published ${col.replace(/s$/, '')} “${String(doc.draft.name || doc.draft.badge || id)}”`)
    return json(view(doc, col))
  }

  if (action === 'unpublish') {
    const actor = await need('publish')
    doc.live = null
    doc.publishedAt = null
    doc.updatedAt = Date.now()
    doc.updatedBy = actor.name
    await getStore().put(PK.collection(col), SK.id(id), doc)
    await getStore().putMany([await bundleItem()])
    await logActivity(actor.name, `Unpublished ${col.replace(/s$/, '')} “${String(doc.draft.name || id)}”`)
    return json(view(doc, col))
  }

  if (action === 'discard') {
    const actor = await need('write')
    if (doc.live) doc.draft = clone(doc.live)
    doc.updatedAt = Date.now()
    doc.updatedBy = actor.name
    await getStore().put(PK.collection(col), SK.id(id), doc)
    return json(view(doc, col))
  }

  throw notFound('No such action')
})
