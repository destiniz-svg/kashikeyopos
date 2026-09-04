'use client'

/**
 * The utility ribbon, the sticky header and the destinations mega menu.
 *
 * The ribbon collapses to zero height past 40px of scroll and the header darkens with it; over the
 * hero both carry `.dk` so the light theme still reads white-on-video. Those two rules are the
 * whole of why this component watches scroll.
 */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { segColours } from '../derive'
import { useSite } from '../state'
import { availableQuickPaths } from '@/lib/content/filters'

export function Header() {
  const { state, actions } = useSite()
  const s = state
  const settings = s.bundle.settings

  const showRibbon = !s.scrolled
  const headerBg = s.scrolled || s.mega || s.page ? 'var(--hdr-solid)' : s.theme === 'light' ? 'rgba(247,245,240,.55)' : 'rgba(0,16,47,.25)'
  const headerCls = s.theme === 'light' || s.scrolled || s.mega || s.page || s.menuOpen ? '' : 'dk'
  const megaLinkColor = s.mega ? '#E0B94F' : 'var(--ink)'
  const en = segColours(s.lang === 'EN')
  const ar = segColours(s.lang === 'AR')
  const usd = segColours(s.currency === 'USD')
  const eur = segColours(s.currency === 'EUR')
  const phone = settings?.phone || '+971 58 270 7625'
  const phoneHref = settings?.phoneHref || '+971582707625'
  const whatsapp = settings?.whatsapp || '971554855656'
  const waLink = `https://wa.me/${whatsapp}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`

  // Only the paths this catalogue can answer — see `availableQuickPaths`.
  const quickPaths = availableQuickPaths(s.bundle.properties, s.bundle.offers)

  const megaTiles = s.liveDestinations.map((d) => ({
    name: d.name,
    count: s.bundle.properties.filter((r) => r.dest === d.name).length,
    img: d.card,
  }))

  return (
    <div style={css('position:fixed;top:0;left:0;right:0;z-index:60;')}>
      <div
        style={{
          ...css('overflow:hidden;transition:height .35s ease;background:var(--bg-deep);border-bottom:1px solid var(--line-06);'),
          height: showRibbon ? '36px' : '0px',
        }}
      >
        <div style={css('max-width:1400px;margin:0 auto;padding:0 32px;height:36px;display:flex;align-items:center;justify-content:space-between;font-size:12px;letter-spacing:.04em;color:var(--muted);')}>
          <div style={css('display:flex;align-items:center;gap:20px;')}>
            <span id="ribbon-lic">Licensed UAE travel agency · TL {settings?.licence || '2423494.01'}</span>
            <span id="ribbon-note" style={css('color:var(--gold-ink);')}>
              Replies in under 1 hour
            </span>
          </div>
          <div id="ribbon-right" style={css('display:flex;align-items:center;gap:20px;')}>
            <Hover
              as="button"
              id="theme-btn"
              type="button"
              onClick={actions.toggleTheme}
              aria-label={s.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              title={s.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              style="display:inline-flex;align-items:center;gap:8px;height:24px;padding:0 8px;border:1px solid var(--line-12);border-radius:2px;background:none;color:var(--ink);font-size:11px;letter-spacing:.08em;"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              {s.theme !== 'light' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              )}
              <span>{s.theme === 'light' ? 'Light' : 'Dark'}</span>
            </Hover>

            <div style={css('display:flex;gap:2px;border:1px solid var(--line-12);border-radius:2px;padding:2px;')}>
              <button type="button" onClick={() => actions.setLang('EN')} style={{ ...css('border:0;font-size:11px;padding:2px 8px;letter-spacing:.08em;transition:all .2s;'), background: en.bg, color: en.fg }}>
                EN
              </button>
              <button type="button" onClick={() => actions.setLang('AR')} style={{ ...css('border:0;font-size:11px;padding:2px 8px;letter-spacing:.08em;transition:all .2s;'), background: ar.bg, color: ar.fg }}>
                AR
              </button>
            </div>

            <div style={css('display:flex;gap:2px;border:1px solid var(--line-12);border-radius:2px;padding:2px;')}>
              <button type="button" onClick={() => actions.setCurrency('USD')} style={{ ...css('border:0;font-size:11px;padding:2px 8px;letter-spacing:.08em;transition:all .2s;'), background: usd.bg, color: usd.fg }}>
                USD
              </button>
              <button type="button" onClick={() => actions.setCurrency('EUR')} style={{ ...css('border:0;font-size:11px;padding:2px 8px;letter-spacing:.08em;transition:all .2s;'), background: eur.bg, color: eur.fg }}>
                EUR
              </button>
            </div>

            <a href={`tel:${phoneHref}`} style={css('color:var(--ink);')}>
              {phone}
            </a>
          </div>
        </div>
      </div>

      <header
        className={headerCls}
        onMouseLeave={() => actions.setMega(false)}
        style={{
          ...css('backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid var(--line-07);transition:background .35s ease;'),
          background: headerBg,
        }}
      >
        <div id="hdr" style={css('max-width:1400px;margin:0 auto;padding:0 32px;height:76px;display:flex;align-items:center;justify-content:space-between;gap:32px;')}>
          <a href="/" onClick={actions.goTop} style={css('display:flex;align-items:center;gap:12px;color:var(--ink);')}>
            {/* The wordmark is a plain <img>: the optimiser resamples a 34px-tall raster and the
                mark is the one place on the page where that is visible. Width and height are set,
                so it still reserves its box and costs no layout shift. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="logo-dark" src="/assets/logomark-white.png" alt="Axis Journeys" width={29} height={34} fetchPriority="high" style={css('height:34px;width:auto;display:block;')} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="logo-light" src="/assets/logomark.png" alt="" aria-hidden="true" width={29} height={34} style={css('height:34px;width:auto;display:none;')} />
            <span style={css('display:flex;flex-direction:column;gap:3px;')}>
              <span style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:500;font-size:20px;letter-spacing:.34em;line-height:1;")}>AXIS</span>
              <span style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:9px;letter-spacing:.42em;line-height:1;color:var(--gold-ink);")}>JOURNEYS</span>
            </span>
          </a>

          <nav id="desknav" style={css('display:flex;align-items:center;gap:36px;font-size:14px;font-weight:500;letter-spacing:.02em;')} aria-label="Primary">
            <button
              type="button"
              onMouseEnter={() => actions.setMega(true)}
              /**
               * Opens on a mouse, toggles on a touch — and never closes what the pointer arriving
               * has just opened.
               *
               * `onMouseEnter` fires before `onClick`, so with a mouse the menu is ALREADY open by
               * the time the click lands and a toggle can only ever shut it again. Measured: hover
               * put `aria-expanded` at true, the click put it back to false, and clicking
               * "Destinations" — the ordinary way anybody opens a menu — showed nothing at all.
               * A device with no hover never opened it on approach, so there a toggle is right.
               */
              onClick={() => {
                const hoverable = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches
                actions.setMega(hoverable ? true : !s.mega)
              }}
              aria-expanded={s.mega}
              style={{ ...css('background:none;border:0;font-size:14px;font-weight:500;letter-spacing:.02em;padding:26px 0;display:flex;align-items:center;gap:6px;transition:color .2s;'), color: megaLinkColor }}
            >
              Destinations{' '}
              <span style={{ ...css('font-size:10px;display:inline-block;transition:transform .25s;'), transform: `rotate(${s.mega ? '180deg' : '0deg'})` }}>▼</span>
            </button>
            {[
              { label: 'Properties', id: 'properties' },
              { label: 'Experiences', id: 'experiences' },
              { label: 'Offers', id: 'offers' },
              { label: 'Our Story', id: 'story' },
            ].map((link) => (
              <Hover
                key={link.id}
                as="a"
                href={`#${link.id}`}
                onClick={actions.nav(link.id)}
                onMouseEnter={() => actions.setMega(false)}
                style="color:var(--ink);transition:color .2s;"
                hover="color:var(--gold-ink);"
              >
                {link.label}
              </Hover>
            ))}
          </nav>

          <div id="hdr-cta" style={css('display:flex;align-items:center;gap:14px;')}>
            <Hover
              as="button"
              type="button"
              onClick={() => actions.openDrawer(null, null, 'saved')}
              aria-label={`Shortlist${s.saved.length ? ` (${s.saved.length} saved)` : ''}`}
              style="position:relative;background:none;border:1px solid var(--line-18);color:var(--ink);width:40px;height:40px;border-radius:2px;font-size:16px;transition:all .2s;"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              ♡
              {s.saved.length > 0 && (
                <span style={css('position:absolute;top:-7px;right:-7px;background:#E0B94F;color:#00102F;font-size:10px;font-weight:700;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;animation:pulse .5s ease;')}>
                  {s.saved.length}
                </span>
              )}
            </Hover>

            <Hover
              as="a"
              href={waLink}
              target="_blank"
              rel="noopener"
              style="display:flex;align-items:center;gap:8px;color:var(--ink);font-size:13px;font-weight:500;padding:10px 14px;border:1px solid var(--line-18);border-radius:2px;transition:all .2s;"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              <span style={css('width:8px;height:8px;border-radius:50%;background:#25D366;display:inline-block;')} />
              <span id="wa-label">WhatsApp a specialist</span>
            </Hover>

            <Hover
              as="button"
              id="plan-btn"
              type="button"
              onClick={() => actions.openDrawer(null)}
              style="background:#E0B94F;color:#00102F;border:0;padding:11px 18px;font-size:13px;font-weight:600;letter-spacing:.04em;border-radius:2px;transition:all .2s;"
              hover="background:#EBCB72;transform:translateY(-1px);"
            >
              Plan my journey
            </Hover>
          </div>

          <button
            id="burger"
            type="button"
            onClick={actions.toggleMenu}
            aria-label="Menu"
            aria-expanded={s.menuOpen}
            style={css('display:none;align-items:center;justify-content:center;gap:10px;background:none;border:1px solid var(--line-2);color:var(--ink);height:40px;padding:0 14px;border-radius:2px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;')}
          >
            {s.menuOpen ? 'Close' : 'Menu'}
            <span style={css('display:flex;flex-direction:column;gap:4px;')}>
              <span style={css('display:block;width:16px;height:1px;background:currentColor;')} />
              <span style={css('display:block;width:16px;height:1px;background:currentColor;')} />
            </span>
          </button>
        </div>

        {s.mega && (
          <div style={css('border-top:1px solid var(--line-07);background:var(--bg-94);animation:fadein .25s ease;')}>
            <div id="mega-grid" style={css('max-width:1400px;margin:0 auto;padding:28px 32px 32px;display:grid;grid-template-columns:2fr 1fr;gap:40px;')}>
              <div>
                <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;')}>Destinations</div>
                <div style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:14px;')}>
                  {megaTiles.map((t) => (
                    <Hover
                      key={t.name}
                      as="button"
                      type="button"
                      onClick={() => actions.openDest(t.name)}
                      style="text-align:left;background:var(--panel);border:1px solid var(--line-08);border-radius:3px;padding:0;overflow:hidden;color:var(--ink);transition:all .3s;"
                      hover="border-color:var(--gold-ink);transform:translateY(-3px);"
                    >
                      <div style={{ ...css('height:110px;background-size:cover;background-position:center;'), backgroundImage: `url(${t.img})` }} />
                      <div style={css('padding:12px 14px 14px;')}>
                        <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:17px;line-height:1.1;")}>{t.name}</div>
                        <div style={css('font-size:12px;color:var(--muted);margin-top:4px;')}>{t.count} properties</div>
                      </div>
                    </Hover>
                  ))}
                </div>
              </div>
              <div>
                <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;')}>Curated quick paths</div>
                <div style={css('display:flex;flex-direction:column;gap:6px;')}>
                  {quickPaths.map((q) => (
                    <Hover
                      key={q.label}
                      as="button"
                      type="button"
                      onClick={() => actions.apply(q.apply)}
                      style="text-align:left;background:none;border:0;border-bottom:1px solid var(--line-07);padding:11px 0;color:var(--ink);font-size:14px;display:flex;justify-content:space-between;align-items:center;transition:color .2s;width:100%;"
                      hover="color:var(--gold-ink);"
                    >
                      <span>{q.label}</span>
                      <span style={css('color:var(--muted);font-size:12px;')}>→</span>
                    </Hover>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </header>
    </div>
  )
}
