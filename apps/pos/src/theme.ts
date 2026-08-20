/* Which palette this terminal wears.
 *
 * TWO BUGS LIVED HERE, and both were invisible because the fix for one hid the
 * other.
 *
 * 1. THE CHOICE WAS APPLIED ONLY WHILE SETTINGS WAS ON SCREEN. The effect that
 *    set `data-theme` lived in the Settings component, so a manager who chose
 *    Light, reloaded, and went to the till got Dark — and the setting still
 *    read "Light", because localStorage had kept it faithfully. It looked like
 *    the toggle did not work. It is applied at boot now (see main.tsx), before
 *    React renders anything.
 *
 * 2. "SYSTEM" DID NOT FOLLOW THE SYSTEM. It removed the attribute, and bare
 *    `:root` in packages/tokens/pos.css is the DARK ramp — there is no
 *    prefers-color-scheme block, deliberately, because §1 of the tokens doc
 *    makes the POS dark-first. So "system" meant "dark" on a machine set to
 *    light, which is the one thing that option promises not to do. It now
 *    resolves the media query itself and keeps listening, so a terminal that
 *    switches at dusk switches with it.
 *
 * THE DEFAULT IS DARK, and stays dark. docs/01-DESIGN-TOKENS.md §1: "The POS is
 * a dense, dark-first operator tool… dark by default, with a light theme under
 * [data-theme='light']. Both must ship; a till by a window needs light mode and
 * a bar at midnight needs dark."
 */

export type Theme = 'system' | 'light' | 'dark';

export const LS_THEME = 'kashikeyo.pos.theme.v1';

/* NOTHING CHOSEN MEANS DARK, not "follow the device".
 *
 * Once "system" actually resolved the media query — which is the fix above —
 * making it the DEFAULT would have inverted the spec: most machines are set to
 * light, so most terminals would have booted light out of the box, and
 * docs/01-DESIGN-TOKENS.md §1 is explicit that the POS is dark-first. So the
 * option is offered and honoured when it is picked; it is not what an outlet
 * gets for never having opened Settings. */
export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(LS_THEME);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
  } catch { return 'dark'; }
}

/** What `theme` actually resolves to right now. */
export function resolve(t: Theme): 'light' | 'dark' {
  if (t === 'light' || t === 'dark') return t;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** Put it on the document. The tokens are custom properties on :root and every
 *  screen reads them from there, so this is the only place that needs to know. */
export function applyTheme(t: Theme, persist = true): void {
  document.documentElement.setAttribute('data-theme', resolve(t));
  if (!persist) return;
  try { localStorage.setItem(LS_THEME, t); } catch { /* private mode */ }
}

/** Start following the OS while the choice is "system". Returns a teardown.
 *  Called once at boot; re-called by whatever changes the setting. */
export function watchSystem(get: () => Theme): () => void {
  let mq: MediaQueryList;
  try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch { return () => {}; }
  const onChange = () => { if (get() === 'system') applyTheme('system', false); };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
