import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Operating Costs — 02-POS-SPEC.md §2 (`opcosts`):
 * "All 16 expense categories, recurring costs, overhead allocation."
 *
 * THIS SCREEN IS DEFINED BY WHAT IT REFUSES. Everything below gross profit has
 * so far arrived here as a side effect of something else — cost of sales from a
 * sale, wages from a payroll run, variance from a stock count. Those categories
 * are shown, greyed, WITH THE MODULE THAT OWNS THEM, rather than left off the
 * list. A category that is simply missing looks like an oversight and invites
 * somebody to find another way to enter it; a category that says "posted by a
 * payroll run" answers the question instead.
 *
 * A SPREAD COST IS NOT THIS MONTH'S COST, and the list never adds it up as if
 * it were. An annual licence paid in January is a twelfth of January, twelve
 * times over — charged where it was paid, January reads as a disaster and the
 * other eleven read better than they were, and a kitchen managing by monthly
 * P&L will act on both. So the row shows what was PAID and what this period
 * BEARS as two separate figures, and the category totals use the second.
 *
 * WHAT IS DUE COMES FROM THE SCHEDULE, not from a diary. Rent falls due on the
 * first whether or not anybody opened this screen, so the overdue list is
 * computed from the schedules every time and says how late each one is.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) =>
  new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

interface Category { code: string; name: string; postedBy: string | null }
interface Expense {
  id: string; spentOn: string; account: string; accountName: string;
  amount: number; method: 'cash' | 'bank' | 'credit'; note: string | null;
  supplier: string | null; by: string | null; fromSchedule: boolean;
  spreadMonths: number | null; releasedMonths: number;
  thisPeriod: number; stillPrepaid: number;
}
interface Schedule {
  id: string; account: string; accountName: string; amount: number;
  cadence: 'weekly' | 'monthly' | 'annual'; dueDay: number;
  startsOn: string; endsOn: string | null; supplier: string | null;
  note: string | null; method: string; spreadMonths: number | null;
  active: boolean; annualised: number;
}
interface Due {
  recurringId: string; account: string; accountName: string; amount: number;
  periodKey: string; dueOn: string; cadence: string; method: string;
  note: string | null; spreadMonths: number | null; daysLate: number;
}
interface Data {
  expenses: Expense[];
  byCategory: Array<{ account: string; name: string; total: number; count: number }>;
  total: number; prepaid: number;
  categories: { enterable: Category[]; elsewhere: Category[] };
  schedules: Schedule[];
  due: Due[];
  canSchedule: boolean;
}

const CADENCE: Record<string, string> = {
  weekly: 'every week', monthly: 'every month', annual: 'once a year',
};
const METHOD: Record<string, string> = {
  cash: 'from the drawer', bank: 'from the bank', credit: 'on account — owed',
};

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function OpCosts({ session, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session }) {
  const [tab, setTab] = useState<'costs' | 'recurring'>('costs');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try { setData(await call<Data>('GET', '/opcosts')); setError(''); }
    catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load operating costs.');
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
    setFlash(t); setTimeout(() => setFlash(''), 8000);
  };

  /* An empty `said` means the action reported for itself — say('') here would
     wipe the message it just set. */
  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  /* The empty result is not an error and is not silence either. Told nothing,
     an operator presses again, and the fact that pressing again is harmless is
     exactly what they cannot see. */
  const release = () => act(async () => {
    const r = await call<{ released: Array<unknown>; total: number; period: string }>(
      'POST', '/opcosts/release', { period: thisMonth() });
    say(r.released.length
      ? 'Released ' + mvr(r.total) + ' of prepaid cost into ' + r.period + '.'
      : 'Nothing left to release for ' + r.period + ' — it has already been done.'
        + ' Running it twice does not charge the month twice.');
  }, '');

  const post = (d: Due) => act(() => call('POST', '/opcosts', {
    account: d.account, amount: d.amount, spentOn: d.dueOn, method: d.method,
    note: d.note, recurringId: d.recurringId, periodKey: d.periodKey,
    spreadMonths: d.spreadMonths,
  }), d.accountName + ' for ' + d.periodKey + ' is posted.');

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Operating costs</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <TabBtn on={tab === 'costs'} onClick={() => setTab('costs')}>What it cost</TabBtn>
          <TabBtn on={tab === 'recurring'} onClick={() => setTab('recurring')}>
            Recurring{data && data.schedules.filter((s) => s.active).length
              ? ' · ' + data.schedules.filter((s) => s.active).length : ''}
          </TabBtn>
        </span>
        <span style={{ flex: 1 }} />
        {data && data.prepaid > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {mvr(data.prepaid)} still prepaid
          </span>
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
        ) : tab === 'costs' ? (
          <Costs data={data} busy={busy} onPost={post} onRelease={release}
            onRecord={(b) => act(() => call('POST', '/opcosts', b),
              'Recorded. It is in the P&L from now.')} />
        ) : (
          <Recurring data={data} busy={busy}
            onSet={(b) => act(() => call('POST', '/opcosts/recurring', b),
              'Scheduled. It will keep falling due whether or not anybody opens this screen.')}
            onStop={(id) => act(() => call('DELETE', '/opcosts/recurring/' + id),
              'Stopped. What it already posted stays posted.')} />
        )}
      </div>
    </div>
  );
}

