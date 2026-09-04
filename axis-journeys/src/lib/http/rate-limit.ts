/**
 * The doorman on the open doors.
 *
 * Two buckets on the endpoints anybody on the internet may call, and both must have room: an
 * IDENTITY bucket keyed on who the request is about (the email, hashed before it is held) so one
 * address cannot be hammered from many addresses, and an IP bucket several times wider, because a
 * hotel's wifi puts a whole lobby behind one address and a doorman that cannot tell forty guests
 * from one attacker locks out the guests.
 *
 * In memory, on purpose: one process, minute-wide windows, and it fails open on a restart — the
 * correct failure. If this ever runs as replicas this is the one seam to move onto Cloudflare Rate
 * Limiting or a KV counter; nothing else changes.
 */
import { createHash } from 'node:crypto'
import { config } from '../config'

interface Bucket { hits: number[] }
const buckets = new Map<string, Bucket>()
let lastSweep = 0

/** Identities are hashed before they are held: a rate-limit table is not a customer list. */
export const identityKey = (v: string): string =>
  createHash('sha256').update(String(v || '').toLowerCase()).digest('hex').slice(0, 32)

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [k, b] of buckets) {
    if (!b.hits.length || now - b.hits[b.hits.length - 1] > 24 * 3600_000) buckets.delete(k)
  }
}

export interface Verdict {
  ok: boolean
  /** Seconds until the caller may try again. */
  retryAfter: number
}

/** Does this key have room? Asked before the work; `charge` is what spends it. */
export function room(key: string, max: number, windowMs: number): Verdict {
  const now = Date.now()
  sweep(now)
  const ceiling = Math.max(1, Math.round(max * config.limits.scale))
  const b = buckets.get(key)
  if (!b) return { ok: true, retryAfter: 0 }
  b.hits = b.hits.filter((t) => now - t < windowMs)
  if (b.hits.length < ceiling) return { ok: true, retryAfter: 0 }
  const oldest = b.hits[0]
  return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) }
}

export function charge(key: string): void {
  const b = buckets.get(key) ?? { hits: [] }
  b.hits.push(Date.now())
  buckets.set(key, b)
}

/** Room plus charge in one call, for the ordinary case where every attempt counts. */
export function take(key: string, max: number, windowMs: number): Verdict {
  const v = room(key, max, windowMs)
  if (v.ok) charge(key)
  return v
}

/** The ceilings SECURITY.md states, in one place so a route cannot invent its own. */
export const LIMITS = {
  enquiryIp: { max: 20, windowMs: 60_000 },
  enquiryIdentity: { max: 5, windowMs: 60_000 },
  enquiryDaily: { max: 20, windowMs: 24 * 3600_000 },
  newsletterIp: { max: 10, windowMs: 60_000 },
  loginIp: { max: 8, windowMs: 10 * 60_000 },
  loginIdentity: { max: 8, windowMs: 10 * 60_000 },
  api: { max: 300, windowMs: 60_000 },
} as const

/** Test support. The application never calls this. */
export function resetLimits(): void {
  buckets.clear()
}
