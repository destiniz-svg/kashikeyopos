/**
 * Make a stored asset path usable from any route.
 *
 * The catalogue carries paths as the prototype wrote them — `assets/video/maldives-sd.mp4` — which
 * was unambiguous when every screen lived at `/`. This build has real routes, so the same string
 * resolves to `/properties/assets/video/…` on a property page and 404s. The hero video was silently
 * broken on every property and destination page for exactly that reason.
 *
 * Fixing it in the content would fix today's rows and not tomorrow's: the CMS's own field says
 * "/assets/video/… or https://…mp4", so an editor may reasonably type either form. So it is fixed
 * where the value is used, once, and it leaves absolute URLs, protocol-relative URLs, data URIs and
 * already-rooted paths exactly as they are.
 */

/** Anything that already names its own origin or root. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i

export function assetUrl(value: string | null | undefined): string {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if (ABSOLUTE.test(v)) return v
  return '/' + v.replace(/^\.\//, '')
}
