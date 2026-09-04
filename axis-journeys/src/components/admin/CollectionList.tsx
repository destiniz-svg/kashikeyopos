'use client'

/** A collection list: search, status filter, thumbnails, and the door to a new document. */
import { useMemo, useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { api } from '@/lib/admin/client'
import { blankDoc, type SchemaContext } from '@/lib/admin/schema'
import type { Permission } from '@/lib/auth/roles'
import type { ContentCollection } from '@/lib/content/types'
import { Button, Empty, FIELD_STYLE, Kicker, PageTitle, StatusPill } from './ui'
import type { Workspace } from './AdminApp'

const COPY: Record<string, { title: string; blurb: string; add: string }> = {
  properties: { title: 'Properties', blurb: 'Every island, villa and retreat you sell. Full details live here; rates only appear inside offers.', add: 'New property' },
  offers: { title: 'Offers', blurb: 'The only published rates on the site. Each one names a property and is always subject to availability.', add: 'New offer' },
  destinations: { title: 'Destinations', blurb: 'The regions you sell. A destination that is not published still renders for anybody holding its link.', add: 'New destination' },
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

export function CollectionList({
  col,
  ws,
  reload,
  say,
  can,
  go,
}: {
  col: ContentCollection
  ws: Workspace
  reload(): Promise<void>
  say(m: string, tone?: 'ok' | 'err'): void
  can(p: Permission): boolean
  go(path: string): void
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'published' | 'changed' | 'draft'>('all')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const copy = COPY[col] ?? { title: col, blurb: '', add: 'New' }

  const ctx: SchemaContext = useMemo(
    () => ({
      lists: ws.lists,
      destinations: ws.cols.destinations.map((d) => ({ name: String((d.draft as { name?: string }).name || '') })).filter((d) => d.name),
      properties: ws.cols.properties.map((p) => ({ id: p.id, name: String((p.draft as { name?: string }).name || p.id), dest: String((p.draft as { dest?: string }).dest || '') })),
    }),
    [ws],
  )

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ws.cols[col].filter((d) => {
      if (filter !== 'all' && d.status !== filter) return false
      if (!q) return true
      const draft = d.draft as Record<string, unknown>
      return [draft.name, draft.badge, draft.dest, draft.area, draft.tier, d.id].some((v) => String(v ?? '').toLowerCase().includes(q))
    })
  }, [ws, col, search, filter])

  const create = async () => {
    const name = newName.trim()
    if (!name) {
      say('Give it a name to start', 'err')
      return
    }
    const id = slug(name) || `new-${Date.now().toString(36)}`
    if (ws.cols[col].some((d) => d.id === id)) {
      say('There is already a document with that name', 'err')
      return
    }
    try {
      const draft = { ...blankDoc(col, ctx), name, ...(col === 'destinations' ? { slug: id } : {}) }
      await api.create(col, id, draft)
      await reload()
      setCreating(false)
      setNewName('')
      go(`/admin/${col}/${id}`)
    } catch (e) {
      say((e as Error).message, 'err')
    }
  }

  return (
    <>
      <div style={css('display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;')}>
        <div>
          <Kicker>Content</Kicker>
          <PageTitle>{copy.title}</PageTitle>
          <p style={css('font-size:13px;color:var(--muted);margin:10px 0 0;max-width:620px;line-height:1.6;')}>{copy.blurb}</p>
        </div>
        {can('write') && <Button tone="gold" onClick={() => setCreating((v) => !v)}>{copy.add}</Button>}
      </div>

      {creating && (
        <div style={css('margin-top:18px;background:var(--panel);border:1px solid var(--line-1);border-radius:4px;padding:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;')}>
          <input
            autoFocus
            value={newName}
            placeholder={col === 'offers' ? 'Offer badge, e.g. Early bird' : 'Name'}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            style={{ ...css(FIELD_STYLE), maxWidth: 340 }}
          />
          <Button tone="gold" onClick={() => void create()}>Create</Button>
          <Button onClick={() => setCreating(false)}>Cancel</Button>
          <span style={css('font-size:12px;color:var(--muted);')}>It starts as a draft — nothing reaches the site until you publish it.</span>
        </div>
      )}

      <div style={css('display:flex;gap:10px;align-items:center;margin-top:22px;flex-wrap:wrap;')}>
        <input value={search} placeholder="Search…" onChange={(e) => setSearch(e.target.value)} style={{ ...css(FIELD_STYLE), maxWidth: 260 }} />
        {(['all', 'published', 'changed', 'draft'] as const).map((f) => {
          const on = filter === f
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(f)}
              style={{
                ...css('padding:8px 16px;font-size:12px;border-radius:999px;min-height:38px;text-transform:capitalize;transition:all .2s;'),
                background: on ? 'rgba(224,185,79,.16)' : 'transparent',
                color: on ? '#E0B94F' : 'var(--ink)',
                border: `1px solid ${on ? '#E0B94F' : 'var(--line-14)'}`,
              }}
            >
              {f}
            </button>
          )
        })}
      </div>

      <div style={css('margin-top:18px;background:var(--panel);border:1px solid var(--line-08);border-radius:4px;overflow:hidden;')}>
        <div className="list-head" style={css('padding:12px 20px;border-bottom:1px solid var(--line-08);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);')}>
          <span />
          <span>{col === 'offers' ? 'Offer' : 'Name'}</span>
          <span>{col === 'offers' ? 'Property' : 'Destination'}</span>
          <span>{col === 'offers' ? 'Date' : 'Tier'}</span>
          <span>Status</span>
          <span>Updated</span>
        </div>
        {rows.length === 0 ? (
          <div style={css('padding:12px;')}>
            <Empty title="Nothing here yet" body={search || filter !== 'all' ? 'No document matches that search.' : 'Create the first one — it starts as a draft and nothing reaches the site until you publish it.'} />
          </div>
        ) : (
          rows.map((d) => {
            const draft = d.draft as Record<string, unknown>
            const prop = col === 'offers' ? ws.cols.properties.find((p) => p.id === draft.resort) : null
            const img = String(draft.img || (prop?.draft as { img?: string } | undefined)?.img || '')
            return (
              <Hover
                key={d.id}
                as="button"
                type="button"
                onClick={() => go(`/admin/${col}/${d.id}`)}
                className="list-row"
                style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line-06);padding:12px 20px;color:var(--ink);min-height:64px;transition:background .2s;"
                hover="background:var(--line-04);"
              >
                <span style={{ ...css('height:44px;border-radius:3px;background:var(--field);background-size:cover;background-position:center;'), backgroundImage: img && !img.startsWith('media:') ? `url(${img})` : undefined }} />
                <span style={css('min-width:0;')}>
                  <span style={css('display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>
                    {String(draft.name || draft.badge || d.id)}
                  </span>
                  <span style={css('display:block;font-size:12px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>
                    {String(draft.area || draft.perk || draft.tagline || '')}
                  </span>
                </span>
                <span style={css('font-size:13px;color:var(--muted);')}>{col === 'offers' ? String((prop?.draft as { name?: string } | undefined)?.name || '—') : String(draft.dest || draft.slug || '')}</span>
                <span style={css('font-size:13px;color:var(--muted);')}>{col === 'offers' ? String(draft.date || '') : String(draft.tier || '')}</span>
                <span>
                  <StatusPill status={d.status} />
                </span>
                <span style={css('font-size:12px;color:var(--muted);')}>{new Date(d.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              </Hover>
            )
          })
        )}
      </div>
    </>
  )
}
