/**
 * `GET /api/media` (the library) and `POST /api/media` (an upload).
 *
 * The browser sends three renditions it produced on a canvas — hero 1600, card 800, thumb 320 — so
 * this build needs no native image dependency, and the re-encode drops EXIF and its GPS tags on the
 * way. A video upload sends the file itself alongside those three, which are a frame captured from
 * it: a video with no poster is a black rectangle wherever autoplay is refused.
 *
 * The server checks each part rather than believing any of it: type against a closed list decided
 * by the magic bytes, size against the cap, and — this is the part somebody asked for — the
 * dimensions and duration read out of the stored bytes, against `media/standards.ts`. What is
 * below the floor is refused by name. What is merely below standard is kept and said out loud,
 * because a resort that holds one photograph of its spa at 1200px still has that photograph.
 *
 * WHAT THE CONTENT-LENGTH CHECK IS AND IS NOT. It reads the announced size before `formData()`
 * parses, which saves the multipart decode and the second copy of every part it allocates. It is
 * NOT a fence at the door, and the first draft of this file claimed it was. Measured: a POST that
 * announces 900 MB and sends seven bytes gets no answer at all — and neither does one to a route
 * that does not exist, so it is the platform receiving the body before anything is dispatched, not
 * this handler. A body that must never arrive has to be stopped at the edge, in front of the
 * application; DEPLOYMENT.md says which setting that is on each of the two.
 */
import type { NextRequest } from 'next/server'
import { listMedia, logActivity, putDoc, uid } from '@/lib/content/repository'
import { kindOf, type MediaRecord } from '@/lib/content/types'
import { clean } from '@/lib/content/sanitize'
import { ALLOWED_MIME, ALLOWED_VIDEO_MIME, getMediaStore, SIZES, type Rendition, type Size } from '@/lib/media'
import { imageDimensions, videoFacts } from '@/lib/media/probe'
import { bytesLabel, judge, summarise, type Measurement, type Verdict } from '@/lib/media/standards'
import { assertSameOrigin, need } from '@/lib/http/request'
import { badRequest, json, route } from '@/lib/http/respond'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

const urlsFor = (id: string, rec: Pick<MediaRecord, 'kind' | 'mime'>) => {
  const store = getMediaStore()
  const urls: Record<string, string> = {
    hero: store.url(id, 'hero'),
    card: store.url(id, 'card'),
    thumb: store.url(id, 'thumb'),
  }
  if (kindOf(rec) === 'video') urls.video = store.url(id, 'video', rec.mime)
  return urls
}

export const GET = route('media:list', async () => {
  await need('read')
  const records = await listMedia()
  return json(records.map((m) => ({ ...m, urls: urlsFor(m.id, m) })))
})

/** The first bytes of a file decide what it is; the header only says what the client claims. */
function sniff(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length > 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  // ISO base media declares itself in the SECOND box field, not the first — and `ftyp` alone is
  // not "a video": a photograph from an iPhone is HEIC, which is the same container. The brand
  // that follows is what separates them, so a still is refused as a still rather than stored as a
  // video nothing will ever play. `qt  ` is QuickTime, which Safari plays and Chrome does not.
  if (bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1')
    if (/^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand)) return 'image/heic'
    if (brand === 'qt  ') return 'video/quicktime'
    return 'video/mp4'
  }
  if (bytes.length > 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm'
  return null
}

