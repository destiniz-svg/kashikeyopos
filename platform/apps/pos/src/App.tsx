import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session, Snapshot } from './api';
import * as outbox from './outbox';
import { navFor, landingFor } from './nav';
import { Lock } from './Lock';
import { Floor } from './Floor';
import { Kds } from './Kds';
import { Menu } from './Menu';
import { NotBuilt } from './NotBuilt';

/* ═══ KASHIKEYOPOS — THE TILL ══════════════════════════════════════════════
 *
 * Ported from design/KashikeyoPOS Guest Theme v3.dc.html against
 * docs/02-POS-SPEC.md. The palette, the type scale and the rail's icon paths
 * are the prototype's, unchanged; packages/tokens/pos.css is its <style> block
 * copied verbatim.
 *
 * WHAT IS BUILT IN THIS DEPLOYMENT: the shell (rail, topbar, lock), the POS
 * Floor and the payment modal — Stage 1's selling path, end to end, against the
 * money chain the backend already proves. The other modules appear in the rail
 * because the rail IS the design, and each says plainly that it is not built
 * yet rather than rendering an empty screen that looks finished. A module that
 * pretends to work is worse than one that admits it does not.
 */

const MODULES_BUILT = new Set(['pos', 'kds', 'menu']);

const LS_SESSION = 'kashikeyo.pos.session.v1';

