import { useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { creditShare } from '../../../packages/money/money.js';

/* Credit notes — 08-BUILD-STAGES §21, raised from the receipt they correct.
 *
 * IT LIVES ON THE SALE because that is where somebody is standing when they
 * need it: a guest is at the counter with a receipt and a complaint, and the
 * person holding it should not have to go and find another screen. §2's module
 * list has no `credits` item and the rail IS the design, so this opens from
 * Orders & Tickets.
 *
 * WHAT IT WILL NOT LET YOU DO is the point of the form. It offers only what is
 * left to credit on each line — a dish sold three times and credited twice
 * offers one — and it offers the tenders the sale was actually paid with,
 * because refunding cash a guest paid by card is how a drawer comes up short.
 *
 * AND IT SAYS PLAINLY THAT NOTHING HAS HAPPENED YET. Raising is a request. The
 * money, the stock and the document number all wait for a manager who is not
 * the person who raised it.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Line {
  id: string; itemId: string; name: string; qty: number;
  unitPrice: number; amount: number; credited: number; remaining: number;
}
interface Note {
  id: string; no: string | null; at: string; amount: number; reason: string;
  refundMethod: string | null; raisedBy: string | null;
  approvedBy: string | null; declinedBy: string | null;
  declineReason: string | null; state: string;
}
interface Data {
  sale: {
    id: string; receiptNo: string; total: number; gross: number;
    discount: number; service: number; tax: number; voided: boolean;
  };
  lines: Line[];
  tenders: Array<{ method: string; amount: number }>;
  notes: Note[];
  refundMethods: string[];
  canApprove: boolean;
}

export function CreditNote({ session, saleId, onClose, onDone }: {
  session: Session; saleId: string; onClose: () => void; onDone: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [picked, setPicked] = useState<Record<string, { qty: number; restock: boolean }>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = async () => {
    try {
      const d = await call<Data>('GET', `/sales/${saleId}/credit`);
      setData(d);
      /* Default the refund to how they actually paid. */
      if (!method && d.tenders.length) setMethod(d.tenders[0].method);
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not read the sale.');
    }
  };
  useEffect(() => { void load(); }, [saleId]);

  const set = (id: string, qty: number, restock: boolean) =>
    setPicked((p) => {
      const n = { ...p };
      if (qty <= 0) delete n[id]; else n[id] = { qty, restock };
      return n;
    });

  const chosen = Object.entries(picked);
  /* Laari, and rounded per line exactly as the server rounds it. */
  const goods = data ? chosen.reduce((a, [id, v]) => {
    const l = data.lines.find((x) => x.id === id);
    return a + (l ? Math.round(Math.round(l.amount * 100) * (v.qty / l.qty)) : 0);
  }, 0) : 0;
  /* THE SAME FUNCTION THE SERVER USES. Written separately, the screen said
     93.50 and the server refunded 93.51 on the first bill anybody tried —
     which is a guest being shown one figure and handed another, and is the
     whole reason packages/money exists. */
  const refund = data ? creditShare(goods, {
    gross: Math.round(data.sale.gross * 100),
    discount: Math.round(data.sale.discount * 100),
    service: Math.round(data.sale.service * 100),
    tax: Math.round(data.sale.tax * 100),
  }).total : 0;

  const ready = chosen.length > 0 && reason.trim().length >= 4 && method;

  const raise = async () => {
    setBusy(true); setError('');
    try {
      const r = await call<{ message: string }>('POST', '/credit-notes', {
        saleId, reason: reason.trim(), refundMethod: method,
        lines: chosen.map(([id, v]) => ({ saleLineId: id, qty: v.qty, restock: v.restock })),
      });
      setFlash(r.message);
      setPicked({}); setReason('');
      await load();
      onDone();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      const r = await call<{ message: string }>('POST', path, body ?? {});
      setFlash(r.message);
      await load();
      onDone();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-label="Credit this sale"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 90 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 'min(760px, 100%)', maxHeight: '88vh', overflowY: 'auto', padding: 18, borderRadius: 12, background: 'var(--bg-1)', border: '1px solid var(--line)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
          Credit {data ? data.sale.receiptNo : 'this sale'}
        </div>
        <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)', maxWidth: 620 }}>
          A closed sale is corrected with a credit note, never erased. Raising one
          moves nothing: a manager other than whoever raised it has to approve it
          before any money goes back.
        </div>

        {(error || flash) && (
          <div style={{ marginTop: 11, padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.55, background: error ? 'var(--stop-dim)' : 'var(--go-dim)', color: error ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
            {error || flash}
          </div>
        )}

        {!data ? (
          <div style={{ padding: '24px 2px', fontSize: 12.5, color: 'var(--text-faint)' }}>
            Reading the sale…
          </div>
        ) : (
          <>
            {/* ── the lines ────────────────────────────────────────────── */}
            <table style={{ marginTop: 14, width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--text-faint)', fontSize: 10, letterSpacing: '.06em' }}>
                  <th style={{ textAlign: 'left', padding: '0 0 5px' }}>ITEM</th>
                  <th style={{ textAlign: 'right', padding: '0 0 5px', width: 70 }}>SOLD</th>
                  <th style={{ textAlign: 'right', padding: '0 0 5px', width: 80 }}>LEFT</th>
                  <th style={{ textAlign: 'right', padding: '0 0 5px', width: 90 }}>CREDIT</th>
                  <th style={{ textAlign: 'right', padding: '0 0 5px', width: 110 }}>CAME BACK?</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ padding: '4px 0', color: 'var(--text)' }}>{l.name}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>
                      {l.qty}
                    </td>
                    <td style={{ padding: '4px 0', textAlign: 'right', fontFamily: MONO, color: l.remaining ? 'var(--text-muted)' : 'var(--text-ghost)' }}>
                      {l.remaining}
                    </td>
                    <td style={{ padding: '4px 0 4px 6px' }}>
                      <input
                        aria-label={'Credit ' + l.name}
                        inputMode="decimal"
                        disabled={l.remaining <= 0}
                        value={picked[l.id]?.qty ?? ''}
                        onChange={(e) => set(l.id, Number(e.target.value) || 0,
                          picked[l.id]?.restock ?? false)}
                        style={{
                          width: '100%', height: 28, padding: '0 8px', borderRadius: 6,
                          background: 'var(--bg-2)', border: '1px solid var(--line)',
                          color: 'var(--text)', fontFamily: MONO, textAlign: 'right',
                        }} />
                    </td>
                    <td style={{ padding: '4px 0 4px 6px', textAlign: 'right' }}>
                      {/* Not a default. A steak sent back goes in the bin, and
                          ticking this by default would invent stock. */}
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                        <input type="checkbox"
                          aria-label={l.name + ' came back'}
                          disabled={!picked[l.id]}
                          checked={picked[l.id]?.restock ?? false}
                          onChange={(e) => set(l.id, picked[l.id]?.qty ?? 0, e.target.checked)} />
                        back on the shelf
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* ── why, and where the money goes ────────────────────────── */}
            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                WHY
                <input aria-label="Why" value={reason} maxLength={200}
                  placeholder="one burger came back raw"
                  onChange={(e) => setReason(e.target.value)}
                  style={{ height: 32, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                REFUND BY
                <select aria-label="Refund by" value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  style={{ height: 32, padding: '0 8px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12 }}>
                  {data.refundMethods.map((m) => (
                    <option key={m} value={m}>
                      {m}{data.tenders.some((t) => t.method === m) ? ' (as paid)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ paddingBottom: 6 }}>
                <span style={{ fontSize: 10.5, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                  REFUND
                </span>
                <div style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                  {mvr(refund / 100)}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
              <button onClick={onClose} style={ghost}>Close</button>
              <button disabled={!ready || busy} onClick={() => void raise()}
                style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ready ? 'var(--accent)' : 'var(--bg-2)', color: ready ? 'var(--on-accent)' : 'var(--text-ghost)' }}>
                Raise it for approval
              </button>
            </div>

            {/* ── what has already been raised against this sale ───────── */}
            {data.notes.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                  ALREADY RAISED
                </div>
                {data.notes.map((n) => (
                  <div key={n.id} style={{ marginTop: 9, padding: 11, borderRadius: 9, background: 'var(--bg-2)', border: '1px solid var(--line-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontFamily: MONO, color: 'var(--text)' }}>
                        {n.no || 'not numbered yet'}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{n.reason}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                        {mvr(n.amount)}
                      </span>
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 11,
                        color: n.state === 'approved' ? 'var(--go-bright)'
                          : n.state === 'declined' ? 'var(--text-faint)' : 'var(--warn-bright)',
                      }}>
                        {n.state}
                        {n.raisedBy && ' · raised by ' + n.raisedBy}
                        {n.approvedBy && ' · approved by ' + n.approvedBy}
                        {n.declinedBy && ' · turned down by ' + n.declinedBy}
                        {n.declineReason && ' — ' + n.declineReason}
                        {n.refundMethod && n.state === 'approved' && ' · by ' + n.refundMethod}
                      </span>
                      <span style={{ flex: 1 }} />
                      {data.canApprove && n.state === 'waiting for approval' && (
                        <>
                          <button disabled={busy}
                            onClick={() => void act(`/credit-notes/${n.id}/approve`)}
                            style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                            Approve and refund
                          </button>
                          <button disabled={busy}
                            onClick={() => {
                              const why = window.prompt('Why is it being turned down?');
                              if (why && why.trim().length >= 4) {
                                void act(`/credit-notes/${n.id}/decline`, { reason: why.trim() });
                              }
                            }}
                            style={{ padding: '5px 11px', borderRadius: 6, fontSize: 11.5, background: 'var(--bg-1)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                            Turn it down
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const ghost: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 7, fontSize: 12, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text-muted)',
};
