import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api, ApiError, type Snapshot } from './api';
import * as session from './session';
import type { CartLine, SentRound } from './session';
import { C, HIT, MONO } from '../../../packages/tokens/guest';
import { MenuTab } from './MenuTab';
import { TrackTab } from './TrackTab';
import { BillTab } from './BillTab';
import { YouTab } from './YouTab';
import { Toast } from './Toast';

/* ═══ KASHIKEYO — GUEST QR ORDERING ═══════════════════════════════════════
 *
 * Ported from design/KashikeyoGuest QR v3.dc.html. The markup, the inline
 * styles and the SVG path data are transcribed from that file rather than
 * rewritten; docs/01-DESIGN-TOKENS.md is the authority where the two could
 * disagree.
 *
 * ONE DELIBERATE DEPARTURE, and it is in the spec rather than against it. The
 * prototype renders the app inside a desktop phone MOCKUP — a radial-gradient
 * stage, a 392×812 bezel with a notch, a 46px-radius screen. That frame is how
 * a design component presents a phone app on a laptop. A real guest is holding
 * the phone. 03-GUEST-PORTAL-SPEC.md §1 states the production frame instead:
 * "Body #1b0d0a, the phone screen #ffffff inside it. Max width 430px, full
 * height, overflow: hidden with the body scrolling internally." That is what is
 * built here. Every colour, radius, size and weight INSIDE the screen is the
 * prototype's, unchanged.
 *
 * THE RULE THE WHOLE APP OBEYS: a phone never decides money. It shows what the
 * till holds and posts intent. See api.ts.
 */

type Tab = 'menu' | 'track' | 'bill' | 'you';

/* §5: the stage list, in order. The phone does not infer a stage from ticket
   lines it can only half-see — this is the till's own projection, read from
   the fulfilment feed. */
export const STAGES = ['Received', 'In the kitchen', 'Ready', 'Served'] as const;

interface Props { outletId: number; initialTable: string; }

