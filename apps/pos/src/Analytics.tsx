import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { useBreakpoint } from './useBreakpoint';

/* Analytics & CFO — 02-POS-SPEC.md §2: "Prime cost, margin by dish, variance
 * trend." 08-BUILD-STAGES §22.
 *
 * FORM BEFORE COLOUR, and for two of the three the answer is NOT A CHART:
 *
 *   · Prime cost and net margin are single headline figures. A stat tile reads
 *     faster than any plot and cannot be misread; plotting one number is
 *     decoration.
 *   · Margin by dish is a ranked comparison of magnitudes at one moment — a
 *     horizontal bar list, which is also a table, so the values are labelled
 *     directly and no axis is needed.
 *   · The variance trend is change over time, and that IS a chart: small
 *     columns, one series, one scale.
 *
 * ONE AXIS. Revenue, cost of sales and labour are all money and share a scale;
 * prime cost PERCENTAGE is not money and would need a second y-axis, so it is
 * printed beside each column rather than plotted against it. A dual-axis chart
 * is the fastest way to imply a relationship that is not there.
 *
 * COLOUR DOES ONE JOB HERE and it is not identity — it is polarity: made money
 * or lost it. That is the design system's existing status pair (--go-bright /
 * --red-bright), already used on every other screen for exactly this meaning,
 * with a neutral for zero. No categorical palette is introduced, so there is no
 * hue order to validate; the ink stays in text tokens throughout and the mark
 * beside a number is what carries the meaning.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number | null) =>
  n === null || n === undefined ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (n: number | null) => (n === null || n === undefined ? '—' : n.toFixed(1) + '%');
const wk = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

interface Dish {
  itemId: string; name: string; category: string | null;
  qty: number; revenue: number; cost: number; margin: number;
  marginPct: number | null; costed: boolean; shareOfMargin: number | null;
}
interface Week {
  week: string; revenue: number; costOfSales: number; labour: number;
  primeCost: number; primeCostPct: number | null;
}
interface Data {
  from: string | null; to: string | null;
  headline: {
    revenue: number; costOfSales: number; labour: number;
    primeCost: number; primeCostPct: number | null;
    grossProfit: number; grossMarginPct: number | null;
    operatingCosts: number; netProfit: number; netMarginPct: number | null;
    labourPosted: boolean;
    cashInDrawer: number; owedToSuppliers: number; owedToStaff: number;
  };
  dishes: Dish[];
  reconciliation: {
    dishRevenue: number; ledgerRevenue: number; revenueDifference: number;
    dishCost: number; ledgerCogs: number; costDifference: number; agrees: boolean;
  };
  trend: Week[];
  variance: {
    weeks: Array<{ week: string; stock: number; cash: number; total: number }>;
    total: number; worsening: boolean;
  };
}

const monthStart = () => new Date().toISOString().slice(0, 8) + '01';
const today = () => new Date().toISOString().slice(0, 10);

export function Analytics({ session }: { session: Session }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('GET', `/analytics?from=${from}&to=${to}`));
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not build the analysis.');
      setData(null);
    }
  }, [call, from, to]);

  useEffect(() => { void load(); }, [load]);

  const h = data?.headline;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Filters in one row above everything, which is where a reader looks for
          them and where they stay put as the content below changes. */}
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
          aria-label="From" style={dateInput} />
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>to</span>
        <input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)}
          aria-label="To" style={dateInput} />
      </div>

      {error && (
        <div role="status" style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--red-dim)', color: 'var(--red-bright)' }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {data === null || !h ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Working…'}
          </div>
        ) : (
          <>
            {/* ── the two numbers a CFO opens this for ─────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 190px), 1fr))', gap: 10, marginBottom: 14 }}>
              <Hero label="Prime cost" value={pc(h.primeCostPct)} sub={mvr(h.primeCost)}
                tone={h.primeCostPct === null ? 'flat' : h.primeCostPct <= 65 ? 'good' : 'bad'} />
              <Hero label="Net margin" value={pc(h.netMarginPct)} sub={mvr(h.netProfit)}
                tone={h.netProfit > 0 ? 'good' : h.netProfit < 0 ? 'bad' : 'flat'} />
              <Hero label="Revenue" value={mvr(h.revenue)} sub="" tone="flat" />
              <Hero label="Gross margin" value={pc(h.grossMarginPct)} sub={mvr(h.grossProfit)} tone="flat" />
            </div>

            {!h.labourPosted && (
              <Note tone="warn">
                No wages have been posted in this period, so prime cost is cost of sales alone.
                Read it as incomplete rather than as good — with labour in it, it will be
                roughly double. Run payroll and it corrects itself.
              </Note>
            )}

            {!data.reconciliation.agrees && (
              <Note tone="bad">
                The dish figures below add up to {mvr(data.reconciliation.dishRevenue)} but the
                ledger holds {mvr(data.reconciliation.ledgerRevenue)} — a difference of{' '}
                {mvr(data.reconciliation.revenueDifference)}. Dish-level numbers come from the
                sale lines, which is the only place a dish exists; the headline figures above come
                from the posted journals. They should be the same money. Until this is found, treat
                the ranking as indicative and the headline as correct.
              </Note>
            )}

            {/* ── margin by dish: a ranked comparison, so a bar list ───── */}
            <section style={{ marginBottom: 18 }}>
              <Head>
                What actually makes the money
                <Sub>ranked by total margin, not by percentage — a 90% dish nobody orders
                  contributes nothing</Sub>
              </Head>
              <DishBars dishes={data.dishes} />
            </section>

            {/* ── the variance trend: change over time, so a chart ─────── */}
            <section style={{ marginBottom: 18 }}>
              <Head>
                Losses nobody decided on
                <Sub>stock that went missing and drawers that miscounted, by week —{' '}
                  {mvr(data.variance.total)} in this period
                  {data.variance.worsening ? ', and getting worse' : ''}</Sub>
              </Head>
              <VarianceChart weeks={data.variance.weeks} worsening={data.variance.worsening} />
            </section>

            {/* ── the money trend ──────────────────────────────────────── */}
            <section>
              <Head>
                Week by week
                <Sub>revenue against what it cost to make — one scale, because they are the
                  same kind of money</Sub>
              </Head>
              <TrendTable trend={data.trend} />
            </section>

            <div style={{ marginTop: 18, display: 'flex', gap: 22, flexWrap: 'wrap' }}>
              <Small label="Cash in the drawer" value={mvr(h.cashInDrawer)} />
              <Small label="Owed to suppliers" value={mvr(h.owedToSuppliers)} />
              <Small label="Owed to staff and pension" value={mvr(h.owedToStaff)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── margin by dish ──────────────────────────────────────────────────────── */

function DishBars({ dishes }: { dishes: Dish[] }) {
  const [hover, setHover] = useState<string | null>(null);
  /* 56 + 88 + 200 + 64 is 408px of fixed columns before the dish name gets a
     pixel, and a phone is 390. They did not clip — the row wrapped and the
     margin bar was drawn over the dish it belonged to. On a phone the bar goes
     (it ranks dishes against each other, which a one-per-line list on a narrow
     screen does anyway) and the figures lose their floors. */
  const isPhone = useBreakpoint() === 'm';
  if (!dishes.length) {
    return <Empty>Nothing has been sold in this period, so there is no margin to rank.</Empty>;
  }
  /* Scaled against the largest MAGNITUDE so a loss-making dish is drawn as long
     as a profitable one of the same size. Scaling against the maximum alone
     would make losses invisible, which is the opposite of useful. */
  const max = Math.max(...dishes.map((d) => Math.abs(d.margin)), 1);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ flex: 1 }}>DISH</span>
        <span style={{ width: isPhone ? undefined : 56, textAlign: 'right' }}>SOLD</span>
        <span style={{ width: isPhone ? undefined : 88, textAlign: 'right' }}>REVENUE</span>
        {!isPhone && <span style={{ width: 200 }}>MARGIN</span>}
        <span style={{ width: isPhone ? undefined : 64, textAlign: 'right' }}>SHARE</span>
      </div>
      {dishes.map((d) => (
        <div key={d.itemId}
          onMouseEnter={() => setHover(d.itemId)} onMouseLeave={() => setHover(null)}
          title={`${d.name}: ${mvr(d.revenue)} revenue less ${mvr(d.cost)} cost = ${mvr(d.margin)} margin (${pc(d.marginPct)}) over ${d.qty} sold`}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--line-soft)', background: hover === d.itemId ? 'var(--bg-1)' : 'transparent', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 150px', minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{d.name}</span>
              {/* A dish with no cost is not a 100% margin — it is a dish nobody
                  has costed, and it must not read as the star of the menu. */}
              {!d.costed && (
                <span style={{ padding: '1px 5px', borderRadius: 4, fontSize: 9, fontWeight: 700, background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>
                  NOT COSTED
                </span>
              )}
            </span>
            {d.category && (
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>{d.category}</span>
            )}
          </span>
          <span style={{ width: isPhone ? undefined : 56, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>{d.qty}</span>
          <span style={{ width: isPhone ? undefined : 88, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{mvr(d.revenue)}</span>

          {/* The bar. 10px, rounded at the data end only, anchored to a
              baseline — and the value is direct-labelled beside it, so this is
              a table that happens to be encoded rather than a chart needing an
              axis. */}
          <span style={{ width: 200, display: isPhone ? 'none' : 'flex', alignItems: 'center', gap: 8 }}>
            <span aria-hidden style={{ flex: 1, height: 10, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
              <span style={{
                width: Math.max(2, (Math.abs(d.margin) / max) * 100) + '%',
                height: '100%',
                background: d.margin < 0 ? 'var(--red-bright)'
                  : d.costed ? 'var(--go)' : 'var(--warn-bright)',
                borderRadius: '3px 4px 4px 3px',
              }} />
            </span>
            <span style={{ width: 74, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: d.margin < 0 ? 'var(--red-bright)' : 'var(--text)' }}>
              {mvr(d.margin)}
            </span>
          </span>
          {/* On a phone the bar is gone, so the margin has to be a figure or it
              is not on the screen at all. */}
          {isPhone && (
            <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: d.margin < 0 ? 'var(--red-bright)' : 'var(--text)' }}>
              {mvr(d.margin)}
            </span>
          )}
          <span style={{ width: isPhone ? undefined : 64, textAlign: 'right', fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>
            {pc(d.marginPct)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── the variance trend ──────────────────────────────────────────────────── */

function VarianceChart({ weeks, worsening }: {
  weeks: Array<{ week: string; stock: number; cash: number; total: number }>;
  worsening: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!weeks.length) {
    return <Empty>No stock went missing and no drawer miscounted in this period. That is the
      result, not an absence of data.</Empty>;
  }
  const max = Math.max(...weeks.map((w) => Math.abs(w.total)), 1);

  return (
    <div style={{ padding: '10px 12px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      {/* One series, so no legend — the heading names it. Columns 22px with a
          2px gap so adjacent bars never merge into one shape. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 92, position: 'relative' }}>
        {weeks.map((w, i) => (
          <span key={w.week}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            title={`Week of ${wk(w.week)}: ${mvr(w.total)} — stock ${mvr(w.stock)}, cash ${mvr(w.cash)}`}
            style={{ flex: 1, maxWidth: 46, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', cursor: 'default' }}>
            <span aria-hidden style={{
              height: Math.max(3, (Math.abs(w.total) / max) * 100) + '%',
              background: w.total > 0 ? 'var(--red-bright)' : 'var(--go)',
              borderRadius: '4px 4px 0 0',
              opacity: hover === null || hover === i ? 1 : .55,
            }} />
          </span>
        ))}
      </div>
      {/* Direct labels, selectively: the first and last week and whichever is
          hovered — never a number on every column. */}
      <div style={{ marginTop: 6, display: 'flex', gap: 2 }}>
        {weeks.map((w, i) => (
          <span key={w.week} style={{ flex: 1, maxWidth: 46, textAlign: 'center', fontSize: 9.5, fontFamily: MONO, color: hover === i ? 'var(--text)' : 'var(--text-faint)' }}>
            {i === 0 || i === weeks.length - 1 || hover === i ? wk(w.week) : ''}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: worsening ? 'var(--red-bright)' : 'var(--text-faint)' }}>
        {hover !== null
          ? `Week of ${wk(weeks[hover].week)} — ${mvr(weeks[hover].total)} (stock ${mvr(weeks[hover].stock)}, cash ${mvr(weeks[hover].cash)})`
          : worsening
            ? 'The last week was worse than the one before it.'
            : 'Not getting worse.'}
      </div>
    </div>
  );
}

/* ── the money trend ─────────────────────────────────────────────────────── */

function TrendTable({ trend }: { trend: Week[] }) {
  if (!trend.length) return <Empty>Nothing posted in this period.</Empty>;
  const max = Math.max(...trend.map((w) => w.revenue), 1);
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ width: 80 }}>WEEK OF</span>
        <span style={{ flex: 1 }}>REVENUE</span>
        <span style={{ width: 92, textAlign: 'right' }}>PRIME COST</span>
        <span style={{ width: 64, textAlign: 'right' }}>OF SALES</span>
      </div>
      {trend.map((w) => (
        <div key={w.week}
          title={`Week of ${wk(w.week)}: revenue ${mvr(w.revenue)}, cost of sales ${mvr(w.costOfSales)}, labour ${mvr(w.labour)}`}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ width: 80, fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>{wk(w.week)}</span>
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span aria-hidden style={{ flex: 1, height: 10, background: 'var(--bg-2)', borderRadius: 3, display: 'flex' }}>
              {/* Revenue, and prime cost inside it — one scale, both money.
                  A 2px gap keeps the two fills from reading as one. */}
              <span style={{ width: Math.max(2, (w.revenue / max) * 100) + '%', height: '100%', background: 'var(--bg-3)', borderRadius: '3px 4px 4px 3px', display: 'flex' }}>
                <span style={{ width: w.revenue ? Math.min(100, (w.primeCost / w.revenue) * 100) + '%' : '0%', height: '100%', background: 'var(--amber)', borderRadius: '3px 0 0 3px', marginRight: 2 }} />
              </span>
            </span>
            <span style={{ width: 88, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{mvr(w.revenue)}</span>
          </span>
          <span style={{ width: 92, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{mvr(w.primeCost)}</span>
          {/* The percentage is NOT plotted — it is not money and would need a
              second scale. Printed beside the bar instead. */}
          <span style={{ width: 64, textAlign: 'right', fontSize: 12, fontWeight: 700, fontFamily: MONO, color: (w.primeCostPct ?? 0) > 65 ? 'var(--red-bright)' : 'var(--text)' }}>
            {pc(w.primeCostPct)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const dateInput: React.CSSProperties = {
  height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO,
};

/* A hero number, not a plot. Plotting one figure is decoration; the tone dot
   carries the polarity so the meaning is never colour-alone on the digits. */
function Hero({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone: 'good' | 'bad' | 'flat';
}) {
  const fg = tone === 'good' ? 'var(--go-bright)' : tone === 'bad' ? 'var(--red-bright)' : 'var(--text-faint)';
  return (
    <div style={{ padding: '11px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {tone !== 'flat' && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 4, background: fg }} />}
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
          {label.toUpperCase()}
        </span>
      </div>
      <div style={{ marginTop: 3, fontSize: 24, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, fontFamily: MONO, color: 'var(--text-faint)' }}>{sub}</div>}
    </div>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: '0 2px 8px', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>{children}</div>;
}
function Sub({ children }: { children: React.ReactNode }) {
  return <span style={{ display: 'block', marginTop: 2, fontSize: 10.5, fontWeight: 400, lineHeight: 1.5, color: 'var(--text-faint)' }}>{children}</span>;
}
function Small({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label.toUpperCase()}</span>
      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text-dim)' }}>{value}</span>
    </span>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '24px 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>{children}</div>;
}
function Note({ tone, children }: { tone: 'warn' | 'bad'; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 14, padding: '10px 12px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.6,
      background: tone === 'bad' ? 'var(--red-dim)' : 'var(--warn-dim)',
      color: tone === 'bad' ? 'var(--red-bright)' : 'var(--warn-bright)',
    }}>{children}</div>
  );
}
