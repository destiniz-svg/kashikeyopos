'use client'

/**
 * What the standard said, drawn where somebody can act on it.
 *
 * Deliberately not a toast. A toast is gone in four seconds and the next one overwrites it, which
 * is the wrong shape for "this photograph is below standard and here is why" — that is something
 * an editor reads, decides about, and may want to still be on screen while they go and find the
 * original file. It sits in the panel, and it stays.
 */
import type { Finding } from '@/lib/media/standards'
import { css } from '@/components/ui/css'

const TONE = {
  refuse: { ink: '#E07A6B', edge: 'rgba(224,122,107,.4)', wash: 'rgba(224,122,107,.08)', word: 'Not accepted' },
  warn: { ink: '#E0B94F', edge: 'rgba(224,185,79,.4)', wash: 'rgba(224,185,79,.07)', word: 'Below standard' },
} as const

export function StandardReport({ findings, title }: { findings: Finding[]; title?: string }) {
  if (!findings.length) return null
  const worst = findings.some((f) => f.level === 'refuse') ? 'refuse' : 'warn'
  const tone = TONE[worst]
  return (
    <div
      role="status"
      style={{
        ...css('border-radius:3px;padding:12px 14px;font-size:12px;line-height:1.6;'),
        border: `1px solid ${tone.edge}`,
        background: tone.wash,
      }}
    >
      <div style={{ ...css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;'), color: tone.ink }}>
        {title ? `${title} · ${tone.word}` : tone.word}
      </div>
      <ul style={css('margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;')}>
        {findings.map((f, i) => (
          <li key={`${f.code}-${i}`} style={css('display:flex;gap:8px;color:var(--soft);')}>
            <span aria-hidden="true" style={{ ...css('flex-shrink:0;margin-top:6px;width:4px;height:4px;border-radius:50%;'), background: TONE[f.level].ink }} />
            <span>{f.says}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The same list, for a file that was refused before it ever reached the library. */
export interface Rejected { name: string; findings: Finding[] }

export function RejectedList({ items, onClear }: { items: Rejected[]; onClear(): void }) {
  if (!items.length) return null
  return (
    <div style={css('margin-top:16px;display:flex;flex-direction:column;gap:10px;')}>
      {items.map((r, i) => (
        <StandardReport key={`${r.name}-${i}`} title={r.name} findings={r.findings} />
      ))}
      <button
        type="button"
        onClick={onClear}
        style={css('align-self:flex-start;background:none;border:0;color:var(--muted);font-size:12px;padding:4px 0;text-decoration:underline;')}
      >
        Clear these notes
      </button>
    </div>
  )
}
