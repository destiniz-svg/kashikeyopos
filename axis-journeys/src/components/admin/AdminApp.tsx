'use client'

/**
 * Axis Studio — the CMS.
 *
 * One client application over the same REST surface the site reads, with the sidebar, the eight
 * views and the editor from the prototype. Routing is by URL segment rather than by state, so a
 * specialist can send a colleague a link to the property they are both looking at.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { css } from '@/components/ui/css'
import { api, type DocView, type SessionUser } from '@/lib/admin/client'
import { ROLES, type Permission } from '@/lib/auth/roles'
import type { ActivityEvent, ContentCollection, Enquiry, Lists, MediaRecord } from '@/lib/content/types'
import { Toast } from './ui'
import { Sidebar } from './Sidebar'
import { Dashboard } from './Dashboard'
import { CollectionList } from './CollectionList'
import { Editor } from './Editor'
import { Enquiries } from './Enquiries'
import { MediaLibrary } from './MediaLibrary'
import { Team } from './Team'

export type View = 'dashboard' | ContentCollection | 'enquiries' | 'media' | 'team'

export interface Workspace {
  user: SessionUser
  lists: Lists
  cols: Record<ContentCollection, DocView[]>
  media: (MediaRecord & { urls: Record<string, string> })[]
  enquiries: Enquiry[]
  activity: ActivityEvent[]
  users: { id: string; name: string; email: string; role: SessionUser['role']; createdAt: number; invited?: boolean }[]
}

const EMPTY_COLS: Record<ContentCollection, DocView[]> = { properties: [], offers: [], destinations: [], homepage: [], settings: [] }

export function AdminApp({ user, view, id }: { user: SessionUser; view: View; id: string | null }) {
  const router = useRouter()
  const [ws, setWs] = useState<Workspace>({
    user,
    lists: { THEMES: [], PKGS: [], MONTHS: [], TIERS: [], SPECIALISTS: [] },
    cols: EMPTY_COLS,
    media: [],
    enquiries: [],
    activity: [],
    users: [],
  })
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'err' } | null>(null)
  const [loading, setLoading] = useState(true)

  const can = useCallback((p: Permission) => ROLES[user.role].can.includes(p), [user.role])

  const say = useCallback((message: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ message, tone })
    setTimeout(() => setToast(null), 3200)
  }, [])

  const reload = useCallback(async () => {
    const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p
      } catch {
        return fallback
      }
    }
    const [lists, properties, offers, destinations, homepage, settings, media, activity] = await Promise.all([
      safe(api.lists(), { THEMES: [], PKGS: [], MONTHS: [], TIERS: [], SPECIALISTS: [] } as Lists),
      safe(api.list('properties'), []),
      safe(api.list('offers'), []),
      safe(api.list('destinations'), []),
      safe(api.list('homepage'), []),
      safe(api.list('settings'), []),
      safe(api.media(), []),
      safe(api.activity(), []),
    ])
    const enquiries = can('enquiries') ? await safe(api.enquiries(), []) : []
    const users = can('users') ? await safe(api.users(), []) : []
    setWs((w) => ({ ...w, lists, cols: { properties, offers, destinations, homepage, settings }, media, activity, enquiries, users }))
    setLoading(false)
  }, [can])

  useEffect(() => {
    void reload()
  }, [reload])

  /** Media references resolve through the library the CMS already has in hand. */
  const resolveImage = useCallback(
    (ref: string): string => {
      if (!ref) return ''
      if (!ref.startsWith('media:')) return ref
      const rec = ws.media.find((m) => m.id === ref.slice(6))
      return rec?.urls?.card || ''
    },
    [ws.media],
  )

  const go = useCallback((path: string) => router.push(path), [router])

  const body = useMemo(() => {
    if (view === 'dashboard') return <Dashboard ws={ws} go={go} can={can} />
    if (view === 'enquiries') return <Enquiries ws={ws} reload={reload} say={say} can={can} />
    if (view === 'media') return <MediaLibrary ws={ws} reload={reload} say={say} can={can} />
    if (view === 'team') return <Team ws={ws} reload={reload} say={say} />
    const col = view as ContentCollection
    if (id) return <Editor col={col} id={id} ws={ws} reload={reload} say={say} can={can} go={go} resolveImage={resolveImage} />
    // The two singles open straight into their editor: there is only ever one document.
    if (col === 'homepage' || col === 'settings') return <Editor col={col} id="main" ws={ws} reload={reload} say={say} can={can} go={go} resolveImage={resolveImage} />
    return <CollectionList col={col} ws={ws} reload={reload} say={say} can={can} go={go} />
  }, [view, id, ws, reload, say, can, go, resolveImage])

  return (
    <div id="app-grid" style={css('display:grid;grid-template-columns:232px 1fr;min-height:100vh;background:var(--bg);color:var(--ink);')}>
      <Sidebar user={ws.user} view={view} newEnquiries={ws.enquiries.filter((e) => e.status === 'new').length} can={can} go={go} say={say} />
      <main id="main" style={css('padding:28px 32px 80px;min-width:0;')}>
        {loading ? <div style={css('color:var(--muted);font-size:13px;padding:40px 0;')}>Loading the workspace…</div> : body}
      </main>
      <Toast message={toast?.message ?? null} tone={toast?.tone} />
    </div>
  )
}
