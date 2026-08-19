import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import * as api from './api';
import type { Session, Snapshot } from './api';
import * as outbox from './outbox';
import { navFor, landingFor, FILTERABLE } from './nav';
import { Lock } from './Lock';
import { Floor } from './Floor';
import { Kds } from './Kds';
import { Menu } from './Menu';
import { Recipes } from './Recipes';
import { Inventory } from './Inventory';
import { Orders } from './Orders';
import { Reports } from './Reports';
import { Today } from './Today';
import { Counts } from './Counts';
import { Ledger } from './Ledger';
import { Purchases } from './Purchases';
import { Vendors } from './Vendors';
import { Staff } from './Staff';
import { Payroll } from './Payroll';
import { Analytics } from './Analytics';
import { OpCosts } from './OpCosts';
import { Assets } from './Assets';
import { Customers } from './Customers';
import { Loyalty } from './Loyalty';
import { Promos } from './Promos';
import { Reservations } from './Reservations';
import { Delivery } from './Delivery';
import { Accounting } from './Accounting';
import { Owner } from './Owner';
import { Chain } from './Chain';
import { Sync } from './Sync';
import { Settings } from './Settings';
import { Users } from './Users';
import { Logs } from './Logs';
import { Branches } from './Branches';
import { Architecture } from './Architecture';
import { Start } from './Start';
import { Production } from './Production';
import { Batches } from './Batches';
import { Dispatches } from './Dispatches';
import { Requests } from './Requests';
import { AiMenu } from './AiMenu';
import { NotBuilt } from './NotBuilt';
import { useBreakpoint } from './useBreakpoint';
import { Palette } from './Palette';
import type { Intent } from './intent';

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

const MODULES_BUILT = new Set(['pos', 'kds', 'menu', 'recipes', 'inventory', 'orders', 'reports', 'today', 'counts', 'ledger', 'purchases', 'vendors', 'staff', 'payroll', 'analytics', 'costs', 'assets', 'customers', 'loyalty', 'promos', 'reservations', 'delivery', 'accounting', 'owner', 'chain', 'sync', 'settings', 'users', 'logs', 'branches', 'architecture', 'start', 'production', 'batches', 'dispatches', 'requests', 'aimenu']);

const LS_SESSION = 'kashikeyo.pos.session.v1';

