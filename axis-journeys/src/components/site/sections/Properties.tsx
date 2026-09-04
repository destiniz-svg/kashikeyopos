'use client'

/** Our Properties: destination chips, the Refine panel, and the two-column card grid. */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { chipColours, useProperties } from '../derive'
import { useSite } from '../state'
import { EmptyProperties, PropertyCardTile, RefinePanel } from './RefinePanel'

export function Properties() {
  const { state: s, actions } = useSite()
  const { groups, cards, hasPf, summary } = useProperties(s.bundle, s.propDest, s.pf, s.saved)
  const destChips = ['All', ...s.liveDestinations.map((d) => d.name)]

  return (
    <section id="properties" data-screen-label="Properties" style={css('padding:40px 0 96px;border-top:1px solid var(--line-06);')}>
      <div id="props-wrap" style={css('max-width:1400px;margin:0 auto;padding:96px 32px 0;')}>
        <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
          <div>
            <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Our Properties</div>
            <h2 id="props-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>
              Every island, villa and retreat we represent
            </h2>
          </div>
          <div style={css('font-size:14px;color:var(--muted);max-width:380px;line-height:1.6;')}>
            Full details on each property. Rates are quoted by your specialist against live availability — only our Offers carry published prices.
          </div>
        </div>

        <div data-reveal="" style={css('display:flex;gap:8px;flex-wrap:wrap;margin-top:32px;')}>
          {destChips.map((label) => {
            const on = s.propDest === label
            const c = chipColours(on)
            return (
              <Hover
                key={label}
                as="button"
                type="button"
                aria-pressed={on}
                onClick={() => actions.setPropDest(label)}
                style={{ ...css('padding:10px 16px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;border-radius:2px;transition:all .2s;min-height:44px;'), background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}
                hover="border-color:var(--gold-ink);color:var(--gold-ink);"
              >
                {label}
              </Hover>
            )
          })}
        </div>

        <RefinePanel groups={groups} summary={summary} hasPf={hasPf} />

        {cards.length === 0 && <EmptyProperties />}

        <div id="props-grid" data-reveal="" style={css('display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:28px;')}>
          {cards.map((p) => (
            <PropertyCardTile key={p.id} p={p} />
          ))}
        </div>
      </div>
    </section>
  )
}
