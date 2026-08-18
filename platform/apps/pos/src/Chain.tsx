import type { Session } from './api';
import type { OutletRow } from './estate';
import { MONO, mvr, pctText, shortDay, useOverview } from './estate';

/* Chain Overview — 08-BUILD-STAGES §25.
 *
 * The Owner Dashboard answers "how is the group doing". This answers "how does
 * each branch compare", off THE SAME payload — see `estate.ts`. Two screens
 * fetching their own version of the same figures is how a chain ends up with
 * two answers to one question and no way to settle it.
 *
 * WHAT IT COMPARES, AND WHAT IT REFUSES TO. Sales, covers, spend per head,
 * food cost, discount rate and what each branch has outstanding. Not a ranking
 * with a winner: branches differ in size, site and trading hours, and a league
 * table invites the wrong conversation. Share of the estate is shown because it
 * is a fact; "best" is not computed because it is not one.
 *
 * PER HEAD IS THE FIGURE THAT ONLY WORKS NOW. It is revenue over COVERS, and
 * covers were the number of BILLS until this build — so every per-head figure
 * a chain could have computed from the old estate aggregate was wrong by the
 * average party size, silently and in the flattering direction.
 */

const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};
const th: React.CSSProperties = {
  font: '600 10px/1 system-ui', letterSpacing: '.06em', color: 'var(--text-faint)',
  textAlign: 'right', padding: '0 0 9px', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  textAlign: 'right', padding: '9px 0', font: `400 13px/1.2 ${MONO}`, color: 'var(--text-dim)',
  whiteSpace: 'nowrap',
};

const perHead = (o: OutletRow) => (o.covers > 0 ? o.revenue / o.covers : null);

