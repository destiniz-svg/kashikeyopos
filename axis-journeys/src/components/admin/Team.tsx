'use client'

/**
 * The team screen: who has access, at what role, and the two removals that are refused because
 * they would end in a workspace nobody can sign in to.
 */
import { useState } from 'react'
import { css } from '@/components/ui/css'
import { api } from '@/lib/admin/client'
import { ROLES, ROLE_KEYS, type Role } from '@/lib/auth/roles'
import { Button, FIELD_STYLE, Kicker, Label, PageTitle, Panel } from './ui'
import type { Workspace } from './AdminApp'

export function Team({ ws, reload, say }: { ws: Workspace; reload(): Promise<void>; say(m: string, tone?: 'ok' | 'err'): void }) {
  const [form, setForm] = useState<{ name: string; email: string; role: Role; password: string }>({ name: '', email: '', role: 'editor', password: '' })
  const [busy, setBusy] = useState(false)

  const invite = async () => {
    setBusy(true)
    try {
      await api.createUser({ name: form.name, email: form.email, role: form.role, ...(form.password ? { password: form.password } : {}) })
      setForm({ name: '', email: '', role: 'editor', password: '' })
      await reload()
      say(form.password ? 'Account created' : 'Account created — set a password before they can sign in')
    } catch (e) {
      say((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Kicker>Access</Kicker>
      <PageTitle>Team</PageTitle>
      <p style={css('font-size:13px;color:var(--muted);margin:10px 0 0;max-width:620px;line-height:1.6;')}>
        The role is the gate: it is checked on every request, not only on the screen. An account with no password exists and cannot sign in until one is set.
      </p>

      <div id="users-grid" style={css('display:grid;grid-template-columns:1fr 340px;gap:16px;margin-top:20px;align-items:start;')}>
        <Panel style={css('padding:0;')}>
          {ws.users.map((u) => (
            <div key={u.id} style={css('display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line-06);')}>
              <div style={css('min-width:0;')}>
                <div style={css('font-size:14px;')}>
                  {u.name}
                  {u.invited && <span style={css('font-size:11px;color:var(--gold-ink);margin-left:8px;')}>no password yet</span>}
                </div>
                <div style={css('font-size:12px;color:var(--muted);margin-top:3px;')}>{u.email}</div>
              </div>
              <select
                value={u.role}
                onChange={async (e) => {
                  try {
                    await api.patchUser(u.id, { role: e.target.value })
                    await reload()
                  } catch (err) {
                    say((err as Error).message, 'err')
                  }
                }}
                style={{ ...css(FIELD_STYLE), width: 150 }}
              >
                {ROLE_KEYS.map((r) => (
                  <option key={r} value={r}>
                    {ROLES[r].label}
                  </option>
                ))}
              </select>
              <Button
                tone="danger"
                onClick={async () => {
                  if (!confirm(`Remove ${u.name}? They lose access at once.`)) return
                  try {
                    await api.deleteUser(u.id)
                    await reload()
                  } catch (err) {
                    say((err as Error).message, 'err')
                  }
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </Panel>

        <Panel>
          <h2 style={css('margin:0 0 4px;font-size:18px;font-weight:400;')}>Add someone</h2>
          <p style={css('font-size:12px;color:var(--muted);margin:0 0 16px;line-height:1.6;')}>
            {ROLES.owner.label}: everything · {ROLES.editor.label}: write and publish · {ROLES.contributor.label}: draft and media · {ROLES.sales.label}: enquiries only
          </p>
          <div style={css('display:flex;flex-direction:column;gap:12px;')}>
            <div>
              <Label required>Name</Label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={css(FIELD_STYLE)} />
            </div>
            <div>
              <Label required>Email</Label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={css(FIELD_STYLE)} />
            </div>
            <div>
              <Label>Role</Label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} style={css(FIELD_STYLE)}>
                {ROLE_KEYS.map((r) => (
                  <option key={r} value={r}>
                    {ROLES[r].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label hint="12 characters or more">Password</Label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" style={css(FIELD_STYLE)} />
            </div>
            <Button tone="gold" onClick={() => void invite()} disabled={busy || !form.name || !form.email}>
              Add to the team
            </Button>
          </div>
        </Panel>
      </div>
    </>
  )
}
