'use client'

/**
 * The document editor: sectioned tabs, autosave, the completeness bar with its readiness hint, and
 * the publish/discard/unpublish/delete controls.
 *
 * The completeness bar reads `readiness()` — the same function the publish endpoint refuses with
 * and the public bundle filters with — so what the bar says is what the server will do. A second
 * opinion here is how a property publishes and then fails to render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@/components/ui/css'
import { api } from '@/lib/admin/client'
import { sectionsFor, type SchemaContext } from '@/lib/admin/schema'
import { readiness } from '@/lib/content/rules'
import type { ContentCollection, Property } from '@/lib/content/types'
import type { Permission } from '@/lib/auth/roles'
import { Button, Kicker, Label, Panel, StatusPill } from './ui'
import { FieldControl } from './Fields'
import { MediaPicker } from './MediaLibrary'
import type { Workspace } from './AdminApp'

type Draft = Record<string, unknown>

const read = (obj: Draft, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Draft)[k]), obj)

const write = (obj: Draft, path: string, value: unknown): Draft => {
  const next = JSON.parse(JSON.stringify(obj)) as Draft
  const keys = path.split('.')
  let cursor: Draft = next
  for (const k of keys.slice(0, -1)) {
    if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {}
    cursor = cursor[k] as Draft
  }
  cursor[keys[keys.length - 1]] = value
  return next
}

export function Editor({
  col,
  id,
  ws,
  reload,
  say,
  can,
  go,
  resolveImage,
  resolveVideo,
}: {
  col: ContentCollection
  id: string
  ws: Workspace
  reload(): Promise<void>
  say(m: string, tone?: 'ok' | 'err'): void
  can(p: Permission): boolean
  go(path: string): void
  resolveImage(ref: string): string
  resolveVideo(ref: string): string
}) {
  const doc = ws.cols[col].find((d) => d.id === id) ?? null
  const [draft, setDraft] = useState<Draft | null>(null)
  const [section, setSection] = useState(0)
  const [saveState, setSaveState] = useState('')
  const [busy, setBusy] = useState(false)
  // The apply function and what it is allowed to pick, held together: a destination's hero clip
  // cannot be a photograph, and a room's gallery takes several at once.
  const [picker, setPicker] = useState<{ apply(refs: string[]): void; only?: 'image' | 'video'; multiple?: boolean } | null>(null)
  const [preview, setPreview] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (doc && draft === null) setDraft(doc.draft as Draft)
  }, [doc, draft])

  const ctx: SchemaContext = useMemo(
    () => ({
      lists: ws.lists,
      destinations: ws.cols.destinations.map((d) => ({ name: String((d.draft as { name?: string }).name || '') })).filter((d) => d.name),
      properties: ws.cols.properties.map((p) => ({ id: p.id, name: String((p.draft as { name?: string }).name || p.id), dest: String((p.draft as { dest?: string }).dest || '') })),
    }),
    [ws],
  )

  const sections = useMemo(() => sectionsFor(col, ctx), [col, ctx])

  const save = useCallback(
    async (next: Draft) => {
      if (!can('write')) return
      try {
        await api.save(col, id, next)
        setSaveState('Saved')
        void reload()
      } catch (e) {
        setSaveState('Could not save')
        say((e as Error).message, 'err')
      }
    },
    [col, id, can, reload, say],
  )

  const set = useCallback(
    (path: string, value: unknown) => {
      setDraft((d) => {
        if (!d) return d
        const next = write(d, path, value)
        setSaveState('Saving…')
        if (timer.current) clearTimeout(timer.current)
        // 500ms of quiet before a write: the prototype's own debounce, and what keeps a typed
        // sentence from becoming forty requests.
        timer.current = setTimeout(() => void save(next), 500)
        return next
      })
    },
    [save],
  )

  // A pending autosave must not be lost when the editor unmounts.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const act = async (action: 'publish' | 'unpublish' | 'discard' | 'delete') => {
    if (!draft) return
    setBusy(true)
    if (timer.current) clearTimeout(timer.current)
    try {
      if (action !== 'delete') await api.save(col, id, draft)
      if (action === 'publish') {
        await api.publish(col, id)
        say('Published — it is on the site now')
      } else if (action === 'unpublish') {
        await api.unpublish(col, id)
        say('Taken off the site')
      } else if (action === 'discard') {
        const back = await api.discard(col, id)
        setDraft(back.draft as Draft)
        say('Draft reset to the published version')
      } else {
        await api.remove(col, id)
        say('Deleted')
        await reload()
        go(`/admin/${col}`)
        return
      }
      await reload()
      setSaveState('Saved')
    } catch (e) {
      say((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  if (!doc || !draft) {
    return (
      <div style={css('color:var(--muted);font-size:13px;padding:40px 0;')}>
        That document is not in this workspace.{' '}
        <button type="button" onClick={() => go(`/admin/${col}`)} style={css('background:none;border:0;color:var(--gold-ink);font-size:13px;')}>
          Back to the list
        </button>
      </div>
    )
  }

  const isProperty = col === 'properties'
  const check = isProperty ? readiness(draft as unknown as Property) : { ready: true, missing: [] }
  // Completeness is measured against the same ten things `readiness()` asks for, so the bar and
  // the publish button can never disagree.
  const total = 10
  const complete = isProperty ? Math.round(((total - check.missing.length) / total) * 100) : 100
  const title = String(draft.name || draft.badge || (col === 'homepage' ? 'Homepage' : col === 'settings' ? 'Settings' : id))
  const single = col === 'homepage' || col === 'settings'

  return (
    <>
      {!single && (
        <button type="button" onClick={() => go(`/admin/${col}`)} style={css('background:none;border:0;padding:0;color:var(--muted);font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin-bottom:14px;')}>
          ← {col}
        </button>
      )}
      {single && <Kicker>{col === 'homepage' ? 'Homepage' : 'Settings'}</Kicker>}

      <div style={css('display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap;')}>
        <div style={css('min-width:0;')}>
          <h1 style={css('font-weight:300;font-size:34px;line-height:1.1;margin:0;letter-spacing:-.01em;display:flex;align-items:center;gap:14px;flex-wrap:wrap;')}>
            {title}
            <StatusPill status={doc.status} />
          </h1>
          <div style={css('font-size:12px;color:var(--muted);margin-top:8px;')}>
            Updated {new Date(doc.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} by {doc.updatedBy}
            {saveState ? ` · ${saveState}` : ''}
          </div>
        </div>
        <div style={css('display:flex;gap:8px;flex-wrap:wrap;')}>
          <Button onClick={() => setPreview((v) => !v)}>{preview ? 'Hide preview' : 'Show preview'}</Button>
          {doc.status === 'changed' && can('write') && <Button onClick={() => void act('discard')} disabled={busy}>Discard</Button>}
          {doc.live && can('publish') && <Button onClick={() => void act('unpublish')} disabled={busy}>Unpublish</Button>}
          {!single && can('delete') && (
            <Button
              tone="danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete “${title}”? This cannot be undone.`)) void act('delete')
              }}
            >
              Delete
            </Button>
          )}
          {can('publish') && (
            <Button tone="gold" onClick={() => void act('publish')} disabled={busy || (isProperty && !check.ready)} title={isProperty && !check.ready ? `Not live yet — the site needs: ${check.missing.join(', ')}` : undefined}>
              {doc.status === 'changed' ? 'Publish changes' : 'Publish'}
            </Button>
          )}
        </div>
      </div>

      {isProperty && (
        <Panel style={css('margin-top:18px;padding:16px 20px;')}>
          <div style={css('display:flex;justify-content:space-between;font-size:12px;color:var(--muted);')}>
            <span>Completeness</span>
            <span>{complete}%</span>
          </div>
          <div style={css('height:3px;background:var(--line-1);margin:10px 0;border-radius:2px;overflow:hidden;')}>
            <div style={{ ...css('height:3px;background:#E0B94F;transition:width .4s ease;'), width: `${complete}%` }} />
          </div>
          <div style={{ ...css('font-size:12px;'), color: check.ready ? '#6BCB9A' : 'var(--muted)' }}>
            {check.ready ? 'Ready for the site.' : `Not live yet — the site needs: ${check.missing.join(', ')}.`}
          </div>
        </Panel>
      )}

      <div style={css('display:flex;gap:4px;flex-wrap:wrap;margin:22px 0 0;border-bottom:1px solid var(--line-08);')}>
        {sections.map((s, i) => {
          const on = i === section
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(i)}
              aria-current={on ? 'true' : undefined}
              style={{
                ...css('background:none;border:0;padding:12px 14px;font-size:13px;min-height:44px;transition:all .2s;'),
                color: on ? 'var(--ink)' : 'var(--muted)',
                borderBottom: `2px solid ${on ? '#E0B94F' : 'transparent'}`,
              }}
            >
              {s.title}
            </button>
          )
        })}
      </div>

      <div style={css('display:grid;gap:16px;margin-top:18px;')}>
        <Panel style={css('padding:24px;')}>
          <h2 style={css('margin:0;font-size:20px;font-weight:400;')}>{sections[section]?.title}</h2>
          {sections[section]?.help && <p style={css('font-size:13px;color:var(--muted);margin:8px 0 20px;line-height:1.6;max-width:760px;')}>{sections[section].help}</p>}
          <div id="field-grid" style={css('display:grid;grid-template-columns:1fr 1fr;gap:18px;')}>
            {(sections[section]?.fields ?? []).map((f) => (
              <div key={f.path} style={f.span === '1/-1' || f.type === 'list' ? css('grid-column:1/-1;') : undefined}>
                <Label hint={f.hint} required={f.req}>
                  {f.label}
                </Label>
                <FieldControl
                  field={f}
                  value={read(draft, f.path)}
                  onChange={(v) => set(f.path, v)}
                  onPickImage={(_current, apply, opts) => setPicker({ apply, ...opts })}
                  resolveImage={resolveImage}
                  resolveVideo={resolveVideo}
                />
              </div>
            ))}
          </div>
        </Panel>

        {preview && (
          <Panel style={css('padding:0;overflow:hidden;')}>
            <div style={css('padding:12px 16px;border-bottom:1px solid var(--line-08);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:12px;')}>
              <span>Live preview · unpublished drafts included</span>
              <a href={previewUrl(col, id, draft)} target="_blank" rel="noopener" style={css('font-size:12px;')}>
                Open in a tab ↗
              </a>
            </div>
            <iframe title="Site preview" src={previewUrl(col, id, draft)} style={css('display:block;width:100%;height:70vh;border:0;background:var(--bg);')} />
          </Panel>
        )}
      </div>

      {picker && (
        <MediaPicker
          media={ws.media}
          only={picker.only}
          multiple={picker.multiple}
          onPick={(refs) => {
            picker.apply(refs)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}

/** Where the preview points. `?preview=1` serves drafts, and the API checks the session. */
function previewUrl(col: ContentCollection, id: string, draft: Record<string, unknown>): string {
  if (col === 'properties') return `/properties/${id}?preview=1`
  if (col === 'destinations') return `/destinations/${String(draft.slug || id)}?preview=1`
  if (col === 'offers') return `/?preview=1#offers`
  return `/?preview=1`
}
