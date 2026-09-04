'use client'

/** The CRM: the enquiry list, and the detail panel where a specialist moves it along. */
import { useMemo, useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { api } from '@/lib/admin/client'
import type { Enquiry, EnquiryStatus } from '@/lib/content/types'
import type { Permission } from '@/lib/auth/roles'
import { Button, Empty, FIELD_STYLE, Kicker, Label, PageTitle, Panel } from './ui'
import type { Workspace } from './AdminApp'

const STATUSES: EnquiryStatus[] = ['new', 'contacted', 'quoted', 'won', 'closed']
const TONE: Record<EnquiryStatus, string> = { new: '#E0B94F', contacted: '#8FB4FF', quoted: '#8FB4FF', won: '#6BCB9A', closed: 'var(--muted)' }

const ref = (id: string): string => 'AXJ-' + id.replace(/^q/, '').slice(-6).toUpperCase()

export function Enquiries({
  ws,
  reload,
  say,
  can,
}: {
  ws: Workspace
  reload(): Promise<void>
  say(m: string, tone?: 'ok' | 'err'): void
  can(p: Permission): boolean
}) {
  const [selected, setSelected] = useState<string | null>(ws.enquiries[0]?.id ?? null)
  const [filter, setFilter] = useState<'all' | EnquiryStatus>('all')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => ws.enquiries.filter((e) => filter === 'all' || e.status === filter), [ws.enquiries, filter])
  const current = ws.enquiries.find((e) => e.id === selected) ?? rows[0] ?? null

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true)
    try {
      await api.patchEnquiry(id, body)
      await reload()
      setNote('')
    } catch (e) {
      say((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Kicker>Sales</Kicker>
      <PageTitle>Enquiries</PageTitle>
      <p style={css('font-size:13px;color:var(--muted);margin:10px 0 0;max-width:620px;line-height:1.6;')}>
        Every enquiry from the site, newest first. The assignee is the specialist named on the property the guest was reading.
      </p>

      <div style={css('display:flex;gap:8px;margin-top:20px;flex-wrap:wrap;')}>
        {(['all', ...STATUSES] as const).map((f) => {
          const on = filter === f
          const count = f === 'all' ? ws.enquiries.length : ws.enquiries.filter((e) => e.status === f).length
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(f)}
              style={{
                ...css('padding:8px 14px;font-size:12px;border-radius:999px;min-height:38px;text-transform:capitalize;transition:all .2s;display:flex;gap:8px;align-items:center;'),
                background: on ? 'rgba(224,185,79,.16)' : 'transparent',
                color: on ? '#E0B94F' : 'var(--ink)',
                border: `1px solid ${on ? '#E0B94F' : 'var(--line-14)'}`,
              }}
            >
              {f} <span style={css('color:var(--muted);font-size:11px;')}>{count}</span>
            </button>
          )
        })}
      </div>

      {ws.enquiries.length === 0 ? (
        <div style={css('margin-top:20px;')}>
          <Empty title="No enquiries yet" body="Every enquiry the site takes lands here, with the guest's month, party and budget band, and the property they were reading." />
        </div>
      ) : (
        <div id="enq-grid" style={css('display:grid;grid-template-columns:1fr 420px;gap:16px;margin-top:18px;align-items:start;')}>
          <Panel style={css('padding:0;')}>
            {rows.map((e) => {
              const on = current?.id === e.id
              return (
                <Hover
                  key={e.id}
                  as="button"
                  type="button"
                  onClick={() => setSelected(e.id)}
                  className="enq-row"
                  style={{
                    ...css('width:100%;text-align:left;border:0;border-bottom:1px solid var(--line-06);padding:14px 18px;color:var(--ink);display:grid;grid-template-columns:8px 1fr auto;gap:12px;align-items:center;min-height:64px;transition:background .2s;'),
                    background: on ? 'var(--line-04)' : 'transparent',
                  }}
                  hover="background:var(--line-04);"
                >
                  <span style={{ ...css('width:8px;height:8px;border-radius:50%;'), background: TONE[e.status] }} />
                  <span style={css('min-width:0;')}>
                    <span style={css('display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>
                      {e.name}
                      {e.property ? ` · ${e.property}` : ''}
                    </span>
                    <span style={css('display:block;font-size:12px;color:var(--muted);margin-top:3px;')}>
                      {ref(e.id)} · {e.month || 'no month'} · {e.source}
                    </span>
                  </span>
                  <span style={css('text-align:right;font-size:12px;color:var(--muted);white-space:nowrap;')}>
                    {new Date(e.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </span>
                </Hover>
              )
            })}
          </Panel>

          {current && (
            <Panel id="enq-detail" style={css('position:sticky;top:24px;')}>
              <div style={css('font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-ink);')}>{ref(current.id)}</div>
              <h2 style={css('margin:8px 0 0;font-size:24px;font-weight:400;')}>{current.name}</h2>
              <div style={css('font-size:13px;color:var(--muted);margin-top:6px;')}>
                {new Date(current.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>

              <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px;font-size:13px;')}>
                <Detail label="Email" value={<a href={`mailto:${current.email}`}>{current.email}</a>} />
                <Detail label="Phone" value={current.phone ? <a href={`https://wa.me/${current.phone.replace(/\D/g, '')}`} target="_blank" rel="noopener">{current.phone}</a> : '—'} />
                <Detail label="Month" value={current.month || '—'} />
                <Detail label="Travelling as" value={current.party || '—'} />
                <Detail label="Budget" value={current.budget || '—'} />
                <Detail label="Source" value={current.source} />
                {current.property && <Detail label="Property" value={current.property} span />}
                {current.offer && <Detail label="Offer" value={current.offer} span />}
                {current.shortlist.length > 0 && <Detail label="Shortlist" value={current.shortlist.join(', ')} span />}
              </div>

              {current.message && (
                <div style={css('margin-top:16px;padding:14px;background:var(--field);border-radius:3px;font-size:13px;line-height:1.6;white-space:pre-wrap;')}>{current.message}</div>
              )}

              <div style={css('margin-top:18px;')}>
                <Label>Status</Label>
                <div style={css('display:flex;gap:6px;flex-wrap:wrap;')}>
                  {STATUSES.map((s) => {
                    const on = current.status === s
                    return (
                      <button
                        key={s}
                        type="button"
                        disabled={busy}
                        onClick={() => void patch(current.id, { status: s })}
                        style={{
                          ...css('padding:7px 12px;font-size:12px;border-radius:999px;min-height:34px;text-transform:capitalize;transition:all .2s;'),
                          background: on ? 'rgba(224,185,79,.16)' : 'transparent',
                          color: on ? '#E0B94F' : 'var(--ink)',
                          border: `1px solid ${on ? '#E0B94F' : 'var(--line-14)'}`,
                        }}
                      >
                        {s}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={css('margin-top:16px;')}>
                <Label>Assigned to</Label>
                <select value={current.assignedTo} disabled={busy} onChange={(e) => void patch(current.id, { assignedTo: e.target.value })} style={css(FIELD_STYLE)}>
                  {[...new Set([current.assignedTo, ...ws.lists.SPECIALISTS, ...ws.users.map((u) => u.name)])].filter(Boolean).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div style={css('margin-top:16px;')}>
                <Label>Notes</Label>
                {(current.notes || []).map((n, i) => (
                  <div key={i} style={css('padding:10px 0;border-top:1px solid var(--line-06);font-size:13px;line-height:1.55;')}>
                    <span style={css('color:var(--gold-ink);')}>{n.by}</span>{' '}
                    <span style={css('color:var(--muted);font-size:11px;')}>{new Date(n.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                    <div>{n.text}</div>
                  </div>
                ))}
                <textarea rows={2} value={note} placeholder="Add a note…" onChange={(e) => setNote(e.target.value)} style={{ ...css(FIELD_STYLE), marginTop: 8 }} />
                <div style={css('display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;')}>
                  <Button onClick={() => note.trim() && void patch(current.id, { note })} disabled={busy || !note.trim()}>
                    Add note
                  </Button>
                  {can('delete') && (
                    <Button
                      tone="danger"
                      disabled={busy}
                      onClick={async () => {
                        if (!confirm('Delete this enquiry? The guest is not told.')) return
                        try {
                          await api.deleteEnquiry(current.id)
                          setSelected(null)
                          await reload()
                        } catch (e) {
                          say((e as Error).message, 'err')
                        }
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}
    </>
  )
}

function Detail({ label, value, span }: { label: string; value: React.ReactNode; span?: boolean }) {
  return (
    <div style={span ? css('grid-column:1/-1;') : undefined}>
      <div style={css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);')}>{label}</div>
      <div style={css('margin-top:4px;word-break:break-word;')}>{value}</div>
    </div>
  )
}
