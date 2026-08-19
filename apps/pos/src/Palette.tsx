import { useEffect, useMemo, useRef, useState } from 'react';
import { NAV } from './nav';
import type { Intent } from './intent';
import { useBreakpoint } from './useBreakpoint';

/* "Go anywhere" — the prototype's ⌘K palette, transcribed.
 *
 * Thirty-seven modules is more than a rail can make findable. The prototype
 * answers that with a palette that indexes them by the WORDS people actually
 * use — somebody looking for the GRN screen types "delivery", somebody chasing
 * an unpaid supplier types "owed" — and neither of those strings appears in the
 * label they are looking for. So the synonym table below is not decoration; it
 * is the entire reason the palette finds anything. It is PALWORDS from
 * design/KashikeyoPOS Guest Theme v3.dc.html, unchanged.
 *
 * Both halves of the prototype's index are here. The "Go" rows are the rail.
 * The "Do" rows are jobs named as the job rather than the screen — somebody new
 * knows they have to book in a delivery long before they know the word GRN —
 * and each one lands on a module AND opens the thing you asked for, through the
 * one-shot channel in intent.ts.
 *
 * The Do rows are rank-gated by their target module, which the prototype does
 * not do. A row that takes you somewhere you cannot go is the same broken
 * promise as a row that does nothing, and §1.5's rule — a module the rank
 * cannot view is absent, not greyed — applies to a palette as much as a rail.
 */

const PALWORDS: Record<string, string> = {
  pos: 'sell till table floor ring up take an order dine in takeaway',
  orders: 'receipt refund bill ticket parked settled void',
  kds: 'kitchen screen bump pass expeditor',
  reservations: 'booking book a table covers',
  delivery: 'rider tracker qr order dispatch a driver',
  customers: 'credit account guest house account statement',
  promos: 'discount offer banner campaign voucher',
  loyalty: 'points rewards tier redeem',
  menu: 'dish price add-on modifier 86 off the menu availability',
  aimenu: 'generate a menu suggestions',
  recipes: 'cost food cost ingredient margin gp portion yield',
  production: 'batch prep central kitchen',
  inventory: 'stock on hand item pantry par level',
  counts: 'stock take count variance',
  ledger: 'movement stock movement history',
  batches: 'expiry fefo shelf life',
  requests: 'indent requisition ask for stock',
  purchases: 'grn goods received delivery supplier invoice receive price check',
  dispatches: 'transfer send stock in transit',
  vendors: 'supplier seller contact terms payable owed ageing pay a supplier payment run invoice due',
  staff: 'clock in roster attendance employee hours',
  payroll: 'wage salary pension mrps payslip',
  analytics: 'cfo dashboard insight health margin ask',
  reports: 'export csv z report gst return cost of sales',
  accounting: 'journal trial balance bank reconciliation gl period close chart of accounts profit and loss p&l income statement net profit margin expenses',
  costs: 'opex rent electricity bills overheads marketing advertising travel insurance legal audit cleaning laundry pest security training packaging commission',
  assets: 'equipment maintenance service repair breakdown',
  chain: 'group all outlets overview benchmark',
  branches: 'outlet location site tax class ggst tgst',
  users: 'role permission pin access rank',
  today: 'morning brief what needs doing now open shift dashboard home decisions urgent attention',
  start: 'help guide new here tour how does this work getting started overview flow chain learn',
  logs: 'audit who did trail flags compliance',
  sync: 'offline outbox queue device replay conflict printer print job docket reprint paper receipt printer not printing',
  architecture: 'schema rls deployment topology',
  settings: 'config preferences printer tax rate terminal receipt currency exchange rate usd dollar euro fx',
};

interface PalRow {
  key: string; label: string; sub: string; icon: string; words: string;
  kind: 'go' | 'do';
  /** Do rows only: where it lands and what it opens on arrival. */
  intent?: Intent;
}