/* ── what it cost ─────────────────────────────────────────────────────────── */

function Costs({ data, busy, onRecord, onPost, onRelease }: {
  data: Data; busy: boolean;
  onRecord: (b: Record<string, unknown>) => void;
  onPost: (d: Due) => void;
  onRelease: () => void;
}) {
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(today());
  const [method, setMethod] = useState('credit');
  const [note, setNote] = useState('');
  const [spread, setSpread] = useState('');

  const ok = account !== '' && Number(amount) > 0;
  const spreadN = Number(spread);
  const spreading = Number.isInteger(spreadN) && spreadN >= 2;

  const submit = () => {
    onRecord({
      account, amount: Number(amount), spentOn, method,
      note: note || null, spreadMonths: spreading ? spreadN : null,
    });
    setAmount(''); setNote(''); setSpread('');
  };

  return (
    <>
      {data.due.length > 0 && (
        <div style={{ marginBottom: 14, padding: 13, borderRadius: 10, background: 'var(--warn-dim)', border: '1px solid var(--warn)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warn-bright)' }}>
            {data.due.length} scheduled {data.due.length === 1 ? 'cost is' : 'costs are'} due and not posted
          </div>
          <p style={{ margin: '4px 0 10px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 560 }}>
            Worked out from the schedule, not from a diary — the rent fell due whether or not
            anybody opened this screen. Until it is posted the P&amp;L flatters the period.
          </p>
          {data.due.map((d) => (
            <div key={d.recurringId + d.periodKey}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                  {d.accountName}
                  <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 500, color: 'var(--text-faint)' }}>
                    {d.periodKey}
                  </span>
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  due {day(d.dueOn)}
                  {d.daysLate > 0 && ' · ' + d.daysLate + ' day' + (d.daysLate === 1 ? '' : 's') + ' late'}
                </span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(d.amount)}
              </span>
              <button disabled={busy} onClick={() => onPost(d)}
                style={{ padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                Post it
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── record one ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 11 }}>
          <L label="Category">
            <select value={account} onChange={(e) => setAccount(e.target.value)}
              aria-label="Category" style={inp}>
              <option value="">choose one…</option>
              {data.categories.enterable.map((c) => (
                <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
              ))}
            </select>
          </L>
          <L label="Amount (MVR)">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount" style={{ ...inp, fontFamily: MONO }} />
          </L>
          <L label="Spent on">
            <input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)}
              aria-label="Spent on" style={{ ...inp, fontFamily: MONO }} />
          </L>
          <L label="How">
            <select value={method} onChange={(e) => setMethod(e.target.value)}
              aria-label="How it was paid" style={inp}>
              <option value="credit">on account — owed</option>
              <option value="bank">paid from the bank</option>
              <option value="cash">paid from the drawer</option>
            </select>
          </L>
          <L label="Spread over"
            hint="Leave blank unless it covers more than this month. An annual licence spread over 12 sits on 1200 Prepaid and is charged a twelfth at a time.">
            <input inputMode="numeric" placeholder="months" value={spread}
              onChange={(e) => setSpread(e.target.value)}
              aria-label="Spread over months" style={{ ...inp, fontFamily: MONO }} />
          </L>
          <L label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)}
              aria-label="Note" style={inp} />
          </L>
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button disabled={busy || !ok} onClick={submit}
            style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
            Record it
          </button>
          {spreading && Number(amount) > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              {mvr(Number(amount) / spreadN)} a month for {spreadN} months — not{' '}
              {mvr(Number(amount))} this one.
            </span>
          )}
        </div>
      </div>

      {/* ── the categories this screen will not take ───────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <SubHead>Posted elsewhere</SubHead>
        <p style={{ margin: '0 2px 8px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 560 }}>
          These reach the ledger on their own. Entering one here would count it twice, and nothing
          downstream would say so — the trial balance still balances, because a duplicate is
          consistent with itself.
        </p>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {data.categories.elsewhere.map((c) => (
            <span key={c.code} style={{ padding: '5px 9px', borderRadius: 7, fontSize: 10.5, background: 'var(--bg-1)', border: '1px solid var(--line-soft)', color: 'var(--text-faint)' }}>
              <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>{c.name}</span>
              {' — from ' + c.postedBy}
            </span>
          ))}
        </div>
      </div>

      {/* ── prepaid, and releasing a month of it ───────────────────────── */}
      {data.prepaid > 0 && (
        <div style={{ marginBottom: 16, padding: 13, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
              {mvr(data.prepaid)} is held on 1200 Prepaid expenses
            </span>
            <span style={{ fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
              Paid already, but belonging to months still to come. Release a month at the end of
              each one. Pressing it twice in the same month charges the month once.
            </span>
          </span>
          <button disabled={busy} onClick={onRelease}
            style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
            Release {thisMonth()}
          </button>
        </div>
      )}

      {/* ── by category ───────────────────────────────────────────────── */}
      {data.byCategory.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SubHead>Where it went</SubHead>
          {data.byCategory.map((c) => (
            <div key={c.account} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 2px', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>{c.name}</span>
              <span style={{ width: 60, textAlign: 'right', fontSize: 10, color: 'var(--text-faint)' }}>
                {c.count}
              </span>
              <span style={{ width: 110, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(c.total)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 2px' }}>
            <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
              THIS PERIOD BEARS
            </span>
            <span style={{ width: 110, textAlign: 'right', fontSize: 17, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
              {mvr(data.total)}
            </span>
          </div>
        </div>
      )}

      {/* ── the list ──────────────────────────────────────────────────── */}
      <SubHead>Every cost</SubHead>
      {!data.expenses.length ? (
        <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 560 }}>
          Nothing has been recorded. Rent, electricity, gas, the licence and the pest contract all
          have accounts waiting — until something is entered, net profit is gross profit minus
          whatever happened to post from somewhere else, which is not the same number.
        </div>
      ) : data.expenses.map((e) => (
        <div key={e.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ width: 54, fontSize: 10.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
            {day(e.spentOn)}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
              {e.accountName}
              {e.fromSchedule && (
                <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                  SCHEDULED
                </span>
              )}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
              {METHOD[e.method]}
              {e.supplier && ' · ' + e.supplier}
              {e.note && ' · ' + e.note}
              {e.by && ' · ' + e.by}
            </span>
          </span>
          {e.spreadMonths ? (
            <span style={{ width: 150, textAlign: 'right' }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(e.thisPeriod)}
              </span>
              {/* What was PAID is a different fact from what this period bears,
                  and putting them in one column is how a licence makes January
                  look like a disaster. */}
              <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>
                {mvr(e.amount)} over {e.spreadMonths} · {e.releasedMonths} released
              </span>
            </span>
          ) : (
            <span style={{ width: 150, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
              {mvr(e.amount)}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/* ── recurring ───────────────────────────────────────────────────────────── */

function Recurring({ data, busy, onSet, onStop }: {
  data: Data; busy: boolean;
  onSet: (b: Record<string, unknown>) => void;
  onStop: (id: string) => void;
}) {
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<'weekly' | 'monthly' | 'annual'>('monthly');
  const [dueDay, setDueDay] = useState('1');
  const [startsOn, setStartsOn] = useState(today());

  const max = cadence === 'weekly' ? 7 : cadence === 'monthly' ? 31 : 366;
  const dayN = Number(dueDay);
  const ok = account !== '' && Number(amount) > 0
    && Number.isInteger(dayN) && dayN >= 1 && dayN <= max;

  const live = data.schedules.filter((s) => s.active);
  const stopped = data.schedules.filter((s) => !s.active);
  const yearly = live.reduce((a, s) => a + s.annualised, 0);

  return (
    <>
      {!data.canSchedule ? (
        <p style={{ margin: '0 2px 14px', padding: 11, borderRadius: 9, fontSize: 11.5, lineHeight: 1.6, background: 'var(--bg-1)', border: '1px solid var(--line-soft)', color: 'var(--text-faint)', maxWidth: 560 }}>
          Setting up a schedule is an admin&apos;s job. It keeps charging long after whoever created
          it has forgotten — that is a commitment, not an entry. You can still record costs as they
          happen on the other tab.
        </p>
      ) : (
        <div style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 11 }}>
            <L label="Category">
              <select value={account} onChange={(e) => setAccount(e.target.value)}
                aria-label="Category" style={inp}>
                <option value="">choose one…</option>
                {data.categories.enterable.map((c) => (
                  <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                ))}
              </select>
            </L>
            <L label="Amount (MVR)">
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                aria-label="Amount" style={{ ...inp, fontFamily: MONO }} />
            </L>
            <L label="How often">
              <select value={cadence} aria-label="How often"
                onChange={(e) => setCadence(e.target.value as 'weekly' | 'monthly' | 'annual')}
                style={inp}>
                <option value="monthly">every month</option>
                <option value="weekly">every week</option>
                <option value="annual">once a year</option>
              </select>
            </L>
            <L label="Due day"
              hint={cadence === 'weekly' ? '1 is Monday, 7 is Sunday.'
                : cadence === 'monthly' ? 'The 31st falls on the last day of a short month, not into the next one.'
                  : 'Day of the year — 1 is 1 January.'}>
              <input inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)}
                aria-label="Due day" style={{ ...inp, fontFamily: MONO }} />
            </L>
            <L label="Starts">
              <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)}
                aria-label="Starts on" style={{ ...inp, fontFamily: MONO }} />
            </L>
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button disabled={busy || !ok} onClick={() => onSet({
              account, amount: Number(amount), cadence, dueDay: dayN, startsOn,
            })}
              style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
              Schedule it
            </button>
            {Number(amount) > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {mvr(Number(amount) * (cadence === 'weekly' ? 52 : cadence === 'monthly' ? 12 : 1))} a year
              </span>
            )}
          </div>
        </div>
      )}

      {!live.length && !stopped.length ? (
        <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 560 }}>
          No schedules. A recurring cost is not a reminder — it is what the business owes on the
          calendar, and until one exists the P&amp;L only knows about costs somebody remembered to
          type in.
        </div>
      ) : (
        <>
          <SubHead>Committed</SubHead>
          {live.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 2px', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                  {s.accountName}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  {CADENCE[s.cadence]} · day {s.dueDay} · from {day(s.startsOn)}
                  {s.supplier && ' · ' + s.supplier}
                </span>
              </span>
              <span style={{ width: 100, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(s.amount)}
              </span>
              {/* A weekly 500 and a monthly 2,000 are not the same cost, and a
                  list showing only the figures makes them look it. */}
              <span style={{ width: 120, textAlign: 'right', fontSize: 10.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
                {mvr(s.annualised)}/yr
              </span>
              {data.canSchedule && (
                <button disabled={busy} onClick={() => onStop(s.id)}
                  style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                  Stop
                </button>
              )}
            </div>
          ))}
          {live.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 2px' }}>
              <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                COMMITTED A YEAR
              </span>
              <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(yearly)}
              </span>
            </div>
          )}
          {stopped.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <SubHead>Stopped</SubHead>
              {stopped.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 2px', borderBottom: '1px solid var(--line-soft)', color: 'var(--text-faint)' }}>
                  <span style={{ flex: 1, fontSize: 12 }}>{s.accountName}</span>
                  <span style={{ fontSize: 11.5, fontFamily: MONO }}>{mvr(s.amount)}</span>
                </div>
              ))}
              <p style={{ margin: '6px 2px 0', fontSize: 10.5, color: 'var(--text-faint)' }}>
                What they already posted stays posted. A schedule stops falling due; it does not
                unspend the money.
              </p>
            </div>
          )}
        </>
      )}
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

/* textTransform, not String(children).toUpperCase() — children is a node array
   and stringifying it renders the commas between them. */
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
