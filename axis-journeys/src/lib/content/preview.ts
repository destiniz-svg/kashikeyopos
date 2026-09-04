/**
 * `?preview=1` serves unpublished drafts.
 *
 * It is a read on the content plane, so it needs a CMS session — otherwise the flag would be a way
 * for anybody to read every draft the team is still writing. Without one the page renders the
 * published site, which is the honest fallback: the URL still works, it just shows what is live.
 */
import { currentActor } from '../http/request'

export async function wantsPreview(searchParams?: Promise<Record<string, string | string[] | undefined>>): Promise<boolean> {
  if (!searchParams) return false
  const params = await searchParams
  if (params.preview !== '1') return false
  return !!(await currentActor())
}
