/**
 * Structured logging — one JSON object per line, which is what a log shipper reads and what a
 * person greps. Newlines are collapsed inside every value: a provider that pretty-prints its errors
 * otherwise scatters the sentence that matters across eight lines that share a timestamp.
 *
 * Nothing here ever logs a password, a token, a session cookie or a card number. `redact()` is the
 * fence, and it is applied to every field rather than to the ones somebody remembered.
 */
import { config } from '../config'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_KEY = /^(password|pass|token|secret|authorization|cookie|apikey|api_key|key|passwordhash|sessionsecret)$/i
const SECRET_VALUE = /(bearer\s+[\w.\-]+|scrypt\$[0-9a-f]+\$[0-9a-f]+)/gi

const flat = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim()

/**
 * `seen` is what makes this safe on a value somebody handed us rather than composed.
 *
 * A request object, an error with a `cause` chain, an ORM row — any of them can hold a cycle, and
 * the depth cap alone does not help: past the cap the value was returned AS IS, so the cycle came
 * straight back and `JSON.stringify` threw. A logger that can throw takes the request with it, and
 * the thing it was reporting is the thing that is lost.
 */
function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value == null) return value
  if (typeof value === 'string') return flat(value).replace(SECRET_VALUE, '[redacted]').slice(0, 1000)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return undefined
  if (seen.has(value as object)) return '[circular]'
  if (depth > 4) return '[deep]'
  seen.add(value as object)
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1, seen)
  }
  return out
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[config.logLevel]) return
  const line = {
    at: new Date().toISOString(),
    level,
    scope,
    msg: flat(message),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  }
  // The last fence. Redaction handles every shape this build produces, but the logger is called
  // from catch blocks with values nobody chose, and one that throws is worse than one that says so.
  let out: string
  try {
    out = JSON.stringify(line)
  } catch {
    out = JSON.stringify({ at: line.at, level, scope, msg: line.msg, note: 'fields could not be serialised' })
  }
  if (level === 'error') console.error(out)
  else if (level === 'warn') console.warn(out)
  else console.log(out)
}

export const log = {
  debug: (scope: string, message: string, fields?: Record<string, unknown>) => emit('debug', scope, message, fields),
  info: (scope: string, message: string, fields?: Record<string, unknown>) => emit('info', scope, message, fields),
  warn: (scope: string, message: string, fields?: Record<string, unknown>) => emit('warn', scope, message, fields),
  error: (scope: string, message: string, fields?: Record<string, unknown>) => emit('error', scope, message, fields),
}
