import { useCallback, useEffect, useState } from 'react';
import { ApiError, authed, requestCode, signIn } from './api';
import type { Bill, Card, Catalogue, Visits } from './api';
import { C, HIT, MONO } from '../../../packages/tokens/guest';
import { SignIn } from './SignIn';
import { HomeTab } from './HomeTab';
import { BillTab } from './BillTab';
import { VisitsTab } from './VisitsTab';
import { RewardsTab } from './RewardsTab';

/* ═══ THE MEMBER PORTAL ══════════════════════════════════════════════════════
 *
 * 04-MEMBER-PORTAL-SPEC.md. "The same visual language as the guest portal.
 * Where the QR portal is anonymous and table-bound, this is identified and
 * chain-wide: one member, many outlets."
 *
 * Four screens, in the order the spec lists them: the card, the bill, the
 * visits, the rewards. There is no fifth, and there is deliberately no way to
 * create an account: §1 is explicit that a member exists the first time a
 * cashier attaches a phone number to a sale.
 *
 * WHAT THIS APP CANNOT DO is the part worth stating. It cannot pay. It cannot
 * apply a discount. It cannot move a single point on its own. Redeeming mints
 * a voucher for a cashier to accept, and offering points writes an offer onto
 * the ticket — the copy on both says so in the words a guest would use, because
 * a phone that quietly appeared to settle a bill and then did not is worse than
 * one that never offered.
 */

const LS = 'kashikeyo.member.v1';

type Tab = 'home' | 'bill' | 'visits' | 'rewards';

interface Stored { token: string; expiresAt: number }

export function App() {
  const [session, setSession] = useState<Stored | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [card, setCard] = useState<Card | null>(null);
  const [visits, setVisits] = useState<Visits | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  /* A session survives a locked phone, and is dropped the moment it is stale
     rather than left to fail its next request: a card that shows yesterday's
     points is worse than one that asks you to sign in. */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS);
      if (!raw) return;
      const s = JSON.parse(raw) as Stored;
      if (s && s.token && s.expiresAt > Date.now()) setSession(s);
      else localStorage.removeItem(LS);
    } catch { /* private browsing */ }
  }, []);

  const api = session ? authed(session.token) : null;

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const [c, v, r, b] = await Promise.all([
        api.me(), api.visits(), api.rewards(),
        api.bill().catch(() => null),
      ]);
      setCard(c); setVisits(v); setCatalogue(r);
      setBill(b && (b as Bill).ticketId ? (b as Bill) : null);
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return signOut();
      setError(e instanceof ApiError ? e.message : 'We could not reach your card.');
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);
  /* The bill moves while somebody is looking at it — a server adds a round, the
     till takes a payment. Everything else on this screen changes at the pace of
     a visit, so only this one polls. */
  useEffect(() => {
    if (!api || tab !== 'bill') return;
    const t = setInterval(() => {
      void api.bill().then((b) => setBill(b && b.ticketId ? b : null)).catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [session, tab]);

  const signOut = () => {
    setSession(null); setCard(null); setVisits(null); setCatalogue(null); setBill(null);
    try { localStorage.removeItem(LS); } catch { /* ignore */ }
  };

  const say = (m: string) => { setNote(m); setTimeout(() => setNote(''), 9000); };

  if (!session) {
    return (
      <SignIn
        onRequest={requestCode}
        onSignIn={async (phone, code) => {
          const s = await signIn(phone, code);
          const stored = { token: s.token, expiresAt: s.expiresAt };
          setSession(stored);
          setCard(s.member);
          try { localStorage.setItem(LS, JSON.stringify(stored)); } catch { /* ignore */ }
        }}
      />
    );
  }

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', flexDirection: 'column',
      background: C.surface, color: C.ink,
      fontFamily: "'Instrument Sans',system-ui,sans-serif",
    }}>
      {(error || note) && (
        <div style={{
          flexShrink: 0, padding: '10px 18px', fontSize: 13, lineHeight: 1.5,
          background: error ? C.warnBg : '#f0fbf2',
          color: error ? C.warnInk : '#1f7a37',
          borderBottom: '1px solid ' + (error ? C.warnBorder : '#d6efdc'),
        }}>{error || note}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tab === 'home' && <HomeTab card={card} onSignOut={signOut} />}
        {tab === 'bill' && (
          <BillTab
            bill={bill} card={card}
            onOffer={async (points) => {
              if (!api || !bill) return;
              try {
                const r = await api.offerPoints(bill.outlet.id, bill.ticketId, points);
                say(r.message);
                await load();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : 'That did not go through.');
              }
            }}
          />
        )}
        {tab === 'visits' && <VisitsTab visits={visits} />}
        {tab === 'rewards' && (
          <RewardsTab
            catalogue={catalogue}
            onRedeem={async (id) => {
              if (!api) return;
              try {
                const r = await api.redeem(id);
                say(r.message);
                await load();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : 'That did not go through.');
              }
            }}
          />
        )}
      </div>

      {/* §4.3 hit targets, and the tab bar the guest portal uses — same visual
          language, different four tabs. */}
      <nav style={{
        flexShrink: 0, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)',
        borderTop: '1px solid ' + C.hairline, background: C.surface,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {([
          ['home', 'Card'], ['bill', 'Bill'], ['visits', 'Visits'], ['rewards', 'Rewards'],
        ] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            style={{
              minHeight: HIT.row + 8, padding: '9px 4px 11px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              fontSize: 11.5, fontWeight: tab === id ? 700 : 500,
              color: tab === id ? C.accent : C.inkMuted, background: 'transparent',
            }}>
            <span style={{ fontSize: 13.5 }}>{label}</span>
            {id === 'bill' && bill && (
              /* A dot rather than a number: the point is that there IS an open
                 bill, and its total is not this portal's to quote. */
              <span style={{ width: 5, height: 5, borderRadius: 3, background: C.accent }} />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

export const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const MONO_FONT = MONO;
