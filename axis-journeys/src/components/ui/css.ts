/**
 * Inline CSS declarations, kept as declarations.
 *
 * The prototype's measurements live in `style="…"` attributes — 1,900 of them, every one final.
 * `css()` parses that exact string into a React style object, so the port carries the declaration
 * the designer wrote rather than a hand-transcribed object where a `28px` can become a `24px` and
 * nothing fails. Results are cached by the source string, so a repainted grid parses nothing.
 *
 * Values pass through untouched: `var(--gold-ink)`, `cubic-bezier(.22,1,.36,1)`, `url(…)` and
 * custom properties all survive, because only the first colon of a declaration is a separator.
 */
import type { CSSProperties } from 'react'

const cache = new Map<string, CSSProperties>()

const toCamel = (prop: string): string =>
  prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Split on `;` at paren depth zero: a `data:` URI or a gradient keeps its own semicolons. */
function declarations(src: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      out.push(src.slice(start, i))
      start = i + 1
    }
  }
  out.push(src.slice(start))
  return out
}

export function css(src: string): CSSProperties {
  const hit = cache.get(src)
  if (hit) return hit
  const style: Record<string, string> = {}
  for (const decl of declarations(src)) {
    const trimmed = decl.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon < 1) continue
    style[toCamel(trimmed.slice(0, colon).trim())] = trimmed.slice(colon + 1).trim()
  }
  const frozen = style as CSSProperties
  cache.set(src, frozen)
  return frozen
}

/** Merge a parsed declaration string with overrides that vary per render. */
export const cssWith = (src: string, extra: CSSProperties): CSSProperties => ({ ...css(src), ...extra })