/* The prototype's own icon paths for the Do rows. */
const ICO = {
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4',
  plus: 'M12 5v14M5 12h14',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  cash: 'M2 7h20v12H2zM2 11h20M6 15h4',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7z',
};

/* Label, the sentence under it, icon, and where it goes. The `sub` doubles as
   the search words, exactly as the prototype does it. */
const DO_ROWS: Array<{ label: string; sub: string; icon: string; intent: Intent }> = [
  { label: 'Receive a delivery', sub: 'Book goods in against a vendor invoice', icon: ICO.box,
    intent: { view: 'purchases', act: 'receive' } },
  { label: 'Price a signed-in delivery', sub: 'Add the rates to a delivery someone signed for', icon: ICO.cash,
    intent: { view: 'purchases', act: 'price' } },
  { label: 'Build a recipe', sub: 'Cost a dish, ingredient by ingredient', icon: ICO.book,
    intent: { view: 'recipes', act: 'build' } },
  { label: 'Add an item to the pantry', sub: 'A new ingredient in the item master', icon: ICO.plus,
    intent: { view: 'recipes', act: 'newIngredient' } },
  { label: 'Add a vendor', sub: 'A new supplier before their first delivery', icon: ICO.plus,
    intent: { view: 'vendors', act: 'newVendor' } },
  { label: 'Raise an indent', sub: 'Request stock from the central store', icon: ICO.truck,
    intent: { view: 'requests', act: 'raise' } },
  { label: 'Start a dispatch', sub: 'Send stock to another outlet', icon: ICO.truck,
    intent: { view: 'dispatches', act: 'start' } },
  { label: 'Clock in', sub: 'Start a paid shift on this device', icon: ICO.clock,
    intent: { view: 'staff', act: 'clockin' } },
  { label: 'Close the register', sub: 'Blind count, then the variance', icon: ICO.cash,
    intent: { view: 'pos', act: 'regclose' } },
  { label: 'Z-report', sub: 'End-of-shift cash-up for this terminal', icon: ICO.cash,
    intent: { view: 'reports', act: 'zread' } },
];

/* The rail is already rank-filtered by whoever renders it; the index is built
   from the same NAV so a module absent from the rail is absent here too. */
const indexFor = (rank: number): PalRow[] => {
  const out: PalRow[] = [];
  for (const grp of NAV) {
    for (const it of grp.items) {
      if (rank < it.minRank) continue;
      out.push({
        kind: 'go',
        key: 'go:' + it.id, label: it.label, sub: grp.title, icon: it.icon,
        words: (PALWORDS[it.id] || '') + ' ' + grp.title.toLowerCase(),
      });
    }
  }
  const reachable = new Set(out.map((x) => x.key.slice(3)));
  for (const d of DO_ROWS) {
    if (!reachable.has(d.intent.view)) continue;
    out.push({
      kind: 'do',
      key: 'do:' + d.label, label: d.label, sub: d.sub, icon: d.icon,
      words: d.sub.toLowerCase(), intent: d.intent,
    });
  }
  return out;
};

/* The prototype's scoring, band for band. An exact label beats a prefix beats a
   substring beats a whole synonym beats a partial synonym; letters-only is the
   last resort and only for three characters or more, because below that it
   matches everything. */
const score = (row: PalRow, t: string): number => {
  const L = row.label.toLowerCase();
  if (L === t) return 100;
  if (L.indexOf(t) === 0) return 80;
  if (L.indexOf(t) > 0) return 60;
  if ((' ' + row.words).indexOf(' ' + t) >= 0) return 50;
  if (row.words.indexOf(t) >= 0) return 35;
  if (t.length > 2 && L.replace(/[^a-z]/g, '').indexOf(t.replace(/[^a-z]/g, '')) >= 0) return 20;
  return 0;
};

