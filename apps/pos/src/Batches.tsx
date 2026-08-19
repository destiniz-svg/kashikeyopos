import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import { DataGrid } from './DataGrid';

/* Batches & Expiry — 02-POS-SPEC §2 (`batches`): "Lot tracking and expiry
 * alerts."
 *
 * THE SCREEN LEADS WITH MONEY, NOT COUNTS. "Four batches expiring" is a shrug;
 * "MVR 812 expiring this week" is a decision, and it is the same fact.
 *
 * EXPIRED AND EXPIRING ARE DIFFERENT PROBLEMS and are not merged into one
 * amber list. Expired is a write-off that has already happened and only needs
 * recording; expiring is a menu decision somebody can still act on. Putting
 * them together makes the first look survivable and the second look hopeless.
 *
 * THE TRACE IS THE POINT OF THE WHOLE MODULE, and it is one press from any
 * batch: which sales contained this lot, with the receipt numbers and the hour.
 * That question gets asked once, by an inspector or a supplier, on the worst
 * day of the year — and it cannot be answered afterwards unless every draw was
 * recorded at the time. The screen also says what the answer IS: first-to-
 * expire-first-out applied by the server, a model of what the kitchen does and
 * not a scan of what it did. A recall report that implies somebody scanned the
 * tub would be worse than no report.
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
const btn = (primary?: boolean): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  color: primary ? '#111214' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

const money = (x: number) =>
  (x + 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (x: number) => Math.round(x * 10000) / 10000;

interface Batch {
  id: string; ingredientId: string; name: string; unit: string;
  lot: string | null; qtyIn: number; qtyLeft: number; unitCost: number; value: number;
  receivedOn: string; expiresOn: string | null; daysLeft: number | null;
  closedAt: string | null; closedReason: string | null;
  note: string | null; by: string | null;
  state: string;
}
interface List {
  batches: Batch[]; ingredients: Ingredient[]; soonDays: number;
  expired: { count: number; value: number };
  expiring: { count: number; value: number };
  tracked: number;
  canWriteOff: boolean;
}
interface Trace {
  batch: Batch & { qtyIn: number };
  sales: Array<{ qty: number; receiptNo: string; soldAt: string; businessDate: string; channel: string }>;
  preps: Array<{ qty: number; made: string; prepRunId: string }>;
  other: Array<{ qty: number; reason: string; at: string }>;
  drawn: number;
  basis: string;
  followsPrep: string | null;
}
interface Ingredient { id: string; name: string; unit: string }

const TONE: Record<string, string> = {
  expired: 'var(--red-bright)',
  expiring: 'var(--warn-bright)',
  good: 'var(--go-bright)',
  'no expiry': 'var(--text-faint)',
};

export function Batches({ session, search }: { session: Session; search?: string }) {
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<List | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ingredientId: '', qty: '', lot: '', expiresOn: '' });

  const load = useCallback(async () => {
    try {
      setData(await call<List>('GET', '/batches' + (showClosed ? '?includeClosed=1' : '')));
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call, showClosed]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy('add'); setError('');
    try {
      await call('POST', '/batches', {
        ingredientId: form.ingredientId, qty: Number(form.qty),
        lot: form.lot.trim() || undefined,
        expiresOn: form.expiresOn || undefined,
      });
      setForm({ ingredientId: '', qty: '', lot: '', expiresOn: '' });
      setAdding(false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const writeOff = async (b: Batch) => {
    setBusy(b.id); setError('');
    try { await call('POST', `/batches/${b.id}/write-off`, {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const open = async (b: Batch) => {
    setBusy(b.id);
    try { setTrace(await call<Trace>('GET', `/batches/${b.id}/trace`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={{ ...card, color: 'var(--text-muted)' }}>Reading…</div>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── the two numbers ────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 220px), 1fr))' }}>
        <div style={{ ...card, borderColor: data.expired.count ? 'var(--red)' : 'var(--line)' }}>
          <div style={h}>Already gone off</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`,
            color: data.expired.count ? 'var(--red-bright)' : 'var(--go-bright)' }}>
            {data.expired.count ? 'MVR ' + money(data.expired.value) : 'nothing'}
          </div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            {data.expired.count
              ? `${data.expired.count} batch${data.expired.count === 1 ? '' : 'es'} past their date and still counted as stock. Writing one off puts it in the wastage figure where it belongs.`
              : 'Nothing on the shelf is past its date.'}
          </div>
        </div>
        <div style={{ ...card, borderColor: data.expiring.count ? 'var(--amber)' : 'var(--line)' }}>
          <div style={h}>Going off within {data.soonDays} days</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`,
            color: data.expiring.count ? 'var(--warn-bright)' : 'var(--go-bright)' }}>
            {data.expiring.count ? 'MVR ' + money(data.expiring.value) : 'nothing'}
          </div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            {data.expiring.count
              ? 'Still worth something. A special this week costs less than the bin.'
              : 'Nothing needs using up.'}
          </div>
        </div>
        <div style={card}>
          <div style={h}>Tracked</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text)' }}>{data.tracked}</div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            ingredients with an open batch. Most of a store never needs one — nobody
            tracks the lot of a bag of salt — so an ingredient becomes tracked the
            moment somebody records a batch of it, and not before.
          </div>
        </div>
      </div>

      {/* ── the trace ──────────────────────────────────────────────────── */}
      {trace && (
        <div style={{ ...card, borderColor: 'var(--amber)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={h}>Where {trace.batch.lot ? 'lot ' + trace.batch.lot : 'that batch'} went</div>
            <button type="button" style={btn()} onClick={() => setTrace(null)}>Close</button>
          </div>
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-dim)' }}>
            {trace.batch.name} — {n4(trace.batch.qtyIn)} {trace.batch.unit} in,
            {' '}{n4(trace.drawn)} drawn, {n4(trace.batch.qtyLeft)} left.
          </div>
          {trace.sales.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <DataGrid
                cols={[
                  { label: 'Receipt', mono: true },
                  { label: 'Day', mono: true },
                  { label: 'Sold at', mono: true },
                  { label: 'From this lot', mono: true, a: 'right' },
                ]}
                rows={trace.sales.map((s, i) => ({
                  key: String(i),
                  cells: [
                    s.receiptNo,
                    { t: s.businessDate, c: 'var(--text-muted)' },
                    { t: new Date(s.soldAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), c: 'var(--text-muted)' },
                    { t: `${n4(s.qty)} ${trace.batch.unit}`, c: 'var(--text-muted)' },
                  ],
                }))}
              />
            </div>
          ) : (
            <div style={{ marginTop: 8, font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
              None of this lot has been sold.
            </div>
          )}
          {trace.preps.length > 0 && (
            <div style={{ marginTop: 10, font: '400 12px/1.5 system-ui', color: 'var(--text-dim)' }}>
              Some of it went into: {trace.preps.map((p) => `${n4(p.qty)} into ${p.made}`).join(', ')}.
              {' '}{trace.followsPrep}
            </div>
          )}
          <div style={{ marginTop: 10, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)',
            maxWidth: 700 }}>
            {trace.basis}
          </div>
        </div>
      )}

      {/* ── the batches ────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexWrap: 'wrap', gap: 10 }}>
          <div style={h}>Batches</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={btn()} onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? 'Open ones only' : 'Show closed ones'}
            </button>
            <button type="button" style={btn(true)} onClick={() => setAdding(!adding)}>
              {adding ? 'Cancel' : 'Record a batch'}
            </button>
          </div>
        </div>

        {adding && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap',
            padding: '10px 0 14px' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Ingredient</span>
              <select value={form.ingredientId} style={{ ...box, font: '400 13px/1 system-ui' }}
                onChange={(e) => setForm({ ...form, ingredientId: e.target.value })}>
                <option value="">choose…</option>
                {data.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>How much</span>
              <input value={form.qty} inputMode="decimal" style={{ ...box, width: 100 }}
                onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Lot</span>
              <input value={form.lot} placeholder="optional" style={{ ...box, width: 120 }}
                onChange={(e) => setForm({ ...form, lot: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Use by</span>
              <input type="date" value={form.expiresOn} style={box}
                onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
            </label>
            <button type="button" style={btn(true)}
              disabled={busy === 'add' || !form.ingredientId || !form.qty}
              onClick={() => void add()}>
              {busy === 'add' ? 'Recording…' : 'Record it'}
            </button>
            <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
              maxWidth: 320 }}>
              This records which of the stock this is. It does not add any — the
              quantity already arrived through a delivery or a batch somebody made.
            </span>
          </div>
        )}

        {data.batches.length === 0 ? (
          <div style={{ font: '400 13px/1.6 system-ui', color: 'var(--text-muted)', maxWidth: 700 }}>
            Nothing is being tracked by lot yet. Record a batch against an ingredient
            when the date on it matters — fresh fish, dairy, anything a supplier
            gives a lot number to — and it will draw down as that ingredient is used
            and appear here when it is close to going off.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {data.batches.filter((b) => hit(search, b.name, b.lot, b.state)).map((b) => (
              <div key={b.id} style={{
                padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)',
                border: '1px solid ' + (b.state === 'expired' ? 'var(--red)'
                  : b.state === 'expiring' ? 'var(--amber)' : 'var(--line)'),
                opacity: b.closedAt ? 0.6 : 1,
                display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
              }}>
                <span style={{ font: '600 13px/1.3 system-ui', color: 'var(--text)', minWidth: 150 }}>
                  {b.name}
                </span>
                <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-faint)', width: 90 }}>
                  {b.lot || '—'}
                </span>
                <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-muted)', width: 130 }}>
                  {n4(b.qtyLeft)} of {n4(b.qtyIn)} {b.unit}
                </span>
                <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--warn-bright)', width: 90 }}>
                  {money(b.value)}
                </span>
                <span style={{ font: '400 12px/1.3 system-ui',
                  color: TONE[b.state] || 'var(--text-faint)', minWidth: 150 }}>
                  {b.closedAt ? b.closedReason
                    : b.expiresOn === null ? 'no date on it'
                      : b.daysLeft === null ? ''
                        : b.daysLeft < 0 ? `${-b.daysLeft} day${b.daysLeft === -1 ? '' : 's'} past its date`
                          : b.daysLeft === 0 ? 'today'
                            : `${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left`}
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" style={btn()} disabled={busy === b.id}
                  onClick={() => void open(b)}>
                  Where it went
                </button>
                {data.canWriteOff && !b.closedAt && (
                  <button type="button" disabled={busy === b.id}
                    style={{ ...btn(), color: 'var(--red-bright)', borderColor: 'var(--red)' }}
                    onClick={() => void writeOff(b)}>
                    Bin what is left
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 12, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)',
          maxWidth: 720 }}>
          Batches draw down on their own, soonest date first, whenever the ingredient
          is used — nobody scans anything, because no design that needs a scan at the
          pass survives a Friday. Binning one goes through the ordinary wastage path,
          so it lands in the same figure as everything else that was thrown away
          rather than in a second one nobody adds up.
        </div>
      </div>

      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
