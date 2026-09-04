/**
 * The media standard, video, and several photographs on one room — over HTTP, against a real
 * server and a real store.
 *
 * Two claims are being held to account here. The first is that the standard is enforced on the
 * bytes the server received rather than on anything the uploader said about them: every dimension
 * below is one this server read out of a file, and the form deliberately carries no width at all.
 * The second is that a room's photographs actually reach a guest — through the publish, through
 * the media resolver, and out of the public bundle as URLs with their focal points beside them.
 */
import { strict as assert } from 'node:assert'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { body, startServer, type Harness } from '../support/server'
import { form, jpegOf, realMp4, realPng, renditions } from '../support/media'
import type { Property, SiteBundle } from '@/lib/content/types'

let h: Harness
let cookie = ''
/** A published property, taken from the catalogue rather than named from memory. */
let subject = ''
before(async () => {
  h = await startServer()
  cookie = await h.signIn()
  const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
  subject = bundle.properties[0].id
})
after(async () => { await h?.stop() })

interface Rec {
  id: string
  ref: string
  kind?: string
  duration?: number
  w: number
  h: number
  bytes: number
  mime: string
  urls: Record<string, string>
  standard: { ok: boolean; findings: { level: string; code: string; says: string }[] }
}

const upload = (f: FormData) => h.api('/api/media', { method: 'POST', cookie, body: f })

/**
 * One HTTP request, written by hand, so a test can say something a client would correct.
 *
 * `fetch` will not let you announce a length and then send less, and that mismatch is the whole
 * case here. Silence is a real answer and is returned as an empty string rather than thrown.
 */
function rawRequest(base: string, lines: string[], payload: string, waitMs = 6000): Promise<string> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve) => {
    const sock = connect({ host: hostname, port: Number(port) }, () => sock.write(lines.join('\r\n') + '\r\n\r\n' + payload))
    let out = ''
    sock.setEncoding('utf8')
    const stop = () => { sock.destroy(); resolve(out) }
    const timer = setTimeout(stop, waitMs)
    sock.on('data', (d) => { out += d })
    sock.on('error', () => { clearTimeout(timer); resolve(out) })
    sock.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}
const put = (path: string, draft: unknown) =>
  h.api(path, { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft }) })

describe('the standard, applied to what actually arrived', () => {
  it('measures the stored file rather than believing the form', async () => {
    // The form says 8000 × 6000 and carries a 1600-wide file. The record has to say 1600.
    const res = await upload(renditions(jpegOf(1600, 1067), { w: '8000', h: '6000', bytes: '99999999', name: 'Measured' }))
    const rec = await body<Rec>(res)
    assert.equal(res.status, 201, JSON.stringify(rec))
    assert.deepEqual({ w: rec.w, h: rec.h }, { w: 1600, h: 1067 })
    assert.deepEqual(rec.standard.findings, [], 'a hero-sized photograph has nothing to answer for')
  })

  it('keeps a photograph below the hero width and says why, rather than losing real content', async () => {
    const res = await upload(renditions(jpegOf(1100, 733, 40_000), { name: 'The only picture of the spa' }))
    const rec = await body<Rec>(res)
    assert.equal(res.status, 201)
    const codes = rec.standard.findings.map((f) => f.code)
    assert.ok(codes.includes('small'), JSON.stringify(codes))
    assert.ok(rec.standard.findings.every((f) => f.level === 'warn'))
    assert.match(rec.standard.findings[0].says, /1100 × 733/, 'the sentence names the actual size')

    // And it is kept on the record, so the library can still say so tomorrow.
    const list = await body<Rec[]>(await h.api('/api/media', { cookie }))
    const again = list.find((m) => m.id === rec.id)!
    assert.ok((again as unknown as { standard: unknown[] }).standard.length)
  })

  it('refuses what cannot work anywhere, by name and without storing it', async () => {
    const tiny = await upload(renditions(jpegOf(200, 150, 3_000)))
    assert.equal(tiny.status, 400)
    assert.match((await body<{ error: string }>(tiny)).error, /smaller than the smallest size/)

    const strip = await upload(renditions(jpegOf(4000, 400)))
    assert.equal(strip.status, 400)
    assert.match((await body<{ error: string }>(strip)).error, /cut away/)
  })

  it('a JPEG with no frame header is unreadable, not silently sized zero', async () => {
    // The shape of the old fixture: the right first three bytes and nothing that says how big it
    // is. A zero would have sailed through every comparison the standard makes.
    const headless = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 0x20), Buffer.from([0xff, 0xd9])])
    const res = await upload(renditions(headless))
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /could not be read/)
  })

  it('a real PNG goes in whole and comes back servable', async () => {
    const res = await upload(form({ hero: { bytes: realPng(), name: 'hero.png', type: 'image/png' }, card: { bytes: realPng(), name: 'card.png', type: 'image/png' }, thumb: { bytes: realPng(), name: 'thumb.png', type: 'image/png' }, name: 'Axis logo' }))
    const rec = await body<Rec>(res)
    assert.equal(res.status, 201, JSON.stringify(rec))
    assert.deepEqual({ w: rec.w, h: rec.h, mime: rec.mime }, { w: 1920, h: 1007, mime: 'image/png' })
    const served = await h.api(`/api/media/${rec.id}/hero`)
    assert.equal(served.headers.get('content-type'), 'image/png')
  })
})

