import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import { DataGrid } from './DataGrid';
import { Skeleton } from './ui';

/* Production — 02-POS-SPEC §2 (`production`): "Batch prep of sub-recipes;
 * consumes ingredients, produces stock."
 *
 * THIS IS A PREP LIST, WHICH IS A DIFFERENT DOCUMENT FROM A RECIPE BOOK. A cook
 * opens it at six in the morning to answer one question — what do I need to
 * make, and can I? So the figure each card leads with is HOW MANY MORE BATCHES
 * THE STORE CAN STAND, and when that is under one it names the single component
 * that stops it. A list of every shortfall is noise; the binding one is the
 * thing to go and buy.
 *
 * RECORDING A BATCH IS TILL RANK AND TAKES ONE PRESS, because the alternative
 * is that it does not get recorded. Everything else follows from the batch
 * being real: the components leave the shelf now rather than when a dish
 * containing them eventually sells, which is what a stock count at eleven
 * o'clock has always disagreed with.
 *
 * WHAT ACTUALLY CAME OUT IS ITS OWN FIELD, and it matters. A cook who reduces
 * four litres to three has used four litres of components, and the whole of
 * that cost belongs in the three — so the box is pre-filled with the formula's
 * yield and can be overwritten, and the screen shows what that does to the
 * price rather than hiding it.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};
const box: React.CSSProperties = {
  font: `400 14px/1 ${MONO}`, padding: '8px 9px', borderRadius: 8, width: 90,
  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
};
const btn = (primary?: boolean): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  /* var(--on-amber), NOT a literal. --amber is a warm coral in the dark theme
     and NEAR-BLACK in the light one, so a hardcoded #111214 — which is the dark
     theme's --bg — rendered every primary button in this module as black text
     on a black fill the moment a till by a window switched to light. */
  color: primary ? 'var(--on-amber)' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

