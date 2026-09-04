/** `GET /api/auth/me` — who is signed in, and what they may do. */
import { ROLES } from '@/lib/auth/roles'
import { currentActor } from '@/lib/http/request'
import { json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const GET = route('auth/me', async () => {
  const actor = await currentActor()
  if (!actor) return json({ user: null }, { status: 200 })
  return json({
    user: { id: actor.sub, name: actor.name, email: actor.email, role: actor.role, can: ROLES[actor.role].can },
  })
})
