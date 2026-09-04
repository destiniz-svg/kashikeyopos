/**
 * A destination's own page. `/destinations/maldives` is a real URL with its own title, description,
 * canonical and JSON-LD — the structural gap ARCHITECTURE.md names in the prototype's hash routing.
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { siteBundle } from '@/lib/content/bundle-service'
import { SiteApp } from '@/components/site/SiteApp'
import { JsonLd } from '@/components/seo/JsonLd'
import { destinationJsonLd } from '@/lib/seo/jsonld'
import { wantsPreview } from '@/lib/content/preview'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const bundle = await siteBundle()
  const dest = bundle.destinations.find((d) => d.slug === slug)
  if (!dest) return { title: 'Destination not found' }
  return {
    title: `${dest.name} — hand-picked resorts and journeys`,
    description: dest.intro?.slice(0, 300) || dest.tagline,
    alternates: { canonical: `/destinations/${dest.slug}` },
    // A destination that is not live yet is real content the team is still preparing; it renders
    // for anybody with the link and stays out of the index until it is published.
    robots: dest.live ? undefined : { index: false, follow: true },
    openGraph: {
      title: `${dest.name} · Axis Journeys`,
      description: dest.tagline,
      images: dest.hero ? [{ url: dest.hero }] : undefined,
      url: `/destinations/${dest.slug}`,
    },
  }
}

export default async function DestinationRoute({ params, searchParams }: Params) {
  const { slug } = await params
  const bundle = await siteBundle(await wantsPreview(searchParams))
  const dest = bundle.destinations.find((d) => d.slug === slug)
  if (!dest) notFound()
  return (
    <>
      <JsonLd data={destinationJsonLd(bundle, dest)} />
      <SiteApp bundle={bundle} destination={dest.name} />
    </>
  )
}
