import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';

/* Equipment & Maintenance — 02-POS-SPEC.md §2 (`assets`):
 * "Asset register, depreciation posting, service schedule."
 *
 * AN OVEN IS NOT AN EXPENSE. That sentence is the screen. Sixty thousand
 * rufiyaa entered as an operating cost lands in one month — that month reads as
 * a catastrophe, the next five years read as better than they were, and the
 * balance sheet never knows the restaurant owns an oven. So the form says, in
 * figures, what it will actually cost each month BEFORE you commit to it: an
 * operator who is about to type an oven into the wrong screen is not helped by
 * being told off afterwards.
 *
 * NET BOOK VALUE IS THE COLUMN THAT MATTERS and it is the one nobody can work
 * out from a cost and a date in their head. Cost is history; what a thing is
 * worth today is the question an owner actually asks.
 *
 * OVERDUE MAINTENANCE SITS ABOVE THE MONEY. A grease trap nobody serviced is
 * how a kitchen fails an inspection, and that is an operations fact before it
 * is ever a financial one.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) =>
  new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

interface Service {
  id: string; kind: 'service' | 'repair' | 'inspection'; dueOn: string;
  everyDays: number | null; doneOn: string | null; doneBy: string | null;
  note: string | null; expenseId: string | null; overdue: boolean;
}
interface Asset {
  id: string; tag: string | null; name: string; category: string | null;
  acquiredOn: string; cost: number; residual: number; lifeMonths: number;
  method: string; supplier: string | null; serial: string | null;
  location: string | null; note: string | null; status: 'active' | 'disposed';
  by: string | null; monthly: number; depreciatedMonths: number; monthsLeft: number;
  accumulated: number; netBook: number; fullyDepreciated: boolean;
  disposedOn: string | null; proceeds: number | null;
  services: Service[];
  nextService: { id: string; kind: string; dueOn: string; overdue: boolean } | null;
}
interface Overdue {
  assetId: string; serviceId: string; name: string; kind: string;
  dueOn: string; daysLate: number;
}
interface Data {
  assets: Asset[];
  totals: { count: number; cost: number; netBook: number; monthly: number };
  overdue: Overdue[];
  canManage: boolean;
}
interface Entry {
  jvNo: string; date: string; memo: string;
  account: string; accountName: string; dr: number; cr: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function Assets({ session, search }: { session: Session; search?: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [showDisposed, setShowDisposed] = useState(false);
  const [open, setOpen] = useState<Asset | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', '/assets' + (showDisposed ? '?disposed=1' : '')));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the register.');
      setData(null);
    }
  }, [call, showDisposed]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 9000); };

  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const depreciate = () => act(async () => {
    const r = await call<{ charged: Array<{ name: string }>; total: number; period: string }>(
      'POST', '/assets/depreciate', { period: thisMonth() });
    say(r.charged.length
      ? 'Charged ' + mvr(r.total) + ' across ' + r.charged.length
        + (r.charged.length === 1 ? ' asset' : ' assets') + ' for ' + r.period + '.'
      : 'Nothing left to charge for ' + r.period + ' — it has already been run.'
        + ' Running it twice does not charge the month twice.');
  }, '');

  const openAsset = async (a: Asset) => {
    setOpen(a); setEntries(null);
    try {
      const r = await call<{ entries: Entry[] }>('GET', `/assets/${a.id}/history`);
      setEntries(r.entries);
    } catch { setEntries([]); }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Equipment</span>
        {data && data.totals.count > 0 && (
          <>
            <Fig label="WORTH NOW" value={mvr(data.totals.netBook)} />
            <Fig label="COST A MONTH" value={mvr(data.totals.monthly)} />
          </>
        )}
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-faint)' }}>
          <input type="checkbox" checked={showDisposed}
            onChange={(e) => setShowDisposed(e.target.checked)} />
          show disposed
        </label>
        {data?.canManage && data.totals.count > 0 && (
          <button disabled={busy} onClick={depreciate}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
            Charge {thisMonth()}
          </button>
        )}
      </div>

      {(error || flash) && (
        <div style={{ flexShrink: 0, padding: '8px 14px', fontSize: 11.5, lineHeight: 1.5, background: error ? 'var(--stop-dim)' : 'var(--go-dim)', color: error ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
          {error || flash}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 40px' }}>
        {!data ? (
          <div style={{ padding: '40px 4px', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {error ? '' : 'Loading…'}
          </div>
        ) : (
          <>
            {data.overdue.length > 0 && (
              <div style={{ marginBottom: 14, padding: 13, borderRadius: 10, background: 'var(--stop-dim)', border: '1px solid var(--stop)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--stop-bright)' }}>
                  {data.overdue.length} {data.overdue.length === 1 ? 'job is' : 'jobs are'} overdue
                </div>
                <p style={{ margin: '4px 0 8px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 560 }}>
                  A grease trap nobody serviced is how a kitchen fails an inspection. This is an
                  operations problem before it is a money one.
                </p>
                {/* Each one OPENS the machine it belongs to. A banner that names
                    an overdue job and then leaves you to find it in the list
                    below is a dead end, and the thing it is warning about is
                    exactly the thing somebody is about to go and deal with. */}
                {data.overdue.map((o) => (
                  <button key={o.serviceId}
                    onClick={() => {
                      const a = data.assets.find((x) => x.id === o.assetId);
                      if (a) void openAsset(a);
                    }}
                    style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: 10, padding: '5px 0', borderTop: '1px solid var(--line-soft)', background: 'transparent', textAlign: 'left' }}>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>
                      {o.name}
                      <span style={{ marginLeft: 7, fontSize: 10, color: 'var(--text-faint)' }}>
                        {o.kind}
                      </span>
                    </span>
                    <span style={{ fontSize: 10.5, fontFamily: MONO, color: 'var(--stop-bright)' }}>
                      due {day(o.dueOn)} · {o.daysLate} day{o.daysLate === 1 ? '' : 's'} late
                    </span>
                  </button>
                ))}
              </div>
            )}

            {data.canManage && (
              <Buy busy={busy} onAdd={(b) => act(() => call('POST', '/assets', b),
                'Capitalised. It costs the P&L a slice a month, not all of it today.')} />
            )}

            {!data.assets.length ? (
              <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 580 }}>
                Nothing on the register. An oven, a chiller or a delivery bike is not an operating
                cost — entered as one, the whole price lands in a single month and the balance
                sheet never records that the business owns it. Put it here instead and it is
                charged a month at a time over its life.
              </div>
            ) : (
              <>
                <SubHead>The register</SubHead>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '0 2px 5px', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                  <span style={{ flex: 1 }}>WHAT</span>
                  <span style={{ width: 96, textAlign: 'right' }}>COST</span>
                  <span style={{ width: 96, textAlign: 'right' }}>WORTH NOW</span>
                  <span style={{ width: 90, textAlign: 'right' }}>A MONTH</span>
                  <span style={{ width: 78, textAlign: 'right' }}>LEFT</span>
                </div>
                {data.assets.filter((a) => hit(search, a.name, a.tag, a.category, a.location, a.serial, a.supplier)).map((a) => (
                  <button key={a.id} onClick={() => void openAsset(a)}
                    style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 2px', borderBottom: '1px solid var(--line-soft)', background: 'transparent', textAlign: 'left' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: a.status === 'disposed' ? 'var(--text-faint)' : 'var(--text)' }}>
                        {a.name}
                        {a.status === 'disposed' && (
                          <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em' }}>
                            GONE {a.disposedOn ? day(a.disposedOn) : ''}
                          </span>
                        )}
                        {a.nextService?.overdue && (
                          <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--stop-bright)' }}>
                            SERVICE OVERDUE
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {a.category || 'equipment'} · bought {day(a.acquiredOn)}
                        {a.serial && ' · ' + a.serial}
                        {a.location && ' · ' + a.location}
                      </span>
                    </span>
                    <span style={{ width: 96, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      {mvr(a.cost)}
                    </span>
                    {/* The column an owner actually asks for, and the one
                        nobody can work out from a cost and a date. */}
                    <span style={{ width: 96, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                      {mvr(a.netBook)}
                    </span>
                    <span style={{ width: 90, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: 'var(--text-muted)' }}>
                      {a.fullyDepreciated ? '—' : mvr(a.monthly)}
                    </span>
                    <span style={{ width: 78, textAlign: 'right', fontSize: 10.5, color: 'var(--text-faint)' }}>
                      {a.status === 'disposed' ? '' : a.fullyDepreciated
                        ? 'written down' : a.monthsLeft + ' mo'}
                    </span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {open && (
        <Sheet asset={open} entries={entries} busy={busy} canManage={!!data?.canManage}
          onClose={() => { setOpen(null); setEntries(null); }}
          onSchedule={(b) => act(() => call('POST', '/assets/services',
            { ...b, assetId: open.id }), 'Scheduled.').then(() => setOpen(null))}
          onDone={(id, b) => act(() => call('POST', `/assets/services/${id}/done`, b),
            'Marked done.').then(() => setOpen(null))}
          onDrop={(id) => act(() => call('DELETE', `/assets/services/${id}`), 'Removed.')
            .then(() => setOpen(null))}
          /* The sentence is composed HERE, from the figures the server returned,
             rather than echoing its `message`: the server formats money plainly
             and every other figure on this screen is grouped, so an echoed
             message reads as 19000.00 beside a column of 19,000.00. */
          onDispose={(b) => act(async () => {
            const r = await call<{ result: number; netBook: number; name: string }>(
              'POST', `/assets/${open.id}/dispose`, b);
            say(r.result === 0
              ? r.name + ' went for exactly what it was worth on the books.'
              : (r.result > 0
                ? 'A gain of ' + mvr(r.result) + ' on ' + r.name + ' — credited to 6310,'
                  + ' not to sales.'
                : 'A loss of ' + mvr(-r.result) + ' on ' + r.name + ' — it was worth '
                  + mvr(r.netBook) + ' on the books.'));
          }, '').then(() => setOpen(null))} />
      )}
    </div>
  );
}

/* ── buying one ──────────────────────────────────────────────────────────── */

function Buy({ busy, onAdd }: { busy: boolean; onAdd: (b: Record<string, unknown>) => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [cost, setCost] = useState('');
  const [life, setLife] = useState('60');
  const [residual, setResidual] = useState('');
  const [acquiredOn, setAcquiredOn] = useState(today());
  const [method, setMethod] = useState('bank');
  const [serial, setSerial] = useState('');

  const costN = Number(cost);
  const lifeN = Number(life);
  const residualN = Number(residual) || 0;
  const ok = name.trim() !== '' && costN > 0
    && Number.isInteger(lifeN) && lifeN >= 1 && lifeN <= 600
    && residualN < costN;
  const monthly = ok ? (costN - residualN) / lifeN : 0;

  return (
    <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 11 }}>
        <L label="What is it">
          <input value={name} onChange={(e) => setName(e.target.value)}
            aria-label="What is it" style={inp} />
        </L>
        <L label="Kind">
          <input value={category} onChange={(e) => setCategory(e.target.value)}
            placeholder="kitchen, front of house…" aria-label="Kind" style={inp} />
        </L>
        <L label="Cost (MVR)">
          <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)}
            aria-label="Cost" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Life (months)" hint="How long it will earn its keep.">
          <input inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value)}
            aria-label="Life in months" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Worth at the end" hint="Leave blank if it will be worth nothing.">
          <input inputMode="decimal" value={residual} onChange={(e) => setResidual(e.target.value)}
            aria-label="Worth at the end" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Bought on">
          <input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)}
            aria-label="Bought on" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Paid">
          <select value={method} onChange={(e) => setMethod(e.target.value)}
            aria-label="How it was paid" style={inp}>
            <option value="bank">from the bank</option>
            <option value="cash">from the drawer</option>
            <option value="credit">on account — owed</option>
          </select>
        </L>
        <L label="Serial">
          <input value={serial} onChange={(e) => setSerial(e.target.value)}
            aria-label="Serial" style={inp} />
        </L>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button disabled={busy || !ok} onClick={() => {
          onAdd({ name, category: category || null, cost: costN, lifeMonths: lifeN,
            residual: residualN, acquiredOn, method, serial: serial || null });
          setName(''); setCost(''); setResidual(''); setSerial(''); setCategory('');
        }}
          style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          Put it on the register
        </button>
        {/* Said BEFORE the operator commits. Somebody about to type an oven
            into the operating-costs screen is not helped by being told off
            afterwards. */}
        {ok && (
          <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 460 }}>
            Costs the P&amp;L <b style={{ color: 'var(--text-muted)', fontFamily: MONO }}>{mvr(monthly)}</b> a
            month for {lifeN} months — not {mvr(costN)} this one. The other {mvr(costN - monthly)} sits
            on the balance sheet as something the business owns.
          </span>
        )}
      </div>
    </div>
  );
}

