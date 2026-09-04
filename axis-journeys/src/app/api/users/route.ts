/** `GET|POST /api/users` — the team. Owner only; a hash never appears in an answer. */
import type { NextRequest } from 'next/server'
import { createUser, listUsers, publicUser } from '@/lib/auth/users'
import { isRole } from '@/lib/auth/roles'
import { passwordFault } from '@/lib/auth/password'
import { logActivity } from '@/lib/content/repository'
import { clean, EMAIL_RE } from '@/lib/content/sanitize'
import { assertSameOrigin, need, readJson } from '@/lib/http/request'
import { badRequest, json, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export const GET = route('users:list', async () => {
  await need('users')
  const users = await listUsers()
  return json(users.map(publicUser).sort((a, b) => a.createdAt - b.createdAt))
})

export const POST = route('users:create', async (req: NextRequest) => {
  const actor = await need('users')
  assertSameOrigin(req)
  const body = await readJson(req)
  const name = clean(body.name, 80)
  const email = clean(body.email, 160).toLowerCase()
  const role = body.role
  if (name.length < 2) throw badRequest('A name is needed')
  if (!EMAIL_RE.test(email)) throw badRequest('A valid email address is needed')
  if (!isRole(role)) throw badRequest('Pick a role')
  // A password is optional: an invited account exists and cannot sign in until an owner sets one.
  // What it never gets is a default — a shared starting password is one nobody changes.
  const password = body.password === undefined ? undefined : String(body.password)
  if (password !== undefined) {
    const fault = passwordFault(password)
    if (fault) throw badRequest(fault)
  }
  const user = await createUser({ name, email, role, password })
  await logActivity(actor.name, `Invited ${user.name} as ${user.role}`)
  return json(publicUser(user), { status: 201 })
})
