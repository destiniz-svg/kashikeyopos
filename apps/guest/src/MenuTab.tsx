import { useMemo, useState } from 'react';
import type { Item, Modifier, Snapshot } from './api';
import type { CartLine, Identity } from './session';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* Menu tab — spec §4. Search, category chips, diet filters, a dish sheet with
   a note and a quantity stepper, and the cart bar (drawn by App, since it sits
   above the tab bar).
 *
 * Every style here is transcribed from design/KashikeyoGuest QR v3.dc.html.
 */

const toLaari = (mvr: string) => Math.round(Number(mvr) * 100);

/* Letters only: "Garudiya & rice" gave "G&", and punctuation identifies no
   dish. */
const initials = (name: string) =>
  String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || '?';

function Photo({ url, name }: { url: string | null | undefined; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span style={{ fontSize: 20, fontWeight: 800, color: C.inkGhost, letterSpacing: '-.02em' }}>
        {initials(name)}
      </span>
    );
  }
  return (
    <img src={url} alt="" onError={() => setBroken(true)}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
  );
}
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
  /* How many of each add-on the guest has stepped up. Cleared with the sheet,
     because a count left over from the last dish is a charge nobody chose. */
  const [picks, setPicks] = useState<Record<string, number>>({});

  const items = snap?.items ?? [];

  /* Categories come from the menu itself, in the order the items arrive — the
     outlet's own order. No hardcoded category list: a restaurant that sells
     three things gets three chips. */
  const cats = useMemo(() => {
    /* The merchant's own order where they have set one, and otherwise the order
       the dishes arrive in. A guest and a cashier looking at the same menu
       should be looking at it in the same order. */
    const styled = (snap?.sections ?? [])
      .filter((sn) => !sn.hidden)
      .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name))
      .map((sn) => sn.name);
    const seen: string[] = [];
    for (const n of styled) if (items.some((it) => (it.category || 'Other') === n)) seen.push(n);
    for (const it of items) {
      const c = it.category || 'Other';
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  }, [items, snap?.sections]);

  /* What this dish offers. Resolved on the phone from the same three lists the
     till resolves it from, so the two can never disagree about what is on
     offer — and the till checks it again when it accepts the round. */
  const addonsFor = (it: Item): Modifier[] => {
    const all = snap?.modifiers ?? [];
    if (it.addons_own) {
      const mine = new Set((snap?.itemModifiers ?? [])
        .filter((l) => l.item_id === it.id).map((l) => l.modifier_id));
      return all.filter((m) => mine.has(m.id));
    }
    const c = it.category;
    return c ? all.filter((m) => (m.sections || []).includes(c)) : [];
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (it.off_menu) return false;
      if (cat !== 'all' && (it.category || 'Other') !== cat) return false;
      if (!needle) return true;
      return it.name.toLowerCase().includes(needle);
    });
  }, [items, q, cat]);

  const add = (it: Item, qty: number, note: string, chosen: Modifier[]) => {
    const picked = chosen
      .filter((m) => picks[m.id] > 0)
      .map((m) => ({ id: m.id, name: m.name, price: toLaari(m.price), qty: picks[m.id] }));
    const extra = picked.reduce((a, m) => a + m.price * m.qty, 0);
    setCart((c) => c.concat([{
      lineId: crypto.randomUUID(),
      itemId: it.id,
      name: it.name,
      qty,
      unitPrice: toLaari(it.price) + extra,
      ...(picked.length ? { addons: picked } : {}),
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
            onClick={() => { setDish(it); setDishQty(1); setDishNote(''); setPicks({}); }}
            style={{
              display: 'block', padding: 9, borderRadius: 16, background: C.surface,
              border: '1px solid ' + C.hairline, textAlign: 'left',
            }}
          >
            {/* The photograph the merchant published, or an artifact in its
                place — the dish's initials, never an empty grey rectangle. */}
            <span style={{
              position: 'relative', display: 'grid', placeItems: 'center',
              width: '100%', height: 96, borderRadius: 12, overflow: 'hidden',
              background: C.surfaceTint,
            }}>
              {/* An <img>, not a background, so a photograph that 404s or a
                  host this phone cannot reach FAILS OUT LOUD and the initials
                  take over. A background paints nothing and leaves a hole, and
                  a hole is the one thing the artifact exists to prevent. */}
              <Photo url={it.image_url} name={it.name} />
              {(it.tags || []).includes('veg') || (it.tags || []).includes('vegan') ? (
                <span aria-label="Vegetarian" style={{
                  position: 'absolute', left: 7, top: 7, width: 15, height: 15, borderRadius: 4,
                  display: 'grid', placeItems: 'center', background: '#fff',
                  border: '1.5px solid #2f8a4e',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: '#2f8a4e' }} />
                </span>
              ) : null}
              {(it.spice ?? 0) > 0 && (
                <span aria-label={'Heat ' + it.spice} style={{
                  position: 'absolute', right: 7, top: 7, padding: '2px 5px', borderRadius: 5,
                  background: '#fff', color: '#c0392b', fontSize: 9, fontWeight: 800,
                  letterSpacing: '.06em',
                }}>{'\u25B2'.repeat(it.spice ?? 0)}</span>
              )}
            </span>
            <span style={{ display: 'block', marginTop: 9, fontSize: 13.5, fontWeight: 600, color: C.ink, lineHeight: 1.3, letterSpacing: '-.015em' }}>
              {it.name}
            </span>
            {it.description && (
              <span style={{
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', marginTop: 4, fontSize: 11.5, lineHeight: 1.4,
                color: C.inkGhost,
              }}>{it.description}</span>
            )}
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
      {dish && (() => {
        const offers = addonsFor(dish);
        const extra = offers.reduce((a, m) => a + toLaari(m.price) * (picks[m.id] || 0), 0);
        const unit = toLaari(dish.price) + extra;
        return (
        <>
          <div
            onClick={() => { setDish(null); setPicks({}); }}
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
            {dish.description && (
              <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.55, color: C.inkSoft, textWrap: 'pretty' }}>
                {dish.description}
              </div>
            )}

            <div style={{ margin: '16px -22px 0', height: 1, background: C.hairlineSoft }} />

            {/* ── ADD-ONS ────────────────────────────────────────────────────
                The same list the till offers, priced from the same catalogue.
                The phone posts ids and counts and never a figure — the till
                prices the round when it accepts it, which is the rule that
                keeps a guest's screen and the bill in agreement. */}
            {offers.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: C.inkGhost }}>
                  Add-ons
                </div>
                {offers.map((m) => {
                  const n = picks[m.id] || 0;
                  return (
                    <div key={m.id} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
                      borderBottom: '1px solid ' + C.hairlineSoft,
                    }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.ink }}>{m.name}</span>
                        <span style={{
                          display: 'block', marginTop: 2, fontSize: 12.5, fontFamily: MONO,
                          color: Number(m.price) ? C.inkMuted : '#2f8a4e',
                        }}>{Number(m.price) ? '+ ' + money(toLaari(m.price)) : 'Free'}</span>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        <button
                          onClick={() => setPicks((x) => ({ ...x, [m.id]: Math.max(0, n - 1) }))}
                          disabled={!n} aria-label={'One less ' + m.name}
                          style={{
                            width: 30, height: 30, borderRadius: 15, background: C.surfaceTint,
                            color: n ? C.inkMid : C.inkGhost, display: 'grid', placeItems: 'center',
                          }}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
                        </button>
                        <span style={{ minWidth: 16, textAlign: 'center', fontSize: 14, fontWeight: 700, fontFamily: MONO, color: n ? C.inkStrong : C.inkGhost }}>
                          {n}
                        </span>
                        <button
                          onClick={() => setPicks((x) => ({ ...x, [m.id]: Math.min(9, n + 1) }))}
                          aria-label={'One more ' + m.name}
                          style={{
                            width: 30, height: 30, borderRadius: 15, background: C.surfaceTint,
                            color: C.inkMid, display: 'grid', placeItems: 'center',
                          }}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

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
                {money(unit * dishQty)}
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
                onClick={() => { setDish(null); setPicks({}); }}
                style={{
                  padding: '15px 18px', borderRadius: 16, background: C.surfaceTint,
                  color: C.inkSoft, fontSize: 14, fontWeight: 700, minHeight: HIT.primary,
                }}
              >Cancel</button>
              <button
                onClick={() => { add(dish, dishQty, dishNote, offers); setDish(null); setPicks({}); }}
                style={{
                  flex: 1, padding: 15, borderRadius: 16, background: C.accent, color: '#fff',
                  fontSize: 14, fontWeight: 700, textAlign: 'center', minHeight: HIT.primary,
                  boxShadow: C.accentShadow,
                }}
              >Add to round</button>
            </div>
          </div>
        </>
        );
      })()}
    </div>
  );
}
