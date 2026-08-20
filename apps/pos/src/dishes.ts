import type { Item, Modifier, Section } from './api';

/* The menu's presentation layer — the readers the till, the KDS and Menu Master
 * all resolve a dish through, so one dish has one answer wherever it is drawn.
 *
 * Named `dishes` and not `menu` because Menu.tsx sits beside it: on a
 * case-insensitive filesystem — every Mac, by default — `menu.ts` and `Menu.tsx`
 * are the same path, and the import that resolves here on Linux resolves to the
 * React component there.
 *
 * Everything here is transcribed from design/KashikeyoPOS Guest Theme v3.dc.html
 * (CATCOLORS, CAT_ICONS, TAGSET, SPICE, dishArt, addonsFor). The prototype's
 * note on why colour matters is load-bearing and is repeated at `sectionColor`.
 *
 * WHY A DEFAULT RAMP IS NOT HARDCODED CONFIGURATION. docs/10-NO-DEMO-DATA.md
 * bans shipping an outlet's data. A section's hue is not that: it carries no
 * business meaning, it is derived from the section's own position rather than
 * from any list of section names we invented, and the moment a merchant picks
 * one it wins. What is forbidden is inventing the SECTIONS. Inventing a legible
 * default for sections the merchant created is the opposite — it is what stops
 * an unstyled menu from being seven identical grey chips.
 */

/** Eight hues at one lightness, spaced so no two sections read alike. The
 *  section's own sort position picks one; a merchant's choice replaces it. */
export const CAT_RAMP = [
  '#b8431d', '#1d6b57', '#6f47a8', '#a8721a',
  '#2b5a9e', '#9c2f63', '#4d6b23', '#7f5330',
];

/** Stroke glyphs, not emoji: the till is read at a glance across a counter,
 *  emoji render differently on every device and vanish on a thermal print. */
export const CAT_ICONS: Record<string, string> = {
  all: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  starter: 'M4 13h16M6.5 13a5.5 5.5 0 0 1 11 0M3 17h18',
  main: 'M7 3v7M5 3v4a2 2 0 0 0 4 0V3M7 10v11M17 3c-1.4 1.8-2 3.8-2 6h4M17 9v12',
  grill: 'M12 3c3 2.6 4.5 5 4.5 7.5a4.5 4.5 0 0 1-9 0C7.5 9 8.6 7.9 10 7c0 1.8.9 2.7 1.6 2.7.8 0 1.1-1.4 1-2.5-.1-1.6-.6-3-.6-4.2zM5 21h14',
  rice: 'M4 11h16a8 8 0 0 1-16 0zM3 21h18M12 4v3M9 6.5V8M15 6.5V8',
  side: 'M6 12h12a6 6 0 0 1-12 0zM4 20h16M10 8V5M14 8V6',
  dessert: 'M8.5 21h7l1-8h-9zM7 13a5 5 0 0 1 10 0M12 3v2M10.5 5.5h3',
  drink: 'M6 4h12l-1.4 9h-9.2zM12 13v6M8.5 19h7M15.5 8h3',
  soup: 'M4 11h16a8 8 0 0 1-16 0zM3 21h18M9 3v3M12 2v4M15 3v3',
  salad: 'M3 12h18a9 9 0 0 1-18 0zM12 3a4 4 0 0 1 4 4M12 3a4 4 0 0 0-4 4',
  seafood: 'M3 12c4-5 14-5 18 0-4 5-14 5-18 0zM17 12h.01M6 8.5 3 6M6 15.5 3 18',
  coffee: 'M4 8h12v5a5 5 0 0 1-10 0zM16 9h2a2.5 2.5 0 0 1 0 5h-2M4 21h14',
};
export const ICON_KEYS = Object.keys(CAT_ICONS);
export const catIcon = (key: string | null | undefined) =>
  CAT_ICONS[key || ''] || CAT_ICONS.main;

/** The diet and kitchen tags a dish can carry. A tag is a fact about the food,
 *  which is why the list is fixed and the merchant's own words go in the
 *  description — a guest filtering for "gf" has to mean the same thing on
 *  every dish or the filter is worse than no filter. */
