import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Customers & Credit — 02-POS-SPEC.md §2 (`customers`):
 * "Chain-wide profiles, loyalty tier, house-account credit ledger."
 *
 * THE PROFILE IS CHAIN-WIDE; THE DEBT IS NOT, and the screen says so rather
 * than letting somebody assume otherwise. A customer is recognised at any
 * outlet, but 1030 Customer receivable lives in this outlet's ledger, so what
 * is shown here is what is owed HERE. A company eating at three branches owes
 * three balances, and one number across the estate would be nobody's
 * receivable.
 *
 * WHAT A CASHIER NEEDS IS "CAN THIS GO ON THE ACCOUNT?" — which is not the
 * credit limit, it is what is LEFT of it. So the figure in the biggest type on
 * every row is what remains, not what was granted, and an account with nothing
 * left says so before anybody tries.
 *
 * THE AGED BOOK IS A MANAGER'S REPORT and it ages by allocation: a receipt
 * settles the oldest charge first. Aged on the net balance instead, a customer
 * who pays every month would drift further into the 90-day column for ever,
 * and a screen like that puts a good customer on stop.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) =>
  new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

interface Member {
  id: string; phone: string; name: string | null; company: string | null;
  email: string | null; note: string | null; tier: string; points: number;
  joinedAt: string; consentAt: string | null;
  creditLimit: number; termsDays: number; blocked: boolean;
  owed: number; available: number; overLimit: boolean; onAccount: boolean;
  charges: number; lastAt: string | null; already?: boolean;
}
interface AgeRow {
  id: string; name: string; company: string | null; owed: number;
  notYetDue: number; upTo30: number; upTo60: number; over60: number;
  creditLimit: number; overLimit: boolean;
}
interface Data {
  members: Member[];
  totals: { count: number; owed: number; onAccount: number; overLimit: number };
  ageing?: { rows: AgeRow[]; total: { owed: number; notYetDue: number; upTo30: number; upTo60: number; over60: number } };
  canCredit: boolean;
}
interface Entry {
  id: number; on: string; kind: 'charge' | 'receipt' | 'writeoff' | 'adjust';
  amount: number; docNo: string | null; method: string | null;
  note: string | null; by: string | null;
}
interface Statement {
  customer: Member; entries: Entry[]; owed: number;
  ageing: { notYetDue: number; upTo30: number; upTo60: number; over60: number; termsDays: number };
}

const KIND: Record<string, string> = {
  charge: 'on account', receipt: 'paid', writeoff: 'written off', adjust: 'adjusted',
};

const today = () => new Date().toISOString().slice(0, 10);

export function Customers({ session }: { session: Session }) {
  const [tab, setTab] = useState<'people' | 'owed'>('people');
  const [data, setData] = useState<Data | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Statement | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', '/customers' + (q ? '?q=' + encodeURIComponent(q) : '')));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load customers.');
      setData(null);
    }
  }, [call, q]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 9000); };

  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const openOne = async (id: string) => {
    try { setOpen(await call<Statement>('GET', `/customers/${id}`)); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open that.'); }
  };
  const reopen = async (id: string) => {
    await load();
    try { setOpen(await call<Statement>('GET', `/customers/${id}`)); } catch { setOpen(null); }
  };

  const owed = data?.ageing;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Customers</span>
        {owed && (
          <span style={{ display: 'flex', gap: 4 }}>
            <TabBtn on={tab === 'people'} onClick={() => setTab('people')}>Everyone</TabBtn>
            <TabBtn on={tab === 'owed'} onClick={() => setTab('owed')}>
              Owed to us{owed.total.owed ? ' · ' + mvr(owed.total.owed) : ''}
            </TabBtn>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or number…"
          aria-label="Find a customer"
          style={{ width: 190, height: 30, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12 }} />
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
        ) : tab === 'owed' && owed ? (
          <Owed owed={owed} onOpen={openOne} />
        ) : (
          <People data={data} busy={busy} onOpen={openOne}
            onAdd={(b) => act(async () => {
              const m = await call<Member>('POST', '/customers', b);
              say(m.already
                ? 'That number is already ' + (m.name || 'on file') + '.'
                : 'Added.');
            }, '')} />
        )}
      </div>

      {open && (
        <Sheet st={open} busy={busy} canCredit={!!data?.canCredit}
          onClose={() => setOpen(null)}
          onCredit={(b) => act(async () => {
            const r = await call<{ message?: string }>(
              'POST', `/customers/${open.customer.id}/credit`, b);
            if (r.message) say(r.message);
            await reopen(open.customer.id);
          }, 'Set.')}
          onReceipt={(b) => act(async () => {
            const r = await call<{ docNo: string; amount: number; message: string }>(
              'POST', `/customers/${open.customer.id}/receipt`, b);
            say(r.docNo + ' · ' + mvr(r.amount) + ' received. ' + r.message);
            await reopen(open.customer.id);
          }, '')}
          onWriteOff={(b) => act(async () => {
            const r = await call<{ amount: number }>(
              'POST', `/customers/${open.customer.id}/writeoff`, b);
            say(mvr(r.amount) + ' written off to 6400 Bad debt.');
            await reopen(open.customer.id);
          }, '')} />
      )}
    </div>
  );
}

