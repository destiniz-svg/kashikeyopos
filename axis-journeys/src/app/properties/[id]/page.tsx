/**
 * A property's own page. Opened from the home page it is a drawer over the funnel; loaded directly
 * it is this route, which renders the same drawer over the same page — one implementation, two
 * entrances, and a URL a guest can share either way.
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { siteBundle } from '@/lib/content/bundle-service'
import { SiteApp } from '@/components/site/SiteApp'
import { JsonLd } from '@/components/seo/JsonLd'
import { propertyJsonLd } from '@/lib/seo/jsonld'
import { wantsPreview } from '@/lib/content/preview'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const bundle = await siteBundle()
  const p = bundle.properties.find((x) => x.id === id)
  if (!p) return { title: 'Property not found' }
  return {
    title: `${p.name} — ${p.dest}`,
    description: (p.verdict || p.about || '').slice(0, 300),
    alternates: { canonical: `/properties/${p.id}` },
    openGraph: {
      title: `${p.name} · ${p.dest} · Axis Journeys`,
      description: (p.verdict || '').slice(0, 300),
      images: p.img ? [{ url: p.img }] : undefined,
      url: `/properties/${p.id}`,
    },
  }
}

export default async function PropertyRoute({ params, searchParams }: Params) {
  const { id } = await params
  const bundle = await siteBundle(await wantsPreview(searchParams))
  const p = bundle.properties.find((x) => x.id === id)
  // A property that is not site-ready is not in the bundle at all, so this is a genuine 404 rather
  // than a page that renders half a profile.
  if (!p) notFound()
  return (
    <>
      <JsonLd data={propertyJsonLd(bundle, p)} />
      <SiteApp bundle={bundle} propertyId={p.id} />
    </>
  )
}
