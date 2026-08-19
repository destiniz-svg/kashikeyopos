import { useState } from 'react';
import type { Catalogue } from './api';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* §5 Rewards — "The catalogue from the loyalty module: reward, cost in points,
 * availability. Redeeming creates a voucher the till can accept; it does not
 * discount anything on the phone."
 *
 * So the button says what it does, and the voucher that comes back says where
 * it works. A screen that showed a reward "applied" would be describing
 * something that has not happened: the discount exists when a cashier takes the
 * code, and not before.
 *
 * A reward out of reach shows HOW FAR out of reach rather than being greyed
 * out. "820 more points" is something to come back for; a dimmed row is a
 * closed door.
 */

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Props {
  catalogue: Catalogue | null;
  onRedeem: (rewardId: string) => Promise<void>;
}

export function RewardsTab({ catalogue, onRedeem }: Props) {
  const [busy, setBusy] = useState('');

  if (!catalogue) {
    return <div style={{ padding: 24, fontSize: 14, color: C.inkMuted }}>Looking…</div>;
  }

  const live = catalogue.vouchers.filter((v) => v.state === 'ready');
  const spent = catalogue.vouchers.filter((v) => v.state !== 'ready');

  return (
    <div style={{ padding: '20px 18px 28px' }}>
      {live.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>
            READY TO USE
          </div>
          {live.map((v) => (
            <div key={v.id} style={{
              marginTop: 10, padding: 16, borderRadius: 18,
              background: C.accentGradient, color: '#fff', boxShadow: C.accentShadow,
            }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{v.name}</div>
              <div style={{ marginTop: 9, fontSize: 26, fontWeight: 700, fontFamily: MONO, letterSpacing: '.06em' }}>
                {v.code}
              </div>
              <div style={{ marginTop: 7, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(255,255,255,.82)', textWrap: 'pretty' }}>
                Worth MVR {money(v.value)}. Show this at the counter — it comes off
                the bill there, not here.
                {v.expiresAt && ' Good until '
                  + new Date(v.expiresAt).toLocaleDateString('en-GB',
                    { day: 'numeric', month: 'short', year: 'numeric' }) + '.'}
              </div>
            </div>
          ))}
        </>
      )}

      <div style={{ marginTop: live.length ? 24 : 0, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>
        WHAT YOUR POINTS BUY
      </div>
      {!catalogue.rewards.length ? (
        <div style={{ marginTop: 14, fontSize: 13.5, lineHeight: 1.65, color: C.inkGhost, textWrap: 'pretty' }}>
          Nothing in the catalogue yet. Your points keep counting up in the
          meantime — they do not expire while there is nothing to spend them on.
        </div>
      ) : catalogue.rewards.map((r) => (
        <div key={r.id} style={{
          marginTop: 11, padding: 15, borderRadius: 16, background: C.surfaceSoft,
          border: '1px solid ' + C.hairline,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: C.ink }}>{r.name}</div>
            <div style={{ marginTop: 3, fontSize: 12.5, color: C.inkMuted, fontFamily: MONO }}>
              {money(r.points)} points · worth MVR {money(r.value)}
            </div>
            {!r.affordable && (
              /* How far, not a closed door. */
              <div style={{ marginTop: 4, fontSize: 12, color: C.inkFaint }}>
                {money(r.short)} more points to go
              </div>
            )}
          </div>
          <button
            disabled={!r.affordable || busy === r.id}
            onClick={async () => {
              setBusy(r.id);
              try { await onRedeem(r.id); } finally { setBusy(''); }
            }}
            style={{
              minHeight: HIT.row, padding: '0 17px', borderRadius: 14,
              background: r.affordable ? C.accent : C.surfaceTint,
              color: r.affordable ? '#fff' : C.inkFaint,
              fontSize: 13.5, fontWeight: 700, flexShrink: 0,
            }}
          >{busy === r.id ? '…' : 'Get a voucher'}</button>
        </div>
      ))}

      {spent.length > 0 && (
        <>
          <div style={{ marginTop: 26, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>
            ALREADY USED
          </div>
          {spent.map((v) => (
            <div key={v.id} style={{
              padding: '11px 0', borderBottom: '1px solid ' + C.hairlineSoft,
              display: 'flex', alignItems: 'baseline', gap: 10, color: C.inkMuted,
            }}>
              <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{v.code}</span>
              <span style={{ flex: 1, fontSize: 13 }}>{v.name}</span>
              {/* Used and expired are different things to be told. */}
              <span style={{ fontSize: 11.5 }}>
                {v.state === 'used' ? 'used' : 'expired'}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
