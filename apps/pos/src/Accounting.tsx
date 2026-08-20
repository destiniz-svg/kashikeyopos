import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { Settlements } from './Settlements';
import { Overlay } from './ui';

/* Accounting Flow — 02-POS-SPEC.md §2 (`accounting`): "The ledger itself:
 * journals, trial balance, P&L."
 *
 * THE LEDGER IS THE SCREEN. Reports & Exports already draws the three
 * statements, and this is deliberately not a second copy of them: what has
 * never existed anywhere is the entries themselves. Seven modules post — a
 * sale, a payroll run, depreciation, a prepaid release, a stock count, a house
 * account, loyalty — and until now nobody in the building could open one and
 * see what it did. "Revenue was 42,000" is a claim; the eleven entries it is
 * made of are the answer to a question about it.
 *
 * SO EVERY ENTRY SHOWS ITS SIDES. Not a total with a chevron to expand — the
 * lines are the entry, and an accounting screen that hides them by default is
 * asking to be trusted rather than read.
 *
 * A MISTAKE IS ANSWERED, NEVER ERASED. There is no edit and no delete here,
 * because there is none in the database either. A wrong entry is reversed by an
 * equal and opposite one that names it and says why, and both stay on screen —
 * the reversed one struck through, the reversal pointing back at it.
 *
 * WRITING BY HAND IS THE LAST RESORT AND THE FORM SAYS SO. Everything else on
 * the ladder posts its own entries; a journal typed here is either the opening
 * position of a business that existed before this system, or a correction
 * nobody else's screen can make.
 *
 * CARD MONEY IS THE SECOND TAB rather than a rail item of its own, because §2's
 * module list has no `settlements` and the rail IS the design. It belongs here:
 * matching an acquirer's payout is reading the ledger and then writing to it,
 * which is the whole of what this screen is for.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
const clock = (s: string) =>
  new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface Line { account: string; name: string; dr: number; cr: number }
interface Entry {
  id: string; no: string; date: string; memo: string; source: string;
  sourceId: string | null; at: string; by: string | null;
  reversedBy: string | null; reversedByNo: string | null;
  amount: number; lines: Line[];
}
interface Account { code: string; name: string; type: string }
interface Data {
  journals: Entry[];
  next: string | null;
  sources: Array<{ source: string; entries: number }>;
  accounts: Account[];
  canPost: boolean;
}

/* What posted an entry, in words. A source column reading "opcosts" tells
   somebody who wrote the code something and everybody else nothing. */
const SOURCE_LABEL: Record<string, string> = {
  sale: 'A sale',
  stock: 'Stock — a delivery, wastage or a count',
  expense: 'An operating cost',
  payroll: 'A payroll run',
  asset: 'The asset register',
  drawer: 'A drawer count',
  house: 'A house account',
  loyalty: 'Loyalty',
  settlement: 'A card settlement',
  credit_note: 'A credit note',
  transfer: 'Stock moved to or from another branch',
  manual: 'Typed by hand',
  reversal: 'A reversal',
};
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

