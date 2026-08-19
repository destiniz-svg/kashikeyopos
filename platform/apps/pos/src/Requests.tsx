import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Indent Requests — 02-POS-SPEC §2 (`requests`): "A kitchen asks; a manager
 * approves."
 *
 * THREE RANKS ON ONE SCREEN, and each sees the part of it that is theirs. A
 * cook can raise a request and read the answer; a manager decides quantities
 * and turns the approved ones into an order. Splitting that into two screens
 * would mean the person who asked never sees what came back — which is how a
 * kitchen learns to pad every request by half.
 *
 * ASKED FOR AND APPROVED SIT SIDE BY SIDE, never one overwriting the other.
 * "We asked for 5 kg and were given 2" is the fact the stove needs at six in
 * the morning. A request that quietly came back smaller is the one that gets
 * discovered at the pass.
 *
 * THE DECISION IS MADE BESIDE THE SHELF FIGURE. Every line carries what the
 * store already has and what it is meant to keep, because approving a quantity
 * is answering "do we need this" — and answering it without the shelf figure is
 * a guess about somebody else's store.
 *
 * APPROVED, AND NOBODY HAS ORDERED IT is the number at the top of the screen.
 * It is the gap nothing else in this build looks for: a kitchen that thinks
 * something is coming and a supplier who has never been told.
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
  font: `400 14px/1 ${MONO}`, padding: '8px 9px', borderRadius: 8,
  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
};
const label: React.CSSProperties = {
  font: '400 11px/1 system-ui', color: 'var(--text-faint)',
};
const btn = (primary?: boolean): React.CSSProperties => ({
  padding: '7px 13px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  color: primary ? '#111214' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

const money = (x: number) =>
  (x + 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (x: number) => Math.round(x * 10000) / 10000;
const day = (s: string) => new Date(s).toLocaleDateString('en-GB',
  { day: '2-digit', month: 'short' });

interface Line {
  id: string; ingredientId: string; name: string; unit: string;
  qty: number; approvedQty: number | null;
  note: string | null; reason: string | null;
  onHand: number; par: number | null; avgCost: number;
}
interface Indent {
  id: string; ref: string; state: string;
  at: string; onDate: string; forArea: string | null;
  neededBy: string | null; note: string | null; reason: string | null;
  raisedBy: string | null; decidedBy: string | null; decidedAt: string | null;
  poId: string | null; poNo: string | null; poStatus: string | null;
  lines: Line[]; estimate: number; approvedLines: number;
}
interface Ingredient { id: string; name: string; unit: string; onHand: number; par: number | null }
interface Board {
  indents: Indent[]; ingredients: Ingredient[];
  waiting: number; approvedNotOrdered: number;
  canDecide: boolean; canOrder: boolean;
}
interface Vendor { id: string; name: string; active: boolean }

const STATE: Record<string, { label: string; tone: string }> = {
  open: { label: 'waiting on a decision', tone: 'var(--amber-bright)' },
  decided: { label: 'decided', tone: 'var(--warn-bright)' },
  ordered: { label: 'ordered', tone: 'var(--go-bright)' },
  cancelled: { label: 'turned down', tone: 'var(--text-faint)' },
};

/* What a manager types into the decision form, per line: the quantity and, if
   it is less than was asked for, why. Held apart from the indent so an untouched
   line stays untouched — the server reads a missing line as "approved in
   full", and the screen must not turn a blank box into a zero. */
interface Decision { [lineId: string]: { qty: string; reason: string } }

export function Requests({ session }: { session: Session }) {
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<Board | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState({ forArea: '', neededBy: '', note: '' });
  const [want, setWant] = useState<{ ingredientId: string; qty: string }[]>(
    [{ ingredientId: '', qty: '' }]);
  const [deciding, setDeciding] = useState('');
  const [decision, setDecision] = useState<Decision>({});
  const [ordering, setOrdering] = useState('');
  const [supplierId, setSupplierId] = useState('');

  const load = useCallback(async () => {
    try { setData(await call<Board>('GET', '/indents')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  /* Suppliers only for the ranks that can place an order. A cook reading their
     own request has no business holding the vendor master, and the endpoint
     would refuse them anyway. */
  useEffect(() => {
    if (session.rank < 3) return;
    void (async () => {
      try {
        const v = await call<{ suppliers: Vendor[] }>('GET', '/vendors');
        setVendors(v.suppliers.filter((s) => s.active));
      } catch { /* the order form says so when it is empty */ }
    })();
  }, [call, session.rank]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={{ ...card, color: 'var(--text-muted)' }}>Reading…</div>;

  const unitOf = (id: string) => data.ingredients.find((i) => i.id === id)?.unit || '';
  const openDecide = (it: Indent) => {
    setOrdering('');
    setDeciding(it.id);
    /* Pre-filled with what was asked for. The manager changes the lines they
       disagree with; the ones they leave alone are approved in full, which is
       what the server does with a line it was never told about. */
    const d: Decision = {};
    for (const l of it.lines) {
      d[l.id] = { qty: String(l.approvedQty === null ? l.qty : l.approvedQty), reason: l.reason || '' };
    }
    setDecision(d);
  };

  const submitDecision = (it: Indent) => act(it.id, async () => {
    const lines = it.lines
      .filter((l) => {
        const d = decision[l.id];
        return d && Number(d.qty) !== l.qty;
      })
      .map((l) => ({
        id: l.id, approvedQty: Number(decision[l.id].qty),
        reason: decision[l.id].reason.trim() || undefined,
      }));
    await call('POST', `/indents/${it.id}/decide`, { lines });
    setDeciding('');
  });

  const lineRow = (it: Indent, l: Line) => {
    const editing = deciding === it.id;
    const d = decision[l.id];
    const cut = editing && d ? Number(d.qty) < l.qty : false;
    const short = l.onHand < (l.par ?? 0);
    return (
      <div key={l.id} style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '7px 0', borderTop: '1px solid var(--line)',
      }}>
        <span style={{ font: '600 13px/1.3 system-ui', color: 'var(--text)', minWidth: 130 }}>
          {l.name}
        </span>
        <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-dim)' }}>
          asked {n4(l.qty)} {l.unit}
        </span>
        {editing ? (
          <>
            <input value={d?.qty ?? ''} inputMode="decimal" aria-label={'Approve ' + l.name}
              style={{ ...box, width: 96, padding: '6px 8px', font: `400 13px/1 ${MONO}` }}
              onChange={(e) => setDecision({ ...decision, [l.id]: { ...d, qty: e.target.value } })} />
            {cut && (
              <input value={d?.reason ?? ''} placeholder="why less?"
                aria-label={'Why less ' + l.name}
                style={{ ...box, flex: 1, minWidth: 150, padding: '6px 8px',
                  font: '400 13px/1 system-ui' }}
                onChange={(e) => setDecision({
                  ...decision, [l.id]: { ...d, reason: e.target.value } })} />
            )}
          </>
        ) : (
          <span style={{ font: `400 12px/1.3 ${MONO}`,
            color: l.approvedQty === null ? 'var(--text-faint)'
              : l.approvedQty < l.qty ? 'var(--red-bright)' : 'var(--go-bright)' }}>
            {l.approvedQty === null ? 'not decided' : `approved ${n4(l.approvedQty)} ${l.unit}`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* The two figures a decision is actually made against. */}
        <span style={{ font: `400 11px/1.3 ${MONO}`,
          color: short ? 'var(--warn-bright)' : 'var(--text-faint)' }}>
          {n4(l.onHand)} on hand{l.par === null ? '' : ` · par ${n4(l.par)}`}
        </span>
        {l.reason && !editing && (
          <span style={{ font: '400 11px/1.3 system-ui', color: 'var(--text-muted)' }}>
            {l.reason}
          </span>
        )}
      </div>
    );
  };

  const row = (it: Indent) => {
    const st = STATE[it.state] || { label: it.state, tone: 'var(--text-faint)' };
    const stuck = it.state === 'decided' && it.approvedLines > 0;
    return (
      <div key={it.id} style={{
        padding: '11px 12px', borderRadius: 10, background: 'var(--bg-2)',
        border: '1px solid ' + (it.state === 'open' ? 'var(--amber)'
          : stuck ? 'var(--warn)' : 'var(--line)'),
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ font: '600 14px/1.3 system-ui', color: 'var(--text)' }}>
            {it.forArea || 'the kitchen'}
          </span>
          <span style={{ font: '400 12px/1.3 system-ui', color: st.tone }}>{st.label}</span>
          {it.poNo && (
            <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--go-bright)' }}>
              {it.poNo} · {it.poStatus}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--warn-bright)' }}>
            {money(it.estimate)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4,
          font: `400 11px/1.4 ${MONO}`, color: 'var(--text-faint)' }}>
          <span>{it.ref}</span>
          <span>{day(it.at)}</span>
          {it.raisedBy && <span>asked by {it.raisedBy}</span>}
          {it.neededBy && <span>needed {day(it.neededBy)}</span>}
          {it.decidedBy && <span>decided by {it.decidedBy}</span>}
        </div>
        {it.note && (
          <div style={{ font: '400 12px/1.4 system-ui', color: 'var(--text-muted)', marginTop: 4 }}>
            {it.note}
          </div>
        )}

        <div style={{ marginTop: 6 }}>{it.lines.map((l) => lineRow(it, l))}</div>

        {/* ── the estimate, said as an estimate ──────────────────────────── */}
        <div style={{ marginTop: 6, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
          {money(it.estimate)} at what this store last paid — not a price anybody has quoted.
        </div>

        {/* ── deciding ───────────────────────────────────────────────────── */}
        {data.canDecide && it.state === 'open' && (deciding === it.id ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} disabled={busy === it.id}
              onClick={() => void submitDecision(it)}>
              Approve it
            </button>
            <button type="button" style={btn()} onClick={() => setDeciding('')}>Cancel</button>
            <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
              flex: 1, minWidth: 240 }}>
              A line you leave alone is approved in full. Cutting one needs a reason —
              a request turned down with nothing said is how the next one gets padded.
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} onClick={() => openDecide(it)}>
              Decide it
            </button>
            <button type="button" style={{ ...btn(), color: 'var(--red-bright)',
              borderColor: 'var(--red)' }} disabled={busy === it.id}
              onClick={() => {
                const reason = window.prompt('Why is it being turned down?');
                if (reason && reason.trim()) {
                  void act(it.id, () => call('POST', `/indents/${it.id}/cancel`,
                    { reason: reason.trim() }));
                }
              }}>
              Turn it down
            </button>
          </div>
        ))}

        {/* ── ordering it ────────────────────────────────────────────────── */}
        {data.canOrder && it.state === 'decided' && it.approvedLines > 0 && (
          ordering === it.id ? (
            <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'flex-end',
              flexWrap: 'wrap' }}>
              <span style={{ display: 'grid', gap: 4 }}>
                <span style={label}>Supplier</span>
                <select value={supplierId} style={{ ...box, font: '400 13px/1 system-ui' }}
                  onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">choose…</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </span>
              <button type="button" style={btn(true)} disabled={busy === it.id || !supplierId}
                onClick={() => void act(it.id, async () => {
                  await call('POST', `/indents/${it.id}/order`, { supplierId });
                  setOrdering(''); setSupplierId('');
                })}>
                Place the order
              </button>
              <button type="button" style={btn()} onClick={() => setOrdering('')}>Cancel</button>
              <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
                flex: 1, minWidth: 240 }}>
                Priced at what this store last paid, and nothing reaches the ledger — an
                order is a promise, not a purchase. The money moves when the delivery is
                received against it.
                {vendors.length === 0 && ' No supplier has been set up yet — add one under Vendors.'}
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center',
              flexWrap: 'wrap' }}>
              <button type="button" style={btn(true)}
                onClick={() => { setDeciding(''); setOrdering(it.id); }}>
                Turn it into an order
              </button>
              <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--warn-bright)' }}>
                Approved, and nobody has ordered it. The kitchen thinks this is coming.
              </span>
            </div>
          )
        )}

        {it.reason && it.state === 'cancelled' && (
          <div style={{ marginTop: 8, font: '400 12px/1.4 system-ui', color: 'var(--text-muted)' }}>
            {it.reason}
          </div>
        )}
      </div>
    );
  };

  const openOnes = data.indents.filter((i) => i.state === 'open');
  const decidedOnes = data.indents.filter((i) => i.state === 'decided');
  const doneOnes = data.indents.filter((i) => i.state === 'ordered' || i.state === 'cancelled');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── the two numbers ────────────────────────────────────────────── */}
      <div style={{ ...card, display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={h}>Waiting on a decision</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`,
            color: data.waiting ? 'var(--amber-bright)' : 'var(--go-bright)' }}>
            {data.waiting || 'none'}
          </div>
        </div>
        <div>
          <div style={h}>Approved, not ordered</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`,
            color: data.approvedNotOrdered ? 'var(--warn-bright)' : 'var(--go-bright)' }}>
            {data.approvedNotOrdered || 'none'}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 260, font: '400 11px/1.6 system-ui',
          color: 'var(--text-faint)' }}>
          Approved and never ordered is the one nothing else looks for: a kitchen that
          thinks something is coming and a supplier who has not been told.
        </div>
        <button type="button" style={btn(true)} onClick={() => setAsking(!asking)}>
          {asking ? 'Cancel' : 'Ask for something'}
        </button>
      </div>

      {/* ── asking ─────────────────────────────────────────────────────── */}
      {asking && (
        <div style={card}>
          <div style={h}>Ask for something</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={label}>For</span>
              <input value={ask.forArea} placeholder="the pass"
                style={{ ...box, width: 150, font: '400 13px/1 system-ui' }}
                onChange={(e) => setAsk({ ...ask, forArea: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={label}>Needed by</span>
              <input value={ask.neededBy} type="date"
                style={{ ...box, font: '400 13px/1 system-ui' }}
                onChange={(e) => setAsk({ ...ask, neededBy: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 170 }}>
              <span style={label}>Note</span>
              <input value={ask.note} placeholder="weekend…"
                style={{ ...box, width: '100%', font: '400 13px/1 system-ui' }}
                onChange={(e) => setAsk({ ...ask, note: e.target.value })} />
            </label>
          </div>

          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {want.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-end',
                flexWrap: 'wrap' }}>
                <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 200 }}>
                  <span style={label}>What</span>
                  <select value={w.ingredientId} style={{ ...box, font: '400 13px/1 system-ui' }}
                    onChange={(e) => setWant(want.map((x, j) =>
                      j === i ? { ...x, ingredientId: e.target.value } : x))}>
                    <option value="">choose…</option>
                    {data.ingredients.map((ing) => (
                      <option key={ing.id} value={ing.id}>
                        {ing.name} ({n4(ing.onHand)} {ing.unit} on hand)
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={label}>How much{w.ingredientId ? ` (${unitOf(w.ingredientId)})` : ''}</span>
                  <input value={w.qty} inputMode="decimal" style={{ ...box, width: 110 }}
                    onChange={(e) => setWant(want.map((x, j) =>
                      j === i ? { ...x, qty: e.target.value } : x))} />
                </label>
                {want.length > 1 && (
                  <button type="button" style={btn()}
                    onClick={() => setWant(want.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            <div>
              <button type="button" style={btn()}
                onClick={() => setWant([...want, { ingredientId: '', qty: '' }])}>
                Another line
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center',
            flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} disabled={busy === 'ask'
              || !want.some((w) => w.ingredientId && Number(w.qty) > 0)}
              onClick={() => void act('ask', async () => {
                await call('POST', '/indents', {
                  forArea: ask.forArea.trim() || undefined,
                  neededBy: ask.neededBy || undefined,
                  note: ask.note.trim() || undefined,
                  lines: want.filter((w) => w.ingredientId && Number(w.qty) > 0)
                    .map((w) => ({ ingredientId: w.ingredientId, qty: Number(w.qty) })),
                });
                setAsk({ forArea: '', neededBy: '', note: '' });
                setWant([{ ingredientId: '', qty: '' }]);
                setAsking(false);
              })}>
              Send it
            </button>
            <span style={{ font: '400 11px/1.6 system-ui', color: 'var(--text-faint)',
              flex: 1, minWidth: 240 }}>
              Nothing moves and nothing is reserved — the goods do not exist yet. This is
              a request, and a manager decides the quantities.
            </span>
          </div>
        </div>
      )}

      {/* ── the three states, as three jobs ────────────────────────────── */}
      <div style={card}>
        <div style={h}>Waiting on a decision</div>
        {openOnes.length === 0 ? (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
            Nobody has asked for anything.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 9 }}>{openOnes.map(row)}</div>
        )}
      </div>

      {decidedOnes.length > 0 && (
        <div style={card}>
          <div style={h}>Decided, waiting to be ordered</div>
          <div style={{ display: 'grid', gap: 9 }}>{decidedOnes.map(row)}</div>
        </div>
      )}

      {doneOnes.length > 0 && (
        <div style={card}>
          <div style={h}>Ordered and turned down</div>
          <div style={{ display: 'grid', gap: 9 }}>{doneOnes.map(row)}</div>
        </div>
      )}

      {error && (
        <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>
          {error}
        </div>
      )}
    </div>
  );
}
