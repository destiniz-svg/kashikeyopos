/**
 * `PATCH|DELETE /api/users/{id}`.
 *
 * The two removals that end in a locked-out workspace — yourself, and the last owner standing —
 * are refused by name rather than performed and regretted.
 */
import type { NextRequest } from 'next/server'
import { deleteUser, getUser, listUsers, publicUser, putUser, revokeSessions, setPassword } from '@/lib/auth/users'
import { isRole } from '@/lib/auth/roles'
import { passwordFault } from '@/lib/auth/password'
import { logActivity } from '@/lib/content/repository'
import { clean } from '@/lib/content/sanitize'
import { assertSameOrigin, need, readJson } from '@/lib/http/request'
import { badRequest, json, notFound, route } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ id: string }> }

export const PATCH = route('users:patch', async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params
  const actor = await need('users')
  assertSameOrigin(req)
  const user = await getUser(id)
  if (!user) throw notFound('No such user')
  const body = await readJson(req)

  if (body.name !== undefined) user.name = clean(body.name, 80)
  if (body.role !== undefined) {
    if (!isRole(body.role)) throw badRequest('That is not a role')
    const owners = (await listUsers()).filter((u) => u.role === 'owner')
    if (user.role === 'owner' && body.role !== 'owner' && owners.length <= 1) {
      throw badRequest('This is the last owner — promote somebody else first')
    }
    user.role = body.role
  }
  if (body.password !== undefined) {
    const fault = passwordFault(String(body.password))
    if (fault) throw badRequest(fault)
    await setPassword(id, String(body.password))
    await logActivity(actor.name, `Set a new password for ${user.name}`)
    const fresh = await getUser(id)
    return json(publicUser(fresh!))
  }
  if (body.signOutEverywhere === true) {
    await revokeSessions(id)
    await logActivity(actor.name, `Signed ${user.name} out of every device`)
    const fresh = await getUser(id)
    return json(publicUser(fresh!))
  }

  await putUser(user)
  await logActivity(actor.name, `Updated ${user.name}`)
  return json(publicUser(user))
})

export const DELETE = route('users:delete', async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params
  const actor = await need('users')
  assertSameOrigin(req)
  const user = await getUser(id)
  if (!user) throw notFound('No such user')
  if (actor.sub === id) throw badRequest('You cannot remove your own account')
  const owners = (await listUsers()).filter((u) => u.role === 'owner')
  if (user.role === 'owner' && owners.length <= 1) throw badRequest('This is the last owner — promote somebody else first')
  await deleteUser(id)
  await logActivity(actor.name, `Removed ${user.name}`)
  return json({ ok: true })
})
