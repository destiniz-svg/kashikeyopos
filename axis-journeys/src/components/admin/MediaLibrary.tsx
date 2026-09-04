'use client'

/**
 * The media library: drag-and-drop upload, alt text, credit, and the focal point picker.
 *
 * The focal point is the difference between a wide crop that keeps the villa and one that keeps
 * the sky. It is stored as a percentage pair and applied as `object-position` wherever the image
 * is drawn, so one click here fixes every crop of that photograph on the site.
 *
 * It holds video as well as photographs, because the one video a guest actually watches — the
 * full-screen clip behind a destination's headline — had no way in: it was a path somebody typed,
 * pointing at a file a developer had copied into the repository. A video record carries a poster
 * frame captured from the clip, which is what this grid draws and what a browser that refuses to
 * autoplay is left looking at.
 */
import { useRef, useState } from 'react'
import { css } from '@/components/ui/css'
import { api, renditions, videoRenditions } from '@/lib/admin/client'
import { kindOf, type MediaRecord } from '@/lib/content/types'
import type { Permission } from '@/lib/auth/roles'
import { Button, Empty, FIELD_STYLE, Kicker, Label, PageTitle, Panel } from './ui'
import { RejectedList, StandardReport, type Rejected } from './StandardReport'
import type { Workspace } from './AdminApp'

type Rec = MediaRecord & { urls: Record<string, string> }

