import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Today — 02-POS-SPEC.md §2 (`today`):
 * "The manager's morning screen: decisions waiting … NOT a dashboard of
 *  numbers; a list of things to do, each linking to where it is done."
 *
 * So there are no tiles, no sparklines and no takings figure. Takings are on
 * the Z-read, where somebody goes to read them; this screen is for the things
 * that need a person. Each row states what is wrong, what it costs to leave it,
 * and opens the module where it is dealt with — the list is a set of doors.
 *
 * The empty state is the most important state on the screen and gets the most
 * care: a manager who opens this and sees "nothing is waiting" has learned
 * something real, and the screen must be able to say it. Every check on the
 * server is written so that a healthy, quiet outlet produces no rows at all.
 */

const SEVERITY: Record<string, { label: string; fg: string; bg: string }> = {
  now: { label: 'NOW', fg: 'var(--red-bright)', bg: 'var(--red-dim)' },
  today: { label: 'TODAY', fg: 'var(--warn-bright)', bg: 'var(--warn-dim)' },
  watch: { label: 'WATCH', fg: 'var(--text-muted)', bg: 'var(--bg-2)' },
};

interface Item {
  id: string; severity: 'now' | 'today' | 'watch'; count: number;
  title: string; detail: string; action: string;
  where: { module: string };
}
interface Day {
  date: string; items: Item[];
  now: number; todayCount: number; watch: number; clear: boolean;
}

export function Today({ session, onGo }: { session: Session; onGo: (module: string) => void }) {
  const [day, setDay] = useState<Day | null>(null);
  const [error, setError] = useState('');
  const [at, setAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/outlet/${session.outletId}/today?date=${new Date().toISOString().slice(0, 10)}`,
        { headers: { authorization: 'Bearer ' + session.token } });
      const text = await r.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (!r.ok) {
        const msg = (json && typeof json === 'object' && 'error' in json)
          ? String((json as { error: unknown }).error) : 'HTTP ' + r.status;
        throw new api.ApiError(r.status, msg);
      }
      setDay(json as Day); setAt(new Date()); setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not read what is waiting.');
    }
  }, [session]);

  useEffect(() => {
    void load();
    /* Two minutes. A guest order nobody has picked up becomes urgent while the
       screen is sitting open on a back-office desk, and a manager should not
       have to know to refresh it. */
    const t = setInterval(() => { void load(); }, 120000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Today</span>
        {day && !day.clear && (
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {[day.now && day.now + ' need' + (day.now === 1 ? 's' : '') + ' you now',
              day.todayCount && day.todayCount + ' before tonight',
              day.watch && day.watch + ' to watch'].filter(Boolean).join(' · ')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {at && (
          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
            as at {at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <button onClick={() => void load()}
          style={{ padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Check again
        </button>
      </div>

      {error && (
        <div role="status" style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--red-dim)', color: 'var(--red-bright)' }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {day === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Checking…'}
          </div>
        ) : day.clear ? (
          <div style={{ padding: '64px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Nothing is waiting</div>
            <div style={{ margin: '10px auto 0', maxWidth: 470, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-muted)' }}>
              No register was left uncounted, no stock has gone negative, nothing was sold
              without a recipe and no till disagreed with the server. This screen only ever
              shows things that need a decision — so an empty one means there are none,
              not that nothing has been checked.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {day.items.map((i) => {
              const s = SEVERITY[i.severity] ?? SEVERITY.watch;
              return (
                <div key={i.id} style={{ display: 'flex', gap: 12, padding: '12px 14px', borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
                  <span style={{
                    flexShrink: 0, alignSelf: 'flex-start', padding: '3px 7px', borderRadius: 5,
                    fontSize: 9, fontWeight: 700, letterSpacing: '.06em',
                    background: s.bg, color: s.fg,
                  }}>{s.label}</span>

                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>
                      {i.title}
                    </span>
                    <span style={{ display: 'block', marginTop: 4, fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>
                      {i.detail}
                    </span>
                  </span>

                  {/* The door. Every row has one — a row a manager cannot act on
                      does not belong on this screen at all. */}
                  <button onClick={() => onGo(i.where.module)}
                    style={{
                      flexShrink: 0, alignSelf: 'center', padding: '8px 13px', borderRadius: 8,
                      fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
                      background: i.severity === 'now' ? 'var(--amber)' : 'var(--bg-2)',
                      border: i.severity === 'now' ? 'none' : '1px solid var(--line)',
                      color: i.severity === 'now' ? 'var(--on-amber)' : 'var(--text)',
                    }}>
                    {i.action}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
