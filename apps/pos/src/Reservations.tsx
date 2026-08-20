import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import { Overlay } from './ui';

/* Reservations — 02-POS-SPEC.md §2 (`reservations`):
 * "Tonight's book, table assignment, arrival state."
 *
 * THE BOOK IS A CLOCK, NOT A LIST. What a host needs at ten past seven is not
 * "here are tonight's twelve bookings" but "these two are late, this one is due
 * in ten minutes, and these four are sitting down". So the late ones are at the
 * top, in red, with how many minutes — because four minutes and forty minutes
 * are different decisions about a table — and the rest of the evening runs
 * underneath in time order.
 *
 * SEATING IS ONE PRESS, and it opens the ticket. The covers, the name and the
 * table go with it, so the host does not type the same four facts into the till
 * thirty seconds later. That is the whole reason this is a module and not a
 * diary by the door.
 *
 * A BOOKING WITH NO TABLE IS NORMAL. A host takes the name at eleven in the
 * morning and decides the room at six, so the table is asked for at the moment
 * it is needed — when the party walks in — and never before.
 */

const MONO = "'JetBrains Mono',monospace";

interface Booking {
  id: string; onDate: string; atMin: number; at: string; mins: number; until: string;
  covers: number; name: string; phone: string | null; memberId: string | null;
  note: string | null; tableNo: string | null;
  status: 'booked' | 'seated' | 'done' | 'no_show' | 'cancelled';
  seatedAt: string | null; ticketId: string | null; ticketOpen: boolean;
  reason: string | null; by: string | null;
  lateBy: number; dueIn: number | null;
}
interface Data {
  date: string;
  reservations: Booking[];
  late: Booking[]; soon: Booking[]; seated: Booking[];
  totals: { bookings: number; covers: number; seated: number; noShows: number };
  heldTables: string[];
}

const STATUS: Record<string, { label: string; fg: string }> = {
  booked: { label: 'booked', fg: 'var(--text-faint)' },
  seated: { label: 'sitting', fg: 'var(--go-bright)' },
  done: { label: 'left', fg: 'var(--text-faint)' },
  no_show: { label: 'never came', fg: 'var(--stop-bright)' },
  cancelled: { label: 'cancelled', fg: 'var(--text-faint)' },
};

const today = () => new Date().toISOString().slice(0, 10);