describe('video in the library', () => {
  it('stores the clip, measures it from its own boxes, and serves it back', async () => {
    const mp4 = realMp4()
    const res = await upload(renditions(jpegOf(1280, 720), { video: { bytes: mp4, name: 'uae.mp4', type: 'video/mp4' }, name: 'UAE hero' }))
    const rec = await body<Rec>(res)
    assert.equal(res.status, 201, JSON.stringify(rec))
    assert.equal(rec.kind, 'video')
    assert.deepEqual({ w: rec.w, h: rec.h }, { w: 640, h: 338 }, 'read out of the tkhd box, not out of the form')
    assert.ok(Math.abs((rec.duration ?? 0) - 11.1) < 0.2, `duration ${rec.duration}`)
    assert.equal(rec.bytes, mp4.length)

    // Below standard for a full-screen hero, kept, and it says so — which is the finding this
    // site's own shipped clips would draw too.
    assert.deepEqual(rec.standard.findings.map((f) => f.code), ['small'])

    const served = await h.api(`/api/media/${rec.id}/video`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'video/mp4')
    assert.equal(Number(served.headers.get('content-length')), mp4.length)
    // The poster is a real picture, so a browser that refuses to autoplay has something to show.
    assert.match((await h.api(`/api/media/${rec.id}/card`)).headers.get('content-type') || '', /^image\//)
  })

  it('refuses a video with no poster frame, rather than storing a black rectangle', async () => {
    const res = await upload(form({ video: { bytes: realMp4(), name: 'uae.mp4', type: 'video/mp4' }, name: 'No poster' }))
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /poster frame/)
  })

  it('a HEIC photograph is not a video, though it is the same container', async () => {
    // `ftyp` fronts an iPhone still as well as an MP4; only the brand after it tells them apart.
    // Stored as a video it would be a hero nothing plays, so it is refused as what it is.
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(4096, 0x20)])
    heic.writeUInt32BE(24, 0)
    const res = await upload(renditions(jpegOf(1280, 720), { video: { bytes: heic, name: 'IMG_0001.HEIC', type: 'video/mp4' } }))
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /HEIC photograph/)
  })

  it('a QuickTime .mov is refused with what to do about it', async () => {
    const mov = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ', 'latin1'), Buffer.alloc(4096, 0x20)])
    mov.writeUInt32BE(24, 0)
    const res = await upload(renditions(jpegOf(1280, 720), { video: { bytes: mov, name: 'clip.mov', type: 'video/mp4' } }))
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /Export it as MP4/)
  })

  it('refuses bytes that are not a video, whatever the part is called', async () => {
    const res = await upload(renditions(jpegOf(1280, 720), { video: { bytes: Buffer.from('#!/bin/sh\nrm -rf /'), name: 'clip.mp4', type: 'video/mp4' } }))
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /MP4 or WebM/)
  })

})

