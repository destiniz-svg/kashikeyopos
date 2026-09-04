/**
 * The CMS's one route. Everything under `/admin` resolves here and the segment names the view, so
 * a specialist can send a colleague a link to the property they are both looking at.
 *
 * The session is checked on the server before a byte of the workspace is sent: an unauthenticated
 * visitor is redirected rather than shown a shell that then fails every request.
 */
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/http/request'
import { ROLES } from '@/lib/auth/roles'
import { CONTENT_COLLECTIONS } from '@/lib/content/types'
import { AdminApp, type View } from '@/components/admin/AdminApp'

export const dynamic = 'force-dynamic'

const VIEWS: View[] = ['dashboard', ...CONTENT_COLLECTIONS, 'enquiries', 'media', 'team']

export default async function AdminRoute({ params }: { params: Promise<{ slug?: string[] }> }) {
  const actor = await currentActor()
  if (!actor) redirect('/admin/login')

  const slug = (await params).slug ?? []
  const view = (VIEWS.includes(slug[0] as View) ? slug[0] : 'dashboard') as View
  const id = slug[1] ?? null

  return (
    <AdminApp
      user={{ id: actor.sub, name: actor.name, email: actor.email, role: actor.role, can: ROLES[actor.role].can }}
      view={view}
      id={id}
    />
  )
}
