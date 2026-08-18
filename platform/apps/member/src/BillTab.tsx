import { useState } from 'react';
import type { Bill, Card } from './api';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* §3 Bill — "the member's open ticket at whichever outlet they are sitting in,
 * with the same line/total treatment as the guest portal."
 *
 * AND THE SENTENCE THAT GOVERNS THE WHOLE SCREEN: "Points settle as money...
 * The till still takes the payment: the portal posts intent."
 *
 * So this screen shows what has been ordered and what the goods come to, and it
 * does NOT show a final total: service and tax are the till's arithmetic, and a
 * phone quoting a figure the counter then contradicts is the single worst thing
 * a portal can do. The guest portal makes the same refusal in the same words.
 *
 * Offering points is worded as an offer everywhere it appears — before, in the
 * button, and after, in what comes back. Nothing here moves a point.
 */

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Props {
  bill: Bill | null;
  card: Card | null;
  onOffer: (points: number) => Promise<void>;
}

export function BillTab({ bill, card, onOffer }: Props) {
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState(false);

  if (!bill) {
    return (
      <div style={{ padding: '46px 22px', textAlign: 'center' }}>
        <div style={{ fontSize: 14, lineHeight: 1.65, color: C.inkGhost, textWrap: 'pretty' }}>
          Nothing open in your name. When a server puts your card on a table, the
          bill appears here while you eat.
        </div>
      </div>
    );
  }

  const want = Math.max(0, Math.round(Number(offer) || 0));
  const have = card ? card.points : 0;
  const rate = card && card.scheme.pointValue ? card.scheme.pointValue : 0;

  return (
    <div style={{ padding: '20px 18px 28px' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.03em' }}>
        {bill.outlet.name}
      </div>
      <div style={{ marginTop: 3, fontSize: 12.5, color: C.inkMuted, fontFamily: MONO }}>
        {bill.table ? 'Table ' + bill.table : 'Your bill'} · {bill.covers}{' '}
        {bill.covers === 1 ? 'cover' : 'covers'}
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column' }}>
        {bill.lines.map((l, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'baseline', gap: 11, padding: '11px 0',
            minHeight: HIT.row, borderBottom: '1px solid ' + C.hairlineSoft,
          }}>
            <span style={{ width: 26, fontFamily: MONO, fontSize: 13.5, color: C.inkMuted }}>
              {l.qty}
            </span>
            <span style={{ flex: 1, fontSize: 14, color: C.ink }}>
              {l.name}
              {!l.sent && (
                <span style={{ marginLeft: 7, fontSize: 11.5, color: C.inkFaint }}>
                  not sent yet
                </span>
              )}
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: C.inkStrong }}>
              {money(l.amount)}
            </span>
          </div>
        ))}
      </div>

      {/* Goods only, and labelled as such — the same refusal the guest portal
          makes. Service and tax are the till's, and quoting them here would be
          a figure the counter could contradict. */}
      <div style={{ marginTop: 15, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, color: C.inkSoft }}>Goods, before service and tax</span>
        <span style={{ fontSize: 19, fontWeight: 800, fontFamily: MONO, color: C.inkStrong, letterSpacing: '-.03em' }}>
          {money(bill.goods)}
        </span>
      </div>

      {/* ── points, as an offer ─────────────────────────────────────────── */}
      <div style={{ marginTop: 24, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>
        PAY SOME OF IT WITH POINTS
      </div>

      {bill.pointsOffered !== null ? (
        <div style={{
          marginTop: 10, padding: '13px 15px', borderRadius: 14,
          background: '#f0fbf2', border: '1px solid #d6efdc', color: '#1f7a37',
          fontSize: 13.5, lineHeight: 1.6, textWrap: 'pretty',
        }}>
          You have offered <b>{money(bill.pointsOffered)} points</b>
          {rate > 0 && ' (MVR ' + money(bill.pointsOffered * rate) + ')'}.
          The cashier takes it off when you pay.
          <div style={{ marginTop: 4, fontSize: 12, color: '#2f8a48' }}>
            Nothing has been charged or deducted yet.
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 10, display: 'flex', gap: 9 }}>
            <input
              value={offer} inputMode="numeric" aria-label="Points to offer"
              onChange={(e) => setOffer(e.target.value.replace(/[^\d]/g, '').slice(0, 7))}
              placeholder={'up to ' + money(have)}
              style={{
                flex: 1, height: HIT.input, padding: '0 15px', borderRadius: 14,
                background: C.surfaceTint, fontSize: 15, fontFamily: MONO, color: C.ink,
              }}
            />
            <button
              disabled={!want || want > have || busy}
              onClick={async () => {
                setBusy(true);
                try { await onOffer(want); setOffer(''); } finally { setBusy(false); }
              }}
              style={{
                height: HIT.input, padding: '0 20px', borderRadius: 14,
                background: want && want <= have ? C.accent : C.surfaceTint,
                color: want && want <= have ? '#fff' : C.inkFaint,
                fontSize: 14.5, fontWeight: 700,
              }}
            >{busy ? '…' : 'Offer'}</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6, color: C.inkMuted, textWrap: 'pretty' }}>
            {want > 0 && rate > 0 && want <= have
              ? money(want) + ' points is MVR ' + money(want * rate)
                + ' off. The cashier applies it when you pay — this only tells them.'
              : 'You have ' + money(have) + ' points. Offering tells the cashier;'
                + ' nothing is charged or deducted here.'}
          </div>
        </>
      )}
    </div>
  );
}
