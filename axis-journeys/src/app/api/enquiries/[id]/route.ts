/**
 * `PATCH|DELETE /api/enquiries/{id}` — move an enquiry's status, reassign it, or add a note.
 *
 * The patch is a whitelist rather than a merge: a caller must not be able to rewrite the address,
 * the property or the creation time of a record a guest submitted.
 */
import type { NextRequest } from 'next/server'
import { deleteDoc, getDoc, logActivity, putDoc } from '@/lib/content/repository'
import type { Enquiry, EnquiryStatus } from '@/lib/content/types'
import { clean } from '@/lib/content/sanitize'
import { assertSameOrigin, need, readJson } from '@/lib/http/request'
import { badRequest, json, notFound, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

const STATUSES: EnquiryStatus[] = ['new', 'contacted', 'quoted', 'won', 'closed']
type Params = { params: Promise<{ id: string }> }

export const PATCH = route('enquiries:patch', async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params
  const actor = await need('enquiries')
  assertSameOrigin(req)
  const doc = await getDoc<Enquiry>('enquiries', id)
  if (!doc) throw notFound('That enquiry does not exist')
  const body = await readJson(req)
  const next: Enquiry = { ...doc.draft }

  if (body.status !== undefined) {
    const status = String(body.status) as EnquiryStatus
    if (!STATUSES.includes(status)) throw badRequest('That is not a status an enquiry can hold')
    next.status = status
  }
  if (body.assignedTo !== undefined) next.assignedTo = clean(body.assignedTo, 80)
  if (body.note !== undefined) {
    const text = clean(body.note, 2000)
    if (text) next.notes = [...(next.notes || []), { by: actor.name, at: Date.now(), text }]
  }

  doc.draft = next
  doc.live = next
  doc.updatedAt = Date.now()
  doc.updatedBy = actor.name
  await putDoc('enquiries', doc)
  await logActivity(actor.name, `Updated enquiry from ${next.name}`)
  return json(next)
})

export const DELETE = route('enquiries:delete', async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params
  const actor = await need('delete')
  assertSameOrigin(req)
  const doc = await getDoc<Enquiry>('enquiries', id)
  if (!doc) throw notFound('That enquiry does not exist')
  await deleteDoc('enquiries', id)
  await logActivity(actor.name, `Deleted the enquiry from ${doc.draft.name}`)
  return json({ ok: true })
})
