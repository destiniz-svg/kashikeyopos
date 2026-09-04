/**
 * `POST /api/public/newsletter` — the footer sign-up.
 *
 * It is a real subscription: the address is stored as an enquiry of source `newsletter` so it lands
 * in the same CRM a specialist already works, rather than becoming a toast over nothing. Same
 * doorman and same bot check as the enquiry form, because it is the same kind of open door.
 */
import type { NextRequest } from 'next/server'
import { clean, EMAIL_RE } from '@/lib/content/sanitize'
import { logActivity, putDoc, uid } from '@/lib/content/repository'
import type { Enquiry } from '@/lib/content/types'
import { clientIp, readJson } from '@/lib/http/request'
import { json, route, tooMany, unprocessable } from '@/lib/http/respond'
import { LIMITS, identityKey, take } from '@/lib/http/rate-limit'
import { verifyTurnstile } from '@/lib/http/turnstile'
import { log } from '@/lib/http/log'

export const dynamic = 'force-dynamic'

export const POST = route('public/newsletter', async (req: NextRequest) => {
  const ip = clientIp(req)
  const body = await readJson(req)

  if (typeof body.website === 'string' && body.website.trim()) return json({ ok: true })

  const verdict = take(`news:ip:${ip}`, LIMITS.newsletterIp.max, LIMITS.newsletterIp.windowMs)
  if (!verdict.ok) throw tooMany('Too many requests — please try again in a minute', verdict.retryAfter)

  const email = clean(body.email, 160).toLowerCase()
  if (!EMAIL_RE.test(email)) throw unprocessable('A valid email is needed', { email: 'A valid email is needed.' })

  const perDay = take(`news:id:${identityKey(email)}`, 3, 24 * 3600_000)
  // An address already on the list is told the same thing as a new one: the answer must not report
  // whether an address is known.
  if (!perDay.ok) return json({ ok: true })

  const bot = await verifyTurnstile(String(body.turnstile ?? ''), ip)
  if (!bot.ok) throw unprocessable(bot.reason)

  const id = 'q' + uid()
  const at = Date.now()
  const record: Enquiry = {
    id,
    status: 'new',
    name: clean(body.name, 80) || email.split('@')[0],
    email,
    phone: '',
    month: '',
    message: 'Newsletter sign-up from the site footer.',
    party: '',
    budget: '',
    property: '',
    propertyId: '',
    offer: '',
    shortlist: [],
    source: 'newsletter',
    assignedTo: 'Axis Maldives Specialist',
    notes: [],
    createdAt: at,
  }
  await putDoc<Enquiry>('enquiries', {
    id,
    draft: record,
    live: record,
    createdAt: at,
    updatedAt: at,
    updatedBy: 'site',
    publishedAt: at,
    order: Date.now(),
  })
  await logActivity('Site', 'Newsletter sign-up')
  log.info('public/newsletter', 'subscription recorded')
  return json({ ok: true })
})