describe('the caps this install was configured with', () => {
  // Its own server, at caps small enough for a test to actually exceed. That is not only cheaper:
  // it proves the numbers are read from configuration rather than that the defaults happen to
  // hold, which a test against a 64 MB cap could never distinguish.
  let small: Harness
  let key = ''
  before(async () => {
    small = await startServer({ MEDIA_MAX_BYTES: '200000', MEDIA_VIDEO_MAX_BYTES: '400000' })
    key = await small.signIn()
  })
  after(async () => { await small?.stop() })

  it('refuses a request larger than one video and its posters could ever be', async () => {
    // A plain body rather than a FormData, and that is the point: undici streams a file-backed
    // multipart without a content-length, so this check simply does not fire on one — which is
    // right (you cannot refuse on a header that is not there) and is why the per-part cap below
    // is the one that actually catches an oversized upload from the CMS.
    const res = await small.api('/api/media', {
      method: 'POST',
      cookie: key,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x'.repeat(1_200_000),
    })
    assert.equal(res.status, 400)
    assert.match((await body<{ error: string }>(res)).error, /larger than this install accepts \(1\.0 MB in one request\)/)
  })

  it('refuses one part over the image cap, and the sentence says what the cap is', async () => {
    // "larger than 0 MB" is what this said before sizes were printed in the unit they fit: a
    // refusal whose whole job is to name the limit, naming zero.
    const res = await small.api('/api/media', { method: 'POST', cookie: key, body: form({ hero: jpegOf(1600, 1067, 300_000), card: jpegOf(800, 533, 20_000), thumb: jpegOf(320, 213, 5_000) }) })
    assert.equal(res.status, 400)
    assert.equal((await body<{ error: string }>(res)).error, 'That image is larger than 195 KB')
  })

  it('refuses a video over the video cap', async () => {
    const res = await small.api('/api/media', {
      method: 'POST',
      cookie: key,
      body: form({ hero: jpegOf(1280, 720, 50_000), card: jpegOf(800, 450, 20_000), thumb: jpegOf(320, 180, 5_000), video: { bytes: realMp4(), name: 'uae.mp4', type: 'video/mp4' } }),
    })
    assert.equal(res.status, 400)
    assert.equal((await body<{ error: string }>(res)).error, 'That video is larger than 391 KB')
  })

  it('and a body the platform never finishes receiving is not this handler to refuse', async () => {
    // Measured rather than assumed, because the first version of the guard claimed the opposite.
    // A POST that announces 900 MB and sends seven bytes gets no answer — and neither does one to
    // a route that does not exist, so it is the platform receiving the body before anything is
    // dispatched. The fence for that lives at the edge; this pins the behaviour so nobody writes
    // the claim back into the handler.
    const head = (path: string) => [
      `POST ${path} HTTP/1.1`,
      `Host: ${new URL(small.base).host}`,
      'content-type: multipart/form-data; boundary=x',
      `content-length: ${900 * 1024 * 1024}`,
      'x-requested-with: axis',
      `cookie: ${key}`,
      'connection: close',
    ]
    assert.equal(await rawRequest(small.base, head('/api/media'), '--x--\r\n', 2500), '')
    assert.equal(await rawRequest(small.base, head('/api/no-such-route'), '--x--\r\n', 2500), '', 'a 404 is just as silent, which is what says it is not the handler')
  })

})