export function Reservations({ session, search, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session; search?: string }) {
  const [date, setDate] = useState(today());
  /* The outlet's OWN tables, so a host picks one rather than inventing a name
     for it. The server normalises anyway — "2" and "T02" are one table — but a
     list is how somebody learns what the tables are called. */
  const [tables, setTables] = useState<string[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [seating, setSeating] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', '/reservations?date=' + date));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the book.');
      setData(null);
    }
  }, [call, date]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    (async () => {
      try {
        const s = await call<{ outlet?: { tables?: number } }>('GET', '/snapshot');
        const n = Number(s.outlet?.tables ?? 0);
        setTables(Array.from({ length: n }, (_, i) =>
          'T' + (i + 1 < 10 ? '0' + (i + 1) : String(i + 1))));
      } catch { setTables([]); }
    })();
  }, [call]);
  /* The book is a clock, so it ticks. A host who walked away for ten minutes
     comes back to a screen that has moved on without them. */
  useEffect(() => {
    if (date !== today()) return;
    const t = setInterval(() => { void load(); }, 60000);
    return () => clearInterval(t);
  }, [load, date]);

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

  const live = data?.reservations.filter(
    (r) => r.status === 'booked' || r.status === 'seated') ?? [];
  const closed = data?.reservations.filter(
    (r) => r.status !== 'booked' && r.status !== 'seated') ?? [];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>The book</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          aria-label="Which day"
          style={{ height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO }} />
        {data && (
          <>
            <Fig label="COVERS" value={String(data.totals.covers)} big />
            <Fig label="BOOKINGS" value={String(data.totals.bookings)} />
            <Fig label="SITTING" value={String(data.totals.seated)} />
            {data.totals.noShows > 0 && (
              <Fig label="NEVER CAME" value={String(data.totals.noShows)} />
            )}
          </>
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
            {/* THE LATE ONES FIRST. This is the only part of the screen a host
                looks at when the room is full. */}
            {data.late.length > 0 && (
              <div style={{ marginBottom: 14, padding: 13, borderRadius: 10, background: 'var(--stop-dim)', border: '1px solid var(--stop)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--stop-bright)' }}>
                  {data.late.length} {data.late.length === 1 ? 'party has' : 'parties have'} not
                  arrived
                </div>
                {data.late.map((r) => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0', borderTop: '1px solid var(--line-soft)' }}>
                    <span style={{ width: 54, fontSize: 12, fontFamily: MONO, color: 'var(--text)' }}>
                      {r.at}
                    </span>
                    <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>
                      {r.name}
                      <span style={{ marginLeft: 7, fontSize: 10.5, color: 'var(--text-faint)' }}>
                        {r.covers} · {r.tableNo ? 'table ' + r.tableNo : 'no table yet'}
                      </span>
                    </span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: 'var(--stop-bright)' }}>
                      {r.lateBy} min late
                    </span>
                    <button disabled={busy} onClick={() => setSeating(r)}
                      style={{ padding: '5px 11px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                      They&apos;re here
                    </button>
                    <button disabled={busy}
                      onClick={() => act(() => call('POST', `/reservations/${r.id}/no-show`, {}),
                        r.name + ' marked as a no-show. It stays on the book.')}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                      No-show
                    </button>
                  </div>
                ))}
              </div>
            )}

            <Take busy={busy} date={date} held={data.heldTables} tables={tables}
              onBook={(b) => act(() => call('POST', '/reservations', b), 'In the book.')} />

            {!live.length && !closed.length ? (
              <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 560 }}>
                Nothing in the book for this day. A booking taken here holds its table for as long
                as you say it does, so two parties cannot be sold the same one — and when they
                arrive, one press opens their ticket with the covers and the name already on it.
              </div>
            ) : (
              <>
                {live.length > 0 && <SubHead>The evening</SubHead>}
                {live.filter((r) => hit(search, r.name, r.phone, r.tableNo, r.at, r.status)).map((r) => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ width: 54, fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                      {r.at}
                    </span>
                    <span style={{ width: 62, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      to {r.until}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                        {r.name}
                        {r.note && (
                          <span style={{ marginLeft: 7, fontSize: 10.5, fontWeight: 500, color: 'var(--text-faint)' }}>
                            {r.note}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {r.covers} {r.covers === 1 ? 'cover' : 'covers'}
                        {r.phone && ' · ' + r.phone}
                        {r.dueIn !== null && r.dueIn <= 30 && ' · due in ' + r.dueIn + ' min'}
                      </span>
                    </span>
                    <span style={{ width: 78, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: r.tableNo ? 'var(--text)' : 'var(--text-faint)' }}>
                      {r.tableNo ? 'table ' + r.tableNo : '—'}
                    </span>
                    <span style={{ width: 66, textAlign: 'right', fontSize: 10.5, color: STATUS[r.status].fg }}>
                      {STATUS[r.status].label}
                    </span>
                    {r.status === 'booked' ? (
                      <>
                        <button disabled={busy} onClick={() => setSeating(r)}
                          style={{ padding: '5px 11px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                          They&apos;re here
                        </button>
                        <button disabled={busy}
                          onClick={() => act(() => call('POST', `/reservations/${r.id}/cancel`, {}),
                            'Cancelled. The table is free again.')}
                          style={{ padding: '5px 9px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button disabled={busy}
                        onClick={() => act(() => call('POST', `/reservations/${r.id}/finish`, {}),
                          'Table free. The ticket stays open until the till closes it.')}
                        style={{ padding: '5px 11px', borderRadius: 6, fontSize: 11.5, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                        They&apos;ve left
                      </button>
                    )}
                  </div>
                ))}

                {closed.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <SubHead>Closed off</SubHead>
                    {closed.map((r) => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 2px', borderBottom: '1px solid var(--line-soft)', color: 'var(--text-faint)' }}>
                        <span style={{ width: 54, fontSize: 11, fontFamily: MONO }}>{r.at}</span>
                        <span style={{ flex: 1, fontSize: 11.5 }}>
                          {r.name}
                          {r.reason && ' · ' + r.reason}
                        </span>
                        <span style={{ width: 78, textAlign: 'right', fontSize: 10.5 }}>
                          {r.covers} covers
                        </span>
                        <span style={{ width: 90, textAlign: 'right', fontSize: 10.5, color: STATUS[r.status].fg }}>
                          {STATUS[r.status].label}
                        </span>
                      </div>
                    ))}
                    {/* Said once, because it is the reason the rows are here. */}
                    <p style={{ margin: '7px 2px 0', fontSize: 10.5, color: 'var(--text-faint)' }}>
                      A booking that never arrived stays on the book. A name that does it twice a
                      month is worth knowing about.
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {seating && (
        <Seat booking={seating} busy={busy} held={data?.heldTables ?? []} tables={tables}
          onClose={() => setSeating(null)}
          onSeat={(tableNo) => act(async () => {
            const r = await call<{ message: string }>(
              'POST', `/reservations/${seating.id}/seat`, { tableNo });
            say(r.message);
          }, '').then(() => setSeating(null))} />
      )}
    </div>
  );
}

/* ── taking a booking ────────────────────────────────────────────────────── */

function Take({ busy, date, held, tables, onBook }: {
  busy: boolean; date: string; held: string[]; tables: string[];
  onBook: (b: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [at, setAt] = useState('19:00');
  const [covers, setCovers] = useState('2');
  const [phone, setPhone] = useState('');
  const [tableNo, setTableNo] = useState('');
  const [mins, setMins] = useState('90');
  const [note, setNote] = useState('');

  const coversN = Number(covers) || 0;
  const ok = name.trim() !== '' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(at) && coversN > 0;

  return (
    <div style={{ marginBottom: 18, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <SubHead>Take a booking</SubHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 130px), 1fr))', gap: 11, marginTop: 6 }}>
        <L label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            aria-label="Name" style={inp} />
        </L>
        <L label="Time">
          <input value={at} onChange={(e) => setAt(e.target.value)} placeholder="19:30"
            aria-label="Time" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Covers">
          <input inputMode="numeric" value={covers} onChange={(e) => setCovers(e.target.value)}
            aria-label="Covers" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Phone">
          <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
            aria-label="Phone" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Table" hint="Leave blank — decide the room later.">
          <select value={tableNo} onChange={(e) => setTableNo(e.target.value)}
            aria-label="Table" style={{ ...inp, fontFamily: MONO }}>
            <option value="">decide later</option>
            {tables.map((t) => (
              <option key={t} value={t}>{t}{held.includes(t) ? ' — held' : ''}</option>
            ))}
          </select>
        </L>
        <L label="Held for (min)" hint="How long the table is theirs.">
          <input inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)}
            aria-label="Held for minutes" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Note">
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="birthday, high chair…" aria-label="Note" style={inp} />
        </L>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button disabled={busy || !ok} onClick={() => {
          onBook({
            onDate: date, name: name.trim(), at, covers: coversN,
            phone: phone.trim() || null, tableNo: tableNo.trim() || null,
            mins: Number(mins) || 90, note: note.trim() || null,
          });
          setName(''); setPhone(''); setTableNo(''); setNote('');
        }}
          style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          Put it in the book
        </button>
        {/* Which tables are already spoken for, so a host on the telephone can
            see the evening rather than guess at it. */}
        {held.length > 0 && (
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            Already held today: {held.map((t) => 'table ' + t).join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── they arrived ────────────────────────────────────────────────────────── */

function Seat({ booking, busy, held, tables, onClose, onSeat }: {
  booking: Booking; busy: boolean; held: string[]; tables: string[];
  onClose: () => void; onSeat: (tableNo: string) => void;
}) {
  const [tableNo, setTableNo] = useState(booking.tableNo || '');
  return (
    <Overlay onClose={onClose} label="Seat the party" width={460}>
    <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{booking.name}</span>
      <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
        {booking.covers} covers · {booking.at}
      </span>
      <span style={{ flex: 1 }} />
      <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div style={{ padding: 16 }}>
      <L label="Which table">
        <select value={tableNo} onChange={(e) => setTableNo(e.target.value)}
          aria-label="Which table" style={{ ...inp, fontFamily: MONO, fontSize: 15 }}>
          <option value="">choose…</option>
          {tables.map((t) => (
            <option key={t} value={t}>{t}{held.includes(t) ? ' — held' : ''}</option>
          ))}
        </select>
      </L>
      {held.length > 0 && (
        <p style={{ margin: '7px 2px 0', fontSize: 10.5, color: 'var(--text-faint)' }}>
          Held today: {held.map((t) => 'table ' + t).join(', ')}
        </p>
      )}
      <button disabled={busy || !tableNo.trim()} onClick={() => onSeat(tableNo.trim())}
        style={{ marginTop: 14, width: '100%', minHeight: 44, borderRadius: 9, fontSize: 13.5, fontWeight: 700, background: tableNo.trim() ? 'var(--go)' : 'var(--bg-2)', color: tableNo.trim() ? 'var(--on-go)' : 'var(--text-faint)' }}>
        Sit them down
      </button>
      {/* What the button actually does, said before it is pressed. */}
      <p style={{ margin: '10px 2px 0', fontSize: 11, lineHeight: 1.55, color: 'var(--text-faint)' }}>
        This opens their ticket on that table with {booking.covers} covers and the name
        already on it — nothing to type again at the till.
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