/* ── everyone ────────────────────────────────────────────────────────────── */

function People({ data, busy, onAdd, onOpen }: {
  data: Data; busy: boolean;
  onAdd: (b: Record<string, unknown>) => void;
  onOpen: (id: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const ok = phone.trim().length >= 5;

  return (
    <>
      <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 11 }}>
          <L label="Phone">
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              aria-label="Phone" style={{ ...inp, fontFamily: MONO }} />
          </L>
          <L label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)}
              aria-label="Name" style={inp} />
          </L>
          <L label="Company" hint="If the bill goes to a company rather than a person.">
            <input value={company} onChange={(e) => setCompany(e.target.value)}
              aria-label="Company" style={inp} />
          </L>
        </div>
        <button disabled={busy || !ok} onClick={() => {
          onAdd({ phone: phone.trim(), name: name.trim() || null, company: company.trim() || null,
            consent: true });
          setPhone(''); setName(''); setCompany('');
        }}
          style={{ marginTop: 12, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          Add them
        </button>
      </div>

      {!data.members.length ? (
        <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 560 }}>
          Nobody on file. A customer here is a phone number with a name on it — enough to put a
          bill on a house account, take a payment against it, and know who is owed what.
        </div>
      ) : (
        <>
          <SubHead>On file</SubHead>
          {data.members.map((m) => (
            <button key={m.id} onClick={() => onOpen(m.id)}
              style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 2px', borderBottom: '1px solid var(--line-soft)', background: 'transparent', textAlign: 'left' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                  {m.name || m.phone}
                  {m.blocked && (
                    <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--stop-bright)' }}>
                      BLOCKED
                    </span>
                  )}
                  {m.overLimit && !m.blocked && (
                    <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--stop-bright)' }}>
                      OVER LIMIT
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  {m.phone}{m.company && ' · ' + m.company}
                  {m.onAccount && ' · ' + m.termsDays + ' day terms'}
                </span>
              </span>
              {m.onAccount ? (
                <>
                  <span style={{ width: 110, textAlign: 'right' }}>
                    <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                      OWES HERE
                    </span>
                    <span style={{ fontSize: 12, fontFamily: MONO, color: 'var(--text-muted)' }}>
                      {mvr(m.owed)}
                    </span>
                  </span>
                  {/* What a cashier actually needs — not the limit, what is
                      LEFT of it. */}
                  <span style={{ width: 110, textAlign: 'right' }}>
                    <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                      CAN CHARGE
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: m.available > 0 ? 'var(--text)' : 'var(--stop-bright)' }}>
                      {m.blocked ? '—' : mvr(m.available)}
                    </span>
                  </span>
                </>
              ) : (
                <span style={{ width: 220, textAlign: 'right', fontSize: 10.5, color: 'var(--text-faint)' }}>
                  no house account
                </span>
              )}
            </button>
          ))}
        </>
      )}
    </>
  );
}

/* ── the aged book ───────────────────────────────────────────────────────── */

