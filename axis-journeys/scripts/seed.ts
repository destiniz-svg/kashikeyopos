/**
 * `npm run seed` — put the catalogue into whichever store the environment names, and create the
 * first owner account if one is configured and the workspace has none.
 *
 * Safe to run twice: an existing document is left alone unless `--force` is given.
 */
import { seedWorkspace } from '../src/lib/content/seed'
import { ensureFirstOwner } from '../src/lib/auth/users'
import { getStore } from '../src/lib/store'
import { config } from '../src/lib/config'

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const health = await getStore().health()
  if (!health.ok) {
    console.error(`[seed] the store is not usable: ${health.detail}`)
    process.exitCode = 1
    return
  }
  console.log(`[seed] ${health.detail}${force ? ' · replacing existing documents' : ''}`)

  const report = await seedWorkspace({ force })
  console.log(
    `[seed] ${report.properties} properties (${report.published} site-ready and published), ` +
      `${report.offers} offers, ${report.destinations} destinations`,
  )

  const owner = await ensureFirstOwner()
  console.log(`[seed] owner account: ${owner.reason}`)
  if (!owner.created && config.isProd) {
    console.log('[seed] nobody can sign in to the CMS until an owner exists — set ADMIN_OWNER_EMAIL and ADMIN_OWNER_PASSWORD')
  }
}

main().catch((e) => {
  console.error('[seed] failed:', (e as Error).message)
  process.exitCode = 1
})
