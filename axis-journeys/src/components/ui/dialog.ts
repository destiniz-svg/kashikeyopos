'use client'

/**
 * What a panel has to do to be a dialog, in one place.
 *
 * `role="dialog"` and `aria-modal="true"` are a claim about behaviour, not a decoration: a screen
 * reader stops announcing the page behind the panel because the application has promised that
 * focus is inside it. Making the claim without moving focus is worse than making no claim at all —
 * the reader falls silent about the page while the keyboard is still standing on it.
 *
 * Measured on the property drawer before this existed: focus stayed on the button that opened it,
 * Tab left the panel on the first press in 25 of 25 attempts, and closing left focus wherever it
 * had wandered to. So all three halves live here — move in, keep in, hand back — and every panel
 * that calls itself a dialog uses them.
 */
import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])'

const reachable = (el: HTMLElement): boolean => el.offsetParent !== null || el.getClientRects().length > 0

/**
 * Move focus into `ref` while `open`, keep Tab inside it, and hand focus back to whatever had it
 * when the panel closes.
 *
 * The panel itself needs `tabIndex={-1}`: it is the fallback target for the moment before its
 * contents have painted, and for a panel whose whole body is text.
 */
export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const panel = ref.current
    const returnTo = document.activeElement as HTMLElement | null

    // After paint: the panel slides in, and an element mid-transition is not yet focusable.
    const t = window.setTimeout(() => {
      const el = ref.current
      if (!el) return
      if (el.contains(document.activeElement)) return
      const first = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find(reachable)
      ;(first ?? el).focus({ preventScroll: true })
    }, 60)

    // Capture, so a control inside the panel that handles Tab itself cannot let focus escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const el = ref.current
      if (!el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable)
      if (!items.length) {
        e.preventDefault()
        el.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const here = document.activeElement
      const inside = el.contains(here)
      if (e.shiftKey ? here === first || !inside : here === last || !inside) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', onKey, true)

    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      // Only if focus is still inside the panel that is going away, or a close that already moved
      // focus somewhere deliberate would be overruled.
      const el = ref.current
      const here = document.activeElement as HTMLElement | null
      if (returnTo && document.contains(returnTo) && (!el || !here || el.contains(here) || here === document.body)) {
        returnTo.focus({ preventScroll: true })
      }
    }
  }, [open, ref])
}
