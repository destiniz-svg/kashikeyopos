'use client'

/**
 * The hero and the intent bar.
 *
 * The video is muted, looping and plays inline; it is layered over a poster so a browser that
 * blocks autoplay still shows the photograph rather than a black rectangle.
 *
 * It carries no `autoplay` attribute, and that is deliberate rather than an omission: playing is
 * `useAmbientPlayback`'s decision, so a visitor who has asked for reduced motion gets the poster
 * and nothing that moves. An attribute would have started the clip before any script could read
 * the preference, and the CSS half of reduced motion cannot reach a `<video>` at all.
 *
 * `preload="none"` on a small viewport is not the saving it reads as, and the comment here used to
 * claim it was: asking a video to play overrides preload, so the clip is fetched whichever value
 * this carries. Measured at 3.1 MB on a phone. What preload still buys is the case where nothing
 * ever asks — reduced motion, or a hero scrolled past before the observer fires.
 */
import { useRef, useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { useAmbientPlayback } from '@/components/ui/motion'
import { homeStats } from '@/lib/content/home'
import { optionColours } from '../derive'
import { useIntentOptions } from '../derive'
import { useSite } from '../state'
import { assetUrl } from '@/lib/content/asset-url'

export function Hero() {
  const { state: s, actions } = useSite()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoOn, setVideoOn] = useState(false)
  const home = s.bundle.homepage
  const settings = s.bundle.settings

  const heroVideoName = home?.heroVideo || 'Maldives'
  const videoUrl = assetUrl(s.destinations.find((d) => d.name === heroVideoName)?.video)
  const poster = assetUrl(home?.heroPoster)
  const whatsapp = settings?.whatsapp || '971554855656'
  const waLink = `https://wa.me/${whatsapp}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`
  const heroShift = Math.min(s.scrollY * 0.08, 8)
  const stats = homeStats(s.bundle.properties)

  const { destOptions, pkgOptions, themeOptions, monthOptions, themesLabel } = useIntentOptions(s.bundle.properties, s.liveDestinations, s.f)
  const fieldBg = (k: string) => (s.openField === k ? 'rgba(224,185,79,.08)' : 'transparent')

  useAmbientPlayback(videoRef, videoUrl)

  return (
    <>
      <section className="dk" id="top" data-screen-label="Hero" style={css('position:relative;height:100vh;min-height:720px;overflow:hidden;background:var(--bg-deep);')}>
        <span id="hero" style={css('display:none;')} />
        <div style={{ ...css('position:absolute;inset:-8px;will-change:transform;'), transform: `translateY(${heroShift}px)` }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the poster is a full-bleed
              background that must paint before hydration; the optimiser's placeholder would show
              through the video's fade-in. */}
          <img src={poster} alt="" style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.6;animation:kenburns 28s ease-in-out infinite alternate;')} />
          {videoUrl && (
            <video
              id="hero-video"
              ref={videoRef}
              className={videoOn ? 'on' : undefined}
              muted
              loop
              playsInline
              preload={s.isMobile ? 'none' : 'auto'}
              poster={poster}
              src={videoUrl}
              aria-hidden="true"
              onPlaying={() => setVideoOn(true)}
              onLoadedData={() => setVideoOn(true)}
              style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;')}
            />
          )}
        </div>
        <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,16,47,.65) 0%,rgba(0,16,47,.45) 40%,rgba(0,16,47,.55) 70%,#00102F 100%);')} />

        <div id="hero-copy" style={css('position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:120px 24px 200px;')}>
          <div id="hero-kicker" style={css('font-size:12px;letter-spacing:.42em;text-transform:uppercase;color:var(--gold-ink);animation:rise .9s ease both;')}>
            Dubai-based · Maldives Holiday Specialist
          </div>
          <h1
            id="hero-h1"
            style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:clamp(44px,6vw,88px);line-height:1.02;margin:22px 0 20px;letter-spacing:-.02em;text-wrap:balance;text-shadow:0 4px 30px var(--shadow-45);")}
          >
            <span className="w">
              <span style={css('animation-delay:.15s;')}>The</span>
            </span>{' '}
            <span className="w">
              <span style={css('animation-delay:.25s;')}>Pinnacle</span>
            </span>{' '}
            <span className="w">
              <span style={css('animation-delay:.35s;')}>of</span>
            </span>
            <br />
            <span className="w">
              <em style={css('font-style:italic;color:var(--ink);animation-delay:.5s;')}>Bespoke</em>
            </span>{' '}
            <span className="w">
              <span style={css('animation-delay:.62s;')}>Travel</span>
            </span>
          </h1>
          <div style={css('font-size:16px;color:var(--ink);letter-spacing:.06em;text-shadow:0 2px 14px var(--shadow-50);animation:rise 1s .2s ease both;')}>
            Seamless Journeys, Timeless Memories.
          </div>
          <div id="hero-line" style={css('display:flex;align-items:center;gap:14px;margin-top:28px;font-size:13px;color:var(--ink-85);animation:rise 1s .3s ease both;flex-wrap:wrap;justify-content:center;')}>
            <span style={css('color:var(--gold-ink);letter-spacing:.1em;')}>★★★★★</span>
            <span>
              <strong>4.9</strong> · 312 Google reviews
            </span>
            <span style={css('width:1px;height:14px;background:var(--line-3);')} />
            {/* Counted from what the site actually publishes. The prototype carries a literal 38
                properties; a figure a visitor can disprove by counting the grid is worse than a
                smaller true one, and this one grows on its own as the catalogue is completed. */}
            <span id="hero-stats" style={css('white-space:nowrap;')}>
              <strong>{stats.islands}</strong> islands · <strong>{stats.atolls}</strong> atolls · quotes in <strong>24h</strong>
            </span>
            <span style={css('width:1px;height:14px;background:var(--line-3);')} />
            <Hover as="a" href={waLink} target="_blank" rel="noopener" style="color:var(--ink);border-bottom:1px solid var(--ink-4);transition:color .2s;" hover="color:var(--gold-ink);">
              or talk to a specialist on WhatsApp
            </Hover>
          </div>
          <button type="button" onClick={actions.nav('properties')} className="pill" style={css('margin-top:34px;animation:rise 1s .9s ease both;')}>
            Explore the collection<i>→</i>
          </button>
        </div>

        <button
          id="scroll-cue"
          type="button"
          onClick={actions.nav('properties')}
          aria-label="Scroll to the collection"
          style={css('position:absolute;left:32px;top:50%;transform:translateY(-50%);animation:cuebob 2.6s ease-in-out infinite;background:none;border:0;color:var(--ink-6);font-size:11px;letter-spacing:.3em;text-transform:uppercase;display:flex;flex-direction:column;align-items:center;gap:8px;z-index:21;writing-mode:vertical-rl;')}
        >
          Scroll<span style={css('display:block;width:1px;height:36px;background:linear-gradient(180deg,#E0B94F,transparent);')} />
        </button>

        <div id="intent-wrap" style={css('position:absolute;left:0;right:0;bottom:56px;padding:0 24px;z-index:20;')}>
          <button
            id="intent-mobile"
            type="button"
            onClick={actions.openSheet}
            style={css('display:none;width:100%;max-width:520px;margin:0 auto;align-items:center;justify-content:space-between;gap:14px;background:rgba(16,22,41,.94);backdrop-filter:blur(16px);border:1px solid var(--gold-50);border-radius:3px;padding:16px 18px;color:var(--ink);text-align:left;box-shadow:0 30px 80px var(--shadow-50);animation:rise 1s .45s ease both;')}
          >
            <span>
              <span style={css('display:block;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>Find my journey</span>
              <span style={css('display:block;font-size:15px;font-weight:500;margin-top:4px;')}>
                {[s.f.dest !== 'Anywhere' ? s.f.dest : 'Anywhere', s.f.month !== 'Any month' ? s.f.month : 'any month', s.f.themes.length ? s.f.themes.join(' · ') : 'any experience'].join(' · ')}
              </span>
            </span>
            <span style={css('background:#E0B94F;color:#00102F;font-size:12px;font-weight:600;padding:10px 14px;border-radius:2px;white-space:nowrap;')}>Explore</span>
          </button>

          <div id="intent-bar" style={css('max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1.2fr 1.1fr 1.2fr 1fr 1fr 150px;background:rgba(16,22,41,.92);backdrop-filter:blur(16px);border:1px solid var(--line-1);border-radius:3px;box-shadow:0 30px 80px var(--shadow-50);')}>
            <div style={css('position:relative;border-right:1px solid var(--line-08);')}>
              <Hover
                as="button"
                type="button"
                onClick={() => actions.setOpenField('dest')}
                aria-expanded={s.openField === 'dest'}
                style={{ ...css('width:100%;height:78px;border:0;color:var(--ink);text-align:left;padding:0 20px;display:flex;flex-direction:column;justify-content:center;gap:5px;transition:background .2s;'), background: fieldBg('dest') }}
                hover="background:var(--line-04);"
              >
                <span style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>Destination</span>
                <span style={css('font-size:15px;font-weight:500;')}>{s.f.dest}</span>
              </Hover>
              {s.openField === 'dest' && (
                <div style={css('position:absolute;bottom:calc(100% + 8px);left:0;min-width:250px;background:var(--panel);border:1px solid var(--line-12);border-radius:3px;box-shadow:0 20px 50px var(--shadow-50);padding:6px;animation:rise .25s ease;z-index:5;')}>
                  {destOptions.map((o) => {
                    const c = optionColours(s.f.dest === o.value)
                    return (
                      <Hover
                        key={o.value}
                        as="button"
                        type="button"
                        onClick={() => actions.setFilter({ dest: o.value })}
                        style={{ ...css('width:100%;text-align:left;border:0;padding:10px 12px;font-size:14px;border-radius:2px;display:flex;justify-content:space-between;transition:background .15s;'), background: c.bg, color: c.fg }}
                        hover="background:rgba(224,185,79,.12);"
                      >
                        <span>{o.label}</span>
                        <span style={css('color:var(--muted);font-size:12px;')}>{o.meta}</span>
                      </Hover>
                    )
                  })}
                </div>
              )}
            </div>

            <div style={css('position:relative;border-right:1px solid var(--line-08);')}>
              <Hover
                as="button"
                type="button"
                onClick={() => actions.setOpenField('pkg')}
                aria-expanded={s.openField === 'pkg'}
                style={{ ...css('width:100%;height:78px;border:0;color:var(--ink);text-align:left;padding:0 20px;display:flex;flex-direction:column;justify-content:center;gap:5px;transition:background .2s;'), background: fieldBg('pkg') }}
                hover="background:var(--line-04);"
              >
                <span style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>Package type</span>
                <span style={css('font-size:15px;font-weight:500;')}>{s.f.pkg}</span>
              </Hover>
              {s.openField === 'pkg' && (
                <div style={css('position:absolute;bottom:calc(100% + 8px);left:0;min-width:240px;background:var(--panel);border:1px solid var(--line-12);border-radius:3px;box-shadow:0 20px 50px var(--shadow-50);padding:6px;animation:rise .25s ease;z-index:5;')}>
                  {pkgOptions.map((o) => {
                    const c = optionColours(s.f.pkg === o.value)
                    return (
                      <Hover
                        key={o.value}
                        as="button"
                        type="button"
                        onClick={() => actions.setFilter({ pkg: o.value })}
                        style={{ ...css('width:100%;text-align:left;border:0;padding:10px 12px;font-size:14px;border-radius:2px;display:flex;justify-content:space-between;transition:background .15s;'), background: c.bg, color: c.fg }}
                        hover="background:rgba(224,185,79,.12);"
                      >
                        <span>{o.label}</span>
                        <span style={css('color:var(--muted);font-size:12px;')}>{o.meta}</span>
                      </Hover>
                    )
                  })}
                </div>
              )}
            </div>

            <div style={css('position:relative;border-right:1px solid var(--line-08);')}>
              <Hover
                as="button"
                type="button"
                onClick={() => actions.setOpenField('themes')}
                aria-expanded={s.openField === 'themes'}
                style={{ ...css('width:100%;height:78px;border:0;color:var(--ink);text-align:left;padding:0 20px;display:flex;flex-direction:column;justify-content:center;gap:5px;transition:background .2s;'), background: fieldBg('themes') }}
                hover="background:var(--line-04);"
              >
                <span style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>Experience themes</span>
                <span style={css('font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;')}>{themesLabel}</span>
              </Hover>
              {s.openField === 'themes' && (
                <div style={css('position:absolute;bottom:calc(100% + 8px);left:0;width:300px;background:var(--panel);border:1px solid var(--line-12);border-radius:3px;box-shadow:0 20px 50px var(--shadow-50);padding:14px;animation:rise .25s ease;z-index:5;')}>
                  <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>
                    {themeOptions.map((o) => {
                      const on = s.f.themes.includes(o.value)
                      const c = optionColours(on)
                      return (
                        <button
                          key={o.value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => actions.setFilter({ themes: on ? s.f.themes.filter((x) => x !== o.value) : [...s.f.themes, o.value] }, { keepOpen: true })}
                          style={{ ...css('padding:8px 14px;font-size:13px;border-radius:999px;transition:all .2s;'), background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}
                        >
                          {o.label}
                        </button>
                      )
                    })}
                  </div>
                  <div style={css('display:flex;justify-content:flex-end;margin-top:12px;')}>
                    <button type="button" onClick={() => actions.setOpenField(null)} style={css('background:#E0B94F;color:#00102F;border:0;padding:8px 14px;font-size:12px;font-weight:600;border-radius:2px;')}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div style={css('border-right:1px solid var(--line-08);height:78px;padding:0 20px;display:flex;flex-direction:column;justify-content:center;gap:6px;')}>
              <label htmlFor="nights" style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>
                Duration · up to <strong style={css('color:var(--ink);')}>{s.f.nights} nights</strong>
              </label>
              <input
                id="nights"
                type="range"
                min={3}
                max={14}
                step={1}
                value={s.f.nights}
                onChange={(e) => actions.setFilter({ nights: +e.target.value }, { keepOpen: true })}
                style={css('width:100%;margin:0;cursor:pointer;')}
              />
            </div>

            <div style={css('position:relative;')}>
              <Hover
                as="button"
                type="button"
                onClick={() => actions.setOpenField('month')}
                aria-expanded={s.openField === 'month'}
                style={{ ...css('width:100%;height:78px;border:0;color:var(--ink);text-align:left;padding:0 20px;display:flex;flex-direction:column;justify-content:center;gap:5px;transition:background .2s;'), background: fieldBg('month') }}
                hover="background:var(--line-04);"
              >
                <span style={css('font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;')}>Departure</span>
                <span style={css('font-size:15px;font-weight:500;')}>{s.f.month}</span>
              </Hover>
              {s.openField === 'month' && (
                <div style={css('position:absolute;bottom:calc(100% + 8px);right:0;width:300px;background:var(--panel);border:1px solid var(--line-12);border-radius:3px;box-shadow:0 20px 50px var(--shadow-50);padding:10px;animation:rise .25s ease;z-index:5;')}>
                  <div style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:6px;')}>
                    {monthOptions.map((o) => {
                      const c = optionColours(s.f.month === o.value)
                      return (
                        <button
                          key={o.value}
                          type="button"
                          onClick={() => actions.setFilter({ month: o.value })}
                          style={{ ...css('padding:9px 0;font-size:13px;border-radius:2px;transition:all .15s;'), background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}
                        >
                          {o.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <Hover
              as="button"
              id="explore-btn"
              type="button"
              onClick={() => actions.apply({})}
              style="height:78px;background:#E0B94F;color:#00102F;border:0;font-size:14px;font-weight:600;letter-spacing:.04em;border-radius:0 3px 3px 0;transition:background .2s;"
              hover="background:#EBCB72;"
            >
              Explore Journeys
            </Hover>
          </div>
        </div>
      </section>

      <IntentSheet />
    </>
  )
}

/** The bottom sheet the mobile "Find my journey" button opens — the same controls, thumb-sized. */
function IntentSheet() {
  const { state: s, actions } = useSite()
  const { destOptions, pkgOptions, themeOptions, monthOptions } = useIntentOptions(s.bundle.properties, s.liveDestinations, s.f)
  const settings = s.bundle.settings
  const waLink = `https://wa.me/${settings?.whatsapp || '971554855656'}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`

  const count = s.bundle.properties.filter((r) => {
    if (s.f.dest !== 'Anywhere' && r.dest !== s.f.dest) return false
    if (s.f.pkg !== 'Any type' && r.pkg !== s.f.pkg) return false
    if (s.f.themes.length && !s.f.themes.every((t) => r.themes.includes(t))) return false
    return r.nights <= s.f.nights
  }).length

  const chip = (label: string, on: boolean, onClick: () => void, key: string) => {
    const c = optionColours(on)
    return (
      <button key={key} type="button" aria-pressed={on} onClick={onClick} style={{ ...css('padding:10px 14px;font-size:13px;border-radius:999px;min-height:44px;transition:all .2s;'), background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>
        {label}
      </button>
    )
  }

  return (
    <>
      <div
        onClick={actions.closeSheet}
        style={{ ...css('position:fixed;inset:0;z-index:94;background:rgba(5,7,14,.7);backdrop-filter:blur(4px);transition:opacity .35s ease;'), opacity: s.sheetOpen ? 1 : 0, pointerEvents: s.sheetOpen ? 'auto' : 'none' }}
      />
      <div
        id="intent-sheet"
        style={{
          ...css('position:fixed;left:0;right:0;bottom:0;z-index:95;background:var(--bg);border-top:1px solid var(--line-12);border-radius:14px 14px 0 0;max-height:88vh;overflow-y:auto;transition:transform .5s cubic-bezier(.22,1,.36,1);box-shadow:0 -30px 80px var(--shadow-60);'),
          transform: `translateY(${s.sheetOpen ? '0%' : '105%'})`,
        }}
      >
        {s.sheetOpen && (
          <>
            <div style={css('position:sticky;top:0;background:var(--bg-95);backdrop-filter:blur(12px);padding:14px 20px;border-bottom:1px solid var(--line-08);display:flex;justify-content:space-between;align-items:center;z-index:2;')}>
              <div>
                <div style={css('width:40px;height:3px;border-radius:2px;background:var(--line-2);margin:0 0 10px;')} />
                <span style={css('font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--gold-ink);')}>Find my journey</span>
              </div>
              <button type="button" onClick={actions.closeSheet} aria-label="Close" style={css('background:none;border:1px solid var(--line-2);color:var(--ink);width:36px;height:36px;border-radius:50%;font-size:16px;')}>
                ✕
              </button>
            </div>
            <div style={css('padding:20px 20px 24px;display:flex;flex-direction:column;gap:22px;')}>
              <div>
                <div style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Where?</div>
                <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>{destOptions.map((o) => chip(o.label, s.f.dest === o.value, () => actions.setFilter({ dest: o.value }, { keepOpen: true }), o.value))}</div>
              </div>
              <div>
                <div style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Package type</div>
                <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>{pkgOptions.map((o) => chip(o.label, s.f.pkg === o.value, () => actions.setFilter({ pkg: o.value }, { keepOpen: true }), o.value))}</div>
              </div>
              <div>
                <div style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Experience themes</div>
                <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>
                  {themeOptions.map((o) =>
                    chip(
                      o.label,
                      s.f.themes.includes(o.value),
                      () => actions.setFilter({ themes: s.f.themes.includes(o.value) ? s.f.themes.filter((x) => x !== o.value) : [...s.f.themes, o.value] }, { keepOpen: true }),
                      o.value,
                    ),
                  )}
                </div>
              </div>
              <div>
                <label htmlFor="nights-sheet" style={css('display:block;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>
                  Duration · up to <strong style={css('color:var(--ink);')}>{s.f.nights} nights</strong>
                </label>
                <input id="nights-sheet" type="range" min={3} max={14} step={1} value={s.f.nights} onChange={(e) => actions.setFilter({ nights: +e.target.value }, { keepOpen: true })} style={css('width:100%;margin:0;height:44px;')} />
              </div>
              <div>
                <div style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Departure</div>
                <div style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:8px;')}>
                  {monthOptions.map((o) => {
                    const c = optionColours(s.f.month === o.value)
                    return (
                      <button key={o.value} type="button" onClick={() => actions.setFilter({ month: o.value }, { keepOpen: true })} style={{ ...css('padding:0;min-height:44px;font-size:13px;border-radius:2px;transition:all .15s;'), background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <button type="button" onClick={() => actions.apply({})} style={css('background:#E0B94F;color:#00102F;border:0;min-height:52px;font-size:14px;font-weight:600;letter-spacing:.04em;border-radius:2px;')}>
                {count ? `Show ${count} journeys` : 'No exact match — widen the search'}
              </button>
              <a href={waLink} target="_blank" rel="noopener" style={css('text-align:center;font-size:13px;color:var(--ink);')}>
                or talk to a specialist on WhatsApp
              </a>
            </div>
          </>
        )}
      </div>
    </>
  )
}
