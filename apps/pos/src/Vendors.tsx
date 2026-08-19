import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Vendors — 02-POS-SPEC.md §2: "Supplier master, terms, price history."
 *
 * The supplier master is chain-wide on purpose: a group that had to re-enter
 * its fish supplier at every branch ends up with four spellings of one company
 * and no way to see what any of them charge. The PRICE HISTORY, though, is this
 * outlet's — what this kitchen has actually been charged — because that is the
 * number a chef argues with.
 *
 * "Up 50% since you last bought it" is the whole point of the screen. A column
 * of prices is data; a direction of travel is a decision.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

interface Supplier { id: string; name: string; trn: string | null; termsDays: number; active: boolean }
interface Detail {
  supplier: Supplier & { owed: number };
  deliveries: Array<{ id: string; grnNo: string; at: string; total: number; priced: boolean; lines: number }>;
  priceHistory: Array<{
    ingredientId: string; name: string; unit: string | null;
    latest: number; previous: number | null; changePct: number | null;
    prices: Array<{ at: string; grnNo: string; unitPrice: number; qty: number }>;
  }>;
}

export function Vendors({ session }: { session: Session }) {
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', trn: '', termsDays: '30' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /* One helper, one BASE — see api.authed. Each of these screens used to
     write its own fetch('/api/...'), which resolves only behind the Vite
     proxy; deployed on its own origin every one of them would have 404'd. */
  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      const j = await call('GET', '/vendors') as { suppliers: Supplier[] };
      setRows(j.suppliers); setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the supplier list.');
      setRows([]);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const canWrite = session.rank >= 4;

  const add = async () => {
    setBusy(true); setError('');
    try {
      await call('POST', '/vendors', {
        name: form.name, trn: form.trn || null, termsDays: Number(form.termsDays) || 30,
      });
      setForm({ name: '', trn: '', termsDays: '30' }); setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  const setTerms = async (id: string, termsDays: number) => {
    setBusy(true); setError('');
    try { await call('PATCH', '/vendors/' + id, { termsDays }); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Vendors</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          shared across the estate — one supplier, one record, wherever they deliver
        </span>
        <span style={{ flex: 1 }} />
        {canWrite && !adding && (
          <button onClick={() => setAdding(true)}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Add a supplier
          </button>
        )}
      </div>

      {error && (
        <div role="status" style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--red-dim)', color: 'var(--red-bright)' }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {adding && (
          <form onSubmit={(e) => { e.preventDefault(); void add(); }}
            style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 160px), 1fr))', gap: 11 }}>
              <L label="Name"><input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inp} placeholder="Malé Fish Co" /></L>
              <L label="TRN" hint="Their tax registration number, for the invoices you file."><input value={form.trn} onChange={(e) => setForm({ ...form, trn: e.target.value })} style={inp} /></L>
              <L label="Payment terms (days)" hint="How long after an invoice it falls due. Ageing is measured from that date, not from the invoice.">
                <input inputMode="numeric" value={form.termsDays} onChange={(e) => setForm({ ...form, termsDays: e.target.value })} style={{ ...inp, fontFamily: MONO }} />
              </L>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button type="submit" disabled={busy || !form.name.trim()}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                {busy ? 'Saving…' : 'Add it'}
              </button>
              <button type="button" onClick={() => setAdding(false)}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>Cancel</button>
            </div>
          </form>
        )}

        {rows === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>Loading…</div>
        ) : !rows.length ? (
          <div style={{ padding: '54px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>No suppliers yet</div>
            <div style={{ margin: '9px auto 0', maxWidth: 470, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
              A supplier carries the payment terms that decide when an invoice falls due, and it is
              what a delivery is received against. Without one there is nobody to owe and nobody to
              ring when the fish is short.
              {!canWrite && ' Adding one needs rank 4.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
            {rows.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)' }}>
                <button onClick={() => void (async () => {
                  try { setDetail(await call('GET', '/vendors/' + s.id) as Detail); }
                  catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open it.'); }
                })()}
                  style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.name}</span>
                    {!s.active && <Tag>Inactive</Tag>}
                  </span>
                  <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {s.trn ? 'TRN ' + s.trn + ' · ' : ''}{s.termsDays} day terms
                  </span>
                </button>
                {canWrite && (
                  <TermsCell value={s.termsDays} onSave={(v) => void setTerms(s.id, v)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {detail && <SupplierSheet detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function SupplierSheet({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const s = detail.supplier;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={s.name}
        style={{ width: '100%', maxWidth: 640, maxHeight: '86dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{s.name}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          <div style={{ display: 'flex', gap: 22, marginBottom: 14 }}>
            <Fig label="OWED" value={mvr(s.owed)} strong={s.owed > 0} />
            <Fig label="TERMS" value={s.termsDays + ' days'} />
            <Fig label="DELIVERIES" value={String(detail.deliveries.length)} />
          </div>

          <Head>What they charge</Head>
          {!detail.priceHistory.length ? (
            <Note>Nothing priced from this supplier yet. Prices appear here as deliveries are
              invoiced, and the second one starts telling you which way they are moving.</Note>
          ) : (
            detail.priceHistory.map((h) => (
              <div key={h.ingredientId} style={{ padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                    {h.name} <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-faint)' }}>per {h.unit}</span>
                  </span>
                  {/* The direction of travel — the reason this screen exists. */}
                  {h.changePct !== null && h.changePct !== 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: h.changePct > 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
                      {h.changePct > 0 ? '↑' : '↓'} {Math.abs(h.changePct)}%
                    </span>
                  )}
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                    {price(h.latest)}
                  </span>
                </div>
                <div style={{ marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {h.prices.slice(0, 6).map((p, i) => (
                    <span key={i} style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: MONO }}>
                      {new Date(p.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                      {' '}{price(p.unitPrice)}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}

          <div style={{ marginTop: 16 }}>
            <Head>Deliveries</Head>
            {!detail.deliveries.length ? (
              <Note>Nothing received from them yet.</Note>
            ) : detail.deliveries.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12, fontFamily: MONO, color: 'var(--text)' }}>{d.grnNo}</span>
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                    {new Date(d.at).toLocaleDateString('en-GB')} · {d.lines} line{d.lines === 1 ? '' : 's'}
                    {!d.priced && ' · not priced yet'}
                  </span>
                </span>
                <span style={{ fontSize: 12.5, fontFamily: MONO, color: d.priced ? 'var(--text-dim)' : 'var(--warn-bright)' }}>
                  {mvr(d.total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const inp: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5,
};

function TermsCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setV(String(value)); }, [value]);
  return editing ? (
    <span style={{ display: 'flex', gap: 6 }}>
      <input autoFocus inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)}
        aria-label="Payment terms in days"
        style={{ ...inp, width: 72, height: 30, fontFamily: MONO, textAlign: 'right' }} />
      <button onClick={() => { setEditing(false); onSave(Number(v)); }}
        style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>Save</button>
    </span>
  ) : (
    <button onClick={() => setEditing(true)}
      style={{ width: 130, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-muted)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>
      {value} day terms
    </button>
  );
}

function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color: strong ? 'var(--red-bright)' : 'var(--text)' }}>{value}</span>
    </span>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: '0 0 6px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{children}</div>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '14px 2px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>{children}</div>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700, background: 'var(--bg-2)', color: 'var(--text-faint)' }}>{children}</span>;
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
