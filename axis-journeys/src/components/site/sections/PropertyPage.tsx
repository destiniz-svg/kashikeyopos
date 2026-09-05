'use client'

/**
 * A property's own page — the long form, for a guest who has stopped browsing and is considering
 * one island.
 *
 * It is deliberately not the drawer. The drawer answers "tell me about this one while I keep my
 * place in the list" and closes back onto the grid; this answers "I am choosing between two or
 * three islands", so it carries the comparison scales, the villa tabs, the pricing table across
 * the year and the honest "consider elsewhere if". Both exist, both are reachable, and the drawer
 * links here from its own hero.
 *
 * Everything drawn here comes from `propertyPage()`, which is a pure derivation — see the reasons
 * there for why each section has an override as well as a reading of the profile.
 */
import { useEffect, useRef, useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { useAmbientPlayback } from '@/components/ui/motion'
import { propertyPage, PP_SECTIONS, VS_AXIS, VS_OTHER } from '@/lib/content/property-page'
import { scrollBehaviour } from '@/components/ui/motion'
import type { Property } from '@/lib/content/types'
import { useSite } from '../state'

const WRAP = 'max-width:1400px;margin:0 auto;padding:0 32px;'
const KICKER = 'font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);'
const H2 = "font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.1;margin:14px 0 0;letter-spacing:-.01em;text-wrap:balance;"

/** The four at-a-glance icons, drawn rather than loaded: four paths cost less than four requests. */
const GLANCE_ICONS: Record<string, React.ReactNode> = {
  Transit: <path d="M3 17h18M5 17l1.5-4h11L19 17M8 13V9l4-2 4 2v4" />,
  'House reef': <path d="M12 21V11M12 11c-3 0-5-2.5-5-5 2 0 4 1 5 3 1-2 3-3 5-3 0 2.5-2 5-5 5M6 21c0-3 2-5 6-5s6 2 6 5" />,
  'Best for': (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="16.5" cy="9.5" r="2.5" />
      <path d="M3 20c0-3.5 2.5-6 6-6s6 2.5 6 6M15 20c0-2.5 1.5-4.5 4-4.5s3 1.5 3 4.5" />
    </>
  ),
  'Meal plans': <path d="M4 12h16M12 12V4M6 12a6 6 0 0 0 12 0M5 20h14" />,
}

const Glance = ({ label, value }: { label: string; value: string }) => (
  <div style={css('display:flex;gap:16px;align-items:flex-start;')}>
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#E0B94F" strokeWidth="1.2" style={css('flex:none;')} aria-hidden="true">
      {GLANCE_ICONS[label]}
    </svg>
    <div>
      <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);')}>{label}</div>
      <div style={css('font-size:15px;color:var(--ink);margin-top:6px;line-height:1.5;')}>{value}</div>
    </div>
  </div>
)

const Tick = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#E0B94F" strokeWidth="1.6" style={css('flex:none;margin-top:2px;')} aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
)

/** The atoll labels on the stylised map, at the positions the diagram puts them. */
const ATOLL_LABELS: [string, string, string][] = [
  ['Raa', '12%', '14%'],
  ['Baa', '30%', '28%'],
  ['North Ari', '8%', '56%'],
  ['South Ari', '8%', '78%'],
  ['North Malé', '78%', '46%'],
  ['South Malé', '70%', '82%'],
]

