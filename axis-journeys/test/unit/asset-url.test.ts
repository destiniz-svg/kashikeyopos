/**
 * Asset paths, and the route they are read from.
 *
 * The catalogue carries `assets/video/maldives-sd.mp4` — written when every screen lived at `/`.
 * On `/properties/baros` that resolves to `/properties/assets/video/…`, which is how the hero video
 * came to be silently broken on every property and destination page. A relative path is a bug that
 * only shows up one route deep, which is exactly the kind that survives a review.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { assetUrl } from '@/lib/content/asset-url'

describe('assetUrl', () => {
  it('roots a bare path, so it resolves the same from every route', () => {
    assert.equal(assetUrl('assets/video/maldives-sd.mp4'), '/assets/video/maldives-sd.mp4')
    assert.equal(assetUrl('./assets/video/uae.mp4'), '/assets/video/uae.mp4')
  })

  it('leaves an absolute URL exactly as the editor typed it', () => {
    for (const url of [
      'https://videos.pexels.com/video-files/19975602/19975602-hd_1920_1080_30fps.mp4',
      'http://example.test/a.mp4',
      '//cdn.axisjourneys.com/a.mp4',
      'data:image/png;base64,iVBORw0KGgo=',
      '/api/media/mabc/hero',
      '/assets/video/uae.mp4',
    ]) {
      assert.equal(assetUrl(url), url)
    }
  })

  it('an unset value is nothing, not "/"', () => {
    // The callers render a <video> only when this is truthy; "/" would ask the page for itself.
    assert.equal(assetUrl(''), '')
    assert.equal(assetUrl(null), '')
    assert.equal(assetUrl(undefined), '')
    assert.equal(assetUrl('   '), '')
  })

  it('is idempotent, so a value that goes through twice is unchanged', () => {
    assert.equal(assetUrl(assetUrl('assets/video/a.mp4')), '/assets/video/a.mp4')
  })
})
