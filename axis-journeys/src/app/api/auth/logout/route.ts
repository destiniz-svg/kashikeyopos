/**
 * `POST /api/auth/logout`.
 *
 * Clearing the cookie is not signing out. The browser stops sending the token, and the token goes
 * on being valid for the rest of its twelve hours — so a copy taken from a shared machine, a
 * synced profile or a proxy log still opens the CMS long after somebody believed they had left.
 *
 * The token carries a `ver` claim for exactly this, and `revokeSessions()` increments the record it
 * is compared against, so every token signed before now is refused on its next request. That means
 * signing out here signs this account out everywhere, which for an administration plane is the
 * right default and the one the screen states.
 *
 * It is deliberately safe to call twice, and safe to call with no session: a sign-out that can fail
 * is a sign-out somebody abandons half-done.
 */
import type { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { config } from '@/lib/config'
import { revokeSessions } from '@/lib/auth/users'
import { logActivity } from '@/lib/content/repository'
import { assertSameOrigin, currentActor } from '@/lib/http/request'
import { json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const POST = route('auth/logout', async (req: NextRequest) => {
  assertSameOrigin(req)
  const actor = await currentActor()
  if (actor) {
    await revokeSessions(actor.sub)
    await logActivity(actor.name, 'Signed out')
  }
  const jar = await cookies()
  jar.delete(config.auth.cookieName)
  return json({ ok: true })
})
