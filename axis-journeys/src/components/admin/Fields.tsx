'use client'

/**
 * The editor's field renderers, generic over `schema.ts`.
 *
 * A tuple row (`[name, meta, supplement, …]`) and an object row (`{img, cap}`) are both edited
 * here, because the content model uses both and the schema says which by whether a column carries
 * a `key`. Nothing in this file knows what a property is.
 */
import { useState } from 'react'
import { css } from '@/components/ui/css'
import { probeVideoUrl } from '@/lib/admin/client'
import { Button, FIELD_STYLE, Label } from './ui'
import { StandardReport } from './StandardReport'
import type { Field, ListColumn } from '@/lib/admin/schema'
import type { Finding } from '@/lib/media/standards'
import { MONTHS } from '@/lib/content/types'

export interface PickOptions {
  /** Which kind of record this field can actually use. */
  only?: 'image' | 'video'
  /** Whether the picker collects several before it closes. */
  multiple?: boolean
}

export interface FieldProps {
  field: Field
  value: unknown
  onChange(value: unknown): void
  /**
   * Opens the media library. It answers with a list because some fields take several — a room's
   * photographs, a venue's — and asking for those one modal at a time is the kind of round trip
   * nobody makes twice.
   */
  onPickImage(current: string, apply: (refs: string[]) => void, opts?: PickOptions): void
  /** Resolves a stored reference to something an <img> can load. */
  resolveImage(ref: string): string
  /** Resolves a stored reference to something a <video> can play. */
  resolveVideo?(ref: string): string
}

const str = (v: unknown): string => (v == null ? '' : String(v))

export function FieldControl(props: FieldProps) {
  const { field, value, onChange } = props
  const type = field.type ?? 'text'

  if (type === 'textarea') {
    return (
      <textarea
        rows={field.rows ?? 3}
        value={str(value)}
        placeholder={field.ph}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...css(FIELD_STYLE), lineHeight: 1.55 }}
      />
    )
  }

  if (type === 'number' || type === 'percent') {
    const shown = type === 'percent' ? (value == null ? '' : String(Math.round(Number(value) * 100))) : str(value)
    return (
      <input
        type="number"
        value={shown}
        placeholder={field.ph}
        onChange={(e) => {
          const n = e.target.value === '' ? '' : Number(e.target.value)
          onChange(type === 'percent' ? (n === '' ? 0 : Number(n) / 100) : n === '' ? '' : n)
        }}
        style={css(FIELD_STYLE)}
      />
    )
  }

  if (type === 'select') {
    // A select whose options do not include the stored value would silently rewrite it on the next
    // save, so the current value is offered too.
    const options = field.options ?? []
    const known = options.some((o) => String(o.v) === str(value))
    return (
      <select value={str(value)} onChange={(e) => onChange(coerceSelect(e.target.value, options))} style={css(FIELD_STYLE)}>
        {!known && <option value={str(value)}>{str(value) || '—'}</option>}
        {options.map((o) => (
          <option key={String(o.v)} value={String(o.v)}>
            {o.l}
          </option>
        ))}
      </select>
    )
  }

  if (type === 'chips') {
    const on = Array.isArray(value) ? (value as string[]) : []
    return (
      <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>
        {(field.choices ?? []).map((c) => {
          const active = on.includes(c)
          return (
            <button
              key={c}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? on.filter((x) => x !== c) : [...on, c])}
              style={{
                ...css('padding:8px 14px;font-size:12px;border-radius:999px;min-height:36px;transition:all .2s;'),
                background: active ? 'rgba(224,185,79,.16)' : 'transparent',
                color: active ? '#E0B94F' : 'var(--ink)',
                border: `1px solid ${active ? '#E0B94F' : 'var(--line-16)'}`,
              }}
            >
              {c}
            </button>
          )
        })}
      </div>
    )
  }

  if (type === 'months') {
    const on = Array.isArray(value) ? (value as number[]) : []
    return (
      <div style={css('display:flex;flex-wrap:wrap;gap:6px;')}>
        {MONTHS.map((m, i) => {
          const n = i + 1
          const active = on.includes(n)
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? on.filter((x) => x !== n) : [...on, n].sort((a, b) => a - b))}
              style={{
                ...css('padding:7px 12px;font-size:12px;border-radius:999px;min-height:34px;transition:all .2s;'),
                background: active ? 'rgba(224,185,79,.16)' : 'transparent',
                color: active ? '#E0B94F' : 'var(--ink)',
                border: `1px solid ${active ? '#E0B94F' : 'var(--line-16)'}`,
              }}
            >
              {m.slice(0, 3)}
            </button>
          )
        })}
      </div>
    )
  }

  if (type === 'tags') return <TagEditor value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} placeholder={field.ph} />

  if (type === 'image') return <ImageField {...props} />

  if (type === 'images') return <ImagesField {...props} />

  if (type === 'video') return <VideoField {...props} />

  if (type === 'list') return <ListEditor {...props} />

  return <input type="text" value={str(value)} placeholder={field.ph} onChange={(e) => onChange(e.target.value)} style={css(FIELD_STYLE)} />
}

