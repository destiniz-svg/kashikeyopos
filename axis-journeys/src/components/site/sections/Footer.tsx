'use client'

/**
 * The footer: the newsletter sign-up, the four link columns, the gold social ring icons, and the
 * legal links that open the modal.
 *
 * The sign-up posts to a real endpoint. The prototype only toasted, and a form that says "you're on
 * the list" over nothing is the defect this build refuses by name.
 */
import { useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { useSite, type LegalKey } from '../state'

const SOCIAL_ICONS: Record<string, React.ReactNode> = {
  instagram: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r=".9" fill="currentColor" stroke="none" />
    </svg>
  ),
  tiktok: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5" />
      <path d="M14 3c.3 2.6 2 4.4 4.5 4.6" />
    </svg>
  ),
  youtube: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
      <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none" />
    </svg>
  ),
  facebook: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h-2.5A4.5 4.5 0 0 0 8 7.5V10H5.5v4H8v7h4v-7h2.6l.6-4H12V7.8c0-.5.4-.8.9-.8H15z" />
    </svg>
  ),
}
const SOCIAL_ORDER: (keyof typeof SOCIAL_ICONS)[] = ['instagram', 'tiktok', 'youtube', 'facebook']
const SOCIAL_LABEL: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' }

export const LEGAL_KEYS: LegalKey[] = ['terms', 'privacy', 'cancel', 'security']

