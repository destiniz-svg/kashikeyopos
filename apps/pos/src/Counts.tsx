import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import * as outbox from './outbox';
import { Skeleton } from './ui';

/* Stock Counts — 02-POS-SPEC.md §2 (`counts`):
 * "Count sheets by category; variance in units and MVR; approval above a
 *  threshold."
 *
 * A stock count is the one operation in the platform where a person types a
 * number and the accounts move to meet it. Everything else is derived. That
 * makes this the screen where the design has to be most careful, and two
 * decisions follow from it:
 *
 *  · THE SHEET DOES NOT SHOW THE EXPECTED FIGURE. A sheet that says "there
 *    should be 4,000 g" is a sheet that gets agreed with rather than counted,
 *    and an independent check is the entire point. The expected quantity is
 *    captured server-side when the count is submitted.
 *  · A HELD COUNT SAYS SO, LOUDLY. Above the outlet's threshold nothing moves
 *    until somebody senior signs. The person who counted has to walk away
 *    knowing the stock has NOT changed, or they will assume it has.
 *
 * Counting queues through the outbox like everything else that moves value — a
 * freezer is exactly where there is no signal.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

interface Row {
  id: string; at: string; status: 'pending' | 'posted' | 'rejected';
  categories: string[]; varianceValue: number; threshold: number;
  note: string | null; rejectedReason: string | null;
  by: string | null; approvedBy: string | null; approvedAt: string | null;
  lines: number; differed: number;
}
interface SheetItem { id: string; name: string; unit: string; category: string | null }
interface Blank {
  categories: Array<{ name: string; count: number }>;
  uncategorised: number; chosen: string[]; items: SheetItem[];
}
interface Line {
  ingredientId: string; name: string; unit: string;
  expected: number; counted: number; variance: number; unitCost: number; value: number;
}
interface Sheet {
  count: Row & { applied: boolean };
  lines: Line[];
}

const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  pending: { label: 'WAITING FOR APPROVAL', fg: 'var(--warn-bright)', bg: 'var(--warn-dim)' },
  posted: { label: 'POSTED', fg: 'var(--go-bright)', bg: 'var(--go-dim)' },
  rejected: { label: 'REFUSED', fg: 'var(--red-bright)', bg: 'var(--red-dim)' },
};

export function Counts({ session, onQueued, search, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session; onQueued: () => void | Promise<void>; search?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [threshold, setThreshold] = useState(0);
  const [approveRank, setApproveRank] = useState(4);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [taking, setTaking] = useState<Blank | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
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
      const j = await call('/counts') as { counts: Row[]; threshold: number; approveRank: number };
      setRows(j.counts); setThreshold(j.threshold); setApproveRank(j.approveRank); setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the counts.');
      setRows([]);
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
    setFlash(t); setTimeout(() => setFlash(''), 6000);
  };

  const startSheet = async (cats: string[]) => {
    setError('');
    try {
      setTaking(await call('/counts/sheet?categories=' + encodeURIComponent(cats.join(','))) as Blank);
      setCounted({});
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not build a sheet.');
    }
  };

  const queue = async (kind: string, payload: unknown, said: string) => {
    setBusy(true);
    try {
      await outbox.enqueue(kind, payload);
      say(said);
      setTaking(null); setSheet(null); setCounted({}); setNote('');
      await onQueued();
      setTimeout(() => { void load(); }, 1400);
    } finally { setBusy(false); }
  };

  const canApprove = session.rank >= approveRank;
  const pending = (rows ?? []).filter((r) => r.status === 'pending').length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Stock counts</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {threshold > 0
            ? 'a count worth over ' + mvr(threshold) + ' waits for approval'
            : 'no approval threshold set — every count posts straight away'}
        </span>
        {pending > 0 && (
          <span style={{ padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700, background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>
            {pending} WAITING
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!taking && (
          <button onClick={() => void startSheet([])}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Take a count
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
        {taking ? (
          <TakeSheet
            search={search}
            blank={taking} counted={counted} setCounted={setCounted}
            note={note} setNote={setNote} busy={busy} threshold={threshold}
            onPick={(cats) => void startSheet(cats)}
            onCancel={() => { setTaking(null); setCounted({}); setNote(''); }}
            onSubmit={(lines, cats) => void queue('stock_count',
              { lines, categories: cats, note, date: new Date().toISOString().slice(0, 10) },
              lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' counted — queued.'
              + ' If it is over the limit the stock will not move until it is approved.')}
          />
        ) : rows === null ? (
          <div style={{ padding: 14 }}><Skeleton rows={5} /></div>
        ) : !rows.length ? (
          <div style={{ padding: '54px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>No counts yet</div>
            <div style={{ margin: '9px auto 0', maxWidth: 460, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
              A stock count is the only place the system takes your word for what is on the
              shelf. Take one by category — the freezer, the bar — and the difference between
              what the ledger expected and what you found is posted as a variance.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((r) => {
              const s = STATUS[r.status];
              return (
                <button key={r.id} onClick={() => void (async () => {
                  try { setSheet(await call('/counts/' + r.id) as Sheet); }
                  catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open the sheet.'); }
                })()}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid ' + (r.status === 'pending' ? 'var(--amber-line)' : 'var(--line-soft)'), textAlign: 'left', width: '100%' }}>
                  <span style={{ flexShrink: 0, alignSelf: 'flex-start', padding: '3px 7px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.05em', background: s.bg, color: s.fg }}>
                    {s.label}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                      {r.categories.length ? r.categories.join(', ') : 'Whole store'}
                      <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
                        {' · '}{r.lines} line{r.lines === 1 ? '' : 's'}
                        {', '}{r.differed} differed
                      </span>
                    </span>
                    <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                      {new Date(r.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {r.by && ' · ' + r.by}
                      {r.approvedBy && ' · ' + (r.status === 'rejected' ? 'refused' : 'approved') + ' by ' + r.approvedBy}
                      {r.note && ' · ' + r.note}
                    </span>
                  </span>
                  <span style={{ textAlign: 'right' }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: r.varianceValue === 0 ? 'var(--text-faint)' : r.varianceValue < 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
                      {r.varianceValue > 0 ? '+' : ''}{mvr(r.varianceValue)}
                    </span>
                    {r.status === 'pending' && (
                      <span style={{ display: 'block', fontSize: 9.5, color: 'var(--warn-bright)' }}>
                        stock has not moved
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {sheet && (
        <SheetView
          sheet={sheet} canApprove={canApprove} approveRank={approveRank} busy={busy}
          isMine={false}
          onClose={() => setSheet(null)}
          onApprove={() => void queue('stock_count_approve', { countId: sheet.count.id },
            'Approval queued — the stock moves when it reaches the server.')}
          onReject={(reason) => void queue('stock_count_reject', { countId: sheet.count.id, reason },
            'Refusal queued. Nothing will move.')}
        />
      )}
    </div>
  );
}

/* ── taking a count ──────────────────────────────────────────────────────── */

