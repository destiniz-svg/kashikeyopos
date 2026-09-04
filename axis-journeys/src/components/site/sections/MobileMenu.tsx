'use client'

/** The full-screen menu behind the hamburger at ≤820px. */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { useSite } from '../state'

export function MobileMenu() {
  const { state: s, actions } = useSite()
  if (!s.menuOpen) return null

  const menuTop = (s.scrolled ? 0 : 36) + 64 + 'px'
  const links = [
    { label: 'Properties', go: actions.nav('properties') },
    { label: 'Experiences', go: actions.nav('experiences') },
    { label: 'Offers', go: actions.nav('offers') },
    { label: 'Our Story', go: actions.nav('story') },
    {
      label: 'Plan my journey',
      go: () => {
        actions.closeMenu()
        actions.openDrawer(null)
      },
    },
  ]
  const megaTiles = s.liveDestinations.map((d) => ({
    name: d.name,
    count: s.bundle.properties.filter((r) => r.dest === d.name).length,
    img: d.card,
  }))
  const settings = s.bundle.settings
  const menuColour = (on: boolean) => (on ? '#E0B94F' : 'var(--muted)')

  return (
    <div style={{ ...css('position:fixed;left:0;right:0;bottom:0;z-index:58;background:var(--bg-97);overflow-y:auto;padding:28px 20px 120px;animation:fadein .25s ease;'), top: menuTop }}>
      <div style={css('display:flex;justify-content:flex-end;margin-bottom:14px;')}>
        <Hover
          as="button"
          id="theme-btn-m"
          type="button"
          onClick={actions.toggleTheme}
          aria-label={s.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          style="display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line-12);border-radius:2px;background:none;color:var(--ink);font-size:11px;letter-spacing:.08em;height:40px;padding:0 14px;"
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
      </div>

      <nav style={css('display:flex;flex-direction:column;gap:2px;')} aria-label="Mobile">
        {links.map((m) => (
          <button
            key={m.label}
            type="button"
            onClick={() => m.go()}
            style={css("text-align:left;background:none;border:0;border-bottom:1px solid var(--line-08);padding:18px 0;color:var(--ink);font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:24px;line-height:1.05;display:flex;justify-content:space-between;align-items:center;")}
          >
            {m.label}
            <span style={css("font-size:14px;color:var(--muted);font-family:var(--font-body),'Mona Sans',sans-serif;")}>→</span>
          </button>
        ))}
      </nav>

      <div style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin:28px 0 14px;')}>Destinations</div>
      <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:10px;')}>
        {megaTiles.map((t) => (
          <button
            key={t.name}
            className="dk"
            type="button"
            onClick={() => actions.openDest(t.name)}
            style={{
              ...css('text-align:left;position:relative;height:96px;border:1px solid var(--line-1);border-radius:3px;padding:0;overflow:hidden;color:var(--ink);background-size:cover;background-position:center;'),
              backgroundImage: `linear-gradient(180deg,rgba(0,16,47,.1),rgba(0,16,47,.85)),url(${t.img})`,
            }}
          >
            <div style={css('position:absolute;left:12px;bottom:10px;')}>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:17px;line-height:1.05;")}>{t.name}</div>
              <div style={css('font-size:11px;color:var(--muted);margin-top:3px;')}>{t.count} properties</div>
            </div>
          </button>
        ))}
      </div>

      <div style={css('display:flex;gap:16px;margin-top:28px;font-size:13px;flex-wrap:wrap;align-items:center;')}>
        <button type="button" onClick={() => actions.setCurrency('USD')} style={{ ...css('background:none;border:0;padding:0;font-size:13px;letter-spacing:.08em;'), color: menuColour(s.currency === 'USD') }}>
          USD
        </button>
        <button type="button" onClick={() => actions.setCurrency('EUR')} style={{ ...css('background:none;border:0;padding:0;font-size:13px;letter-spacing:.08em;'), color: menuColour(s.currency === 'EUR') }}>
          EUR
        </button>
        <span style={css('color:var(--line-2);')}>|</span>
        <button type="button" onClick={() => actions.setLang('EN')} style={{ ...css('background:none;border:0;padding:0;font-size:13px;letter-spacing:.08em;'), color: menuColour(s.lang === 'EN') }}>
          EN
        </button>
        <button type="button" onClick={() => actions.setLang('AR')} style={{ ...css('background:none;border:0;padding:0;font-size:13px;letter-spacing:.08em;'), color: menuColour(s.lang === 'AR') }}>
          AR
        </button>
        <span style={css('color:var(--line-2);')}>|</span>
        <a href={`tel:${settings?.phoneHref || '+971582707625'}`} style={css('color:var(--ink);')}>
          {settings?.phone || '+971 58 270 7625'}
        </a>
      </div>
    </div>
  )
}
