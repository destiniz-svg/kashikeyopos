import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Recipes & Costing — 02-POS-SPEC.md §2 (`recipes`):
 * "Ingredients, yield, sub-recipes, waste %, live plate cost and GP."
 *
 * The costs on this screen are the SAME numbers the ledger books: the server
 * computes both through src/costing.js. So "the screen says 31% and the books
 * say 38%" cannot happen — there is one calculation and two readers of it.
 *
 * The figure a manager acts on is FOOD COST %, so it is the one that gets the
 * colour: green under 30, amber to 40, red above. Those thresholds are a
 * convention of the trade rather than configuration, and they are here rather
 * than in the database because they change nothing about the money — they only
 * decide which of three tokens a number is painted in.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Costed {
  itemId: string; name: string; category: string | null;
  price: number; plateCost: number; lines: number; incomplete: boolean;
  net: number; gp: number; gpPct: number; foodCostPct: number;
}
interface Ingredient {
  id: string; name: string; unit: string; onHand: number; avgCost: number;
  par: number | null; allergens: string[]; category: string | null; usedIn: number;
}
interface RecipeLine {
  id: number; kind: 'ingredient' | 'sub'; ref: string; name: string;
  unit: string; qty: number; wastePct: number; grossQty: number;
  unitCost: number; cost: number; priced: boolean;
}
interface RecipeDetail {
  itemId: string; name: string; price: number; yieldQty: number;
  lines: RecipeLine[]; plateCost: number; incomplete: boolean;
  net: number; gp: number; gpPct: number; foodCostPct: number;
}

type Tab = 'dishes' | 'ingredients';

