/**
 * The user plane. Records live in their own partition and a password hash never leaves this module
 * — `publicUser()` is the only shape any caller or response ever sees.
 */
import { getStore, PK, SK } from '../store'
import { config } from '../config'
import { hashPassword, verifyPassword } from './password'
import { isRole, type Role } from './roles'
import { logActivity, uid } from '../content/repository'

export interface UserRecord {
  id: string
  name: string
  email: string
  role: Role
  passwordHash: string
  /** Bumped to orphan every token signed before now. */
  tokenVersion: number
  createdAt: number
  /** Set when an invited user has not chosen a password yet. */
  invited?: boolean
}

export interface PublicUser {
  id: string
  name: string
  email: string
  role: Role
  createdAt: number
  invited?: boolean
}

export const publicUser = (u: UserRecord): PublicUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
  ...(u.invited ? { invited: true } : {}),
})

const norm = (email: string): string => String(email || '').trim().toLowerCase()

export async function listUsers(): Promise<UserRecord[]> {
  const rows = await getStore().list<UserRecord>(PK.users)
  return rows.map((r) => r.body)
}

export async function getUser(id: string): Promise<UserRecord | null> {
  return getStore().get<UserRecord>(PK.users, SK.id(id))
}

export async function findByEmail(email: string): Promise<UserRecord | null> {
  const all = await listUsers()
  return all.find((u) => norm(u.email) === norm(email)) ?? null
}

export async function putUser(u: UserRecord): Promise<void> {
  await getStore().put(PK.users, SK.id(u.id), u)
}

export async function deleteUser(id: string): Promise<void> {
  await getStore().delete(PK.users, SK.id(id))
}

export async function createUser(input: {
  name: string
  email: string
  role: Role
  password?: string
}): Promise<UserRecord> {
  const existing = await findByEmail(input.email)
  if (existing) {
    const err = new Error('That email address already has an account') as Error & { status?: number }
    err.status = 409
    throw err
  }
  const rec: UserRecord = {
    id: 'u' + uid(),
    name: String(input.name || '').trim().slice(0, 80),
    email: norm(input.email),
    role: isRole(input.role) ? input.role : 'contributor',
    // An invited user with no password cannot sign in: an empty hash never verifies, and the
    // account waits for an owner to set one rather than existing with a guessable default.
    passwordHash: input.password ? await hashPassword(input.password) : '',
    tokenVersion: 0,
    createdAt: Date.now(),
    ...(input.password ? {} : { invited: true }),
  }
  await putUser(rec)
  return rec
}

/** Credentials check. Returns null for both "no such account" and "wrong password". */
export async function authenticate(email: string, password: string): Promise<UserRecord | null> {
  const u = await findByEmail(email)
  if (!u || !u.passwordHash) {
    // Spend the same work either way so the answer does not time-leak whether the address is known.
    await verifyPassword(password, 'scrypt$00$' + '0'.repeat(128))
    return null
  }
  return (await verifyPassword(password, u.passwordHash)) ? u : null
}

export async function setPassword(id: string, password: string): Promise<void> {
  const u = await getUser(id)
  if (!u) return
  u.passwordHash = await hashPassword(password)
  delete u.invited
  // A new password ends every session signed with the old one.
  u.tokenVersion = (u.tokenVersion ?? 0) + 1
  await putUser(u)
}

export async function revokeSessions(id: string): Promise<void> {
  const u = await getUser(id)
  if (!u) return
  u.tokenVersion = (u.tokenVersion ?? 0) + 1
  await putUser(u)
}

/**
 * The first owner. Created from configuration when the workspace has no users at all, so a fresh
 * install has exactly one way in and it is one the operator chose. With nothing configured, no
 * account is created and the sign-in screen says so — an install with a default password is worse
 * than an install nobody can sign in to yet.
 */
export async function ensureFirstOwner(): Promise<{ created: boolean; reason: string }> {
  const users = await listUsers()
  if (users.length) return { created: false, reason: 'the workspace already has users' }
  const { ownerEmail, ownerPassword, ownerName } = config.auth
  if (!ownerEmail || !ownerPassword) {
    return { created: false, reason: 'set ADMIN_OWNER_EMAIL and ADMIN_OWNER_PASSWORD to create the first owner' }
  }
  await createUser({ name: ownerName, email: ownerEmail, role: 'owner', password: ownerPassword })
  await logActivity('System', `Created the first owner account for ${norm(ownerEmail)}`)
  return { created: true, reason: `created the owner account ${norm(ownerEmail)}` }
}
