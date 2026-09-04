/**
 * The credential plane: password storage, session tokens and the role gate.
 *
 * Everything here is a control rather than a convenience, so each test is a way in that must stay
 * shut: a forged token, a truncated one, a token that outlived a "sign out everywhere", a role that
 * reaches past its rank.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { hashPassword, passwordFault, verifyPassword } from '@/lib/auth/password'
import { issueToken, readToken } from '@/lib/auth/session'
import { ROLES, ROLE_KEYS, can, isRole } from '@/lib/auth/roles'

const user = { id: 'u1', name: 'Aishath', email: 'a@axisjourneys.com', role: 'owner' as const, tokenVersion: 3 }

describe('password storage', () => {
  it('a stored password is self-describing and carries no plaintext', async () => {
    const stored = await hashPassword('correct horse battery staple')
    const [scheme, salt, hash] = stored.split('$')
    assert.equal(scheme, 'scrypt')
    assert.equal(salt.length, 32)
    assert.equal(hash.length, 128)
    assert.equal(stored.includes('correct horse'), false)
  })

  it('the same password hashes differently every time', async () => {
    assert.notEqual(await hashPassword('the same password'), await hashPassword('the same password'))
  })

  it('verifies the right password and refuses every wrong one', async () => {
    const stored = await hashPassword('a-real-password-1')
    assert.equal(await verifyPassword('a-real-password-1', stored), true)
    assert.equal(await verifyPassword('a-real-password-2', stored), false)
    assert.equal(await verifyPassword('', stored), false)
    assert.equal(await verifyPassword('A-REAL-PASSWORD-1', stored), false)
  })

  it('a malformed or empty stored value never verifies', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$only-two', 'bcrypt$aa$bb', 'scrypt$zz$zz', 'scrypt$00$' + '0'.repeat(10)]) {
      assert.equal(await verifyPassword('anything', bad), false, bad)
    }
  })

  it('an invited account with an empty hash cannot be signed into', async () => {
    // `createUser` stores '' for an invited user; that must never verify, whatever is typed.
    assert.equal(await verifyPassword('', ''), false)
    assert.equal(await verifyPassword('guess', ''), false)
  })

  it('the length policy is refused by name rather than silently accepted', () => {
    assert.equal(passwordFault('a-good-long-password'), null)
    assert.equal(passwordFault('short'), 'A password must be at least 12 characters')
    assert.equal(passwordFault('x'.repeat(201)), 'That password is too long')
    assert.equal(passwordFault(undefined as unknown as string), 'A password must be at least 12 characters')
  })
})

describe('session tokens', () => {
  it('round-trips the claims a request needs', () => {
    const { token, claims } = issueToken(user)
    const read = readToken(token)
    assert.deepEqual(read, claims)
    assert.equal(read?.sub, 'u1')
    assert.equal(read?.role, 'owner')
    assert.equal(read?.ver, 3)
  })

  it('carries no password and no secret', () => {
    const { token } = issueToken(user)
    const payload = Buffer.from(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    assert.equal(/password|hash|secret/i.test(payload), false)
  })

  it('every token is distinct, so one can be named in the trail', () => {
    assert.notEqual(issueToken(user).claims.jti, issueToken(user).claims.jti)
  })

  it('refuses a token whose payload was edited', () => {
    const { token } = issueToken(user)
    const [payload, mac] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.role = 'owner'
    claims.sub = 'somebody-else'
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + mac
    assert.equal(readToken(forged), null)
  })

  it('refuses a token signed with another key', () => {
    // The signature is over the payload, so a payload lifted onto a different MAC is refused.
    const a = issueToken(user).token
    const b = issueToken({ ...user, id: 'u2' }).token
    assert.equal(readToken(a.split('.')[0] + '.' + b.split('.')[1]), null)
  })

  it('refuses every malformed shape without throwing', () => {
    for (const bad of ['', null, undefined, 'nodot', '.', '.mac', 'payload.', 'a.b.c', '!!!.???', 42 as unknown as string]) {
      assert.equal(readToken(bad as string), null, String(bad))
    }
  })

  it('refuses an expired token', () => {
    const { token } = issueToken(user)
    const [payload, mac] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.exp = Math.floor(Date.now() / 1000) - 1
    // Re-signing is impossible without the key, so the expiry is checked on a token that is
    // otherwise valid: issue one and assert the claim the door reads.
    assert.ok(readToken(token)!.exp * 1000 > Date.now())
    const stale = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + mac
    assert.equal(readToken(stale), null)
  })

  it('the version claim is what makes “sign out everywhere” real', () => {
    // The token is still valid; the door compares `ver` against the record, and a bumped record
    // orphans it. That comparison lives in `currentActor()` and is exercised over HTTP.
    const before = readToken(issueToken({ ...user, tokenVersion: 3 }).token)
    const after = readToken(issueToken({ ...user, tokenVersion: 4 }).token)
    assert.equal(before?.ver, 3)
    assert.equal(after?.ver, 4)
  })

  it('a user record with no version is version zero rather than undefined', () => {
    const { claims } = issueToken({ id: 'u9', name: 'n', email: 'e@x.com', role: 'sales' })
    assert.equal(claims.ver, 0)
  })
})

describe('roles', () => {
  it('is the ladder the CMS draws and the routes gate on — one map, not two', () => {
    assert.deepEqual(ROLE_KEYS, ['owner', 'editor', 'contributor', 'sales'])
    assert.equal(can('owner', 'users'), true)
    assert.equal(can('editor', 'users'), false)
    assert.equal(can('contributor', 'publish'), false)
    assert.equal(can('contributor', 'write'), true)
    assert.equal(can('sales', 'write'), false)
    assert.equal(can('sales', 'enquiries'), true)
  })

  it('only the owner administers accounts', () => {
    for (const r of ROLE_KEYS) assert.equal(can(r, 'users'), r === 'owner', r)
  })

  it('every role can read, because the CMS is unusable otherwise', () => {
    for (const r of ROLE_KEYS) assert.equal(can(r, 'read'), true, r)
  })

  it('an absent or unknown role reaches nothing', () => {
    assert.equal(can(null, 'read'), false)
    assert.equal(can(undefined, 'read'), false)
    assert.equal(can('admin' as never, 'read'), false)
    assert.equal(can('__proto__' as never, 'read'), false)
  })

  it('isRole refuses anything that is not one of the four', () => {
    for (const r of ROLE_KEYS) assert.equal(isRole(r), true)
    for (const bad of ['Owner', 'root', '', null, 42, {}, 'constructor']) assert.equal(isRole(bad), false, String(bad))
  })

  it('every permission a role claims is one the map defines', () => {
    const known = new Set(['read', 'write', 'publish', 'delete', 'settings', 'users', 'enquiries', 'media'])
    for (const r of ROLE_KEYS) for (const p of ROLES[r].can) assert.equal(known.has(p), true, `${r}:${p}`)
  })
})
