/**
 * A property's own page — the long form.
 *
 * One address per property, which is the handoff's own map (`prototype/_redirects` sends
 * `/properties/:id` at the property page) and the URL every share link, sitemap entry and canonical
 * already points at. `/property/:id`, which the spec writes, redirects here.
 *
 * The drawer is not a second address: it is an overlay opened from a card, and it borrows this URL
 * while it is open so Back closes it. Reloading there gives the full page, which is the same
 * property answered at greater length rather than a different document.
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { siteBundle } from '@/lib/content/bundle-service'
import { SiteApp } from '@/components/site/SiteApp'
import { JsonLd } from '@/components/seo/JsonLd'
import { breadcrumbJsonLd, propertyJsonLd } from '@/lib/seo/jsonld'
import { wantsPreview } from '@/lib/content/preview'
import type { SiteBundle } from '@/lib/content/types'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }

/** The destination's slug, so the breadcrumb's middle rung points at a page the site serves. */
const destSlug = (bundle: SiteBundle, name: string): string =>
  bundle.destinations.find((d) => d.name === name)?.slug ?? ''

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const bundle = await siteBundle()
  const p = bundle.properties.find((x) => x.id === id)
  if (!p) return { title: 'Property not found' }
  return {
    title: `${p.name} — ${p.area}, ${p.dest}`,
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
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Axis Journeys', path: '/' },
          { name: p.dest, path: `/destinations/${destSlug(bundle, p.dest)}` },
          { name: p.name, path: `/properties/${p.id}` },
        ])}
      />
      <SiteApp bundle={bundle} propertyPage={p.id} />
    </>
  )
}
