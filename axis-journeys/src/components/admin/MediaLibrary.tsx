'use client'

/**
 * The media library: drag-and-drop upload, alt text, credit, and the focal point picker.
 *
 * The focal point is the difference between a wide crop that keeps the villa and one that keeps
 * the sky. It is stored as a percentage pair and applied as `object-position` wherever the image
 * is drawn, so one click here fixes every crop of that photograph on the site.
 */
import { useRef, useState } from 'react'
import { css } from '@/components/ui/css'
import { api, renditions } from '@/lib/admin/client'
import type { MediaRecord } from '@/lib/content/types'
import type { Permission } from '@/lib/auth/roles'
import { Button, Empty, FIELD_STYLE, Kicker, Label, PageTitle, Panel } from './ui'
import type { Workspace } from './AdminApp'

type Rec = MediaRecord & { urls: Record<string, string> }

export function MediaLibrary({
  ws,
  reload,
  say,
  can,
}: {
  ws: Workspace
  reload(): Promise<void>
  say(m: string, tone?: 'ok' | 'err'): void
  can(p: Permission): boolean
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const current = ws.media.find((m) => m.id === selected) ?? null

  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) {
      say('Only images can be uploaded here', 'err')
      return
    }
    setUploading(list.length)
    for (const file of list) {
      try {
        const { form } = await renditions(file)
        await api.uploadMedia(form)
      } catch (e) {
        say(`${file.name}: ${(e as Error).message}`, 'err')
      } finally {
        setUploading((n) => n - 1)
      }
    }
    await reload()
    say(`${list.length} image${list.length === 1 ? '' : 's'} uploaded`)
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.patchMedia(id, body)
      await reload()
    } catch (e) {
      say((e as Error).message, 'err')
    }
  }

  return (
    <>
      <Kicker>Library</Kicker>
      <PageTitle>Media</PageTitle>
      <p style={css('font-size:13px;color:var(--muted);margin:10px 0 0;max-width:620px;line-height:1.6;')}>
        Images are resized on your device before they are sent — 1600, 800 and 320 wide — which also strips the camera&apos;s location data.
      </p>

      {can('media') && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void upload(e.dataTransfer.files)
          }}
          style={{
            ...css('margin-top:20px;border-radius:4px;padding:28px;text-align:center;transition:all .2s;'),
            border: `1px dashed ${dragging ? 'var(--gold-ink)' : 'var(--line-16)'}`,
            background: dragging ? 'rgba(224,185,79,.06)' : 'transparent',
          }}
        >
          <div style={css('font-size:14px;')}>Drop images here</div>
          <div style={css('font-size:12px;color:var(--muted);margin:6px 0 14px;')}>JPEG, PNG or WebP · up to 10 MB each</div>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
          <Button onClick={() => input.current?.click()}>Choose files</Button>
          {uploading > 0 && <div style={css('font-size:12px;color:var(--gold-ink);margin-top:12px;')}>Uploading {uploading}…</div>}
        </div>
      )}

      {ws.media.length === 0 ? (
        <div style={css('margin-top:20px;')}>
          <Empty title="The library is empty" body="Upload the resort's own photography here, then pick it on each property. Until then the site shows the stand-in images the catalogue shipped with." />
        </div>
      ) : (
        <div id="media-grid" style={css('display:grid;grid-template-columns:1fr 360px;gap:16px;margin-top:20px;align-items:start;')}>
          <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;')}>
            {ws.media.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelected(m.id)}
                title={m.name}
                style={{
                  ...css('position:relative;aspect-ratio:4/3;border-radius:3px;overflow:hidden;padding:0;background-size:cover;background-position:center;transition:all .2s;'),
                  backgroundImage: `url(${m.urls.thumb})`,
                  border: `1px solid ${selected === m.id ? 'var(--gold-ink)' : 'var(--line-1)'}`,
                }}
              >
                <span style={css('position:absolute;left:0;right:0;bottom:0;padding:14px 8px 6px;font-size:10px;color:#F3EFE6;background:linear-gradient(180deg,transparent,rgba(0,16,47,.9));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;')}>
                  {m.name}
                </span>
              </button>
            ))}
          </div>

          {current && (
            <Panel id="media-detail" style={css('position:sticky;top:24px;')}>
              <FocalPicker rec={current} onPick={(x, y) => void patch(current.id, { focal: { x, y } })} />
              <div style={css('margin-top:16px;')}>
                <Label>Name</Label>
                <input defaultValue={current.name} onBlur={(e) => void patch(current.id, { name: e.target.value })} style={css(FIELD_STYLE)} />
              </div>
              <div style={css('margin-top:12px;')}>
                <Label hint="What a screen reader says">Alt text</Label>
                <input defaultValue={current.alt} onBlur={(e) => void patch(current.id, { alt: e.target.value })} style={css(FIELD_STYLE)} />
              </div>
              <div style={css('margin-top:12px;')}>
                <Label>Credit</Label>
                <input defaultValue={current.credit} onBlur={(e) => void patch(current.id, { credit: e.target.value })} style={css(FIELD_STYLE)} />
              </div>
              <div style={css('margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6;')}>
                {current.w} × {current.h} · {(current.bytes / 1024).toFixed(0)} KB · uploaded by {current.by}
                <br />
                Reference: <code style={css('color:var(--gold-ink);')}>media:{current.id}</code>
              </div>
              {can('media') && (
                <div style={css('margin-top:14px;')}>
                  <Button
                    tone="danger"
                    onClick={async () => {
                      if (!confirm(`Remove ${current.name}? Anything still pointing at it will show no image.`)) return
                      try {
                        await api.deleteMedia(current.id)
                        setSelected(null)
                        await reload()
                      } catch (e) {
                        say((e as Error).message, 'err')
                      }
                    }}
                  >
                    Remove from the library
                  </Button>
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
    </>
  )
}

function FocalPicker({ rec, onPick }: { rec: Rec; onPick(x: number, y: number): void }) {
  return (
    <div>
      <Label hint="Click the subject">Focal point</Label>
      <button
        type="button"
        onClick={(e) => {
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
          onPick(Math.round(((e.clientX - box.left) / box.width) * 100), Math.round(((e.clientY - box.top) / box.height) * 100))
        }}
        style={{ ...css('position:relative;width:100%;aspect-ratio:4/3;border:1px solid var(--line-12);border-radius:3px;padding:0;background-size:cover;background-position:center;cursor:crosshair;'), backgroundImage: `url(${rec.urls.card})` }}
      >
        <span
          style={{
            ...css('position:absolute;width:18px;height:18px;border-radius:50%;border:2px solid #E0B94F;background:rgba(224,185,79,.25);transform:translate(-50%,-50%);pointer-events:none;'),
            left: `${rec.focal?.x ?? 50}%`,
            top: `${rec.focal?.y ?? 50}%`,
          }}
        />
      </button>
    </div>
  )
}

/** The picker the editor opens when a field asks for an image. */
export function MediaPicker({ media, onPick, onClose }: { media: Rec[]; onPick(ref: string): void; onClose(): void }) {
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Choose an image" style={css('position:fixed;inset:0;z-index:150;background:rgba(5,7,14,.75);display:flex;align-items:center;justify-content:center;padding:24px;')}>
      <div onClick={(e) => e.stopPropagation()} style={css('background:var(--bg);border:1px solid var(--line-12);border-radius:4px;max-width:860px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;')}>
        <div style={css('display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;')}>
          <h2 style={css('margin:0;font-size:20px;font-weight:400;')}>Choose an image</h2>
          <Button onClick={onClose}>Close</Button>
        </div>
        {media.length === 0 ? (
          <Empty title="Nothing in the library yet" body="Upload images under Media, then pick them here." />
        ) : (
          <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;')}>
            {media.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onPick(`media:${m.id}`)}
                title={m.name}
                style={{ ...css('aspect-ratio:4/3;border:1px solid var(--line-1);border-radius:3px;padding:0;background-size:cover;background-position:center;'), backgroundImage: `url(${m.urls.thumb})` }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