export function Footer() {
  const { state: s, actions } = useSite()
  const [email, setEmail] = useState('')
  const settings = s.bundle.settings
  const phone = settings?.phone || '+971 58 270 7625'
  const phoneHref = settings?.phoneHref || '+971582707625'
  const mail = settings?.email || 'hello@axisjourneys.com'
  const waLink = `https://wa.me/${settings?.whatsapp || '971554855656'}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`
  const social = settings?.social || {}
  const legal = settings?.legal

  return (
    <footer id="legal" data-screen-label="Footer" style={css('background:var(--bg-deep);border-top:1px solid rgba(224,185,79,.35);padding:0 32px 110px;position:relative;overflow:hidden;')}>
      <div style={css('position:absolute;right:-60px;bottom:-40px;width:520px;height:520px;background-image:url(/assets/logomark-white.png);background-size:contain;background-repeat:no-repeat;background-position:bottom right;opacity:.035;pointer-events:none;')} />

      <div id="footer-top" style={css('max-width:1400px;margin:0 auto;padding:56px 0 48px;display:flex;justify-content:space-between;align-items:center;gap:32px;flex-wrap:wrap;border-bottom:1px solid var(--line-08);')}>
        <div>
          <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>Stay in the loop</div>
          <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:28px;line-height:1.15;margin-top:10px;letter-spacing:-.01em;")}>
            New properties and offers, once a month.
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void actions.subscribe(email)
          }}
          style={css('display:flex;gap:8px;flex-wrap:wrap;align-items:center;')}
        >
          <label htmlFor="newsletter-email" className="sr-only">
            Your email
          </label>
          <input
            id="newsletter-email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            autoComplete="email"
            placeholder="Your email"
            style={css('background:var(--line-04);border:1px solid var(--line-16);color:var(--ink);padding:0 16px;height:48px;min-width:260px;font-size:14px;border-radius:2px;')}
          />
          <Hover
            as="button"
            type="submit"
            disabled={s.subscribed}
            style="height:48px;background:#E0B94F;color:#00102F;border:0;padding:0 20px;font-size:13px;font-weight:600;letter-spacing:.04em;border-radius:2px;transition:all .2s;"
            hover="background:#EBCB72;"
          >
            {s.subscribed ? "You're on the list" : 'Subscribe'}
          </Hover>
        </form>
      </div>

      <div id="footer-grid" style={css('max-width:1400px;margin:0 auto;padding-top:56px;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr 1.2fr;gap:40px;position:relative;')}>
        <div>
          <div style={css('display:flex;align-items:center;gap:14px;')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="logo-dark" src="/assets/logomark-white.png" alt="Axis Journeys" width={37} height={44} loading="lazy" style={css('height:44px;width:auto;display:block;')} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="logo-light" src="/assets/logomark.png" alt="" aria-hidden="true" width={37} height={44} loading="lazy" style={css('height:44px;width:auto;display:none;')} />
            <span style={css('display:flex;flex-direction:column;gap:4px;')}>
              <span style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:500;font-size:24px;letter-spacing:.34em;line-height:1;")}>AXIS</span>
              <span style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:10px;letter-spacing:.42em;line-height:1;color:var(--gold-ink);")}>JOURNEYS</span>
            </span>
          </div>
          <div style={css('font-size:13px;color:var(--ink);margin-top:14px;letter-spacing:.02em;')}>Seamless Journeys, Timeless Memories.</div>
          <p style={css('font-size:13px;line-height:1.7;color:var(--muted);margin:18px 0 0;max-width:340px;')}>
            Axis Link LLC-FZ · Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, UAE
            <br />
            Trade License {settings?.licence || '2423494.01'}
          </p>
          <div style={css('display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;')}>
            {SOCIAL_ORDER.filter((k) => social[k as keyof typeof social]).map((k) => (
              <Hover
                key={k}
                as="a"
                href={social[k as keyof typeof social]}
                target="_blank"
                rel="noopener"
                aria-label={SOCIAL_LABEL[k]}
                style="width:40px;height:40px;border:1px solid rgba(224,185,79,.35);border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--gold-ink);transition:all .2s;"
                hover="border-color:var(--gold-ink);background:#E0B94F;color:#00102F;"
              >
                {SOCIAL_ICONS[k]}
              </Hover>
            ))}
          </div>
        </div>

        <div style={css('display:flex;flex-direction:column;gap:10px;font-size:13px;')}>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;')}>Destinations</div>
          {s.liveDestinations.map((d) => (
            <Hover key={d.id} as="button" type="button" onClick={() => actions.openDest(d.name)} style="background:none;border:0;padding:0;text-align:left;color:var(--ink);font-size:13px;transition:color .2s;" hover="color:var(--gold-ink);">
              {d.name}
            </Hover>
          ))}
        </div>

        <div style={css('display:flex;flex-direction:column;gap:10px;font-size:13px;')}>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;')}>Explore</div>
          {[
            { label: 'Properties', id: 'properties' },
            { label: 'Experiences', id: 'experiences' },
            { label: 'Offers', id: 'offers' },
            { label: 'Our Story', id: 'story' },
          ].map((l) => (
            <Hover key={l.id} as="a" href={`#${l.id}`} onClick={actions.nav(l.id)} style="color:var(--ink);" hover="color:var(--gold-ink);">
              {l.label}
            </Hover>
          ))}
        </div>

        <div style={css('display:flex;flex-direction:column;gap:10px;font-size:13px;')}>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;')}>Legal</div>
          {LEGAL_KEYS.map((k) => (
            <Hover key={k} as="button" type="button" onClick={() => actions.setLegal(k)} style="background:none;border:0;padding:0;text-align:left;color:var(--ink);font-size:13px;transition:color .2s;" hover="color:var(--gold-ink);">
              {legal?.[k]?.title || k}
            </Hover>
          ))}
        </div>

        <div style={css('font-size:13px;color:var(--muted);line-height:1.7;')}>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;margin-bottom:12px;')}>Speak to a specialist</div>
          <a href={`tel:${phoneHref}`} style={css("display:block;color:var(--ink);font-size:18px;font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;letter-spacing:.02em;")}>
            {phone}
          </a>
          <a href={`mailto:${mail}`} style={css('display:block;color:var(--ink);margin-top:4px;')}>
            {mail}
          </a>
          <Hover
            as="a"
            href={waLink}
            target="_blank"
            rel="noopener"
            style="display:inline-flex;align-items:center;gap:8px;color:var(--ink);border:1px solid var(--line-18);padding:10px 14px;font-size:13px;border-radius:2px;margin-top:14px;transition:all .2s;"
            hover="border-color:var(--gold-ink);color:var(--gold-ink);"
          >
            <span style={css('width:8px;height:8px;border-radius:50%;background:#25D366;')} />
            WhatsApp · replies in under an hour
          </Hover>
          <div style={css('display:flex;gap:8px;margin-top:18px;flex-wrap:wrap;')}>
            {['VISA', 'MASTERCARD', 'AMEX', '3-D SECURE'].map((t) => (
              <span key={t} style={css('border:1px solid var(--line-15);padding:4px 8px;font-size:10px;letter-spacing:.1em;white-space:nowrap;')}>
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div id="footer-bottom" style={css('max-width:1400px;margin:48px auto 0;padding-top:20px;border-top:1px solid var(--line-06);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;position:relative;')}>
        <span>© 2026 Axis Link LLC-FZ. All rights reserved.</span>
        <span>
          Photography via{' '}
          <a href="https://unsplash.com" target="_blank" rel="noopener">
            Unsplash
          </a>{' '}
          · Footage via{' '}
          <a href="https://www.pexels.com" target="_blank" rel="noopener">
            Pexels
          </a>{' '}
          · Dubai · EN / AR
        </span>
      </div>
    </footer>
  )
}

export function MobileDock() {
  const { state: s, actions } = useSite()
  const settings = s.bundle.settings
  const waLink = `https://wa.me/${settings?.whatsapp || '971554855656'}?text=${encodeURIComponent("Hello Axis Journeys — I'd like to speak with a specialist.")}`

  return (
    <div id="mobile-dock" style={css('display:none;position:fixed;left:0;right:0;bottom:0;z-index:55;background:var(--bg-95);backdrop-filter:blur(14px);border-top:1px solid var(--line-1);padding:10px 12px;gap:8px;')}>
      <a href={waLink} target="_blank" rel="noopener" style={css('flex:1;display:flex;align-items:center;justify-content:center;gap:8px;height:48px;border:1px solid var(--line-18);color:var(--ink);font-size:13px;border-radius:2px;')}>
        <span style={css('width:8px;height:8px;border-radius:50%;background:#25D366;')} />
        WhatsApp
      </a>
      <a href={`tel:${settings?.phoneHref || '+971582707625'}`} style={css('flex:1;display:flex;align-items:center;justify-content:center;height:48px;border:1px solid var(--line-18);color:var(--ink);font-size:13px;border-radius:2px;')}>
        Call
      </a>
      <button type="button" onClick={() => actions.openDrawer(null)} style={css('flex:1.3;height:48px;background:#E0B94F;color:#00102F;border:0;font-size:13px;font-weight:600;border-radius:2px;')}>
        Plan journey
      </button>
    </div>
  )
}
