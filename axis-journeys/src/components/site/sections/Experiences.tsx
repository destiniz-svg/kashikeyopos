'use client'

/** The eight experience themes. One tap applies the theme and rearranges the Selection above. */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { useThemeTiles } from '../derive'
import { useSite } from '../state'

export function Experiences() {
  const { state: s, actions } = useSite()
  const tiles = useThemeTiles(s.bundle.properties, s.bundle.homepage?.themeImages || [], s.applied.themes)

  return (
    <section id="experiences" data-screen-label="Experiences" style={css('padding:96px 0;')}>
      <div id="exp-wrap" style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
        <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
          <div>
            <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Experiences</div>
            <h2 id="exp-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>
              Travel by the way you want to feel
            </h2>
          </div>
          <div style={css('font-size:14px;color:var(--muted);max-width:360px;line-height:1.6;')}>
            Each theme is a pre-filtered shortlist. One tap, and the selection above rearranges itself.
          </div>
        </div>
        <div id="exp-grid" data-reveal="" style={css('display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-top:40px;')}>
          {tiles.map((t) => (
            <Hover
              key={t.label}
              as="button"
              className="dk"
              type="button"
              onClick={() => actions.apply({ themes: [t.label] })}
              aria-pressed={t.active}
              style={{
                ...css('text-align:left;background-size:cover;background-position:center;border-radius:3px;padding:0;height:240px;color:var(--ink);position:relative;overflow:hidden;transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .3s,box-shadow .35s;'),
                backgroundImage: `linear-gradient(180deg,rgba(0,16,47,.05) 30%,rgba(0,16,47,.92) 100%),url(${t.img})`,
                border: `1px solid ${t.active ? 'var(--gold-ink)' : 'var(--line-08)'}`,
              }}
              hover="transform:translateY(-6px);border-color:var(--gold-ink);box-shadow:0 24px 50px var(--shadow-50);"
            >
              <div style={css('position:absolute;left:18px;bottom:18px;right:18px;')}>
                <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:20px;line-height:1.05;")}>{t.label}</div>
                <div style={css('font-size:12px;color:var(--gold-ink);margin-top:6px;letter-spacing:.06em;')}>{t.count} journeys →</div>
              </div>
            </Hover>
          ))}
        </div>
      </div>
    </section>
  )
}
