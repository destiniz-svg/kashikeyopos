/**
 * `POST /api/public/enquiries` — the enquiry funnel's one door, and the only place on the public
 * plane that writes a record.
 *
 * The hardening is the prototype's, ported verbatim and then given the server half it always
 * needed: honeypot, Turnstile, `sanitizeEnquiry`, rate limits on both the address and the IP, and
 * the assignee defaulting to the property's own specialist.
 */
import type { NextRequest } from 'next/server'
import { sanitizeEnquiry, enquiryFaults } from '@/lib/content/sanitize'
import { getDoc, logActivity, putDoc, uid } from '@/lib/content/repository'
import type { Doc, Enquiry, Property, Settings } from '@/lib/content/types'
import { siteBundle } from '@/lib/content/bundle-service'
import { clientIp, readJson } from '@/lib/http/request'
import { json, route, tooMany, unprocessable } from '@/lib/http/respond'
import { LIMITS, identityKey, take } from '@/lib/http/rate-limit'
import { verifyTurnstile } from '@/lib/http/turnstile'
import { getMailer } from '@/lib/mail'
import { config } from '@/lib/config'
import { log } from '@/lib/http/log'

export const dynamic = 'force-dynamic'

/** The reference a guest is shown, and quotes back to a specialist. */
export const leadRef = (id: string): string => 'AXJ-' + id.replace(/^q/, '').slice(-6).toUpperCase()

export const POST = route('public/enquiries', async (req: NextRequest) => {
  const ip = clientIp(req)
  const body = await readJson(req)

  // The honeypot: a filled `website` field is a bot. Answer 200 with a plausible id and drop the
  // record — telling a bot it was caught is telling it what to change.
  if (typeof body.website === 'string' && body.website.trim()) {
    log.info('public/enquiries', 'honeypot caught a submission', { ip })
    return json({ id: 'q' + uid(), ref: leadRef('q' + uid()) })
  }

  const ipVerdict = take(`enq:ip:${ip}`, LIMITS.enquiryIp.max, LIMITS.enquiryIp.windowMs)
  if (!ipVerdict.ok) throw tooMany('Too many requests — please try again in a minute', ipVerdict.retryAfter)

  const clean = sanitizeEnquiry(body)
  const faults = enquiryFaults(clean)
  if (Object.keys(faults).length) throw unprocessable('Name and a valid email are required', faults)

  const idKey = identityKey(clean.email)
  const perMinute = take(`enq:id:${idKey}`, LIMITS.enquiryIdentity.max, LIMITS.enquiryIdentity.windowMs)
  if (!perMinute.ok) throw tooMany('Too many requests — please try again in a minute', perMinute.retryAfter)
  const perDay = take(`enq:day:${idKey}`, LIMITS.enquiryDaily.max, LIMITS.enquiryDaily.windowMs)
  if (!perDay.ok) throw tooMany('We already have your enquiry — a specialist will be in touch', perDay.retryAfter)

  const bot = await verifyTurnstile(String(body.turnstile ?? ''), ip)
  if (!bot.ok) throw unprocessable(bot.reason)

  // The assignee is the property's own specialist where the enquiry names one. Read from the
  // document rather than from anything the browser sent: the form is open to the internet.
  let specialist = 'Axis Maldives Specialist'
  let propertyDoc: Doc<Property> | null = null
  if (clean.propertyId) {
    propertyDoc = await getDoc<Property>('properties', clean.propertyId)
    const p = propertyDoc?.live ?? propertyDoc?.draft
    if (p?.specialist) specialist = p.specialist
  }

  const id = 'q' + uid()
  const record: Enquiry = {
    id,
    status: 'new',
    notes: [],
    assignedTo: specialist,
    createdAt: Date.now(),
    ...clean,
    source: clean.source || 'site',
  }
  await putDoc<Enquiry>('enquiries', {
    id,
    draft: record,
    live: record,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    updatedBy: 'site',
    publishedAt: record.createdAt,
    order: Date.now(),
  })
  await logActivity('Site', `New enquiry from ${record.name || 'a visitor'}`)

  // The notification is a side effect: a mail transport that is down must not lose the lead, so the
  // record is written first and the send is reported rather than awaited into the answer.
  notify(record).catch((e) => log.error('public/enquiries', 'notification failed', { detail: (e as Error).message }))

  return json({ id, ref: leadRef(id), assignedTo: specialist })
})

async function notify(enquiry: Enquiry): Promise<void> {
  const bundle = await siteBundle(false)
  const settings = bundle.settings as Settings | undefined
  const to = [config.mail.notify || settings?.email].filter(Boolean) as string[]
  if (!to.length) return
  const lines = [
    `A new enquiry came in from ${enquiry.name}.`,
    '',
    `Reference   ${leadRef(enquiry.id)}`,
    `Name        ${enquiry.name}`,
    `Email       ${enquiry.email}`,
    `Phone       ${enquiry.phone}`,
    `Month       ${enquiry.month}`,
    `Travelling  ${enquiry.party}`,
    `Budget      ${enquiry.budget}`,
    enquiry.property ? `Property    ${enquiry.property}` : '',
    enquiry.offer ? `Offer       ${enquiry.offer}` : '',
    enquiry.shortlist.length ? `Shortlist   ${enquiry.shortlist.join(', ')}` : '',
    `Assigned    ${enquiry.assignedTo}`,
    '',
    enquiry.message || '(no message)',
  ].filter(Boolean)
  const result = await getMailer().send({
    to,
    subject: `New enquiry — ${enquiry.name} (${leadRef(enquiry.id)})`,
    text: lines.join('\n'),
    replyTo: enquiry.email,
  })
  log.info('public/enquiries', result.sent ? 'notification sent' : `notification not sent: ${result.reason}`, {
    ref: leadRef(enquiry.id),
  })
}
