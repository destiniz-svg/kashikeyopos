'use client'

/** The CMS sidebar: the eight views, the live-site link, the theme toggle and the signed-in user. */
import { useEffect, useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { api, type SessionUser } from '@/lib/admin/client'
import type { Permission } from '@/lib/auth/roles'
import type { View } from './AdminApp'

const NAV: { view: View; label: string; need?: Permission }[] = [
  { view: 'dashboard', label: 'Dashboard' },
  { view: 'properties', label: 'Properties' },
  { view: 'offers', label: 'Offers' },
  { view: 'destinations', label: 'Destinations' },
  { view: 'homepage', label: 'Homepage' },
  { view: 'enquiries', label: 'Enquiries', need: 'enquiries' },
  { view: 'media', label: 'Media', need: 'media' },
  { view: 'settings', label: 'Settings', need: 'settings' },
  { view: 'team', label: 'Team', need: 'users' },
]

const href = (v: View) => (v === 'dashboard' ? '/admin' : `/admin/${v}`)

export function Sidebar({
  user,
  view,
  newEnquiries,
  can,
  go,
  say,
}: {
  user: SessionUser
  view: View
  newEnquiries: number
  can(p: Permission): boolean
  go(path: string): void
  say(m: string, tone?: 'ok' | 'err'): void
}) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    try {
      setTheme(localStorage.getItem('axis.theme') === 'light' ? 'light' : 'dark')
    } catch {
      setTheme('dark')
    }
  }, [])

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('axis.theme', next)
    } catch {
      /* a browser with storage blocked keeps the choice for this session */
    }
  }

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <aside id="sidebar" style={css('background:var(--bg-deep);border-right:1px solid var(--line-06);display:flex;flex-direction:column;justify-content:space-between;position:sticky;top:0;height:100vh;')}>
      <div>
        <div style={css('display:flex;align-items:center;gap:12px;padding:22px 20px;border-bottom:1px solid var(--line-06);')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logomark-white.png" alt="" width={27} height={32} className="logo-dark" style={css('height:32px;width:auto;')} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logomark.png" alt="" width={27} height={32} className="logo-light" style={css('height:32px;width:auto;display:none;')} />
          <span style={css('display:flex;flex-direction:column;gap:3px;')}>
            <span style={css('font-weight:500;font-size:16px;letter-spacing:.3em;line-height:1;')}>AXIS</span>
            <span style={css('font-weight:400;font-size:9px;letter-spacing:.34em;line-height:1;color:var(--gold-ink);')}>STUDIO</span>
          </span>
        </div>

        <nav style={css('padding:14px 12px;display:flex;flex-direction:column;gap:2px;')} aria-label="Sections">
          {NAV.filter((n) => !n.need || can(n.need)).map((n) => {
            const active = view === n.view
            return (
              <Hover
                key={n.view}
                as="button"
                type="button"
                onClick={() => go(href(n.view))}
                aria-current={active ? 'page' : undefined}
                style={{
                  ...css('display:flex;align-items:center;gap:10px;text-align:left;border:0;padding:11px 14px;font-size:14px;border-radius:3px;min-height:42px;transition:all .2s;width:100%;'),
                  background: active ? 'var(--panel)' : 'transparent',
                  color: active ? 'var(--gold-ink)' : 'var(--ink)',
                }}
                hover="color:var(--gold-ink);"
              >
                <span style={{ ...css('width:6px;height:6px;border-radius:50%;flex:none;'), background: active ? '#E0B94F' : 'transparent' }} />
                <span style={css('flex:1;')}>{n.label}</span>
                {n.view === 'enquiries' && newEnquiries > 0 && (
                  <span style={css('background:#E0B94F;color:#00102F;font-size:11px;font-weight:600;min-width:20px;height:20px;border-radius:999px;display:flex;align-items:center;justify-content:center;padding:0 6px;')}>
                    {newEnquiries}
                  </span>
                )}
              </Hover>
            )
          })}
        </nav>
      </div>

      <div style={css('border-top:1px solid var(--line-06);padding:18px 20px;display:flex;flex-direction:column;gap:14px;')}>
        <a href="/" target="_blank" rel="noopener" style={css('font-size:13px;color:var(--ink);')}>
          View live site ↗
        </a>
        <button type="button" onClick={toggleTheme} style={css('background:none;border:0;padding:0;text-align:left;color:var(--ink);font-size:13px;')}>
          {theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
        <div style={css('display:flex;align-items:center;gap:10px;')}>
          <span style={css('width:32px;height:32px;border-radius:50%;background:var(--panel);color:var(--gold-ink);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex:none;')}>{initials}</span>
          <span style={css('flex:1;min-width:0;')}>
            <span style={css('display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{user.name}</span>
            <span style={css('display:block;font-size:11px;color:var(--muted);text-transform:capitalize;')}>{user.role}</span>
          </span>
          <button
            type="button"
            onClick={async () => {
              try {
                await api.logout()
                window.location.href = '/admin/login'
              } catch {
                say('Could not sign out — try again', 'err')
              }
            }}
            style={css('background:none;border:0;color:var(--muted);font-size:12px;padding:6px;')}
            title="Signs this account out on every device"
          >
            Out
          </button>
        </div>
      </div>
    </aside>
  )
}
