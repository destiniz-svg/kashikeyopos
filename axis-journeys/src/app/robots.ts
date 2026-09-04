/**
 * `/robots.txt`.
 *
 * The CMS and the API are disallowed, and that is a courtesy to a crawler rather than a control:
 * everything behind them is refused without a session anyway. What robots.txt is genuinely for here
 * is keeping the sitemap discoverable and keeping a preview or staging origin out of the index —
 * an unpublished staging copy of a real business's site outranking the real one is a costly and
 * entirely preventable mistake.
 */
import type { MetadataRoute } from 'next'
import { config } from '@/lib/config'

/**
 * Evaluated per request, not at build.
 *
 * One image runs in development, staging and production — that is the whole shape of the deploy —
 * and `next build` runs with `NODE_ENV=production`, so a statically generated robots.txt would bake
 * production's "allow everything" and serve it on staging. The file whose entire job is keeping a
 * staging copy out of the index would be the thing that put it there.
 */
export const dynamic = 'force-dynamic'

export default function robots(): MetadataRoute.Robots {
  if (config.stage !== 'production') {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/admin', '/admin/', '/api/'] },
      // These crawl for training corpora rather than to send anybody to the site. The agency's
      // photography and its specialists' written descriptions are its own work.
      { userAgent: ['GPTBot', 'CCBot', 'ClaudeBot', 'Google-Extended', 'anthropic-ai'], disallow: '/' },
    ],
    sitemap: `${config.siteUrl}/sitemap.xml`,
    host: config.siteUrl,
  }
}
