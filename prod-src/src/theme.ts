/* Production's theme system, ported verbatim from the deployed bundle's
   window.__kpal helper. A store picks one of five brand palettes; each maps to
   a `kt-<palette>-<l|d>` class that drives the --k-* CSS variables (see
   index.css), plus the ksh-* semantic classes the components consume through
   the returned `_` object. Chart colors (axis/bar/grid/tipBg) are literal per
   palette so SVG charts match the brand. */

export type Palette = "orange" | "green" | "watermelon" | "mango" | "strawberry";

export type Theme = {
  app: string; header: string; panel: string; panel2: string; border: string;
  sub: string; faint: string; input: string; chip: string; chipOn: string;
  tile: string; nav: string; navOn: string; navOff: string; modal: string;
  btn: string; primary: string; accent: string; accentBd: string;
  axis: string; bar: string; grid: string; tipBg: string;
};

const CH: Record<Palette, { l: { axis: string; bar: string; grid: string; tipBg: string }; d: { axis: string; bar: string; grid: string; tipBg: string } }> = {
  orange: { l: { axis: "#B8B0A3", bar: "#C7431D", grid: "#EFEBE2", tipBg: "#FFFFFF" }, d: { axis: "#7C7365", bar: "#E0794F", grid: "#3A322A", tipBg: "#221D17" } },
  green: { l: { axis: "#9AA79F", bar: "#0FA968", grid: "#E1EEE6", tipBg: "#FFFFFF" }, d: { axis: "#6B7660", bar: "#1FC47E", grid: "#2A3A30", tipBg: "#18211D" } },
  watermelon: { l: { axis: "#C4A6A8", bar: "#DA3B4B", grid: "#F3DEDE", tipBg: "#FFFFFF" }, d: { axis: "#7A5A5C", bar: "#F05563", grid: "#3E2427", tipBg: "#241618" } },
  mango: { l: { axis: "#C4B688", bar: "#E19A12", grid: "#F1E8CE", tipBg: "#FFFFFF" }, d: { axis: "#7A6E48", bar: "#F2B733", grid: "#3E3620", tipBg: "#241E10" } },
  strawberry: { l: { axis: "#C4A6B2", bar: "#D8437A", grid: "#F3DEE8", tipBg: "#FFFFFF" }, d: { axis: "#7A5A68", bar: "#F06C9B", grid: "#3E2432", tipBg: "#241620" } },
};

export function kpal(name: string, dark: boolean): Theme {
  const ok: Palette = (CH as any)[name] ? (name as Palette) : "orange";
  const c = CH[ok][dark ? "d" : "l"];
  return {
    app: "ksh-app kt-" + ok + (dark ? "-d" : "-l"),
    header: "ksh-header", panel: "ksh-panel", panel2: "ksh-panel2", border: "ksh-border",
    sub: "ksh-sub", faint: "ksh-faint", input: "ksh-input", chip: "ksh-chip", chipOn: "ksh-chipOn",
    tile: "ksh-tile", nav: "ksh-nav", navOn: "ksh-navOn", navOff: "ksh-navOff", modal: "ksh-modal",
    btn: "ksh-btn", primary: "ksh-primary", accent: "ksh-accent", accentBd: "ksh-accentBd",
    axis: c.axis, bar: c.bar, grid: c.grid, tipBg: c.tipBg,
  };
}

/* Store theme resolves from settings.theme (name + dark flag), same shape the
   till/back office already sync. Falls back to the production default. */
export function resolveTheme(settings: any): Theme {
  const raw = settings?.theme;
  const name = typeof raw === "string" ? raw : (raw?.name || raw?.palette || "orange");
  const dark = typeof raw === "object" ? !!raw?.dark : false;
  return kpal(String(name).toLowerCase(), dark);
}
