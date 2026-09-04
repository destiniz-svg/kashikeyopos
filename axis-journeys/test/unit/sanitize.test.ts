/**
 * Input hygiene on the one public door that writes a record.
 *
 * The browser has a copy of these rules as a courtesy; this is the control. Every case below is a
 * payload a form cannot produce and a script can, which is the whole reason the server re-does it.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ENQUIRY_LIMITS, EMAIL_RE, clean, enquiryFaults, sanitizeEnquiry } from '@/lib/content/sanitize'

describe('clean', () => {
  it('strips tags rather than escaping them', () => {
    assert.equal(clean('<script>alert(1)</script>Aminath', 80), 'alert(1)Aminath')
    assert.equal(clean('<img src=x onerror=alert(1)>', 80), '')
    assert.equal(clean('Hello <b>world</b>', 80), 'Hello world')
  })

  it('turns control characters into spaces, so a log line cannot be forged', () => {
    assert.equal(clean('Aminath\r\nX-Injected: yes', 80), 'Aminath  X-Injected: yes')
    assert.equal(clean('a\u0000b', 80), 'a b')
    assert.equal(clean('a\u007Fb', 80), 'a b')
    assert.equal(clean('tab\there', 80), 'tab here')
  })

  it('caps the length and trims the edges', () => {
    assert.equal(clean('   padded   ', 80), 'padded')
    assert.equal(clean('x'.repeat(500), 10), 'xxxxxxxxxx')
  })

  it('coerces anything to a string without throwing', () => {
    assert.equal(clean(null, 10), '')
    assert.equal(clean(undefined, 10), '')
    assert.equal(clean(42, 10), '42')
    assert.equal(clean({ a: 1 }, 40), '[object Object]')
  })
})

describe('sanitizeEnquiry', () => {
  it('returns every field the record needs, and only those fields', () => {
    const out = sanitizeEnquiry({ name: 'Aminath', email: 'A@Example.COM', nonsense: 'x', status: 'won' })
    assert.deepEqual(Object.keys(out).sort(), [...Object.keys(ENQUIRY_LIMITS), 'shortlist'].sort())
    assert.equal('nonsense' in out, false)
    // A caller cannot set its own status, assignee or id: those are the CMS's, not the form's.
    assert.equal('status' in out, false)
  })

  it('lower-cases the email, because that is how it is compared and rate-limited', () => {
    assert.equal(sanitizeEnquiry({ email: '  Guest@Example.COM ' }).email, 'guest@example.com')
  })

  it('applies each field own cap', () => {
    const out = sanitizeEnquiry({ name: 'n'.repeat(500), message: 'm'.repeat(5000) })
    assert.equal(out.name.length, ENQUIRY_LIMITS.name)
    assert.equal(out.message.length, ENQUIRY_LIMITS.message)
  })

  it('the shortlist is capped in length and in count, and never carries markup', () => {
    const out = sanitizeEnquiry({ shortlist: [...Array(50)].map((_, i) => `<b>resort ${i}</b>`) })
    assert.equal(out.shortlist.length, 20)
    assert.equal(out.shortlist[0], 'resort 0')
  })

  it('a shortlist that is not an array is no shortlist', () => {
    assert.deepEqual(sanitizeEnquiry({ shortlist: 'baros' }).shortlist, [])
    assert.deepEqual(sanitizeEnquiry({}).shortlist, [])
  })

  it('empty entries are dropped rather than stored blank', () => {
    assert.deepEqual(sanitizeEnquiry({ shortlist: ['baros', '', '   ', '<i></i>'] }).shortlist, ['baros'])
  })

  it('survives a hostile body without throwing', () => {
    const out = sanitizeEnquiry({ name: { toString: () => 'x' }, email: [1, 2], shortlist: [null, undefined, {}] })
    assert.equal(typeof out.name, 'string')
    assert.equal(typeof out.email, 'string')
    assert.equal(out.shortlist.every((s) => typeof s === 'string'), true)
  })
})

describe('enquiryFaults', () => {
  const base = sanitizeEnquiry({ name: 'Aminath Hassan', email: 'a@example.com' })

  it('a good enquiry has no faults', () => {
    assert.deepEqual(enquiryFaults(base), {})
  })

  it('names the field, in the words the form shows', () => {
    assert.deepEqual(enquiryFaults({ ...base, name: 'A' }), { name: 'Please tell us your name.' })
    assert.deepEqual(enquiryFaults({ ...base, email: 'not-an-email' }), { email: 'A valid email is needed for your quote.' })
  })

  it('reports both faults at once rather than one at a time', () => {
    assert.deepEqual(Object.keys(enquiryFaults({ ...base, name: '', email: '' })).sort(), ['email', 'name'])
  })

  it('the address rule refuses the shapes a mail server would', () => {
    for (const good of ['a@b.co', 'first.last+tag@sub.example.com']) assert.equal(EMAIL_RE.test(good), true, good)
    for (const bad of ['', 'a@b', 'a b@c.com', '@b.com', 'a@ .com', 'a@b.com c']) assert.equal(EMAIL_RE.test(bad), false, bad)
  })
})