const n4 = (x: number) => Math.round(x * 10000) / 10000;
const money = (x: number | null | undefined) =>
  x === null || x === undefined ? '—'
    : (x + 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Component {
  id: string; name: string; unit: string; qty: number; wastePct: number;
  needPerBatch: number; onHand: number; avgCost: number; costPerBatch: number;
  isPrep: boolean;
}
interface Item {
  id: string; name: string; unit: string; category: string | null;
  onHand: number; avgCost: number; yieldQty: number;
  components: Component[];
  batchCost: number; unitCostIfMadeNow: number;
  possibleBatches: number | null; bindingComponent: string | null; ready: boolean;
}
interface Catalogue { items: Item[]; canEditRecipe: boolean }
interface Run {
  id: string; at: string; onDate: string;
  makes: { id: string; name: string; unit: string };
  qty: number; batches: number; cost: number; unitCost: number;
  note: string | null; by: string | null;
}
interface Made {
  id: string; qty: number; batches: number; cost: number; unitCost: number;
  makes: { id: string; name: string; unit: string };
  used: Array<{ id: string; name: string; unit: string; qty: number; cost: number }>;
  short: Array<{ id: string; name: string; onHand: number; needed: number }>;
  ledger: string;
}

export function Production({ session, search }: { session: Session; search?: string }) {
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<Catalogue | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [made, setMade] = useState<Made | null>(null);
  const [making, setMaking] = useState<string>('');
  const [batches, setBatches] = useState('1');
  const [outQty, setOutQty] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        call<Catalogue>('GET', '/production'),
        call<{ runs: Run[] }>('GET', '/production/runs?limit=20'),
      ]);
      setData(c); setRuns(r.runs); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const openMake = (it: Item) => {
    setMaking(it.id);
    setBatches('1');
    setOutQty(String(it.yieldQty));
    setNote('');
    setMade(null);
  };

  const makeIt = async (it: Item) => {
    setBusy(it.id); setError('');
    try {
      const r = await call<Made>('POST', '/production/runs', {
        makesId: it.id,
        batches: Number(batches) || 1,
        qty: outQty === '' ? undefined : Number(outQty),
        note: note.trim() || undefined,
      });
      setMade(r);
      setMaking('');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={card}><Skeleton /></div>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {made && (
        <div style={{ ...card, borderColor: 'var(--go)' }}>
          <div style={h}>Made</div>
          <div style={{ font: '600 17px/1.3 system-ui', color: 'var(--text)' }}>
            {n4(made.qty)} {made.makes.unit} of {made.makes.name} — MVR {money(made.cost)}
            {' '}({money(made.unitCost)} per {made.makes.unit})
          </div>
          <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--text-muted)', marginTop: 6 }}>
            Off the shelf: {made.used.map((u) => `${n4(u.qty)} ${u.unit} ${u.name}`).join(' · ')}
          </div>
          {made.short.length > 0 && (
            /* Named rather than hidden: a batch made from stock the system did
               not think was there means the store is wrong or a delivery was
               never booked, and both are worth chasing today. */
            <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--red-bright)', marginTop: 6 }}>
              The store did not have{' '}
              {made.short.map((s) => `${s.name} (needed ${n4(s.needed)}, had ${n4(s.onHand)})`).join(', ')}.
              It has been recorded anyway — the batch was made — and those are now
              negative, which is a finding rather than an error.
            </div>
          )}
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            Ledger: {made.ledger}.
          </div>
        </div>
      )}

      <div style={card}>
        <div style={h}>What this kitchen makes</div>
        {data.items.length === 0 ? (
          <div style={{ font: '400 13px/1.6 system-ui', color: 'var(--text-muted)', maxWidth: 700 }}>
            Nothing yet. A prep item is an ingredient the kitchen MAKES rather than
            buys — a sauce, a stock, a marinade. Give an ingredient a batch size and a
            formula on this screen and it behaves like every other ingredient
            afterwards: dishes use it, counts count it, and its cost is whatever the
            last batches actually cost to make.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {data.items.filter((it) => hit(search, it.name, it.unit)).map((it) => {
              const canMake = it.possibleBatches;
              const short = canMake !== null && canMake < 1;
              return (
                <div key={it.id} style={{
                  padding: '12px 13px', borderRadius: 11, background: 'var(--bg-2)',
                  border: '1px solid ' + (short ? 'var(--red)' : 'var(--line)'),
                }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ font: '600 15px/1.3 system-ui', color: 'var(--text)' }}>
                      {it.name}
                    </span>
                    <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-faint)' }}>
                      makes {n4(it.yieldQty)} {it.unit} a batch
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ font: `400 13px/1.3 ${MONO}`, color: 'var(--text-muted)' }}>
                      {n4(it.onHand)} {it.unit} on hand
                    </span>
                  </div>

                  {/* The figure the screen exists for. */}
                  <div style={{ marginTop: 7, font: '400 13px/1.5 system-ui',
                    color: short ? 'var(--red-bright)' : 'var(--go-bright)' }}>
                    {!it.ready ? 'No formula yet — nothing can be made until there is one.'
                      : canMake === null ? ''
                        : short
                          ? `Not enough for a batch${it.bindingComponent ? ' — ' + it.bindingComponent + ' runs out first' : ''}.`
                          : `Enough for ${canMake} more batch${canMake === 1 ? '' : 'es'}.`}
                  </div>

                  {it.ready && (
                    <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
                      {it.components.map((cpt) => (
                        <div key={cpt.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap',
                          font: `400 12px/1.4 ${MONO}`, color: 'var(--text-muted)' }}>
                          <span style={{ width: 170, color: 'var(--text-dim)' }}>{cpt.name}</span>
                          <span style={{ width: 110 }}>{n4(cpt.needPerBatch)} {cpt.unit}</span>
                          <span style={{ width: 110,
                            color: cpt.onHand < cpt.needPerBatch ? 'var(--red-bright)' : 'var(--text-faint)' }}>
                            {n4(cpt.onHand)} on hand
                          </span>
                          <span style={{ color: 'var(--text-faint)' }}>MVR {money(cpt.costPerBatch)}</span>
                          {cpt.wastePct > 0 && (
                            <span style={{ color: 'var(--text-faint)' }}>
                              incl. {cpt.wastePct}% trim
                            </span>
                          )}
                          {cpt.isPrep && (
                            <span style={{ color: 'var(--amber-bright)' }}>made here too</span>
                          )}
                        </div>
                      ))}
                      <div style={{ font: `400 12px/1.6 ${MONO}`, color: 'var(--text-faint)', marginTop: 4 }}>
                        A batch costs MVR {money(it.batchCost)} at today&rsquo;s prices —
                        {' '}{money(it.unitCostIfMadeNow)} per {it.unit}.
                        {Math.abs(it.unitCostIfMadeNow - it.avgCost) > 0.0001 && (
                          <span style={{ color: 'var(--warn-bright)' }}>
                            {' '}What is in the store cost {money(it.avgCost)}.
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {it.ready && (making === it.id ? (
                    <div style={{ marginTop: 11, display: 'flex', gap: 12, alignItems: 'flex-end',
                      flexWrap: 'wrap' }}>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                          Batches
                        </span>
                        <input value={batches} inputMode="decimal" style={box}
                          onChange={(e) => {
                            setBatches(e.target.value);
                            const b = Number(e.target.value);
                            if (Number.isFinite(b) && b > 0) setOutQty(String(n4(it.yieldQty * b)));
                          }} />
                      </label>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                          Actually made ({it.unit})
                        </span>
                        <input value={outQty} inputMode="decimal" style={box}
                          onChange={(e) => setOutQty(e.target.value)} />
                      </label>
                      <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 160 }}>
                        <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                          Note
                        </span>
                        <input value={note} onChange={(e) => setNote(e.target.value)}
                          placeholder="reduced hard, tasted thin…"
                          style={{ ...box, width: '100%', font: '400 13px/1 system-ui' }} />
                      </label>
                      <button type="button" style={btn(true)} disabled={busy === it.id}
                        onClick={() => void makeIt(it)}>
                        {busy === it.id ? 'Recording…' : 'Record the batch'}
                      </button>
                      <button type="button" style={btn()} onClick={() => setMaking('')}>Cancel</button>
                      {Number(outQty) > 0 && Number(batches) > 0 && (
                        <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
                          width: '100%' }}>
                          That takes {money(it.batchCost * Number(batches))} of components and makes
                          {' '}{n4(Number(outQty))} {it.unit} — {' '}
                          {money((it.batchCost * Number(batches)) / Number(outQty))} each.
                          {Number(outQty) < it.yieldQty * Number(batches)
                            && ' Short of the formula’s yield, so it is dearer than usual.'}
                        </span>
                      )}
                    </div>
                  ) : (
                    <button type="button" style={{ ...btn(true), marginTop: 11 }}
                      onClick={() => openMake(it)}>
                      Make a batch
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {data.canEditRecipe && (
          <div style={{ marginTop: 12, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)',
            maxWidth: 700 }}>
            A formula is a costing decision — it prices every dish that contains this
            and it is what a stock count is measured against — so writing one is a
            manager&rsquo;s act, and it is set whole rather than line by line. Half a
            saved formula is how a batch gets made from four of its five components.
          </div>
        )}
      </div>

      {/* ── what has been made ────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>Batches made</div>
        <DataGrid
          cols={[
            { label: 'When', mono: true },
            { label: 'What', w: '1.6fr' },
            { label: 'Made', a: 'right', mono: true },
            { label: 'Cost', a: 'right', mono: true },
            { label: 'Per unit', a: 'right', mono: true },
            { label: 'By' },
          ]}
          rows={runs.filter((r) => hit(search, r.makes.name, r.note, r.by)).map((r) => ({
            key: String(r.id),
            cells: [
              { t: new Date(r.at).toLocaleString('en-GB',
                  { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
                c: 'var(--text-faint)' },
              { t: r.note ? `${r.makes.name} — ${r.note}` : r.makes.name, w: 600 },
              `${n4(r.qty)} ${r.makes.unit}`,
              { t: money(r.cost), c: 'var(--warn-bright)' },
              money(r.unitCost),
              { t: r.by || '—', c: 'var(--text-faint)' },
            ],
          }))}
          empty="Nothing has been made yet."
        />
        <div style={{ marginTop: 10, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)',
          maxWidth: 700 }}>
          Making a batch moves value from one inventory line to another and posts
          nothing to the ledger — tomatoes become sauce, and both are stock. What it
          does change is when the components leave the shelf: now, rather than
          whenever a dish containing them eventually sells.
        </div>
      </div>

      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
