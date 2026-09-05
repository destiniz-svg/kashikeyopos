'use client'

/**
 * The Refine panel and the property card, shared by the home page's Properties section and by each
 * destination page. One implementation, because two copies of a filter panel is how a chip count on
 * one screen stops agreeing with the grid on the other.
 *
 * The body opens by animating `grid-template-rows` from `0fr` to `1fr`, which is what lets a panel
 * of unknown height animate at all.
 */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { ImageSlot } from '@/components/ui/ImageSlot'
import { chipColours, type FilterGroup, type PropertyCard } from '../derive'
import { useSite } from '../state'

export function RefinePanel({ groups, summary, hasPf }: { groups: FilterGroup[]; summary: string; hasPf: boolean }) {
  const { state: s, actions } = useSite()

  return (
    <div data-reveal="" style={css('margin-top:24px;border:1px solid var(--line-1);border-radius:3px;background:var(--panel);overflow:hidden;')}>
      <div style={css('display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 6px 0 18px;min-height:56px;')}>
        <button type="button" onClick={actions.togglePf} aria-expanded={s.pfOpen} style={css('flex:1;min-width:0;display:flex;align-items:center;gap:14px;background:none;border:0;color:var(--ink);text-align:left;min-height:56px;padding:0;')}>
          <span style={css('display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;border:1px solid var(--gold-50);color:var(--gold-ink);flex:none;')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16" />
              <path d="M7 12h10" />
              <path d="M10 18h4" />
            </svg>
          </span>
          <span style={css('display:flex;flex-direction:column;gap:2px;min-width:0;')}>
            <span style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>Refine</span>
            <span style={css('font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{summary}</span>
          </span>
        </button>
        <div style={css('display:flex;align-items:center;gap:6px;flex:none;')}>
          {hasPf && (
            <button type="button" onClick={actions.clearPf} style={css('background:none;border:0;padding:8px 10px;color:var(--gold-ink);font-size:11px;letter-spacing:.14em;text-transform:uppercase;min-height:44px;')}>
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={actions.togglePf}
            aria-label="Toggle filters"
            style={{ ...css('width:44px;height:44px;background:none;border:0;color:var(--ink);display:flex;align-items:center;justify-content:center;transition:transform .35s cubic-bezier(.22,1,.36,1);'), transform: `rotate(${s.pfOpen ? '180deg' : '0deg'})` }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
      <div style={{ ...css('display:grid;transition:grid-template-rows .4s cubic-bezier(.22,1,.36,1);'), gridTemplateRows: s.pfOpen ? '1fr' : '0fr' }}>
        <div style={css('overflow:hidden;min-height:0;')}>
          <div style={css('display:flex;flex-direction:column;gap:12px;padding:6px 18px 18px;border-top:1px solid var(--line-08);')}>
            {groups.map((g) => (
              <div key={g.name} style={css('display:grid;grid-template-columns:90px 1fr;gap:12px;align-items:center;padding-top:8px;')}>
                <div style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>{g.name}</div>
                <div style={css('display:flex;gap:6px;flex-wrap:wrap;')}>
                  {g.chips.map((c) => {
                    const on = s.pf[g.facet] === c.value
                    const col = chipColours(on)
                    return (
                      <Hover
                        key={c.value}
                        as="button"
                        type="button"
                        aria-pressed={on}
                        onClick={() => actions.setPf(g.facet, c.value)}
                        style={{ ...css('padding:7px 12px;font-size:12px;border-radius:999px;transition:all .2s;display:flex;gap:6px;align-items:center;white-space:nowrap;min-height:34px;'), background: col.bg, border: `1px solid ${col.bd}`, color: col.fg }}
                        hover="border-color:var(--gold-ink);"
                      >
                        <span style={css('white-space:nowrap;')}>{c.label}</span>
                        <span style={css('font-size:10px;color:var(--muted);')}>{c.count}</span>
                      </Hover>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function PropertyCardTile({ p }: { p: PropertyCard }) {
  const { actions } = useSite()

  return (
    <Hover
      className="zoomhost"
      style="display:grid;grid-template-columns:minmax(0,240px) 1fr;background:var(--panel);border:1px solid var(--line-08);border-radius:3px;overflow:hidden;transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .3s,box-shadow .35s;"
      hover="transform:translateY(-4px);border-color:rgba(224,185,79,.6);box-shadow:0 24px 50px var(--shadow-45);"
    >
      <div className="zoomhost" style={css('position:relative;min-height:260px;')}>
        <button type="button" className="zoomable" onClick={() => actions.openDrawer(p.resort)} aria-label={`View ${p.name}`} style={css('position:absolute;inset:0;width:100%;height:100%;border:0;padding:0;cursor:pointer;background:none;')}>
          <ImageSlot src={p.img} alt={`${p.name}, ${p.dest}`} credit={p.credit} creditHref={p.creditHref} placeholder={p.photoHint} pos={p.pos} sizes="240px" />
        </button>
        {p.noImg && (
          <div className="dk" style={css('position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,var(--panel),#00102F);pointer-events:none;')}>
            <div style={css('text-align:center;padding:16px;')}>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:22px;color:var(--gold-ink);line-height:1.1;")}>{p.name}</div>
              <div style={css('font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:8px;')}>Photography to follow</div>
            </div>
          </div>
        )}
        <span style={css('position:absolute;top:12px;left:12px;background:rgba(0,16,47,.72);backdrop-filter:blur(6px);color:var(--gold-ink);font-size:10px;letter-spacing:.18em;text-transform:uppercase;padding:6px 10px;border-radius:2px;pointer-events:none;')}>{p.tier}</span>
        <button
          type="button"
          onClick={(e) => actions.toggleSave(p.id, e)}
          aria-label={p.saved ? `Remove ${p.name} from your shortlist` : `Save ${p.name} to your shortlist`}
          aria-pressed={p.saved}
          style={{ ...css('position:absolute;top:8px;right:8px;width:44px;height:44px;background:rgba(0,16,47,.55);border:0;border-radius:50%;font-size:18px;cursor:pointer;'), color: p.saved ? '#E0B94F' : '#F3EFE6' }}
        >
          {p.saved ? '♥' : '♡'}
        </button>
      </div>

      <div style={css('padding:22px 22px 20px;display:flex;flex-direction:column;gap:12px;min-width:0;')}>
        <div>
          <div style={css('font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);')}>
            {p.dest} · {p.area}
          </div>
          <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:24px;line-height:1.1;margin-top:6px;letter-spacing:-.01em;color:var(--ink);")}>{p.name}</div>
        </div>
        <div style={css('font-size:13px;color:var(--soft);line-height:1.55;')}>{p.blurb}</div>
        <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;font-size:12px;color:var(--muted);border-top:1px solid var(--line-06);padding-top:12px;')}>
          <div>
            <div style={css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:3px;')}>Transfer</div>
            <div style={css('color:var(--ink);')}>{p.transfer}</div>
          </div>
          <div>
            <div style={css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:3px;')}>Style</div>
            <div style={css('color:var(--ink);')}>{p.pkg}</div>
          </div>
          <div style={css('grid-column:span 2;')}>
            <div style={css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:3px;')}>Accommodation</div>
            <div style={css('color:var(--ink);line-height:1.5;')}>{p.villaList}</div>
            <div style={css('display:flex;gap:6px;flex-wrap:wrap;align-items:center;')}>
              <span style={css('font-size:11px;color:var(--gold-ink);letter-spacing:.06em;')}>{p.roomCount}</span>
              {p.tags.map((t) => (
                <span key={t} style={css('font-size:11px;padding:4px 9px;border:1px solid var(--line-14);border-radius:999px;color:var(--soft);')}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div style={css('display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:auto;')}>
          <div style={css('display:flex;gap:6px;flex-wrap:wrap;')}>
            {p.resort.themes.map((th) => (
              <span key={th} style={css('font-size:11px;letter-spacing:.08em;color:var(--gold-ink);border:1px solid rgba(224,185,79,.35);padding:4px 9px;border-radius:2px;')}>
                {th}
              </span>
            ))}
          </div>
          <Hover
            as="button"
            type="button"
            onClick={() => actions.openDrawer(p.resort)}
            style="background:none;border:0;padding:8px 0;color:var(--ink);font-size:12px;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid var(--gold-ink);cursor:pointer;min-height:44px;transition:color .2s;"
            hover="color:var(--gold-ink);"
          >
            View property →
          </Hover>
        </div>
      </div>
    </Hover>
  )
}

export function EmptyProperties() {
  const { actions } = useSite()
  return (
    <div style={css('margin-top:28px;padding:40px;border:1px dashed var(--line-14);border-radius:3px;text-align:center;color:var(--muted);font-size:14px;')}>
      No property matches every filter —{' '}
      <button type="button" onClick={actions.clearPf} style={css('background:none;border:0;padding:0;color:var(--gold-ink);font-size:14px;border-bottom:1px solid var(--gold-ink);')}>
        clear filters
      </button>{' '}
      or ask a specialist for a hand-picked shortlist.
    </div>
  )
}
