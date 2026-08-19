import type { Card } from './api';
import { C, MONO } from '../../../packages/tokens/guest';

/* §2 Home — the member card.
 *
 * The design token doc gives this one its gradient literally
 * (`linear-gradient(150deg,#f4553c,#c2321c)`), the name at 22px/700 white and
 * the masked number in monospace at 80% white. Those are not suggestions: the
 * card is the thing somebody holds their phone up to show a cashier, and it has
 * to be recognisable across a counter.
 *
 * THE TIER AND THE DISTANCE TO IT COME FROM CONFIGURATION. §2 says "never a
 * hardcoded threshold", and this screen holds none: it prints what the API
 * says, and a chain with no tiers gets a card with no ladder rather than an
 * invented one.
 */

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function HomeTab({ card, onSignOut }: { card: Card | null; onSignOut: () => void }) {
  if (!card) {
    return <div style={{ padding: 24, fontSize: 14, color: C.inkMuted }}>Opening your card…</div>;
  }
  return (
    <div style={{ padding: '20px 18px 28px' }}>
      <div style={{
        padding: 20, borderRadius: 22, background: C.accentGradient,
        boxShadow: C.accentShadow, color: '#fff',
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em' }}>
          {card.name || 'Member'}
        </div>
        <div style={{ marginTop: 3, fontSize: 13, fontFamily: MONO, color: 'rgba(255,255,255,.8)' }}>
          {card.phone}
        </div>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span style={{ fontSize: 34, fontWeight: 700, fontFamily: MONO, letterSpacing: '-.03em' }}>
            {money(card.points)}
          </span>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,.78)' }}>points</span>
        </div>
        {/* What they are worth, because a number of points means nothing on its
            own to the person holding them. */}
        <div style={{ marginTop: 2, fontSize: 12.5, color: 'rgba(255,255,255,.72)' }}>
          worth MVR {money(card.worth)} off a bill
        </div>
      </div>

      {card.tier.name && (
        <div style={{ marginTop: 16, fontSize: 14, color: C.ink }}>
          You are <b>{card.tier.name}</b>.
        </div>
      )}
      {card.tier.next && (
        <div style={{ marginTop: card.tier.name ? 5 : 16, fontSize: 13.5, lineHeight: 1.6, color: C.inkMid }}>
          {money(card.tier.toNext)} more points and you reach <b>{card.tier.next}</b>.
        </div>
      )}

      {!card.scheme.running && (
        /* An earn rate of zero is a scheme that is not running, which is a real
           state and not an error — but a card that silently never grows is a
           card somebody assumes is broken. */
        <div style={{
          marginTop: 16, padding: '12px 14px', borderRadius: 14, fontSize: 13,
          lineHeight: 1.6, background: C.warnBg, border: '1px solid ' + C.warnBorder,
          color: C.warnInk, textWrap: 'pretty',
        }}>
          The points scheme is not running at the moment, so visits are not earning.
          Anything you have already earned is still yours.
        </div>
      )}

      <div style={{ marginTop: 22, fontSize: 12.5, color: C.inkFaint }}>
        A member since {new Date(card.memberSince).toLocaleDateString('en-GB',
          { day: 'numeric', month: 'long', year: 'numeric' })}
      </div>

      <button onClick={onSignOut}
        style={{
          marginTop: 22, padding: '12px 18px', borderRadius: 14, fontSize: 13.5,
          background: C.surfaceTint, color: C.inkMid,
        }}>Sign out</button>
    </div>
  );
}
