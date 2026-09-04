/**
 * `GET /api/media` (the library) and `POST /api/media` (an upload).
 *
 * The browser sends three renditions it produced on a canvas — hero 1600, card 800, thumb 320 — so
 * this build needs no native image dependency, and the re-encode drops EXIF and its GPS tags on the
 * way. The server still checks each part: type against a closed list, size against the cap, and the
 * magic bytes against the declared type, because a content-type header is whatever the client says.
 */
import type { NextRequest } from 'next/server'
import { listMedia, logActivity, putDoc, uid } from '@/lib/content/repository'
import type { MediaRecord } from '@/lib/content/types'
import { clean } from '@/lib/content/sanitize'
import { ALLOWED_MIME, getMediaStore, isSize, SIZES, type Size } from '@/lib/media'
import { assertSameOrigin, need } from '@/lib/http/request'
import { badRequest, json, route } from '@/lib/http/respond'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

export const GET = route('media:list', async () => {
  await need('read')
  const store = getMediaStore()
  const records = await listMedia()
  return json(records.map((m) => ({ ...m, urls: { hero: store.url(m.id, 'hero'), card: store.url(m.id, 'card'), thumb: store.url(m.id, 'thumb') } })))
})

/** The first bytes of a file decide what it is; the header only says what the client claims. */
function sniff(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length > 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

export const POST = route('media:upload', async (req: NextRequest) => {
  const actor = await need('media')
  assertSameOrigin(req)

  const form = await req.formData().catch(() => null)
  if (!form) throw badRequest('Send the image as a multipart form')

  const id = 'm' + uid()
  const store = getMediaStore()
  let mime = 'image/jpeg'
  let stored = 0

  for (const size of Object.keys(SIZES) as Size[]) {
    const part = form.get(size)
    if (!(part instanceof File)) continue
    if (part.size > config.media.maxBytes) throw badRequest(`That image is larger than ${Math.round(config.media.maxBytes / 1024 / 1024)} MB`)
    const bytes = Buffer.from(await part.arrayBuffer())
    const actual = sniff(bytes)
    if (!actual || !ALLOWED_MIME.has(actual)) throw badRequest('That file is not a JPEG, PNG or WebP image')
    mime = actual
    await store.put(id, size, bytes, actual)
    stored++
  }
  if (!stored) throw badRequest('No image was included')
  // Every rendition or none: a record whose card size is missing renders a hole on the card grid.
  if (stored !== Object.keys(SIZES).length) throw badRequest('Every rendition (hero, card, thumb) must be included')

  const record: MediaRecord = {
    id,
    name: clean(form.get('name'), 120) || 'Untitled',
    alt: clean(form.get('alt'), 200),
    credit: clean(form.get('credit'), 200),
    focal: { x: 50, y: 50 },
    w: Number(form.get('w')) || 0,
    h: Number(form.get('h')) || 0,
    bytes: Number(form.get('bytes')) || 0,
    createdAt: Date.now(),
    by: actor.name,
    mime,
  }
  await putDoc<MediaRecord>('media', {
    id,
    draft: record,
    live: record,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    updatedBy: actor.name,
    publishedAt: record.createdAt,
    order: Date.now(),
  })
  await logActivity(actor.name, `Uploaded ${record.name}`)
  return json({ ...record, ref: `media:${id}`, urls: { hero: store.url(id, 'hero'), card: store.url(id, 'card'), thumb: store.url(id, 'thumb') } }, { status: 201 })
})

export { isSize }