export function Accounting({ session, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session }) {
  const [tab, setTab] = useState<'ledger' | 'cards'>('ledger');
  const [data, setData] = useState<Data | null>(null);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [more, setMore] = useState<Entry[]>([]);
  const [lastCursor, setLastCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState<Entry | null>(null);

  const call = useMemo(() => api.authed(session), [session]);
  const file = useMemo(() => api.download(session), [session]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ from, to, limit: '40' });
    if (source) p.set('source', source);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
  }, [from, to, source, q]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', `/accounting/journals?${query}`));
      setMore([]);
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not open the ledger.');
      setData(null);
    }
  }, [call, query]);

  /* `tab` is in here on purpose. Coming back from Card money after matching a
     batch showed the ledger as it was when the screen first mounted — without
     the entry just posted, which is the one somebody switched tabs to look
     at. */
  useEffect(() => { if (tab === 'ledger') void load(); }, [load, tab]);

  /* Routed to the terminal's toast when one is supplied (src/ui.tsx), and to
     the module's own banner when it is not. A confirmation belongs at the
     bottom of the SCREEN rather than at the top of one card: the operator who
     just pressed Save is looking at the thing they saved, not at the header.
     Errors are deliberately NOT routed here — those stay in the form, beside
     the field that has to change, until somebody changes it. */
  const say = (t: string) => {
    if (toast) { toast(t); return; }
    setFlash(t); setTimeout(() => setFlash(''), 9000);
  };
  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const older = async () => {
    if (!data?.next && !more.length) return;
    const cursor = more.length ? lastCursor : data?.next;
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await call<Data>('GET',
        `/accounting/journals?${query}&before=${encodeURIComponent(cursor)}`);
      setMore((m) => m.concat(r.journals));
      setLastCursor(r.next);
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not read further back.');
    } finally { setBusy(false); }
  };
  /* A new period or filter is a new listing: the cursor from the old one points
     into a different set of rows. */
  useEffect(() => { setLastCursor(null); }, [query]);

  const entries = (data?.journals ?? []).concat(more);
  const hasMore = more.length ? !!lastCursor : !!data?.next;

  const save = async (name: string) => {
    setBusy(true); setError('');
    try { await file(`/accounting/export?${name}`, 'export.csv'); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not build the file.'); }
    finally { setBusy(false); }
  };

  const tabs = (
    <div style={{ display: 'flex', gap: 6 }}>
      {([['ledger', 'The ledger'], ['cards', 'Card money']] as const).map(([id, label]) => (
        <button key={id} onClick={() => setTab(id)}
          aria-current={tab === id ? 'page' : undefined}
          style={{
            padding: '5px 11px', borderRadius: 7, fontSize: 12,
            fontWeight: tab === id ? 700 : 500,
            background: tab === id ? 'var(--bg-3)' : 'transparent',
            color: tab === id ? 'var(--text)' : 'var(--text-muted)',
          }}>{label}</button>
      ))}
    </div>
  );

  if (tab === 'cards') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          {tabs}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}><Settlements session={session} /></div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {tabs}
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInput} />
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>to</span>
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} style={dateInput} />
        <select aria-label="Posted by" value={source} onChange={(e) => setSource(e.target.value)} style={{ ...dateInput, fontFamily: 'inherit' }}>
          <option value="">everything</option>
          {(data?.sources ?? []).map((s) => (
            <option key={s.source} value={s.source}>
              {sourceLabel(s.source)} ({s.entries})
            </option>
          ))}
        </select>
        <input data-screen-search aria-label="Search" value={q} placeholder="voucher or memo"
          onChange={(e) => setQ(e.target.value)}
          style={{ ...dateInput, width: 170, fontFamily: 'inherit' }} />
        <span style={{ flex: 1 }} />
        {data?.canPost && (
          <button onClick={() => setPosting(true)} disabled={busy}
            style={{ padding: '6px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--accent)', color: 'var(--on-accent)' }}>
            Post an entry
          </button>
        )}
        <button onClick={() => void save(`kind=journal&from=${from}&to=${to}`)} disabled={busy} style={ghost}>
          Journal CSV
        </button>
        <button onClick={() => void save(`kind=trial&from=${from}&to=${to}`)} disabled={busy} style={ghost}>
          Trial balance CSV
        </button>
        <button onClick={() => void save(`kind=tax&from=${from}&to=${to}`)} disabled={busy} style={ghost}>
          Tax CSV
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
            {error ? '' : 'Opening…'}
          </div>
        ) : !entries.length ? (
          <div style={{ padding: '18px 4px 24px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 620 }}>
            Nothing posted in this period. Every sale, payroll run, delivery and stock
            count writes its own entry here — this is the book they all write into, so
            an empty one means nothing has happened yet rather than that something is
            missing.
          </div>
        ) : (
          <>
            {entries.map((j) => (
              <div key={j.id} style={{
                marginBottom: 9, padding: 12, borderRadius: 10, background: 'var(--bg-1)',
                border: '1px solid ' + (j.reversedBy ? 'var(--line-soft)' : 'var(--line)'),
                opacity: j.reversedBy ? 0.72 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: 'var(--text)', textDecoration: j.reversedBy ? 'line-through' : 'none' }}>
                    {j.no}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{j.memo}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {sourceLabel(j.source)} · {j.date} {clock(j.at)}
                    {j.by && ' · ' + j.by}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                    {mvr(j.amount)}
                  </span>
                  {/* Reversing is the only write available against a posted
                      entry, and only for one that has not been reversed and is
                      not itself a reversal. */}
                  {data.canPost && !j.reversedBy && j.source !== 'reversal' && (
                    <button disabled={busy} onClick={() => setReversing(j)}
                      style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                      Reverse
                    </button>
                  )}
                </div>

                {j.reversedBy && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--warn-bright)' }}>
                    Reversed by {j.reversedByNo}. Both entries stay in the ledger.
                  </div>
                )}

                {/* The lines ARE the entry. Always drawn. */}
                <table style={{ marginTop: 8, width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <tbody>
                    {j.lines.map((l, i) => (
                      <tr key={i}>
                        <td style={{ padding: '3px 0', width: 58, fontFamily: MONO, color: 'var(--text-faint)' }}>
                          {l.account}
                        </td>
                        <td style={{ padding: '3px 0', color: 'var(--text-muted)' }}>{l.name}</td>
                        <td style={{ padding: '3px 0', width: 110, textAlign: 'right', fontFamily: MONO, color: l.dr ? 'var(--text)' : 'var(--text-ghost)' }}>
                          {l.dr ? mvr(l.dr) : ''}
                        </td>
                        <td style={{ padding: '3px 0', width: 110, textAlign: 'right', fontFamily: MONO, color: l.cr ? 'var(--text)' : 'var(--text-ghost)' }}>
                          {l.cr ? mvr(l.cr) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {hasMore && (
              <button onClick={() => void older()} disabled={busy}
                style={{ marginTop: 6, padding: '8px 16px', borderRadius: 7, fontSize: 12, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                {busy ? 'Reading…' : 'Older entries'}
              </button>
            )}
          </>
        )}
      </div>

      {posting && data && (
        <PostEntry accounts={data.accounts} busy={busy}
          onClose={() => setPosting(false)}
          onPost={(body) => act(
            () => call('POST', '/accounting/journal', body),
            'Posted.').then(() => setPosting(false))} />
      )}
      {reversing && (
        <Reverse entry={reversing} busy={busy} onClose={() => setReversing(null)}
          onReverse={(reason) => act(
            () => call('POST', `/accounting/journal/${reversing.id}/reverse`, { reason }),
            'Reversed. Both entries stay in the ledger.').then(() => setReversing(null))} />
      )}
    </div>
  );
}

/* ── typing one by hand ──────────────────────────────────────────────────── */

interface Draft { account: string; dr: string; cr: string }

function PostEntry({ accounts, busy, onClose, onPost }: {
  accounts: Account[]; busy: boolean; onClose: () => void;
  onPost: (b: Record<string, unknown>) => void;
}) {
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState<Draft[]>([
    { account: '', dr: '', cr: '' }, { account: '', dr: '', cr: '' },
  ]);

  const num = (s: string) => Math.round((Number(s) || 0) * 100);
  const dr = rows.reduce((a, r) => a + num(r.dr), 0);
  const cr = rows.reduce((a, r) => a + num(r.cr), 0);
  const out = dr - cr;
  const ready = memo.trim().length >= 4 && dr > 0 && out === 0
    && rows.filter((r) => r.account && (num(r.dr) > 0 || num(r.cr) > 0)).length >= 2;

  const set = (i: number, patch: Partial<Draft>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal title="Post an entry" onClose={onClose}>
      <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)', marginBottom: 12, maxWidth: 560 }}>
        Everything else on the system posts its own entries. Use this for the opening
        position of a business that existed before it, or for a correction no other
        screen can make — and remember it cannot be edited afterwards, only reversed.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={lbl}>Date
          <input type="date" aria-label="Date" value={date}
            onChange={(e) => setDate(e.target.value)} style={inp} />
        </label>
        <label style={{ ...lbl, flex: 1, minWidth: 240 }}>What this is
          <input aria-label="Memo" value={memo} maxLength={200}
            placeholder="Opening balances at handover"
            onChange={(e) => setMemo(e.target.value)} style={inp} />
        </label>
      </div>

      <table style={{ marginTop: 14, width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text-faint)', fontSize: 10, letterSpacing: '.06em' }}>
            <th style={{ textAlign: 'left', padding: '0 0 5px' }}>ACCOUNT</th>
            <th style={{ textAlign: 'right', padding: '0 0 5px', width: 120 }}>DEBIT</th>
            <th style={{ textAlign: 'right', padding: '0 0 5px', width: 120 }}>CREDIT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ padding: '3px 6px 3px 0' }}>
                <select aria-label={`Account ${i + 1}`} value={r.account}
                  onChange={(e) => set(i, { account: e.target.value })}
                  style={{ ...inp, width: '100%', fontFamily: 'inherit' }}>
                  <option value="">choose an account…</option>
                  {accounts.map((a) => (
                    <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </td>
              {/* One side or the other: typing in one clears the other, because
                  a line that is both is neither and the server will say so. */}
              <td style={{ padding: '3px 0' }}>
                <input aria-label={`Debit ${i + 1}`} inputMode="decimal" value={r.dr}
                  onChange={(e) => set(i, { dr: e.target.value, cr: '' })}
                  style={{ ...inp, width: '100%', textAlign: 'right', fontFamily: MONO }} />
              </td>
              <td style={{ padding: '3px 0 3px 6px' }}>
                <input aria-label={`Credit ${i + 1}`} inputMode="decimal" value={r.cr}
                  onChange={(e) => set(i, { cr: e.target.value, dr: '' })}
                  style={{ ...inp, width: '100%', textAlign: 'right', fontFamily: MONO }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button onClick={() => setRows((rs) => rs.concat([{ account: '', dr: '', cr: '' }]))}
        style={{ ...ghost, marginTop: 8 }}>Another line</button>

      {/* The running difference, always visible. An entry that does not balance
          is refused, and finding out at the moment of pressing Post is worse
          than watching it converge. */}
      <div style={{ marginTop: 12, display: 'flex', gap: 18, alignItems: 'baseline', fontSize: 12, fontFamily: MONO }}>
        <span style={{ color: 'var(--text-faint)' }}>debits <b style={{ color: 'var(--text)' }}>{mvr(dr / 100)}</b></span>
        <span style={{ color: 'var(--text-faint)' }}>credits <b style={{ color: 'var(--text)' }}>{mvr(cr / 100)}</b></span>
        <span style={{ color: out === 0 ? 'var(--go-bright)' : 'var(--warn-bright)' }}>
          {out === 0 ? 'balanced' : 'out by ' + mvr(Math.abs(out) / 100)}
        </span>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
        <button onClick={onClose} style={ghost}>Cancel</button>
        <button disabled={!ready || busy}
          onClick={() => onPost({
            date, memo,
            lines: rows
              .filter((r) => r.account && (num(r.dr) > 0 || num(r.cr) > 0))
              .map((r) => ({ account: r.account, dr: Number(r.dr) || 0, cr: Number(r.cr) || 0 })),
          })}
          style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ready ? 'var(--accent)' : 'var(--bg-2)', color: ready ? 'var(--on-accent)' : 'var(--text-ghost)' }}>
          Post it
        </button>
      </div>
    </Modal>
  );
}

function Reverse({ entry, busy, onClose, onReverse }: {
  entry: Entry; busy: boolean; onClose: () => void; onReverse: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={'Reverse ' + entry.no} onClose={onClose}>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 520 }}>
        <b style={{ color: 'var(--text)' }}>{entry.memo}</b> — {mvr(entry.amount)}.
        <div style={{ marginTop: 7, color: 'var(--text-faint)' }}>
          This posts a new entry with the sides swapped. Nothing is deleted: both stay
          in the ledger, which is how somebody later can see what happened and why.
        </div>
      </div>
      <label style={{ ...lbl, marginTop: 12, width: '100%' }}>Why
        <input aria-label="Why" value={reason} maxLength={160} autoFocus
          placeholder="the handover figures were restated"
          onChange={(e) => setReason(e.target.value)} style={{ ...inp, width: '100%' }} />
      </label>
      <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
        <button onClick={onClose} style={ghost}>Cancel</button>
        <button disabled={reason.trim().length < 4 || busy}
          onClick={() => onReverse(reason.trim())}
          style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: reason.trim().length >= 4 ? 'var(--accent)' : 'var(--bg-2)', color: reason.trim().length >= 4 ? 'var(--on-accent)' : 'var(--text-ghost)' }}>
          Reverse it
        </button>
      </div>
    </Modal>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <Overlay onClose={onClose} label={title} width={680} scroll>
    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
      {title}
    </div>
    {children}
    </Overlay>
  );
}

const dateInput: React.CSSProperties = {
  height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO,
};
const inp: React.CSSProperties = { ...dateInput, height: 32 };
const lbl: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5,
  letterSpacing: '.05em', color: 'var(--text-faint)',
};
const ghost: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 7, fontSize: 11.5, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text-muted)',
};
