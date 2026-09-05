'use client'

/**
 * The site, assembled.
 *
 * Home renders the long-scroll funnel; a destination renders its own page in place of it. The
 * drawer, the overlays, the dock and the footer are shared by both, exactly as the prototype's DOM
 * order has them.
 */
import type { SiteBundle } from '@/lib/content/types'
import { css } from '@/components/ui/css'
import { Drawer } from './Drawer'
import { SiteProvider, useSite } from './state'
import { Header } from './sections/Header'
import { MobileMenu } from './sections/MobileMenu'
import { Hero } from './sections/Hero'
import { Destinations, TrustStrip } from './sections/Destinations'
import { Selection } from './sections/Selection'
import { Experiences } from './sections/Experiences'
import { Properties } from './sections/Properties'
import { Offers } from './sections/Offers'
import { AboutAxis, CtaBand, Story, Voices } from './sections/Story'
import { Footer, MobileDock } from './sections/Footer'
import { LegalModal, Lightbox, Toast } from './sections/Overlays'
import { DestinationPage } from './sections/DestinationPage'
import { PropertyPage } from './sections/PropertyPage'
import { ByAtoll, Compared, Guides, HomeFaq, WhyAxis } from './sections/HomeSections'

export interface SiteAppProps {
  bundle: SiteBundle
  destination?: string | null
  /** `/properties/<id>` — the property's own page, in place of the home funnel. */
  propertyPage?: string | null
}

export function SiteApp({ bundle, destination = null, propertyPage = null }: SiteAppProps) {
  return (
    <SiteProvider bundle={bundle} initialPage={destination} initialPropertyPage={propertyPage}>
      <Shell />
    </SiteProvider>
  )
}

function Shell() {
  const { state: s } = useSite()
  const propertyOnPage = s.propPage ? s.bundle.properties.find((p) => p.id === s.propPage) || null : null

  return (
    <div style={css("min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--font-body),'Mona Sans',system-ui,sans-serif;overflow-x:hidden;")}>
      {/* The first tab stop on the page: a keyboard user should not have to walk the whole header
          and mega menu to reach the collection. */}
      <a className="skip-link" href={propertyOnPage ? '#pp-villas' : s.page ? '#dp-props' : '#properties'}>
        Skip to the collection
      </a>
      <Header />
      <MobileMenu />

      {/* A destination page and a property page carry their own <main>; the home funnel had none, so
          the skip link landed a screen-reader user in a document with no main region to be in.

          The home order is the handoff's own numbering, 01 to 13: the sequence is an argument
          rather than a stack of sections, and each section's kicker says where a reader is in it. */}
      {propertyOnPage ? (
        <PropertyPage p={propertyOnPage} />
      ) : s.page ? (
        <DestinationPage name={s.page} />
      ) : (
        <main>
          <Hero />
          <Destinations />
          <TrustStrip />
          <WhyAxis />
          <Selection />
          <Experiences />
          <Properties />
          <ByAtoll />
          <Compared />
          <Offers />
          <Story />
          <AboutAxis />
          <Voices />
          <Guides />
          <HomeFaq />
          <CtaBand />
        </main>
      )}

      <Footer />
      {/* The property page has a conversion bar on that same edge; two bars stacked on a phone is
          one of them covering the other. */}
      {!propertyOnPage && <MobileDock />}
      <Toast />
      <LegalModal />
      <Lightbox />
      <Drawer />
    </div>
  )
}
