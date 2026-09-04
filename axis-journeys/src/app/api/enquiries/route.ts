/** `GET /api/enquiries` — the CRM list, newest first. Sales, editor and owner. */
import { listEnquiries } from '@/lib/content/repository'
import { need } from '@/lib/http/request'
import { json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const GET = route('enquiries:list', async () => {
  await need('enquiries')
  return json(await listEnquiries())
})
