/**
 * `/offers` — the offers on their own URL, for a campaign link or a share.
 *
 * It renders the same home page and asks it to open on the Offers tab: the offers section is part
 * of the funnel, and a standalone list that behaves differently from the one on the home page is
 * two implementations of one screen.
 */
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Offers — rates negotiated for you',
  description: 'The only rates Axis Journeys publishes, agreed directly with our partner resorts. Every offer is subject to availability.',
  alternates: { canonical: '/#offers' },
}

export default function OffersRoute() {
  redirect('/#offers')
}