export function Palette({ rank, open, recent, onClose, onGo }: {
  rank: number;
  open: boolean;
  recent: string[];
  onClose: () => void;
  /** A Go row passes a view id; a Do row passes the intent that follows it. */
  onGo: (id: string, key: string, intent?: Intent) => void;
}) {
  const isPhone = useBreakpoint() === 'm';
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ(''); setSel(0);
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const all = useMemo(() => indexFor(rank), [rank]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) {
      /* An empty palette is not an empty screen: the places this person
         actually goes, then everything else. */
      const been = recent.map((k) => all.find((x) => x.key === k)).filter(Boolean) as PalRow[];
      return been.concat(all.filter((x) => been.indexOf(x) < 0)).slice(0, 9);
    }
    return all
      .map((x) => ({ row: x, sc: score(x, t) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc || (a.row.kind === b.row.kind ? 0 : a.row.kind === 'go' ? -1 : 1))
      .slice(0, 12)
      .map((x) => x.row);
  }, [all, q, recent]);

  if (!open) return null;
  const at = Math.max(0, Math.min(rows.length - 1, sel));
  const run = (r: PalRow | undefined) => {
    if (!r) return;
    onGo(r.intent ? r.intent.view : r.key.slice(3), r.key, r.intent);
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 88, animation: 'kfade .12s' }} />
      {/* Two elements where the prototype has one: kmodal animates `transform`
          and the centring IS a transform, so a single element snaps to the left
          edge for the last frame of the animation. The outer box centres, the
          inner box animates, and the two never fight. */}
      <div style={{
        position: 'fixed', zIndex: 89, left: '50%', transform: 'translateX(-50%)',
        top: isPhone ? 8 : '9vh',
        width: isPhone ? 'calc(100vw - 16px)' : 'min(560px,92vw)',
      }}>
      <div role="dialog" aria-label="Go anywhere" style={{
        width: '100%',
        background: 'var(--bg-1)', border: '1px solid var(--line-3)', borderRadius: 14,
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', animation: 'kmodal .16s cubic-bezier(.2,.7,.3,1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={input} value={q} aria-label="Go anywhere"
            placeholder="Go anywhere, or say what you want to do…"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(rows.length - 1, at + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, at - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(rows[at]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit' }}
          />
          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: 'var(--text-faint)', border: '1px solid var(--line)', borderRadius: 5, padding: '3px 6px', fontFamily: "'JetBrains Mono',monospace" }}>ESC</span>
        </div>
        <div className="krail" style={{ maxHeight: 'min(56dvh,420px)', overflowY: 'auto', padding: 7 }}>
          {rows.map((r, i) => (
            <button
              key={r.key} type="button" onClick={() => run(r)}
              onMouseEnter={() => { if (at !== i) setSel(i); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px',
                borderRadius: 9, minHeight: 46, fontFamily: 'inherit', textAlign: 'left',
                border: '1px solid ' + (i === at ? 'var(--line-3)' : 'transparent'),
                background: i === at ? 'var(--bg-2)' : 'transparent', color: 'var(--text)',
              }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: .7 }}>
                <path d={r.icon} />
              </svg>
              <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</span>
              </span>
              <span style={{
                flexShrink: 0, fontSize: 9, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase',
                padding: '3px 7px', borderRadius: 5,
                background: r.kind === 'do' ? 'var(--warn-dim)' : 'var(--bg-3)',
                color: r.kind === 'do' ? 'var(--warn-bright)' : 'var(--text-muted)',
              }}>{r.kind === 'do' ? 'Do' : 'Go'}</span>
            </button>
          ))}
          {rows.length === 0 && (
            <div style={{ padding: '26px 16px', textAlign: 'center', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
              Nothing matches that. Try a plainer word — delivery, stock, refund, points, wages.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '9px 16px', borderTop: '1px solid var(--line)', fontSize: 10.5, color: 'var(--text-faint)' }}>
          <span>↑↓ to move</span><span>Enter to open</span>
        </div>
      </div>
      </div>
    </>
  );
}