const secs = (n?: number): string => (n ? `${n < 10 ? n.toFixed(1) : Math.round(n)}s` : '')

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
  const [notes, setNotes] = useState<Rejected[]>([])
  const input = useRef<HTMLInputElement>(null)
  const current = ws.media.find((m) => m.id === selected) ?? null

  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
    const wrong = [...files].length - list.length
    if (!list.length) {
      say('Only images and video can be uploaded here', 'err')
      return
    }
    if (wrong) say(`${wrong} file${wrong === 1 ? ' was' : 's were'} skipped — only images and video can be uploaded here`, 'err')

    setUploading(list.length)
    const found: Rejected[] = []
    let landed = 0
    for (const file of list) {
      const video = file.type.startsWith('video/')
      try {
        // Checked here first so nobody waits out a sixty-megabyte upload to be told the clip is
        // portrait. The server checks the bytes it receives, and it is the one that decides.
        const prepared = video ? await videoRenditions(file) : await renditions(file)
        if (!prepared.verdict.ok) {
          found.push({ name: file.name, findings: prepared.verdict.findings })
          continue
        }
        const rec = await api.uploadMedia(prepared.form)
        landed++
        if (rec.standard?.findings.length) found.push({ name: file.name, findings: rec.standard.findings })
      } catch (e) {
        found.push({ name: file.name, findings: [{ level: 'refuse', code: 'failed', says: (e as Error).message }] })
      } finally {
        setUploading((n) => n - 1)
      }
    }
    setNotes(found)
    await reload()
    // The count is what landed, never what was offered: saying "3 uploaded" over two refusals is
    // the kind of cheerful lie this build refuses everywhere else.
    if (landed) say(`${landed} file${landed === 1 ? '' : 's'} uploaded${found.length ? ` · ${found.length} with something to read` : ''}`)
    else say('Nothing was uploaded — see the notes below', 'err')
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
        Images are resized on your device before they are sent — 1600, 800 and 320 wide — which also strips the camera&apos;s location data. Video is
        stored as it is, with a frame taken from it as its poster. Anything below the standard is named rather than quietly accepted.
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
          <div style={css('font-size:14px;')}>Drop images or video here</div>
          <div style={css('font-size:12px;color:var(--muted);margin:6px 0 14px;')}>
            JPEG, PNG or WebP up to 10 MB · MP4 or WebM up to 64 MB · a hero photograph wants 1600px or more, a hero clip 1280 × 720 and under 45s
          </div>
          <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
          <Button onClick={() => input.current?.click()}>Choose files</Button>
          {uploading > 0 && <div style={css('font-size:12px;color:var(--gold-ink);margin-top:12px;')}>Uploading {uploading}…</div>}
          <div style={css('text-align:left;')}>
            <RejectedList items={notes} onClear={() => setNotes([])} />
          </div>
        </div>
      )}

      {ws.media.length === 0 ? (
        <div style={css('margin-top:20px;')}>
          <Empty title="The library is empty" body="Upload the resort's own photography and video here, then pick it on each property. Until then the site shows the stand-in images the catalogue shipped with." />
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
                {kindOf(m) === 'video' && (
                  <span style={css('position:absolute;top:6px;left:6px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;padding:3px 6px;border-radius:2px;background:rgba(0,16,47,.8);color:#E0B94F;')}>
                    Video {secs(m.duration)}
                  </span>
                )}
                {!!m.standard?.length && (
                  <span
                    title={m.standard.map((f) => f.says).join(' ')}
                    style={css('position:absolute;top:6px;right:6px;width:16px;height:16px;border-radius:50%;background:rgba(0,16,47,.8);color:#E0B94F;font-size:11px;line-height:16px;')}
                  >
                    !
                  </span>
                )}
                <span style={css('position:absolute;left:0;right:0;bottom:0;padding:14px 8px 6px;font-size:10px;color:#F3EFE6;background:linear-gradient(180deg,transparent,rgba(0,16,47,.9));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;')}>
                  {m.name}
                </span>
              </button>
            ))}
          </div>

          {current && (
            <Panel id="media-detail" style={css('position:sticky;top:24px;')}>
              {kindOf(current) === 'video' && (
                <video
                  data-testid="media-preview"
                  src={current.urls.video}
                  poster={current.urls.card}
                  controls
                  muted
                  playsInline
                  style={css('width:100%;border:1px solid var(--line-12);border-radius:3px;margin-bottom:14px;background:#000;')}
                />
              )}
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
              {!!current.standard?.length && (
                <div style={css('margin-top:14px;')}>
                  <StandardReport findings={current.standard} />
                </div>
              )}
              <div style={css('margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6;')}>
                {/* Measured from the stored bytes, not from what the uploading device asserted —
                    which is why it says "stored" rather than describing the original file. */}
                Stored {current.w} × {current.h} · {(current.bytes / 1024).toFixed(0)} KB
                {kindOf(current) === 'video' ? ` · ${secs(current.duration) || 'length unread'}` : ''} · uploaded by {current.by}
                <br />
                Reference: <code style={css('color:var(--gold-ink);')}>media:{current.id}</code>
              </div>
              {can('media') && (
                <div style={css('margin-top:14px;')}>
                  <Button
                    tone="danger"
                    onClick={async () => {
                      if (!confirm(`Remove ${current.name}? Anything still pointing at it will show nothing.`)) return
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

/**
 * The picker the editor opens when a field asks for an image.
 *
 * `only` is how a field says which kind it can use: a destination's hero clip cannot be a
 * photograph, and offering one would be a choice that saves and then does not play.
 */
export function MediaPicker({
  media,
  onPick,
  onClose,
  only,
  multiple,
}: {
  media: Rec[]
  onPick(refs: string[]): void
  onClose(): void
  only?: 'image' | 'video'
  multiple?: boolean
}) {
  const shown = only ? media.filter((m) => kindOf(m) === only) : media
  const [chosen, setChosen] = useState<string[]>([])
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Choose an image" style={css('position:fixed;inset:0;z-index:150;background:rgba(5,7,14,.75);display:flex;align-items:center;justify-content:center;padding:24px;')}>
      <div onClick={(e) => e.stopPropagation()} style={css('background:var(--bg);border:1px solid var(--line-12);border-radius:4px;max-width:860px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;')}>
        <div style={css('display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;')}>
          <h2 style={css('margin:0;font-size:20px;font-weight:400;')}>
            {only === 'video' ? 'Choose a video' : multiple ? 'Choose photographs' : 'Choose an image'}
          </h2>
          <div style={css('display:flex;gap:8px;align-items:center;')}>
            {multiple && (
              <Button tone="gold" disabled={!chosen.length} onClick={() => onPick(chosen.map((id) => `media:${id}`))}>
                {chosen.length ? `Add ${chosen.length}` : 'Add'}
              </Button>
            )}
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
        {shown.length === 0 ? (
          <Empty
            title={only === 'video' ? 'No video in the library yet' : 'Nothing in the library yet'}
            body={only === 'video' ? 'Upload an MP4 or WebM under Media, then pick it here.' : 'Upload images under Media, then pick them here.'}
          />
        ) : (
          <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;')}>
            {shown.map((m) => {
              const on = chosen.includes(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={multiple ? on : undefined}
                  onClick={() => (multiple ? toggle(m.id) : onPick([`media:${m.id}`]))}
                  title={m.name}
                  style={{
                    ...css('position:relative;aspect-ratio:4/3;border-radius:3px;padding:0;background-size:cover;background-position:center;'),
                    backgroundImage: `url(${m.urls.thumb})`,
                    border: `1px solid ${on ? 'var(--gold-ink)' : 'var(--line-1)'}`,
                  }}
                >
                  {kindOf(m) === 'video' && (
                    <span style={css('position:absolute;top:6px;left:6px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;padding:3px 6px;border-radius:2px;background:rgba(0,16,47,.8);color:#E0B94F;')}>
                      Video {secs(m.duration)}
                    </span>
                  )}
                  {multiple && on && (
                    <span style={css('position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;background:#E0B94F;color:#00102F;font-size:12px;line-height:20px;')}>
                      {chosen.indexOf(m.id) + 1}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
