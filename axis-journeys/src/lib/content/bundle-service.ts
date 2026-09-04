/**
 * The public bundle as the site actually receives it: media references resolved, and — for a
 * preview — drafts instead of live documents.
 *
 * One function, called by the API route and by every server-rendered page, so a page's first paint
 * and the client's later re-fetch can never be composed from two different rules.
 */
import { composeBundle, listMedia, readBundle } from './repository'
import { buildMediaIndex, resolveMediaRefs } from '../media/resolve'
import type { SiteBundle } from './types'

export async function siteBundle(preview = false): Promise<SiteBundle> {
  const bundle = preview ? await composeBundle(true) : await readBundle()
  const index = buildMediaIndex(await listMedia())
  // Nothing to resolve on a store whose content still points at the resort CDN, which is the
  // ordinary case — the walk is over a bundle already in memory and costs a pass, not a query.
  return index.size ? resolveMediaRefs(bundle, index) : bundle
}