function TakeSheet({ blank, counted, setCounted, note, setNote, busy, threshold, onPick, onCancel, onSubmit, search }: {
  blank: Blank;
  counted: Record<string, string>;
  setCounted: (v: Record<string, string>) => void;
  note: string; setNote: (v: string) => void;
  busy: boolean; threshold: number;
  onPick: (cats: string[]) => void;
  onCancel: () => void;
  onSubmit: (lines: Array<{ ingredientId: string; counted: number }>, cats: string[]) => void;
  search?: string;
}) {
  const lines = Object.entries(counted)
    .filter(([, v]) => v !== '')
    .map(([ingredientId, v]) => ({ ingredientId, counted: Number(v) }));
  const done = lines.length;

  return (
    <>
      <div style={{ marginBottom: 12, padding: '11px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>WHAT ARE YOU COUNTING</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip on={!blank.chosen.length} onClick={() => onPick([])}>Whole store</Chip>
          {blank.categories.map((c) => (
            <Chip key={c.name} on={blank.chosen.includes(c.name)} onClick={() => onPick([c.name])}>
              {c.name} <span style={{ opacity: .6 }}>{c.count}</span>
            </Chip>
          ))}
        </div>
        {blank.uncategorised > 0 && blank.chosen.length > 0 && (
          <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)' }}>
            {blank.uncategorised} item{blank.uncategorised === 1 ? ' that has' : 's that have'} no
            category {blank.uncategorised === 1 ? 'is' : 'are'} on every sheet — something nobody
            has filed still has to be counted.
          </div>
        )}
        {!blank.categories.length && (
          <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)' }}>
            No ingredient has a category yet. Set one in Recipes &amp; Costing — freezer, bar,
            dry store, whatever the kitchen calls them — and sheets can be taken shelf by shelf.
          </div>
        )}
      </div>

      {/* Deliberately no "expected" column. See the file header. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
        <div style={{ display: 'flex', gap: 12, padding: '8px 13px', background: 'var(--bg-2)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
          <span style={{ flex: 1 }}>ITEM</span>
          <span style={{ width: 130, textAlign: 'right' }}>HOW MANY ARE THERE</span>
        </div>
        {blank.items.filter((i) => hit(search, i.name, i.category, i.unit)).map((i) => (
          <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 13px', background: 'var(--bg-1)' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{i.name}</span>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                {i.category ?? 'no category'} · in {i.unit}
              </span>
            </span>
            <input
              inputMode="decimal" value={counted[i.id] ?? ''}
              onChange={(e) => setCounted({ ...counted, [i.id]: e.target.value })}
              aria-label={'Counted quantity for ' + i.name}
              style={{ width: 130, height: 32, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--amber-line)', color: 'var(--text)', fontSize: 12.5, fontFamily: MONO, textAlign: 'right' }}
            />
          </div>
        ))}
        {!blank.items.length && (
          <div style={{ padding: '26px 13px', background: 'var(--bg-1)', fontSize: 12, color: 'var(--text-faint)' }}>
            Nothing to count in this category.
          </div>
        )}
      </div>

      <label style={{ display: 'block', marginTop: 12 }}>
        <span style={{ display: 'block', marginBottom: 4, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>NOTE</span>
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="month end, walk-in only"
          style={{ width: '100%', height: 34, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5 }} />
      </label>

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 9 }}>
        <button disabled={busy || !done} onClick={() => onSubmit(lines, blank.chosen)}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: done ? 'var(--go)' : 'var(--bg-2)', color: done ? 'var(--on-go)' : 'var(--text-faint)' }}>
          {busy ? 'Queuing…' : 'Submit ' + done + ' line' + (done === 1 ? '' : 's')}
        </button>
        <button onClick={onCancel}
          style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Cancel
        </button>
        {threshold > 0 && (
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)' }}>
            Anything worth over {mvr(threshold)} will wait for approval before the stock moves.
          </span>
        )}
      </div>
    </>
  );
}

/* ── one sheet, and the decision on it ───────────────────────────────────── */

function SheetView({ sheet, canApprove, approveRank, busy, onClose, onApprove, onReject }: {
  sheet: Sheet; canApprove: boolean; approveRank: number; busy: boolean; isMine: boolean;
  onClose: () => void; onApprove: () => void; onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [refusing, setRefusing] = useState(false);
  const c = sheet.count;
  const s = STATUS[c.status];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'var(--scrim)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Count sheet"
        style={{ width: '100%', maxWidth: 660, maxHeight: '86dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
            {c.categories.length ? c.categories.join(', ') : 'Whole store'}
          </span>
          <span style={{ padding: '3px 7px', borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.05em', background: s.bg, color: s.fg }}>{s.label}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {/* The one thing a reader must not get wrong. */}
          {!c.applied && (
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.6, background: c.status === 'rejected' ? 'var(--red-dim)' : 'var(--warn-dim)', color: c.status === 'rejected' ? 'var(--red-bright)' : 'var(--warn-bright)' }}>
              {c.status === 'rejected'
                ? 'This count was refused' + (c.rejectedReason ? ' — ' + c.rejectedReason : '')
                  + '. No stock moved and nothing posted to the accounts. The sheet is kept'
                  + ' because a refused count is evidence.'
                : 'The stock has NOT moved. On-hand still shows the old figure and every dish'
                  + ' costed from it is being costed against stock this count says is not there.'
                  + ' It is worth ' + mvr(Math.abs(c.varianceValue)) + ', over the '
                  + mvr(c.threshold) + ' limit, so it needs rank ' + approveRank + ' to approve.'}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{ flex: 1 }}>ITEM</span>
            <span style={{ width: 88, textAlign: 'right' }}>EXPECTED</span>
            <span style={{ width: 88, textAlign: 'right' }}>COUNTED</span>
            <span style={{ width: 88, textAlign: 'right' }}>DIFFERENCE</span>
            <span style={{ width: 88, textAlign: 'right' }}>VALUE</span>
          </div>
          {sheet.lines.map((l) => (
            <div key={l.ingredientId} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{l.name}</span>
                {/* Up to 4dp, NOT the 2dp used for money elsewhere. A cost per
                    gram is a fraction of a laari — tuna at 0.0850 renders as
                    "0.09" at two places, which is a 6% lie about the cost of
                    every gram-denominated line on the sheet. */}
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                  in {l.unit} · at {l.unitCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} each
                </span>
              </span>
              <Num>{qty(l.expected)}</Num>
              <Num>{qty(l.counted)}</Num>
              {/* Units AND money, side by side — §2 asks for both, and a
                  variance in grams means nothing to whoever signs it. */}
              <span style={{ width: 88, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: l.variance === 0 ? 'var(--text-faint)' : l.variance < 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
                {l.variance > 0 ? '+' : ''}{qty(l.variance)}
              </span>
              <span style={{ width: 88, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: l.value === 0 ? 'var(--text-faint)' : l.value < 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
                {l.value > 0 ? '+' : ''}{mvr(l.value)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 12, padding: '9px 0', fontWeight: 700 }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>
              {sheet.lines.filter((l) => l.variance !== 0).length} of {sheet.lines.length} differed
            </span>
            <span style={{ width: 88 }} /><span style={{ width: 88 }} /><span style={{ width: 88 }} />
            <span style={{ width: 88, textAlign: 'right', fontSize: 14, fontWeight: 700, fontFamily: MONO, color: c.varianceValue < 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
              {c.varianceValue > 0 ? '+' : ''}{mvr(c.varianceValue)}
            </span>
          </div>

          {c.status === 'pending' && (
            canApprove ? (
              refusing ? (
                <div style={{ marginTop: 14 }}>
                  <label style={{ display: 'block', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>WHY</label>
                  <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="counted the delivery twice"
                    style={{ marginTop: 4, width: '100%', height: 34, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5 }} />
                  <div style={{ marginTop: 9, display: 'flex', gap: 8 }}>
                    <button disabled={busy || !reason.trim()} onClick={() => onReject(reason)}
                      style={{ padding: '9px 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: reason.trim() ? 'var(--red-dim-2)' : 'var(--bg-2)', color: reason.trim() ? '#fff' : 'var(--text-faint)' }}>
                      Refuse this count
                    </button>
                    <button onClick={() => setRefusing(false)}
                      style={{ padding: '9px 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button disabled={busy} onClick={onApprove}
                    style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                    Approve — move the stock
                  </button>
                  <button onClick={() => setRefusing(true)}
                    style={{ padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--red-bright)' }}>
                    Refuse
                  </button>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    Approving posts the variance to the accounts.
                  </span>
                </div>
              )
            ) : (
              <div style={{ marginTop: 14, padding: '9px 11px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)' }}>
                Approving a count needs rank {approveRank}. Somebody who did not take it has to
                sign it — that is what the threshold is for.
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span style={{ width: 88, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{children}</span>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 11px', borderRadius: 999, fontSize: 11.5, fontWeight: on ? 700 : 600,
      background: on ? 'var(--amber)' : 'var(--bg-2)',
      border: '1px solid ' + (on ? 'transparent' : 'var(--line)'),
      color: on ? 'var(--on-amber)' : 'var(--text-muted)',
    }}>{children}</button>
  );
}
