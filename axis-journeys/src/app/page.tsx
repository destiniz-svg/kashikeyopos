/**
 * The home page.
 *
 * Server-rendered with the published bundle, so the first paint carries every property, offer and
 * destination as real markup — the funnel is indexable and readable before a byte of JavaScript
 * has run. The client takes it from there.
 */
import type { Metadata } from 'next'
import { siteBundle } from '@/lib/content/bundle-service'
import { SiteApp } from '@/components/site/SiteApp'
import { organisationJsonLd } from '@/lib/seo/jsonld'
import { JsonLd } from '@/components/seo/JsonLd'
import { wantsPreview } from '@/lib/content/preview'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const bundle = await siteBundle()
  const settings = bundle.settings
  return {
    title: 'Axis Journeys — Maldives holiday specialists, Dubai',
    description:
      settings?.who ||
      'Dubai-based Maldives holiday specialists. Seamless journeys, timeless memories — hand-picked resorts, seaplane and speedboat transfers, and a specialist who replies in under an hour.',
    alternates: { canonical: '/' },
    openGraph: {
      title: 'Axis Journeys — Seamless Journeys, Timeless Memories',
      description: settings?.promise || 'Hand-picked Maldives resorts, arranged by a Dubai-based specialist.',
      images: bundle.homepage?.heroPoster ? [{ url: bundle.homepage.heroPoster }] : undefined,
      url: '/',
    },
  }
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const bundle = await siteBundle(await wantsPreview(searchParams))
  return (
    <>
      <JsonLd data={organisationJsonLd(bundle)} />
      <SiteApp bundle={bundle} />
    </>
  )
}
