/**
 * The business rules from `prototype/admin/api.js`, ported unchanged.
 *
 * They live here rather than in a route handler because three callers need the same answer: the
 * publish endpoint (which refuses 422), the public bundle (which filters with the same rule), and
 * the CMS completeness bar (which tells an editor what is still missing). Two implementations of
 * "is this ready" is how a property publishes and then fails to render.
 */
import type { Doc, DocStatus, Offer, Property } from './types'

export interface Readiness { ready: boolean; missing: string[] }

/** A property is site-ready when it can render the full profile the public site expects. */
export function readiness(p: Partial<Property> | null | undefined): Readiness {
  const miss: string[] = []
  if (!p) return { ready: false, missing: ['document'] }
  if (!(p.name || '').trim()) miss.push('name')
  if (!(p.dest || '').trim()) miss.push('destination')
  if (!(p.area || '').trim()) miss.push('area')
  if (!(p.verdict || '').trim()) miss.push('verdict')
  if (!(p.transferShort || '').trim()) miss.push('transfer summary')
  if (!(p.img || '').trim()) miss.push('hero photo')
  if (!Array.isArray(p.villas) || !p.villas.length) miss.push('at least one room type')
  if (!Array.isArray(p.days) || !p.days.length) miss.push('day-by-day itinerary')
  if (!Array.isArray(p.transfers) || !p.transfers.length) miss.push('transfer options')
  if (!Array.isArray(p.themes) || !p.themes.length) miss.push('themes')
  return { ready: miss.length === 0, missing: miss }
}

/** Never publish, and never serve, a document still carrying the legacy stub flags. */
export const isSiteReady = (p: Partial<Property> | null | undefined): boolean =>
  !!p && !p.draft && !p.detailPending && readiness(p).ready

/** An offer is publishable once it names a property that exists, and carries its own copy. */
export function validateOffer(o: Partial<Offer> | null | undefined, propertyIds: Set<string>): string[] {
  const miss: string[] = []
  if (!o?.resort || !propertyIds.has(o.resort)) miss.push('a property')
  if (!(o?.badge || '').trim()) miss.push('badge')
  if (!(o?.date || '').trim()) miss.push('departure/validity')
  if (!(o?.perk || '').trim()) miss.push('perks')
  return miss
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Derived, never stored: a cached status column is a status that goes stale. */
export function docStatus<T>(d: Pick<Doc<T>, 'draft' | 'live'>): DocStatus {
  if (!d.live) return 'draft'
  return eq(d.draft, d.live) ? 'published' : 'changed'
}
