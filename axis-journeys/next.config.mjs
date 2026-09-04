import { securityHeaders, longCacheHeaders, noStoreHeaders } from './src/lib/http/headers.mjs'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: a self-contained Node server for AWS (App Runner / ECS / Lambda web adapter),
  // fronted by Cloudflare for DNS, CDN, WAF and TLS. See DEPLOYMENT.md.
  output: 'standalone',
  // This app is a workspace inside a larger repository; name the root so tracing does not walk out
  // of it and pull an unrelated project's files into the server bundle.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  reactStrictMode: true,
  // No agent-rules file: this repository documents itself in its own README and docs/.
  agentRules: false,
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  images: {
    // Remote photography lives on the resort CDN and Unsplash; both are pinned in the CSP too.
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'axisjourneys.com' },
      { protocol: 'https', hostname: 'media.axisjourneys.com' },
      { protocol: 'https', hostname: 'www.sunsiyam.com' },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders() },
      { source: '/assets/:path*', headers: longCacheHeaders() },
      { source: '/admin/:path*', headers: noStoreHeaders() },
    ]
  },
  async redirects() {
    return [
      // The prototype's _redirects mapped pretty URLs onto hash routes. Production has real routes,
      // so the hash forms are kept working for anything already printed or linked.
      { source: '/login', destination: '/admin/login', permanent: false },
      { source: '/property/:id', destination: '/properties/:id', permanent: true },
      { source: '/destination/:slug', destination: '/destinations/:slug', permanent: true },
    ]
  },
}

export default nextConfig
