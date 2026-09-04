/**
 * `POST /api/auth/login`.
 *
 * Two rate-limit tiers, both charged only on failure: signing a team in correctly all morning never
 * touches the budget. The refusal is byte-identical whether the address is unknown or the password
 * is wrong — a door that answers differently is a door that enumerates the team.
 */
import type { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { authenticate } from '@/lib/auth/users'
import { cookieOptions, issueToken } from '@/lib/auth/session'
import { ROLES } from '@/lib/auth/roles'
import { logActivity } from '@/lib/content/repository'
import { assertSameOrigin, clientIp, readJson } from '@/lib/http/request'
import { httpError, json, route, tooMany } from '@/lib/http/respond'
import { LIMITS, charge, identityKey, room } from '@/lib/http/rate-limit'
import { config } from '@/lib/config'
import { log } from '@/lib/http/log'

export const dynamic = 'force-dynamic'

export const POST = route('auth/login', async (req: NextRequest) => {
  assertSameOrigin(req)
  const ip = clientIp(req)
  const body = await readJson(req)
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 160)
  const password = String(body.password ?? '').slice(0, 200)

  const ipRoom = room(`login:ip:${ip}`, LIMITS.loginIp.max, LIMITS.loginIp.windowMs)
  if (!ipRoom.ok) throw tooMany('Too many attempts — try again shortly', ipRoom.retryAfter)
  const idRoom = room(`login:id:${identityKey(email)}`, LIMITS.loginIdentity.max, LIMITS.loginIdentity.windowMs)
  if (!idRoom.ok) throw tooMany('Too many attempts — try again shortly', idRoom.retryAfter)

  const user = email && password ? await authenticate(email, password) : null
  if (!user) {
    charge(`login:ip:${ip}`)
    charge(`login:id:${identityKey(email)}`)
    log.warn('auth/login', 'refused', { ip })
    throw httpError(401, 'Email or password is incorrect')
  }

  const { token, claims } = issueToken(user)
  const jar = await cookies()
  jar.set(config.auth.cookieName, token, cookieOptions(config.auth.ttlHours * 3600))
  await logActivity(user.name, 'Signed in')
  log.info('auth/login', 'signed in', { user: user.email, role: user.role })

  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, can: ROLES[user.role].can },
    expiresAt: claims.exp * 1000,
  })
})
