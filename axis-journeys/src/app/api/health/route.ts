/** `GET /api/health` — the process is up. Cheap enough for a load-balancer to ask constantly. */
import { json, route } from '@/lib/http/respond'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

export const GET = route('health', async () =>
  json({ ok: true, stage: config.stage, at: new Date().toISOString() }),
)
