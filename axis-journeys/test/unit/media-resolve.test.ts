/**
 * `media:{id}` reference resolution, including the two positional rules the public site reads.
 *
 * A villa or venue tuple keeps its lead image at index 3 and its focal position at index 6, its
 * further photographs at index 7 and their positions at index 8; an object carrying `img` gains a
 * sibling `pos`. Those indices are the data model rather than an accident,
 * so they are pinned: a resolver that put the focal point somewhere else would silently re-crop
 * every photograph on the site.
 */
import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { buildMediaIndex, resolveMediaRefs } from '@/lib/media/resolve'
import { setMediaStore, type MediaStore } from '@/lib/media'
import type { MediaRecord } from '@/lib/content/types'

const record = (id: string, focal?: { x: number; y: number }): MediaRecord =>
  ({ id, name: `${id}.jpg`, alt: '', credit: '', w: 1600, h: 1067, bytes: 1, by: 'test', createdAt: 0, ...(focal ? { focal } : {}) }) as MediaRecord

/** A store that says where a rendition would be fetched from, and touches no filesystem. */
const stubStore: MediaStore = {
  put: async () => undefined,
  get: async () => null,
  remove: async () => undefined,
  url: (id: string, size: string) => `/media/${id}/${size}`,
  health: async () => ({ ok: true, detail: 'stub' }),
}
setMediaStore(stubStore)
afterEach(() => setMediaStore(stubStore))

const index = buildMediaIndex([record('a', { x: 30, y: 70 }), record('b'), record('hero1', { x: 10, y: 20 })])

describe('resolveMediaRefs', () => {
  it('turns a reference into a URL and leaves everything else alone', () => {
    assert.equal(resolveMediaRefs('media:a', index), '/media/a/card')
    assert.equal(resolveMediaRefs('https://example.test/x.jpg', index), 'https://example.test/x.jpg')
    assert.equal(resolveMediaRefs(42, index), 42)
    assert.equal(resolveMediaRefs(null, index), null)
    assert.equal(resolveMediaRefs(true, index), true)
  })

  it('a reference to a record that is gone resolves to nothing, not to a broken URL', () => {
    // The library row was deleted; the document still points at it. An empty string renders as
    // "no image", which every surface already handles, where a dead URL renders as a broken one.
    assert.equal(resolveMediaRefs('media:deleted', index), '')
  })

  it('a hero key asks for the hero rendition, everything else for the card', () => {
    assert.equal(resolveMediaRefs({ hero: 'media:a' }, index).hero, '/media/a/hero')
    assert.equal(resolveMediaRefs({ poster: 'media:a' }, index).poster, '/media/a/hero')
    assert.equal(resolveMediaRefs({ storyImg: 'media:a' }, index).storyImg, '/media/a/hero')
    assert.equal(resolveMediaRefs({ img: 'media:a' }, index).img, '/media/a/card')
  })

  it('an object carrying img gains a sibling pos', () => {
    const out = resolveMediaRefs({ name: 'Water Villa', img: 'media:a' }, index) as { img: string; pos?: string; name: string }
    assert.equal(out.img, '/media/a/card')
    assert.equal(out.pos, '30% 70%')
    assert.equal(out.name, 'Water Villa')
  })

  it('a record with no focal point centres, rather than leaving the crop undefined', () => {
    const out = resolveMediaRefs({ img: 'media:b' }, index) as { pos?: string }
    assert.equal(out.pos, '50% 50%')
  })

  it('a tuple keeps its image at 3 and its focal position at 6', () => {
    const villa = ['Water Villa with Pool', '90 sqm', 1200, 'media:a', 'A description', ['Pool']]
    const out = resolveMediaRefs(villa, index) as unknown[]
    assert.equal(out[0], 'Water Villa with Pool')
    assert.equal(out[2], 1200)
    assert.equal(out[3], '/media/a/card')
    assert.equal(out[6], '30% 70%')
    // The nested feature list is resolved too, and is still a list.
    assert.deepEqual(out[5], ['Pool'])
  })

  it('a tuple whose index 3 is not a reference gains no focal position', () => {
    const out = resolveMediaRefs(['Beach Villa', '60 sqm', 0, 'https://example.test/v.jpg'], index) as unknown[]
    assert.equal(out[3], 'https://example.test/v.jpg')
    assert.equal(out[6], undefined)
  })

  it('a tuple pointing at a deleted record keeps its shape and gains nothing', () => {
    const out = resolveMediaRefs(['Villa', '', 0, 'media:deleted'], index) as unknown[]
    assert.equal(out[3], '')
    assert.equal(out[6], undefined)
  })

  it('resolves the whole document, at every depth', () => {
    const doc = {
      name: 'Baros',
      hero: 'media:hero1',
      gallery: [{ img: 'media:a', cap: 'Sunset' }, { img: 'media:b', cap: 'Reef' }],
      villas: [['Water Villa', '90 sqm', 0, 'media:a']],
      nested: { deep: { deeper: 'media:b' } },
    }
    const out = resolveMediaRefs(doc, index)
    assert.equal(out.hero, '/media/hero1/hero')
    assert.equal((out.gallery[0] as { img: string; pos?: string }).img, '/media/a/card')
    assert.equal((out.gallery[0] as { pos?: string }).pos, '30% 70%')
    assert.equal((out.villas[0] as unknown[])[6], '30% 70%')
    assert.equal(out.nested.deep.deeper, '/media/b/card')
  })

  it('does not mutate the document it was handed', () => {
    const doc = { img: 'media:a', villas: [['V', '', 0, 'media:a']] }
    const before = JSON.stringify(doc)
    resolveMediaRefs(doc, index)
    assert.equal(JSON.stringify(doc), before)
  })

  it('an empty index resolves every reference to nothing', () => {
    const empty = buildMediaIndex([])
    assert.equal(resolveMediaRefs('media:a', empty), '')
  })
})

