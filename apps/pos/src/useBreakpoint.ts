import { useEffect, useState } from 'react';

/* The terminal's breakpoint, as the prototype computes it.
 *
 * THE PROTOTYPE DOES THIS IN JAVASCRIPT, NOT IN CSS, and this follows it rather
 * than reinventing it in media queries. The reason is that the breakpoint does
 * not merely restyle the shell — it changes what the shell IS. On a phone the
 * navigation rail stops being a column of the layout and becomes an overlay
 * with a scrim, which is a different tree, not a different width; and a data
 * grid stops being a table and becomes a stack of record cards. A media query
 * can only reach the first of those.
 *
 *   m   < 760    phone       rail is an overlay drawer
 *   t   < 1180   tablet      rail is a 60px icon column
 *   d   ≥ 1180   desktop     rail is a labelled column
 *
 * Those two numbers are the prototype's (`bpOf`), copied exactly.
 */
export type Bp = 'm' | 't' | 'd';

export const bpOf = (w: number): Bp => (w < 760 ? 'm' : w < 1180 ? 't' : 'd');

export function useBreakpoint(): Bp {
  /* Read on the first render rather than in an effect. Starting at a guess and
     correcting after mount makes a phone paint the desktop shell for a frame,
     which is the flash of the wrong layout every till operator would see on
     every load. */
  const [bp, setBp] = useState<Bp>(() =>
    typeof window === 'undefined' ? 'd' : bpOf(window.innerWidth));

  useEffect(() => {
    const onResize = () => setBp((prev) => {
      const next = bpOf(window.innerWidth);
      return next === prev ? prev : next;
    });
    onResize();
    window.addEventListener('resize', onResize);
    /* Rotating a tablet fires `resize` late on some browsers; the orientation
       event is the one that fires at the turn. */
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return bp;
}

/* HEIGHT IS A BREAKPOINT TOO, and the prototype says why in one line: "A
 * 1440-wide window 600px tall passes every width test as desktop and still
 * cannot show a keypad beside a bill, so anything that stacks or scrolls has to
 * consult this as well."
 *
 * That is not an exotic window. It is a 13" laptop with a browser chrome and a
 * dock, and it is a tablet in landscape — the two shapes a back office is
 * actually used on. Every dialog in this build asked only about WIDTH, so on a
 * short screen it kept the desktop's 28px of scrim inset and then had to scroll
 * its own body inside what was left.
 *
 * `shortVp` is the prototype's `shortVp()`: 760, the same number as the phone
 * width breakpoint, applied to the other axis.
 *
 * THE 12px DEADBAND IS THE PROTOTYPE'S AS WELL. A phone's address bar collapses
 * and expands as the page scrolls, which fires `resize` with a height that
 * moves by 40-60px and back. Re-rendering the shell on every one of those is
 * the jank the deadband exists to stop; the state only moves when the change is
 * bigger than the noise.
 */
export const SHORT_VP = 760;

export function useViewportHeight(): number {
  const [vh, setVh] = useState<number>(() =>
    typeof window === 'undefined' ? 900 : window.innerHeight);

  useEffect(() => {
    const onResize = () => setVh((prev) =>
      Math.abs(window.innerHeight - prev) > 12 ? window.innerHeight : prev);
    onResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return vh;
}

/** Too short to put two things side by side, whatever the width says. */
export function useShortViewport(): boolean {
  return useViewportHeight() < SHORT_VP;
}
