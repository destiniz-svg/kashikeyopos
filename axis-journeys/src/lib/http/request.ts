/**
 * What a route needs to know about the request in front of it: who is calling, from where, and
 * whether the body is a shape it can trust.
 */
import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'
import { config } from '../config'
import { readToken, type SessionClaims } from '../auth/session'
import { can, type Permission } from '../auth/roles'
import { getUser } from '../auth/users'
import { badRequest, forbidden, unauthorized } from './respond'

/**
 * The caller's address. Cloudflare's own header is preferred where it is present and trusted;
 * `x-forwarded-for` is client-settable at the origin, so it is only read when the deployment says
 * it sits behind a proxy that rewrites it.
 */
export function clientIp(req: NextRequest): string {
  const cf = req.headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('x-real-ip')?.trim() || '0.0.0.0'
}

/** Body, capped and parsed. An oversized or malformed body is a 400, never a stack trace. */
export async function readJson(req: NextRequest, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') || 0)
  if (declared > maxBytes) throw badRequest('That request is too large')
  let text: string
  try {
    text = await req.text()
  } catch {
    throw badRequest('Could not read the request body')
  }
  if (text.length > maxBytes) throw badRequest('That request is too large')
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw badRequest('That request body is not valid JSON')
  }
}

/**
 * CSRF. There is one cookie and it is SameSite=Lax, which stops a cross-site form post; the header
 * check is the second belt, because a header cannot be set by a plain form and a cross-origin
 * fetch that tries is stopped by the preflight. Same-origin requests are allowed by Origin as well.
 */
export function assertSameOrigin(req: NextRequest): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const origin = req.headers.get('origin')
  if (origin) {
    const allowed = new Set([config.siteUrl, config.apiOrigin].filter(Boolean))
    // A same-host request is allowed whatever the configured site URL is, so a deploy behind a
    // preview hostname does not refuse its own admin.
    const host = req.headers.get('host')
    if (host) allowed.add(`https://${host}`).add(`http://${host}`)
    if (!allowed.has(origin)) throw forbidden('Cross-site request refused')
  }
  if (req.headers.get('x-requested-with') !== 'axis') throw forbidden('Cross-site request refused')
}

export interface Actor extends SessionClaims {}

/** The signed-in user, or null. The token's `ver` is checked against the record on every call. */
export async function currentActor(): Promise<Actor | null> {
  const jar = await cookies()
  const claims = readToken(jar.get(config.auth.cookieName)?.value)
  if (!claims) return null
  const user = await getUser(claims.sub)
  if (!user) return null
  if ((user.tokenVersion ?? 0) !== claims.ver) return null
  // The record wins over the token for role and name: a demotion takes effect at once rather than
  // when the token happens to expire.
  return { ...claims, role: user.role, name: user.name, email: user.email }
}

export async function requireActor(): Promise<Actor> {
  const actor = await currentActor()
  if (!actor) throw unauthorized('Sign in to continue')
  return actor
}

/** The rank gate. Every admin route calls it; the store has no second opinion to fall back on. */
export async function need(perm: Permission): Promise<Actor> {
  const actor = await requireActor()
  if (!can(actor.role, perm)) throw forbidden(`That needs the ${perm} permission`)
  return actor
}