export function App({ outletId }: { outletId: number }) {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState('pos');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [now, setNow] = useState(() => new Date());
  const [railOpen, setRailOpen] = useState(true);

  /* §1.4: "A terminal with nobody signed in IS locked." The session is restored
     from storage so a reload mid-service does not throw the cashier back to the
     PIN pad — but it is the SERVER's token that authorises anything, and that
     expires on its own schedule. */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_SESSION);
      if (raw) {
        const s = JSON.parse(raw) as Session;
        if (s && s.token) { setSession(s); setView(landingFor(s.rank)); }
      }
    } catch { /* nothing stored */ }
  }, []);

  /* §5: "now — ticked every second — ages are derived, never stored." A table's
     age counts up from openedAt for as long as the terminal is open. */
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  /* The UI reads the CACHE; the network refreshes it (§5). So a snapshot is
     loaded from IndexedDB first and rendered immediately — a till that opens to
     a spinner because the wifi is slow is a till nobody can sell on. */
  useEffect(() => {
    void outbox.getCache<Snapshot>('snapshot').then((s) => { if (s) setSnap(s); });
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const s = await api.snapshot(session.outletId, session.token);
      setSnap(s);
      await outbox.putCache('snapshot', s);
    } catch { /* the cache stands; the topbar already says we are offline */ }
  }, [session]);

  /* Drain the outbox whenever there is a network and something to send. This is
     the only place a queued operation reaches the server. */
  const drain = useCallback(async () => {
    if (!session || !navigator.onLine) return;
    await outbox.drain(async (op) => {
      try {
        const r = await api.push(session.outletId, session.token,
          { opId: op.opId, kind: op.kind, payload: op.payload, at: op.at });
        const first = r.results[0];
        if (first && first.error) {
          // The server took the request and refused the operation. That is a
          // decision, not a network problem — retrying will refuse it again.
          return { ok: false as const, retryable: false, error: first.error };
        }
        return { ok: true as const, result: first?.result ?? null };
      } catch (e) {
        const err = e as api.ApiError;
        return { ok: false as const, retryable: err.retryable !== false, error: err.message };
      }
    });
    setPending(await outbox.pendingCount());
    await refresh();
  }, [session, refresh]);

  useEffect(() => {
    void outbox.pendingCount().then(setPending);
  }, []);

  useEffect(() => {
    if (!session) return;
    void refresh();
    void drain();
    const t = setInterval(() => { void refresh(); void drain(); }, 5000);
    return () => clearInterval(t);
  }, [session, refresh, drain]);

  const signIn = async (pin: string) => {
    const s = await api.signIn(outletId, pin);
    setSession(s);
    setView(landingFor(s.rank));
    try { localStorage.setItem(LS_SESSION, JSON.stringify(s)); } catch { /* private mode */ }
  };

  /* §1.4: "Signing out drops the acting role to the lowest, so a permission
     check can never pass on a dead session." Clearing the session outright is
     the same guarantee with nothing left to get wrong. */
  const signOut = () => {
    setSession(null);
    try { localStorage.removeItem(LS_SESSION); } catch { /* ignore */ }
  };

  const groups = useMemo(() => navFor(session?.rank ?? 0), [session]);

  if (!session) return <Lock outletId={outletId} onSignIn={signIn} />;

  const RAIL_W = railOpen ? 208 : 56;

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* ── Rail. §1.1: --bg-0, 208px expanded / 56px collapsed. ─────────── */}
      <nav
        aria-label="Modules"
        style={{
          width: RAIL_W, flexShrink: 0, background: 'var(--bg-0)',
          borderRight: '1px solid var(--line-soft)', display: 'flex',
          flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: railOpen ? '14px 14px 10px' : '14px 8px 10px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <button
            onClick={() => setRailOpen((v) => !v)}
            aria-label={railOpen ? 'Collapse the rail' : 'Expand the rail'}
            style={{
              width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)',
              color: 'var(--text-dim)', display: 'grid', placeItems: 'center', flexShrink: 0,
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {railOpen && (
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '-.01em' }}>
              KashikeyoPOS
            </span>
          )}
        </div>

        <div className="krail" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 8px 10px' }}>
          {groups.map((g) => (
            <div key={g.title} style={{ marginTop: 10 }}>
              {railOpen && (
                <div style={{ padding: '6px 6px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                  {g.title.toUpperCase()}
                </div>
              )}
              {g.items.map((it) => {
                const on = view === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => setView(it.id)}
                    title={railOpen ? undefined : it.label}
                    aria-current={on ? 'page' : undefined}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                      padding: railOpen ? '8px 8px' : '8px 6px', borderRadius: 7,
                      background: on ? 'var(--bg-2)' : 'transparent',
                      color: on ? 'var(--amber-bright)' : 'var(--text-muted)',
                      minHeight: 34, justifyContent: railOpen ? 'flex-start' : 'center',
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d={it.icon} />
                    </svg>
                    {railOpen && (
                      <span style={{ fontSize: 13, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {it.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Identity chip — §1.1 foot. */}
        <div style={{ padding: 10, borderTop: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{
            width: 28, height: 28, borderRadius: 14, background: 'var(--bg-3)',
            color: 'var(--amber-bright)', display: 'grid', placeItems: 'center', flexShrink: 0,
            fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
          }}>
            {session.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
          </span>
          {railOpen && (
            <>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {session.name}
                </span>
                <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>
                  {['', 'Kitchen', 'Till', 'Manager', 'Admin', 'Owner'][session.rank]}
                </span>
              </span>
              <button onClick={signOut} title="Sign out" aria-label="Sign out"
                style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--bg-2)', color: 'var(--text-faint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            </>
          )}
        </div>
      </nav>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Topbar. §1.1: outlet, live clock over a date, and the pending count —
            "a hidden queue is how sales get lost" (§5.1). */}
        <header style={{
          flexShrink: 0, height: 52, borderBottom: '1px solid var(--line-soft)',
          background: 'var(--bg-1)', display: 'flex', alignItems: 'center',
          gap: 14, padding: '0 14px',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {snap?.outlet?.name ?? '—'}
          </span>
          <span style={{ flex: 1 }} />

          {pending > 0 && (
            <span
              title={pending + ' operation(s) waiting to reach the server'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px',
                borderRadius: 999, background: 'var(--warn-dim)', color: 'var(--warn-bright)',
                fontSize: 10.5, fontWeight: 700,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 3, background: 'currentColor', animation: 'kpulse 1.4s infinite' }} />
              {pending} to sync
            </span>
          )}
          {!online && (
            <span style={{ padding: '4px 9px', borderRadius: 999, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 10.5, fontWeight: 700 }}>
              Offline — still selling
            </span>
          )}

          <span style={{ textAlign: 'right' }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 600, letterSpacing: '-.01em', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text)' }}>
              {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>
              {now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
          </span>
        </header>

        <main style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {view === 'pos' && MODULES_BUILT.has('pos') ? (
            <Floor
              snap={snap}
              now={now}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : view === 'menu' && MODULES_BUILT.has('menu') ? (
            <Menu session={session} />
          ) : view === 'kds' && MODULES_BUILT.has('kds') ? (
            <Kds
              snap={snap}
              now={now}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : (
            <NotBuilt id={view} groups={groups} />
          )}
        </main>
      </div>
    </div>
  );
}
