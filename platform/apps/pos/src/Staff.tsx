import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import * as outbox from './outbox';

/* Staff & Time Clock — 02-POS-SPEC.md §2 (`staff`):
 * "Roster, clock in/out, rank assignment."
 *
 * Two things that are usually separate screens, together because they answer
 * each other: who works here and what rank they hold, and who is actually in
 * the building right now. A rota nobody clocks against is a wish; a clock with
 * no roster behind it cannot tell you who forgot to press the button.
 *
 * Rank is the only gate in this system, so this is the most dangerous screen in
 * the build. It shows what THIS caller may do rather than offering buttons the
 * server will refuse — and the rank dropdown stops at the caller's own rank,
 * because nobody may create or promote above themselves. That rule is enforced
 * in the database, not here; the UI just declines to lie about it.
 */

const MONO = "'JetBrains Mono',monospace";
const hhmm = (s: string) =>
  new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface Person {
  id: string; name: string; rank: number; rankName: string; active: boolean;
  lockedUntil: string | null; failedAttempts: number;
  onShift: boolean; shiftId: string | null; onSince: string | null; onFor: number | null;
  runaway: boolean; weekHours: number; weekShifts: number;
}
interface Shift {
  id: string; staffId: string; name: string; rank: number;
  inAt: string; outAt: string | null; hours: number | null; open: boolean;
  inBy: string | null; outBy: string | null; note: string | null;
}
interface Data {
  roster: Person[];
  day: { date: string; shifts: Shift[]; totalHours: number; stillOpen: number };
  ranks: Record<string, string>;
  maxRank: number;
  canWrite: boolean;
}

