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

export interface SiteAppProps {
  bundle: SiteBundle
  destination?: string | null
  propertyId?: string | null
  offerId?: string | null
}

export function SiteApp({ bundle, destination = null, propertyId = null, offerId = null }: SiteAppProps) {
  return (
    <SiteProvider bundle={bundle} initialPage={destination} initialPropertyId={propertyId} initialOfferId={offerId}>
      <Shell />
    </SiteProvider>
  )
}

function Shell() {
  const { state: s } = useSite()

  return (
    <div style={css("min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--font-body),'Mona Sans',system-ui,sans-serif;overflow-x:hidden;")}>
      {/* The first tab stop on the page: a keyboard user should not have to walk the whole header
          and mega menu to reach the collection. */}
      <a className="skip-link" href={s.page ? '#dp-props' : '#properties'}>
        Skip to the collection
      </a>
      <Header />
      <MobileMenu />

      {s.page ? (
        <DestinationPage name={s.page} />
      ) : (
        <>
          <Hero />
          <Destinations />
          <TrustStrip />
          <Selection />
          <Experiences />
          <Properties />
          <Offers />
          <Story />
          <AboutAxis />
          <Voices />
          <CtaBand />
        </>
      )}

      <Footer />
      <MobileDock />
      <Toast />
      <LegalModal />
      <Lightbox />
      <Drawer />
    </div>
  )
}
