/**
 * Input hygiene for the one door open to the internet that writes a record.
 * Ported from `sanitizeEnquiry()` in `prototype/admin/api.js` — same fields, same caps, same order.
 * The server is the source of truth: the browser's copy of this is a courtesy, not a control.
 */

export const ENQUIRY_LIMITS = {
  name: 80,
  email: 160,
  phone: 40,
  month: 24,
  message: 2000,
  party: 24,
  budget: 24,
  property: 120,
  propertyId: 64,
  offer: 80,
  source: 120,
} as const

export type EnquiryField = keyof typeof ENQUIRY_LIMITS

const TAGS = /<[^>]*>/g
// C0 controls and DEL. They have no place in a name or a message and they are how a log line is
// forged, so they become spaces rather than being dropped silently.
const CONTROL = /[\u0000-\u001F\u007F]/g

/** Strip tags and control characters, collapse to a plain string, cap the length. */
export const clean = (v: unknown, max: number): string =>
  String(v == null ? '' : v)
    .replace(TAGS, '')
    .replace(CONTROL, ' ')
    .trim()
    .slice(0, max)

export interface SanitizedEnquiry extends Record<EnquiryField, string> {
  shortlist: string[]
}

export function sanitizeEnquiry(body: Record<string, unknown>): SanitizedEnquiry {
  const out = {} as SanitizedEnquiry
  for (const k of Object.keys(ENQUIRY_LIMITS) as EnquiryField[]) out[k] = clean(body?.[k], ENQUIRY_LIMITS[k])
  out.shortlist = (Array.isArray(body?.shortlist) ? (body.shortlist as unknown[]) : [])
    .slice(0, 20)
    .map((x) => clean(x, 120))
    .filter(Boolean)
  out.email = out.email.toLowerCase()
  return out
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The site's own validation, mirrored so a refusal reads the same on both sides. */
export function enquiryFaults(b: SanitizedEnquiry): Record<string, string> {
  const e: Record<string, string> = {}
  if (b.name.trim().length < 2) e.name = 'Please tell us your name.'
  if (!EMAIL_RE.test(b.email)) e.email = 'A valid email is needed for your quote.'
  return e
}
