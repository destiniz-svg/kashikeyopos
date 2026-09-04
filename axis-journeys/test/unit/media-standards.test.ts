/**
 * The media standard, and the header readers it is judged on.
 *
 * Two things are being held still here. The first is the line between refusing a file and warning
 * about it: a resort that only holds one photograph of its spa at 1200px still has that
 * photograph, and a rule that loses it is worse than the rule not existing. The second is that the
 * dimensions come out of the bytes rather than out of the upload's own claim — every number below
 * is read from a file this test composes, and the video cases are checked against the two clips
 * this site actually ships.
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { IMAGE_STANDARD, judge, summarise, VIDEO_STANDARD, type Measurement } from '@/lib/media/standards'
import { imageDimensions, videoFacts } from '@/lib/media/probe'

const CAP = 10 * 1024 * 1024
const VIDEO_CAP = 64 * 1024 * 1024

const image = (over: Partial<Measurement> = {}): Measurement => ({
  kind: 'image',
  mime: 'image/jpeg',
  width: 1600,
  height: 1067,
  bytes: 380_000,
  ...over,
})

const video = (over: Partial<Measurement> = {}): Measurement => ({
  kind: 'video',
  mime: 'video/mp4',
  width: 1920,
  height: 1080,
  bytes: 6 * 1024 * 1024,
  duration: 20,
  ...over,
})

const codes = (m: Measurement, cap = CAP): string[] => judge(m, cap).findings.map((f) => f.code)

describe('the image standard', () => {
  it('a hero-sized photograph passes with nothing to say', () => {
    const v = judge(image(), CAP)
    assert.equal(v.ok, true)
    assert.deepEqual(v.findings, [])
    assert.equal(summarise(v), '')
  })

  it('refuses a type the site cannot store, and says which types it takes', () => {
    const v = judge(image({ mime: 'image/gif' }), CAP)
    assert.equal(v.ok, false)
    assert.match(v.findings[0].says, /JPEG, PNG or WebP/)
  })

  it('refuses past the cap, and names both figures in megabytes', () => {
    const v = judge(image({ bytes: 12 * 1024 * 1024 }), CAP)
    assert.equal(v.ok, false)
    assert.match(summarise(v), /12\.0 MB.*10\.0 MB/)
  })

  it('a file whose dimensions could not be read is refused rather than passed', () => {
    // The alternative is worse than a refusal: a zero would sail through every size comparison.
    assert.deepEqual(codes(image({ width: 0, height: 0 })), ['unreadable'])
  })

  it('refuses below the smallest rendition and only warns below the hero width', () => {
    assert.deepEqual(codes(image({ width: 300, height: 200, bytes: 9_000 })), ['tiny'])
    const small = judge(image({ width: 1200, height: 800, bytes: 220_000 }), CAP)
    assert.equal(small.ok, true, 'a 1200px photograph is real content and is kept')
    assert.deepEqual(small.findings.map((f) => f.code), ['small'], 'one fault, one sentence')
    assert.match(small.findings[0].says, /1200 × 800/)
  })

  it('the warning names the hero width, because that is where it will be enlarged', () => {
    const v = judge(image({ width: IMAGE_STANDARD.wantLongEdge - 1, height: 900, bytes: 300_000 }), CAP)
    assert.match(v.findings[0].says, new RegExp(String(IMAGE_STANDARD.wantLongEdge)))
  })

  it('refuses a shape that crops to nothing, and warns on one that crops hard', () => {
    assert.deepEqual(codes(image({ width: 4000, height: 500, bytes: 400_000 })), ['shape'])
    assert.deepEqual(codes(image({ width: 500, height: 4000, bytes: 400_000 })), ['shape'])
    assert.ok(codes(image({ width: 2400, height: 1000, bytes: 400_000 })).includes('crop'))
  })

  it('reads heavy prior compression off our own re-encode, and only for JPEG', () => {
    const thin = { width: 1600, height: 1067, bytes: 40_000 }
    assert.ok(codes(image(thin)).includes('compressed'))
    // A flat PNG logo is legitimately tiny; calling that poor quality is a rule about the wrong
    // thing, so the check does not apply to it.
    assert.ok(!codes(image({ ...thin, mime: 'image/png' })).includes('compressed'))
  })

  it('a warning never makes the file unacceptable', () => {
    const v = judge(image({ width: 900, height: 600, bytes: 60_000 }), CAP)
    assert.equal(v.ok, true)
    assert.ok(v.findings.length >= 1)
    assert.ok(v.findings.every((f) => f.level === 'warn'))
  })
})

describe('the video standard', () => {
  it('a 1080p twenty-second loop passes', () => {
    assert.deepEqual(judge(video(), VIDEO_CAP).findings, [])
  })

  it('refuses a container this site cannot play', () => {
    assert.match(judge(video({ mime: 'video/quicktime' }), VIDEO_CAP).findings[0].says, /MP4 or WebM/)
  })

  it('refuses a clip too short to loop and one long enough to be a film', () => {
    assert.deepEqual(codes(video({ duration: 1 }), VIDEO_CAP), ['short'])
    assert.deepEqual(codes(video({ duration: 400 }), VIDEO_CAP), ['long'])
  })

  it('warns about portrait, because the hero is a wide band', () => {
    assert.ok(codes(video({ width: 1080, height: 1920 }), VIDEO_CAP).includes('portrait'))
  })

  it('says so when nothing could be measured, rather than passing a check that never ran', () => {
    assert.deepEqual(codes(video({ width: 0, height: 0 }), VIDEO_CAP), ['unmeasured'])
  })

  it('warns on the weight a phone would have to carry', () => {
    assert.ok(codes(video({ bytes: VIDEO_STANDARD.wantBytes + 1 }), VIDEO_CAP).includes('weight'))
  })
})

describe('reading dimensions out of the bytes', () => {
  it('reads a PNG header', async () => {
    const b = await readFile('public/assets/logo.png')
    assert.deepEqual(imageDimensions(b, 'image/png'), { width: 1920, height: 1007 })
  })

  it('answers null for something that is not the image it claims to be', () => {
    assert.equal(imageDimensions(Buffer.from('not an image at all'), 'image/jpeg'), null)
    assert.equal(imageDimensions(Buffer.alloc(0), 'image/png'), null)
    assert.equal(imageDimensions(Buffer.from('RIFF____WEBPnope'), 'image/webp'), null)
  })

  it('reads the video track and the duration out of the clips this site ships', async () => {
    const maldives = videoFacts(await readFile('public/assets/video/maldives-sd.mp4'), 'video/mp4')
    assert.deepEqual({ width: maldives.width, height: maldives.height }, { width: 640, height: 360 })
    assert.ok(Math.abs((maldives.seconds ?? 0) - 40.36) < 0.05)

    const uae = videoFacts(await readFile('public/assets/video/uae.mp4'), 'video/mp4')
    assert.deepEqual({ width: uae.width, height: uae.height }, { width: 640, height: 338 })
  })

  it('and those clips are below the standard, which is a finding about them and not a bug', async () => {
    // Both shipped heroes are 640-wide — the Maldives file says so in its own name. The standard
    // is not tuned down to let the existing content pass; it reports what is true of it.
    const b = await readFile('public/assets/video/uae.mp4')
    const f = videoFacts(b, 'video/mp4')
    const v = judge({ kind: 'video', mime: 'video/mp4', width: f.width ?? 0, height: f.height ?? 0, bytes: b.length, duration: f.seconds }, VIDEO_CAP)
    assert.equal(v.ok, true)
    assert.deepEqual(v.findings.map((x) => x.code), ['small'])
  })

  it('an audio track never wins the dimensions, and a non-MP4 is an unknown', async () => {
    // maldives-sd carries a 0 × 0 audio tkhd beside its video track.
    const b = await readFile('public/assets/video/maldives-sd.mp4')
    assert.equal(videoFacts(b, 'video/mp4').width, 640)
    assert.deepEqual(videoFacts(b, 'video/webm'), {})
    assert.deepEqual(videoFacts(Buffer.from('nope'), 'video/mp4'), {})
  })
})