export function App({ outletId }: { outletId: number }) {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState('pos');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [now, setNow] = useState(() => new Date());
  const [railOpen, setRailOpen] = useState(true);
  /* The prototype computes this in JS because the breakpoint changes what the
     shell IS, not just how wide it is — on a phone the rail stops being a
     column and becomes an overlay. See useBreakpoint.ts. */
  const bp = useBreakpoint();
  const isPhone = bp === 'm';
  const isRail = bp === 't';
  const [drawer, setDrawer] = useState(false);
  /* "Go anywhere" — thirty-seven modules is past what a rail makes
     findable, so the prototype puts a ⌘K palette over it. */
  const [pal, setPal] = useState(false);
  const [palRecent, setPalRecent] = useState<string[]>([]);
  /* The one-shot that carries a palette "Do" row across the navigation to
     the module that finishes the job. See intent.ts. */
  const [intent, setIntent] = useState<Intent | null>(null);
  /* "/" filters what is already on screen — the other half of the prototype's
     two-key convention, where ⌘K goes somewhere and / narrows where you are.
     The value is the SHELL's rather than each screen's because the box is in
     the top bar, and it is cleared on every navigation: a filter carried onto
     the next screen would hide most of it for no reason the operator can see. */
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

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
    } catch (e) {
      /* A 401 is not "offline". Since migration 031 a session can genuinely be
         ENDED — a manager revoking this device kills it mid-shift, which is the
         entire point of a kill switch — and a till that keeps polling a dead
         token shows a stale floor plan and a topbar claiming a network problem.
         Drop to the PIN pad, which is the honest state.

         Only on 401. Every other failure leaves the cache standing, because
         being offline is the normal condition of a till and not an error. */
      if ((e as api.ApiError)?.status === 401) {
        setSession(null);
        try { localStorage.removeItem(LS_SESSION); } catch { /* private mode */ }
      }
      /* else: the cache stands; the topbar already says we are offline */
    }
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
    /* Sent only if this machine has been paired. An unpaired one sends
       nothing and the server binds nothing — see api.thisDevice(). */
    const s = await api.signIn(outletId, pin, api.thisDevice() ?? undefined);
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

  /* The prototype's resize handler closes the drawer on every breakpoint
     change. Without it, rotating a phone to landscape leaves a fixed overlay
     pinned over a layout that now has a real rail. */
  useEffect(() => { setDrawer(false); }, [bp]);

  /* A filter belongs to the screen that was filtered. */
  useEffect(() => { setSearch(''); setSearchOpen(false); }, [view]);

  /* ⌘K anywhere. The prototype binds it on the document so it works whatever
     has focus, and preventDefault stops the browser's own find bar. */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPal(true);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      /* Out of the way the moment somebody is typing into a field — otherwise
         a slash in a dish name opens a search box instead of being typed. */
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || t?.isContentEditable) return;
      if (e.key !== '/') return;
      /* The prototype's rule: "/" lands on whichever search is actually on
         screen. A screen that draws its own filter field owns the key; the top
         bar's box is the fallback, and on a screen with neither the key does
         nothing rather than opening a box that filters nothing. */
      const own = document.querySelector<HTMLInputElement>('main [data-screen-search]');
      if (own && own.offsetParent !== null) {
        e.preventDefault(); own.focus(); own.select(); return;
      }
      if (!FILTERABLE.has(viewRef.current)) return;
      e.preventDefault();
      setSearchOpen(true);
      setTimeout(() => { const n = searchBox.current; if (n) { n.focus(); n.select(); } }, 30);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  /* The keydown listener is bound once, so it reads the live view through a ref
     rather than closing over the value it was bound with. */
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  /* Above the lock's early return, with every other hook: a useCallback below
     it runs on the signed-in render and not on the locked one, which is one
     hook more on one render than the other and takes React down. */
  const intentDone = useCallback(() => setIntent(null), []);

  const groups = useMemo(() => navFor(session?.rank ?? 0), [session]);

  if (!session) return <Lock outletId={outletId} onSignIn={signIn} />;

  /* Labels show on a phone too — the drawer is a full 280px there, so the rail
     being "collapsed" is a desktop and tablet idea only. On the tablet rail the
     column is 60px and labels cannot fit at all, which is the prototype's
     behaviour and not a preference the operator gets to override. */
  /* The sell screens are full-bleed: they manage their own height and their
     own scrolling, and the prototype gives them every pixel. */
  const fullBleed = view === 'pos' || view === 'kds';
  const labelled = isPhone ? true : isRail ? false : railOpen;
  const RAIL_W = isRail ? 60 : railOpen ? 208 : 56;

  /* The palette navigates and remembers; the four most recent are what an
     empty query offers, because the places somebody went yesterday are the
     places they are going today. */
  const palGo = (id: string, key: string, next?: Intent) => {
    setPalRecent((r) => [key].concat(r.filter((k) => k !== key)).slice(0, 4));
    setPal(false);
    setDrawer(false);
    setView(id);
    setIntent(next ?? null);
  };
  /* Every module clears the intent the moment it has acted on it. */
  /* Only the addressed module sees one, so a stale intent cannot fire on a
     screen it was never meant for. */
  const intentFor = (id: string) => (intent && intent.view === id ? intent : null);

  return (
    <div style={{
      /* Phone: a column, with the rail lifted out of the layout entirely.
         Tablet and desktop: rail beside main. The prototype's shellStyle. */
      display: 'flex',
      flexDirection: isPhone ? 'column' : 'row',
      height: '100dvh', overflow: 'hidden', background: 'var(--bg)',
    }}>
      <Palette
        rank={session.rank} open={pal} recent={palRecent}
        onClose={() => setPal(false)} onGo={palGo}
      />

      {/* ── The scrim. Only a phone has one, because only a phone has an
             overlay to dismiss. Tapping it closes the drawer, which is the
             gesture everybody tries first. ──────────────────────────────── */}
      {isPhone && drawer && (
        <div
          onClick={() => setDrawer(false)}
          aria-hidden="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'var(--scrim, rgba(0,0,0,.55))',
            backdropFilter: 'blur(3px)', animation: 'kfade .14s',
          }}
        />
      )}

      {/* ── Rail. §1.1: --bg-0, 208px expanded / 56px collapsed. On a phone it
             is not a column at all — it is a fixed drawer over the content,
             and when closed it is not rendered, so it costs no width. ───── */}
      <nav
        aria-label="Modules"
        aria-hidden={isPhone && !drawer ? true : undefined}
        style={isPhone
          ? {
            position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 70,
            width: 'min(280px, 84vw)',
            display: drawer ? 'flex' : 'none',
            flexDirection: 'column', overflow: 'hidden',
            background: 'var(--bg-0)', borderRight: '1px solid var(--line-soft)',
            boxShadow: '0 0 60px rgba(0,0,0,.6)', animation: 'kslide .2s',
          }
          : {
            width: RAIL_W, flexShrink: 0, background: 'var(--bg-0)',
            borderRight: '1px solid var(--line-soft)', display: 'flex',
            flexDirection: 'column', overflow: 'hidden',
          }}
      >
        <div style={{ padding: labelled ? '14px 14px 10px' : '14px 8px 10px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <button
            onClick={() => (isPhone ? setDrawer(false) : setRailOpen((v) => !v))}
            /* On the tablet rail the column is 60px and a label cannot fit, so
               there is nothing for this to toggle — it closes the drawer on a
               phone and collapses the rail on a desktop. */
            aria-label={isPhone ? 'Close the menu' : railOpen ? 'Collapse the rail' : 'Expand the rail'}
            style={{
              width: isPhone ? 34 : 28, height: isPhone ? 34 : 28,
              borderRadius: 7, background: 'var(--bg-2)',
              color: 'var(--text-dim)', placeItems: 'center', flexShrink: 0,
              display: isRail ? 'none' : 'grid',
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {labelled && (
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '-.01em' }}>
              KashikeyoPOS
            </span>
          )}
        </div>

        <div className="krail" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 8px 10px' }}>
          {groups.map((g) => (
            <div key={g.title} style={{ marginTop: 10 }}>
              {labelled && (
                <div style={{ padding: '6px 6px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                  {g.title.toUpperCase()}
                </div>
              )}
              {g.items.map((it) => {
                const on = view === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => { setView(it.id); setDrawer(false); }}
                    title={labelled ? undefined : it.label}
                    aria-current={on ? 'page' : undefined}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                      padding: labelled ? '8px 8px' : '8px 6px', borderRadius: 7,
                      background: on ? 'var(--bg-2)' : 'transparent',
                      color: on ? 'var(--amber-bright)' : 'var(--text-muted)',
                      /* 44px on a phone: a finger is not a mouse pointer, and
                         these sit in a list where a mis-tap opens the wrong
                         module mid-service. */
                      minHeight: isPhone ? 44 : 34,
                      justifyContent: labelled ? 'flex-start' : 'center',
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d={it.icon} />
                    </svg>
                    {labelled && (
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
          {labelled && (
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
      {/* `minHeight: 0` is load-bearing. A flex item defaults to
          `min-height:auto`, which refuses to shrink below its content — so this
          column grew to the full height of whatever screen was inside it, main
          grew with it, and main could never become a scroll container no matter
          what its own overflow said. The shell's `overflow:hidden` then clipped
          the excess and there was no gesture that could reach it. */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Topbar. §1.1: outlet, live clock over a date, and the pending count —
            "a hidden queue is how sales get lost" (§5.1). */}
        <header style={{
          flexShrink: 0, minHeight: isPhone ? 56 : 52,
          borderBottom: '1px solid var(--line-soft)',
          background: 'var(--bg-1)', display: 'flex', alignItems: 'center',
          gap: isPhone ? 10 : 14, padding: isPhone ? '8px 12px' : '0 14px',
          /* Never wrap on a phone: a header that grows to two lines eats the
             screen the ticket needs. Things drop out instead — see below. */
          flexWrap: 'nowrap',
        }}>
          {/* The only way to the modules on a phone. It lives in the header
              rather than the rail because on a phone the rail is not on
              screen to be tapped. */}
          {isPhone && (
            <button
              onClick={() => setDrawer(true)}
              aria-label="Open the menu"
              aria-expanded={drawer}
              style={{
                width: 40, height: 40, flexShrink: 0, borderRadius: 9,
                background: 'var(--bg-2)', color: 'var(--text-dim)',
                display: 'grid', placeItems: 'center',
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <span style={{
            fontSize: isPhone ? 15 : 13, fontWeight: isPhone ? 700 : 600,
            color: 'var(--text)', letterSpacing: isPhone ? '-.025em' : undefined,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            minWidth: 0,
          }}>
            {snap?.outlet?.name ?? '—'}
          </span>
          <span style={{ flex: 1 }} />

          {/* On a phone this is the icon alone — the label and the ⌘K hint are
              the first things the prototype drops, because a phone has no ⌘
              and the header has no room for a word. */}
          <button
            type="button" onClick={() => setPal(true)}
            title="Go anywhere, or say what you want to do — ⌘K"
            aria-label="Go anywhere"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
              minHeight: isPhone ? 38 : 34, padding: isPhone ? '0 10px' : '0 11px',
              borderRadius: 999, background: 'var(--bg-2)', border: '1px solid var(--line)',
              color: 'var(--text-dim)', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M4 6h16M4 12h10M4 18h13M18 15l3 3-3 3" />
            </svg>
            {!isPhone && <span style={{ whiteSpace: 'nowrap' }}>Go anywhere</span>}
            {!isPhone && !isRail && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
                color: 'var(--text-faint)', border: '1px solid var(--line)', borderRadius: 4, padding: '2px 5px',
              }}>⌘K</span>
            )}
          </button>

          {/* The filter. Hidden on a phone, exactly as the prototype hides it —
              there is no room beside the outlet name, and no keyboard to press
              "/" on. It collapses to a 32px disc when empty and grows on focus,
              so a screen that can be filtered says so without spending the
              width all the time. */}
          {!isPhone && FILTERABLE.has(view) && (
            <div
              onClick={() => {
                if (searchOpen) return;
                setSearchOpen(true);
                setTimeout(() => searchBox.current?.focus(), 30);
              }}
              title="Filter this screen — press /"
              style={{
                display: 'flex', alignItems: 'center', gap: searchOpen ? 8 : 0,
                background: 'var(--bg-2)',
                border: '1px solid ' + (searchOpen ? 'var(--warn-line)' : 'var(--line)'),
                borderRadius: 8, padding: searchOpen ? '7px 10px' : 0, flexShrink: 0,
                color: 'var(--text-dim)',
                width: searchOpen ? 'clamp(112px,14vw,180px)' : 32,
                height: searchOpen ? undefined : 32,
                justifyContent: searchOpen ? undefined : 'center',
                transition: 'width .14s ease', cursor: 'text', overflow: 'hidden',
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                ref={searchBox} value={search} placeholder="Search…" aria-label="Filter this screen"
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => { if (!search) setSearchOpen(false); }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearch(''); setSearchOpen(false);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                style={{
                  background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)',
                  fontSize: 12, minWidth: 0, fontFamily: 'inherit',
                  ...(searchOpen ? { flex: 1, width: 'auto' } : { width: 0, flex: '0 0 0', padding: 0 }),
                }}
              />
            </div>
          )}

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
              {pending}{isPhone ? '' : ' to sync'}
            </span>
          )}
          {!online && (
            <span style={{ padding: '4px 9px', borderRadius: 999, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 10.5, fontWeight: 700 }}>
              {isPhone ? 'Offline' : 'Offline — still selling'}
            </span>
          )}

          <span style={{ textAlign: 'right' }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 600, letterSpacing: '-.01em', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text)' }}>
              {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {/* The date goes first on a phone. The time is an operational
                fact during a shift; the date is not, and the header has no
                room to wrap. */}
            {!isPhone && (
              <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>
                {now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
            )}
          </span>
        </header>

        {/* One module's bug must not take the terminal down. Without this a
            crash anywhere below unmounted the whole app — rail, header and the
            open ticket with it — mid-service, and the only way back was a
            reload and a PIN. The boundary is keyed on the view so moving to
            another screen clears it. */}
        {/* THE PAGE SCROLLS HERE, and nowhere else.
            This was `overflow:hidden` with no scroll container under it, which
            on a desktop looked fine because the content happened to fit. On a
            phone it never fits: the Owner Dashboard is ~2600px tall in an 844px
            viewport, so about 1,800px of it was clipped and could not be
            reached by any gesture — the document itself did not scroll either,
            because the shell is `height:100dvh;overflow:hidden`.

            THE TILL AND THE PASS ARE THE EXCEPTION. Floor and Kds are
            `height:100%` and do their own scrolling inside their own columns;
            they want every pixel and no gutter, which is the prototype's rule
            for the sell screens. Giving them a scrolling, padded parent would
            put a second scrollbar around a screen that already had one. */}
        <main style={{
          flex: 1, minHeight: 0,
          overflowY: fullBleed ? 'hidden' : 'auto',
          /* Never sideways: a horizontal scrollbar on the page is always a
             layout fault, and the tables that legitimately scroll do it inside
             their own container. */
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          /* The gutter. Content used to sit flush against both bezels — every
             card's border touched the edge of the glass. The bottom inset keeps
             the last row clear of the home indicator on a notched phone, which
             `viewport-fit=cover` in index.html otherwise lets it slide under. */
          padding: fullBleed
            ? 0
            : isPhone
              ? '12px 12px calc(12px + env(safe-area-inset-bottom))'
              : '14px 16px',
        }}>
          {/* A filter that has hidden rows must say so. Every screen already has
              its own empty state, and each of them explains an empty DATABASE —
              "no dishes yet", "nothing has been received". Left alone, a filter
              that matches nothing shows one of those, and the operator reads it
              as data loss rather than as a filter. One strip, above every
              screen, is the honest answer and it is the same answer everywhere. */}
          {search.trim() !== '' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              marginBottom: 10, padding: '7px 11px', borderRadius: 8,
              background: 'var(--warn-dim)', border: '1px solid var(--warn-line)',
            }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--warn-bright)' }}>
                Showing only what matches “{search.trim()}”.
              </span>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => { setSearch(''); setSearchOpen(false); }}
                style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-dim)' }}>
                Clear the filter
              </button>
            </div>
          )}

          <Boundary key={view} view={view}>
          {view === 'owner' && MODULES_BUILT.has('owner') ? (
            <Owner session={session} onGo={setView} />
          ) : view === 'chain' && MODULES_BUILT.has('chain') ? (
            <Chain session={session} onGo={setView} />
          ) : view === 'sync' && MODULES_BUILT.has('sync') ? (
            <Sync session={session} onPaired={signOut} />
          ) : view === 'settings' && MODULES_BUILT.has('settings') ? (
            <Settings session={session} />
          ) : view === 'users' && MODULES_BUILT.has('users') ? (
            <Users session={session} onGo={setView} search={search} />
          ) : view === 'logs' && MODULES_BUILT.has('logs') ? (
            <Logs session={session} search={search} />
          ) : view === 'branches' && MODULES_BUILT.has('branches') ? (
            <Branches session={session} onGo={setView} />
          ) : view === 'architecture' && MODULES_BUILT.has('architecture') ? (
            <Architecture session={session} />
          ) : view === 'start' && MODULES_BUILT.has('start') ? (
            <Start session={session} onGo={setView} />
          ) : view === 'production' && MODULES_BUILT.has('production') ? (
            <Production session={session} search={search} />
          ) : view === 'batches' && MODULES_BUILT.has('batches') ? (
            <Batches session={session} search={search} />
          ) : view === 'dispatches' && MODULES_BUILT.has('dispatches') ? (
            <Dispatches session={session} intent={intentFor('dispatches')} onIntentDone={intentDone} search={search} />
          ) : view === 'requests' && MODULES_BUILT.has('requests') ? (
            <Requests session={session} intent={intentFor('requests')} onIntentDone={intentDone} search={search} />
          ) : view === 'aimenu' && MODULES_BUILT.has('aimenu') ? (
            <AiMenu session={session} />
          ) : view === 'pos' && MODULES_BUILT.has('pos') ? (
            <Floor
              snap={snap}
              now={now}
              session={session}
              online={online}
              intent={intentFor('pos')} onIntentDone={intentDone}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : view === 'purchases' && MODULES_BUILT.has('purchases') ? (
            <Purchases
              session={session} search={search}
              intent={intentFor('purchases')} onIntentDone={intentDone}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : view === 'analytics' && MODULES_BUILT.has('analytics') ? (
            <Analytics session={session} />
          ) : view === 'costs' && MODULES_BUILT.has('costs') ? (
            <OpCosts session={session} />
          ) : view === 'assets' && MODULES_BUILT.has('assets') ? (
            <Assets session={session} search={search} />
          ) : view === 'customers' && MODULES_BUILT.has('customers') ? (
            <Customers session={session} />
          ) : view === 'loyalty' && MODULES_BUILT.has('loyalty') ? (
            <Loyalty session={session} search={search} />
          ) : view === 'promos' && MODULES_BUILT.has('promos') ? (
            <Promos session={session} search={search} />
          ) : view === 'reservations' && MODULES_BUILT.has('reservations') ? (
            <Reservations session={session} search={search} />
          ) : view === 'delivery' && MODULES_BUILT.has('delivery') ? (
            <Delivery session={session} />
          ) : view === 'accounting' && MODULES_BUILT.has('accounting') ? (
            <Accounting session={session} />
          ) : view === 'payroll' && MODULES_BUILT.has('payroll') ? (
            <Payroll session={session} />
          ) : view === 'staff' && MODULES_BUILT.has('staff') ? (
            <Staff
              session={session} search={search}
              intent={intentFor('staff')} onIntentDone={intentDone}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : view === 'vendors' && MODULES_BUILT.has('vendors') ? (
            <Vendors session={session} intent={intentFor('vendors')} onIntentDone={intentDone} search={search} />
          ) : view === 'counts' && MODULES_BUILT.has('counts') ? (
            <Counts
              session={session} search={search}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : view === 'ledger' && MODULES_BUILT.has('ledger') ? (
            <Ledger session={session} search={search} />
          ) : view === 'today' && MODULES_BUILT.has('today') ? (
            <Today session={session} onGo={setView} />
          ) : view === 'reports' && MODULES_BUILT.has('reports') ? (
            <Reports session={session} intent={intentFor('reports')} onIntentDone={intentDone} />
          ) : view === 'orders' && MODULES_BUILT.has('orders') ? (
            <Orders
              session={session} search={search}
              /* Straight to the till with that bill open. Through the same
                 one-shot the palette uses — see intent.ts. */
              onSettle={(t, sp) => {
                setView('pos');
                setIntent({ view: 'pos', act: 'open:' + (t ?? '') + ':' + sp });
              }}
            />
          ) : view === 'menu' && MODULES_BUILT.has('menu') ? (
            <Menu session={session} />
          ) : view === 'inventory' && MODULES_BUILT.has('inventory') ? (
            <Inventory
              session={session} search={search}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : view === 'recipes' && MODULES_BUILT.has('recipes') ? (
            <Recipes session={session} intent={intentFor('recipes')} onIntentDone={intentDone} search={search} />
          ) : view === 'kds' && MODULES_BUILT.has('kds') ? (
            <Kds
              snap={snap}
              now={now}
              onQueued={async () => { setPending(await outbox.pendingCount()); void drain(); }}
            />
          ) : (
            <NotBuilt id={view} groups={groups} />
          )}
          </Boundary>
        </main>
      </div>
    </div>
  );
}

/* ── the boundary ─────────────────────────────────────────────────────────
 *
 * A class, because that is the only thing React lets catch a render error. It
 * says which screen failed and what it said — a till that goes blank tells the
 * operator nothing they can pass on, and "it broke" is not a bug report.
 */
class Boundary extends Component<{ view: string; children: ReactNode }, { err: Error | null }> {
  constructor(props: { view: string; children: ReactNode }) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err: Error) { return { err }; }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Logged rather than swallowed: this is the only trace of it once the
    // fallback has replaced the screen.
    console.error('screen "' + this.props.view + '" failed', err, info.componentStack);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
            This screen stopped working
          </div>
          <div style={{ margin: '9px 0 0', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
            The rest of the terminal is still running — the floor, the ticket you had open
            and anything queued to send are all untouched. Move to another screen, or try
            this one again.
          </div>
          <div style={{ margin: '11px 0 0', padding: '8px 11px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-faint)', wordBreak: 'break-word' }}>
            {this.props.view}: {this.state.err.message}
          </div>
          <button onClick={() => this.setState({ err: null })}
            style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
            Try this screen again
          </button>
        </div>
      </div>
    );
  }
}
