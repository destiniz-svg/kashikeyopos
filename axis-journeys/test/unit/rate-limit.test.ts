/**
 * The doorman on the endpoints anybody on the internet may call.
 *
 * Two properties matter and both are tested here: the ceiling actually holds, and the two buckets
 * are independent — because a hotel's wifi puts a whole lobby behind one address, and a doorman
 * that cannot tell forty guests from one attacker locks out the guests.
 */
import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import { LIMITS, charge, identityKey, resetLimits, room, take } from '@/lib/http/rate-limit'

beforeEach(() => resetLimits())

describe('identityKey', () => {
  it('hashes: a rate-limit table is not a customer list', () => {
    const key = identityKey('guest@example.com')
    assert.equal(key.includes('guest'), false)
    assert.equal(key.includes('@'), false)
    assert.match(key, /^[0-9a-f]{32}$/)
  })

  it('is stable, and case-insensitive, so one address is one bucket however it is typed', () => {
    assert.equal(identityKey('Guest@Example.com'), identityKey('guest@example.com'))
    assert.notEqual(identityKey('a@example.com'), identityKey('b@example.com'))
  })

  it('an empty identity still yields a key rather than throwing', () => {
    assert.match(identityKey(''), /^[0-9a-f]{32}$/)
  })
})

describe('take', () => {
  it('allows up to the ceiling and refuses the next', () => {
    for (let i = 0; i < 3; i++) assert.equal(take('k', 3, 60_000).ok, true, `attempt ${i + 1}`)
    const refused = take('k', 3, 60_000)
    assert.equal(refused.ok, false)
    assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 60)
  })

  it('keys are independent — one caller’s spend is not another’s', () => {
    for (let i = 0; i < 3; i++) take('a', 3, 60_000)
    assert.equal(take('a', 3, 60_000).ok, false)
    assert.equal(take('b', 3, 60_000).ok, true)
  })

  it('a window that has passed lets the caller back in', async () => {
    for (let i = 0; i < 3; i++) take('short', 3, 5)
    assert.equal(take('short', 3, 5).ok, false)
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(take('short', 3, 5).ok, true)
  })

  it('the same key under two ceilings is one spend, not two', () => {
    // Two routes must never share a key unless they mean to share a budget.
    take('shared', 5, 60_000)
    take('shared', 5, 60_000)
    assert.equal(room('shared', 2, 60_000).ok, false)
  })
})

describe('room and charge', () => {
  it('room asks without spending, which is what makes a failure-only budget possible', () => {
    for (let i = 0; i < 20; i++) assert.equal(room('ask', 2, 60_000).ok, true)
    charge('ask')
    charge('ask')
    assert.equal(room('ask', 2, 60_000).ok, false)
  })

  it('an unknown key always has room', () => {
    assert.deepEqual(room('never-seen', 1, 60_000), { ok: true, retryAfter: 0 })
  })

  it('retryAfter counts down from the oldest hit in the window', () => {
    charge('rt')
    const v = room('rt', 1, 60_000)
    assert.equal(v.ok, false)
    assert.ok(v.retryAfter >= 59 && v.retryAfter <= 60, `retryAfter was ${v.retryAfter}`)
  })

  it('a ceiling of zero still admits one caller rather than nobody', () => {
    // `Math.max(1, ...)` is deliberate: a misconfigured scale must not take the site off the air.
    charge('z')
    assert.equal(room('z', 0, 60_000).ok, false)
    assert.equal(room('fresh-z', 0, 60_000).ok, true)
  })
})

describe('the published ceilings', () => {
  it('the identity bucket is tighter than the IP bucket on every public door', () => {
    // The whole design: one address cannot be hammered from many addresses, and many guests behind
    // one address are not mistaken for one attacker.
    assert.ok(LIMITS.enquiryIdentity.max < LIMITS.enquiryIp.max)
    assert.equal(LIMITS.enquiryIdentity.windowMs, LIMITS.enquiryIp.windowMs)
  })

  it('the daily enquiry cap is a day wide', () => {
    assert.equal(LIMITS.enquiryDaily.windowMs, 24 * 3600_000)
  })

  it('sign-in is the tightest door and its window is the longest', () => {
    assert.ok(LIMITS.loginIp.max <= LIMITS.enquiryIp.max)
    assert.ok(LIMITS.loginIp.windowMs > LIMITS.enquiryIp.windowMs)
    assert.equal(LIMITS.loginIdentity.max, LIMITS.loginIp.max)
  })

  it('every ceiling is a positive number over a positive window', () => {
    for (const [name, l] of Object.entries(LIMITS)) {
      assert.ok(l.max > 0, `${name}.max`)
      assert.ok(l.windowMs > 0, `${name}.windowMs`)
    }
  })
})
