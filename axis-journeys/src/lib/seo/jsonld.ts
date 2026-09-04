/**
 * Structured data, composed from the published bundle.
 *
 * Every value here is a fact the business has already stated somewhere on the page — the licence,
 * the address, the transfer, the collection. Nothing is invented for the crawler's benefit: a
 * rating or a price in JSON-LD that the page does not carry is a rich result the site cannot back.
 */
import { config } from '../config'
import type { Destination, Property, SiteBundle } from '../content/types'

const abs = (path: string): string => new URL(path, config.siteUrl).toString()

export function organisationJsonLd(bundle: SiteBundle): Record<string, unknown> {
  const s = bundle.settings
  return {
    '@context': 'https://schema.org',
    '@type': 'TravelAgency',
    '@id': abs('/#organisation'),
    name: 'Axis Journeys',
    legalName: s?.company || 'Axis Link LLC-FZ',
    url: config.siteUrl,
    logo: abs('/assets/logo.png'),
    description: s?.who,
    slogan: 'Seamless Journeys, Timeless Memories.',
    telephone: s?.phoneHref,
    email: s?.email,
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Meydan Grandstand, 6th Floor, Al Meydan Rd, Nad Al Sheba',
      addressLocality: 'Dubai',
      addressCountry: 'AE',
    },
    identifier: s?.licence ? { '@type': 'PropertyValue', name: 'Trade License', value: s.licence } : undefined,
    sameAs: Object.values(s?.social || {}).filter(Boolean),
    areaServed: bundle.destinations.filter((d) => d.live).map((d) => ({ '@type': 'Country', name: d.name })),
  }
}

export function destinationJsonLd(bundle: SiteBundle, dest: Destination): Record<string, unknown> {
  const properties = bundle.properties.filter((p) => p.dest === dest.name)
  return {
    '@context': 'https://schema.org',
    '@type': 'TouristDestination',
    '@id': abs(`/destinations/${dest.slug}#destination`),
    name: dest.name,
    description: dest.intro || dest.tagline,
    url: abs(`/destinations/${dest.slug}`),
    image: dest.hero,
    touristType: [...new Set(properties.flatMap((p) => p.themes))],
    includesAttraction: properties.slice(0, 20).map((p) => ({
      '@type': 'LodgingBusiness',
      name: p.name,
      url: abs(`/properties/${p.id}`),
    })),
  }
}

export function propertyJsonLd(bundle: SiteBundle, p: Property): Record<string, unknown> {
  const offers = bundle.offers.filter((o) => o.resort === p.id && o.from)
  return {
    '@context': 'https://schema.org',
    '@type': 'Resort',
    '@id': abs(`/properties/${p.id}#property`),
    name: p.name,
    description: p.verdict || p.about,
    url: abs(`/properties/${p.id}`),
    image: p.img ? [p.img, ...(p.gallery || []).slice(0, 5).map((g) => g.img)] : undefined,
    address: { '@type': 'PostalAddress', addressLocality: p.area, addressCountry: countryOf(p.dest) },
    amenityFeature: (p.amenities || []).map((a) => ({ '@type': 'LocationFeatureSpecification', name: a })),
    numberOfRooms: (p.villas || []).length || undefined,
    // A price only appears where the business has actually published one — an offer's own
    // from-rate. Everything else on this site is quoted against live availability.
    makesOffer: offers.map((o) => ({
      '@type': 'Offer',
      name: o.title || o.badge,
      priceCurrency: 'USD',
      price: o.from,
      availability: 'https://schema.org/LimitedAvailability',
      validThrough: undefined,
      description: o.perk,
    })),
    provider: { '@id': abs('/#organisation') },
  }
}

/** The destinations this agency sells, mapped to ISO codes for structured data. */
function countryOf(dest: string): string | undefined {
  const map: Record<string, string> = { Maldives: 'MV', 'Sri Lanka': 'LK', UAE: 'AE' }
  return map[dest]
}

export function breadcrumbJsonLd(trail: { name: string; path: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: abs(t.path) })),
  }
}