export const POST = route('media:upload', async (req: NextRequest) => {
  const actor = await need('media')
  assertSameOrigin(req)

  // The largest a legitimate upload can be: one video, its three poster renditions, and the
  // multipart framing around them. Derived rather than a round number, so raising either cap in
  // configuration raises this with it instead of silently contradicting it.
  const ceiling = config.media.videoMaxBytes + 3 * config.media.maxBytes + 64 * 1024
  const announced = Number(req.headers.get('content-length') || 0)
  if (announced > ceiling) throw badRequest(`That upload is larger than this install accepts (${bytesLabel(ceiling)} in one request)`)

  const form = await req.formData().catch(() => null)
  if (!form) throw badRequest('Send the file as a multipart form')

  const id = 'm' + uid()
  const store = getMediaStore()
  const videoPart = form.get('video')
  const isVideo = videoPart instanceof File

  // ---- the renditions, each one sniffed and sized before anything is stored
  const parts: { size: Rendition; bytes: Buffer; mime: string }[] = []

  for (const size of Object.keys(SIZES) as Size[]) {
    const part = form.get(size)
    if (!(part instanceof File)) continue
    const bytes = Buffer.from(await part.arrayBuffer())
    if (bytes.length > config.media.maxBytes) throw badRequest(`That image is larger than ${bytesLabel(config.media.maxBytes)}`)
    const actual = sniff(bytes)
    if (!actual || !ALLOWED_MIME.has(actual)) throw badRequest('That file is not a JPEG, PNG or WebP image')
    parts.push({ size, bytes, mime: actual })
  }
  // Every rendition or none: a record whose card size is missing renders a hole on the card grid,
  // and a video with no poster frame is a black rectangle wherever autoplay is refused.
  if (parts.length !== Object.keys(SIZES).length) {
    throw badRequest(isVideo ? 'A video needs its poster frame in all three sizes' : parts.length ? 'Every rendition (hero, card, thumb) must be included' : 'No image was included')
  }

  if (isVideo) {
    const bytes = Buffer.from(await videoPart.arrayBuffer())
    if (bytes.length > config.media.videoMaxBytes) throw badRequest(`That video is larger than ${bytesLabel(config.media.videoMaxBytes)}`)
    const actual = sniff(bytes)
    if (actual === 'image/heic') throw badRequest('That is a HEIC photograph, not a video. Drop it in as an image, or export the clip as MP4.')
    if (actual === 'video/quicktime') throw badRequest('That is a QuickTime .mov, which some browsers will not play. Export it as MP4 and it will work everywhere.')
    if (!actual || !ALLOWED_VIDEO_MIME.has(actual)) throw badRequest('That file is not an MP4 or WebM video')
    parts.push({ size: 'video', bytes, mime: actual })
  }

  // ---- the standard, measured on the bytes rather than on what the uploader said about them
  const subject = parts.find((p) => p.size === (isVideo ? 'video' : 'hero'))!
  const verdict = measure(subject, isVideo)
  if (!verdict.ok) throw badRequest(summarise(verdict))

  for (const p of parts) await store.put(id, p.size, p.bytes, p.mime)

  const hero = parts.find((p) => p.size === 'hero')!
  const shape = isVideo ? videoFacts(subject.bytes, subject.mime) : imageDimensions(hero.bytes, hero.mime)
  const record: MediaRecord = {
    id,
    kind: isVideo ? 'video' : 'image',
    ...(isVideo ? { duration: Math.round(((shape as { seconds?: number }).seconds ?? 0) * 10) / 10 } : {}),
    name: clean(form.get('name'), 120) || 'Untitled',
    alt: clean(form.get('alt'), 200),
    credit: clean(form.get('credit'), 200),
    focal: { x: 50, y: 50 },
    // Measured, never taken from the form. The old fields carried whatever the browser asserted.
    w: shape?.width ?? 0,
    h: shape?.height ?? 0,
    bytes: subject.bytes.length,
    createdAt: Date.now(),
    by: actor.name,
    mime: subject.mime,
    ...(verdict.findings.length ? { standard: verdict.findings } : {}),
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
  return json({ ...record, ref: `media:${id}`, urls: urlsFor(id, record), standard: verdict }, { status: 201 })
})

/**
 * What the standard is judged against.
 *
 * For a picture it is the `hero` rendition, and that is the load-bearing choice: the browser only
 * ever scales down (`Math.min(1, 1600 / longEdge)`), so a hero that comes back under 1600 wide is
 * proof the original was under 1600 wide. Nothing has to trust a number in the form to know it.
 *
 * For a video it is the file itself, read through `videoFacts()`. A WebM answers with nothing this
 * build can read, and the standard reports that as unmeasured rather than as a pass.
 */
function measure(subject: { bytes: Buffer; mime: string }, isVideo: boolean): Verdict {
  const cap = isVideo ? config.media.videoMaxBytes : config.media.maxBytes
  if (isVideo) {
    const f = videoFacts(subject.bytes, subject.mime)
    const m: Measurement = { kind: 'video', mime: subject.mime, width: f.width ?? 0, height: f.height ?? 0, bytes: subject.bytes.length, duration: f.seconds ?? 0 }
    return judge(m, cap)
  }
  const d = imageDimensions(subject.bytes, subject.mime)
  const m: Measurement = { kind: 'image', mime: subject.mime, width: d?.width ?? 0, height: d?.height ?? 0, bytes: subject.bytes.length }
  return judge(m, cap)
}
