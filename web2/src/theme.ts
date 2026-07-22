// Design tokens lifted verbatim from the prototype (KashikeyoPOS.dc.html helmet).
// Light "coral" palette + a dark variant. Applied as CSS variables on :root so
// every screen styles with inline styles + var() exactly like the prototype.
export type Palette = Record<string, string>

export const light: Palette = {
  bg: '#FEFEFE', sur: '#FFFFFF', sur2: 'rgba(38,41,48,.05)',
  ink: '#262930', ink2: '#6C6F77', ink3: '#A2A4AB', line: 'rgba(38,41,48,.11)',
  coral: '#EE8C21', coralink: '#FFFFFF', coralsoft: 'rgba(238,140,33,.13)',
  green: '#1FA65C', greensoft: 'rgba(31,166,92,.12)',
  amber: '#D98A1C', ambersoft: 'rgba(238,140,33,.14)',
  red: '#C13A26', redsoft: 'rgba(193,58,38,.11)',
}

export const dark: Palette = {
  bg: '#0F1712', sur: '#16211A', sur2: 'rgba(220,255,235,.05)',
  ink: '#E4F0E8', ink2: '#94A89C', ink3: '#647468', line: 'rgba(220,255,235,.09)',
  coral: '#57C486', coralink: '#08210F', coralsoft: 'rgba(87,196,134,.15)',
  green: '#57C486', greensoft: 'rgba(87,196,134,.13)',
  amber: '#D7A24A', ambersoft: 'rgba(215,162,74,.13)',
  red: '#E27A5E', redsoft: 'rgba(226,122,94,.15)',
}

export function applyTheme(dark_ = false) {
  const p = dark_ ? dark : light
  const r = document.documentElement
  for (const k in p) r.style.setProperty('--' + k, p[k])
  r.style.setProperty('color-scheme', dark_ ? 'dark' : 'light')
}
