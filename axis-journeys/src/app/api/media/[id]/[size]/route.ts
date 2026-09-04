/**
 * `GET /api/media/{id}/{size}` — serve a rendition: one of the three picture sizes, or the video
 * itself.
 *
 * This is the path a deployment without a CDN in front of the bucket uses. With `MEDIA_ORIGIN` set
 * the URLs point straight at the CDN and this route is only the fallback, which is why it carries
 * the same immutable cache header: a rendition never changes, only the record around it does.
 */
import type { NextRequest } from 'next/server'
import { getDoc } from '@/lib/content/repository'
import type { MediaRecord } from '@/lib/content/types'
import { getMediaStore, isRendition } from '@/lib/media'
import { notFound, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; size: string }> }

export const GET = route('media:serve', async (_req: NextRequest, ctx: Params) => {
  const { id, size } = await ctx.params
  if (!isRendition(size)) throw notFound('No such rendition')
  const doc = await getDoc<MediaRecord>('media', id)
  if (!doc) throw notFound('That file is not in the library')
  const file = await getMediaStore().get(id, size)
  if (!file) throw notFound('That rendition has not been stored')
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': file.mime,
      'Content-Length': String(file.bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
