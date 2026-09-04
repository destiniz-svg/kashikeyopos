'use client'

/**
 * Offers — the only rates the site publishes.
 *
 * Every card is a real offer against a live property; the bundle has already dropped any offer
 * whose resort is not published, so a card can never open onto a property that is not there.
 */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { chipColours, useOffers } from '../derive'
import { useSite } from '../state'

export function Offers() {
  const { state: s, actions } = useSite()
  const offers = useOffers(s.bundle, s.offerDest, s.currency)
  const destChips = ['All', ...s.liveDestinations.map((d) => d.name)]

  return (
    <section id="offers" data-screen-label="Offers" style={css('padding:40px 0 96px;')}>
      <div id="offers-wrap" style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
        <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
          <div>
            <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Offers</div>
            <h2 id="offers-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>
              Rates negotiated for you
            </h2>
          </div>
          <div style={css('font-size:14px;color:var(--muted);max-width:360px;line-height:1.6;')}>
            The only rates we publish, agreed directly with our partner resorts. Every offer is subject to availability — your specialist confirms it with the property before you commit.
          </div>
        </div>

        <div data-reveal="" style={css('display:flex;gap:8px;flex-wrap:wrap;margin-top:32px;')}>
          {destChips.map((label) => {
            const on = s.offerDest === label
            const c = chipColours(on)
            return (
              <Hover
                key={label}
                as="button"
                type="button"
                aria-pressed={on}
                onClick={() => actions.setOfferDest(label)}
                style={{ ...css('padding:10px 16px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;border-radius:2px;transition:all .2s;min-height:44px;'), background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}
                hover="border-color:var(--gold-ink);color:var(--gold-ink);"
              >
                {label}
              </Hover>
            )
          })}
        </div>

        <div id="offers-grid" data-reveal="" style={css('display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:300px;gap:14px;margin-top:28px;')}>
          {offers.map((o) => (
            <Hover
              key={o.id}
              as="button"
              className="dk"
              type="button"
              onClick={() => actions.openDrawer(o.resort, o.offer)}
              style={{
                ...css('text-align:left;background-size:cover;background-position:center;border:1px solid var(--line-08);border-radius:3px;padding:0;color:var(--ink);position:relative;overflow:hidden;transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .3s,box-shadow .35s;'),
                backgroundImage: `linear-gradient(180deg,rgba(0,16,47,.1) 20%,rgba(0,16,47,.94) 100%),url(${o.img})`,
              }}
              hover="transform:translateY(-6px);border-color:var(--gold-ink);box-shadow:0 24px 50px var(--shadow-50);"
            >
              <div style={css('position:absolute;top:16px;left:16px;display:flex;gap:8px;align-items:center;')}>
                <span style={css('background:#E0B94F;color:#00102F;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;padding:6px 10px;border-radius:2px;')}>{o.badge}</span>
                <span style={css('background:rgba(0,16,47,.6);backdrop-filter:blur(6px);font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:6px 10px;border-radius:2px;color:var(--ink);')}>Availability on request</span>
              </div>
              <div style={css('position:absolute;left:18px;right:18px;bottom:18px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;')}>
                <div style={css('min-width:0;')}>
                  <div style={css('font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-ink);')}>
                    {o.dest} · {o.date}
                  </div>
                  <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:22px;line-height:1.1;margin-top:6px;letter-spacing:-.01em;")}>{o.resort.name}</div>
                  <div style={css('font-size:13px;color:var(--soft);margin-top:6px;')}>{o.perk}</div>
                </div>
                <div style={css('text-align:right;flex-shrink:0;')}>
                  <div style={css('font-size:12px;color:var(--muted);text-decoration:line-through;')}>{o.was}</div>
                  <div style={css('font-size:22px;letter-spacing:-.01em;')}>{o.price}</div>
                  <div style={css('font-size:11px;color:var(--muted);')}>{o.resort.name} · availability on request</div>
                </div>
              </div>
            </Hover>
          ))}
        </div>

        <div data-reveal="" style={css('margin-top:22px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted);')}>
          <span>Prices include villa, transfers and the stated perks. Flights quoted separately.</span>
          <a
            href="#selection"
            onClick={(e) => {
              e.preventDefault()
              actions.setTab('dep')
              actions.nav('selection')(e)
            }}
            style={css('color:var(--gold-ink);letter-spacing:.1em;text-transform:uppercase;font-size:12px;')}
          >
            All offers →
          </a>
        </div>
      </div>
    </section>
  )
}
