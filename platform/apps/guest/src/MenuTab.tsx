import { useMemo, useState } from 'react';
import type { Item, Snapshot } from './api';
import type { CartLine, Identity } from './session';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* Menu tab — spec §4. Search, category chips, diet filters, a dish sheet with
   a note and a quantity stepper, and the cart bar (drawn by App, since it sits
   above the tab bar).
 *
 * Every style here is transcribed from design/KashikeyoGuest QR v3.dc.html.
 */

const toLaari = (mvr: string) => Math.round(Number(mvr) * 100);
const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Props {
  snap: Snapshot | null;
  table: string;
  ident: Identity | null;
  diets: string[];
  setDiets: (d: string[]) => void;
  cart: CartLine[];
  setCart: (f: (c: CartLine[]) => CartLine[]) => void;
  say: (m: string) => void;
  onYou: () => void;
  onReview: () => void;
}

export function MenuTab({ snap, table, ident, cart, setCart, say, onYou }: Props) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [dish, setDish] = useState<Item | null>(null);
  const [dishQty, setDishQty] = useState(1);
  const [dishNote, setDishNote] = useState('');

  const items = snap?.items ?? [];

  /* Categories come from the menu itself, in the order the items arrive — the
     outlet's own order. No hardcoded category list: a restaurant that sells
     three things gets three chips. */
  const cats = useMemo(() => {
    const seen: string[] = [];
    for (const it of items) {
      const c = it.category || 'Other';
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  }, [items]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (it.off_menu) return false;
      if (cat !== 'all' && (it.category || 'Other') !== cat) return false;
      if (!needle) return true;
      return it.name.toLowerCase().includes(needle);
    });
  }, [items, q, cat]);

  const add = (it: Item, qty: number, note: string) => {
    setCart((c) => c.concat([{
      lineId: crypto.randomUUID(),
      itemId: it.id,
      name: it.name,
      qty,
      unitPrice: toLaari(it.price),
      note: note.trim() || undefined,
    }]));
    say(qty + ' × ' + it.name + ' added to this round');
  };

  const initials = (ident?.name || '').trim().slice(0, 1).toUpperCase();

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} className="qs">
      <div style={{ padding: '14px 20px 0' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 23, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.035em', lineHeight: 1.15 }}>
              {snap?.outlet?.name ?? ' '}
            </div>
            {/* Spec §3: table icon, 13.5px/600 accent. "Welcome — you're all set
                to order", becoming "Welcome back, {firstName}" once identified.
                The tax rate belongs on the bill, not here. */}
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: C.accent, fontWeight: 600 }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v2M4.5 11h15L15 5.5H9zM6 11v9M18 11v9" />
              </svg>
              {'Table ' + table + ' · ' + (ident?.name
                ? 'Welcome back, ' + ident.name.trim().split(/\s+/)[0]
                : "Welcome — you're all set to order")}
            </div>
          </div>
          <button
            onClick={onYou}
            aria-label="You"
            style={{
              flexShrink: 0, width: 42, height: 42, borderRadius: 21,
              background: initials ? C.accent : C.surfaceTint,
              color: initials ? '#fff' : C.inkMuted,
              display: 'grid', placeItems: 'center', fontSize: 15, fontWeight: 700,
            }}
          >
            {initials || (
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z" />
              </svg>
            )}
          </button>
        </div>

        {/* Search — 46px, 15px radius, #f5f5f6 fill. */}
        <div style={{
          marginTop: 16, height: HIT.row, borderRadius: 15, display: 'flex',
          alignItems: 'center', gap: 10, padding: '0 14px', background: C.surfaceTint,
        }}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#b4b4b9" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the menu"
            aria-label="Search the menu"
            style={{ fontSize: 14.5, color: C.ink }}
          />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear search"
              style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 11, background: C.hairline, color: C.inkMuted, display: 'grid', placeItems: 'center', fontSize: 15, lineHeight: 1 }}>
              ×
            </button>
          )}
        </div>
      </div>

      {/* Category chips */}
      <div className="qs" style={{ marginTop: 13, padding: '0 20px 4px', display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[{ id: 'all', name: 'All' }, ...cats.map((c) => ({ id: c, name: c }))].map((c) => {
          const on = cat === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              style={{
                flexShrink: 0, padding: '0 15px', minHeight: 38, borderRadius: 12,
                fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap',
                background: on ? C.accent : C.surfaceTint,
                color: on ? '#fff' : C.inkSoft,
              }}
            >{c.name}</button>
          );
        })}
      </div>

      {/* Grid */}
      <div style={{ marginTop: 12, padding: '0 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        {shown.map((it) => (
          <button
            key={it.id}
            onClick={() => { setDish(it); setDishQty(1); setDishNote(''); }}
            style={{
              display: 'block', padding: 9, borderRadius: 16, background: C.surface,
              border: '1px solid ' + C.hairline, textAlign: 'left',
            }}
          >
            <span style={{
              display: 'block', width: '100%', height: 96, borderRadius: 12,
              background: C.surfaceTint,
            }} />
            <span style={{ display: 'block', marginTop: 9, fontSize: 13.5, fontWeight: 600, color: C.ink, lineHeight: 1.3, letterSpacing: '-.015em' }}>
              {it.name}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, letterSpacing: '-.02em', fontFamily: MONO }}>
                {money(toLaari(it.price))}
              </span>
              <span style={{
                width: 26, height: 26, borderRadius: 13, background: C.accent, color: '#fff',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
            </span>
          </button>
        ))}
      </div>

      {/* Empty is a first-class state — 10-NO-DEMO-DATA.md §4: say what lands
          here and what creates it, never "No data". */}
      {!shown.length && (
        <div style={{ padding: '38px 24px', textAlign: 'center', color: C.inkGhost, fontSize: 13.5, lineHeight: 1.6, textWrap: 'pretty' }}>
          {!snap ? 'Loading the menu…'
            : items.length === 0
              ? 'This restaurant has not published its menu yet. Please ask a member of our team.'
              : q ? 'Nothing matches “' + q + '”. Try another word, or clear the search.'
                : 'Nothing in this section just now.'}
        </div>
      )}

      <div style={{ height: cart.length ? 150 : 24 }} />

      {/* ── Dish sheet. Spec §4: hero, description, add-ons, note, quantity
          (34px circular −/+ around a 16px/700 monospace count), "Add to
          round". Rises from the bottom; scrim dismisses. ─────────────────── */}
      {dish && (
        <>
          <div
            onClick={() => setDish(null)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(15,10,9,.42)', zIndex: 50, animation: 'qfade .16s' }}
          />
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 51,
            background: C.surface, borderRadius: '22px 22px 0 0',
            padding: '20px 22px calc(24px + env(safe-area-inset-bottom))',
            boxShadow: '0 -8px 40px rgba(0,0,0,.12)', animation: 'qsheet .22s',
            maxHeight: '86%', overflowY: 'auto',
          }} className="qs">
            <div style={{ fontSize: 21, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.03em', lineHeight: 1.2 }}>
              {dish.name}
            </div>
            <div style={{ marginTop: 5, fontSize: 13.5, color: C.inkMuted }}>
              {money(toLaari(dish.price))} each
            </div>

            <div style={{ margin: '16px -22px 0', height: 1, background: C.hairlineSoft }} />

            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  onClick={() => setDishQty((n) => Math.max(1, n - 1))}
                  aria-label="One less"
                  style={{ width: 34, height: 34, borderRadius: 17, background: C.surfaceTint, color: C.inkMid, display: 'grid', placeItems: 'center' }}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
                </button>
                <span style={{ fontSize: 16, fontWeight: 700, color: C.inkStrong, minWidth: 18, textAlign: 'center', fontFamily: MONO }}>
                  {dishQty}
                </span>
                <button
                  onClick={() => setDishQty((n) => Math.min(99, n + 1))}
                  aria-label="One more"
                  style={{ width: 34, height: 34, borderRadius: 17, background: C.surfaceTint, color: C.inkMid, display: 'grid', placeItems: 'center' }}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              </span>
              <span style={{ flex: 1, textAlign: 'right', fontSize: 22, fontWeight: 700, color: C.accent, fontFamily: MONO, letterSpacing: '-.01em' }}>
                {money(toLaari(dish.price) * dishQty)}
              </span>
            </div>

            <textarea
              value={dishNote}
              onChange={(e) => setDishNote(e.target.value.slice(0, 140))}
              placeholder="Anything else for the kitchen…"
              rows={2}
              aria-label="A note for the kitchen"
              style={{
                marginTop: 16, padding: '12px 14px', borderRadius: 14,
                background: C.surfaceTint, fontSize: 13.5, color: C.ink, lineHeight: 1.5,
              }}
            />

            <div style={{ marginTop: 12, fontSize: 12, color: C.inkGhost, lineHeight: 1.5, textWrap: 'pretty' }}>
              Allergy or preparation question? Ask a member of our team — they can answer before this reaches the kitchen.
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
              <button
                onClick={() => setDish(null)}
                style={{
                  padding: '15px 18px', borderRadius: 16, background: C.surfaceTint,
                  color: C.inkSoft, fontSize: 14, fontWeight: 700, minHeight: HIT.primary,
                }}
              >Cancel</button>
              <button
                onClick={() => { add(dish, dishQty, dishNote); setDish(null); }}
                style={{
                  flex: 1, padding: 15, borderRadius: 16, background: C.accent, color: '#fff',
                  fontSize: 14, fontWeight: 700, textAlign: 'center', minHeight: HIT.primary,
                  boxShadow: C.accentShadow,
                }}
              >Add to round</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
