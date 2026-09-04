/**
 * The log's redaction fence.
 *
 * The brief names this outright: a password, a token, a key or personal payment data must never be
 * written down. `redact()` is applied to every field rather than to the ones somebody remembered,
 * which is the only version of this that survives a new field being added — so what is tested here
 * is that it applies to everything, at depth, and to values as well as keys.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { log } from '@/lib/http/log'

/** Capture what actually reaches the console for one call. */
function capture(fn: () => void): Record<string, unknown> {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const lines: string[] = []
  const grab = (s: unknown) => lines.push(String(s))
  console.log = grab
  console.warn = grab
  console.error = grab
  try {
    fn()
  } finally {
    Object.assign(console, original)
  }
  return lines.length ? (JSON.parse(lines[lines.length - 1]) as Record<string, unknown>) : {}
}

describe('the log line', () => {
  it('is one JSON object with a level, a scope and a message', () => {
    const line = capture(() => log.error('auth/login', 'refused', { ip: '203.0.113.1' }))
    assert.equal(line.level, 'error')
    assert.equal(line.scope, 'auth/login')
    assert.equal(line.msg, 'refused')
    assert.equal(line.ip, '203.0.113.1')
    assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T/)
  })

  it('collapses newlines, so a provider’s pretty-printed error stays on one line', () => {
    const line = capture(() => log.error('ai', 'refused', { detail: '{\n  "error": {\n    "code": 503\n  }\n}' }))
    assert.equal(String(line.detail).includes('\n'), false)
    assert.match(String(line.detail), /"code": 503/)
  })
})

describe('what it refuses to write down', () => {
  const secrets = ['password', 'pass', 'token', 'secret', 'authorization', 'cookie', 'apiKey', 'api_key', 'key', 'passwordHash']

  it('redacts every field whose name says what it holds', () => {
    for (const field of secrets) {
      const line = capture(() => log.info('t', 'm', { [field]: 'the-actual-value' }))
      assert.equal(line[field], '[redacted]', `${field} was written out`)
    }
  })

  it('is case-insensitive about those names', () => {
    for (const field of ['Password', 'TOKEN', 'Authorization', 'apiKEY']) {
      const line = capture(() => log.info('t', 'm', { [field]: 'the-actual-value' }))
      assert.equal(line[field], '[redacted]', `${field} was written out`)
    }
  })

  it('redacts at depth, not only at the top level', () => {
    const line = capture(() => log.info('t', 'm', { request: { headers: { authorization: 'Bearer abc.def' }, body: { password: 'hunter2' } } }))
    const request = line.request as { headers: Record<string, string>; body: Record<string, string> }
    assert.equal(request.headers.authorization, '[redacted]')
    assert.equal(request.body.password, '[redacted]')
    assert.equal(JSON.stringify(line).includes('hunter2'), false)
  })

  it('redacts a credential found in a VALUE, whatever the field is called', () => {
    // A bearer token pasted into a message is the ordinary way one reaches a log.
    const line = capture(() => log.warn('t', 'm', { note: 'called with Bearer eyJhbGciOi.J9.abc and it failed' }))
    assert.equal(String(line.note).includes('eyJhbGciOi'), false)
    assert.match(String(line.note), /\[redacted\]/)
  })

  it('redacts a stored password hash wherever it appears', () => {
    const stored = 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)
    const line = capture(() => log.error('t', 'm', { detail: `verify failed for ${stored}` }))
    assert.equal(String(line.detail).includes('scrypt$aaaa'), false)
    assert.match(String(line.detail), /\[redacted\]/)
  })

  it('caps a value, so one huge field cannot flood the log', () => {
    const line = capture(() => log.info('t', 'm', { blob: 'x'.repeat(50_000) }))
    assert.ok(String(line.blob).length <= 1000, `a ${String(line.blob).length}-character value was written`)
  })

  it('caps an array, for the same reason', () => {
    const line = capture(() => log.info('t', 'm', { many: Array.from({ length: 500 }, (_, i) => i) }))
    assert.equal((line.many as unknown[]).length, 20)
  })

  it('survives a cyclic or exotic value rather than throwing inside the logger', () => {
    // A logger that can throw takes the request with it, and the thing it was reporting is lost.
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic.self = cyclic
    assert.doesNotThrow(() => capture(() => log.error('t', 'm', cyclic)))
    assert.doesNotThrow(() => capture(() => log.error('t', 'm', { fn: () => 1, sym: Symbol('s'), undef: undefined })))
  })
})
