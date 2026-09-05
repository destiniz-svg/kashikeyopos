'use client'

/** Our Story, the collection tiers, the About bento, the guest voices and the pre-footer CTA. */
import { useRef } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { ImageSlot } from '@/components/ui/ImageSlot'
import { useAmbientPlayback } from '@/components/ui/motion'
import { useTiers } from '../derive'
import { useSite } from '../state'
import { assetUrl } from '@/lib/content/asset-url'

export function Story() {
  const { state: s, actions } = useSite()
  const tiers = useTiers(s.bundle.properties)
  const storyImg = assetUrl(s.bundle.homepage?.storyImg)

  return (
    <section id="story" data-screen-label="Our Story" style={css('background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);')}>
      <div id="story-grid" style={css('max-width:1400px;margin:0 auto;padding:96px 32px;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;')}>
        <div data-reveal="">
          <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Our Story</div>
          <h2 id="story-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:44px;line-height:1.08;margin:14px 0 22px;letter-spacing:-.02em;text-wrap:balance;")}>
            Browse like a marketplace. Close like a concierge.
          </h2>
          <p style={css('font-size:16px;line-height:1.75;color:var(--ink-78);margin:0 0 28px;')}>
            AXIS Journeys crafts seamless, unforgettable travel — tailored holiday packages and luxury stays across the Maldives. We listen first, then hand-pick three resorts that truly fit you: no long lists, just the right match, with a real specialist beside you before, during and after your trip.
          </p>
          <div id="tier-grid" style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:14px;')}>
            {tiers.map((t) => (
              <Hover
                key={t.name}
                as="button"
                type="button"
                onClick={() => actions.openTier(t.name)}
                style={{ ...css('text-align:left;background:var(--bg);padding:18px;color:var(--ink);border-radius:3px;transition:all .25s;'), border: `1px solid ${s.pf.tier === t.name ? 'var(--gold-ink)' : 'var(--line-08)'}` }}
                hover="border-color:var(--gold-ink);transform:translateY(-3px);"
              >
                <div style={css('font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-ink);')}>{t.name}</div>
                <div style={css('font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5;')}>{t.desc}</div>
                <div style={css('font-size:13px;margin-top:10px;')}>{t.from}</div>
              </Hover>
            ))}
          </div>
        </div>
        <div id="story-photo-wrap" data-reveal="" style={css('position:relative;height:520px;')}>
          <ImageSlot
            src={storyImg}
            alt="An Axis specialist meeting a guest at a resort jetty"
            credit="Photo by Shifaaz shamoon on Unsplash"
            creditHref="https://unsplash.com/@sotti"
            placeholder="Editorial photo · specialist meeting a guest at a resort jetty"
            sizes="(max-width:1000px) 100vw, 640px"
          />
          <div id="story-quote" style={css('position:absolute;left:-28px;bottom:60px;background:var(--bg);border:1px solid var(--line-1);padding:22px 26px;max-width:320px;pointer-events:none;box-shadow:0 30px 60px var(--shadow-50);')}>
            <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:20px;line-height:1.35;")}>
              “They rebooked our seaplane before we knew the weather had turned.”
            </div>
            <div style={css('font-size:12px;color:var(--muted);margin-top:10px;letter-spacing:.06em;')}>Layla &amp; Omar · Honeymoon, Baa Atoll · March 2026</div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function AboutAxis() {
  const { state: s, actions } = useSite()
  const settings = s.bundle.settings
  const waLink = `https://wa.me/${settings?.whatsapp || '971554855656'}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`
  const email = settings?.email || 'hello@axisjourneys.com'
  const maldivesVideo = assetUrl(s.destinations.find((d) => d.name === 'Maldives')?.video)
  const teamImg = settings?.teamImg || ''
  const aboutVideo = useRef<HTMLVideoElement>(null)
  useAmbientPlayback(aboutVideo, maldivesVideo)

  return (
    <section id="about" data-screen-label="About Axis" style={css('padding:96px 0;')}>
      <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;')}>
        <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;margin-bottom:28px;')}>
          <div>
            <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>About Axis</div>
            <h2 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:44px;line-height:1.08;margin:14px 0 0;letter-spacing:-.02em;")}>
              Seamless journeys, designed around every traveller.
            </h2>
          </div>
          <div style={css('font-size:14px;color:var(--muted);max-width:460px;line-height:1.6;')}>
            A Dubai-based luxury travel company specialising in bespoke Maldives escapes — expert destination knowledge, carefully selected resorts and personalised service. Managed and operated by Axis Link LLC FZ, Meydan Grandstand, Dubai.
          </div>
        </div>

        <div id="about-grid">
          <a href={waLink} target="_blank" rel="noopener" className="bento" data-reveal="">
            <div className="bg" style={{ backgroundImage: `url(${teamImg})` }} />
            <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,16,47,.1) 30%,rgba(0,16,47,.92));')} />
            <div style={css('position:relative;')}>
              <div style={css('font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold-ink);')}>Our team</div>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:32px;line-height:1.1;margin:12px 0 18px;max-width:400px;")}>
                Passionate specialists who understand every traveller&apos;s needs — from planning to the moment you return home.
              </div>
              <div style={css('display:flex;justify-content:space-between;align-items:center;')}>
                <span style={css('font-size:13px;color:var(--soft);')}>Real people, real advice — not bots</span>
                <span className="arrow">→</span>
              </div>
            </div>
          </a>

          <button type="button" onClick={actions.nav('properties')} className="bento" data-reveal="">
            {maldivesVideo && (
              <video id="about-video" ref={aboutVideo} muted loop playsInline preload="none" src={maldivesVideo} aria-hidden="true" style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.7;')} />
            )}
            <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,16,47,.9));')} />
            <div style={css('position:relative;')}>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:26px;line-height:1.15;")}>Your Maldives, narrowed to three hand-picked resorts.</div>
              <div style={css('display:flex;justify-content:space-between;align-items:center;margin-top:16px;')}>
                <span style={css('font-size:13px;color:var(--soft);')}>See the collection</span>
                <span className="arrow">→</span>
              </div>
            </div>
          </button>

          <div className="bento" data-reveal="" style={css('background:#E0B94F;color:#00102F;')}>
            <div style={css('font-size:11px;letter-spacing:.3em;text-transform:uppercase;opacity:.7;')}>How we work</div>
            <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:18px 12px;margin-top:18px;')}>
              {[
                ['3', 'Hand-picked resorts per enquiry — never a long list'],
                ['70+', 'Partner resorts, each one stayed in by our team'],
                ['15+', 'Years of Indian Ocean expertise behind every itinerary'],
                ['1', 'Named specialist with you before, during and after'],
              ].map(([n, label]) => (
                <div key={label}>
                  <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:44px;line-height:1;")}>{n}</div>
                  <div style={css('font-size:12px;margin-top:6px;opacity:.75;')}>{label}</div>
                </div>
              ))}
            </div>
          </div>

          <a href={`mailto:${email}?subject=Working at Axis`} className="bento" data-reveal="">
            <div className="bg" style={css('background-image:url(https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=1000&q=70);opacity:.85;')} />
            <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,16,47,.2),rgba(0,16,47,.92));')} />
            <div style={css('position:relative;')}>
              <div style={css('font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold-ink);')}>Our vision</div>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:26px;line-height:1.15;margin-top:10px;")}>
                To become the world&apos;s most trusted name in luxury travel.
              </div>
              <div style={css('display:flex;justify-content:space-between;align-items:center;margin-top:16px;')}>
                <span style={css('font-size:13px;color:var(--soft);')}>Meydan Grandstand, Dubai</span>
                <span className="arrow">→</span>
              </div>
            </div>
          </a>

          <button type="button" onClick={() => actions.openDest('Maldives')} className="bento" data-reveal="">
            <div className="bg" style={css('background-image:url(https://images.unsplash.com/photo-1540202404-a2f29016b523?auto=format&fit=crop&w=1000&q=70);')} />
            <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,16,47,.2),rgba(0,16,47,.92));')} />
            <div style={css('position:relative;')}>
              <div style={css('font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold-ink);')}>Our promise</div>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:26px;line-height:1.15;margin-top:10px;")}>
                Smooth, memorable and stress-free — every detail handled.
              </div>
              <div style={css('display:flex;justify-content:space-between;align-items:center;margin-top:16px;')}>
                <span style={css('font-size:13px;color:var(--soft);')}>Replies within minutes</span>
                <span className="arrow">→</span>
              </div>
            </div>
          </button>
        </div>
      </div>
    </section>
  )
}

