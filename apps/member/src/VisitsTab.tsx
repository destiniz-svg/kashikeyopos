import type { Visits } from './api';
import { C, MONO } from '../../../packages/tokens/guest';

/* §4 Visits — "Real visit history read from settled sales — date, outlet,
 * covers, total, points earned. No fabricated history: a new member sees an
 * empty state that says what will appear here after their first visit."
 *
 * The empty state is the specified part, so it says exactly that rather than
 * "no data". And every row here came from a real settled sale: there is no
 * client-side sample, no placeholder row, nothing that looks like history and
 * is not.
 */

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const when = (s: string) =>
  new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function VisitsTab({ visits }: { visits: Visits | null }) {
  if (!visits) {
    return <div style={{ padding: 24, fontSize: 14, color: C.inkMuted }}>Looking…</div>;
  }
  if (!visits.visits.length) {
    return (
      <div style={{ padding: '46px 22px', textAlign: 'center' }}>
        <div style={{ fontSize: 14, lineHeight: 1.65, color: C.inkGhost, textWrap: 'pretty' }}>
          Nothing here yet. After your first visit with your card on the bill, it
          will show the date, the restaurant, what it came to and what you earned.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 18px 28px' }}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <Fig label="VISITS" value={String(visits.totals.visits)} />
        <Fig label="SPENT" value={money(visits.totals.spent)} />
        <Fig label="EARNED" value={money(visits.totals.earned) + ' pts'} />
      </div>

      <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column' }}>
        {visits.visits.map((v, i) => (
          <div key={i} style={{
            padding: '13px 0', borderBottom: '1px solid ' + C.hairlineSoft,
            display: 'flex', alignItems: 'baseline', gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{v.outlet}</div>
              <div style={{ marginTop: 3, fontSize: 12, color: C.inkMuted, fontFamily: MONO }}>
                {when(v.at)} · {v.covers} {v.covers === 1 ? 'cover' : 'covers'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: C.inkStrong }}>
                {money(v.total)}
              </div>
              {v.points > 0 && (
                <div style={{ marginTop: 2, fontSize: 11.5, color: C.success, fontFamily: MONO }}>
                  +{money(v.points)} pts
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: C.label }}>
        {label}
      </div>
      <div style={{ marginTop: 3, fontSize: 19, fontWeight: 700, fontFamily: MONO, color: C.inkStrong, letterSpacing: '-.02em' }}>
        {value}
      </div>
    </div>
  );
}
