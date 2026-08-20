import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { hit } from './filter';
import { Skeleton } from './ui';

/* Users & Roles — 02-POS-SPEC §2 (`users`), 08-BUILD-STAGES §29.
 *
 * THIS SCREEN DOES NOT EDIT RANKS, AND THAT IS THE DESIGN. Rank assignment
 * lives on Staff & Time Clock, where it has been since that module was built,
 * with the rule that nobody may create or promote above their own rank enforced
 * in the database. A second editor for the same column is how the two come to
 * disagree about what a rank means — this build has already paid for that
 * lesson twice, with five copies of a chart of accounts and four spellings of
 * one table name. So: the rank PICTURE is here, and the button goes there.
 *
 * WHAT IS ONLY HERE is the thing a roster cannot tell you: who is signed in
 * RIGHT NOW, on what machine, and how to get them off it. That was impossible
 * until migration 031 — `chain.session.revoked_at` existed from the first day
 * of this project and nothing read it, so there was no way to sign anybody out.
 * A dismissal at 14:00 left a working session until midnight.
 *
 * THE EMPTY RUNGS MATTER MORE THAN THE FULL ONES. An outlet with nobody at
 * Admin cannot add staff or change a tax rate, and finds that out at the worst
 * possible moment — so a rung with nobody on it is drawn, in red, rather than
 * omitted for tidiness.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};

interface Access {
  ladder: Array<{ rank: number; name: string; people: number }>;
  sessions: Array<{
    id: string; staffId: string; staffName: string; rank: number; rankName: string;
    issuedAt: string; expiresAt: string; scope: string;
    device: { id: string; label: string; revoked: boolean } | null;
    isMine: boolean;
  }>;
  lockedOut: Array<{ id: string; name: string; until: string }>;
  canEnd: boolean;
  myRank: number;
}

const since = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
};
const until = (iso: string) => {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return m <= 0 ? 'expired' : m < 60 ? m + ' min' : Math.round(m / 60) + ' h';
};

export function Users({ session, onGo, search }: { session: Session; onGo: (m: string) => void; search?: string }) {
  /* useMemo, and not decoration. `api.authed(session)` returns a NEW function
     every render, so a `useCallback` that depends on it changes identity every
     render too, and the `useEffect` that loads on it fires on every render —
     an endless fetch loop that also resets this form's fields out from under
     whoever is typing in them. Found by a browser check where a filled input
     came back with its old value. */
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<Access | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState('');

  const load = useCallback(async () => {
    try { setData(await call<Access>('GET', '/access')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const end = async (id: string) => {
    setBusy(id); setError('');
    try { await call('POST', `/access/sessions/${id}/end`, {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); setConfirming(''); }
  };

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={card}><Skeleton /></div>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── the ladder ─────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>The ladder here</div>
        <div style={{ display: 'grid', gap: 7 }}>
          {data.ladder.map((r) => (
            <div key={r.rank} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <span style={{ width: 22, font: `600 13px/1.3 ${MONO}`, color: 'var(--text-faint)' }}>
                {r.rank}
              </span>
              <span style={{ width: 90, font: '500 14px/1.3 system-ui', color: 'var(--text)' }}>
                {r.name}
              </span>
              <span style={{
                font: `400 13px/1.3 ${MONO}`,
                color: r.people === 0 ? 'var(--red-bright)' : 'var(--text-muted)',
              }}>
                {r.people === 0 ? 'nobody' : r.people + (r.people === 1 ? ' person' : ' people')}
              </span>
              {r.people === 0 && r.rank === 4 && (
                <span style={{ font: '400 12px/1.3 system-ui', color: 'var(--red-bright)' }}>
                  — nobody here can add staff or change a tax rate
                </span>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onGo('staff')}
            style={{ padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
              background: 'var(--bg-2)', color: 'var(--text-dim)',
              border: '1px solid var(--line-2)', font: '600 13px/1 system-ui' }}>
            Add somebody, or change a rank
          </button>
          <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', maxWidth: 460 }}>
            Ranks are set on Staff &amp; Time Clock, in one place, where the rule that
            nobody promotes above their own rank is enforced by the database. A second
            editor here would be a second answer to the same question.
          </span>
        </div>
      </div>

      {/* ── signed in right now ────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>Signed in right now</div>
        {data.sessions.length === 0 ? (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
            Nobody. Not even you, which means this list is wrong — reload it.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 9 }}>
            {data.sessions.filter((s) => hit(search, s.staffName, s.rankName, s.device?.label)).map((s) => (
              <div key={s.id} style={{
                padding: '10px 12px', borderRadius: 10,
                background: s.isMine ? 'var(--bg-3)' : 'var(--bg-2)',
                border: '1px solid var(--line)',
                display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
              }}>
                <span style={{ font: '600 14px/1.3 system-ui', color: 'var(--text)', minWidth: 150 }}>
                  {s.staffName}
                </span>
                <span style={{ font: '400 12px/1.3 system-ui', color: 'var(--text-faint)', width: 70 }}>
                  {s.rankName}
                </span>
                <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-muted)', minWidth: 150 }}>
                  {s.device
                    ? s.device.label + (s.device.revoked ? ' (revoked)' : '')
                    /* Not a machine anybody paired. It is not an error — an
                       unpaired till works — but it is the reason an operation
                       can arrive with no device against it. */
                    : 'an unpaired machine'}
                </span>
                <span style={{ font: '400 12px/1.3 system-ui', color: 'var(--text-faint)' }}>
                  in {since(s.issuedAt)} · {until(s.expiresAt)} left
                </span>
                {s.isMine && (
                  <span style={{ font: '600 10px/1.6 system-ui', letterSpacing: '.06em',
                    padding: '1px 6px', borderRadius: 5, background: 'var(--amber)', color: 'var(--on-amber)' }}>
                    YOU
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {data.canEnd && (
                  confirming === s.id ? (
                    <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                      <span style={{ font: '400 12px/1.3 system-ui', color: 'var(--text-muted)' }}>
                        {s.isMine ? 'This signs YOU out.' : 'They lose the till at once.'}
                      </span>
                      <button type="button" disabled={busy === s.id} onClick={() => void end(s.id)}
                        style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                          background: 'var(--red)', color: '#fff', border: 'none',
                          font: '600 12px/1 system-ui' }}>
                        End it
                      </button>
                      <button type="button" onClick={() => setConfirming('')}
                        style={{ padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                          background: 'var(--bg-2)', color: 'var(--text-dim)',
                          border: '1px solid var(--line-2)', font: '600 12px/1 system-ui' }}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirming(s.id)}
                      style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                        background: 'var(--bg-2)', color: 'var(--red-bright)',
                        border: '1px solid var(--red)', font: '600 12px/1 system-ui' }}>
                      Sign out
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 10, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)', maxWidth: 680 }}>
          Ending a session takes effect on that terminal&rsquo;s next request, within
          seconds — not when its token would have expired. Before this existed, a
          dismissal at two in the afternoon left a working till until midnight.
        </div>
      </div>

      {/* ── locked out ─────────────────────────────────────────────────── */}
      {data.lockedOut.length > 0 && (
        <div style={card}>
          <div style={h}>Locked out by wrong PINs</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {data.lockedOut.map((l) => (
              <div key={l.id} style={{ font: '400 13px/1.4 system-ui', color: 'var(--warn-bright)' }}>
                {l.name} — until {until(l.until)} from now
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
            A manager can release one from Staff &amp; Time Clock. The lock is on the
            OUTLET&rsquo;s attempts, not on one account — with PIN-only sign-in nobody
            names an account, so a per-account counter would let somebody walk the
            whole space while no single counter ever climbed.
          </div>
        </div>
      )}

      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