export function PropertyPage({ p }: { p: Property }) {
  const { state: s, actions } = useSite()
  const [tab, setTab] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
  const video = useRef<HTMLVideoElement>(null)

  const pp = propertyPage(p, s.bundle, s.currency, s.bundle.settings?.whatsapp || '971554855656')
  const villa = pp.villaAt(tab)
  useAmbientPlayback(video, pp.video)

  // The sticky nav and the conversion bar arrive once the hero is behind you — they are the page's
  // way of saying "you are still on this island", and over the hero they would only cover it.
  const navOn = s.scrollY > (typeof window === 'undefined' ? 900 : window.innerHeight * 0.85)
  const barOn = s.scrollY > (typeof window === 'undefined' ? 700 : window.innerHeight * 0.7)

  // The dock is the home page's thumb bar; here the conversion bar occupies that edge, and two
  // bars stacked on a phone is one of them covering the other.
  useEffect(() => {
    document.body.dataset.ppBar = '1'
    return () => {
      delete document.body.dataset.ppBar
    }
  }, [])

  const quote = () => {
    actions.openDrawer(p)
    setTimeout(() => actions.jump('drawer-form'), 350)
  }
  const goSection = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 72, behavior: scrollBehaviour() })
  }
  const openShot = (index: number) => () => {
    if (index >= 0) actions.setLightbox(index, pp.gallery)
  }

  return (
    <>
      <main data-screen-label="Property page" style={css('animation:fadein .5s ease;')}>
        {/* ---------------------------------------------------------------- hero */}
        <section className="dk" style={css('position:relative;height:100vh;min-height:640px;overflow:hidden;background:var(--bg-deep);')}>
          <div
            style={{
              ...css('position:absolute;inset:-8px;background-size:cover;background-position:center;animation:kenburns 18s ease-out both;'),
              backgroundImage: `url(${p.img})`,
            }}
          />
          {pp.video && (
            <video
              ref={video}
              muted
              loop
              playsInline
              preload="none"
              poster={p.img}
              src={pp.video}
              aria-hidden="true"
              style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;')}
            />
          )}
          <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,11,34,.55) 0%,rgba(0,11,34,.15) 40%,rgba(0,16,47,.95) 100%);')} />
          <div id="pp-hero-wrap" style={css('position:relative;max-width:1400px;margin:0 auto;padding:0 32px 72px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;')}>
            <nav
              aria-label="Breadcrumb"
              style={css('display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:28px;flex-wrap:wrap;')}
            >
              <Hover as="a" href="/#properties" style="color:var(--muted);transition:color .2s;" hover="color:var(--ink);">
                Properties
              </Hover>
              <span aria-hidden="true">/</span>
              <span>{p.dest}</span>
              <span aria-hidden="true">/</span>
              <span style={css('color:var(--ink);')}>{p.name}</span>
            </nav>
            <div style={css(KICKER)}>{p.tier}</div>
            <h1
              id="pp-h1"
              style={css(
                "font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:76px;line-height:1;margin:14px 0 16px;letter-spacing:-.02em;max-width:900px;text-wrap:balance;",
              )}
            >
              {p.name} <span style={css('color:var(--muted);')}>– {p.area}</span>
            </h1>
            <p style={css('font-size:18px;color:var(--soft);max-width:600px;line-height:1.5;text-wrap:pretty;margin:0;')}>{pp.sub}</p>
            <div
              id="pp-price"
              style={css(
                'position:absolute;right:32px;bottom:72px;width:320px;background:var(--bg-95);backdrop-filter:blur(14px);border:1px solid rgba(224,185,79,.35);border-radius:3px;padding:22px 24px;',
              )}
            >
              <div style={css('font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);')}>
                {pp.hasPrice ? 'Packages from' : 'Tailored package'}
              </div>
              <div
                style={css(
                  pp.hasPrice
                    ? "font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:36px;line-height:1;margin-top:8px;color:var(--ink);"
                    : "font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:28px;line-height:1.1;margin-top:8px;color:var(--ink);",
                )}
              >
                {pp.hasPrice ? (
                  <>
                    {pp.price} <span style={css('font-size:13px;color:var(--muted);font-family:inherit;')}>per couple</span>
                  </>
                ) : (
                  'Quote within 24 hours'
                )}
              </div>
              <div style={css('font-size:13px;color:var(--soft);margin-top:10px;')}>Includes {pp.priceIncl}</div>
              <Hover
                as="button"
                type="button"
                onClick={quote}
                style="width:100%;margin-top:18px;height:48px;background:#E0B94F;color:#00102F;border:0;font-size:13px;font-weight:600;letter-spacing:.06em;border-radius:2px;transition:background .2s;cursor:pointer;"
                hover="background:#F0CB64;"
              >
                Request a custom quote
              </Hover>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- at a glance */}
        <section style={css('border-bottom:1px solid var(--line-06);')}>
          <div id="pp-glance" data-reveal="" style={css('max-width:1400px;margin:0 auto;padding:40px 32px;display:grid;grid-template-columns:repeat(4,1fr);gap:24px 40px;')}>
            <Glance label="Transit" value={pp.transit} />
            <Glance label="House reef" value={pp.reef} />
            <Glance label="Best for" value={pp.bestFor} />
            <Glance label="Meal plans" value={pp.meals} />
          </div>
        </section>

        {/* ---------------------------------------------------------------- the seven rungs */}
        <nav
          id="pp-nav"
          aria-label="On this page"
          style={{
            ...css('position:sticky;top:0;z-index:40;background:var(--bg-95);backdrop-filter:blur(14px);border-bottom:1px solid var(--line-06);transition:transform .3s ease;'),
            transform: `translateY(${navOn ? '0' : '-100%'})`,
          }}
        >
          <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:flex;align-items:center;gap:28px;height:52px;overflow-x:auto;')}>
            {PP_SECTIONS.map((sec) => (
              <Hover
                key={sec.id}
                as="a"
                href={`#${sec.id}`}
                onClick={goSection(sec.id)}
                style="display:inline-flex;gap:8px;align-items:baseline;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);white-space:nowrap;transition:color .2s;"
                hover="color:var(--gold-ink);"
              >
                <span style={css('color:var(--gold-ink);font-size:10px;')}>{sec.n}</span>
                {sec.label}
              </Hover>
            ))}
          </div>
        </nav>

        {/* ---------------------------------------------------------------- positioning */}
        <section id="pp-sec" style={css('padding:96px 0;')}>
          <div id="pp-scales" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:1.1fr 1fr;gap:64px;align-items:start;')}>
            <div>
              <div data-reveal="" style={css(KICKER)}>
                Our positioning
              </div>
              <p
                data-reveal=""
                style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:30px;line-height:1.3;color:var(--ink);margin:16px 0 0;text-wrap:pretty;")}
              >
                {pp.posBig}
              </p>
              <p data-reveal="" style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:24px 0 0;max-width:560px;text-wrap:pretty;')}>
                {pp.posSmall}
              </p>
            </div>
            <div data-reveal="" style={css('display:flex;flex-direction:column;gap:22px;padding-top:6px;')}>
              {pp.scales.map((sl) => (
                <div key={sl.lo}>
                  <div style={css('display:flex;justify-content:space-between;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);')}>
                    <span>{sl.lo}</span>
                    <span>{sl.hi}</span>
                  </div>
                  <div
                    role="img"
                    aria-label={`${sl.lo} to ${sl.hi}: ${sl.pos.replace('%', '')} per cent toward ${sl.hi}`}
                    style={css('position:relative;height:2px;background:var(--line-14);margin-top:10px;')}
                  >
                    <span
                      style={{
                        ...css('position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:#E0B94F;transform:translate(-50%,-50%);box-shadow:0 0 0 4px rgba(224,185,79,.2);'),
                        left: sl.pos,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- recognition */}
        {pp.awards.length > 0 && (
          <section style={css('padding:0 0 96px;')}>
            <div style={css(WRAP)}>
              <div
                id="pp-awards"
                data-reveal=""
                style={{
                  ...css('display:grid;gap:1px;background:var(--line-08);border:1px solid var(--line-08);border-radius:3px;overflow:hidden;'),
                  gridTemplateColumns: `200px repeat(${pp.awards.length},1fr)`,
                }}
              >
                <div style={css('background:var(--panel);padding:24px 26px;')}>
                  <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:44px;font-weight:300;line-height:1;color:var(--gold-ink);")}>
                    {pp.awards.length}
                  </div>
                  <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-top:8px;')}>
                    {pp.awards.length === 1 ? 'Recognition' : 'Recognitions'}
                  </div>
                </div>
                {pp.awards.map((aw) => (
                  <div key={aw[0]} style={css('background:var(--bg);padding:24px 26px;')}>
                    <div style={css('font-size:15px;line-height:1.45;color:var(--ink);text-wrap:pretty;')}>{aw[0]}</div>
                    <div style={css('font-size:12px;color:var(--muted);margin-top:8px;')}>{aw[1]}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- 01 villas */}
        <section id="pp-villas" style={css('padding:0 0 96px;')}>
          <div style={css(WRAP)}>
            <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
              <div>
                <div style={css(KICKER)}>01 · Accommodation</div>
                <h2 style={css(H2)}>Choose your villa</h2>
              </div>
              {pp.tabs.length > 1 && (
                <div id="pp-tabs" role="tablist" aria-label="Villa types" style={css('display:flex;gap:2px;border:1px solid var(--line-14);border-radius:2px;padding:2px;')}>
                  {pp.tabs.map((tb, k) => (
                    <button
                      key={tb.name}
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      onClick={() => setTab(k)}
                      style={{
                        // 44px rather than the prototype's 37: this is the page's primary control
                        // on a phone, and it is the one place the design's own padding lands under
                        // the tap target the rest of this site is held to.
                        ...css('border:0;font-size:12px;letter-spacing:.1em;text-transform:uppercase;padding:10px 18px;min-height:44px;border-radius:1px;transition:all .2s;white-space:nowrap;cursor:pointer;'),
                        background: tab === k ? 'var(--gold-ink)' : 'transparent',
                        color: tab === k ? '#00102F' : 'var(--ink)',
                      }}
                    >
                      {tb.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div id="pp-villa" style={css('display:grid;grid-template-columns:1.2fr 1fr;gap:40px;margin-top:40px;align-items:start;animation:fadein .4s ease;')}>
              <div id="pp-gal" style={css('display:grid;grid-template-columns:2fr 1fr;grid-auto-rows:220px;gap:10px;')}>
                {villa.imgs.map((vi, i) => (
                  <button
                    key={vi.img}
                    type="button"
                    className="zoomhost"
                    onClick={openShot(vi.galleryIndex)}
                    aria-label={`Open a photograph of ${villa.name || p.name}`}
                    disabled={vi.galleryIndex < 0}
                    style={{
                      ...css('position:relative;overflow:hidden;border:1px solid var(--line-08);padding:0;border-radius:3px;background:var(--panel);'),
                      gridRow: i === 0 ? 'span 2' : 'auto',
                      cursor: vi.galleryIndex >= 0 ? 'zoom-in' : 'default',
                    }}
                  >
                    <div
                      className="zoomable"
                      style={{
                        ...css('position:absolute;inset:0;background-size:cover;transition:transform .8s ease;'),
                        backgroundImage: `url(${vi.img})`,
                        backgroundPosition: vi.pos,
                      }}
                    />
                  </button>
                ))}
              </div>
              <div>
                <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:32px;line-height:1.1;")}>{villa.name}</div>
                <div style={css('font-size:13px;color:var(--muted);margin-top:8px;letter-spacing:.04em;')}>{villa.meta}</div>
                <p style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:20px 0 0;text-wrap:pretty;')}>{villa.desc}</p>
                <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-top:20px;')}>
                  {villa.feats.map((ft) => (
                    <span key={ft} style={css('font-size:12px;color:var(--ink);border:1px solid var(--line-14);padding:6px 12px;border-radius:999px;')}>
                      {ft}
                    </span>
                  ))}
                </div>
                <div
                  style={css(
                    'margin-top:28px;padding:16px 20px;background:var(--panel);border:1px solid var(--line-08);border-radius:3px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;',
                  )}
                >
                  <div style={css('font-size:14px;color:var(--gold-ink);')}>{villa.upgrade}</div>
                  <Hover
                    as="button"
                    type="button"
                    onClick={quote}
                    style="background:none;border:1px solid var(--line-2);color:var(--ink);font-size:12px;letter-spacing:.1em;text-transform:uppercase;padding:10px 16px;border-radius:2px;transition:all .2s;cursor:pointer;min-height:44px;"
                    hover="border-color:var(--gold-ink);color:var(--gold-ink);"
                  >
                    Quote this villa
                  </Hover>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 02 dining */}
        {pp.dining.length > 0 && (
          <section id="pp-dining" style={css('padding:96px 0;background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);')}>
            <div style={css(WRAP)}>
              <div data-reveal="" style={css(KICKER)}>
                02 · Dining
              </div>
              <h2 data-reveal="" style={css(H2 + 'margin-bottom:36px;')}>
                {pp.diningCount}
              </h2>
              <div id="pp-dine-grid" style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:18px;')}>
                {pp.dining.map((dn) => (
                  <div key={dn.name} data-reveal="" style={css('border:1px solid var(--line-08);border-radius:3px;overflow:hidden;background:var(--bg);')}>
                    <div
                      style={{
                        ...css('aspect-ratio:16/9;background-color:var(--bg-deep);background-size:cover;'),
                        backgroundImage: `url(${dn.img})`,
                        backgroundPosition: dn.pos,
                      }}
                    />
                    <div style={css('padding:18px 20px 20px;')}>
                      <div style={css('display:flex;justify-content:space-between;gap:12px;align-items:baseline;')}>
                        <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:20px;font-weight:300;")}>{dn.name}</div>
                        <div style={css('font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-ink);white-space:nowrap;')}>{dn.cuisine}</div>
                      </div>
                      <div style={css('font-size:13px;color:var(--muted);margin-top:6px;')}>{dn.setting}</div>
                      {dn.desc && <p style={css('font-size:14px;line-height:1.6;color:var(--soft);margin:10px 0 0;')}>{dn.desc}</p>}
                      {dn.when && <div style={css('font-size:12px;color:var(--muted);margin-top:12px;padding-top:12px;border-top:1px solid var(--line-07);')}>{dn.when}</div>}
                    </div>
                  </div>
                ))}
              </div>
              {pp.plans.length > 0 && (
                <div data-reveal="" style={css('margin-top:40px;border-top:1px solid var(--line-1);')}>
                  <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);padding:18px 0 6px;')}>Meal plans</div>
                  {pp.plans.map((pl) => (
                    <div
                      key={pl.name}
                      style={css('display:flex;justify-content:space-between;gap:24px;padding:14px 0;border-bottom:1px solid var(--line-07);font-size:15px;flex-wrap:wrap;')}
                    >
                      <span style={css('color:var(--ink);')}>{pl.name}</span>
                      <span style={css('color:var(--soft);font-size:14px;')}>{pl.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- from the island */}
        {pp.instagram && pp.igTiles.length > 0 && (
          <section style={css('padding:96px 0 0;')}>
            <div style={css(WRAP)}>
              <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:20px;')}>
                <div style={css(KICKER)}>From the island</div>
                <Hover as="a" href={pp.instagram.href} target="_blank" rel="noopener" style="font-size:13px;color:var(--soft);transition:color .2s;" hover="color:var(--gold-ink);">
                  {pp.instagram.handle} on Instagram →
                </Hover>
              </div>
              <div id="pp-ig" style={css('display:grid;grid-template-columns:repeat(6,1fr);gap:8px;')}>
                {pp.igTiles.map((ig) => (
                  <button
                    key={ig.img}
                    type="button"
                    className="zoomhost"
                    onClick={openShot(ig.index)}
                    aria-label={`Open photograph ${ig.index + 1} of ${p.name}`}
                    style={css('position:relative;aspect-ratio:1;overflow:hidden;border:1px solid var(--line-08);padding:0;border-radius:3px;background:var(--panel);cursor:zoom-in;')}
                  >
                    <div
                      className="zoomable"
                      style={{
                        ...css('position:absolute;inset:0;background-size:cover;transition:transform .8s ease;'),
                        backgroundImage: `url(${ig.img})`,
                        backgroundPosition: ig.pos,
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- 03 the package */}
        <section id="pp-incl" style={css('padding:96px 0;')}>
          <div id="pp-pkg" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:start;')}>
            <div data-reveal="">
              <div style={css(KICKER)}>03 · The exclusive package</div>
              <h2 id="pp-h2" style={css(H2 + 'margin-bottom:20px;')}>
                What&apos;s included when you book through Axis
              </h2>
              <p style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:0;max-width:480px;text-wrap:pretty;')}>
                Direct contract rates and a best-rate guarantee, with transfers, taxes and meal plans quoted upfront. If something needs fixing on the
                island, we call the resort — not a call centre.
              </p>
              <p style={css('font-size:13px;line-height:1.7;color:var(--muted);margin:20px 0 0;max-width:480px;')}>
                Flights quoted separately. Honeymoon and anniversary touches added when you tell us the occasion.
              </p>
            </div>
            <div data-reveal="" style={css('background:var(--panel);border:1px solid var(--line-08);border-radius:3px;padding:32px 36px;')}>
              {pp.included.map((it) => (
                <div key={it.text} style={css('display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--line-07);')}>
                  <Tick />
                  <div style={css('font-size:15px;line-height:1.5;color:var(--ink);')}>
                    {it.exclusive && (
                      <span style={css('display:inline-block;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-ink);margin-right:10px;')}>
                        Axis exclusive
                      </span>
                    )}
                    {it.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 04 reef */}
        <section id="pp-reef" style={css('padding:96px 0;background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);')}>
          <div id="pp-reef-grid" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:start;')}>
            <div>
              <div data-reveal="" style={css(KICKER)}>
                04 · House reef &amp; marine life
              </div>
              <h2 data-reveal="" style={css(H2 + 'margin-bottom:24px;')}>
                {pp.reef}
              </h2>
              {p.children && (
                <p data-reveal="" style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:0;max-width:520px;text-wrap:pretty;')}>
                  {p.children}
                </p>
              )}
            </div>
            <div data-reveal="">
              {pp.marine.length > 0 && (
                <>
                  <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;')}>
                    Regularly seen here or nearby
                  </div>
                  <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>
                    {pp.marine.map((mp) => (
                      <span key={mp} style={css('font-size:13px;color:var(--ink);border:1px solid var(--line-14);padding:8px 14px;border-radius:999px;')}>
                        {mp}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {pp.nearby.length > 0 && (
                <div style={css('margin-top:28px;border-top:1px solid var(--line-1);')}>
                  {pp.nearby.map((nb) => (
                    <div key={nb[0]} style={css('padding:16px 0;border-bottom:1px solid var(--line-07);')}>
                      <div style={css('font-size:15px;color:var(--ink);')}>{nb[0]}</div>
                      <div style={css('font-size:14px;color:var(--soft);margin-top:4px;line-height:1.6;text-wrap:pretty;')}>{nb[1]}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 05 getting there */}
        <section id="pp-transfer" style={css('padding:96px 0;')}>
          <div id="pp-transfer-grid" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;')}>
            <div
              id="pp-map"
              data-reveal=""
              className="dk"
              role="img"
              aria-label={`${p.name} on a stylised map of the Maldives — ${pp.map.km}`}
              style={css(
                'position:relative;aspect-ratio:1/1.15;background:#00102F;border:1px solid var(--line-1);border-radius:3px;overflow:hidden;background-image:radial-gradient(circle at 30% 20%,rgba(24,64,104,.55),transparent 55%),radial-gradient(circle at 70% 80%,rgba(24,64,104,.4),transparent 50%);',
              )}
            >
              <svg viewBox="0 0 100 115" preserveAspectRatio="none" style={css('position:absolute;inset:0;width:100%;height:100%;')} aria-hidden="true">
                <line
                  x1={pp.map.maleX}
                  y1={pp.map.maleY}
                  x2={pp.map.x}
                  y2={pp.map.y}
                  stroke="#E0B94F"
                  strokeWidth=".4"
                  strokeDasharray="1.2 1.2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {ATOLL_LABELS.map(([label, left, top]) => (
                <div
                  key={label}
                  style={{
                    ...css('position:absolute;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:rgba(255,255,255,.28);'),
                    left,
                    top,
                  }}
                >
                  {label}
                </div>
              ))}
              <div
                style={{
                  ...css('position:absolute;transform:translate(-50%,-4px);display:flex;flex-direction:column;align-items:center;gap:6px;'),
                  left: pp.map.maleX,
                  top: pp.map.maleY,
                }}
              >
                <span style={css('width:8px;height:8px;border-radius:50%;border:1px solid rgba(255,255,255,.7);')} />
                <span style={css('font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.6);white-space:nowrap;')}>
                  Malé · Velana
                </span>
              </div>
              <div
                style={{
                  ...css('position:absolute;transform:translate(-7px,-50%);display:flex;align-items:center;gap:10px;'),
                  left: pp.map.x,
                  top: pp.map.y,
                }}
              >
                <span style={css('width:14px;height:14px;border-radius:50%;background:#E0B94F;box-shadow:0 0 0 6px rgba(224,185,79,.25);flex:none;')} />
                <span style={css('font-size:12px;color:#fff;white-space:nowrap;font-weight:500;background:rgba(0,16,47,.7);padding:4px 8px;border-radius:2px;')}>
                  {p.name}
                </span>
              </div>
              <div style={css('position:absolute;left:20px;bottom:18px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.6);')}>
                {pp.map.km}
              </div>
            </div>
            <div>
              <div data-reveal="" style={css(KICKER)}>
                05 · Getting there
              </div>
              <h2 data-reveal="" style={css(H2 + 'margin-bottom:28px;')}>
                {p.area}
              </h2>
              <div style={css('display:flex;flex-direction:column;gap:12px;')}>
                {pp.transfers.map((tr) => (
                  <div key={tr.mode} data-reveal="" style={css('border:1px solid var(--line-08);border-radius:3px;padding:18px 22px;background:var(--panel);')}>
                    <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>{tr.label}</div>
                    <div style={css('display:flex;justify-content:space-between;gap:16px;margin-top:8px;flex-wrap:wrap;')}>
                      <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:22px;font-weight:300;")}>{tr.mode}</div>
                      <div style={css('font-size:13px;color:var(--soft);')}>{tr.cost}</div>
                    </div>
                    <div style={css('font-size:14px;color:var(--soft);margin-top:6px;')}>{tr.detail}</div>
                  </div>
                ))}
              </div>
              <p data-reveal="" style={css('font-size:13px;line-height:1.7;color:var(--muted);margin:20px 0 0;')}>
                Seaplanes fly in daylight only; we arrange domestic-flight or airport-hotel alternatives for late arrivals.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 06 our take */}
        <section id="pp-verdict" style={css('padding:96px 0;background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);')}>
          <div style={css(WRAP)}>
            <div data-reveal="" style={css(KICKER)}>
              06 · Our take
            </div>
            <h2 data-reveal="" style={css(H2 + 'margin-bottom:40px;')}>
              Who this island is for
            </h2>
            <div id="pp-verdict-grid" style={css('display:grid;grid-template-columns:1fr 1fr;gap:64px;')}>
              <div data-reveal="">
                <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);padding-bottom:14px;border-bottom:1px solid var(--line-1);')}>
                  Ideal for
                </div>
                {pp.ideal.map((li) => (
                  <div key={li} style={css('display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--line-07);font-size:15px;line-height:1.5;color:var(--ink);')}>
                    <span style={css('color:var(--gold-ink);flex:none;')} aria-hidden="true">
                      —
                    </span>
                    {li}
                  </div>
                ))}
              </div>
              <div data-reveal="">
                <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);padding-bottom:14px;border-bottom:1px solid var(--line-1);')}>
                  Consider elsewhere if
                </div>
                {pp.notFor.map((li) => (
                  <div key={li} style={css('display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--line-07);font-size:15px;line-height:1.5;color:var(--soft);')}>
                    <span style={css('color:var(--muted);flex:none;')} aria-hidden="true">
                      —
                    </span>
                    {li}
                  </div>
                ))}
              </div>
            </div>
            <div
              id="pp-glance-2"
              data-reveal=""
              style={css(
                'margin-top:56px;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line-08);border:1px solid var(--line-08);border-radius:3px;overflow:hidden;',
              )}
            >
              {pp.seasons.map((se) => (
                <div key={se.when} style={css('background:var(--bg);padding:18px 20px;')}>
                  <div style={css('font-size:14px;color:var(--ink);')}>{se.when}</div>
                  <div style={css('font-size:12px;color:var(--muted);margin-top:6px;')}>{se.note}</div>
                </div>
              ))}
            </div>
            <div style={css('font-size:12px;color:var(--muted);margin-top:12px;')}>
              Season guide — peak dates fill four months ahead; shoulder months balance weather, price and availability.
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- pricing */}
        <section id="pp-pricing" style={css('padding:96px 0 0;')}>
          <div style={css(WRAP)}>
            <div style={css(KICKER)}>Pricing by travel date</div>
            <h2 data-reveal="" style={css(H2 + 'margin-bottom:12px;')}>
              What the same week costs across the year
            </h2>
            <p data-reveal="" style={css('font-size:14px;color:var(--muted);margin:0 0 32px;max-width:640px;line-height:1.6;')}>
              {p.nights} nights per couple · villa, board and Axis exclusives · transfers and green tax quoted with your dates
            </p>
            <div data-reveal="" style={css('overflow-x:auto;border:1px solid var(--line-08);border-radius:3px;')}>
              <div id="pp-price-grid" style={css('display:grid;grid-template-columns:1.4fr 1fr 1fr;min-width:640px;')}>
                <div style={css('padding:16px 24px;border-bottom:1px solid var(--line-08);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);')}>
                  Travel window
                </div>
                <div
                  style={css(
                    'padding:16px 24px;border-bottom:1px solid var(--line-08);border-left:1px solid var(--line-07);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);',
                  )}
                >
                  {pp.entryVilla}
                </div>
                <div
                  style={css(
                    'padding:16px 24px;border-bottom:1px solid var(--line-08);border-left:1px solid var(--line-07);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);',
                  )}
                >
                  {pp.midVilla}
                </div>
                {pp.pricing.map((pr) => (
                  <div key={pr.window} style={css('display:contents;')}>
                    <div style={css('padding:16px 24px;border-bottom:1px solid var(--line-07);font-size:15px;color:var(--ink);')}>{pr.window}</div>
                    <div style={css('padding:16px 24px;border-bottom:1px solid var(--line-07);border-left:1px solid var(--line-07);')}>
                      <div style={css('font-size:17px;color:var(--ink);')}>{pr.entry}</div>
                      <div style={css('font-size:12px;color:var(--muted);margin-top:4px;')}>{pr.perNight}</div>
                    </div>
                    <div style={css('padding:16px 24px;border-bottom:1px solid var(--line-07);border-left:1px solid var(--line-07);font-size:17px;color:var(--ink);')}>
                      {pr.mid}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-top:20px;')}>
              <span style={css('font-size:13px;color:var(--muted);')}>
                {pp.pricingIsGuide
                  ? 'A guide from this island’s tier and the season, not a quoted rate. We confirm the exact total for your dates within 24 hours.'
                  : 'Guide prices from current contracts; we confirm the exact total for your dates within 24 hours.'}
              </span>
              <button type="button" onClick={quote} className="pill" style={css('height:44px;')}>
                Price my dates<i>→</i>
              </button>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- why book through Axis */}
        <section style={css('padding:96px 0 0;')}>
          <div style={css(WRAP)}>
            <div data-reveal="" style={css(KICKER)}>
              Why book through Axis
            </div>
            <h2 data-reveal="" style={css(H2 + 'margin-bottom:36px;')}>
              The same island, a better deal
            </h2>
            <div id="pp-vs" style={css('display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line-08);border:1px solid var(--line-08);border-radius:3px;overflow:hidden;')}>
              <div style={css('background:var(--panel);padding:28px 32px;')}>
                <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);padding-bottom:14px;border-bottom:1px solid var(--line-1);')}>
                  Book with Axis
                </div>
                {VS_AXIS.map((li) => (
                  <div key={li} style={css('display:flex;gap:14px;padding:13px 0;border-bottom:1px solid var(--line-07);font-size:14px;line-height:1.5;color:var(--ink);')}>
                    <Tick size={16} />
                    {li}
                  </div>
                ))}
              </div>
              <div style={css('background:var(--bg);padding:28px 32px;')}>
                <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);padding-bottom:14px;border-bottom:1px solid var(--line-1);')}>
                  Direct or generic OTA
                </div>
                {VS_OTHER.map((li) => (
                  <div key={li} style={css('display:flex;gap:14px;padding:13px 0;border-bottom:1px solid var(--line-07);font-size:14px;line-height:1.5;color:var(--soft);')}>
                    <span style={css('color:var(--muted);flex:none;width:16px;text-align:center;')} aria-hidden="true">
                      —
                    </span>
                    {li}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- similar islands */}
        {pp.similar.length > 0 && (
          <section id="pp-similar" style={css('padding:96px 0 0;')}>
            <div style={css(WRAP)}>
              <div data-reveal="" style={css(KICKER)}>
                Similar islands
              </div>
              <h2 data-reveal="" style={css(H2 + 'margin-bottom:36px;')}>
                If this is close but not quite
              </h2>
              <div id="pp-sim-grid" style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:18px;')}>
                {pp.similar.map((sm) => (
                  <a
                    key={sm.id}
                    href={`/properties/${sm.id}`}
                    className="zoomhost"
                    data-reveal=""
                    style={css('display:block;position:relative;aspect-ratio:4/3;border-radius:3px;overflow:hidden;border:1px solid var(--line-08);color:#fff;')}
                  >
                    <div
                      className="zoomable"
                      style={{
                        ...css('position:absolute;inset:0;background-size:cover;background-position:center;transition:transform .8s ease;'),
                        backgroundImage: `url(${sm.img})`,
                      }}
                    />
                    <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,16,47,.9));')} />
                    <div style={css('position:absolute;left:20px;right:20px;bottom:18px;')}>
                      <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#E0B94F;')}>{sm.tier}</div>
                      <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:24px;font-weight:300;margin-top:6px;")}>{sm.name}</div>
                      <div style={css('font-size:12px;color:rgba(255,255,255,.7);margin-top:4px;')}>
                        {sm.area} · {sm.transferShort}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- 07 questions */}
        {pp.faq.length > 0 && (
          <section id="pp-faq" style={css('padding:96px 0;')}>
            <div style={css('max-width:900px;margin:0 auto;padding:0 32px;')}>
              <div data-reveal="" style={css(KICKER)}>
                07 · Frequently asked
              </div>
              <h2 data-reveal="" style={css(H2 + 'margin-bottom:32px;')}>
                {p.name} — questions
              </h2>
              <div style={css('border-top:1px solid var(--line-1);')}>
                {pp.faq.map(([q, a], i) => (
                  <div key={q} style={css('border-bottom:1px solid var(--line-07);')}>
                    <button
                      type="button"
                      aria-expanded={open === i}
                      onClick={() => setOpen(open === i ? null : i)}
                      style={css(
                        'width:100%;display:flex;justify-content:space-between;align-items:center;gap:16px;background:none;border:0;padding:20px 0;text-align:left;color:var(--ink);font-size:17px;cursor:pointer;',
                      )}
                    >
                      <span>{q}</span>
                      <span style={css('font-size:20px;color:var(--gold-ink);flex:none;width:24px;text-align:center;')} aria-hidden="true">
                        {open === i ? '−' : '+'}
                      </span>
                    </button>
                    {open === i && (
                      <p style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:0 48px 22px 0;text-wrap:pretty;animation:fadein .3s ease;')}>{a}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* ---------------------------------------------------------------- the conversion bar */}
      <div
        id="pp-bar"
        style={{
          ...css(
            'position:fixed;left:0;right:0;bottom:0;z-index:56;background:var(--bg-95);backdrop-filter:blur(14px);border-top:1px solid rgba(224,185,79,.35);padding:12px 32px;display:flex;justify-content:space-between;align-items:center;gap:16px;transition:transform .4s ease;',
          ),
          transform: `translateY(${barOn ? '0' : '110%'})`,
        }}
      >
        <div id="pp-bar-name" style={css('display:flex;align-items:baseline;gap:14px;min-width:0;')}>
          <span
            style={css(
              "font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink);",
            )}
          >
            {p.name}
          </span>
          <span style={css('font-size:13px;color:var(--muted);white-space:nowrap;')}>{pp.barPrice}</span>
        </div>
        <div id="pp-bar-btns" style={css('display:flex;gap:8px;')}>
          <Hover
            as="a"
            href={pp.whatsapp}
            target="_blank"
            rel="noopener"
            style="display:inline-flex;align-items:center;justify-content:center;gap:8px;height:46px;padding:0 18px;border:1px solid var(--line-2);color:var(--ink);font-size:13px;border-radius:2px;white-space:nowrap;transition:all .2s;"
            hover="border-color:var(--gold-ink);color:var(--gold-ink);"
          >
            Chat with a specialist
          </Hover>
          <Hover
            as="button"
            type="button"
            onClick={quote}
            style="height:46px;padding:0 22px;background:#E0B94F;color:#00102F;border:0;font-size:13px;font-weight:600;border-radius:2px;white-space:nowrap;transition:background .2s;cursor:pointer;"
            hover="background:#F0CB64;"
          >
            Get a custom quote
          </Hover>
        </div>
      </div>
    </>
  )
}