export function Chain({ session, onGo }: { session: Session; onGo: (m: string) => void }) {
  const { data, error, loading, date, setDate } = useOverview(session);

  if (error) {
    return <div style={{ ...card, color: 'var(--red-bright)' }}>
      The chain could not be read: {error}
    </div>;
  }
  if (!data) {
    return <div style={{ ...card, color: 'var(--text-muted)' }}>
      {loading ? 'Reading the chain…' : 'Nothing yet.'}
    </div>;
  }

  const trading = data.outlets.filter((o) => o.bills > 0);
  const totalRevenue = data.outlets.reduce((a, o) => a + o.revenue, 0);
  const totalCovers = data.outlets.reduce((a, o) => a + o.covers, 0);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ ...card, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ font: '600 17px/1.3 system-ui', color: 'var(--text)' }}>
            {trading.length} of {data.outlets.length} outlet{data.outlets.length === 1 ? '' : 's'}{' '}
            traded on {shortDay(data.date)}
          </div>
          <div style={{ font: '400 12px/1.5 system-ui', color: 'var(--text-muted)', marginTop: 3 }}>
            {data.fellBack
              /* Never silently: the day shown is not the day asked for. */
              ? `${date} has not traded, so this is ${data.date}, the last day that did.`
              : 'Each figure was computed inside the outlet that owns it. This page received sums.'}
          </div>
        </div>
        <label style={{ font: '400 12px/1 system-ui', color: 'var(--text-faint)', display: 'grid', gap: 4 }}>
          Day
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={{
              font: `400 13px/1 ${MONO}`, padding: '7px 8px', borderRadius: 8,
              background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
            }} />
        </label>
      </div>

      <div style={card}>
        <div style={h}>Branch by branch</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Outlet</th>
                <th style={th}>Sales</th>
                <th style={th}>Share</th>
                <th style={th}>Bills</th>
                <th style={th}>Covers</th>
                <th style={th}>Per head</th>
                <th style={th}>Food cost</th>
                <th style={th}>Discount</th>
                <th style={th}>Last sale</th>
              </tr>
            </thead>
            <tbody>
              {data.outlets.map((o) => (
                <tr key={o.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                  <td style={{ ...td, textAlign: 'left', font: '400 13px/1.2 system-ui', color: 'var(--text)' }}>
                    <span style={{
                      display: 'inline-block', width: 7, height: 7, borderRadius: 7, marginRight: 7,
                      background: o.silent ? 'var(--red)' : o.bills > 0 ? 'var(--go)' : 'var(--line-3)',
                    }} />
                    {o.name}
                    <span style={{ color: 'var(--text-faint)', marginLeft: 7, font: `400 11px/1 ${MONO}` }}>
                      {o.code}
                    </span>
                  </td>
                  <td style={{ ...td, color: 'var(--warn-bright)' }}>{mvr(o.revenue)}</td>
                  <td style={td}>{pctText(o.sharePct)}</td>
                  <td style={td}>{o.bills}</td>
                  <td style={td}>{o.covers}</td>
                  <td style={td}>{mvr(perHead(o))}</td>
                  <td style={{ ...td,
                    color: o.foodCostPct === null ? 'var(--text-faint)'
                      : data.target.foodCostTargetPct === null ? 'var(--text-dim)'
                        : o.foodCostPct > data.target.foodCostTargetPct
                          ? 'var(--red-bright)' : 'var(--go-bright)' }}>
                    {pctText(o.foodCostPct)}
                  </td>
                  <td style={td}>{mvr(o.discount)}</td>
                  <td style={{ ...td, color: 'var(--text-faint)' }}>
                    {o.lastSaleAt
                      ? new Date(o.lastSaleAt).toLocaleTimeString('en-GB',
                        { hour: '2-digit', minute: '2-digit' })
                      : '—'}
                  </td>
                </tr>
              ))}
              {data.outlets.length > 1 && (
                <tr style={{ borderTop: '1px solid var(--line-2)' }}>
                  <td style={{ ...td, textAlign: 'left', font: '600 13px/1.2 system-ui', color: 'var(--text)' }}>
                    The estate
                  </td>
                  <td style={{ ...td, color: 'var(--warn-bright)', fontWeight: 600 }}>{mvr(totalRevenue)}</td>
                  <td style={td}>100%</td>
                  <td style={td}>{data.outlets.reduce((a, o) => a + o.bills, 0)}</td>
                  <td style={td}>{totalCovers}</td>
                  <td style={td}>{mvr(totalCovers > 0 ? totalRevenue / totalCovers : null)}</td>
                  <td style={td}>{pctText(data.figures.foodCost.value)}</td>
                  <td style={td}>{mvr(data.outlets.reduce((a, o) => a + o.discount, 0))}</td>
                  <td style={td}>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data.outlets.length === 0 && (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
            No active outlets yet. A branch appears here the moment it is provisioned.
          </div>
        )}
        <div style={{ marginTop: 10, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
          Per head is sales over COVERS — the people fed, not the bills printed. There is no
          ranking here on purpose: branches differ in size, site and hours, and a league table
          asks the wrong question of the difference.
        </div>
      </div>

      <div style={card}>
        <div style={h}>What each branch has outstanding</div>
        <div style={{ display: 'grid', gap: 10 }}>
          {data.outlets.map((o) => {
            const a = o.alerts;
            const items: string[] = [];
            if (o.silent) items.push('took nothing while other outlets traded');
            if (a?.salesUnjournalled) items.push(`${a.salesUnjournalled} sale(s) never reached the ledger`);
            if (a && a.receipts.missing > 0) items.push(`${a.receipts.missing} receipt number(s) missing from the day's run`);
            if (a?.servicesOverdue) items.push(`${a.servicesOverdue} equipment service(s) overdue`);
            if (a?.houseOverLimit) {
              items.push(`${a.houseOverLimit} house account(s) over their limit, by MVR ${mvr(a.houseOverLimitValue)}`);
            }
            return (
              <div key={o.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ width: 150, flex: '0 0 150px', font: '500 13px/1.4 system-ui', color: 'var(--text-dim)' }}>
                  {o.name}
                </div>
                <div style={{ flex: 1, font: '400 12px/1.5 system-ui',
                  color: items.length ? 'var(--text-muted)' : 'var(--go-bright)' }}>
                  {items.length ? items.join(' · ') : 'nothing outstanding'}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
          Counts, not rows. Which three services are overdue is a question for that branch&rsquo;s own
          Equipment screen, signed in at that branch — this page cannot see them and is not
          supposed to be able to.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onGo('owner')}
          style={{
            padding: '9px 16px', borderRadius: 9, cursor: 'pointer', background: 'var(--bg-2)',
            color: 'var(--text-dim)', border: '1px solid var(--line-2)', font: '500 13px/1 system-ui',
          }}>
          Back to the owner dashboard
        </button>
        <button type="button" onClick={() => onGo('branches')}
          style={{
            padding: '9px 16px', borderRadius: 9, cursor: 'pointer', background: 'var(--bg-2)',
            color: 'var(--text-dim)', border: '1px solid var(--line-2)', font: '500 13px/1 system-ui',
          }}>
          Outlets
        </button>
      </div>
    </div>
  );
}
