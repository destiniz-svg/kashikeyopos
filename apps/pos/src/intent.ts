import { useEffect } from 'react';

/* An intent is a job that starts on one screen and finishes on another.
 *
 * The palette's "Do" rows are the reason this exists: "Receive a delivery" has
 * to land on Purchases AND open the GRN form, and the two halves happen in
 * different components on different sides of a navigation. Without a channel
 * between them the palette can only navigate, which is why those rows were left
 * out of the first cut — a row that goes somewhere and then does nothing is
 * worse than an absent row.
 *
 * It is deliberately a ONE-SHOT. The module consumes the intent and clears it
 * on arrival, so re-rendering, coming back to the screen later, or a reload
 * does not re-open the form. An intent that survived would be a form that
 * opened itself every time you visited, and nobody would work out why.
 */
export interface Intent {
  /** The module id — the same id the rail and `view` use. */
  view: string;
  /** What to do on arrival. Each module names its own; see useIntent. */
  act: string;
}

/* Runs `fn` once, when an intent addressed to THIS module arrives, then clears
   it. `fn` is read through a ref-free dependency list on purpose: the effect
   keys on the intent object, which only changes when a new one is dispatched. */
export function useIntent(
  intent: Intent | null | undefined,
  view: string,
  fn: (act: string) => void,
  done: () => void,
) {
  useEffect(() => {
    if (!intent || intent.view !== view) return;
    fn(intent.act);
    done();
    // fn and done are re-created every render by every caller; keying on them
    // would run this on every render, which is exactly what a one-shot must
    // not do. The intent object is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, view]);
}
