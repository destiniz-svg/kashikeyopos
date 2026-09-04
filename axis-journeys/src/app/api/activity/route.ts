/** `GET /api/activity` — the last 60 events, newest first. */
import { readActivity } from '@/lib/content/repository'
import { need } from '@/lib/http/request'
import { json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const GET = route('activity', async () => {
  await need('read')
  return json(await readActivity(60))
})