function Owed({ owed, onOpen }: {
  owed: NonNullable<Data['ageing']>; onOpen: (id: string) => void;
}) {
  if (!owed.rows.length) {
    return (
      <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 560 }}>
        Nobody owes anything. What appears here is what has been put on a house account at this
        outlet and not yet paid — a debt belongs to the branch that served the food, because
        that is whose ledger carries it.
      </div>
    );
  }
  return (
    <>
      <p style={{ margin: '0 2px 10px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 620 }}>
        What is owed <b style={{ color: 'var(--text-muted)' }}>at this outlet</b>. A payment settles
        the oldest charge first, so a customer who pays every month stays in the first column
        instead of drifting into the last one for ever.
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '0 2px 5px', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
        <span style={{ flex: 1 }}>WHO</span>
        <span style={{ width: 92, textAlign: 'right' }}>NOT YET DUE</span>
        <span style={{ width: 82, textAlign: 'right' }}>1–30</span>
        <span style={{ width: 82, textAlign: 'right' }}>31–60</span>
        <span style={{ width: 82, textAlign: 'right' }}>60+</span>
        <span style={{ width: 96, textAlign: 'right' }}>OWED</span>
      </div>
      {owed.rows.map((r) => (
        <button key={r.id} onClick={() => onOpen(r.id)}
          style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)', background: 'transparent', textAlign: 'left' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
              {r.name}
              {r.overLimit && (
                <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--stop-bright)' }}>
                  OVER LIMIT
                </span>
              )}
            </span>
            {r.company && (
              <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{r.company}</span>
            )}
          </span>
          <Cell v={r.notYetDue} />
          <Cell v={r.upTo30} />
          <Cell v={r.upTo60} />
          <Cell v={r.over60} loud />
          <span style={{ width: 96, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
            {mvr(r.owed)}
          </span>
        </button>
      ))}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 2px' }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
          OWED AT THIS OUTLET
        </span>
        <Cell v={owed.total.notYetDue} />
        <Cell v={owed.total.upTo30} />
        <Cell v={owed.total.upTo60} />
        <Cell v={owed.total.over60} loud />
        <span style={{ width: 96, textAlign: 'right', fontSize: 17, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
          {mvr(owed.total.owed)}
        </span>
      </div>
    </>
  );
}

function Cell({ v, loud }: { v: number; loud?: boolean }) {
  return (
    <span style={{ width: loud ? 82 : 82, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: v === 0 ? 'var(--text-faint)' : loud ? 'var(--stop-bright)' : 'var(--text-muted)' }}>
      {v === 0 ? '—' : mvr(v)}
    </span>
  );
}

/* ── one customer ────────────────────────────────────────────────────────── */

function Sheet({ st, busy, canCredit, onClose, onCredit, onReceipt, onWriteOff }: {
  st: Statement; busy: boolean; canCredit: boolean; onClose: () => void;
  onCredit: (b: Record<string, unknown>) => void;
  onReceipt: (b: Record<string, unknown>) => void;
  onWriteOff: (b: Record<string, unknown>) => void;
}) {
  const m = st.customer;
  const [tab, setTab] = useState<'account' | 'terms'>('account');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [on, setOn] = useState(today());
  const [limit, setLimit] = useState(String(m.creditLimit || ''));
  const [terms, setTerms] = useState(String(m.termsDays || 0));
  const [blocked, setBlocked] = useState(m.blocked);
  const [reason, setReason] = useState('');

  const pay = Number(amount) || 0;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Customer"
        style={{ width: '100%', maxWidth: 680, maxHeight: '88dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
            {m.name || m.phone}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            {m.phone}{m.company && ' · ' + m.company}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flexShrink: 0, padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <Fig label="OWES HERE" value={mvr(st.owed)} big />
          <Fig label="LIMIT" value={m.creditLimit ? mvr(m.creditLimit) : 'none'} />
          <Fig label="CAN CHARGE" value={m.blocked ? '—' : mvr(m.available)} />
          {/* Said plainly, because it is the thing most likely to be assumed
              wrong: the person is chain-wide, the debt is not. */}
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 260 }}>
            This is what they owe at this outlet. Another branch keeps its own.
          </span>
        </div>

        <div style={{ flexShrink: 0, padding: '8px 16px', display: 'flex', gap: 4 }}>
          <TabBtn on={tab === 'account'} onClick={() => setTab('account')}>The account</TabBtn>
          {canCredit && (
            <TabBtn on={tab === 'terms'} onClick={() => setTab('terms')}>Credit &amp; terms</TabBtn>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 16px 16px' }}>
          {tab === 'account' ? (
            <>
              {st.owed > 0 && (
                <div style={{ margin: '8px 0 14px', padding: 12, borderRadius: 9, background: 'var(--bg-2)', border: '1px solid var(--line-soft)' }}>
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 11 }}>
                    <Fig label="NOT YET DUE" value={mvr(st.ageing.notYetDue)} />
                    <Fig label="1–30" value={mvr(st.ageing.upTo30)} />
                    <Fig label="31–60" value={mvr(st.ageing.upTo60)} />
                    <Fig label="60+" value={mvr(st.ageing.over60)} />
                    <span style={{ fontSize: 10, color: 'var(--text-faint)', alignSelf: 'center' }}>
                      {st.ageing.termsDays} day terms
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 130px), 1fr))', gap: 10 }}>
                    <L label="They paid (MVR)">
                      <input inputMode="decimal" value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        aria-label="They paid" style={{ ...inp, fontFamily: MONO }} />
                    </L>
                    <L label="Into">
                      <select value={method} onChange={(e) => setMethod(e.target.value)}
                        aria-label="Into" style={inp}>
                        <option value="cash">the drawer</option>
                        <option value="bank">the bank</option>
                        <option value="card">a card</option>
                      </select>
                    </L>
                    <L label="On">
                      <input type="date" value={on} onChange={(e) => setOn(e.target.value)}
                        aria-label="Paid on" style={{ ...inp, fontFamily: MONO }} />
                    </L>
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <button disabled={busy || !(pay > 0) || pay > st.owed}
                      onClick={() => { onReceipt({ amount: pay, method, on }); setAmount(''); }}
                      style={{ padding: '8px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: pay > 0 && pay <= st.owed ? 'var(--go)' : 'var(--bg-2)', color: pay > 0 && pay <= st.owed ? 'var(--on-go)' : 'var(--text-faint)' }}>
                      Take the payment
                    </button>
                    {pay > st.owed && (
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)', maxWidth: 360, lineHeight: 1.5 }}>
                        That is more than the {mvr(st.owed)} owed. Anything beyond a debt is a
                        deposit, not a payment, and would turn the receivable negative.
                      </span>
                    )}
                    {pay > 0 && pay <= st.owed && (
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                        Leaves {mvr(st.owed - pay)} outstanding.
                      </span>
                    )}
                  </div>
                </div>
              )}

              <SubHead>Every entry</SubHead>
              {!st.entries.length ? (
                <div style={{ padding: '20px 2px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)', maxWidth: 500 }}>
                  Nothing has been charged to this account.
                </div>
              ) : st.entries.map((e) => (
                <div key={e.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                  <span style={{ width: 62, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                    {day(e.on)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text)' }}>
                    {KIND[e.kind]}
                    {e.docNo && (
                      <span style={{ marginLeft: 6, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                        {e.docNo}
                      </span>
                    )}
                    {e.note && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-faint)' }}>
                        {e.note}
                      </span>
                    )}
                  </span>
                  <span style={{ width: 100, textAlign: 'right', fontSize: 12.5, fontWeight: 600, fontFamily: MONO, color: e.amount > 0 ? 'var(--text)' : 'var(--go-bright)' }}>
                    {e.amount > 0 ? mvr(e.amount) : '(' + mvr(-e.amount) + ')'}
                  </span>
                  <span style={{ width: 96, textAlign: 'right', fontSize: 10, color: 'var(--text-faint)' }}>
                    {e.by || ''}
                  </span>
                </div>
              ))}
            </>
          ) : (
            <div style={{ padding: '10px 0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 140px), 1fr))', gap: 11 }}>
                <L label="Credit limit (MVR)" hint="Nought means no house account at all.">
                  <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)}
                    aria-label="Credit limit" style={{ ...inp, fontFamily: MONO }} />
                </L>
                <L label="Terms (days)" hint="How long they have before a charge is overdue.">
                  <input inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)}
                    aria-label="Terms in days" style={{ ...inp, fontFamily: MONO }} />
                </L>
                <L label="Blocked">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, height: 34, fontSize: 12, color: 'var(--text-muted)' }}>
                    <input type="checkbox" checked={blocked}
                      onChange={(e) => setBlocked(e.target.checked)} />
                    stop new charges
                  </label>
                </L>
              </div>
              <button disabled={busy}
                onClick={() => onCredit({ creditLimit: Number(limit) || 0, termsDays: Number(terms) || 0, blocked })}
                style={{ marginTop: 12, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                Set the account
              </button>
              {Number(limit) > 0 && st.owed > Number(limit) && (
                <p style={{ margin: '10px 2px 0', fontSize: 11, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 480 }}>
                  They already owe {mvr(st.owed)}, which is over that. Nothing is clawed back —
                  it only stops the next charge.
                </p>
              )}

              {st.owed > 0 && (
                <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
                  <SubHead>Give up on it</SubHead>
                  <p style={{ margin: '0 2px 9px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 500 }}>
                    Writing off {mvr(st.owed)} charges it to 6400 Bad debt and clears the
                    receivable. It is the one entry here that makes money disappear, so it is
                    dated, attributed, and needs a reason.
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <span style={{ flex: 1, minWidth: 200 }}>
                      <L label="Why">
                        <input value={reason} onChange={(e) => setReason(e.target.value)}
                          aria-label="Why" style={inp} />
                      </L>
                    </span>
                    <button disabled={busy || reason.trim().length < 3}
                      onClick={() => { onWriteOff({ reason: reason.trim() }); setReason(''); }}
                      style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: reason.trim().length >= 3 ? 'var(--stop)' : 'var(--bg-2)', color: reason.trim().length >= 3 ? 'var(--on-stop, #fff)' : 'var(--text-faint)' }}>
                      Write it off
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
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
