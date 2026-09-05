'use client'

/** The destinations index and the trust strip beneath it. */
import { css } from '@/components/ui/css'
import { useDestinationRows } from '../derive'
import { useSite } from '../state'

export function Destinations() {
  const { state: s, actions } = useSite()
  const rows = useDestinationRows(s.destinations, s.bundle.properties, s.destHover)
  const hovered = s.destHover || rows[0]?.name || ''

  return (
    <section data-screen-label="Destinations index" style={css('border-bottom:1px solid var(--line-06);')}>
      <div id="dest-grid" style={css('max-width:1400px;margin:0 auto;padding:96px 32px;display:grid;grid-template-columns:1.1fr .9fr;gap:64px;align-items:center;')}>
        <div>
          <div data-reveal="" style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>
            01 · Where is your next adventure?
          </div>
          {/* `minmax(0,1fr)` above and `min-width:0` here: a grid track's default minimum is its
              content, and the row's third column is a nowrap "9 properties →". Together they held
              this list 20px wider than the phone it was drawn on. */}
          <div id="dest-list" style={css('min-width:0;margin-top:28px;border-top:1px solid var(--line-12);')}>
            {rows.map((d) => (
              <button
                key={d.name}
                className="drow"
                type="button"
                onClick={() => actions.openDest(d.name)}
                onMouseEnter={() => actions.setDestHover(d.name)}
                onFocus={() => actions.setDestHover(d.name)}
                style={css('width:100%;min-width:0;text-align:left;background:none;border:0;border-bottom:1px solid var(--line-12);padding:26px 0;color:var(--ink);display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:20px;align-items:baseline;')}
              >
                <span style={css('font-size:12px;letter-spacing:.2em;color:var(--gold-ink);')}>{d.num}</span>
                <span>
                  <span style={css("display:block;font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:clamp(34px,4vw,56px);line-height:1;letter-spacing:-.02em;")}>{d.name}</span>
                  <span style={css('display:block;font-size:14px;color:var(--muted);margin-top:10px;max-width:520px;line-height:1.5;')}>{d.tagline}</span>
                </span>
                <span style={css('font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);white-space:nowrap;')}>{d.count} properties →</span>
              </button>
            ))}
          </div>
        </div>

        <div className="dk" id="dest-preview" data-reveal="" style={css('position:relative;aspect-ratio:4/5;overflow:hidden;border-radius:3px;background:var(--panel);')}>
          {rows.map((d) => (
            <div
              key={d.name}
              aria-hidden="true"
              style={{
                ...css('position:absolute;inset:0;background-size:cover;background-position:center;transition:opacity .7s ease,transform 1.4s cubic-bezier(.2,.8,.2,1);'),
                backgroundImage: `url(${d.img})`,
                opacity: d.on ? 1 : 0,
                transform: `scale(${d.on ? 1 : 1.08})`,
              }}
            />
          ))}
          <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,transparent 50%,rgba(0,16,47,.85));')} />
          <div style={css('position:absolute;left:24px;right:24px;bottom:24px;display:flex;justify-content:space-between;align-items:flex-end;')}>
            <span style={css('font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold-ink);')}>{hovered}</span>
            <button type="button" onClick={() => hovered && actions.openDest(hovered)} className="pill" style={css('height:44px;')}>
              Open<i>→</i>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function TrustStrip() {
  const { state: s } = useSite()
  const licence = s.bundle.settings?.licence || '2423494.01'

  return (
    <section data-screen-label="Trust strip" style={css('border-bottom:1px solid var(--line-06);')}>
      <div id="trust" data-reveal="" style={css('max-width:1400px;margin:0 auto;padding:22px 32px;display:flex;flex-wrap:wrap;justify-content:center;gap:12px 48px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);')}>
        <span>
          <strong style={css('color:var(--ink);')}>4.9</strong> Google rating
        </span>
        <span>
          Trade License <strong style={css('color:var(--ink);')}>{licence}</strong>
        </span>
        {/* The partner count is the agency's own claim about its contracts, not a count of what
            the site happens to publish — it is business copy and is carried across verbatim. */}
        <span>
          Preferred partner · <strong style={css('color:var(--ink);')}>38 properties</strong>
        </span>
        <span>
          First reply <strong style={css('color:var(--ink);')}>&lt; 15 min</strong>
        </span>
        <span>
          Quote <strong style={css('color:var(--ink);')}>&lt; 4 hrs</strong>
        </span>
      </div>
    </section>
  )
}