describe('several photographs of one room, all the way to a guest', () => {
  it('reach the public bundle as URLs, with their focal points beside them', async () => {
    const a = await body<Rec>(await upload(renditions(jpegOf(1600, 1067), { name: 'Villa deck' })))
    const b = await body<Rec>(await upload(renditions(jpegOf(1600, 1067), { name: 'Villa bathroom' })))
    const c = await body<Rec>(await upload(renditions(jpegOf(1600, 1067), { name: 'Villa pool' })))
    // A focal point on one of them, so the position that comes back is a real choice.
    await h.api(`/api/media/${b.id}`, { method: 'PATCH', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ focal: { x: 20, y: 80 } }) })

    const before = await body<{ draft: Property }>(await h.api(`/api/properties/${subject}`, { cookie }))
    const draft = structuredClone(before.draft)
    draft.villas[0] = [draft.villas[0][0], draft.villas[0][1], draft.villas[0][2], a.ref, 'A room with more than one photograph.', ['Private pool'], undefined, [b.ref, c.ref]]
    draft.dining = [['Lagoon Grill', 'Wood-fire seafood', 'Overwater deck', a.ref, 'Dinner over the reef.', ['Dinner'], undefined, [c.ref]]]
    assert.equal((await put(`/api/properties/${subject}`, draft)).status, 200)
    assert.equal((await h.api(`/api/properties/${subject}/publish`, { method: 'POST', cookie })).status, 200)

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const p = bundle.properties.find((x) => x.id === subject)!
    const villa = p.villas[0]

    assert.equal(villa[3], `/api/media/${a.id}/card`, 'the lead photograph resolved')
    assert.deepEqual(villa[7], [`/api/media/${b.id}/card`, `/api/media/${c.id}/card`], 'and the rest, in order')
    assert.deepEqual(villa[8], ['20% 80%', '50% 50%'], 'their focal points, at slot 8')
    assert.equal(villa[0], before.draft.villas[0][0], 'the row is otherwise the row it was')

    // The seventh slot of the photo LIST is a photograph, not a focal position — the trap the
    // resolver's own guard exists for.
    const venue = p.dining![0]
    assert.deepEqual(venue[7], [`/api/media/${c.id}/card`])
    assert.deepEqual(venue[8], ['50% 50%'])

    // A reference the library no longer holds resolves to nothing rather than to a broken URL.
    await h.api(`/api/media/${c.id}`, { method: 'DELETE', cookie })
    const after = await body<SiteBundle>(await h.api('/api/public/site?preview=0'))
    const gone = after.properties.find((x) => x.id === subject)!.villas[0]
    assert.equal((gone[7] as string[])[1], '', 'a removed photograph leaves an empty slot, not a 404')
  })

  it('a room with one photograph is unchanged, slot for slot', async () => {
    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const other = bundle.properties.find((p) => p.id !== subject)!
    for (const v of other.villas) {
      assert.equal(v[7], undefined, `${other.id} grew a photo list it was never given`)
      assert.equal(v[8], undefined, `${other.id} grew positions it was never given`)
    }
  })
})

describe('a destination points at its own video and its own gallery', () => {
  it('resolves the clip to the video, not to a picture of it', async () => {
    const clip = await body<Rec>(await upload(renditions(jpegOf(1280, 720), { video: { bytes: realMp4(), name: 'uae.mp4', type: 'video/mp4' }, name: 'Dest hero clip' })))
    const shot = await body<Rec>(await upload(renditions(jpegOf(1600, 1067), { name: 'Dest gallery' })))

    const before = await body<{ draft: Record<string, unknown> }>(await h.api('/api/destinations/maldives', { cookie }))
    const draft = { ...before.draft, video: clip.ref, gallery: [{ img: shot.ref, cap: 'A lagoon at dusk' }] }
    assert.equal((await put('/api/destinations/maldives', draft)).status, 200)
    assert.equal((await h.api('/api/destinations/maldives/publish', { method: 'POST', cookie })).status, 200)

    const bundle = await body<SiteBundle>(await h.api('/api/public/site'))
    const dest = bundle.destinations.find((d) => d.slug === 'maldives')!
    assert.equal(dest.video, `/api/media/${clip.id}/video`, 'the field named video wants the clip')
    assert.equal(dest.gallery?.[0].img, `/api/media/${shot.id}/card`)
    assert.equal(dest.gallery?.[0].cap, 'A lagoon at dusk')
    // And the poster is still reachable under the same record, which is what a `<video>` needs.
    assert.equal(dest.hero?.startsWith('http') || dest.hero?.startsWith('/') || dest.hero?.startsWith('assets'), true)
  })
})