function coerceSelect(v: string, options: { v: string | number; l: string }[]): string | number | boolean {
  const match = options.find((o) => String(o.v) === v)
  if (match) return match.v
  // The destination editor's live flag is a yes/no select over a boolean.
  if (v === 'yes') return true
  if (v === 'no') return false
  return v
}

function TagEditor({ value, onChange, placeholder }: { value: string[]; onChange(v: string[]): void; placeholder?: string }) {
  const [text, setText] = useState('')
  const commit = () => {
    const t = text.trim()
    if (!t) return
    onChange([...value, t])
    setText('')
  }
  return (
    <div>
      <div style={css('display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;')}>
        {value.map((t, i) => (
          <span key={`${t}-${i}`} style={css('display:inline-flex;align-items:center;gap:8px;font-size:12px;padding:6px 10px;border:1px solid var(--line-16);border-radius:999px;')}>
            {t}
            <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${t}`} style={css('background:none;border:0;color:var(--muted);font-size:14px;padding:0;line-height:1;')}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <div style={css('display:flex;gap:8px;')}>
        <input
          value={text}
          placeholder={placeholder || 'Add and press Enter'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          style={css(FIELD_STYLE)}
        />
        <Button onClick={commit}>Add</Button>
      </div>
    </div>
  )
}

function ImageField({ value, onChange, onPickImage, resolveImage }: FieldProps) {
  const ref = str(value)
  const src = ref ? resolveImage(ref) : ''
  return (
    <div style={css('display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:start;')}>
      <div style={{ ...css('height:84px;border:1px solid var(--line-12);border-radius:3px;background-size:cover;background-position:center;background-color:var(--field);'), backgroundImage: src ? `url(${src})` : undefined }} />
      <div style={css('display:flex;flex-direction:column;gap:8px;min-width:0;')}>
        <input value={ref} placeholder="https://… or media:id" onChange={(e) => onChange(e.target.value)} style={css(FIELD_STYLE)} />
        <div style={css('display:flex;gap:8px;flex-wrap:wrap;')}>
          <Button onClick={() => onPickImage(ref, (next) => onChange(next[0] ?? ''), { only: 'image' })}>Choose from Media</Button>
          {ref && <Button onClick={() => onChange('')}>Clear</Button>}
        </div>
      </div>
    </div>
  )
}

/**
 * Several photographs of one thing, in the order somebody chose.
 *
 * A room, a restaurant, a spa: one picture of any of them is a placeholder, and the site has always
 * had the gallery language to show more — it simply had nowhere to put them. Order is the whole
 * point of the arrows: the first photograph is the one the collapsed row and the card crop to.
 */
function ImagesField({ value, onChange, onPickImage, resolveImage }: FieldProps) {
  const refs: string[] = Array.isArray(value) ? (value as unknown[]).map(str).filter(Boolean) : []
  const write = (next: string[]) => onChange(next)
  const move = (i: number, by: number) => {
    const next = [...refs]
    const [row] = next.splice(i, 1)
    next.splice(i + by, 0, row)
    write(next)
  }
  return (
    <div style={css('display:flex;flex-direction:column;gap:10px;')}>
      {refs.length > 0 && (
        <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px;')}>
          {refs.map((ref, i) => {
            const src = resolveImage(ref)
            return (
              <div
                key={`${ref}-${i}`}
                style={{
                  ...css('position:relative;aspect-ratio:4/3;border:1px solid var(--line-12);border-radius:3px;background-size:cover;background-position:center;background-color:var(--field);'),
                  backgroundImage: src ? `url(${src})` : undefined,
                }}
              >
                <span style={css('position:absolute;left:5px;top:5px;font-size:10px;padding:2px 6px;border-radius:2px;background:rgba(0,16,47,.8);color:#E0B94F;')}>{i + 1}</span>
                <div style={css('position:absolute;right:4px;bottom:4px;display:flex;gap:4px;')}>
                  {i > 0 && (
                    <button type="button" aria-label={`Move photo ${i + 1} earlier`} onClick={() => move(i, -1)} style={css('width:30px;height:30px;border-radius:3px;border:1px solid var(--line-16);background:rgba(0,16,47,.8);color:var(--ink);font-size:12px;padding:0;')}>
                      ←
                    </button>
                  )}
                  {i < refs.length - 1 && (
                    <button type="button" aria-label={`Move photo ${i + 1} later`} onClick={() => move(i, 1)} style={css('width:30px;height:30px;border-radius:3px;border:1px solid var(--line-16);background:rgba(0,16,47,.8);color:var(--ink);font-size:12px;padding:0;')}>
                      →
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove photo ${i + 1}`}
                    onClick={() => write(refs.filter((_, j) => j !== i))}
                    style={css('width:30px;height:30px;border-radius:3px;border:1px solid rgba(224,122,107,.5);background:rgba(0,16,47,.8);color:#E07A6B;font-size:12px;padding:0;')}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div style={css('display:flex;gap:8px;flex-wrap:wrap;align-items:center;')}>
        <Button onClick={() => onPickImage('', (next) => write([...refs, ...next.filter((r) => !refs.includes(r))]), { only: 'image', multiple: true })}>
          {refs.length ? 'Add more photos' : 'Add photos'}
        </Button>
        <span style={css('font-size:11px;color:var(--muted);')}>
          {refs.length ? `${refs.length} photo${refs.length === 1 ? '' : 's'} · the first one leads` : 'The lead photo above is shown on its own until you add more'}
        </span>
      </div>
    </div>
  )
}

/**
 * A video: a library record, or an address.
 *
 * Both are real answers — a clip uploaded here, and the two files this site has always served out
 * of `/assets` — so neither is taken away. What is added is the check: a URL never went through
 * the upload door, so without pressing this nothing has ever looked at the one video a guest
 * actually watches.
 */
function VideoField({ value, onChange, onPickImage, resolveVideo }: FieldProps) {
  const ref = str(value)
  const [checking, setChecking] = useState(false)
  const [findings, setFindings] = useState<Finding[] | null>(null)
  const src = resolveVideo ? resolveVideo(ref) : ref

  const check = async () => {
    if (!src) return
    setChecking(true)
    setFindings(null)
    try {
      const v = await probeVideoUrl(src)
      setFindings(v.findings.length ? v.findings : [{ level: 'warn', code: 'ok', says: 'This video meets the standard for a full-screen hero.' }])
    } catch (e) {
      setFindings([{ level: 'refuse', code: 'failed', says: (e as Error).message }])
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={css('display:flex;flex-direction:column;gap:8px;')}>
      <input
        value={ref}
        placeholder="/assets/video/… or https://…mp4 or media:id"
        onChange={(e) => {
          setFindings(null)
          onChange(e.target.value)
        }}
        style={css(FIELD_STYLE)}
      />
      <div style={css('display:flex;gap:8px;flex-wrap:wrap;')}>
        <Button onClick={() => onPickImage(ref, (next) => onChange(next[0] ?? ''), { only: 'video' })}>Choose from Media</Button>
        <Button onClick={() => void check()} disabled={!src || checking}>
          {checking ? 'Checking…' : 'Check this video'}
        </Button>
        {ref && <Button onClick={() => onChange('')}>Clear</Button>}
      </div>
      {findings && <StandardReport findings={findings} />}
    </div>
  )
}

/** A row is a tuple unless the schema's columns carry keys, in which case it is an object. */
const isKeyed = (cols: ListColumn[]): boolean => cols.some((c) => !!c.key)

function ListEditor({ field, value, onChange, onPickImage, resolveImage, resolveVideo }: FieldProps) {
  const cols = field.cols ?? []
  const keyed = isKeyed(cols)
  const rows: unknown[] = field.single ? (value ? [value] : []) : Array.isArray(value) ? [...(value as unknown[])] : []

  const write = (next: unknown[]) => onChange(field.single ? (next[0] ?? null) : next)

  const many = (t?: string) => t === 'tags' || t === 'images'
  const blank = (): unknown => {
    if (keyed) return Object.fromEntries(cols.map((c) => [c.key!, many(c.type) ? [] : '']))
    // Sized by the furthest slot any column edits, so a row starts life the shape it will be saved
    // in rather than growing holes the first time somebody fills in a later field.
    const row: unknown[] = new Array(Math.max(cols.length, ...cols.map((c, i) => slot(c, i) + 1))).fill('')
    cols.forEach((c, i) => {
      row[slot(c, i)] = many(c.type) ? [] : c.type === 'number' ? 0 : ''
    })
    return row
  }

  // A column edits its own position in the row unless it says otherwise; see `ListColumn.at`.
  const slot = (col: ListColumn, i: number): number => col.at ?? i

  const cellValue = (row: unknown, col: ListColumn, i: number): unknown =>
    keyed ? (row as Record<string, unknown>)?.[col.key!] : (row as unknown[])?.[slot(col, i)]

  const setCell = (rowIndex: number, col: ListColumn, i: number, v: unknown) => {
    const next = rows.map((r, j) => {
      if (j !== rowIndex) return r
      if (keyed) return { ...(r as Record<string, unknown>), [col.key!]: v }
      const arr = Array.isArray(r) ? [...(r as unknown[])] : []
      const at = slot(col, i)
      while (arr.length <= at) arr.push('')
      arr[at] = v
      return arr
    })
    write(next)
  }

  return (
    <div style={css('display:flex;flex-direction:column;gap:10px;')}>
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} style={css('border:1px solid var(--line-1);border-radius:3px;padding:14px;background:var(--field);')}>
          <div style={css('display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;')}>
            <span style={css('font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);')}>
              {field.single ? field.label : `${field.label} ${rowIndex + 1}`}
            </span>
            <div style={css('display:flex;gap:6px;')}>
              {!field.single && rowIndex > 0 && (
                <button type="button" aria-label="Move up" onClick={() => { const n = [...rows]; const t = n[rowIndex - 1]; n[rowIndex - 1] = n[rowIndex]; n[rowIndex] = t; write(n) }} style={css('background:none;border:1px solid var(--line-12);color:var(--muted);border-radius:3px;width:30px;height:30px;')}>
                  ↑
                </button>
              )}
              {!field.single && rowIndex < rows.length - 1 && (
                <button type="button" aria-label="Move down" onClick={() => { const n = [...rows]; const t = n[rowIndex + 1]; n[rowIndex + 1] = n[rowIndex]; n[rowIndex] = t; write(n) }} style={css('background:none;border:1px solid var(--line-12);color:var(--muted);border-radius:3px;width:30px;height:30px;')}>
                  ↓
                </button>
              )}
              <button type="button" aria-label="Remove" onClick={() => write(rows.filter((_, j) => j !== rowIndex))} style={css('background:none;border:1px solid rgba(224,122,107,.4);color:#E07A6B;border-radius:3px;width:30px;height:30px;')}>
                ✕
              </button>
            </div>
          </div>
          <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:12px;')}>
            {cols.map((col, i) => (
              <div key={`${col.label}-${i}`} style={col.span === '1/-1' ? css('grid-column:1/-1;') : undefined}>
                <Label>{col.label}</Label>
                <FieldControl
                  field={{ path: `${field.path}.${rowIndex}.${slot(col, i)}`, label: col.label, type: col.type ?? 'text', ph: col.ph }}
                  value={cellValue(row, col, i)}
                  onChange={(v) => setCell(rowIndex, col, i, v)}
                  onPickImage={onPickImage}
                  resolveImage={resolveImage}
                  resolveVideo={resolveVideo}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      {(!field.single || rows.length === 0) && (
        <div>
          <Button onClick={() => write([...rows, blank()])}>{field.addLabel || `Add ${field.label.toLowerCase()}`}</Button>
        </div>
      )}
    </div>
  )
}
