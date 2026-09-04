/**
 * CMS sessions: an HMAC-signed token in an HttpOnly cookie.
 *
 * Never localStorage — SECURITY.md says so, and a token a script can read is a token an injected
 * script can take. The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`, which with the
 * `X-Requested-With` check on writes is the CSRF fence.
 *
 * The token carries a `ver` claim taken from the user's own `tokenVersion`, so "sign out
 * everywhere" is a single increment and every token minted before it is refused — a revocation
 * that is recorded but not read is not a revocation.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import type { Role } from './roles'

export interface SessionClaims {
  /** user id */
  sub: string
  name: string
  email: string
  role: Role
  /** token version, compared against the user record */
  ver: number
  /** issued at, seconds */
  iat: number
  /** expires at, seconds */
  exp: number
  /** token id, for the audit trail */
  jti: string
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const unb64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function key(): string {
  const k = config.auth.secret
  if (k.length >= 32) return k
  if (config.isProd) throw new Error('SESSION_SECRET is not set — refusing to sign a session')
  // Development only, and it changes per process, so a restart signs everyone out rather than
  // letting a well-known key become the thing somebody forgets to replace.
  return devKey
}
const devKey = randomUUID() + randomUUID()

const sign = (data: string): string => b64url(createHmac('sha256', key()).update(data).digest())

export function issueToken(user: { id: string; name: string; email: string; role: Role; tokenVersion?: number }): {
  token: string
  claims: SessionClaims
} {
  const iat = Math.floor(Date.now() / 1000)
  const claims: SessionClaims = {
    sub: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    ver: user.tokenVersion ?? 0,
    iat,
    exp: iat + config.auth.ttlHours * 3600,
    jti: randomUUID(),
  }
  const payload = b64url(JSON.stringify(claims))
  return { token: `${payload}.${sign(payload)}`, claims }
}

/**
 * Verify shape, signature and expiry. An expired token is refused exactly like a forged one here:
 * this is a credential plane, and "old" and "wrong" are the same answer to the door.
 */
export function readToken(token: string | null | undefined): SessionClaims | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const expected = sign(payload)
  if (mac.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  let claims: SessionClaims
  try {
    claims = JSON.parse(unb64url(payload).toString('utf8')) as SessionClaims
  } catch {
    return null
  }
  if (!claims || typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  return claims
}

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}
