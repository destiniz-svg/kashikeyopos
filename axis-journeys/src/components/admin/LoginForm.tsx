'use client'

/**
 * Sign in.
 *
 * The refusal is one sentence and it is the same whether the address is unknown or the password is
 * wrong — a door that answers differently is a door that enumerates the team. Rate limiting and the
 * timing-equal comparison are on the server; this screen only has to not undo them.
 */
import { useState } from 'react'
import { css } from '@/components/ui/css'
import { api } from '@/lib/admin/client'
import { Button, FIELD_STYLE, Label } from './ui'

export function LoginForm({ ownerConfigured }: { ownerConfigured: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(email, password)
      window.location.href = '/admin'
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <main style={css('min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--ink);')}>
      <form onSubmit={submit} style={css('width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line-08);border-radius:4px;padding:32px;')}>
        <div style={css('display:flex;align-items:center;gap:12px;margin-bottom:26px;')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logomark-white.png" alt="" width={27} height={32} className="logo-dark" style={css('height:32px;width:auto;')} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logomark.png" alt="" width={27} height={32} className="logo-light" style={css('height:32px;width:auto;display:none;')} />
          <span style={css('display:flex;flex-direction:column;gap:3px;')}>
            <span style={css('font-weight:500;font-size:16px;letter-spacing:.3em;line-height:1;')}>AXIS</span>
            <span style={css('font-weight:400;font-size:9px;letter-spacing:.34em;line-height:1;color:var(--gold-ink);')}>STUDIO</span>
          </span>
        </div>

        <h1 style={css('margin:0 0 6px;font-size:26px;font-weight:300;')}>Sign in</h1>
        <p style={css('margin:0 0 22px;font-size:13px;color:var(--muted);line-height:1.6;')}>
          {ownerConfigured ? 'Use the address the workspace was set up with.' : 'No owner account exists yet — run the seeding step with ADMIN_OWNER_EMAIL and ADMIN_OWNER_PASSWORD set.'}
        </p>

        <div style={css('display:flex;flex-direction:column;gap:14px;')}>
          <div>
            <Label>Email</Label>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} style={css(FIELD_STYLE)} />
          </div>
          <div>
            <Label>Password</Label>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={css(FIELD_STYLE)} />
          </div>
          {error && (
            <div role="alert" style={css('font-size:13px;color:#E07A6B;line-height:1.5;')}>
              {error}
            </div>
          )}
          <Button type="submit" tone="gold" disabled={busy} style="width:100%;justify-content:center;">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>

        <a href="/" style={css('display:block;margin-top:20px;font-size:12px;color:var(--muted);')}>
          ← Back to the site
        </a>
      </form>
    </main>
  )
}
