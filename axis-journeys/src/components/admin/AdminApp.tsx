'use client'

/**
 * Axis Studio — the CMS.
 *
 * One client application over the same REST surface the site reads, with the sidebar, the eight
 * views and the editor from the prototype. Routing is by URL segment rather than by state, so a
 * specialist can send a colleague a link to the property they are both looking at.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/** What the narrow bar calls the screen you are on. */
const VIEW_LABEL: Record<View, string> = {
  dashboard: 'Dashboard',
  properties: 'Properties',
  offers: 'Offers',
  destinations: 'Destinations',
  homepage: 'Homepage',
  settings: 'Settings',
  enquiries: 'Enquiries',
  media: 'Media',
  team: 'Team',
}

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
  /**
   * The sidebar is the only way to reach seven of the nine sections, and below 820px it used to be
   * `display:none` with nothing in its place — so on a phone the workspace was three dashboard
   * cards and no way back. It is a drawer at that width now; above it, nothing about this changes.
   */
  const [navOpen, setNavOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)

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

  /**
   * The playable address of a video reference.
   *
   * Separate from `resolveImage` on purpose: for a video record that one answers with the poster,
   * which is what a thumbnail wants, and handing that to a `<video>` would be a preview that
   * never plays. A plain URL passes through — the two clips this site has always served live under
   * `/assets`, and they are as real an answer as an uploaded one.
   */
  const resolveVideo = useCallback(
    (ref: string): string => {
      if (!ref) return ''
      if (!ref.startsWith('media:')) return ref
      const rec = ws.media.find((m) => m.id === ref.slice(6))
      return rec?.urls?.video || ''
    },
    [ws.media],
  )

  const go = useCallback((path: string) => router.push(path), [router])
  const closeNav = useCallback(() => setNavOpen(false), [])

  // A drawer left open across a navigation covers the screen it just opened.
  useEffect(() => setNavOpen(false), [view, id])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setNavOpen(false)
      // Focus goes back to what opened it, or a keyboard user is left at the top of the document.
      menuButton.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  const body = useMemo(() => {
    if (view === 'dashboard') return <Dashboard ws={ws} go={go} can={can} />
    if (view === 'enquiries') return <Enquiries ws={ws} reload={reload} say={say} can={can} />
    if (view === 'media') return <MediaLibrary ws={ws} reload={reload} say={say} can={can} />
    if (view === 'team') return <Team ws={ws} reload={reload} say={say} />
    const col = view as ContentCollection
    if (id) return <Editor col={col} id={id} ws={ws} reload={reload} say={say} can={can} go={go} resolveImage={resolveImage} resolveVideo={resolveVideo} />
    // The two singles open straight into their editor: there is only ever one document.
    if (col === 'homepage' || col === 'settings') return <Editor col={col} id="main" ws={ws} reload={reload} say={say} can={can} go={go} resolveImage={resolveImage} resolveVideo={resolveVideo} />
    return <CollectionList col={col} ws={ws} reload={reload} say={say} can={can} go={go} />
  }, [view, id, ws, reload, say, can, go, resolveImage, resolveVideo])

  const newEnquiries = ws.enquiries.filter((e) => e.status === 'new').length

  return (
    <div id="app-grid" data-nav={navOpen ? 'open' : 'shut'} style={css('display:grid;grid-template-columns:232px 1fr;min-height:100vh;background:var(--bg);color:var(--ink);')}>
      {/* Drawn only below 820px, by admin.css. Above it the sidebar is always there and this is not. */}
      <header id="studio-bar" style={css('display:none;align-items:center;gap:12px;padding:0 14px;height:60px;background:var(--bg-deep);border-bottom:1px solid var(--line-06);position:sticky;top:0;z-index:120;')}>
        <button
          ref={menuButton}
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          aria-label={navOpen ? 'Close the sections menu' : 'Open the sections menu'}
          style={css('display:flex;align-items:center;justify-content:center;gap:9px;background:none;border:1px solid var(--line-16);color:var(--ink);height:44px;min-width:44px;padding:0 13px;border-radius:3px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;')}
        >
          Menu
          <span style={css('display:flex;flex-direction:column;gap:4px;')}>
            <span style={css('display:block;width:15px;height:1px;background:currentColor;')} />
            <span style={css('display:block;width:15px;height:1px;background:currentColor;')} />
          </span>
        </button>
        <span style={css('flex:1;min-width:0;font-size:13px;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{VIEW_LABEL[view]}</span>
        {newEnquiries > 0 && (
          <span style={css('background:#E0B94F;color:#00102F;font-size:11px;font-weight:600;min-width:20px;height:20px;border-radius:999px;display:flex;align-items:center;justify-content:center;padding:0 6px;flex:none;')}>
            {newEnquiries}
          </span>
        )}
      </header>

      {/* The scrim is a real button so the drawer can be dismissed by tapping beside it. */}
      <button
        id="studio-scrim"
        type="button"
        tabIndex={navOpen ? 0 : -1}
        aria-label="Close the sections menu"
        onClick={closeNav}
        style={css('display:none;position:fixed;inset:0;z-index:130;border:0;background:rgba(5,7,14,.6);')}
      />

      <Sidebar
        user={ws.user}
        view={view}
        newEnquiries={newEnquiries}
        can={can}
        go={go}
        say={say}
        onNavigate={closeNav}
      />
      <main id="main" style={css('padding:28px 32px 80px;min-width:0;')}>
        {loading ? <div style={css('color:var(--muted);font-size:13px;padding:40px 0;')}>Loading the workspace…</div> : body}
      </main>
      <Toast message={toast?.message ?? null} tone={toast?.tone} />
    </div>
  )
}
