import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import * as outbox from './outbox';
import { useIntent } from './intent';
import type { Intent } from './intent';

/* Purchases / GRN — 02-POS-SPEC.md §2 (`purchases`):
 * "PO → delivery → priced GRN → vendor invoice → ageing."
 *
 * The screen is built around the UNPRICED delivery, because that is the normal
 * one: fish arrives at 6am, the driver leaves, the invoice turns up on
 * Thursday. Receiving must therefore be fast and must not demand prices — and
 * everything that has not been priced sorts to the top, because it is the only
 * thing on this screen that is somebody's job.
 *
 * The ageing is here rather than on a screen of its own for the same reason:
 * what is owed and what was delivered are the same conversation with the same
 * supplier, and splitting them means nobody has both halves when they ring up.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
/* Up to 4dp: a cost per gram is a fraction of a laari, and rendering 0.0850 as
   "0.09" is a six per cent lie about every gram-denominated line. */
const price = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

interface Supplier { id: string; name: string; trn: string | null; termsDays: number; active: boolean }
interface Row {
  id: string; grnNo: string; at: string; total: number; priced: boolean;
  note: string | null; supplier: string | null; receivedBy: string | null;
  lines: number; invoiceNo: string | null;
}
interface Invoice {
  id: string; invoiceNo: string; invoiceDate: string; dueDate: string;
  daysOver: number; bucket: string; amount: number; paid: number; outstanding: number;
  supplier: string | null; grnNo: string | null;
}
interface Ageing {
  buckets: Array<{ key: string; label: string }>;
  invoices: Invoice[];
  totals: Record<string, number>;
  owed: number; overdue: number;
}
interface Data { deliveries: Row[]; ageing: Ageing; suppliers: Supplier[] }
interface Line {
  ingredientId: string; name: string; unit: string | null; qty: number;
  unitPrice: number | null; provisionalCost: number; currentAvgCost: number | null; value: number;
}
interface Detail {
  delivery: Row & { supplierId: string; termsDays: number; pricedAt: string | null; pricedBy: string | null };
  lines: Line[];
  invoice: { invoiceNo: string; dueDate: string; amount: number; paid: number } | null;
}
interface Ingredient { id: string; name: string; unit: string; avgCost: number }

