'use client'

/**
 * The CMS's shared shapes: the panel, the buttons, the status pill and the toast.
 *
 * The measurements are the prototype's. Axis Studio is dark-first with the same token table as the
 * site plus `--field` for inputs; it is a different application in one visual language.
 */
import type { CSSProperties, ReactNode } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'

export function Panel({ children, style, id }: { children: ReactNode; style?: CSSProperties; id?: string }) {
  return (
    <div id={id} style={{ ...css('background:var(--panel);border:1px solid var(--line-08);border-radius:4px;padding:20px;'), ...style }}>
      {children}
    </div>
  )
}

export function Kicker({ children }: { children: ReactNode }) {
  return <div style={css('font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--gold-ink);')}>{children}</div>
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 style={css('font-weight:300;font-size:34px;line-height:1.1;margin:8px 0 0;letter-spacing:-.01em;')}>{children}</h1>
}

export const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  published: { bg: 'rgba(107,203,154,.14)', fg: '#6BCB9A' },
  changed: { bg: 'rgba(224,185,79,.16)', fg: '#E0B94F' },
  draft: { bg: 'rgba(154,168,191,.14)', fg: 'var(--muted)' },
}

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.draft
  return (
    <span style={{ ...css('font-size:10px;letter-spacing:.16em;text-transform:uppercase;padding:5px 9px;border-radius:999px;white-space:nowrap;'), background: tone.bg, color: tone.fg }}>
      {status}
    </span>
  )
}

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  disabled?: boolean
  tone?: 'gold' | 'plain' | 'danger'
  style?: string
  title?: string
}

export function Button({ children, onClick, type = 'button', disabled, tone = 'plain', style = '', title }: ButtonProps) {
  const base =
    tone === 'gold'
      ? 'background:#E0B94F;color:#00102F;border:0;font-weight:600;'
      : tone === 'danger'
        ? 'background:none;color:#E07A6B;border:1px solid rgba(224,122,107,.4);'
        : 'background:none;color:var(--ink);border:1px solid var(--line-16);'
  const hover = tone === 'gold' ? 'background:#EBCB72;' : tone === 'danger' ? 'border-color:#E07A6B;' : 'border-color:var(--gold-ink);color:var(--gold-ink);'
  return (
    <Hover
      as="button"
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={`${base}padding:10px 16px;font-size:13px;border-radius:3px;min-height:40px;transition:all .2s;${disabled ? 'opacity:.5;cursor:default;' : ''}${style}`}
      hover={disabled ? '' : hover}
    >
      {children}
    </Hover>
  )
}

export function Toast({ message, tone = 'ok' }: { message: string | null; tone?: 'ok' | 'err' }) {
  if (!message) return null
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...css('position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:200;padding:12px 18px;border-radius:3px;font-size:13px;box-shadow:0 20px 50px rgba(0,0,0,.5);animation:toastIn .3s ease;max-width:min(560px,92vw);'),
        background: tone === 'err' ? '#E07A6B' : 'var(--gold-ink)',
        color: '#00102F',
      }}
    >
      {message}
    </div>
  )
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div style={css('padding:56px 32px;border:1px dashed var(--line-14);border-radius:4px;text-align:center;color:var(--muted);')}>
      <div style={css('font-size:22px;font-weight:300;color:var(--ink);')}>{title}</div>
      <p style={css('margin:10px auto 18px;font-size:13px;line-height:1.6;max-width:460px;')}>{body}</p>
      {action}
    </div>
  )
}

export const FIELD_STYLE =
  'width:100%;background:var(--field);border:1px solid var(--line-14);color:var(--ink);padding:11px 12px;font-size:14px;border-radius:3px;min-height:42px;'

export function Label({ children, hint, required }: { children: ReactNode; hint?: string; required?: boolean }) {
  return (
    <div style={css('display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:6px;')}>
      <span style={css('font-size:12px;color:var(--muted);')}>
        {children}
        {required && <span style={css('color:var(--gold-ink);')}> *</span>}
      </span>
      {hint && <span style={css('font-size:11px;color:var(--line-3);')}>{hint}</span>}
    </div>
  )
}