export function Staff({ session, onQueued }: { session: Session; onQueued: () => void | Promise<void> }) {
  const [data, setData] = useState<Data | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', '/staff?date=' + new Date().toISOString().slice(0, 10)));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the roster.');
      setData(null);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 5000); };

  const clock = async (p: Person, kind: 'clock_in' | 'clock_out') => {
    setBusy(true);
    try {
      await outbox.enqueue(kind, { staffId: p.id });
      say(p.name + (kind === 'clock_in' ? ' clocked in' : ' clocked out') + ' — queued');
      await onQueued();
      setTimeout(() => { void load(); }, 1300);
    } finally { setBusy(false); }
  };

  const write = async (method: string, path: string, body: unknown, said: string) => {
    setBusy(true); setError('');
    try {
      await call(method, path, body);
      say(said); setAdding(false); setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  const on = (data?.roster ?? []).filter((p) => p.onShift);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Staff</span>
        {data && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {on.length ? on.length + ' in the building' : 'nobody clocked in'}
            {data.day.totalHours > 0 && ' · ' + data.day.totalHours + ' hours worked today'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {data?.canWrite && !adding && (
          <button onClick={() => setAdding(true)}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Add somebody
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
        {data === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Loading…'}
          </div>
        ) : (
          <>
            {adding && (
              <PersonForm
                title="Add somebody" maxRank={data.maxRank} ranks={data.ranks} busy={busy}
                onCancel={() => setAdding(false)}
                onSave={(body) => void write('POST', '/staff', body,
                  body.name + ' added. Tell them their PIN now — it cannot be shown again.')}
              />
            )}
            {editing && (
              <PersonForm
                title={editing.name} person={editing} maxRank={data.maxRank} ranks={data.ranks} busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(body) => void write('PATCH', '/staff/' + editing.id, body, 'Saved.')}
              />
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', gap: 12, padding: '8px 13px', background: 'var(--bg-2)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                <span style={{ flex: 1 }}>WHO</span>
                <span style={{ width: 130 }}>ON SHIFT</span>
                <span style={{ width: 110, textAlign: 'right' }}>HOURS THIS WEEK</span>
                <span style={{ width: 210 }} />
              </div>
              {data.roster.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)', opacity: p.active ? 1 : .55 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{p.name}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                        {p.rankName.toUpperCase()}
                      </span>
                      {!p.active && <Tag>Off the roster</Tag>}
                      {p.lockedUntil && (
                        <Tag tone="red">Locked out until {hhmm(p.lockedUntil)}</Tag>
                      )}
                      {p.runaway && <Tag tone="red">Clock still running</Tag>}
                    </span>
                    {p.failedAttempts > 0 && !p.lockedUntil && (
                      <span style={{ display: 'block', marginTop: 3, fontSize: 10, color: 'var(--text-faint)' }}>
                        {p.failedAttempts} failed PIN attempt{p.failedAttempts === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>

                  <span style={{ width: 130, fontSize: 11.5, color: p.onShift ? 'var(--go-bright)' : 'var(--text-faint)' }}>
                    {p.onShift
                      ? 'since ' + hhmm(p.onSince as string)
                        + (p.onFor !== null ? ' · ' + p.onFor + 'h' : '')
                      : '—'}
                  </span>

                  <span style={{ width: 110, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text-dim)' }}>
                    {p.weekHours ? p.weekHours + 'h' : '—'}
                    {p.weekShifts > 0 && (
                      <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>
                        {p.weekShifts} shift{p.weekShifts === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>

                  <span style={{ width: 210, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {p.active && (
                      <RowBtn disabled={busy} onClick={() => void clock(p, p.onShift ? 'clock_out' : 'clock_in')}>
                        {p.onShift ? 'Clock out' : 'Clock in'}
                      </RowBtn>
                    )}
                    {p.lockedUntil && (
                      <RowBtn disabled={busy}
                        onClick={() => void write('POST', '/staff/' + p.id + '/unlock', {},
                          p.name + ' can sign in again')}>
                        Unlock
                      </RowBtn>
                    )}
                    {data.canWrite && p.rank <= data.maxRank && (
                      <RowBtn onClick={() => setEditing(p)}>Edit</RowBtn>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {/* The day's shifts, because "who was in on Tuesday" is the question
                a roster cannot answer and a payroll run depends on. */}
            <section style={{ marginTop: 18 }}>
              <div style={{ margin: '0 2px 8px', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>
                Today&apos;s shifts
                {data.day.stillOpen > 0 && (
                  <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
                    {' — '}{data.day.stillOpen} still running
                  </span>
                )}
              </div>
              {!data.day.shifts.length ? (
                <div style={{ padding: '26px 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>
                  Nobody has clocked in today. Hours recorded here are what payroll will pay
                  against, so a shift that was never clocked is a shift nobody gets paid for.
                </div>
              ) : (
                data.day.shifts.map((s) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ width: 110, fontSize: 11.5, fontFamily: MONO, color: 'var(--text-dim)' }}>
                      {hhmm(s.inAt)}–{s.outAt ? hhmm(s.outAt) : '…'}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text)' }}>{s.name}</span>
                      {(s.inBy || s.outBy || s.note) && (
                        <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                          {[s.inBy && 'clocked in by ' + s.inBy,
                            s.outBy && 'clocked out by ' + s.outBy,
                            s.note].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span style={{ width: 80, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: s.open ? 'var(--go-bright)' : 'var(--text-dim)' }}>
                      {s.hours !== null ? s.hours + 'h' : 'running'}
                    </span>
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* ── adding and editing ──────────────────────────────────────────────────── */

function PersonForm({ title, person, maxRank, ranks, busy, onCancel, onSave }: {
  title: string;
  person?: Person;
  maxRank: number;
  ranks: Record<string, string>;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { name: string; rank?: number; pin?: string; active?: boolean }) => void;
}) {
  const [name, setName] = useState(person?.name ?? '');
  const [rank, setRank] = useState(String(person?.rank ?? 2));
  const [pin, setPin] = useState('');
  const [active, setActive] = useState(person?.active ?? true);
  const isNew = !person;

  /* The dropdown stops at the caller's own rank. Offering rank 5 to an admin
     and then refusing it is a worse experience than not offering it, and it
     teaches people that the screen lies. */
  const options = Object.entries(ranks)
    .map(([k, v]) => ({ rank: Number(k), name: v }))
    .filter((o) => o.rank <= maxRank)
    .sort((a, b) => a.rank - b.rank);

  const ok = name.trim().length > 0 && (!isNew || pin.length >= 4);

  return (
    <div style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}>
      <div style={{ marginBottom: 10, fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 11 }}>
        <L label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={inp} />
        </L>
        <L label="Rank" hint="Rank is the only gate in the system. Nobody can be given a rank above your own.">
          <select value={rank} onChange={(e) => setRank(e.target.value)} style={inp}>
            {options.map((o) => (
              <option key={o.rank} value={o.rank}>{o.rank} · {o.name}</option>
            ))}
          </select>
        </L>
        <L label={isNew ? 'PIN' : 'New PIN (leave empty to keep)'}
          hint={isNew
            ? 'Tell them this now — it is hashed and can never be shown again.'
            : 'Setting one also releases any lockout.'}>
          <input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)}
            style={{ ...inp, fontFamily: MONO }} placeholder="4 to 12 digits" />
        </L>
      </div>

      {!isNew && (
        <label style={{ marginTop: 11, display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)' }}>
            On the roster
            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-faint)' }}>
              Taking somebody off stops them signing in and clocking on. Their shifts and every
              sale they rang stay exactly where they are — this is not a delete.
            </span>
          </span>
        </label>
      )}

      <div style={{ marginTop: 13, display: 'flex', gap: 8 }}>
        <button disabled={busy || !ok}
          onClick={() => onSave({
            name: name.trim(),
            rank: Number(rank),
            ...(pin ? { pin } : {}),
            ...(isNew ? {} : { active }),
          })}
          style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          {busy ? 'Saving…' : isNew ? 'Add them' : 'Save'}
        </button>
        <button onClick={onCancel}
          style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const inp: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5,
};

function RowBtn({ children, onClick, disabled }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
      background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)',
    }}>{children}</button>
  );
}

function Tag({ tone, children }: { tone?: 'red'; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700,
      background: tone === 'red' ? 'var(--red-dim)' : 'var(--bg-2)',
      color: tone === 'red' ? 'var(--red-bright)' : 'var(--text-faint)',
    }}>{children}</span>
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
