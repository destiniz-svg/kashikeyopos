/**
 * Password storage: scrypt with a per-row salt, over node:crypto.
 *
 * A hash never leaves the database layer and a password is never stored, logged or returned. The
 * comparison is constant-time — a fast negative on the first wrong byte is a timing oracle.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: string | Buffer, len: number) => Promise<Buffer>

const KEY_LEN = 64

/** `scrypt$<salt hex>$<hash hex>` — self-describing, so the format can change without a migration. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[1], 'hex')
    expected = Buffer.from(parts[2], 'hex')
  } catch {
    return false
  }
  if (expected.length !== KEY_LEN) return false
  const actual = await scrypt(password, salt, KEY_LEN)
  return timingSafeEqual(actual, expected)
}

/** The policy SECURITY.md states: 12 characters or more. Refused by name, never silently accepted. */
export function passwordFault(password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) return 'A password must be at least 12 characters'
  if (password.length > 200) return 'That password is too long'
  return null
}
