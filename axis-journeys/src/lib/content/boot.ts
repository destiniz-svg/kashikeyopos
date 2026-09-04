/**
 * Bringing an empty workspace up on first boot.
 *
 * The AWS deploy seeds from a checkout — an operator runs `npm run seed` once against the table and
 * that is the end of it. A container whose store is a mounted disk cannot do that: the runtime image
 * carries the standalone server and no source, so there is no `scripts/seed.ts` inside it to run.
 * Without this, a fresh volume means a site with no catalogue and a CMS nobody can sign in to, and
 * the only remedy is a shell in a container that was built not to need one.
 *
 * So it is gated (`SEED_ON_BOOT`), idempotent on both halves — an existing document is left alone,
 * and the owner account is created only when the workspace has no users at all — and it reports
 * what it did rather than being silent about writing a catalogue into somebody's store.
 *
 * It deliberately does NOT bring the process down when it fails. A store that is briefly
 * unreachable at boot is a store that will be reachable in a moment, and `/api/ready` is what says
 * whether this instance can serve a guest; a crash loop would take that answer away.
 */
import { config } from '../config'
import { log } from '../http/log'
import { getStore } from '../store'

let done = false

export async function bootstrapWorkspace(): Promise<void> {
  if (!config.seedOnBoot || done) return
  done = true

  const health = await getStore().health()
  if (!health.ok) {
    log.error('boot', 'the store is not usable, so the workspace was not seeded', { detail: health.detail })
    return
  }

  try {
    // Imported here rather than at the top so the catalogue is only pulled into memory on an
    // install that asked for this.
    const [{ seedWorkspace }, { ensureFirstOwner }] = await Promise.all([import('./seed'), import('../auth/users')])
    const report = await seedWorkspace({ force: false })
    const owner = await ensureFirstOwner()
    log.info('boot', 'workspace ready', {
      store: health.detail,
      properties: report.properties,
      published: report.published,
      offers: report.offers,
      destinations: report.destinations,
      owner: owner.reason,
    })
  } catch (e) {
    log.error('boot', 'the workspace could not be seeded', { detail: (e as Error).message })
  }
}
