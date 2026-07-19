export const money = (laari: number) => "MVR " + (Math.round(laari) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money0 = (laari: number) => "MVR " + Math.round(laari / 100).toLocaleString("en-US");

export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
export const dayKey = (t: number) => { const d = new Date(t); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };

/* Category tint palette (soft bg, ink) hashed by category string. */
const TINTS: [string, string][] = [
  ["var(--ambersoft)", "var(--amber)"], ["var(--greensoft)", "var(--green)"], ["var(--coralsoft)", "var(--coral)"],
  ["rgba(47,107,224,.14)", "var(--blue)"], ["var(--redsoft)", "var(--red)"], ["var(--sur2)", "var(--ink2)"],
];
export const tintFor = (cat: string): [string, string] => { let h = 0; for (const c of cat || "") h = (h * 31 + c.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length]; };
