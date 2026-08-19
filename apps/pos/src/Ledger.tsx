import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import { DataGrid } from './DataGrid';
import type { Session } from './api';
import { hit } from './filter';

/* Stock Ledger — 02-POS-SPEC.md §2 (`ledger`):
 * "Every movement with its reason and source document."
 *
 * Two ledger views exist and they answer different questions, which is why
 * neither replaces the other:
 *
 *   Inventory → tap a figure   "why is THIS ITEM showing 17.4?"  (§15)
 *   here                       "what happened to the STORE yesterday?"
 *
 * So this one is outlet-wide and newest-first, and it filters by item, by
 * reason and by date rather than starting from a single ingredient. The value
 * totals follow the filter — a filtered list under an unfiltered total is a
 * number nobody can act on.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

interface Move {
  id: number; at: string; ingredientId: string; name: string; unit: string | null;
  qty: number; unitCost: number; value: number; reason: string;
  source: string | null; by: string | null;
}
interface Data {
  moves: Move[];
  page: { limit: number; offset: number; count: number };
  value: { in: number; out: number; net: number };
  reasons: string[];
}

const REASON_LABEL: Record<string, string> = {
  opening: 'Opening stock', purchase: 'Received', waste: 'Wasted',
  count: 'Count adjustment', sale: 'Sold', transfer: 'Transfer',
  production: 'Production', return: 'Returned',
};

const PAGE = 100;

export function Ledger({ session, search }: { session: Session; search?: string }) {
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [item, setItem] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  /* Through api.authed, not a bare fetch — see there. A hard-coded '/api'
     resolves only behind the Vite proxy. */
  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (reason) q.set('reason', reason);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (item) q.set('ingredient', item);
    try {
      setData(await call<Data>('GET', '/ledger?' + q.toString()));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not read the ledger.');
      setData(null);
    }
  }, [call, reason, from, to, item, offset]);

  useEffect(() => { void load(); }, [load]);

  const set = (fn: () => void) => { setOffset(0); fn(); };
  const pages = data ? Math.ceil(data.page.count / PAGE) : 0;
  const filtered = Boolean(reason || from || to || item);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Stock ledger</span>
        <input value={item} onChange={(e) => set(() => setItem(e.target.value))}
          placeholder="Item code" aria-label="Filter by item code"
          style={{ width: 120, height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12 }} />
        <input type="date" value={from} onChange={(e) => set(() => setFrom(e.target.value))}
          aria-label="From" style={dateInput} />
        <input type="date" value={to} onChange={(e) => set(() => setTo(e.target.value))}
          aria-label="To" style={dateInput} />
        {filtered && (
          <button onClick={() => set(() => { setReason(''); setFrom(''); setTo(''); setItem(''); })}
            style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
            Clear
          </button>
        )}
        <span style={{ flex: 1 }} />
        {data && (
          <span style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
            <Fig label="IN" value={mvr(data.value.in)} />
            <Fig label="OUT" value={mvr(data.value.out)} />
            <Fig label="NET" value={mvr(data.value.net)} strong />
          </span>
        )}
      </div>

      <div className="krail" style={{ flexShrink: 0, display: 'flex', gap: 6, padding: '9px 14px', overflowX: 'auto', borderBottom: '1px solid var(--line-soft)' }}>
        <Chip on={!reason} onClick={() => set(() => setReason(''))}>Everything</Chip>
        {(data?.reasons ?? []).map((x) => (
          <Chip key={x} on={reason === x} onClick={() => set(() => setReason(x))}>
            {REASON_LABEL[x] ?? x}
          </Chip>
        ))}
      </div>

      {error && (
        <div role="status" style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--red-dim)', color: 'var(--red-bright)' }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {data === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Loading…'}
          </div>
        ) : !data.moves.length ? (
          <div style={{ padding: '54px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {filtered ? 'Nothing matches that' : 'Nothing has moved yet'}
            </div>
            <div style={{ margin: '9px auto 0', maxWidth: 460, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
              {filtered
                ? 'Widen the dates, or clear the filters to see the whole store.'
                : 'Every movement lands here the moment it happens — a sale exploding its recipe, '
                  + 'a delivery received, wastage, a count adjustment — each with its reason and '
                  + 'the document that caused it.'}
            </div>
          </div>
        ) : (
          <>
            {/* One table, one implementation — see DataGrid.tsx. The row was
                96 + 132 + 100 + 88px of fixed columns beside a flex one, so a
                390px phone could not lay it out at all. The grid measures each
                column from the widest string it actually renders, and on a
                phone drops the table shape entirely for record cards. */}
            <DataGrid
              cols={[
                { label: 'When', mono: true, w: '0.9fr' },
                { label: 'Item', w: '1.4fr' },
                { label: 'Why', w: '0.8fr' },
                { label: 'From what', w: '1.2fr' },
                { label: 'Quantity', a: 'right', mono: true, w: '0.9fr' },
                { label: 'Value', a: 'right', mono: true, w: '0.8fr' },
              ]}
              rows={data.moves.filter((m) => hit(search, m.name, m.reason, m.source, m.by)).map((m) => ({
                key: String(m.id),
                cells: [
                  { t: new Date(m.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                       + ' ' + new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
                    mono: true, c: 'var(--text-faint)' },
                  { t: m.name, w: 600 },
                  /* Two columns, not one composed string. Joined, the value
                     was long enough to ellipsise on a phone card and the
                     source — the thing that says WHY it moved — was what got
                     cut. The source document names a receipt; a manual
                     movement names the person, because there the person IS the
                     document. */
                  { t: REASON_LABEL[m.reason] ?? m.reason, c: 'var(--text-dim)' },
                  { t: m.source ?? (m.by ? 'by ' + m.by : 'no source recorded'),
                    c: 'var(--text-faint)' },
                  { t: (m.qty > 0 ? '+' : '') + qty(m.qty) + ' ' + (m.unit ?? ''),
                    mono: true, w: 700,
                    c: m.qty < 0 ? 'var(--red-bright)' : 'var(--go-bright)' },
                  { t: mvr(m.value), mono: true, c: 'var(--text-dim)' },
                ],
              }))}
            />

            {pages > 1 && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 9 }}>
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}
                  style={pageBtn(offset === 0)}>Newer</button>
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                  {offset + 1}–{Math.min(offset + PAGE, data.page.count)} of {data.page.count}
                </span>
                <button disabled={offset + PAGE >= data.page.count} onClick={() => setOffset(offset + PAGE)}
                  style={pageBtn(offset + PAGE >= data.page.count)}>Older</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const dateInput: React.CSSProperties = {
  height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO,
};

const pageBtn = (off: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600,
  background: 'var(--bg-2)', border: '1px solid var(--line)',
  color: off ? 'var(--text-faint)' : 'var(--text-muted)',
});

function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span style={{ textAlign: 'right' }}>
      <span style={{ display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: strong ? 14 : 12, fontWeight: 700, fontFamily: MONO, color: strong ? 'var(--text)' : 'var(--text-dim)' }}>{value}</span>
    </span>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      flexShrink: 0, padding: '6px 12px', borderRadius: 999, fontSize: 11.5, fontWeight: on ? 700 : 600,
      background: on ? 'var(--amber)' : 'var(--bg-2)',
      border: '1px solid ' + (on ? 'transparent' : 'var(--line)'),
      color: on ? 'var(--on-amber)' : 'var(--text-muted)',
    }}>{children}</button>
  );
}
