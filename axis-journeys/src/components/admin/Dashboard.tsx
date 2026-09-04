'use client'

/**
 * The dashboard: four counted tiles, what needs attention, and the activity feed.
 *
 * Every figure is measured off the workspace in hand. There are no illustrative numbers here — a
 * count that is not counted is the one thing a dashboard must never carry.
 */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { Kicker, PageTitle, Panel, StatusPill } from './ui'
import type { Permission } from '@/lib/auth/roles'
import type { Workspace } from './AdminApp'

const ago = (at: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

const greeting = (): string => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function Dashboard({ ws, go, can }: { ws: Workspace; go(path: string): void; can(p: Permission): boolean }) {
  const properties = ws.cols.properties
  const offers = ws.cols.offers
  const live = properties.filter((d) => d.status !== 'draft').length
  const liveOffers = offers.filter((d) => d.status !== 'draft').length
  const newEnquiries = ws.enquiries.filter((e) => e.status === 'new').length
  const changed = [...properties, ...offers, ...ws.cols.destinations, ...ws.cols.homepage, ...ws.cols.settings]
  const edited = changed.filter((d) => d.status === 'changed').length
  const drafts = changed.filter((d) => d.status === 'draft').length

  const attention: { kind: string; label: string; note: string; go: () => void }[] = [
    ...ws.enquiries
      .filter((e) => e.status === 'new')
      .slice(0, 6)
      .map((e) => ({ kind: 'Enquiry', label: `${e.name}${e.property ? ' · ' + e.property : ''}`, note: ago(e.createdAt), go: () => go('/admin/enquiries') })),
    ...properties
      .filter((d) => d.status === 'draft')
      .slice(0, 12)
      .map((d) => ({ kind: 'Draft', label: String((d.draft as { name?: string }).name || d.id), note: 'Never published', go: () => go(`/admin/properties/${d.id}`) })),
  ]

  return (
    <>
      <Kicker>Dashboard</Kicker>
      <PageTitle>{greeting()}, {ws.user.name.split(' ')[0]}.</PageTitle>

      <div id="stats-grid" style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:24px;')}>
        <Stat label="Properties" value={properties.length} note={`${live} live`} onClick={() => go('/admin/properties')} />
        <Stat label="Offers" value={offers.length} note={`${liveOffers} live`} onClick={() => go('/admin/offers')} />
        <Stat label="New enquiries" value={newEnquiries} note={newEnquiries ? 'Waiting for a reply' : 'Nothing waiting'} onClick={can('enquiries') ? () => go('/admin/enquiries') : undefined} />
        <Stat label="Unpublished changes" value={edited + drafts} note={`${edited} edited · ${drafts} drafts`} />
      </div>

      <div id="dash-cols" style={css('display:grid;grid-template-columns:1.2fr .8fr;gap:16px;margin-top:20px;')}>
        <Panel style={css('padding:0;')}>
          <div style={css('display:flex;justify-content:space-between;align-items:baseline;padding:18px 20px;border-bottom:1px solid var(--line-06);')}>
            <h2 style={css('margin:0;font-size:18px;font-weight:400;')}>Needs attention</h2>
            <span style={css('font-size:12px;color:var(--muted);')}>{attention.length} items</span>
          </div>
          {attention.length === 0 ? (
            <div style={css('padding:32px 20px;color:var(--muted);font-size:13px;')}>Nothing is waiting. Every document is published and every enquiry has been picked up.</div>
          ) : (
            attention.map((a, i) => (
              <Hover
                key={`${a.kind}-${a.label}-${i}`}
                as="button"
                type="button"
                onClick={a.go}
                style="display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line-06);padding:14px 20px;color:var(--ink);min-height:52px;"
                hover="background:var(--line-04);"
              >
                <span style={css('font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line-12);border-radius:999px;padding:4px 9px;')}>{a.kind}</span>
                <span style={css('font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{a.label}</span>
                <span style={css('font-size:12px;color:var(--muted);white-space:nowrap;')}>{a.note}</span>
              </Hover>
            ))
          )}
        </Panel>

        <div style={css('display:flex;flex-direction:column;gap:16px;')}>
          <Panel>
            <h2 style={css('margin:0 0 14px;font-size:18px;font-weight:400;')}>Getting started</h2>
            <Step done={ws.media.length > 0} title="Replace the stand-in photography" body="Upload your own images to the Media library, then pick them on each property." />
            <Step done={!!(ws.cols.settings[0]?.draft as { phone?: string })?.phone} title="Check contact details" body="Phone, WhatsApp and email appear across the site." />
            <Step done={liveOffers > 0} title="Publish your first offer" body="Offers are the only rates guests see." />
            <Step done={ws.users.length > 1} title="Invite the team" body="Editors publish; contributors draft; sales sees enquiries." />
          </Panel>

          <Panel>
            <h2 style={css('margin:0 0 8px;font-size:18px;font-weight:400;')}>Activity</h2>
            {ws.activity.length === 0 ? (
              <div style={css('color:var(--muted);font-size:13px;padding:8px 0;')}>Nothing recorded yet.</div>
            ) : (
              ws.activity.slice(0, 10).map((e) => (
                <div key={e.id} style={css('display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line-06);font-size:13px;')}>
                  <span style={css('min-width:0;')}>
                    <span style={css('color:var(--gold-ink);')}>{e.by}</span> · {e.what}
                  </span>
                  <span style={css('color:var(--muted);white-space:nowrap;font-size:12px;')}>{ago(e.at)}</span>
                </div>
              ))
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

function Stat({ label, value, note, onClick }: { label: string; value: number; note: string; onClick?: () => void }) {
  const inner = (
    <>
      <div style={css('font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);')}>{label}</div>
      <div style={css('font-size:38px;font-weight:300;line-height:1;margin:12px 0 8px;')}>{value}</div>
      <div style={css('font-size:12px;color:var(--gold-ink);')}>{note}</div>
    </>
  )
  if (!onClick) return <Panel>{inner}</Panel>
  return (
    <Hover
      as="button"
      type="button"
      onClick={onClick}
      style="background:var(--panel);border:1px solid var(--line-08);border-radius:4px;padding:20px;text-align:left;color:var(--ink);transition:border-color .2s;"
      hover="border-color:var(--gold-ink);"
    >
      {inner}
    </Hover>
  )
}

function Step({ done, title, body }: { done: boolean; title: string; body: string }) {
  return (
    <div style={css('display:grid;grid-template-columns:auto 1fr;gap:12px;padding:9px 0;align-items:start;')}>
      <span
        style={{
          ...css('width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:2px;'),
          background: done ? 'rgba(107,203,154,.2)' : 'transparent',
          color: done ? '#6BCB9A' : 'var(--muted)',
          border: `1px solid ${done ? 'rgba(107,203,154,.5)' : 'var(--line-16)'}`,
        }}
      >
        {done ? '✓' : ''}
      </span>
      <span>
        <span style={css('display:block;font-size:13px;')}>{title}</span>
        <span style={css('display:block;font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5;')}>{body}</span>
      </span>
    </div>
  )
}

export { StatusPill }
