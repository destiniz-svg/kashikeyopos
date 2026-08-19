/* Guest-portal design tokens.
 *
 * Every value is a literal from docs/01-DESIGN-TOKENS.md §2 and §3.2, which
 * says of this palette: "Flat literals, no custom properties. The portals are
 * single-purpose and light." So these are constants, not CSS variables — the
 * prototype writes them inline and the ported screens do the same.
 *
 * They live in one file so a screen never types `#f4553c` from memory and lands
 * on `#f4553d`. Naming follows the token doc's own names.
 */

export const C = {
  accent: '#f4553c',
  accentDeep: '#c2321c',
  accentGradient: 'linear-gradient(150deg,#f4553c,#c2321c)',
  accentShadow: '0 8px 22px rgba(244,85,60,.32)',
  accentHover: '#d33d26',

  appBg: '#1b0d0a',
  surface: '#ffffff',
  surfaceSoft: '#fafafb',
  surfaceTint: '#f5f5f6',
  hairline: '#e8e8ea',
  hairlineSoft: '#f0f0f0',

  ink: '#1a1a1a',
  inkStrong: '#111111',
  inkMid: '#4a4a4f',
  inkSoft: '#6a6a70',
  inkMuted: '#8a8a8f',
  inkFaint: '#9c9ca1',
  inkGhost: '#a8a8ad',
  label: '#b0b0b5',
  disabled: '#c8c8cc',
  disabledDeep: '#dcdce0',

  success: '#2ea44f',
  warnBg: '#fff8f0',
  warnBorder: '#f2ddc6',
  warnInk: '#8a5a12',
  warnInkSoft: '#96702e',
  danger: '#c2452f',
} as const;

/* §3: "Every monetary figure, receipt number, table label, time, quantity and
   code is set in JetBrains Mono. Prose is Instrument Sans. There is no third
   case." MONO is that second case, spelled once. */
export const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace";

/* §4.3 Hit targets. Named rather than sprinkled, because a 44 that should have
   been a 46 is invisible in review and obvious under a thumb. */
export const HIT = {
  row: 46,        // every tappable row
  input: 50,      // 50-52 on inputs
  primary: 52,    // primary buttons, ~15px padding
  tableTile: 46,  // table picker tiles, min-height
} as const;

/* §7: money renders as `MVR 1,234.56` in full and `1,234.56` in dense tables.
   Both take integer LAARI, because that is what the API and packages/money
   speak; a component that formats a float has already lost a laari somewhere. */
export const MVR = (laari: number): string =>
  'MVR ' + (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const MVRc = (laari: number): string =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
