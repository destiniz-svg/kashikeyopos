/**
 * The document shell.
 *
 * Two things happen here that cannot happen anywhere else: the theme is settled before first paint
 * (a theme applied after hydration is a white flash on a navy site), and the CSP nonce minted by
 * the middleware is handed to React so the streaming runtime's own inline script is allowed.
 */
import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { Outfit, Mona_Sans } from 'next/font/google'
import { config } from '@/lib/config'
import './globals.css'

// Self-hosted at build time: no request to a third party, no CSP entry for a font CDN, and the
// two families are preloaded with `font-display: swap` — ARCHITECTURE.md's own recommendation.
const outfit = Outfit({ subsets: ['latin'], weight: ['300', '400', '500', '600'], variable: '--font-display', display: 'swap' })
const mona = Mona_Sans({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-body', display: 'swap' })

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The page paints navy in dark and ivory in light; the browser chrome follows.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#00102F' },
    { media: '(prefers-color-scheme: light)', color: '#F7F5F0' },
  ],
}

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: {
    default: 'Axis Journeys — Maldives holiday specialists, Dubai',
    template: '%s · Axis Journeys',
  },
  description:
    'Dubai-based Maldives holiday specialists. Seamless journeys, timeless memories — hand-picked resorts, seaplane and speedboat transfers, and a specialist who replies in under an hour.',
  applicationName: 'Axis Journeys',
  authors: [{ name: 'Axis Link LLC-FZ' }],
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Axis Journeys',
    locale: 'en_AE',
    url: config.siteUrl,
  },
  twitter: { card: 'summary_large_image' },
  icons: { icon: '/assets/logomark.png', apple: '/assets/logomark.png' },
}

/**
 * Settle the theme before the first paint. It reads the same key the prototype does and falls back
 * to dark, which is what the prototype's own `applyTheme()` resolves to — the brand is dark-first
 * and a light default would repaint the whole page on arrival.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('axis.theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}catch(e){document.documentElement.setAttribute('data-theme','dark')}`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang="en" data-theme="dark" className={`${outfit.variable} ${mona.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
