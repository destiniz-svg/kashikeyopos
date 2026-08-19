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