export const TAGSET: Array<[string, string]> = [
  ['veg', 'Vegetarian'], ['vegan', 'Vegan'], ['gf', 'Gluten free'],
  ['nuts', 'Contains nuts'], ['chef', "Chef's pick"], ['new', 'New'],
  ['signature', 'Signature'],
];
export const SPICE = ['Not spicy', 'Mild', 'Medium', 'Hot'];
export const tagLabel = (t: string) =>
  (TAGSET.find((x) => x[0] === t) || [t, t])[1];

/** Every section the menu actually uses, styled where anyone has styled it.
 *  Derived from the DISHES, not only from the section table: a section nobody
 *  has opened the editor for still exists and still needs a chip. */
export function sectionsOf(items: Item[], styled: Section[] | undefined): Section[] {
  const by = new Map((styled || []).map((s) => [s.name, s]));
  const out: Section[] = [];
  const seen = new Set<string>();
  for (const s of (styled || [])) { out.push(s); seen.add(s.name); }
  for (const it of items) {
    const c = it.category;
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push({ name: c, color: null, icon: null, station: null, sort: 1000, hidden: false });
  }
  void by;
  return out.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}

/** THE SECTION COLOUR IS NOT DECORATION. It bands the till grid, it tints the
 *  artifact on a dish with no photograph, and it colours the KDS docket rail.
 *  One hue per section, reused in all three places, is what lets a cashier aim
 *  at a section before they have read a single word. */
export function sectionColor(sections: Section[], name: string | null): string {
  if (!name) return 'var(--cat-all)';
  const i = sections.findIndex((s) => s.name === name);
  const own = i >= 0 ? sections[i].color : null;
  if (own) return own;
  return CAT_RAMP[(i < 0 ? 0 : i) % CAT_RAMP.length];
}

export function sectionIcon(sections: Section[], name: string | null): string {
  const s = sections.find((x) => x.name === name);
  return catIcon(s?.icon);
}

/* Two letters, and LETTERS only. "Garudiya & rice" gave "G&", because the
   ampersand is a word by any whitespace split and the first character of it is
   an ampersand — the artifact that is supposed to identify a dish at a glance
   was showing punctuation. */
export const initials = (name: string) =>
  String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('');

/** A dish with no photograph still needs a shape. The artifact is its section's
 *  colour with the dish's initials — recognisable in the same position a photo
 *  would occupy, and never an empty grey box. */
export function dishArt(item: Item, sections: Section[]) {
  const c = sectionColor(sections, item.category);
  return {
    tint: 'color-mix(in oklab, ' + c + ' 22%, transparent)',
    /* THE HUE IS MIXED TOWARDS THE INK, not used raw. The section ramp is a set
       of mid-lightness hues chosen so no two sections are confusable; laid
       straight onto a 22% tint of themselves on the dark surface, every one of
       them fell under the contrast floor and the initials were a smudge. Mixing
       towards --text does the right thing in BOTH themes for free: --text is
       near-white on the dark ramp so the hue brightens, and near-black on the
       light one so it darkens. The section stays identifiable either way. */
    ink: 'color-mix(in oklab, ' + c + ' 55%, var(--text))',
    text: initials(item.name) || '?',
  };
}

/** Which add-ons this dish offers — the same answer the server gives, resolved
 *  on the client so a till with no signal can still open the picker. A dish
 *  inherits its section's add-ons unless it names its own; naming an empty set
 *  is a real answer (backend/src/addons.js). */
export function addonsFor(
  item: Item,
  modifiers: Modifier[] | undefined,
  links: Array<{ item_id: string; modifier_id: string }> | undefined,
): Modifier[] {
  const all = modifiers || [];
  if (item.addons_own) {
    const mine = new Set((links || [])
      .filter((l) => l.item_id === item.id).map((l) => l.modifier_id));
    return all.filter((m) => mine.has(m.id));
  }
  const cat = item.category;
  if (!cat) return [];
  return all.filter((m) => (m.sections || []).includes(cat));
}
