/**
 * `GET /api/public/site` — the only hot path on the public plane.
 *
 * It serves the denormalised bundle, and it applies `isSiteReady` on the server. The client is
 * never trusted to hide a stub: a property that is not ready is not in the answer at all, so there
 * is nothing to reveal by reading the response.
 */
import type { NextRequest } from 'next/server'
import { siteBundle } from '@/lib/content/bundle-service'
import { currentActor } from '@/lib/http/request'
import { json, route } from '@/lib/http/respond'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

export const GET = route('public/site', async (req: NextRequest) => {
  const wantsPreview = new URL(req.url).searchParams.get('preview') === '1'
  // A preview serves unpublished drafts, so it is a read on the content plane and needs a session.
  // Refused rather than downgraded: silently serving live content under `?preview=1` is how an
  // editor concludes their draft did not save.
  const actor = wantsPreview ? await currentActor() : null
  const preview = wantsPreview && !!actor

  const bundle = await siteBundle(preview)
  return json(bundle, {
    headers: preview
      ? { 'Cache-Control': 'no-store, max-age=0' }
      : {
          // Short edge cache with a long grace window: Cloudflare serves the stale copy while it
          // revalidates, so a publish is visible in seconds and a store hiccup is invisible.
          'Cache-Control': `public, max-age=0, s-maxage=${Math.round(config.bundleTtlMs / 1000)}, stale-while-revalidate=86400`,
        },
  })
})
