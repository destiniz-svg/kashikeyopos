/**
 * The CMS shell.
 *
 * It carries its own stylesheet — Axis Studio is Outfit-only, dark-first, with `--field` for
 * inputs — and is never indexed: the headers say `noindex` and `no-store`, and robots.txt
 * disallows it. That is three fences for the same thing, which is the right number for an
 * operator surface.
 */
import type { Metadata } from 'next'
import './admin.css'

export const metadata: Metadata = {
  title: { default: 'Axis Studio', template: '%s · Axis Studio' },
  robots: { index: false, follow: false, nocache: true },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="axis-studio">{children}</div>
}