export function App({ outletId, initialTable }: Props) {
  const [table, setTable] = useState(initialTable);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string>('');
  const [offline, setOffline] = useState(!navigator.onLine);
  const [tab, setTab] = useState<Tab>('menu');
  const [toast, setToast] = useState('');

  const restored = useMemo(() => session.load(outletId, initialTable), [outletId, initialTable]);
  const [cart, setCart] = useState<CartLine[]>(restored.cart);
  const [sent, setSent] = useState<SentRound[]>(restored.sent);
  const [ident, setIdent] = useState(restored.ident);
  const [promo, setPromo] = useState(restored.promo);
  const [diets, setDiets] = useState<string[]>(restored.diets);
  const [rated, setRated] = useState(restored.rated);

  /* The guest portal reads the snapshot with a token minted for the OUTLET, not
     for a member of staff — it is a public storefront. In this build the token
     is handed to the page by the QR link; when the guest-token endpoint lands
     it will be fetched here instead, which is why it is behind one ref. */
  const api = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return new Api(outletId, params.get('k') || '');
  }, [outletId]);

  const say = useCallback((m: string) => setToast(m), []);

  /* Poll the till. 03-GUEST-PORTAL-SPEC.md §4: "A recipe change updates the
     guest's filter the same minute", and §5 has the tracker following the
     till's own stages — both need the snapshot to be fresh without the guest
     pulling to refresh. Five seconds is the prototype's own cadence.
     Paused when the tab is hidden: a phone in a pocket polling all through
     dinner is somebody's battery. */
  const tick = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const pull = async () => {
      if (document.hidden) return;
      try {
        const s = await api.snapshot();
        if (!alive) return;
        setSnap(s);
        setLoadError('');
      } catch (e) {
        if (!alive) return;
        // A failed poll is not a broken app: the last snapshot stays on screen
        // and the banner says it is not live. Blanking the menu because one
        // request timed out is how a guest concludes the restaurant is shut.
        const msg = e instanceof ApiError ? e.message : 'Not connected';
        setLoadError(msg);
      }
      tick.current++;
    };

    void pull();
    timer = window.setInterval(pull, 5000);
    const onVis = () => { if (!document.hidden) void pull(); };
    const onOnline = () => { setOffline(false); void pull(); };
    const onOffline = () => setOffline(true);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [api]);

  // Persist on every change to anything the spec says must survive a reload.
  useEffect(() => {
    session.save(outletId, table, { cart, sent, ident, promo, diets, rated });
  }, [outletId, table, cart, sent, ident, promo, diets, rated]);

  const outlet = snap?.outlet ?? null;
  const tableCount = outlet?.tables ?? 0;

  /* ── The frame. Spec §1. ────────────────────────────────────────────────── */
  const stage: React.CSSProperties = {
    minHeight: '100dvh', background: C.appBg, display: 'flex', justifyContent: 'center',
  };
  const screen: React.CSSProperties = {
    width: '100%', maxWidth: 430, minHeight: '100dvh', background: C.surface,
    overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative',
  };

  /* ── Table gate. Spec §2. Shown when no table is chosen. ────────────────── */
  if (!table) {
    return (
      <div style={stage}>
        <div style={screen}>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 22px 30px', animation: 'qfade .2s' }}>
            <div style={{
              width: 52, height: 52, borderRadius: 17, background: C.accentGradient,
              display: 'grid', placeItems: 'center', boxShadow: C.accentShadow,
            }}>
              <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v2M4.5 11h15L15 5.5H9zM6 11v9M18 11v9" />
              </svg>
            </div>
            <div style={{ marginTop: 18, fontSize: 25, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.035em', lineHeight: 1.15 }}>
              {outlet ? 'Welcome to ' + outlet.name : 'Welcome'}
            </div>
            <div style={{ marginTop: 9, fontSize: 14, color: C.inkMuted, lineHeight: 1.6, textWrap: 'pretty' }}>
              {loadError && !snap
                ? 'We cannot reach the restaurant just now. Please ask a member of our team.'
                : 'Order from your table, follow it to the kitchen, and settle when you are ready.'}
            </div>

            <div style={{ marginTop: 24, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>YOUR TABLE</div>
            <div style={{ marginTop: 11, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(62px,1fr))', gap: 9 }}>
              {Array.from({ length: tableCount }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  onClick={() => { setTable(String(n)); say('Table ' + n + ' — here is the menu'); }}
                  style={{
                    padding: '13px 6px', borderRadius: 14, background: C.surface,
                    border: '1px solid ' + C.hairline, fontSize: 13.5, fontWeight: 700,
                    color: C.ink, textAlign: 'center', minHeight: HIT.tableTile, fontFamily: MONO,
                  }}
                >
                  {'T' + (n < 10 ? '0' + n : n)}
                </button>
              ))}
            </div>
            {/* An outlet whose table count is not configured yet has no grid to
                draw. Say what is missing rather than render nothing: an empty
                state is a first-class state (10-NO-DEMO-DATA.md §4). */}
            {!tableCount && (
              <div style={{ marginTop: 14, fontSize: 13.5, color: C.inkGhost, lineHeight: 1.6 }}>
                {snap
                  ? 'This restaurant has not set its tables up yet. Please ask a member of our team to take your order.'
                  : 'Loading the menu…'}
              </div>
            )}
            <div style={{ marginTop: 18, fontSize: 12, color: C.inkGhost, lineHeight: 1.6, textWrap: 'pretty' }}>
              Your table number is printed on the card in front of you.
            </div>
          </div>
          <Toast message={toast} onDone={() => setToast('')} />
        </div>
      </div>
    );
  }

  /* ── The four tabs. Spec §1: "Menu · Track · Bill · You". ───────────────── */
  const TABS: { k: Tab; label: string; icon: string; dot: boolean }[] = [
    { k: 'menu', label: 'Menu', icon: 'M4 6h16M4 12h16M4 18h10', dot: false },
    { k: 'track', label: 'Order', icon: 'M6 2h9l5 5v15H6zM9 12h7M9 16h5', dot: sent.length > 0 },
    { k: 'bill', label: 'Bill', icon: 'M3 7h18v11H3zM3 11h18M7 15h4', dot: false },
    { k: 'you', label: 'You', icon: 'M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z', dot: !rated && sent.length > 0 },
  ];

  const cartCount = cart.reduce((a, l) => a + l.qty, 0);

  return (
    <div style={stage}>
      <div style={screen}>
        {/* Not-live banner. The spec has no design for this because the
            prototype had no network to lose; it is built from the existing
            warning tokens (§2) rather than a new colour, and it never hides
            the menu — a guest can still read it and call somebody over. */}
        {(offline || loadError) && (
          <div style={{
            flexShrink: 0, padding: '9px 20px', background: C.warnBg,
            borderBottom: '1px solid ' + C.warnBorder, color: C.warnInk,
            fontSize: 12.5, fontWeight: 600, lineHeight: 1.45,
          }}>
            {offline ? 'You are offline — prices and your bill may be out of date.'
              : 'Not connected to the restaurant just now — showing the last menu we had.'}
          </div>
        )}

        {tab === 'menu' && (
          <MenuTab
            snap={snap} table={table} ident={ident} diets={diets} setDiets={setDiets}
            cart={cart} setCart={setCart} say={say} onYou={() => setTab('you')}
            onReview={() => setTab('track')}
          />
        )}
        {tab === 'track' && (
          <TrackTab
            snap={snap} table={table} cart={cart} setCart={setCart} sent={sent} setSent={setSent}
            promo={promo} setPromo={setPromo} api={api} ident={ident} say={say}
            onBrowse={() => setTab('menu')}
          />
        )}
        {tab === 'bill' && (
          <BillTab snap={snap} table={table} api={api} say={say} onBrowse={() => setTab('menu')} />
        )}
        {tab === 'you' && (
          <YouTab
            snap={snap} table={table} api={api} ident={ident} setIdent={setIdent}
            rated={rated} setRated={setRated} say={say}
          />
        )}

        {/* Cart bar. Spec §4: rises above the tab bar when the cart is
            non-empty. 16px radius, accent fill, count badge, total in
            800-weight monospace. */}
        {tab === 'menu' && cartCount > 0 && (
          <button
            onClick={() => setTab('track')}
            style={{
              position: 'absolute', left: 16, right: 16, bottom: 82, zIndex: 40,
              display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px',
              borderRadius: 16, background: C.accent, color: '#fff',
              boxShadow: C.accentShadow, animation: 'qriseb .18s', minHeight: HIT.row,
            }}
          >
            <span style={{
              minWidth: 24, height: 24, padding: '0 7px', borderRadius: 12,
              background: 'rgba(255,255,255,.22)', display: 'grid', placeItems: 'center',
              fontSize: 12.5, fontWeight: 700, fontFamily: MONO,
            }}>{cartCount}</span>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>Review this round</span>
            <span style={{ fontSize: 14, fontWeight: 800, fontFamily: MONO, letterSpacing: '-.02em' }}>
              {(cart.reduce((a, l) => a + l.unitPrice * l.qty, 0) / 100)
                .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </button>
        )}

        {/* Bottom tab bar, thumb reach. */}
        <div style={{
          flexShrink: 0, display: 'flex', gap: 4, padding: '6px 12px calc(8px + env(safe-area-inset-bottom))',
          borderTop: '1px solid ' + C.hairlineSoft, background: C.surface,
        }}>
          {TABS.map((x) => (
            <button
              key={x.k}
              onClick={() => setTab(x.k)}
              aria-current={tab === x.k ? 'page' : undefined}
              style={{
                position: 'relative', flex: 1, minWidth: 0, display: 'flex',
                flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 3, padding: '7px 4px', borderRadius: 13, minHeight: 52,
                color: tab === x.k ? C.accent : C.label,
              }}
            >
              <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d={x.icon} />
              </svg>
              <span style={{ fontSize: 10.5, fontWeight: 600 }}>{x.label}</span>
              {x.dot && (
                <span style={{
                  position: 'absolute', top: 6, right: '50%', marginRight: -14,
                  width: 6, height: 6, borderRadius: 3, background: C.accent, display: 'block',
                }} />
              )}
            </button>
          ))}
        </div>

        <Toast message={toast} onDone={() => setToast('')} />
      </div>
    </div>
  );
}
