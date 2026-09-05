'use client'

/**
 * One answer to "does this visitor want motion".
 *
 * The CSS side of reduced motion is already settled in `globals.css` — every keyframe and every
 * transition is switched off under `prefers-reduced-motion: reduce`, measured at 12 running
 * animations normally and 0 under reduce. What CSS cannot reach is motion this application asks
 * for in JavaScript: a `scrollTo` with `behavior:'smooth'` animates whatever the media query says,
 * and a `<video autoplay loop>` keeps playing.
 *
 * So both are read from here rather than from four call sites that would drift apart. On the
 * server, and in a browser too old to answer, the answer is "no preference" — the same default the
 * media query itself has.
 */

import { useEffect, type RefObject } from 'react'

/** True when the visitor has asked their system for less motion. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The scroll behaviour to hand `scrollTo` / `scrollIntoView`.
 *
 * `'auto'` is an instant jump, which is the point: the destination is still reached, so nothing
 * about the flow changes — only the travelling.
 */
export const scrollBehaviour = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth')

/**
 * An ambient background clip: muted, looping, decorative, and playing only where motion is welcome.
 *
 * Three sections carry one — the hero, a destination hero and the About bento — and each used to
 * decide for itself. Two of them asked for playback with an `autoplay` attribute, which starts the
 * clip before any script can read the visitor's preference, and the third had no retry for a
 * browser that waits for a gesture. This is the one decision, so a fourth cannot arrive with a
 * fourth answer.
 *
 * The element keeps its `poster`, so what a visitor who wants stillness sees is the photograph the
 * design already puts there — nothing is missing, only the movement.
 */
export function useAmbientPlayback(ref: RefObject<HTMLVideoElement | null>, src: string | null | undefined): void {
  useEffect(() => {
    const v = ref.current
    if (!v || !src) return
    v.muted = true
    v.defaultMuted = true
    if (prefersReducedMotion()) {
      v.pause()
      return
    }

    const play = () => {
      const p = v.play()
      if (p && typeof p.catch === 'function') p.catch(() => undefined)
    }
    // A browser that will not autoplay until it has seen a gesture gets one chance per gesture.
    const events: (keyof WindowEventMap)[] = ['touchstart', 'pointerdown', 'keydown', 'scroll']
    let watching = false
    const listen = (on: boolean) => {
      if (on === watching) return
      watching = on
      events.forEach((t) => (on ? window.addEventListener(t, play, { passive: true }) : window.removeEventListener(t, play)))
    }

    // Only while it is on the screen. `play()` overrides `preload="none"`, so a clip that starts on
    // mount is downloaded whether or not anybody scrolls to it — measured at 3.1 MB fetched on a
    // phone for the About bento, which sits eight screens down. Decoding a video nobody is looking
    // at is the same waste in battery.
    if (typeof IntersectionObserver !== 'function') {
      play()
      listen(true)
      return () => listen(false)
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          play()
          listen(true)
        } else {
          v.pause()
          listen(false)
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(v)
    return () => {
      io.disconnect()
      listen(false)
    }
  }, [ref, src])
}
