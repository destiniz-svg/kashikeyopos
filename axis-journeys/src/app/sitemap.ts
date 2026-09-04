/**
 * `/sitemap.xml`, composed from what is actually published.
 *
 * It reads the same bundle the site serves, so a page can never be advertised to a crawler that a
 * guest would be 404'd on — which is what a hand-written sitemap becomes the first time a property
 * is unpublished. `lastModified` is the bundle's own generation time rather than "now": a sitemap
 * that claims every page changed on every crawl teaches a crawler to ignore the field.
 */
import type { MetadataRoute } from 'next'
import { siteBundle } from '@/lib/content/bundle-service'
import { config } from '@/lib/config'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = config.siteUrl.replace(/\/$/, '')
  const bundle = await siteBundle(false).catch(() => null)
  const lastModified = new Date(bundle?.generatedAt ?? Date.now())

  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified, changeFrequency: 'daily', priority: 1 },
  ]

  for (const d of bundle?.destinations ?? []) {
    // A destination the agency does not sell yet is not a page worth ranking.
    if (!d.live) continue
    entries.push({ url: `${base}/destinations/${d.slug}`, lastModified, changeFrequency: 'weekly', priority: 0.8 })
  }

  for (const p of bundle?.properties ?? []) {
    entries.push({ url: `${base}/properties/${p.id}`, lastModified, changeFrequency: 'weekly', priority: 0.7 })
  }

  return entries
}