export function Purchases({ session, onQueued, intent, onIntentDone, search }: {
  session: Session;
  onQueued: () => void | Promise<void>;
  intent?: Intent | null;
  onIntentDone?: () => void;
  search?: string;
}) {
  const [tab, setTab] = useState<'deliveries' | 'ageing'>('deliveries');
  const [data, setData] = useState<Data | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [ings, setIngs] = useState<Ingredient[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  /* One helper, one BASE — see api.authed. Each of these screens used to
     write its own fetch('/api/...'), which resolves only behind the Vite
     proxy; deployed on its own origin every one of them would have 404'd. */
  const authed = useMemo(() => api.authed(session), [session]);
  const call = useCallback((path: string) => authed('GET', path), [authed]);

  const load = useCallback(async () => {
    try {
      setData(await call('/purchases') as Data);
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load purchases.');
      setData(null);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 7000); };

  const queue = async (kind: string, payload: unknown, said: string) => {
    setBusy(true);
    try {
      await outbox.enqueue(kind, payload);
      say(said);
      setReceiving(false); setDetail(null);
      await onQueued();
      setTimeout(() => { void load(); }, 1400);
    } finally { setBusy(false); }
  };

  const openReceive = async () => {
    setError('');
    try {
      const j = await call('/ingredients') as { ingredients: Ingredient[] };
      setIngs(j.ingredients); setReceiving(true);
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the ingredient list.');
    }
  };

  /* Arriving from the palette. "Receive a delivery" opens the GRN form the
     moment the ingredient list is in; "Price a signed-in delivery" only puts
     you on the deliveries tab, because which one to price is the operator's
     call and guessing it would be worse than landing on the list. */
  useIntent(intent, 'purchases', (act) => {
    if (act === 'receive') void openReceive();
    if (act === 'price') setTab('deliveries');
  }, () => onIntentDone?.());

  const unpriced = (data?.deliveries ?? []).filter((d) => !d.priced).length;
  const canPrice = session.rank >= 4;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Purchases</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <TabBtn on={tab === 'deliveries'} onClick={() => setTab('deliveries')}>Deliveries</TabBtn>
          <TabBtn on={tab === 'ageing'} onClick={() => setTab('ageing')}>What we owe</TabBtn>
        </span>
        {unpriced > 0 && (
          <span style={{ padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700, background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>
            {unpriced} UNPRICED
          </span>
        )}
        <span style={{ flex: 1 }} />
        {data && tab === 'ageing' && (
          <span style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
            <Fig label="OWED" value={mvr(data.ageing.owed)} strong />
            <Fig label="OVERDUE" value={mvr(data.ageing.overdue)} warn={data.ageing.overdue > 0} />
          </span>
        )}
        {!receiving && tab === 'deliveries' && (
          <button onClick={() => void openReceive()}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Receive a delivery
          </button>
        )}
      </div>

      {(error || flash) && (
        <div role="status" style={{
          flexShrink: 0, padding: '9px 14px', fontSize: 11.5, lineHeight: 1.5,
          background: error ? 'var(--red-dim)' : 'var(--go-dim)',
          color: error ? 'var(--red-bright)' : 'var(--go-bright)',
        }}>{error || flash}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {receiving && data ? (
          <Receive
            suppliers={data.suppliers.filter((s) => s.active)} ings={ings} busy={busy}
            onCancel={() => setReceiving(false)}
            onSubmit={(payload, priced) => void queue('delivery_receive', payload,
              priced
                ? 'Delivery queued — stock rises and the supplier is owed when it reaches the server.'
                : 'Delivery queued without prices. The stock goes on the shelf at what it was'
                  + ' already worth; put the invoice in when it arrives and every recipe recosts.')}
          />
        ) : data === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Loading…'}
          </div>
        ) : tab === 'deliveries' ? (
          !data.deliveries.length ? (
            <Empty
              title={data.suppliers.length ? 'No deliveries yet' : 'No suppliers yet'}
              body={data.suppliers.length
                ? 'Receiving a delivery raises the stock, owes the supplier, and — once it is'
                  + ' priced — recosts every dish that uses what came in. A delivery with no'
                  + ' invoice is fine: receive it now and price it when the paperwork turns up.'
                : 'Add a supplier in Vendors first. A delivery has to be from somebody, or there'
                  + ' is nobody to owe and nobody to ring when the fish is short.'} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.deliveries.filter((d) => hit(search, d.supplier, d.invoiceNo)).map((d) => (
                <button key={d.id} onClick={() => void (async () => {
                  try { setDetail(await call('/purchases/' + d.id) as Detail); }
                  catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open it.'); }
                })()}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid ' + (d.priced ? 'var(--line-soft)' : 'var(--amber-line)'), textAlign: 'left', width: '100%' }}>
                  <span style={{ flexShrink: 0, alignSelf: 'flex-start', padding: '3px 7px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.05em', background: d.priced ? 'var(--go-dim)' : 'var(--warn-dim)', color: d.priced ? 'var(--go-bright)' : 'var(--warn-bright)' }}>
                    {d.priced ? 'PRICED' : 'NO INVOICE YET'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{d.supplier ?? 'unknown supplier'}</span>
                      <span style={{ fontSize: 10.5, fontFamily: MONO, color: 'var(--text-faint)' }}>{d.grnNo}</span>
                    </span>
                    <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                      {new Date(d.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {' · '}{d.lines} line{d.lines === 1 ? '' : 's'}
                      {d.receivedBy && ' · ' + d.receivedBy}
                      {d.invoiceNo && ' · invoice ' + d.invoiceNo}
                      {d.note && ' · ' + d.note}
                    </span>
                  </span>
                  <span style={{ textAlign: 'right' }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(d.total)}</span>
                    {!d.priced && (
                      <span style={{ display: 'block', fontSize: 9.5, color: 'var(--warn-bright)' }}>provisional</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : (
          <AgeingView ageing={data.ageing} canPay={canPrice} busy={busy}
            onPay={(id, amount) => void queue('invoice_pay', { invoiceId: id, amount },
              'Payment of ' + mvr(amount) + ' queued.')} />
        )}
      </div>

      {detail && (
        <DeliverySheet
          detail={detail} canPrice={canPrice} busy={busy}
          onClose={() => setDetail(null)}
          onPrice={(lines, invoiceNo) => void queue('delivery_price',
            { deliveryId: detail.delivery.id, lines, invoiceNo: invoiceNo || undefined },
            'Prices queued — every recipe using these recosts when it lands.')}
        />
      )}
    </div>
  );
}

/* ── receiving ───────────────────────────────────────────────────────────── */

function Receive({ suppliers, ings, busy, onCancel, onSubmit }: {
  suppliers: Supplier[]; ings: Ingredient[]; busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: unknown, priced: boolean) => void;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '');
  const [rows, setRows] = useState<Array<{ ingredientId: string; qty: string; unitPrice: string }>>(
    [{ ingredientId: '', qty: '', unitPrice: '' }]);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [note, setNote] = useState('');

  const filled = rows.filter((r) => r.ingredientId && Number(r.qty) > 0);
  const priced = filled.length > 0 && filled.every((r) => r.unitPrice !== '');
  const total = filled.reduce((a, r) => a + Number(r.qty) * (Number(r.unitPrice) || 0), 0);

  const set = (i: number, p: Partial<typeof rows[0]>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div style={{ padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 170px), 1fr))', gap: 11 }}>
        <L label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={inp}>
            {!suppliers.length && <option value="">no suppliers yet</option>}
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.termsDays} day terms)</option>
            ))}
          </select>
        </L>
        <L label="Invoice number" hint="Leave it empty if the paperwork has not arrived.">
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} style={inp} />
        </L>
        <L label="Note">
          <input value={note} onChange={(e) => setNote(e.target.value)} style={inp}
            placeholder="no docket with the driver" />
        </L>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
          <span style={{ flex: 1 }}>WHAT CAME IN</span>
          <span style={{ width: 110, textAlign: 'right' }}>QUANTITY</span>
          <span style={{ width: 120, textAlign: 'right' }}>PRICE EACH</span>
          <span style={{ width: 92, textAlign: 'right' }}>VALUE</span>
          <span style={{ width: 28 }} />
        </div>
        {rows.map((r, i) => {
          const ing = ings.find((g) => g.id === r.ingredientId);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
              <span style={{ flex: 1 }}>
                <select value={r.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value })}
                  aria-label={'Ingredient on line ' + (i + 1)} style={inp}>
                  <option value="">choose an ingredient</option>
                  {ings.map((g) => <option key={g.id} value={g.id}>{g.name} (per {g.unit})</option>)}
                </select>
              </span>
              <input inputMode="decimal" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })}
                aria-label={'Quantity on line ' + (i + 1)}
                style={{ ...inp, width: 110, fontFamily: MONO, textAlign: 'right' }}
                placeholder={ing ? ing.unit : ''} />
              <input inputMode="decimal" value={r.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })}
                aria-label={'Price each on line ' + (i + 1)}
                style={{ ...inp, width: 120, fontFamily: MONO, textAlign: 'right' }}
                placeholder={ing ? price(ing.avgCost) : 'no invoice'} />
              <span style={{ width: 92, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>
                {r.qty && r.unitPrice ? mvr(Number(r.qty) * Number(r.unitPrice)) : '—'}
              </span>
              <button onClick={() => setRows(rows.filter((_, j) => j !== i))}
                aria-label={'Remove line ' + (i + 1)}
                style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-faint)' }}>×</button>
            </div>
          );
        })}
        <button onClick={() => setRows([...rows, { ingredientId: '', qty: '', unitPrice: '' }])}
          style={{ marginTop: 6, padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Another line
        </button>
      </div>

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button disabled={busy || !filled.length || !supplierId}
          onClick={() => onSubmit({
            supplierId,
            lines: filled.map((r) => ({
              ingredientId: r.ingredientId, qty: Number(r.qty),
              unitPrice: r.unitPrice === '' ? undefined : Number(r.unitPrice),
            })),
            invoiceNo: invoiceNo || undefined,
            note: note || undefined,
            date: new Date().toISOString().slice(0, 10),
          }, priced)}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: filled.length && supplierId ? 'var(--go)' : 'var(--bg-2)', color: filled.length && supplierId ? 'var(--on-go)' : 'var(--text-faint)' }}>
          {busy ? 'Queuing…' : 'Receive ' + filled.length + ' line' + (filled.length === 1 ? '' : 's')}
        </button>
        <button onClick={onCancel}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Cancel
        </button>
        {priced
          ? <span style={{ fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{mvr(total)}</span>
          : filled.length > 0 && (
            <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 420 }}>
              No prices, or not on every line — this will be received as unpriced. The stock still
              goes on the shelf, valued at what it was already worth, and waits for the invoice.
            </span>
          )}
      </div>
    </div>
  );
}