export function Recipes({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>('dishes');
  const [items, setItems] = useState<Costed[] | null>(null);
  const [ings, setIngs] = useState<Ingredient[] | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [open, setOpen] = useState<RecipeDetail | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [newIng, setNewIng] = useState({ id: '', name: '', unit: 'g', avgCost: '', category: '' });
  const [addingIng, setAddingIng] = useState(false);

  /* One helper, one BASE — see api.authed. Each of these screens used to
     write its own fetch('/api/...'), which resolves only behind the Vite
     proxy; deployed on its own origin every one of them would have 404'd. */
  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        call('GET', '/recipes') as Promise<{ items: Costed[] }>,
        call('GET', '/ingredients') as Promise<{ ingredients: Ingredient[]; units: string[] }>,
      ]);
      setItems(a.items); setIngs(b.ingredients); setUnits(b.units); setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load.');
      setItems([]); setIngs([]);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 2600); };

  const openRecipe = async (itemId: string) => {
    setError('');
    try { setOpen(await call('GET', '/recipes/' + encodeURIComponent(itemId)) as RecipeDetail); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open it.'); }
  };

  const saveRecipe = async (lines: RecipeLine[], yieldQty: number) => {
    if (!open || busy) return;
    setBusy(true); setError('');
    try {
      await call('PUT', '/recipes/' + encodeURIComponent(open.itemId), {
        yieldQty,
        lines: lines.map((l) => (l.kind === 'sub'
          ? { subItemId: l.ref, qty: l.qty, wastePct: l.wastePct }
          : { ingredientId: l.ref, qty: l.qty, wastePct: l.wastePct })),
      });
      say('Saved ' + open.name);
      await openRecipe(open.itemId);
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  const addIngredient = async () => {
    setBusy(true); setError('');
    try {
      await call('POST', '/ingredients', {
        id: newIng.id, name: newIng.name, unit: newIng.unit, category: newIng.category,
        avgCost: newIng.avgCost === '' ? 0 : Number(newIng.avgCost),
      });
      say('Added ' + newIng.name);
      setNewIng({ id: '', name: '', unit: 'g', avgCost: '', category: '' });
      setAddingIng(false);
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not add it.');
    } finally { setBusy(false); }
  };

  const repriceIngredient = async (id: string, avgCost: string) => {
    setBusy(true); setError('');
    try {
      await call('PATCH', '/ingredients/' + encodeURIComponent(id), { avgCost: Number(avgCost) });
      say('Repriced — every dish using it has recosted');
      await load();
      if (open) await openRecipe(open.itemId);
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  const setCategory = async (id: string, category: string) => {
    setBusy(true); setError('');
    try {
      await call('PATCH', '/ingredients/' + encodeURIComponent(id), { category });
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  /* Food cost %: the figure a chef actually manages against. */
  const costTone = (pct: number, incomplete: boolean) =>
    incomplete ? 'var(--text-faint)'
      : pct <= 30 ? 'var(--go-bright)'
        : pct <= 40 ? 'var(--warn-bright)' : 'var(--red-bright)';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Recipes &amp; Costing</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          {(['dishes', 'ingredients'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
                background: tab === t ? 'var(--amber)' : 'var(--bg-2)',
                color: tab === t ? 'var(--on-amber)' : 'var(--text-muted)',
                border: '1px solid ' + (tab === t ? 'var(--amber)' : 'var(--line)'),
              }}>{t === 'dishes' ? 'Dishes' : 'Ingredients'}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {tab === 'ingredients' && (
          <button onClick={() => setAddingIng(true)}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Add an ingredient
          </button>
        )}
      </div>

      {(error || flash) && (
        <div role="status" style={{
          flexShrink: 0, padding: '9px 14px', fontSize: 11.5,
          background: error ? 'var(--red-dim)' : 'var(--go-dim)',
          color: error ? 'var(--red-bright)' : 'var(--go-bright)',
        }}>{error || flash}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {tab === 'dishes' ? (
          items === null ? <Loading />
            : !items.length ? (
              <Empty
                title="No dishes to cost yet"
                body="A dish costs what its recipe costs. Add dishes in Menu Master, then give each one a recipe here — the plate cost and margin appear immediately, and the same figures are what the ledger books when it sells."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
                <div style={{ display: 'flex', gap: 12, padding: '8px 13px', background: 'var(--bg-2)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                  <span style={{ flex: 1 }}>DISH</span>
                  <span style={{ width: 78, textAlign: 'right' }}>PRICE</span>
                  <span style={{ width: 78, textAlign: 'right' }}>PLATE COST</span>
                  <span style={{ width: 62, textAlign: 'right' }}>FOOD %</span>
                  <span style={{ width: 78, textAlign: 'right' }}>GP</span>
                  <span style={{ width: 56 }} />
                </div>
                {items.map((it) => (
                  <div key={it.itemId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{it.name}</span>
                        {!it.lines && <Tag>No recipe</Tag>}
                        {it.lines > 0 && it.incomplete && <Tag>Unpriced ingredient</Tag>}
                      </span>
                      <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                        {it.category || 'Uncategorised'}{it.lines ? ' · ' + it.lines + ' line' + (it.lines === 1 ? '' : 's') : ''}
                      </span>
                    </span>
                    <Num>{mvr(it.price)}</Num>
                    <Num dim={!it.lines}>{it.lines ? mvr(it.plateCost) : '—'}</Num>
                    <span style={{ width: 62, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: costTone(it.foodCostPct, it.incomplete || !it.lines) }}>
                      {it.lines && !it.incomplete ? it.foodCostPct + '%' : '—'}
                    </span>
                    <Num dim={!it.lines}>{it.lines && !it.incomplete ? mvr(it.gp) : '—'}</Num>
                    <span style={{ width: 56, textAlign: 'right' }}>
                      <button onClick={() => void openRecipe(it.itemId)}
                        style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                        Recipe
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )
        ) : (
          ings === null ? <Loading />
            : (
              <>
                {addingIng && (
                  <form onSubmit={(e) => { e.preventDefault(); void addIngredient(); }}
                    style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 140px), 1fr))', gap: 10 }}>
                      <L label="Code"><input required value={newIng.id} onChange={(e) => setNewIng({ ...newIng, id: e.target.value })} style={inp} placeholder="TUNA" /></L>
                      <L label="Name"><input required value={newIng.name} onChange={(e) => setNewIng({ ...newIng, name: e.target.value })} style={inp} /></L>
                      <L label="Unit"><select value={newIng.unit} onChange={(e) => setNewIng({ ...newIng, unit: e.target.value })} style={inp}>{units.map((u) => <option key={u} value={u}>{u}</option>)}</select></L>
                      <L label="Cost per unit (MVR)" hint="From an invoice. A priced delivery will maintain this once Purchasing lands.">
                        <input inputMode="decimal" value={newIng.avgCost} onChange={(e) => setNewIng({ ...newIng, avgCost: e.target.value })} style={{ ...inp, fontFamily: MONO }} placeholder="0.0850" />
                      </L>
                      {/* Where it lives, in the kitchen's own words — this is
                          what a count sheet is drawn by, so an ingredient with
                          no category ends up on every sheet. */}
                      <L label="Where it lives" hint="Freezer, bar, dry store — whatever the kitchen calls it. Count sheets are taken by these.">
                        <input list="kpos-ing-categories" value={newIng.category} onChange={(e) => setNewIng({ ...newIng, category: e.target.value })} style={inp} placeholder="Freezer" />
                        <datalist id="kpos-ing-categories">
                          {Array.from(new Set(ings.map((g) => g.category).filter(Boolean))).map((c) => <option key={c as string} value={c as string} />)}
                        </datalist>
                      </L>
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                      <button type="submit" disabled={busy} style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                        {busy ? 'Saving…' : 'Add it'}
                      </button>
                      <button type="button" onClick={() => setAddingIng(false)} style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>Cancel</button>
                    </div>
                  </form>
                )}

                {!ings.length ? (
                  <Empty
                    title="No ingredients yet"
                    body="An ingredient is what the kitchen buys — with a unit and a cost per unit. Recipes are built from these, and a dish's plate cost is the sum of what it consumes. Change one cost here and every dish that uses it recosts at once."
                    action={{ label: 'Add the first ingredient', onClick: () => setAddingIng(true) }}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
                    {ings.map((g) => (
                      <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)' }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{g.name}</span>
                            <span style={{ fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>{g.id}</span>
                            {!g.avgCost && <Tag>No cost</Tag>}
                          </span>
                          <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                            per {g.unit} · {g.onHand} on hand{g.usedIn ? ' · used in ' + g.usedIn + ' recipe' + (g.usedIn === 1 ? '' : 's') : ''}
                            {' · '}
                            <CategoryCell value={g.category} known={Array.from(new Set(ings.map((x) => x.category).filter(Boolean))) as string[]} onSave={(v) => void setCategory(g.id, v)} />
                          </span>
                        </span>
                        <CostCell value={g.avgCost} onSave={(v) => void repriceIngredient(g.id, v)} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )
        )}
      </div>

      {open && (
        <RecipeSheet
          detail={open}
          ingredients={ings ?? []}
          dishes={(items ?? []).filter((i) => i.itemId !== open.itemId)}
          busy={busy}
          onClose={() => setOpen(null)}
          onSave={saveRecipe}
          costTone={costTone}
        />
      )}
    </div>
  );
}

/* ── the recipe editor ───────────────────────────────────────────────────── */

function RecipeSheet({ detail, ingredients, dishes, busy, onClose, onSave, costTone }: {
  detail: RecipeDetail;
  ingredients: Ingredient[];
  dishes: Costed[];
  busy: boolean;
  onClose: () => void;
  onSave: (lines: RecipeLine[], yieldQty: number) => void | Promise<void>;
  costTone: (pct: number, incomplete: boolean) => string;
}) {
  const [lines, setLines] = useState<RecipeLine[]>(detail.lines);
  const [yieldQty, setYieldQty] = useState(String(detail.yieldQty));
  const [pick, setPick] = useState('');

  const add = () => {
    if (!pick) return;
    const [kind, ref] = pick.split(':');
    const src = kind === 'ing'
      ? ingredients.find((i) => i.id === ref)
      : dishes.find((d) => d.itemId === ref);
    if (!src) return;
    setLines((ls) => ls.concat([{
      id: -Date.now(), kind: kind === 'ing' ? 'ingredient' : 'sub', ref,
      name: kind === 'ing' ? (src as Ingredient).name : (src as Costed).name,
      unit: kind === 'ing' ? (src as Ingredient).unit : 'portion',
      qty: 1, wastePct: 0, grossQty: 1,
      unitCost: kind === 'ing' ? (src as Ingredient).avgCost * 100 : (src as Costed).plateCost,
      cost: 0, priced: true,
    }]));
    setPick('');
  };

  const patch = (i: number, p: Partial<RecipeLine>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...p } : l)));

  /* A live preview while editing, computed the same way the server does —
     qty ÷ (1 − waste) × unit cost, over the yield. The SAVED figure always
     comes back from the server; this is only so the number moves while a
     finger is on the stepper. */
  const y = Math.max(0.0001, Number(yieldQty) || 1);
  const preview = Math.round(lines.reduce((a, l) =>
    a + (l.qty / (1 - Math.min(0.95, l.wastePct / 100))) * l.unitCost, 0) / y);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Recipe for ' + detail.name}
        style={{ width: '100%', maxWidth: 720, maxHeight: '86dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{detail.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>sells at {mvr(detail.price)}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {lines.map((l, i) => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{l.name}</span>
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                  {l.kind === 'sub' ? 'sub-recipe' : 'per ' + l.unit}
                  {l.wastePct > 0 && ' · buys ' + (Math.round(l.qty / (1 - l.wastePct / 100) * 100) / 100) + ' ' + l.unit}
                  {!l.priced && ' · not priced'}
                </span>
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>QTY</span>
                <input inputMode="decimal" value={l.qty}
                  onChange={(e) => patch(i, { qty: Number(e.target.value) || 0 })}
                  style={{ ...inp, width: 74, height: 30, fontFamily: MONO, textAlign: 'right' }} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>WASTE%</span>
                <input inputMode="decimal" value={l.wastePct}
                  onChange={(e) => patch(i, { wastePct: Number(e.target.value) || 0 })}
                  style={{ ...inp, width: 60, height: 30, fontFamily: MONO, textAlign: 'right' }} />
              </label>
              <button onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}
                aria-label={'Remove ' + l.name}
                style={{ width: 30, height: 30, borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-faint)', display: 'grid', placeItems: 'center' }}>×</button>
            </div>
          ))}

          {!lines.length && (
            <div style={{ padding: '22px 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>
              Nothing in this recipe yet. Until it has one, the dish sells and reports
              zero cost — the sale is right, the margin is unknown.
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...inp, flex: 1 }}>
              <option value="">Add an ingredient or a sub-recipe…</option>
              {ingredients.length > 0 && (
                <optgroup label="Ingredients">
                  {ingredients.map((g) => <option key={g.id} value={'ing:' + g.id}>{g.name} (per {g.unit})</option>)}
                </optgroup>
              )}
              {dishes.length > 0 && (
                <optgroup label="Sub-recipes">
                  {dishes.map((d) => <option key={d.itemId} value={'sub:' + d.itemId}>{d.name}</option>)}
                </optgroup>
              )}
            </select>
            <button onClick={add} disabled={!pick}
              style={{ padding: '9px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: pick ? 'var(--bg-3)' : 'var(--bg-2)', border: '1px solid var(--line)', color: pick ? 'var(--amber-bright)' : 'var(--text-faint)' }}>Add</button>
          </div>

          <label style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>YIELD</span>
            <input inputMode="decimal" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)}
              style={{ ...inp, width: 80, fontFamily: MONO, textAlign: 'right' }} />
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              portions this recipe makes. A batch that makes 8 costs an eighth a portion.
            </span>
          </label>
        </div>

        <div style={{ flexShrink: 0, padding: '13px 16px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span>
            <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>PLATE COST</span>
            <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(preview)}</span>
          </span>
          <span>
            <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>FOOD COST</span>
            <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color: costTone(detail.net ? Math.round(preview / detail.net * 1000) / 10 : 0, false) }}>
              {detail.net ? Math.round(preview / detail.net * 1000) / 10 + '%' : '—'}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => void onSave(lines, Number(yieldQty) || 1)} disabled={busy}
            style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
            {busy ? 'Saving…' : 'Save recipe'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── small pieces ────────────────────────────────────────────────────────── */

const inp: React.CSSProperties = {
  width: '100%', height: 32, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5,
};

function CostCell({ value, onSave }: { value: number; onSave: (v: string) => void }) {
  const [v, setV] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setV(String(value)); }, [value]);
  return editing ? (
    <span style={{ display: 'flex', gap: 6 }}>
      <input autoFocus inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)}
        style={{ ...inp, width: 96, height: 30, fontFamily: MONO, textAlign: 'right' }} />
      <button onClick={() => { setEditing(false); onSave(v); }}
        style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>Save</button>
    </span>
  ) : (
    <button onClick={() => setEditing(true)}
      style={{ width: 150, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: value ? 'var(--warn-bright)' : 'var(--text-faint)' }}>
      {value ? value.toFixed(4) : 'set a cost'}
    </button>
  );
}

/* Where an ingredient lives, edited in place. A <datalist> of the categories
   already in use rather than a fixed vocabulary — the words are the kitchen's,
   and a dropdown of ours would be one more thing to fight. */
function CategoryCell({ value, known, onSave }: {
  value: string | null; known: string[]; onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => { setV(value ?? ''); }, [value]);
  const commit = () => { setEditing(false); if (v !== (value ?? '')) onSave(v); };
  return editing ? (
    <>
      <input autoFocus list="kpos-ing-cat-inline" value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setV(value ?? ''); setEditing(false); } }}
        aria-label="Where it lives"
        style={{ width: 120, height: 24, padding: '0 7px', borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--amber-line)', color: 'var(--text)', fontSize: 10.5 }} />
      <datalist id="kpos-ing-cat-inline">{known.map((c) => <option key={c} value={c} />)}</datalist>
    </>
  ) : (
    <button onClick={() => setEditing(true)}
      style={{ fontSize: 10.5, color: value ? 'var(--text-faint)' : 'var(--warn-bright)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 }}>
      {value ?? 'no category'}
    </button>
  );
}

function Num({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return <span style={{ width: 78, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: dim ? 'var(--text-faint)' : 'var(--text-dim)' }}>{children}</span>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700, background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>{children}</span>;
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', marginBottom: 4, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label.toUpperCase()}</span>
      {children}
      {hint && <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}

const Loading = () => (
  <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>Loading…</div>
);

/* §6: every module has a real empty state — what lands here, what creates it,
   and a way to start. Never "No data". */
function Empty({ title, body, action }: { title: string; body: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div style={{ padding: '54px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      <div style={{ margin: '9px auto 0', maxWidth: 460, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>{body}</div>
      {action && (
        <button onClick={action.onClick}
          style={{ marginTop: 16, padding: '10px 18px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
          {action.label}
        </button>
      )}
    </div>
  );
}
