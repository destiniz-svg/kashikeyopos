/**
 * `GET /api/{col}` and `POST /api/{col}` — the content collections.
 *
 * `{col}` is checked against the closed list rather than trusted: an unknown segment is a 404, not
 * a partition key composed from whatever the caller typed.
 */
import type { NextRequest } from 'next/server'
import { CONTENT_COLLECTIONS, type ContentCollection } from '@/lib/content/types'
import { listDocs, newDoc, putDoc, uid, view, logActivity } from '@/lib/content/repository'
import { assertSameOrigin, need, readJson } from '@/lib/http/request'
import { badRequest, json, notFound, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export function assertCollection(col: string): ContentCollection {
  if (!(CONTENT_COLLECTIONS as string[]).includes(col)) throw notFound('No such collection')
  return col as ContentCollection
}

/** A document id reaches a sort key and a URL, so its shape is fixed rather than sanitised. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

type Params = { params: Promise<{ col: string }> }

export const GET = route('collection:list', async (_req: NextRequest, ctx: Params) => {
  const col = assertCollection((await ctx.params).col)
  await need('read')
  const docs = await listDocs<Record<string, unknown>>(col)
  return json(docs.map((d) => view(d, col)))
})

/** Create. The id may be supplied (a slug the editor chose) or minted. */
export const POST = route('collection:create', async (req: NextRequest, ctx: Params) => {
  const col = assertCollection((await ctx.params).col)
  const actor = await need('write')
  assertSameOrigin(req)
  const body = await readJson(req)
  const draft = (body.draft ?? {}) as Record<string, unknown>
  const proposed = String(body.id ?? draft.id ?? '').trim().toLowerCase()
  const id = proposed || uid()
  if (!ID_RE.test(id)) throw badRequest('An id may use lowercase letters, numbers and hyphens only')

  const doc = newDoc<Record<string, unknown>>(id, { ...draft, id }, actor.name)
  await putDoc(col, doc)
  await logActivity(actor.name, `Created ${col.replace(/s$/, '')} “${String(draft.name || draft.badge || id)}”`)
  return json(view(doc, col), { status: 201 })
})
