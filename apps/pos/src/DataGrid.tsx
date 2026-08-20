import type { ReactNode } from 'react';
import { HButton, LIFT_CARD } from './ui';
import { useBreakpoint } from './useBreakpoint';

/* The ONE table in this application, because the prototype has one.
 *
 * Every list screen here hand-rolled its own rows, which is why adapting them
 * to a phone was thirty separate jobs and none of them happened. The prototype
 * renders every table through a single `grid()`, and that is what makes its
 * behaviour consistent and its phone treatment possible at all.
 *
 * TWO RENDERINGS, NOT ONE RESTYLED. On a phone a table is not a narrow table —
 * it is a list of RECORD CARDS: the first cell becomes the card's title, the
 * last chip becomes its status badge, and everything else becomes label/value
 * pairs. A row of eight columns cannot be made legible at 390px by any amount
 * of CSS, because the problem is not the widths, it is the shape.
 *
 * THE COLUMN FLOOR IS MEASURED FROM THE TEXT, and this is the part worth
 * keeping. A grid of `1fr` columns has no floor: it keeps dividing whatever
 * width it is given, so a narrow window crushes "Delivery outstanding" to an
 * ellipsis. Deriving the floor from a column's declared fraction is wrong — a
 * fraction is a share of surplus and says nothing about how many characters the
 * cell holds; it misses exactly the cells that compose two values into one
 * string ("MVR 940 / MVR 2,500"), which are built at render time and are far
 * wider than their share suggests. So each track is
 * `minmax(measured, declared)`: the fraction still governs surplus on a wide
 * screen, and no cell is squeezed below its own text on a narrow one.
 */

export type Chip = [background: string, foreground: string];

export interface Cell {
  t: string;
  mono?: boolean;
  chip?: Chip;
  /** Colour override for the value. */
  c?: string;
  w?: number;
  size?: number;
}

export type CellIn = Cell | string | number | null | undefined;

export interface Col {
  label: string;
  /** Declared share of surplus — a grid fraction. Defaults to `1fr`. */
  w?: string;
  mono?: boolean;
  a?: 'left' | 'right';
}

export interface Row {
  key: string;
  cells: CellIn[];
  /** Highlighted — the row that needs attention. */
  on?: boolean;
  go?: () => void;
}

const cellOf = (c: CellIn): Cell =>
  (typeof c === 'object' && c !== null) ? c : { t: c === null || c === undefined ? '' : String(c) };

/* Inter at 12px averages ~6.4px a character; JetBrains Mono is fixed at ~7.2.
   Chips are 9.5px uppercase with .06em tracking inside 16px of padding. These
   are estimates, but they are estimates of the REAL STRING rather than of a
   layout hint, which is the whole point. */
const cellWidth = (c: Cell, col: Col): number => {
  if (!c.t) return 0;
  if (c.chip) return Math.round(c.t.length * 6.9) + 20;
  const mono = c.mono || col.mono;
  const per = mono ? 7.2 : (c.size && c.size > 12 ? 6.9 : 6.4);
  const bold = (c.w || 0) >= 600 ? 1.04 : 1;
  return Math.round(c.t.length * per * bold);
};

