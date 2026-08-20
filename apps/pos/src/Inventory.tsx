import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import * as outbox from './outbox';
import { Overlay, Skeleton } from './ui';

/* Inventory and the stock ledger — 02-POS-SPEC.md §2 (`inventory`, `ledger`).
 *
 * §15 of the brief sets the standard this screen is built to: "Inventory should
 * be explainable. A user should be able to answer: «Why is this item showing
 * 17.4 units?»" So the on-hand figure is a BUTTON. Tapping it opens the
 * movements that add up to it, newest first, each with the balance it left
 * behind and the receipt or reason that caused it.
 *
 * Writes queue through the outbox like everything else that moves value — a
 * stock count is taken on a tablet in a walk-in freezer, which is exactly where
 * there is no signal.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: 3 });

interface Row {
  id: string; name: string; unit: string; onHand: number; avgCost: number;
  value: number; par: number | null; belowPar: boolean; negative: boolean;
  usedIn: number; lastMove: string | null;
}
interface Move {
  id: number; at: string; qty: number; unitCost: number; value: number;
  reason: string; balance: number; source: string | null; by: string | null;
}
interface Ledger {
  ingredient: { id: string; name: string; unit: string; onHand: number; avgCost: number };
  ledgerSum: number;
  moves: Move[];
}

const REASON_LABEL: Record<string, string> = {
  opening: 'Opening stock', purchase: 'Received', waste: 'Wasted',
  count: 'Count adjustment', sale: 'Sold', transfer: 'Transfer',
  production: 'Production', return: 'Returned',
};

export function Inventory({ session, onQueued, search, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session; onQueued: () => void | Promise<void>; search?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [totalValue, setTotalValue] = useState(0);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [act, setAct] = useState<{ kind: 'receive' | 'waste'; row: Row } | null>(null);
  const [counting, setCounting] = useState<Record<string, string> | null>(null);

  /* One helper, one BASE — see api.authed. A hard-coded '/api' resolves
     only behind the Vite proxy. */
  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      const j = await call('GET', '/inventory') as { items: Row[]; totalValue: number };
      setRows(j.items); setTotalValue(j.totalValue); setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load inventory.');
      setRows([]);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  /* Routed to the terminal's toast when one is supplied (src/ui.tsx), and to
     the module's own banner when it is not. A confirmation belongs at the
     bottom of the SCREEN rather than at the top of one card: the operator who
     just pressed Save is looking at the thing they saved, not at the header.
     Errors are deliberately NOT routed here — those stay in the form, beside
     the field that has to change, until somebody changes it. */
  const say = (t: string) => {
    if (toast) { toast(t); return; }
    setFlash(t); setTimeout(() => setFlash(''), 3200);
  };

  const explain = async (id: string) => {
    setError('');
    try { setLedger(await call('GET', `/inventory/${encodeURIComponent(id)}/ledger`) as Ledger); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open the ledger.'); }
  };

  /* Queued, not posted. The screen does not wait for a server, and the figure
     it shows refreshes when the queue drains — so a count taken with no signal
     is not lost and not double-applied. */
  const queue = async (kind: string, payload: unknown, note: string) => {
    setBusy(true);
    try {
      await outbox.enqueue(kind, payload);
      say(note + ' — queued, and applied when it reaches the server');
      setAct(null); setCounting(null);
      await onQueued();
      // Give the drain a moment, then re-read.
      setTimeout(() => { void load(); }, 1200);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Inventory</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          stock at cost <b style={{ fontFamily: MONO, color: 'var(--text-dim)' }}>{mvr(totalValue)}</b>
        </span>
        <span style={{ flex: 1 }} />
        {counting ? (
          <>
            <button onClick={() => setCounting(null)}
              style={{ padding: '7px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
              Cancel count
            </button>
            <button
              disabled={busy}
              onClick={() => {
                const lines = Object.entries(counting)
                  .filter(([, v]) => v !== '')
                  .map(([ingredientId, v]) => ({ ingredientId, counted: Number(v) }));
                if (!lines.length) { setError('Nothing counted yet.'); return; }
                void queue('stock_count', { lines, date: new Date().toISOString().slice(0, 10) },
                  lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' counted');
              }}
              style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
              Post the count
            </button>
          </>
        ) : (
          <button onClick={() => setCounting({})}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Start a stock count
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
        {rows === null ? (
          <div style={{ padding: 14 }}><Skeleton rows={5} /></div>
        ) : !rows.length ? (
          <div style={{ padding: '54px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Nothing in stock yet</div>
            <div style={{ margin: '9px auto 0', maxWidth: 460, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
              Stock lives against ingredients. Add them in Recipes &amp; Costing, then receive
              opening stock here — from that point every sale takes its recipe out of this
              list automatically, and the movements explain every figure.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', gap: 12, padding: '8px 13px', background: 'var(--bg-2)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
              <span style={{ flex: 1 }}>ITEM</span>
              <span style={{ width: 110, textAlign: 'right' }}>ON HAND</span>
              <span style={{ width: 84, textAlign: 'right' }}>VALUE</span>
              <span style={{ width: counting ? 110 : 150 }} />
            </div>
            {rows.filter((r) => hit(search, r.name, r.unit)).map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{r.name}</span>
                    {r.negative && <Tag tone="red">Oversold</Tag>}
                    {r.belowPar && !r.negative && <Tag tone="warn">Below par</Tag>}
                    {!r.avgCost && <Tag tone="warn">No cost</Tag>}
                  </span>
                  <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {r.avgCost ? mvr(Math.round(r.avgCost * 100)) + ' per ' + r.unit : 'per ' + r.unit}
                    {r.par !== null && ' · par ' + qty(r.par)}
                    {r.usedIn > 0 && ' · in ' + r.usedIn + ' recipe' + (r.usedIn === 1 ? '' : 's')}
                  </span>
                </span>

                {/* §15: the figure is the way in to its own explanation. */}
                <button onClick={() => void explain(r.id)}
                  title="Why is it showing this?"
                  style={{
                    width: 110, textAlign: 'right', fontSize: 14, fontWeight: 700, fontFamily: MONO,
                    color: r.negative ? 'var(--red-bright)' : r.belowPar ? 'var(--warn-bright)' : 'var(--text)',
                    textDecoration: 'underline', textDecorationStyle: 'dotted',
                    textUnderlineOffset: 3, textDecorationColor: 'var(--line-3)',
                  }}>
                  {qty(r.onHand)} <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{r.unit}</span>
                </button>

                <span style={{ width: 84, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text-dim)' }}>
                  {mvr(r.value)}
                </span>

                {counting ? (
                  <span style={{ width: 110, display: 'flex', justifyContent: 'flex-end' }}>
                    <input
                      inputMode="decimal"
                      placeholder="counted"
                      value={counting[r.id] ?? ''}
                      onChange={(e) => setCounting({ ...counting, [r.id]: e.target.value })}
                      aria-label={'Counted quantity for ' + r.name}
                      style={{ width: 100, height: 32, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--amber-line)', color: 'var(--text)', fontSize: 12.5, fontFamily: MONO, textAlign: 'right' }}
                    />
                  </span>
                ) : (
                  <span style={{ width: 150, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <RowBtn onClick={() => setAct({ kind: 'receive', row: r })}>Receive</RowBtn>
                    <RowBtn danger onClick={() => setAct({ kind: 'waste', row: r })}>Waste</RowBtn>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {act && <MoveSheet act={act} busy={busy} onClose={() => setAct(null)} onSubmit={queue} />}
      {ledger && <LedgerSheet ledger={ledger} onClose={() => setLedger(null)} />}
    </div>
  );
}

/* ── receive / waste ─────────────────────────────────────────────────────── */

function MoveSheet({ act, busy, onClose, onSubmit }: {
  act: { kind: 'receive' | 'waste'; row: Row };
  busy: boolean;
  onClose: () => void;
  onSubmit: (kind: string, payload: unknown, note: string) => void | Promise<void>;
}) {
  const { kind, row } = act;
  const [q, setQ] = useState('');
  const [cost, setCost] = useState(String(row.avgCost || ''));
  const [note, setNote] = useState('');
  const [opening, setOpening] = useState(false);

  const submit = () => {
    const quantity = Number(q);
    if (!(quantity > 0)) return;
    if (kind === 'receive') {
      void onSubmit('stock_receive', {
        ingredientId: row.id, qty: quantity, unitCost: Number(cost) || 0,
        reason: opening ? 'opening' : 'purchase',
        date: new Date().toISOString().slice(0, 10),
      }, qty + ' ' + row.unit + ' of ' + row.name + ' received');
    } else {
      void onSubmit('stock_waste', {
        ingredientId: row.id, qty: quantity, note,
        date: new Date().toISOString().slice(0, 10),
      }, qty + ' ' + row.unit + ' of ' + row.name + ' wasted');
    }
  };

  const canSubmit = Number(q) > 0 && (kind === 'receive' || note.trim().length > 0);

  return (
    <Sheet title={(kind === 'receive' ? 'Receive ' : 'Waste ') + row.name} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 11 }}>
        <L label={'Quantity (' + row.unit + ')'}>
          <input autoFocus inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ ...inp, fontFamily: MONO, textAlign: 'right' }} />
        </L>
        {kind === 'receive' && (
          <L label="Cost per unit (MVR)" hint="Re-averages the item's cost, and reprices every dish that uses it.">
            <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)}
              style={{ ...inp, fontFamily: MONO, textAlign: 'right' }} />
          </L>
        )}
      </div>

      {kind === 'receive' ? (
        <label style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}>
          <input type="checkbox" checked={opening} onChange={(e) => setOpening(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)' }}>
            This is opening stock — it was already here.
            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-faint)' }}>
              Credits owner equity instead of accounts payable: nothing is owed to a supplier for it.
            </span>
          </span>
        </label>
      ) : (
        <L label="Why" hint="Wastage without a reason is an unexplained hole in the stock and in the margin.">
          <input value={note} onChange={(e) => setNote(e.target.value)} style={inp}
            placeholder="walk-in failed overnight" />
        </L>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !canSubmit}
          style={{
            padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: canSubmit ? (kind === 'waste' ? 'var(--red-dim-2)' : 'var(--go)') : 'var(--bg-2)',
            color: canSubmit ? (kind === 'waste' ? '#fff' : 'var(--on-go)') : 'var(--text-faint)',
          }}>
          {busy ? 'Queuing…' : kind === 'receive' ? 'Receive it' : 'Record the waste'}
        </button>
        <button onClick={onClose}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/* ── the explanation (§15) ───────────────────────────────────────────────── */

function LedgerSheet({ ledger, onClose }: { ledger: Ledger; onClose: () => void }) {
  const agrees = ledger.ledgerSum === ledger.ingredient.onHand;
  return (
    <Sheet title={ledger.ingredient.name} onClose={onClose} wide>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, paddingBottom: 12, borderBottom: '1px solid var(--line-soft)' }}>
        <span>
          <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>ON HAND</span>
          <span style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
            {qty(ledger.ingredient.onHand)} <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{ledger.ingredient.unit}</span>
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {/* The ledger's own sum, shown beside the figure it explains — so a
            reader sees they agree rather than taking it on trust. */}
        <span style={{ fontSize: 11, color: agrees ? 'var(--go-bright)' : 'var(--red-bright)', textAlign: 'right', lineHeight: 1.5 }}>
          {agrees
            ? 'These ' + ledger.moves.length + ' movements add up to exactly that.'
            : 'The movements sum to ' + qty(ledger.ledgerSum) + ' — this does not agree, and is a bug.'}
        </span>
      </div>

      <div style={{ marginTop: 4 }}>
        {ledger.moves.map((m) => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{ width: 92, fontSize: 10.5, color: 'var(--text-faint)', fontFamily: MONO }}>
              {new Date(m.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              {' '}{new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {REASON_LABEL[m.reason] ?? m.reason}
              </span>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                {m.source ? 'receipt ' + m.source : m.by ? 'by ' + m.by : '—'}
              </span>
            </span>
            <span style={{ width: 96, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: m.qty < 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
              {m.qty > 0 ? '+' : ''}{qty(m.qty)}
            </span>
            <span style={{ width: 92, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>
              {qty(m.balance)}
            </span>
          </div>
        ))}
        {!ledger.moves.length && (
          <div style={{ padding: '26px 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>
            Nothing has moved yet. Receive opening stock and it starts here.
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const inp: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5,
};

function Sheet({ title, children, onClose, wide }: {
  title: string; children: React.ReactNode; onClose: () => void; wide?: boolean;
}) {
  return (
    <Overlay onClose={onClose} label={title} width={wide ? 640 : 460}>
    <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center' }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
      <span style={{ flex: 1 }} />
      <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>{children}</div>
    </Overlay>
  );
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

function Tag({ tone, children }: { tone: 'red' | 'warn'; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700,
      background: tone === 'red' ? 'var(--red-dim)' : 'var(--warn-dim)',
      color: tone === 'red' ? 'var(--red-bright)' : 'var(--warn-bright)',
    }}>{children}</span>
  );
}

function RowBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
      background: 'var(--bg-2)', border: '1px solid var(--line)',
      color: danger ? 'var(--red-bright)' : 'var(--text-muted)',
    }}>{children}</button>
  );
}
