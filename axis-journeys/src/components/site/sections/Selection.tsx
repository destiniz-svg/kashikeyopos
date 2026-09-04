'use client'

/**
 * Our Selection: the two tabs, the round navigation buttons, the slide counter with its gold
 * progress line, and the card carousel itself.
 *
 * The carousel is a transform on a flex track rather than a scroll container, so the counter, the
 * progress line, the arrows, the keyboard and the swipe all read one number — `slide`. The card
 * width is a function of the viewport, exactly as `cardW()` computes it in the prototype.
 */
import { useEffect, useRef } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { ImageSlot } from '@/components/ui/ImageSlot'
import { useSelection } from '../derive'
import { useSite } from '../state'

/** Card width by viewport, and the gap between cards. Both from the prototype's own functions. */
export function cardWidth(vw: number): number {
  if (vw <= 600) return Math.max(240, vw - 72)
  if (vw <= 820) return 300
  if (vw <= 1180) return 320
  return 340
}
export const cardGap = (vw: number): number => (vw <= 820 ? 16 : 28)

export function Selection() {
  const { state: s, actions, setTotal } = useSite()
  const { cards, total, hasActiveFilters, resultLine } = useSelection(s.bundle, s.applied, s.tab, s.saved)
  const press = useRef<number | null>(null)

  // The carousel's length has to reach the arrow-key handler, which lives in the provider.
  useEffect(() => {
    setTotal(total)
  }, [total, setTotal])

  const slide = Math.min(s.slide, Math.max(0, total - 1))
  const w = cardWidth(s.vw)
  const gap = cardGap(s.vw)

  return (
    <section id="selection" data-screen-label="Our Selection" style={css('padding:96px 0 40px;position:relative;overflow:hidden;')}>
      <div id="sel-head" data-reveal="" style={css('text-align:center;padding:0 24px;')}>
        <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Handpicked by our specialists</div>
        <h2 id="sel-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:52px;letter-spacing:-.02em;line-height:1;margin:14px 0 26px;")}>
          Our Selection
        </h2>
        <div id="sel-tabs" style={css('display:inline-flex;align-items:center;gap:28px;font-size:15px;')}>
          <button
            type="button"
            onClick={() => actions.setTab('insp')}
            aria-pressed={s.tab === 'insp'}
            style={{ ...css('background:none;border:0;padding:6px 2px;font-size:15px;transition:all .25s;'), color: s.tab === 'insp' ? 'var(--ink)' : 'var(--muted)', borderBottom: `1px solid ${s.tab === 'insp' ? '#E0B94F' : 'transparent'}` }}
          >
            Curated Inspirations
          </button>
          <span style={css('width:4px;height:4px;border-radius:50%;background:var(--muted);')} />
          <button
            type="button"
            onClick={() => actions.setTab('dep')}
            aria-pressed={s.tab === 'dep'}
            style={{ ...css('background:none;border:0;padding:6px 2px;font-size:15px;transition:all .25s;'), color: s.tab === 'dep' ? 'var(--ink)' : 'var(--muted)', borderBottom: `1px solid ${s.tab === 'dep' ? '#E0B94F' : 'transparent'}` }}
          >
            Offers &amp; Departures
          </button>
        </div>
        <div style={css('margin-top:18px;font-size:13px;color:var(--muted);min-height:20px;display:flex;justify-content:center;align-items:center;gap:14px;flex-wrap:wrap;')} aria-live="polite">
          <span>{resultLine}</span>
          {hasActiveFilters && (
            <Hover
              as="button"
              type="button"
              onClick={actions.resetFilters}
              style="background:none;border:1px solid var(--line-18);color:var(--ink);font-size:12px;padding:4px 10px;border-radius:999px;transition:all .2s;"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              Clear filters
            </Hover>
          )}
        </div>
      </div>

      <div data-reveal="" style={css('position:relative;margin-top:56px;')}>
        <div id="sel-bg" style={css('position:absolute;left:0;top:0;bottom:0;width:30%;max-width:420px;background:var(--panel);')} />
        <div id="sel-grid" style={css('position:relative;max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:220px 1fr;gap:40px;align-items:stretch;')}>
          <div id="sel-nav" style={css('display:flex;flex-direction:column;justify-content:space-between;padding:60px 0 48px;')}>
            <div id="sel-arrows" style={css('display:flex;flex-direction:column;gap:14px;')}>
              <Hover
                as="button"
                type="button"
                onClick={() => actions.step(1)}
                aria-label="Next"
                style="width:58px;height:58px;border-radius:50%;border:1px solid var(--line-25);background:none;color:var(--ink);font-size:20px;transition:all .25s;"
                hover="border-color:var(--gold-ink);color:var(--gold-ink);transform:scale(1.06);"
              >
                →
              </Hover>
              <Hover
                as="button"
                type="button"
                onClick={() => actions.step(-1)}
                aria-label="Previous"
                style="width:58px;height:58px;border-radius:50%;border:1px solid var(--line-25);background:none;color:var(--ink);font-size:20px;transition:all .25s;"
                hover="border-color:var(--gold-ink);color:var(--gold-ink);transform:scale(1.06);"
              >
                ←
              </Hover>
            </div>
            <div id="sel-counter">
              <div style={css('display:flex;align-items:baseline;gap:10px;')}>
                <span id="slide-no" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:72px;line-height:1;")}>
                  {String(total ? slide + 1 : 0).padStart(2, '0')}
                </span>
                <span style={css('font-size:20px;color:var(--muted);')}>{String(total).padStart(2, '0')}</span>
              </div>
              <div style={css('height:1px;background:var(--line-15);margin-top:16px;position:relative;')}>
                <div style={{ ...css('position:absolute;left:0;top:0;height:1px;background:#E0B94F;transition:width .5s cubic-bezier(.22,1,.36,1);'), width: total ? `${((slide + 1) / total) * 100}%` : '0%' }} />
              </div>
            </div>
          </div>

          <div
            id="sel-track"
            onPointerDown={(e) => (press.current = e.clientX)}
            onPointerUp={(e) => {
              if (press.current == null) return
              const dx = e.clientX - press.current
              press.current = null
              if (Math.abs(dx) > 50) actions.step(dx < 0 ? 1 : -1)
            }}
            style={css('overflow:hidden;padding:60px 0 48px;touch-action:pan-y;')}
          >
            {total > 0 ? (
              <div
                key={s.trackKey}
                style={{ ...css('display:flex;transition:transform .6s cubic-bezier(.22,1,.36,1);will-change:transform;animation:slidein .5s ease;'), gap: `${gap}px`, transform: `translateX(${-slide * (w + gap)}px)` }}
              >
                {cards.map((c) => (
                  <Hover
                    key={c.id}
                    as="article"
                    onClick={() => actions.openDrawer(c.resort, c.dep)}
                    style={{ ...css('background:var(--card);color:#00102F;cursor:pointer;box-shadow:0 30px 60px var(--shadow-45);transition:transform .35s ease,box-shadow .35s ease;user-select:none;'), flex: `0 0 ${w}px` }}
                    hover="transform:translateY(-6px);box-shadow:0 40px 70px var(--shadow-55);"
                  >
                    <div style={css('position:relative;height:210px;overflow:hidden;background:var(--bg);')}>
                      <div className="zoomable" style={css('position:absolute;inset:0;transition:transform .8s cubic-bezier(.22,1,.36,1);')}>
                        <ImageSlot src={c.img} alt={`${c.name}, ${c.dest}`} credit={c.credit} creditHref={c.creditHref} placeholder={c.photoHint} pos={c.pos} sizes="340px" />
                      </div>
                      <div style={css('position:absolute;top:12px;left:12px;background:var(--bg-85);color:var(--gold-ink);font-size:10px;letter-spacing:.2em;text-transform:uppercase;padding:6px 10px;pointer-events:none;')}>{c.tier}</div>
                      <Hover
                        as="button"
                        type="button"
                        onClick={(e: React.MouseEvent) => actions.toggleSave(c.resort.id, e)}
                        aria-label={c.saved ? `Remove ${c.name} from your shortlist` : `Save ${c.name} to your shortlist`}
                        aria-pressed={c.saved}
                        style={{
                          ...css('position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:50%;border:0;background:rgba(0,16,47,.75);font-size:16px;display:flex;align-items:center;justify-content:center;transition:color .2s;'),
                          color: c.saved ? '#E0B94F' : '#F3EFE6',
                          animation: s.pulse === c.resort.id ? 'pulse .5s ease' : 'none',
                        }}
                        hover="color:var(--gold-ink);"
                      >
                        {c.saved ? '♥' : '♡'}
                      </Hover>
                      {c.dateLabel && (
                        <div style={css('position:absolute;bottom:12px;right:12px;background:#E0B94F;color:#00102F;font-size:11px;font-weight:600;letter-spacing:.06em;padding:6px 10px;pointer-events:none;')}>{c.dateLabel}</div>
                      )}
                    </div>
                    <div style={css('padding:22px 26px 24px;')}>
                      <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:28px;line-height:1;color:#00102F;")}>{c.dest}</div>
                      <div style={css('font-size:13px;color:#184068;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>
                        {c.name} · {c.area}
                      </div>
                      <div style={css('display:flex;gap:18px;margin:16px 0 14px;padding-bottom:14px;border-bottom:1px solid rgba(10,14,40,.12);font-size:13px;color:#3A4A66;')}>
                        <span>
                          ◷ <strong style={css('color:#00102F;')}>{c.nights}</strong> nights
                        </span>
                        <span>◌ {c.transferShort}</span>
                      </div>
                      <div style={css('display:flex;justify-content:space-between;align-items:flex-end;')}>
                        <div>
                          <div style={css('font-size:12px;color:#3A4A66;')}>{c.priceLabel}</div>
                          <div style={css('font-size:30px;font-weight:600;color:#184068;letter-spacing:-.01em;line-height:1.1;')}>{c.price}</div>
                        </div>
                        <span style={css('font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#00102F;border-bottom:1px solid #00102F;padding-bottom:2px;')}>View</span>
                      </div>
                    </div>
                  </Hover>
                ))}
              </div>
            ) : (
              <div style={css('padding:60px 40px;border:1px dashed var(--line-2);text-align:center;color:var(--muted);max-width:640px;animation:fadein .4s ease;')}>
                <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:30px;color:var(--ink);")}>
                  No journeys match this exact combination yet.
                </div>
                <p style={css('margin:12px 0 22px;font-size:14px;line-height:1.6;')}>Widen the duration or month — or let a specialist build it for you in under an hour.</p>
                <div style={css('display:flex;gap:12px;justify-content:center;')}>
                  <button type="button" onClick={actions.resetFilters} style={css('background:none;border:1px solid var(--line-25);color:var(--ink);padding:11px 18px;font-size:13px;border-radius:2px;')}>
                    Reset filters
                  </button>
                  <button type="button" onClick={() => actions.openDrawer(null)} style={css('background:#E0B94F;border:0;color:#00102F;padding:11px 18px;font-size:13px;font-weight:600;border-radius:2px;')}>
                    Ask a specialist
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