export function DataGrid({ cols, rows, empty }: { cols: Col[]; rows: Row[]; empty?: ReactNode }) {
  const isPhone = useBreakpoint() === 'm';

  if (!rows.length) {
    return (
      <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)', padding: '10px 2px' }}>
        {empty ?? 'Nothing here yet.'}
      </div>
    );
  }

  /* ── the phone: record cards ─────────────────────────────────────────── */
  if (isPhone) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((r) => {
          const cs = r.cells.map((c, j) => ({ label: cols[j]?.label ?? '', cc: cellOf(c), mono: cellOf(c).mono || cols[j]?.mono }));
          /* The last chip becomes the badge; it leaves the pair list so it is
             not printed twice. */
          let badge: typeof cs[number] | null = null;
          for (let j = cs.length - 1; j > 0; j--) {
            if (cs[j].cc.chip) { badge = cs.splice(j, 1)[0]; break; }
          }
          const head = cs.shift();
          const pairs = cs.filter((c) => c.cc.t !== '' && c.cc.t !== undefined);
          const Tag = r.go ? HButton : 'div';
          return (
            <Tag
              key={r.key}
              {...(r.go ? { onClick: r.go, type: 'button' as const, hover: r.on ? undefined : LIFT_CARD } : {})}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                width: '100%', padding: '13px 14px', borderRadius: 11, minHeight: 44,
                textAlign: 'left',
                background: r.on ? 'var(--warn-dim)' : 'var(--bg-1)',
                border: '1px solid ' + (r.on ? 'var(--warn-line)' : 'var(--line)'),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%' }}>
                <span style={{
                  fontSize: 13.5, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--text)',
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  fontFamily: head?.mono ? "'JetBrains Mono',monospace" : undefined,
                }}>
                  {head?.cc.t}
                </span>
                {badge && (
                  <span style={{
                    flexShrink: 0, padding: '3px 8px', borderRadius: 5, fontSize: 9.5, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    background: badge.cc.chip![0], color: badge.cc.chip![1],
                  }}>
                    {badge.cc.t}
                  </span>
                )}
              </div>
              {pairs.length > 0 && (
                <div style={{ display: 'grid', gap: 3, marginTop: 8, width: '100%' }}>
                  {pairs.map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-faint)', flexShrink: 0 }}>
                        {c.label}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span style={{
                        fontSize: 12, fontWeight: 600, textAlign: 'right',
                        color: c.cc.chip ? c.cc.chip[1] : (c.cc.c || 'var(--text)'),
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontFamily: c.mono ? "'JetBrains Mono',monospace" : undefined,
                        fontVariantNumeric: c.mono ? 'tabular-nums' : undefined,
                      }}>
                        {c.cc.t}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Tag>
          );
        })}
      </div>
    );
  }

  /* ── tablet and desktop: a table that side-scrolls rather than crushes ── */
  const mins = cols.map((col, j) => {
    let w = Math.round((col.label || '').length * 7.0);   // the header must not clip either
    for (const r of rows) {
      const cw = cellWidth(cellOf(r.cells[j]), col);
      if (cw > w) w = cw;
    }
    /* The floor keeps a one-character column from collapsing; the cap stops one
       long note pushing every other column off the screen — past it that cell
       ellipsises and the rest stay readable. */
    return Math.min(300, Math.max(58, w + 10));
  });
  const tmpl = cols.map((c, j) => `minmax(${mins[j]}px,${c.w || '1fr'})`).join(' ');
  const tableMin = mins.reduce((a, b) => a + b, 0) + Math.max(0, cols.length - 1) * 12 + 32;

  /* The outer grid is load-bearing, not decoration. A scroll container's
     minimum size only collapses to zero when it is a FLEX OR GRID ITEM; as a
     plain block child it still reports the table's min-content upward, and the
     card it sits in — itself a grid item on the page — grows to that width and
     drags every sibling card wide with it. One `minmax(0,1fr)` track makes the
     scroller a grid item, so the table side-scrolls inside the card instead of
     widening the page. */
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)' }}>
    <div style={{ overflowX: 'auto' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: tmpl, gap: 12, padding: '10px 16px',
        background: 'var(--bg-0)', borderBottom: '1px solid var(--line)',
        fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.09em',
        color: 'var(--text-muted)', minWidth: tableMin,
      }}>
        {cols.map((c) => (
          <span key={c.label} style={{ textAlign: c.a || 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.label}
          </span>
        ))}
      </div>
      {rows.map((r) => {
        const Tag = r.go ? HButton : 'div';
        return (
          <Tag
            key={r.key}
            /* A row that goes somewhere says so under the cursor. The global
               hover in pos.css is a brightness filter, and brightness on a
               TRANSPARENT background changes nothing — so the one place in the
               app where the rest state is transparent has to name its own. */
            {...(r.go ? { onClick: r.go, type: 'button' as const, hover: r.on ? undefined : { background: 'var(--bg-1)' } } : {})}
            style={{
              display: 'grid', gridTemplateColumns: tmpl, gap: 12, padding: '11px 16px',
              width: '100%', alignItems: 'center', textAlign: 'left',
              borderBottom: '1px solid var(--line-soft)',
              background: r.on ? 'var(--warn-dim)' : 'transparent',
              minWidth: tableMin,
            }}
          >
            {cols.map((col, j) => {
              const c = cellOf(r.cells[j]);
              if (c.chip) {
                return (
                  <span key={j} style={{ textAlign: col.a || 'left' }}>
                    <span style={{
                      padding: '3px 8px', borderRadius: 5, fontSize: 9.5, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '.06em',
                      background: c.chip[0], color: c.chip[1],
                    }}>
                      {c.t}
                    </span>
                  </span>
                );
              }
              return (
                <span key={j} style={{
                  textAlign: col.a || 'left', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', fontSize: 12,
                  fontWeight: c.w || 400, color: c.c || 'var(--text)',
                  fontFamily: (c.mono || col.mono) ? "'JetBrains Mono',monospace" : undefined,
                  fontVariantNumeric: (c.mono || col.mono) ? 'tabular-nums' : undefined,
                }}>
                  {c.t}
                </span>
              );
            })}
          </Tag>
        );
      })}
    </div>
    </div>
  );
}