describe('buildMediaIndex', () => {
  it('is keyed by id', () => {
    const i = buildMediaIndex([record('x'), record('y')])
    assert.equal(i.size, 2)
    assert.equal(i.get('x')?.id, 'x')
  })
})

describe('a row with several photographs', () => {
  it('resolves the list at slot 7 and puts their focal points at slot 8', () => {
    const villa = ['Beach Pool Villa', '210 sqm', 0, 'media:a', 'A room.', ['Pool'], undefined, ['media:b', 'media:a']]
    const out = resolveMediaRefs(villa, index) as unknown[]
    assert.equal(out[3], '/media/a/card')
    assert.equal(out[6], '30% 70%', 'the lead photograph still names its own focal point')
    assert.deepEqual(out[7], ['/media/b/card', '/media/a/card'])
    assert.deepEqual(out[8], ['50% 50%', '30% 70%'], 'a record with no focal point falls back to the centre')
  })

  it('a LIST of photographs is not a row, so slot 3 of it stays a photograph', () => {
    // The trap: a photo list's fourth entry is a media reference too, so the row rule would have
    // written a focal position over its seventh photograph. A row never holds a reference at 0.
    const many = ['media:a', 'media:b', 'media:a', 'media:b', 'media:a', 'media:b', 'media:a', 'media:b']
    const out = resolveMediaRefs(many, index) as unknown[]
    assert.equal(out.length, 8)
    assert.equal(out[6], '/media/a/card', 'slot 6 was overwritten with a focal position')
    assert.ok(out.every((x) => typeof x === 'string' && (x as string).startsWith('/media/')))
  })

  it('a row with no extra photographs grows neither slot', () => {
    const out = resolveMediaRefs(['Sunset Villa', '90 sqm', 0, 'media:b'], index) as unknown[]
    // It still reaches slot 6: that is the lead photograph's focal position, and this resolver has
    // written it since it was ported. What must not appear is a photo list or positions for one.
    assert.equal(out.length, 7)
    assert.equal(out[6], '50% 50%')
    assert.equal(out[7], undefined)
    assert.equal(out[8], undefined)
  })

  it('a field called video asks for the clip; everything else asks for a picture', () => {
    const dest = { hero: 'media:hero1', card: 'media:a', video: 'media:b' }
    const out = resolveMediaRefs(dest, index) as Record<string, string>
    assert.equal(out.hero, '/media/hero1/hero')
    assert.equal(out.card, '/media/a/card')
    assert.equal(out.video, '/media/b/video')
  })
})
