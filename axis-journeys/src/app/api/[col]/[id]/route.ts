/**
 * `GET|PUT|DELETE /api/{col}/{id}` — read a document, save a draft (the CMS autosaves here), or
 * remove it. A save never touches `live`: publishing is the only thing that does.
 */
import type { NextRequest } from 'next/server'
import { deleteDoc, getDoc, logActivity, newDoc, putDoc, view } from '@/lib/content/repository'
import { assertSameOrigin, need, readJson } from '@/lib/http/request'
import { badRequest, json, notFound, route } from '@/lib/http/respond'
import { assertCollection, ID_RE } from '../route'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ col: string; id: string }> }

export const GET = route('document:read', async (_req: NextRequest, ctx: Params) => {
  const { col: rawCol, id } = await ctx.params
  const col = assertCollection(rawCol)
  await need('read')
  const doc = await getDoc<Record<string, unknown>>(col, id)
  if (!doc) throw notFound('That document does not exist')
  return json(view(doc, col))
})

export const PUT = route('document:save', async (req: NextRequest, ctx: Params) => {
  const { col: rawCol, id } = await ctx.params
  const col = assertCollection(rawCol)
  const actor = await need('write')
  assertSameOrigin(req)
  if (!ID_RE.test(id)) throw badRequest('An id may use lowercase letters, numbers and hyphens only')

  const body = await readJson(req)
  const draft = (body.draft ?? {}) as Record<string, unknown>
  const existing = await getDoc<Record<string, unknown>>(col, id)
  const doc = existing ?? newDoc<Record<string, unknown>>(id, {}, actor.name)
  // The id is the document's own name; a draft that disagrees with the path would file the row
  // under one and be read back under the other.
  doc.draft = { ...draft, id }
  doc.updatedAt = Date.now()
  doc.updatedBy = actor.name
  await putDoc(col, doc)
  return json(view(doc, col))
})

export const DELETE = route('document:delete', async (req: NextRequest, ctx: Params) => {
  const { col: rawCol, id } = await ctx.params
  const col = assertCollection(rawCol)
  const actor = await need('delete')
  assertSameOrigin(req)
  const doc = await getDoc<Record<string, unknown>>(col, id)
  if (!doc) throw notFound('That document does not exist')
  await deleteDoc(col, id)
  await logActivity(actor.name, `Deleted ${col.replace(/s$/, '')} “${String(doc.draft?.name || id)}”`)
  return json({ ok: true })
})
