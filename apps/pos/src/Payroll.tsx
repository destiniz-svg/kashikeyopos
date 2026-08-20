import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { Overlay } from './ui';

/* Payroll & Pension — 02-POS-SPEC.md §2 (`payroll`):
 * "Runs, pension, posts to 6000 / 2300."
 *
 * A RUN IS TWO ACTS AND THE SCREEN SAYS SO. A draft is arithmetic read off the
 * time clock; posting makes it a liability and cannot be undone. Payroll is the
 * one calculation where the inputs are routinely wrong — somebody forgot to
 * clock out — and the output is a person's wages, so the review step is not a
 * courtesy, it is the design.
 *
 * The two things a draft reports that are NOT on any line — hours with no rate,
 * and shifts left running — are shown above the figures rather than below them.
 * After the run posts they stop being questions and become somebody's missing
 * wages.
 *
 * Nothing here is queued through the outbox. Payroll is done once a fortnight
 * at a desk; a run replayed hours later against rates that have since changed
 * would post a liability nobody reviewed.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

interface Run {
  id: string; from: string; to: string; status: 'draft' | 'posted' | 'paid';
  gross: number; employeePension: number; employerPension: number; net: number;
  cost: number; note: string | null; people: number;
  runAt: string; postedAt: string | null; paidAt: string | null;
  runBy: string | null; postedBy: string | null;
}
interface Rate {
  id: number; staffId: string; name: string; rank: number;
  kind: 'hourly' | 'monthly'; amount: number; effectiveFrom: string;
  setBy: string | null;
}
interface Person { id: string; name: string; rank: number; rankName: string; active: boolean }
interface Line {
  staffId: string; name: string; rank: number; kind: string; rate: number;
  hours: number; shifts: number; gross: number;
  employeePension: number; employerPension: number; net: number;
}
interface Data {
  runs: Run[]; rates: Rate[]; roster: Person[];
  pension: { employeeBp: number; employerBp: number };
}
interface Draft {
  runId: string; from: string; to: string; lines: Line[];
  totals: { gross: number; employeePension: number; employerPension: number; net: number; cost: number };
  unpaid: Array<{ staffId: string; name: string; hours: number; shifts: number; why: string }>;
  openShifts: number;
  pension: { employeeBp: number; employerBp: number; configured: boolean };
}
interface Detail { run: Run & { owed: boolean }; lines: Line[] }

const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  draft: { label: 'DRAFT — NOTHING POSTED', fg: 'var(--warn-bright)', bg: 'var(--warn-dim)' },
  posted: { label: 'POSTED — OWED', fg: 'var(--text)', bg: 'var(--bg-2)' },
  paid: { label: 'PAID', fg: 'var(--go-bright)', bg: 'var(--go-dim)' },
};

/* A fortnight ending today, which is what a run usually is. */
const defaultPeriod = () => {
  const to = new Date();
  const from = new Date(to.getTime() - 13 * 86400000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
};

export function Payroll({ session, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session }) {
  const [tab, setTab] = useState<'runs' | 'rates'>('runs');
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [period, setPeriod] = useState(defaultPeriod());
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try { setData(await call<Data>('GET', '/payroll')); setError(''); }
    catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load payroll.');
      setData(null);
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
    setFlash(t); setTimeout(() => setFlash(''), 7000);
  };

  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const calculate = () => act(async () => {
    setDraft(await call<Draft>('POST', '/payroll/draft', period));
  }, 'Calculated from the clock. Nothing has posted — check it before you do.');

  const pensionOff = data && data.pension.employeeBp === 0 && data.pension.employerBp === 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 4 }}>
          <TabBtn on={tab === 'runs'} onClick={() => setTab('runs')}>Runs</TabBtn>
          <TabBtn on={tab === 'rates'} onClick={() => setTab('rates')}>What people are paid</TabBtn>
        </span>
        <span style={{ flex: 1 }} />
        {data && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            pension {data.pension.employeeBp / 100}% employee · {data.pension.employerBp / 100}% employer
          </span>
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
        {data === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Loading…'}
          </div>
        ) : tab === 'rates' ? (
          <Rates data={data} busy={busy}
            onSet={(body) => void act(() => call('PUT', '/payroll/rates', body),
              'Rate saved. It applies from the date you gave, so past runs stay as they were.')} />
        ) : (
          <>
            {pensionOff && (
              <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-muted)' }}>
                No pension rate is set, so nothing is deducted and nothing is owed to the pension
                office. The Maldives Retirement Pension Scheme is 7% from the employee and 7% from
                the employer of the pensionable wage — set it on the outlet if this business is
                registered. It is left at zero rather than assumed, because assuming it would take
                7% out of somebody&apos;s wages on nobody&apos;s instruction.
              </div>
            )}

            {/* Calculate */}
            <div style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)', display: 'flex', alignItems: 'flex-end', gap: 11, flexWrap: 'wrap' }}>
              <L label="From">
                <input type="date" value={period.from}
                  onChange={(e) => setPeriod({ ...period, from: e.target.value })}
                  aria-label="Period from" style={{ ...inp, width: 150, fontFamily: MONO }} />
              </L>
              <L label="To">
                <input type="date" value={period.to}
                  onChange={(e) => setPeriod({ ...period, to: e.target.value })}
                  aria-label="Period to" style={{ ...inp, width: 150, fontFamily: MONO }} />
              </L>
              <button disabled={busy} onClick={() => void calculate()}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
                {busy ? 'Working…' : 'Calculate from the clock'}
              </button>
              <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 380 }}>
                Reads the hours already recorded. Nobody retypes a timesheet, and nothing posts
                until you say so.
              </span>
            </div>

            {draft && (
              <DraftView draft={draft} busy={busy}
                onDiscard={() => void act(async () => {
                  await call('DELETE', '/payroll/' + draft.runId); setDraft(null);
                }, 'Draft thrown away. Nothing had posted.')}
                onPost={() => void act(async () => {
                  await call('POST', `/payroll/${draft.runId}/post`, {}); setDraft(null);
                }, 'Posted. The wages are now owed, and this cannot be undone.')} />
            )}

            <div style={{ margin: '0 2px 8px', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>
              Runs
            </div>
            {!data.runs.length ? (
              <div style={{ padding: '40px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 520 }}>
                No payroll has been run. Until one is, wages are missing from the P&amp;L entirely
                and prime cost is cost of sales alone — which reads as a very good number and is
                an incomplete one.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.runs.map((r) => {
                  const s = STATUS[r.status];
                  return (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid ' + (r.status === 'draft' ? 'var(--amber-line)' : 'var(--line-soft)') }}>
                      <span style={{ flexShrink: 0, alignSelf: 'flex-start', padding: '3px 7px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.05em', background: s.bg, color: s.fg }}>
                        {s.label}
                      </span>
                      <button onClick={() => void (async () => {
                        try { setDetail(await call<Detail>('GET', '/payroll/' + r.id)); }
                        catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open it.'); }
                      })()} style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                          {day(r.from)} – {day(r.to)}
                          <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
                            {' · '}{r.people} {r.people === 1 ? 'person' : 'people'}
                          </span>
                        </span>
                        <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                          {[r.runBy && 'run by ' + r.runBy,
                            r.postedBy && 'posted by ' + r.postedBy,
                            r.paidAt && 'paid ' + day(r.paidAt),
                            r.note].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                      <span style={{ textAlign: 'right' }}>
                        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                          {mvr(r.net)}
                        </span>
                        <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>
                          costs {mvr(r.cost)}
                        </span>
                      </span>
                      {r.status === 'posted' && (
                        <button disabled={busy}
                          onClick={() => void act(() => call('POST', `/payroll/${r.id}/pay`, { method: 'bank' }),
                            'Paid. What is owed to the pension office is still outstanding — it goes on its own schedule.')}
                          style={{ padding: '7px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                          Pay it
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {detail && <RunSheet detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/* ── the draft, which is the review ──────────────────────────────────────── */

function DraftView({ draft, busy, onPost, onDiscard }: {
  draft: Draft; busy: boolean; onPost: () => void; onDiscard: () => void;
}) {
  return (
    <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}>
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
          {day(draft.from)} – {day(draft.to)}
        </span>
        <span style={{ padding: '3px 7px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.05em', background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>
          DRAFT — NOTHING POSTED
        </span>
      </div>

      {/* The two things NOT on any line, above the figures rather than below —
          after the run posts they stop being questions and become somebody's
          missing wages. */}
      {draft.unpaid.length > 0 && (
        <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 11.5, lineHeight: 1.6 }}>
          {draft.unpaid.length} {draft.unpaid.length === 1 ? 'person is' : 'people are'} not on this
          run because {draft.unpaid.length === 1 ? 'they have' : 'they have'} no pay rate:{' '}
          {draft.unpaid.map((u) => u.name + ' (' + u.hours + 'h)').join(', ')}. They worked those
          hours. Set a rate and calculate again, or they will not be paid for them.
        </div>
      )}
      {draft.openShifts > 0 && (
        <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--warn-dim)', color: 'var(--warn-bright)', fontSize: 11.5, lineHeight: 1.6 }}>
          {draft.openShifts} shift{draft.openShifts === 1 ? '' : 's'} in this period {draft.openShifts === 1 ? 'was' : 'were'}{' '}
          never clocked out, so {draft.openShifts === 1 ? 'it has' : 'they have'} no hours and{' '}
          {draft.openShifts === 1 ? 'is' : 'are'} unpaid. Close {draft.openShifts === 1 ? 'it' : 'them'} on
          the staff screen first — nobody can guess when somebody went home.
        </div>
      )}

      <Lines lines={draft.lines} />

      <div style={{ marginTop: 10, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Fig label="GROSS" value={mvr(draft.totals.gross)} />
        <Fig label="PENSION — EMPLOYEE" value={mvr(draft.totals.employeePension)} />
        <Fig label="PENSION — EMPLOYER" value={mvr(draft.totals.employerPension)} />
        <Fig label="NET TO PAY" value={mvr(draft.totals.net)} big />
        <Fig label="COST TO THE BUSINESS" value={mvr(draft.totals.cost)} />
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={busy || !draft.lines.length} onClick={onPost}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: draft.lines.length ? 'var(--go)' : 'var(--bg-2)', color: draft.lines.length ? 'var(--on-go)' : 'var(--text-faint)' }}>
          Post it
        </button>
        <button disabled={busy} onClick={onDiscard}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Throw it away
        </button>
        <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 420 }}>
          Posting writes the journal — wages to 6000, the employer pension to 6010, net pay owed on
          2300 and both pension halves on 2310. It cannot be undone; a posted run is corrected with
          a further entry, never deleted.
        </span>
      </div>
    </div>
  );
}

function Lines({ lines }: { lines: Line[] }) {
  if (!lines.length) {
    return (
      <div style={{ padding: '22px 2px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>
        Nobody worked a closed shift in this period and nobody is on a monthly rate, so there is
        nothing to pay.
      </div>
    );
  }
  return (
    <>
      <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ flex: 1 }}>WHO</span>
        <span style={{ width: 96, textAlign: 'right' }}>HOURS</span>
        <span style={{ width: 88, textAlign: 'right' }}>GROSS</span>
        <span style={{ width: 88, textAlign: 'right' }}>PENSION</span>
        <span style={{ width: 92, textAlign: 'right' }}>NET</span>
      </div>
      {lines.map((l) => (
        <div key={l.staffId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{l.name}</span>
            <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
              {l.kind === 'monthly'
                ? mvr(l.rate) + ' a month, prorated'
                : mvr(l.rate) + ' an hour · ' + l.shifts + ' shift' + (l.shifts === 1 ? '' : 's')}
            </span>
          </span>
          <span style={{ width: 96, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>
            {l.kind === 'monthly' ? '—' : l.hours + 'h'}
          </span>
          <span style={{ width: 88, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text-dim)' }}>{mvr(l.gross)}</span>
          <span style={{ width: 88, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-faint)' }}>
            {l.employeePension ? '−' + mvr(l.employeePension) : '—'}
          </span>
          <span style={{ width: 92, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(l.net)}</span>
        </div>
      ))}
    </>
  );
}

/* ── rates ───────────────────────────────────────────────────────────────── */

function Rates({ data, busy, onSet }: {
  data: Data; busy: boolean;
  onSet: (body: { staffId: string; kind: string; amount: number; effectiveFrom: string }) => void;
}) {
  const [staffId, setStaffId] = useState(data.roster[0]?.id ?? '');
  const [kind, setKind] = useState('hourly');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));

  /* Newest first per person; the history is kept and shown because a run priced
     at an old rate has to be explicable a year later. */
  const byPerson = new Map<string, Rate[]>();
  for (const r of data.rates) {
    if (!byPerson.has(r.staffId)) byPerson.set(r.staffId, []);
    (byPerson.get(r.staffId) as Rate[]).push(r);
  }

  return (
    <>
      <div style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 11 }}>
          <L label="Who">
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} style={inp}>
              {data.roster.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </L>
          <L label="Paid">
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={inp}>
              <option value="hourly">by the hour</option>
              <option value="monthly">a monthly salary</option>
            </select>
          </L>
          <L label="Amount (MVR)">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount" style={{ ...inp, fontFamily: MONO }} />
          </L>
          <L label="From" hint="Runs before this date keep the old rate. A rise never restates a period that has been paid.">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              aria-label="Effective from" style={{ ...inp, fontFamily: MONO }} />
          </L>
        </div>
        <button disabled={busy || !staffId || !(Number(amount) >= 0) || amount === ''}
          onClick={() => onSet({ staffId, kind, amount: Number(amount), effectiveFrom: from })}
          style={{ marginTop: 12, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
          Set the rate
        </button>
      </div>

      {!data.rates.length ? (
        <div style={{ padding: '40px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 520 }}>
          Nobody has a pay rate yet. A payroll run prices the hours the clock recorded — without a
          rate somebody&apos;s hours are on the run as unpaid rather than valued at a made-up zero,
          which is the only honest thing to do with them.
        </div>
      ) : (
        [...byPerson.entries()].map(([id, rs]) => (
          <div key={id} style={{ padding: '9px 2px', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{rs[0].name}</span>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(rs[0].amount)}
              </span>
              <span style={{ width: 90, textAlign: 'right', fontSize: 10.5, color: 'var(--text-faint)' }}>
                {rs[0].kind === 'monthly' ? 'a month' : 'an hour'}
              </span>
            </div>
            <div style={{ marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {rs.map((r) => (
                <span key={r.id} style={{ fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                  from {day(r.effectiveFrom)} · {mvr(r.amount)}
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}

/* ── one run ─────────────────────────────────────────────────────────────── */

function RunSheet({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const r = detail.run;
  return (
    <Overlay onClose={onClose} label="Payroll run" width={660}>
    <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
        {day(r.from)} – {day(r.to)}
      </span>
      <span style={{ padding: '3px 7px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.05em', background: STATUS[r.status].bg, color: STATUS[r.status].fg }}>
        {STATUS[r.status].label}
      </span>
      <span style={{ flex: 1 }} />
      <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
      <Lines lines={detail.lines} />
      <div style={{ marginTop: 12, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Fig label="GROSS" value={mvr(r.gross)} />
        <Fig label="PENSION" value={mvr(r.employeePension + r.employerPension)} />
        <Fig label="NET" value={mvr(r.net)} big />
        <Fig label="COST" value={mvr(r.cost)} />
      </div>
      <p style={{ margin: '12px 2px 0', fontSize: 11, lineHeight: 1.6, color: 'var(--text-faint)' }}>
        {r.status === 'draft'
          ? 'Nothing has posted. These figures are arithmetic read off the time clock.'
          : 'Wages went to 6000 and the employer pension to 6010. Net pay is owed on 2300'
            + (r.paidAt ? ' and has been paid.' : ' and has not been paid yet.')
            + ' Both pension halves sit on 2310, owed to the pension office on its own schedule.'}
      </p>
    </div>
    </Overlay>
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

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', marginBottom: 4, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label.toUpperCase()}</span>
      {children}
      {hint && <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}