/* ── one asset ───────────────────────────────────────────────────────────── */

function Sheet({ asset, entries, busy, canManage, onClose, onSchedule, onDone, onDrop, onDispose }: {
  asset: Asset; entries: Entry[] | null; busy: boolean; canManage: boolean;
  onClose: () => void;
  onSchedule: (b: Record<string, unknown>) => void;
  onDone: (id: string, b: Record<string, unknown>) => void;
  onDrop: (id: string) => void;
  onDispose: (b: Record<string, unknown>) => void;
}) {
  const [tab, setTab] = useState<'jobs' | 'ledger' | 'dispose'>('jobs');
  const waiting = asset.services.filter((s) => !s.doneOn);
  const done = asset.services.filter((s) => s.doneOn);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Asset"
        style={{ width: '100%', maxWidth: 700, maxHeight: '88dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{asset.name}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            bought {day(asset.acquiredOn)}{asset.supplier && ' · ' + asset.supplier}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flexShrink: 0, padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <Fig label="COST" value={mvr(asset.cost)} />
          <Fig label="CHARGED SO FAR" value={mvr(asset.accumulated)} />
          <Fig label="WORTH NOW" value={mvr(asset.netBook)} big />
          <Fig label="A MONTH" value={asset.fullyDepreciated ? '—' : mvr(asset.monthly)} />
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            {asset.status === 'disposed'
              ? 'Disposed of ' + (asset.disposedOn ? day(asset.disposedOn) : '')
                + (asset.proceeds ? ' for ' + mvr(asset.proceeds) : '')
              : asset.depreciatedMonths + ' of ' + asset.lifeMonths + ' months charged'
                + (asset.residual ? ' · stops at ' + mvr(asset.residual) : '')}
          </span>
        </div>

        <div style={{ flexShrink: 0, padding: '8px 16px', display: 'flex', gap: 4 }}>
          <TabBtn on={tab === 'jobs'} onClick={() => setTab('jobs')}>
            Maintenance{waiting.length ? ' · ' + waiting.length : ''}
          </TabBtn>
          <TabBtn on={tab === 'ledger'} onClick={() => setTab('ledger')}>In the ledger</TabBtn>
          {canManage && asset.status === 'active' && (
            <TabBtn on={tab === 'dispose'} onClick={() => setTab('dispose')}>Sell or scrap</TabBtn>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 16px 16px' }}>
          {tab === 'jobs' && (
            <Jobs asset={asset} waiting={waiting} done={done} busy={busy}
              onSchedule={onSchedule} onDone={onDone} onDrop={onDrop} />
          )}
          {tab === 'ledger' && (
            !entries ? (
              <div style={{ padding: '20px 2px', fontSize: 12, color: 'var(--text-faint)' }}>Loading…</div>
            ) : !entries.length ? (
              <div style={{ padding: '20px 2px', fontSize: 12, color: 'var(--text-faint)' }}>
                Nothing posted against it.
              </div>
            ) : entries.map((e, i) => (
              <div key={e.jvNo + i} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ width: 60, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                  {day(e.date)}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text)' }}>
                  {e.accountName}
                  <span style={{ marginLeft: 6, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                    {e.account}
                  </span>
                </span>
                <span style={{ width: 90, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: e.dr ? 'var(--text)' : 'var(--text-faint)' }}>
                  {e.dr ? mvr(e.dr) : ''}
                </span>
                <span style={{ width: 90, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: e.cr ? 'var(--text)' : 'var(--text-faint)' }}>
                  {e.cr ? mvr(e.cr) : ''}
                </span>
              </div>
            ))
          )}
          {tab === 'dispose' && <Dispose asset={asset} busy={busy} onDispose={onDispose} />}
        </div>
      </div>
    </div>
  );
}

function Jobs({ asset, waiting, done, busy, onSchedule, onDone, onDrop }: {
  asset: Asset; waiting: Service[]; done: Service[]; busy: boolean;
  onSchedule: (b: Record<string, unknown>) => void;
  onDone: (id: string, b: Record<string, unknown>) => void;
  onDrop: (id: string) => void;
}) {
  const [kind, setKind] = useState('service');
  const [dueOn, setDueOn] = useState(today());
  const [every, setEvery] = useState('');
  const [note, setNote] = useState('');
  const [doing, setDoing] = useState<string | null>(null);
  const [cost, setCost] = useState('');
  const [method, setMethod] = useState('cash');

  return (
    <>
      {asset.status === 'active' && (
        <div style={{ margin: '8px 0 14px', padding: 12, borderRadius: 9, background: 'var(--bg-2)', border: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 130px), 1fr))', gap: 10 }}>
            <L label="Job">
              <select value={kind} onChange={(e) => setKind(e.target.value)}
                aria-label="Job" style={inp}>
                <option value="service">service</option>
                <option value="inspection">inspection</option>
                <option value="repair">repair</option>
              </select>
            </L>
            <L label="Due">
              <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)}
                aria-label="Due" style={{ ...inp, fontFamily: MONO }} />
            </L>
            <L label="Repeat (days)" hint="Blank for a one-off.">
              <input inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)}
                aria-label="Repeat every days" style={{ ...inp, fontFamily: MONO }} />
            </L>
            <L label="Note">
              <input value={note} onChange={(e) => setNote(e.target.value)}
                aria-label="Note" style={inp} />
            </L>
          </div>
          <button disabled={busy} onClick={() => {
            onSchedule({ kind, dueOn, everyDays: every ? Number(every) : null, note: note || null });
          }}
            style={{ marginTop: 10, padding: '8px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
            Put it in the diary
          </button>
        </div>
      )}

      {waiting.length > 0 && <SubHead>Waiting</SubHead>}
      {waiting.map((s) => (
        <div key={s.id} style={{ padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>
              {s.kind}
              {s.note && <span style={{ color: 'var(--text-faint)' }}> · {s.note}</span>}
              {s.everyDays && (
                <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-faint)' }}>
                  every {s.everyDays} days
                </span>
              )}
            </span>
            <span style={{ fontSize: 11, fontFamily: MONO, color: s.overdue ? 'var(--stop-bright)' : 'var(--text-faint)' }}>
              due {day(s.dueOn)}
            </span>
            <button disabled={busy} onClick={() => setDoing(doing === s.id ? null : s.id)}
              style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
              Done
            </button>
            <button disabled={busy} onClick={() => onDrop(s.id)}
              style={{ padding: '5px 9px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
              Remove
            </button>
          </div>
          {doing === s.id && (
            <div style={{ marginTop: 9, padding: 11, borderRadius: 8, background: 'var(--bg-2)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 130px), 1fr))', gap: 10 }}>
                <L label="What it cost" hint="Leave blank if it cost nothing.">
                  <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)}
                    aria-label="What it cost" style={{ ...inp, fontFamily: MONO }} />
                </L>
                <L label="Paid">
                  <select value={method} onChange={(e) => setMethod(e.target.value)}
                    aria-label="Paid" style={inp}>
                    <option value="cash">from the drawer</option>
                    <option value="bank">from the bank</option>
                    <option value="credit">on account — owed</option>
                  </select>
                </L>
              </div>
              <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button disabled={busy} onClick={() => onDone(s.id, {
                  doneOn: today(), cost: Number(cost) || 0, method,
                })}
                  style={{ padding: '8px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                  Mark it done
                </button>
                {/* Not a second place to type a repair — the same row. */}
                {Number(cost) > 0 && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)', maxWidth: 380, lineHeight: 1.5 }}>
                    Books {mvr(Number(cost))} to 6190 Repairs. It appears on the Operating Costs
                    list as this same entry, not a second one.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      ))}

      {done.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <SubHead>Done</SubHead>
          {done.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 2px', borderBottom: '1px solid var(--line-soft)', color: 'var(--text-faint)' }}>
              <span style={{ flex: 1, fontSize: 11.5 }}>
                {s.kind}{s.note && ' · ' + s.note}
              </span>
              {s.expenseId && <span style={{ fontSize: 10 }}>charged to repairs</span>}
              <span style={{ fontSize: 10.5, fontFamily: MONO }}>{s.doneOn ? day(s.doneOn) : ''}</span>
              <span style={{ width: 110, textAlign: 'right', fontSize: 10.5 }}>{s.doneBy || ''}</span>
            </div>
          ))}
        </div>
      )}

      {!waiting.length && !done.length && (
        <div style={{ padding: '20px 2px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)', maxWidth: 500 }}>
          Nothing in the diary for this one. A service that only exists in somebody&apos;s memory
          is a service that gets missed the week they are on leave.
        </div>
      )}
    </>
  );
}

function Dispose({ asset, busy, onDispose }: {
  asset: Asset; busy: boolean; onDispose: (b: Record<string, unknown>) => void;
}) {
  const [proceeds, setProceeds] = useState('');
  const [on, setOn] = useState(today());
  const [method, setMethod] = useState('bank');
  const got = Number(proceeds) || 0;
  const result = got - asset.netBook;

  return (
    <div style={{ padding: '10px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 140px), 1fr))', gap: 11 }}>
        <L label="What you got (MVR)" hint="Nought if it was scrapped.">
          <input inputMode="decimal" value={proceeds} onChange={(e) => setProceeds(e.target.value)}
            aria-label="What you got" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="On">
          <input type="date" value={on} onChange={(e) => setOn(e.target.value)}
            aria-label="Disposed on" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Paid into">
          <select value={method} onChange={(e) => setMethod(e.target.value)}
            aria-label="Paid into" style={inp}>
            <option value="bank">the bank</option>
            <option value="cash">the drawer</option>
            <option value="credit">still owed to us</option>
          </select>
        </L>
      </div>
      {/* The consequence, before the button, in the words of the ledger. */}
      <p style={{ margin: '12px 2px 0', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)', maxWidth: 520 }}>
        It is worth <b style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{mvr(asset.netBook)}</b> on
        the books.{' '}
        {result === 0 ? 'Selling it for that is neither a gain nor a loss.'
          : result > 0
            ? 'A gain of ' + mvr(result) + ' — credited to 6310 Gain or loss on disposal.'
              + ' It is not revenue and never reaches the sales line.'
            : 'A loss of ' + mvr(-result) + ' — charged to 6310 Gain or loss on disposal,'
              + ' not buried in repairs.'}
      </p>
      <button disabled={busy} onClick={() => onDispose({ on, proceeds: got, method })}
        style={{ marginTop: 12, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--stop)', color: 'var(--on-stop, #fff)' }}>
        Take it off the register
      </button>
    </div>
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

function Fig({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: big ? 20 : 14, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{value}</span>
    </span>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: '0 2px 6px', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
      {children}
    </div>
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