export function Voices() {
  const { state: s } = useSite()
  const voices = s.bundle.homepage?.voices || []
  if (!voices.length) return null

  return (
    <section id="voices" data-screen-label="Testimonials" style={css('padding:96px 0 24px;overflow:hidden;')}>
      <div data-reveal="" style={css('text-align:center;padding:0 24px;')}>
        <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Real travellers</div>
        <h2 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>What they remember</h2>
      </div>
      <div id="voices-grid" data-reveal="" style={css('max-width:1400px;margin:44px auto 0;padding:0 32px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px;')}>
        {voices.map((v, i) => (
          <Hover
            key={`${v.who}-${i}`}
            as="figure"
            style="margin:0;background:var(--panel);border:1px solid var(--line-08);border-radius:3px;padding:30px 28px 26px;display:flex;flex-direction:column;gap:18px;position:relative;overflow:hidden;transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .3s;"
            hover="transform:translateY(-4px);border-color:rgba(224,185,79,.6);"
          >
            <div style={css("position:absolute;top:-10px;right:18px;font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:120px;line-height:1;color:rgba(224,185,79,.12);pointer-events:none;")} aria-hidden="true">
              ”
            </div>
            <div style={css('color:var(--gold-ink);font-size:12px;letter-spacing:.2em;')} aria-label="Five out of five">
              ★★★★★
            </div>
            <blockquote style={css("margin:0;font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:20px;line-height:1.45;color:var(--ink);text-wrap:pretty;")}>{v.quote}</blockquote>
            <figcaption style={css('display:flex;align-items:center;gap:12px;margin-top:auto;')}>
              <span
                style={{
                  ...css('width:40px;height:40px;border-radius:50%;background-size:cover;flex-shrink:0;border:1px solid var(--gold-50);'),
                  backgroundImage: v.img ? `url(${v.img})` : undefined,
                  backgroundPosition: (v as { pos?: string }).pos || '50% 50%',
                  background: v.img ? undefined : 'var(--bg-deep)',
                }}
              />
              <span>
                <span style={css('display:block;font-size:13px;font-weight:500;')}>{v.who}</span>
                <span style={css('display:block;font-size:12px;color:var(--muted);margin-top:2px;')}>{v.trip}</span>
              </span>
            </figcaption>
          </Hover>
        ))}
      </div>
    </section>
  )
}