/* ── one delivery, and pricing it ────────────────────────────────────────── */

function DeliverySheet({ detail, canPrice, busy, onClose, onPrice }: {
  detail: Detail; canPrice: boolean; busy: boolean;
  onClose: () => void;
  onPrice: (lines: Array<{ ingredientId: string; unitPrice: number }>, invoiceNo: string) => void;
}) {
  const d = detail.delivery;
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [invoiceNo, setInvoiceNo] = useState('');
  const needed = detail.lines.filter((l) => l.unitPrice === null);
  const ready = needed.length > 0 && needed.every((l) => prices[l.ingredientId] !== undefined
    && prices[l.ingredientId] !== '');

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Delivery"
        style={{ width: '100%', maxWidth: 700, maxHeight: '86dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{d.supplier}</span>
          <span style={{ fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>{d.grnNo}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {!d.priced && (
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.6, background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>
              Received without an invoice. The stock is on the shelf, valued provisionally at what
              it was already worth — so every dish using it reports a margin nobody has checked.
              Putting the real prices in corrects the value and recosts every recipe.
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{ flex: 1 }}>ITEM</span>
            <span style={{ width: 96, textAlign: 'right' }}>QUANTITY</span>
            <span style={{ width: 108, textAlign: 'right' }}>{d.priced ? 'PRICE EACH' : 'PROVISIONAL'}</span>
            {!d.priced && <span style={{ width: 118, textAlign: 'right' }}>INVOICED AT</span>}
            <span style={{ width: 92, textAlign: 'right' }}>VALUE</span>
          </div>
          {detail.lines.map((l) => (
            <div key={l.ingredientId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{l.name}</span>
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                  per {l.unit}{l.currentAvgCost !== null && ' · shelf now at ' + price(l.currentAvgCost)}
                </span>
              </span>
              <span style={{ width: 96, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text-dim)' }}>
                {qty(l.qty)}
              </span>
              <span style={{ width: 108, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: l.unitPrice === null ? 'var(--text-faint)' : 'var(--text)' }}>
                {price(l.unitPrice ?? l.provisionalCost)}
              </span>
              {!d.priced && (
                <span style={{ width: 118, display: 'flex', justifyContent: 'flex-end' }}>
                  {l.unitPrice === null ? (
                    <input inputMode="decimal" value={prices[l.ingredientId] ?? ''}
                      onChange={(e) => setPrices({ ...prices, [l.ingredientId]: e.target.value })}
                      aria-label={'Invoiced price for ' + l.name}
                      disabled={!canPrice}
                      placeholder={price(l.provisionalCost)}
                      style={{ width: 110, height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--amber-line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO, textAlign: 'right' }} />
                  ) : <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>already priced</span>}
                </span>
              )}
              <span style={{ width: 92, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text-dim)' }}>
                {mvr(l.value)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 12, padding: '9px 0', fontWeight: 700 }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>
              {d.priced ? 'Invoiced' : 'Provisional value'}
            </span>
            <span style={{ fontSize: 14, fontFamily: MONO, color: 'var(--text)' }}>{mvr(d.total)}</span>
          </div>

          {detail.invoice && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.6 }}>
              Invoice {detail.invoice.invoiceNo} · due{' '}
              {new Date(detail.invoice.dueDate).toLocaleDateString('en-GB')} ·{' '}
              {mvr(detail.invoice.paid)} of {mvr(detail.invoice.amount)} paid
            </div>
          )}

          {!d.priced && (
            canPrice ? (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 180px), 1fr))', gap: 11 }}>
                  <L label="Invoice number" hint={'Due ' + d.termsDays + ' days from today on this supplier\'s terms.'}>
                    <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} style={inp} />
                  </L>
                </div>
                <button disabled={busy || !ready}
                  onClick={() => onPrice(
                    needed.map((l) => ({ ingredientId: l.ingredientId, unitPrice: Number(prices[l.ingredientId]) })),
                    invoiceNo)}
                  style={{ marginTop: 12, padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: ready ? 'var(--go)' : 'var(--bg-2)', color: ready ? 'var(--on-go)' : 'var(--text-faint)' }}>
                  {busy ? 'Queuing…' : 'Price it'}
                </button>
                {!ready && (
                  <span style={{ marginLeft: 10, fontSize: 10.5, color: 'var(--text-faint)' }}>
                    Every line needs a price — a half-priced delivery leaves the rest at a guess.
                  </span>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 14, padding: '9px 11px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)' }}>
                Pricing a delivery needs rank 4 — it moves value between accounts and settles what
                is owed. Receiving is a manager&apos;s job; agreeing the bill is not.
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/* ── ageing ──────────────────────────────────────────────────────────────── */

function AgeingView({ ageing, canPay, busy, onPay }: {
  ageing: Ageing; canPay: boolean; busy: boolean;
  onPay: (invoiceId: string, amount: number) => void;
}) {
  const [paying, setPaying] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  if (!ageing.invoices.length) {
    return <Empty title="Nothing outstanding"
      body="Every supplier invoice on record has been paid in full. Invoices appear here as soon as
            a delivery is priced, aged from the due date their supplier's own terms produce." />;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 14 }}>
        {ageing.buckets.map((b) => (
          <div key={b.key} style={{ padding: '9px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid ' + (b.key !== 'current' && ageing.totals[b.key] > 0 ? 'var(--amber-line)' : 'var(--line-soft)'), minWidth: 140 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
              {b.label.toUpperCase()}
            </div>
            <div style={{ marginTop: 2, fontSize: 15, fontWeight: 700, fontFamily: MONO, color: b.key !== 'current' && ageing.totals[b.key] > 0 ? 'var(--red-bright)' : 'var(--text)' }}>
              {mvr(ageing.totals[b.key] ?? 0)}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
        <div style={{ display: 'flex', gap: 12, padding: '8px 13px', background: 'var(--bg-2)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
          <span style={{ flex: 1 }}>SUPPLIER</span>
          <span style={{ width: 100 }}>DUE</span>
          <span style={{ width: 96, textAlign: 'right' }}>OUTSTANDING</span>
          <span style={{ width: canPay ? 190 : 0 }} />
        </div>
        {ageing.invoices.map((v) => (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{v.supplier}</span>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                invoice {v.invoiceNo}{v.grnNo && ' · ' + v.grnNo}
                {v.paid > 0 && ' · ' + mvr(v.paid) + ' of ' + mvr(v.amount) + ' paid'}
              </span>
            </span>
            <span style={{ width: 100, fontSize: 11, color: v.daysOver > 0 ? 'var(--red-bright)' : 'var(--text-faint)' }}>
              {new Date(v.dueDate).toLocaleDateString('en-GB')}
              <span style={{ display: 'block', fontSize: 9.5 }}>
                {v.daysOver > 0 ? v.daysOver + ' day' + (v.daysOver === 1 ? '' : 's') + ' over'
                  : 'in ' + Math.abs(v.daysOver) + ' day' + (v.daysOver === -1 ? '' : 's')}
              </span>
            </span>
            <span style={{ width: 96, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: v.daysOver > 0 ? 'var(--red-bright)' : 'var(--text)' }}>
              {mvr(v.outstanding)}
            </span>
            {canPay && (
              <span style={{ width: 190, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                {paying === v.id ? (
                  <>
                    <input autoFocus inputMode="decimal" value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-label={'Amount to pay ' + v.supplier}
                      style={{ width: 92, height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--amber-line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO, textAlign: 'right' }} />
                    <button disabled={busy || !(Number(amount) > 0)}
                      onClick={() => { onPay(v.id, Number(amount)); setPaying(null); setAmount(''); }}
                      style={{ padding: '6px 11px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>Pay</button>
                    <button onClick={() => { setPaying(null); setAmount(''); }}
                      style={{ padding: '6px 9px', borderRadius: 7, fontSize: 11.5, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>×</button>
                  </>
                ) : (
                  <button onClick={() => { setPaying(v.id); setAmount(String(v.outstanding)); }}
                    style={{ padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                    Record a payment
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const inp: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5,
};

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: on ? 700 : 600,
      background: on ? 'var(--bg-2)' : 'transparent',
      border: '1px solid ' + (on ? 'var(--line)' : 'transparent'),
      color: on ? 'var(--text)' : 'var(--text-faint)',
    }}>{children}</button>
  );
}

function Fig({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <span style={{ textAlign: 'right' }}>
      <span style={{ display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: strong ? 15 : 12.5, fontWeight: 700, fontFamily: MONO, color: warn ? 'var(--red-bright)' : strong ? 'var(--text)' : 'var(--text-dim)' }}>{value}</span>
    </span>
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

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: '54px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      <div style={{ margin: '9px auto 0', maxWidth: 470, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>{body}</div>
    </div>
  );
}
