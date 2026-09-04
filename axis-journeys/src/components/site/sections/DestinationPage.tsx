'use client'

/**
 * A destination's own page — its video hero, facts, intro, gallery, themes, offers, the shared
 * Refine panel over its properties, the logistics and seasons tables, and the other destinations.
 *
 * It is a real route (`/destinations/{slug}`) rather than a hash, so it can be indexed, shared and
 * cached, which is the one structural change ARCHITECTURE.md asks the prototype for.
 */
import { useEffect, useRef, useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { chipColours, useDestinationProperties, useOffers, useThemeTiles } from '../derive'
import { useSite } from '../state'
import { EmptyProperties, PropertyCardTile, RefinePanel } from './RefinePanel'
import { useProperties } from '../derive'
import { assetUrl } from '@/lib/content/asset-url'

export function DestinationPage({ name }: { name: string }) {
  const { state: s, actions } = useSite()
  const dest = s.destinations.find((d) => d.name === name)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoOn, setVideoOn] = useState(false)
  const video = assetUrl(dest?.video)

  const { all, cards } = useDestinationProperties(s.bundle, name, s.destTheme, s.pf, s.saved)
  const { groups, hasPf, summary } = useProperties(s.bundle, name, s.pf, s.saved)
  const offers = useOffers(s.bundle, 'All', s.currency, name)
  const themeTiles = useThemeTiles(all, s.bundle.homepage?.themeImages || [], s.destTheme ? [s.destTheme] : [])
  const otherDests = s.liveDestinations.filter((d) => d.name !== name)

  // The destination's own photographs where somebody has chosen them, and otherwise what this
  // page has always drawn: the hero of its first few properties. Neither is a placeholder — a
  // destination with no gallery of its own genuinely is best introduced by what is in it.
  const gallery = (dest?.gallery || []).filter((g) => g.img).length
    ? (dest?.gallery || []).filter((g) => g.img)
    : all.slice(0, 4).map((r) => ({ img: r.img, cap: r.photoHint || r.name }))
  const settings = s.bundle.settings
  const wa = `https://wa.me/${settings?.whatsapp || '971554855656'}?text=${encodeURIComponent(`Hello Axis Journeys — I'd like to plan a ${name} journey.`)}`

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = true
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => undefined)
  }, [video])

  if (!dest) return null

  return (
    <main data-screen-label="Destination page" style={css('animation:fadein .5s ease;')}>
      <section className="dk" style={css('position:relative;height:78vh;min-height:560px;overflow:hidden;background:var(--bg-deep);')}>
        <div style={{ ...css('position:absolute;inset:-8px;background-size:cover;background-position:center;animation:drift 22s ease-in-out infinite alternate;'), backgroundImage: `url(${assetUrl(dest.hero)})` }} />
        {video && (
          <video
            id="dp-video"
            ref={videoRef}
            className={videoOn ? 'on' : undefined}
            autoPlay
            muted
            loop
            playsInline
            preload={s.isMobile ? 'none' : 'auto'}
            poster={assetUrl(dest.hero)}
            src={video}
            aria-hidden="true"
            onPlaying={() => setVideoOn(true)}
            onLoadedData={() => setVideoOn(true)}
            style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;')}
          />
        )}
        <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,11,34,.55) 0%,rgba(0,11,34,.15) 40%,rgba(0,16,47,.95) 100%);')} />
        <div id="dp-wrap" style={css('position:relative;max-width:1400px;margin:0 auto;padding:0 32px 56px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;')}>
          <Hover
            as="a"
            href="/"
            onClick={actions.goHome}
            style="display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:28px;transition:color .2s;min-height:44px;width:fit-content;"
            hover="color:var(--gold-ink);"
          >
            ← {otherDests.length ? 'All destinations' : 'Home'}
          </Hover>
          <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Destination</div>
          <h1 id="dp-h1" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:76px;line-height:1;margin:14px 0 16px;letter-spacing:-.02em;")}>{dest.name}</h1>
          <div style={css('font-size:18px;color:var(--soft);max-width:560px;line-height:1.5;text-wrap:pretty;')}>{dest.tagline}</div>
        </div>
      </section>

      <section style={css('border-bottom:1px solid var(--line-06);')}>
        <div id="dp-facts" data-reveal="" style={css('max-width:1400px;margin:0 auto;padding:28px 32px;display:grid;grid-template-columns:repeat(4,1fr);gap:20px 32px;')}>
          {(dest.facts || []).map(([k, v]) => (
            <div key={k}>
              <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);')}>{k}</div>
              <div style={css('font-size:14px;color:var(--ink);margin-top:6px;line-height:1.5;')}>{v}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={css('padding:96px 0 0;')}>
        <div id="dp-intro" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:1.2fr 1fr;gap:64px;align-items:start;')}>
          <div data-reveal="">
            <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>About {dest.name}</div>
            <p style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:26px;line-height:1.4;margin:16px 0 0;color:var(--ink);text-wrap:pretty;")}>{dest.intro}</p>
          </div>
          {(dest.highlights || []).length > 0 && (
            <div data-reveal="" style={css('background:var(--panel);border:1px solid var(--line-08);border-radius:3px;padding:28px;')}>
              <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;')}>Why we send guests here</div>
              <div style={css('display:flex;flex-direction:column;gap:12px;')}>
                {dest.highlights.map((hl) => (
                  <div key={hl} style={css('display:flex;gap:12px;align-items:flex-start;font-size:14px;line-height:1.5;color:var(--ink);')}>
                    <span style={css('color:var(--gold-ink);margin-top:2px;')}>◆</span>
                    <span>{hl}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {gallery.length > 0 && (
        <section style={css('padding:96px 0 0;')}>
          <div id="dp-gallery" data-reveal="" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:2fr 1fr 1fr;grid-auto-rows:260px;grid-auto-flow:dense;gap:14px;')}>
            {gallery.map((g, i) => (
              <Hover
                key={`${g.img}-${i}`}
                className="dk"
                style={{ ...css('position:relative;background-size:cover;border-radius:3px;overflow:hidden;border:1px solid var(--line-06);'), backgroundImage: `url(${g.img})`, backgroundPosition: (g as { pos?: string }).pos || 'center' }}
                hover="border-color:var(--gold-50);"
              >
                <div style={css('position:absolute;left:0;right:0;bottom:0;padding:12px 14px;background:linear-gradient(180deg,transparent,rgba(0,16,47,.85));font-size:11px;letter-spacing:.08em;color:var(--soft);')}>{g.cap}</div>
              </Hover>
            ))}
          </div>
        </section>
      )}

      {themeTiles.length > 0 && (
        <section style={css('padding:96px 0 0;')}>
          <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
            <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
              <div>
                <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Experiences</div>
                <h2 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>Ways to travel {dest.name}</h2>
              </div>
              <div style={css('font-size:14px;color:var(--muted);max-width:360px;line-height:1.6;')}>Tap a theme to narrow the properties below to the ones that do it best.</div>
            </div>
            <div id="dp-exp" data-reveal="" style={css('display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-top:40px;')}>
              {themeTiles.map((t) => (
                <Hover
                  key={t.label}
                  as="button"
                  className="dk"
                  type="button"
                  aria-pressed={s.destTheme === t.label}
                  onClick={() => {
                    actions.setDestTheme(s.destTheme === t.label ? null : t.label)
                    setTimeout(() => document.getElementById('dp-props')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 20)
                  }}
                  style={{
                    ...css('text-align:left;background-size:cover;background-position:center;border-radius:3px;padding:0;height:200px;color:var(--ink);position:relative;overflow:hidden;transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .3s,box-shadow .35s;'),
                    backgroundImage: `linear-gradient(180deg,rgba(0,16,47,.05) 30%,rgba(0,16,47,.92) 100%),url(${t.img})`,
                    border: `1px solid ${s.destTheme === t.label ? 'var(--gold-ink)' : 'var(--line-08)'}`,
                  }}
                  hover="transform:translateY(-6px);border-color:var(--gold-ink);box-shadow:0 24px 50px var(--shadow-50);"
                >
                  <div style={css('position:absolute;left:16px;bottom:16px;right:16px;')}>
                    <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:19px;line-height:1.05;")}>{t.label}</div>
                    <div style={css('font-size:12px;color:var(--gold-ink);margin-top:6px;letter-spacing:.06em;')}>{t.count} properties →</div>
                  </div>
                </Hover>
              ))}
            </div>
          </div>
        </section>
      )}

      {offers.length > 0 && (
        <section style={css('padding:96px 0 0;')}>
          <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
            <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
              <div>
                <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Offers</div>
                <h2 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>
                  {offers.length} offers in {dest.name}
                </h2>
              </div>
              <div style={css('font-size:14px;color:var(--muted);max-width:360px;line-height:1.6;')}>
                The only rates we publish. Villa, transfers and the stated perks included; flights quoted separately.
              </div>
            </div>
            <div id="dp-offers" data-reveal="" style={css('display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:300px;gap:14px;margin-top:40px;')}>
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
                      <div style={css('font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-ink);')}>{o.date}</div>
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
          </div>
        </section>
      )}

      <section id="dp-props" style={css('padding:96px 0;')}>
        <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
          <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
            <div>
              <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Properties</div>
              <h2 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>
                {all.length} properties in {dest.name}
              </h2>
            </div>
            <div style={css('font-size:14px;color:var(--muted);max-width:360px;line-height:1.6;display:flex;flex-direction:column;gap:8px;align-items:flex-start;')}>
              <span>Rates on request — your specialist quotes each stay against live availability.</span>
              {s.destTheme && (
                <button type="button" onClick={() => actions.setDestTheme(null)} style={css('background:none;border:0;padding:0;color:var(--gold-ink);font-size:12px;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--gold-ink);cursor:pointer;min-height:32px;')}>
                  Showing {cards.length} for {s.destTheme} · Show all
                </button>
              )}
            </div>
          </div>

          <RefinePanel groups={groups} summary={summary} hasPf={hasPf} />

          {cards.length === 0 && <EmptyProperties />}

          <div id="dp-grid" data-reveal="" style={css('display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:28px;')}>
            {cards.map((p) => (
              <PropertyCardTile key={p.id} p={p} />
            ))}
          </div>
        </div>
      </section>

      <section style={css('background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);padding:96px 32px;text-align:center;')}>
        <div data-reveal="">
          <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Begin</div>
          <h2 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:52px;line-height:1.05;margin:14px auto 28px;max-width:700px;text-wrap:balance;")}>
            Plan your {dest.name} journey with a specialist
          </h2>
          <div style={css('display:flex;gap:12px;justify-content:center;flex-wrap:wrap;')}>
            <Hover
              as="button"
              type="button"
              onClick={() => actions.openDrawer(null)}
              style="background:#E0B94F;color:#00102F;border:0;padding:14px 24px;font-size:13px;font-weight:600;letter-spacing:.06em;border-radius:2px;transition:all .2s;min-height:44px;"
              hover="background:#EBCB72;transform:translateY(-1px);"
            >
              Plan my journey
            </Hover>
            <Hover
              as="a"
              href={wa}
              target="_blank"
              rel="noopener"
              style="display:inline-flex;align-items:center;gap:8px;color:var(--ink);border:1px solid var(--line-2);padding:13px 20px;font-size:13px;border-radius:2px;transition:all .2s;min-height:44px;"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              <span style={css('width:8px;height:8px;border-radius:50%;background:#25D366;')} />
              WhatsApp a specialist
            </Hover>
          </div>
        </div>
      </section>

      {((dest.logistics || []).length > 0 || (dest.seasons || []).length > 0) && (
        <section style={css('background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);')}>
          <div id="dp-plan" style={css('max-width:1400px;margin:0 auto;padding:96px 32px;display:grid;grid-template-columns:1fr 1fr;gap:64px;')}>
            <div>
              <div data-reveal="" style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Getting there</div>
              <h2 data-reveal="" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.1;margin:14px 0 28px;letter-spacing:-.01em;")}>The transfer decides the trip.</h2>
              <div style={css('display:flex;flex-direction:column;')}>
                {(dest.logistics || []).map(([t, m, dd]) => (
                  <div key={t} data-reveal="" style={css('display:grid;grid-template-columns:1fr;gap:4px;padding:18px 0;border-top:1px solid var(--line-1);')}>
                    <div style={css('display:flex;justify-content:space-between;gap:16px;align-items:baseline;')}>
                      <div style={css('font-size:16px;font-weight:500;')}>{t}</div>
                      <div style={css('font-size:12px;color:var(--gold-ink);letter-spacing:.06em;white-space:nowrap;')}>{m}</div>
                    </div>
                    <div style={css('font-size:13px;color:var(--muted);line-height:1.6;')}>{dd}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div data-reveal="" style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>When to go</div>
              <h2 data-reveal="" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.1;margin:14px 0 28px;letter-spacing:-.01em;")}>Weather, price and the season that matters.</h2>
              <div id="dp-seasons" style={css('display:grid;grid-template-columns:1fr 1fr;gap:10px;')}>
                {(dest.seasons || []).map(([t, m, dd]) => (
                  <div key={t} data-reveal="" style={css('background:var(--bg);border:1px solid var(--line-08);padding:18px;border-radius:3px;')}>
                    <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>{t}</div>
                    <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:20px;margin-top:8px;")}>{m}</div>
                    <div style={css('font-size:12px;color:var(--muted);margin-top:6px;line-height:1.5;')}>{dd}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {otherDests.length > 0 && (
        <section style={css('padding:96px 0;')}>
          <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
            <div data-reveal="" style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);margin-bottom:20px;')}>Other destinations</div>
            <div data-reveal="" style={css('display:grid;grid-template-columns:1fr 1fr;gap:14px;')}>
              {otherDests.map((od) => (
                <Hover
                  key={od.id}
                  as="button"
                  className="dk"
                  type="button"
                  onClick={() => actions.openDest(od.name)}
                  style={{
                    ...css('text-align:left;position:relative;height:200px;border:1px solid var(--line-08);border-radius:3px;padding:0;overflow:hidden;color:var(--ink);background-size:cover;background-position:center;transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .3s;'),
                    backgroundImage: `linear-gradient(180deg,rgba(0,16,47,.05),rgba(0,16,47,.9)),url(${od.card})`,
                  }}
                  hover="transform:translateY(-4px);border-color:var(--gold-ink);"
                >
                  <div style={css('position:absolute;left:20px;bottom:18px;')}>
                    <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:24px;line-height:1.05;")}>{od.name}</div>
                    <div style={css('font-size:12px;color:var(--gold-ink);margin-top:6px;letter-spacing:.06em;')}>Explore →</div>
                  </div>
                </Hover>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

export { chipColours }