export function CtaBand() {
  const { state: s, actions } = useSite()
  const waLink = `https://wa.me/${s.bundle.settings?.whatsapp || '971554855656'}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`

  return (
    <section className="dk" id="cta" data-screen-label="Pre-footer CTA" style={css('padding:120px 32px;text-align:center;position:relative;overflow:hidden;')}>
      <div style={css('position:absolute;inset:0;background-image:linear-gradient(180deg,#00102F 0%,rgba(0,16,47,.7) 40%,rgba(0,16,47,.85) 100%),url(https://images.unsplash.com/photo-1573843981267-be1999ff37cd?auto=format&fit=crop&w=1920&q=60);background-size:cover;background-position:center;animation:drift 30s ease-in-out infinite alternate;')} />
      <div style={css('position:relative;')}>
        <div data-reveal="">
          <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Begin</div>
          <h2 id="cta-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:52px;line-height:1;margin:14px 0 18px;")}>
            Tell us the feeling. We&apos;ll find the island.
          </h2>
          <p style={css('color:var(--muted);font-size:15px;margin:0 0 30px;')}>Sixty seconds. A shortlist of three within 24 hours. Refined together on WhatsApp.</p>
          <div style={css('display:flex;gap:14px;justify-content:center;flex-wrap:wrap;')}>
            <Hover
              as="button"
              type="button"
              onClick={() => actions.openDrawer(null)}
              style="background:#E0B94F;color:#00102F;border:0;padding:15px 28px;font-size:14px;font-weight:600;letter-spacing:.04em;border-radius:2px;transition:all .2s;"
              hover="background:#EBCB72;transform:translateY(-2px);"
            >
              Plan my journey
            </Hover>
            <Hover
              as="a"
              href={waLink}
              target="_blank"
              rel="noopener"
              style="display:inline-flex;align-items:center;gap:8px;color:var(--ink);border:1px solid var(--line-22);padding:15px 24px;font-size:14px;border-radius:2px;transition:all .2s;backdrop-filter:blur(6px);"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              <span style={css('width:8px;height:8px;border-radius:50%;background:#25D366;')} />
              WhatsApp a specialist
            </Hover>
          </div>
        </div>
      </div>
    </section>
  )
}
