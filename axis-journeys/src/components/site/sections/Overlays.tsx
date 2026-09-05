'use client'

/** The toast, the legal modal and the gallery lightbox — the three things that sit above everything. */
import { useEffect, useRef } from 'react'
import { css } from '@/components/ui/css'
import { useDialogFocus } from '@/components/ui/dialog'
import { Hover } from '@/components/ui/Hover'
import { useSite } from '../state'
import { LEGAL_KEYS } from './Footer'
import { chipColours } from '../derive'

export function Toast() {
  const { state: s } = useSite()
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...css('position:fixed;left:50%;bottom:32px;z-index:120;transition:all .4s cubic-bezier(.22,1,.36,1);pointer-events:none;background:var(--card);color:#00102F;padding:12px 18px;border-radius:2px;font-size:13px;font-weight:500;box-shadow:0 20px 50px var(--shadow-50);display:flex;align-items:center;gap:10px;white-space:nowrap;'),
        transform: `translate(-50%,${s.toast.on ? '0' : '20px'})`,
        opacity: s.toast.on ? 1 : 0,
      }}
    >
      <span style={css('width:8px;height:8px;border-radius:50%;background:#E0B94F;')} />
      {s.toast.msg}
    </div>
  )
}

export function LegalModal() {
  const { state: s, actions } = useSite()
  const box = useRef<HTMLDivElement>(null)
  const legal = s.bundle.settings?.legal
  useDialogFocus(!!s.legal && !!legal, box)
  if (!s.legal || !legal) return null
  const doc = legal[s.legal]
  if (!doc) return null

  return (
    <div
      onClick={() => actions.setLegal(null)}
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
      style={css('position:fixed;inset:0;z-index:100;background:rgba(5,7,14,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:24px;animation:fadein .3s ease;')}
    >
      <div id="legal-box" ref={box} tabIndex={-1} onClick={(e) => e.stopPropagation()} style={css('background:var(--bg);border:1px solid var(--line-12);max-width:680px;width:100%;max-height:80vh;overflow-y:auto;padding:36px 40px;animation:rise .4s ease;box-shadow:0 40px 100px var(--shadow-60);')}>
        <div style={css('display:flex;justify-content:space-between;align-items:flex-start;gap:20px;')}>
          <div>
            <div style={css('font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--gold-ink);')}>Legal</div>
            <h3 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:36px;line-height:1.05;margin:10px 0 0;")}>{doc.title}</h3>
          </div>
          <Hover
            as="button"
            type="button"
            onClick={() => actions.setLegal(null)}
            aria-label="Close"
            style="background:none;border:1px solid var(--line-2);color:var(--ink);width:36px;height:36px;border-radius:50%;font-size:16px;flex-shrink:0;"
            hover="border-color:var(--gold-ink);color:var(--gold-ink);"
          >
            ✕
          </Hover>
        </div>
        <div style={css('font-size:12px;color:var(--muted);margin:8px 0 22px;')}>
          Last updated 1 September 2026 · Axis Link LLC-FZ, Trade License {s.bundle.settings?.licence || '2423494.01'}
        </div>
        {doc.sections.map(([h, p], i) => (
          <div key={`${h}-${i}`} style={css('padding:14px 0;border-top:1px solid var(--line-08);')}>
            <div style={css('font-size:14px;font-weight:600;margin-bottom:6px;')}>{h}</div>
            <p style={css('font-size:14px;line-height:1.7;color:var(--ink-8);margin:0;')}>{p}</p>
          </div>
        ))}
        <div style={css('display:flex;gap:10px;flex-wrap:wrap;margin-top:22px;')}>
          {LEGAL_KEYS.map((k) => {
            const on = s.legal === k
            const c = { bg: on ? 'rgba(224,185,79,.18)' : 'transparent', fg: on ? '#E0B94F' : 'var(--ink)', bd: on ? '#E0B94F' : 'var(--line-14)' }
            return (
              <button key={k} type="button" onClick={() => actions.setLegal(k)} style={{ ...css('padding:8px 14px;font-size:12px;border-radius:999px;transition:all .2s;'), background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}>
                {legal[k]?.title || k}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function Lightbox() {
  const { state: s, actions } = useSite()
  const box = useRef<HTMLDivElement>(null)
  // A room or a venue hands in its own photographs; everything else means the property gallery,
  // which is the only set this ever walked before those existed.
  const gallery = s.lightboxSet ?? s.drawer?.resort?.gallery ?? []
  const open = s.lightbox != null && gallery.length > 0
  const shot = open ? gallery[s.lightbox as number] : null

  // The arrow keys drive the lightbox while it is open; the provider's own handler stands down.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') actions.setLightbox(((s.lightbox as number) + 1) % gallery.length)
      if (e.key === 'ArrowLeft') actions.setLightbox(((s.lightbox as number) - 1 + gallery.length) % gallery.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, s.lightbox, gallery.length, actions])

  useDialogFocus(open, box)

  if (!open || !shot) return null

  return (
    <div
      className="dk"
      ref={box}
      tabIndex={-1}
      data-screen-label="Gallery lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={shot.cap || 'Gallery'}
      onClick={() => actions.setLightbox(null)}
      style={css('position:fixed;inset:0;z-index:120;background:rgba(0,8,24,.94);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px;animation:lbin .3s ease-out both;')}
    >
      <div style={{ ...css('width:min(1100px,100%);height:calc(100vh - 160px);background-size:contain;background-position:center;background-repeat:no-repeat;filter:drop-shadow(0 30px 60px var(--shadow-60));'), backgroundImage: `url(${shot.img})` }} />
      <div style={css('display:flex;justify-content:space-between;align-items:center;width:100%;max-width:1100px;margin-top:18px;color:var(--ink);')}>
        <div style={css('font-size:13px;color:var(--soft);')}>{shot.cap}</div>
        <div style={css('font-size:11px;letter-spacing:.2em;color:var(--muted);')}>
          {(s.lightbox as number) + 1} / {gallery.length}
        </div>
      </div>
      <Hover
        as="button"
        type="button"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          actions.setLightbox(((s.lightbox as number) - 1 + gallery.length) % gallery.length)
        }}
        aria-label="Previous"
        style="position:absolute;left:24px;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(0,16,47,.7);border:1px solid var(--line-2);color:var(--ink);font-size:18px;transition:all .2s;"
        hover="border-color:var(--gold-ink);color:var(--gold-ink);"
      >
        ‹
      </Hover>
      <Hover
        as="button"
        type="button"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          actions.setLightbox(((s.lightbox as number) + 1) % gallery.length)
        }}
        aria-label="Next"
        style="position:absolute;right:24px;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(0,16,47,.7);border:1px solid var(--line-2);color:var(--ink);font-size:18px;transition:all .2s;"
        hover="border-color:var(--gold-ink);color:var(--gold-ink);"
      >
        ›
      </Hover>
      <Hover
        as="button"
        type="button"
        onClick={() => actions.setLightbox(null)}
        aria-label="Close"
        style="position:absolute;top:24px;right:24px;width:40px;height:40px;border-radius:50%;background:none;border:1px solid var(--line-25);color:var(--ink);font-size:16px;"
        hover="border-color:var(--gold-ink);color:var(--gold-ink);"
      >
        ✕
      </Hover>
    </div>
  )
}

export { chipColours }
