/**
 * `GET /api/ready` — can this instance actually serve a request?
 *
 * Ready means the store answers and the published bundle composes. A probe that only proves the
 * process started reports green on an install that cannot show a guest a single property, which is
 * the failure this endpoint exists to catch. A failure names the remedy, because a 503 that says
 * "not ready" leaves whoever is holding the pager exactly where a 200 left them.
 */
import { getStore } from '@/lib/store'
import { readBundle } from '@/lib/content/repository'
import { getMediaStore } from '@/lib/media'
import { getMailer } from '@/lib/mail'
import { configFaults, config } from '@/lib/config'
import { json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const GET = route('ready', async () => {
  const faults: string[] = [...configFaults()]
  const store = await getStore().health()
  if (!store.ok) faults.push(`the document store is unreachable: ${store.detail} — check STORE_DRIVER and its credentials`)

  let properties = 0
  let destinations = 0
  if (store.ok) {
    try {
      const bundle = await readBundle()
      properties = bundle.properties.length
      destinations = bundle.destinations.length
      // An empty store is a fresh install on its way to being seeded, not a failure — a probe that
      // never goes green there is an install that can never be set up.
      if (!bundle.settings) faults.push('the workspace has no settings document — run `npm run seed`')
    } catch (e) {
      faults.push(`the published bundle could not be composed: ${(e as Error).message} — run \`npm run seed\``)
    }
  }

  const media = await getMediaStore().health()
  if (!media.ok) faults.push(`media storage is not usable: ${media.detail}`)

  const mail = getMailer().health()
  const ok = faults.length === 0
  return json(
    {
      ok,
      stage: config.stage,
      store: store.detail,
      media: media.detail,
      // Mail being unconfigured is a stated condition, not a fault: the app says so rather than
      // pretending a notification went out.
      mail: mail.reason,
      properties,
      destinations,
      faults,
      at: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  )
})
