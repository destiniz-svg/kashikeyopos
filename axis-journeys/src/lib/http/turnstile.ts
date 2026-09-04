/**
 * Cloudflare Turnstile verification.
 *
 * The seam is honest in all three states: verified, refused, and not configured. With no secret the
 * form still works and the answer says the check did not run — a bot fence that silently is not
 * there is worse than none, because somebody believes in it. `TURNSTILE_REQUIRED=1` (the production
 * default) turns "not configured" into a refusal rather than a shrug.
 */
import { config } from './../config'
import { log } from './log'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export interface TurnstileResult {
  ok: boolean
  /** What the caller may be told. Never the provider's verbatim answer. */
  reason: string
  ran: boolean
}

export async function verifyTurnstile(token: string, ip: string, fetchImpl: typeof fetch = fetch): Promise<TurnstileResult> {
  if (!config.turnstile.secret) {
    if (config.turnstile.required) return { ok: false, reason: 'The bot check is not configured on this install', ran: false }
    return { ok: true, reason: 'no bot check is configured on this install', ran: false }
  }
  if (!token) return { ok: false, reason: 'Please complete the human check and try again', ran: true }

  const body = new URLSearchParams({ secret: config.turnstile.secret, response: token, remoteip: ip })
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] }
    if (data?.success) return { ok: true, reason: 'verified', ran: true }
    // The provider's codes name our own configuration as often as the caller, so they go to the log
    // and the caller is told the one thing they can act on.
    log.warn('turnstile', 'verification refused', { codes: (data?.['error-codes'] || []).join(',') })
    return { ok: false, reason: 'Please complete the human check and try again', ran: true }
  } catch (e) {
    // A verifier we cannot reach must not take the enquiry form down: a guest with a trip to plan
    // is the person this costs. It is logged and the request proceeds.
    log.error('turnstile', 'verifier unreachable', { detail: (e as Error).message })
    return { ok: true, reason: 'the bot check could not be reached', ran: false }
  }
}
