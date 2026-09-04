/** `GET /api/lists` — the vocabularies that drive every select and chip in the CMS and the site. */
import { readLists } from '@/lib/content/repository'
import { need } from '@/lib/http/request'
import { json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const GET = route('lists', async () => {
  await need('read')
  return json(await readLists())
})
