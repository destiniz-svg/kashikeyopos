import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { Overlay } from './ui';

/* Card settlements — 08-BUILD-STAGES §17, and the second half of a sentence
 * this build has only ever said the first half of: a card sale debits 1020 Card
 * receivable, and until now nothing ever took it off again.
 *
 * SO THE FIRST THING ON THE SCREEN IS WHAT IS STILL OWED and how old the oldest
 * of it is. An acquirer pays out in two or three days; a payment sitting
 * unsettled from six weeks ago is not waiting, it is lost, and the age is the
 * only figure here that says so.
 *
 * MATCHING IS ONE PRESS AND IT SHOWS ITS WORKING. The suggestion is every
 * unsettled card payment up to the batch's value date, with what they come to,
 * what the acquirer says, and the difference — because an operator matching a
 * batch is deciding whether to accept that difference, and the number is the
 * decision. It does not quietly pick the subset that happens to add up.
 *
 * A DIFFERENCE IS NOT AN ERROR MESSAGE. It posts to 6185 and stays in the P&L
 * until somebody explains it, which is the point of surfacing it rather than
 * folding it into the fee where it would look like a cost of doing business.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

const daysSince = (d: string) =>
  Math.max(0, Math.round((Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000));

interface Batch {
  id: string; acquirer: string; batchNo: string; valueDate: string;
  gross: number; fee: number; net: number; variance: number;
  matchedAt: string | null; matchedBy: string | null;
  enteredAt: string; enteredBy: string | null; note: string | null;
  journalId: string | null; payments: number | null; matchedAmount: number | null;
  state: string;
}
interface Outstanding {
  days: Array<{ date: string; method: string; payments: number; amount: number }>;
  total: number; payments: number; oldest: string | null;
}
interface Data {
  batches: Batch[];
  totals: { unmatched: number; unmatchedValue: number; variance: number };
  outstanding: Outstanding;
}
interface Payment {
  id: string; method: string; amount: number; tip: number;
  authRef: string | null; date: string; receipt: string;
}
interface Suggestion {
  batch: Batch; payments: Payment[]; total: number; difference: number;
  agrees: boolean; message: string;
}

export function Settlements({ session, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session }) {
  const [data, setData] = useState<Data | null>(null);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [entering, setEntering] = useState(false);
  const [matching, setMatching] = useState<Suggestion | null>(null);
  const [unmatching, setUnmatching] = useState<Batch | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', `/settlements?from=${from}&to=${to}`));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not read the settlements.');
      setData(null);
    }
  }, [call, from, to]);

  useEffect(() => { void load(); }, [load]);

  /* Routed to the terminal's toast when one is supplied (src/ui.tsx), and to
     the module's own banner when it is not. A confirmation belongs at the
     bottom of the SCREEN rather than at the top of one card: the operator who
     just pressed Save is looking at the thing they saved, not at the header.
     Errors are deliberately NOT routed here — those stay in the form, beside
     the field that has to change, until somebody changes it. */
  const say = (t: string) => {
    if (toast) { toast(t); return; }
    setFlash(t); setTimeout(() => setFlash(''), 10000);
  };
  const act = async (fn: () => Promise<unknown>, said?: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const openMatch = async (b: Batch) => {
    setBusy(true); setError('');
    try { setMatching(await call<Suggestion>('GET', `/settlements/${b.id}/suggest`)); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not read the payments.'); }
    finally { setBusy(false); }
  };

  const out = data?.outstanding;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {/* No heading here: the tab above already says Card money, and a screen
            that names itself twice is a screen nobody proofread. */}
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInput} />
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>to</span>
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} style={dateInput} />

        {out && (
          <>
            <Fig label="NOT SETTLED YET" value={mvr(out.total)} />
            {/* The figure that says whether anything is actually wrong. */}
            <span>
              <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                OLDEST
              </span>
              <span style={{
                fontSize: 15, fontWeight: 700, fontFamily: MONO,
                color: !out.oldest ? 'var(--text)'
                  : daysSince(out.oldest) >= 7 ? 'var(--stop-bright)'
                    : daysSince(out.oldest) >= 4 ? 'var(--warn-bright)' : 'var(--text)',
              }}>
                {out.oldest ? daysSince(out.oldest) + ' days' : '—'}
              </span>
            </span>
          </>
        )}
        {data && data.totals.unmatched > 0 && (
          <Fig label="BATCHES WAITING" value={String(data.totals.unmatched)} />
        )}
        <span style={{ flex: 1 }} />
        <button onClick={() => setEntering(true)} disabled={busy}
          style={{ padding: '6px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--accent)', color: 'var(--on-accent)' }}>
          Enter a statement
        </button>
      </div>

      {(error || flash) && (
        <div style={{ flexShrink: 0, padding: '8px 14px', fontSize: 11.5, lineHeight: 1.5, background: error ? 'var(--stop-dim)' : 'var(--go-dim)', color: error ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
          {error || flash}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 40px' }}>
        {!data ? (
          <div style={{ padding: '40px 4px', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {error ? '' : 'Reading…'}
          </div>
        ) : (
          <>
            {/* ── what the acquirer still owes ─────────────────────────── */}
            <SubHead>Taken on cards, not settled yet</SubHead>
            {!out || !out.days.length ? (
              <div style={{ padding: '14px 4px 20px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 620 }}>
                Every card payment has been tied to a batch. This is account 1020 at
                nought, which is where it should sit between payouts.
              </div>
            ) : (
              <div style={{ marginBottom: 20 }}>
                {out.days.map((d, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '7px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ width: 96, fontSize: 12, fontFamily: MONO, color: 'var(--text-muted)' }}>
                      {d.date}
                    </span>
                    <span style={{ width: 70, fontSize: 12, color: 'var(--text-faint)' }}>{d.method}</span>
                    <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-faint)' }}>
                      {d.payments} {d.payments === 1 ? 'payment' : 'payments'}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                      {mvr(d.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ── the batches ──────────────────────────────────────────── */}
            <SubHead>Statements</SubHead>
            {!data.batches.length ? (
              <div style={{ padding: '14px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 620 }}>
                Nothing entered for this period. An acquirer sends a statement — a
                batch reference, a date, what they paid and what they kept — and
                entering it here is what turns card takings into money in the bank.
              </div>
            ) : data.batches.map((b) => (
              <div key={b.id} style={{
                marginBottom: 9, padding: 12, borderRadius: 10, background: 'var(--bg-1)',
                border: '1px solid ' + (b.matchedAt ? 'var(--line-soft)' : 'var(--line)'),
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    {b.acquirer}
                  </span>
                  <span style={{ fontSize: 12, fontFamily: MONO, color: 'var(--text-muted)' }}>
                    {b.batchNo}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    value {b.valueDate}
                    {b.enteredBy && ' · entered by ' + b.enteredBy}
                    {b.matchedBy && ' · matched by ' + b.matchedBy}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12.5, fontFamily: MONO, color: 'var(--text-muted)' }}>
                    {mvr(b.gross)} − {mvr(b.fee)} fee
                  </span>
                  <span style={{ width: 96, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                    {mvr(b.net)}
                  </span>
                </div>

                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11.5,
                    color: !b.matchedAt ? 'var(--warn-bright)'
                      : b.variance ? 'var(--stop-bright)' : 'var(--go-bright)',
                  }}>
                    {b.state}
                    {b.matchedAt && b.payments !== null && ' · ' + b.payments + ' payments'}
                    {/* The difference is stated, not hidden behind a state word. */}
                    {b.variance !== 0 && ' · out by ' + mvr(Math.abs(b.variance))}
                  </span>
                  {b.note && (
                    <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{b.note}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {!b.matchedAt ? (
                    <button disabled={busy} onClick={() => void openMatch(b)}
                      style={{ padding: '6px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                      Find its payments
                    </button>
                  ) : (
                    <button disabled={busy} onClick={() => setUnmatching(b)}
                      style={{ padding: '5px 11px', borderRadius: 7, fontSize: 11.5, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                      Unmatch
                    </button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {entering && (
        <EnterStatement busy={busy} onClose={() => setEntering(false)}
          onSave={(body) => act(() => call('POST', '/settlements', body),
            'On the books. Find its payments to settle it.').then(() => setEntering(false))} />
      )}
      {matching && (
        <MatchBatch suggestion={matching} busy={busy} onClose={() => setMatching(null)}
          onMatch={(ids) => act(
            async () => {
              const r = await call<{ message: string }>(
                'POST', `/settlements/${matching.batch.id}/match`, { paymentIds: ids });
              say(r.message);
            }).then(() => setMatching(null))} />
      )}
      {unmatching && (
        <Ask title={'Unmatch ' + unmatching.acquirer + ' ' + unmatching.batchNo}
          label="Why" action="Unmatch it" busy={busy}
          hint="The posting is reversed and the payments go back to unsettled. Nothing is deleted — both entries stay in the ledger."
          onClose={() => setUnmatching(null)}
          onSubmit={(reason) => act(
            async () => {
              const r = await call<{ message: string }>(
                'POST', `/settlements/${unmatching.id}/unmatch`, { reason });
              say(r.message);
            }).then(() => setUnmatching(null))} />
      )}
    </div>
  );
}

/* ── entering a statement ────────────────────────────────────────────────── */

function EnterStatement({ busy, onClose, onSave }: {
  busy: boolean; onClose: () => void; onSave: (b: Record<string, unknown>) => void;
}) {
  const [acquirer, setAcquirer] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [valueDate, setValueDate] = useState(today());
  const [gross, setGross] = useState('');
  const [fee, setFee] = useState('');
  const [note, setNote] = useState('');

  const g = Math.round((Number(gross) || 0) * 100);
  const f = Math.round((Number(fee) || 0) * 100);
  const ready = acquirer.trim() && batchNo.trim() && g > 0 && f >= 0;

  return (
    <Modal title="Enter a statement" onClose={onClose}>
      <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)', marginBottom: 12, maxWidth: 560 }}>
        Copy it from the acquirer's payout advice. The net is worked out here, and
        a statement whose own arithmetic does not add up is refused — better to
        catch a typo now than to have it appear as a difference in the trade.
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <L label="Acquirer">
          <input aria-label="Acquirer" value={acquirer} maxLength={60}
            placeholder="BML" onChange={(e) => setAcquirer(e.target.value)} style={inp} />
        </L>
        <L label="Batch reference">
          <input aria-label="Batch reference" value={batchNo} maxLength={60}
            placeholder="B-2201" onChange={(e) => setBatchNo(e.target.value)} style={inp} />
        </L>
        <L label="Value date">
          <input type="date" aria-label="Value date" value={valueDate}
            onChange={(e) => setValueDate(e.target.value)} style={inp} />
        </L>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <L label="Gross">
          <input aria-label="Gross" inputMode="decimal" value={gross}
            onChange={(e) => setGross(e.target.value)} style={{ ...inp, textAlign: 'right', fontFamily: MONO }} />
        </L>
        <L label="Fee they kept">
          <input aria-label="Fee" inputMode="decimal" value={fee}
            onChange={(e) => setFee(e.target.value)} style={{ ...inp, textAlign: 'right', fontFamily: MONO }} />
        </L>
        <div style={{ paddingBottom: 7 }}>
          <span style={{ fontSize: 10.5, letterSpacing: '.05em', color: 'var(--text-faint)' }}>NET</span>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
            {mvr((g - f) / 100)}
          </div>
        </div>
        <L label="Note" >
          <input aria-label="Note" value={note} maxLength={200}
            placeholder="Tuesday payout" onChange={(e) => setNote(e.target.value)} style={inp} />
        </L>
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 9 }}>
        <button onClick={onClose} style={ghost}>Cancel</button>
        <button disabled={!ready || busy}
          onClick={() => onSave({
            acquirer: acquirer.trim(), batchNo: batchNo.trim(), valueDate,
            gross: Number(gross), fee: Number(fee) || 0, note: note.trim() || undefined,
          })}
          style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ready ? 'var(--accent)' : 'var(--bg-2)', color: ready ? 'var(--on-accent)' : 'var(--text-ghost)' }}>
          Put it on the books
        </button>
      </div>
    </Modal>
  );
}

/* ── matching ────────────────────────────────────────────────────────────── */

function MatchBatch({ suggestion, busy, onClose, onMatch }: {
  suggestion: Suggestion; busy: boolean; onClose: () => void;
  onMatch: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(suggestion.payments.map((p) => p.id)));

  const chosen = suggestion.payments.filter((p) => picked.has(p.id));
  const total = chosen.reduce((a, p) => a + Math.round(p.amount * 100), 0);
  const gross = Math.round(suggestion.batch.gross * 100);
  const diff = gross - total;

  return (
    <Modal title={'Match ' + suggestion.batch.acquirer + ' ' + suggestion.batch.batchNo}
      onClose={onClose}>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 620 }}>
        {suggestion.message}
      </div>

      <div style={{ marginTop: 12, maxHeight: '42vh', overflowY: 'auto', border: '1px solid var(--line-soft)', borderRadius: 8 }}>
        {!suggestion.payments.length ? (
          <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>
            No unsettled card payments on or before {suggestion.batch.valueDate}. Either
            they are already in another batch, or this statement covers a period the
            till has no record of.
          </div>
        ) : suggestion.payments.map((p) => (
          <label key={p.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 11px',
            borderBottom: '1px solid var(--line-soft)', fontSize: 12, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={picked.has(p.id)}
              aria-label={'Payment ' + p.receipt}
              onChange={(e) => setPicked((s) => {
                const n = new Set(s);
                if (e.target.checked) n.add(p.id); else n.delete(p.id);
                return n;
              })} />
            <span style={{ width: 96, fontFamily: MONO, color: 'var(--text-muted)' }}>{p.date}</span>
            <span style={{ width: 130, fontFamily: MONO, color: 'var(--text)' }}>{p.receipt}</span>
            <span style={{ width: 60, color: 'var(--text-faint)' }}>{p.method}</span>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--text-faint)' }}>
              {p.authRef || ''}
            </span>
            <span style={{ fontFamily: MONO, fontWeight: 700, color: 'var(--text)' }}>
              {mvr(p.amount)}
            </span>
          </label>
        ))}
      </div>

      {/* The arithmetic, live, because ticking a box changes the decision. */}
      <div style={{ marginTop: 12, display: 'flex', gap: 20, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5, fontFamily: MONO }}>
        <span style={{ color: 'var(--text-faint)' }}>
          picked <b style={{ color: 'var(--text)' }}>{mvr(total / 100)}</b>
        </span>
        <span style={{ color: 'var(--text-faint)' }}>
          statement <b style={{ color: 'var(--text)' }}>{mvr(gross / 100)}</b>
        </span>
        <span style={{ color: diff === 0 ? 'var(--go-bright)' : 'var(--warn-bright)' }}>
          {diff === 0 ? 'they agree' : 'out by ' + mvr(Math.abs(diff) / 100) + ' → 6185'}
        </span>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
        <button onClick={onClose} style={ghost}>Cancel</button>
        <button disabled={!chosen.length || busy} onClick={() => onMatch([...picked])}
          style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: chosen.length ? 'var(--accent)' : 'var(--bg-2)', color: chosen.length ? 'var(--on-accent)' : 'var(--text-ghost)' }}>
          {diff === 0 ? 'Match and post' : 'Match, and book the difference'}
        </button>
      </div>
    </Modal>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

function Ask({ title, label, hint, action, busy, onClose, onSubmit }: {
  title: string; label: string; hint: string; action: string; busy: boolean;
  onClose: () => void; onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 520 }}>
        {hint}
      </div>
      <L label={label}>
        <input aria-label={label} value={v} maxLength={160} autoFocus
          onChange={(e) => setV(e.target.value)} style={{ ...inp, width: '100%' }} />
      </L>
      <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
        <button onClick={onClose} style={ghost}>Cancel</button>
        <button disabled={v.trim().length < 4 || busy} onClick={() => onSubmit(v.trim())}
          style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: v.trim().length >= 4 ? 'var(--accent)' : 'var(--bg-2)', color: v.trim().length >= 4 ? 'var(--on-accent)' : 'var(--text-ghost)' }}>
          {action}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <Overlay onClose={onClose} label={title} width={760} scroll>
    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
      {title}
    </div>
    {children}
    </Overlay>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: '0 0 9px', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
      {String(children).toUpperCase()}
    </div>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
        {label}
      </span>
      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
        {value}
      </span>
    </span>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
      {label}
      {children}
    </label>
  );
}

const dateInput: React.CSSProperties = {
  height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO,
};
const inp: React.CSSProperties = { ...dateInput, height: 32, fontFamily: 'inherit' };
const ghost: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 7, fontSize: 11.5, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text-muted)',
};
