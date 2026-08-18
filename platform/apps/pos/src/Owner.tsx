import { useEffect, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import type { Overview, Waiting } from './estate';
import { MONO, mvr, pctText, shortDay, useOverview } from './estate';

/* Owner Dashboard — 11-OWNER-DASHBOARD-SPEC.md.
 *
 * It is a VIEW INSIDE THE POS, not a second application: same sign-in, same
 * session, same audit trail. An owner reaches it with the PIN they already
 * have. Building it as its own portal would mean a second login, a second
 * deploy and two places for one figure to disagree with itself.
 *
 * NOTHING ON THIS SCREEN WRITES except the targets card, and that card is here
 * for a reason the spec is explicit about (§4): the health score's weights are
 * configuration, so the person being scored by them can see and set them. Every
 * other control navigates.
 *
 * THE HARDEST PART OF THIS SCREEN IS WHAT IT REFUSES TO SAY. A dashboard is
 * read in four seconds and believed for the rest of the day, so a figure that
 * is not known has to look different from a figure that is zero:
 *   · no trading → the score is an em dash, not a 100
 *   · no food cost target → the number is shown and explicitly not judged
 *   · no payroll posted → labour says "missing, not zero" beside the figure
 *   · fewer than two trading days → a sentence where the chart would be
 *   · unsynced writes → "unknown", because they are on a till by definition
 * Every one of those is a place where a confident number would be a lie.
 */

const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)',
  borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};

export function Owner({ session, onGo }: { session: Session; onGo: (m: string) => void }) {
  const { data, error, loading, date, setDate, reload } = useOverview(session);

  if (error) {
    return (
      <div style={{ ...card, color: 'var(--red-bright)' }}>
        The estate could not be read: {error}
      </div>
    );
  }
  if (!data) {
    return <div style={{ ...card, color: 'var(--text-muted)' }}>
      {loading ? 'Reading the estate…' : 'Nothing yet.'}
    </div>;
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Briefing data={data} date={date} setDate={setDate} loading={loading} />
      <Figures data={data} />
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr)' }}>
        <Fortnight data={data} />
        <Estate data={data} onGo={onGo} />
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <ProfitAndLoss data={data} />
        <Position data={data} />
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <WaitingOnYou data={data} onGo={onGo} />
        <Controls data={data} />
      </div>
      <Targets session={session} data={data} onSaved={reload} />
      <NotHere />
    </div>
  );
}

/* ── §3.1 the briefing band ──────────────────────────────────────────────── */

function Briefing({ data, date, setDate, loading }: {
  data: Overview; date: string; setDate: (d: string) => void; loading: boolean;
}) {
  const score = data.briefing.score;
  const tone = score === null ? 'var(--text-faint)'
    : score >= 80 ? 'var(--go-bright)' : score >= 60 ? 'var(--warn-bright)' : 'var(--red-bright)';
  return (
    <div style={{ ...card, display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div title={score === null ? 'A day that has not happened is not a judgement.'
        : data.briefing.why.map((w) => `−${w.points}  ${w.cause}`).join('\n') || 'Nothing deducted.'}
      style={{
        width: 74, height: 74, flex: '0 0 74px', borderRadius: 12, background: 'var(--bg-2)',
        display: 'grid', placeItems: 'center', border: '1px solid var(--line)',
      }}>
        {/* An em dash, never a zero and never a hopeful 100. */}
        <div style={{ font: `700 26px/1 ${MONO}`, color: tone }}>
          {score === null ? '—' : score}
        </div>
        <div style={{ font: '600 9px/1 system-ui', letterSpacing: '.1em', color: 'var(--text-faint)', marginTop: 4 }}>
          HEALTH
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: '600 18px/1.3 system-ui', color: 'var(--text)' }}>
          {data.briefing.headline}
        </div>
        <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)', marginTop: 4 }}>
          {data.briefing.context}
        </div>
        {data.briefing.why.length > 0 && (
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 3 }}>
            {data.briefing.why.map((w, i) => (
              <li key={i} style={{ font: '400 12px/1.4 system-ui', color: 'var(--text-faint)' }}>
                <span style={{ font: `500 12px/1.4 ${MONO}`, color: 'var(--red-bright)' }}>
                  −{w.points}
                </span>{' '}{w.cause}
              </li>
            ))}
          </ul>
        )}
      </div>
      <label style={{ font: '400 12px/1 system-ui', color: 'var(--text-faint)', display: 'grid', gap: 4 }}>
        Day
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          style={{
            font: `400 13px/1 ${MONO}`, padding: '7px 8px', borderRadius: 8,
            background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
          }} />
        <span style={{ color: loading ? 'var(--amber-bright)' : 'transparent', font: '400 11px/1 system-ui' }}>
          reading…
        </span>
      </label>
    </div>
  );
}

/* ── §3.2 the six figures ────────────────────────────────────────────────── */

function Figures({ data }: { data: Overview }) {
  const f = data.figures;
  const tone = (over: boolean | null) =>
    over === null ? 'var(--text)' : over ? 'var(--red-bright)' : 'var(--go-bright)';
  const cells: Array<{ label: string; value: string; note: string; color?: string }> = [
    { label: 'Net sales', value: mvr(f.netSales.value),
      note: delta(f.netSales.deltaPct, f.netSales.against) },
    { label: 'Covers', value: String(f.covers.value),
      note: delta(f.covers.deltaPct, f.covers.against) },
    { label: 'Food cost', value: pctText(f.foodCost.value),
      note: f.foodCost.against, color: tone(f.foodCost.over) },
    /* A labour figure with no payroll behind it is NOT on target — it is
       missing. Green would tell an owner their wage bill is under control on a
       day nobody has run payroll for, which is the most flattering possible
       lie this screen could tell. */
    { label: 'Labour', value: pctText(f.labour.value),
      note: f.labour.against, color: f.labour.posted ? tone(f.labour.over) : 'var(--text-faint)' },
    { label: 'Prime cost', value: pctText(f.primeCost.value),
      note: f.primeCost.complete ? f.primeCost.against
        : f.primeCost.against + ' — without labour, so not yet complete',
      /* Same reason as labour: prime cost missing its largest component is not
         a prime cost that has met its target. */
      color: f.primeCost.complete ? tone(f.primeCost.over) : 'var(--text-faint)' },
    { label: 'Profit', value: mvr(f.profit.value),
      note: pctText(f.profit.pct) + ' of ' + f.profit.against,
      color: (f.profit.value ?? 0) < 0 ? 'var(--red-bright)' : undefined },
  ];
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))' }}>
      {cells.map((c) => (
        <div key={c.label} style={card}>
          <div style={h}>{c.label}</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: c.color || 'var(--text)' }}>{c.value}</div>
          <div style={{ font: '400 11px/1.4 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            {c.note}
          </div>
        </div>
      ))}
    </div>
  );
}

function delta(d: number | null, against: string) {
  if (d === null) return 'nothing to compare against yet';
  return (d >= 0 ? '+' : '') + d + '% on ' + against;
}

/* ── §3.3 fourteen days ──────────────────────────────────────────────────── */

function Fortnight({ data }: { data: Overview }) {
  const s = data.series;
  const peak = Math.max(1, ...s.bars.map((b) => b.revenue ?? 0));
  return (
    <div style={card}>
      <div style={h}>Fourteen days</div>
      {!s.plottable ? (
        /* Thirteen empty columns carry less information than this sentence. */
        <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
          Only {s.tradingDays} of the last fourteen days has traded, so there is no
          shape to plot yet. The chart appears once there are two.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110 }}>
            {s.bars.map((b, i) => (
              <div key={b.date} title={`${b.date} — ${b.traded ? mvr(b.revenue) : 'did not trade'}`}
                style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  justifyContent: 'flex-end', height: '100%' }}>
                <div style={{
                  height: b.traded ? Math.max(2, ((b.revenue ?? 0) / peak) * 100) + '%' : 2,
                  background: !b.traded ? 'var(--line)'
                    : i === s.bars.length - 1 ? 'var(--amber)' : 'var(--bg-3)',
                  borderRadius: 3,
                }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6,
            font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
            <span>{shortDay(s.from)}</span><span>{shortDay(s.to)}</span>
          </div>
        </>
      )}
      <div style={{ marginTop: 10, font: '400 12px/1.5 system-ui', color: 'var(--text-muted)' }}>
        {s.growthPct === null ? (
          /* Suppressed entirely — a percentage against zero is not a percentage. */
          <>No growth figure: {s.growthSuppressed}.</>
        ) : (
          <>Last seven days {mvr(s.lastSeven)} against {mvr(s.previousSeven)} —{' '}
            <span style={{ color: s.growthPct >= 0 ? 'var(--go-bright)' : 'var(--red-bright)' }}>
              {s.growthPct >= 0 ? '+' : ''}{s.growthPct}%
            </span>.
          </>
        )}
      </div>
    </div>
  );
}

/* ── §3.4 the estate ─────────────────────────────────────────────────────── */

function Estate({ data, onGo }: { data: Overview; onGo: (m: string) => void }) {
  return (
    <div style={card}>
      <div style={h}>The estate</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 380 }}>
          <thead>
            <tr style={{ font: '600 10px/1 system-ui', letterSpacing: '.06em',
              color: 'var(--text-faint)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '0 0 8px' }}>Outlet</th>
              <th style={{ padding: '0 0 8px' }}>Sales</th>
              <th style={{ padding: '0 0 8px' }}>Share</th>
              <th style={{ padding: '0 0 8px' }}>Covers</th>
              <th style={{ padding: '0 0 8px' }}>Food</th>
            </tr>
          </thead>
          <tbody>
            {data.outlets.map((o) => (
              <tr key={o.id} onClick={() => onGo('chain')} style={{ cursor: 'pointer' }}>
                <td style={{ padding: '7px 0', font: '400 13px/1.2 system-ui', color: 'var(--text)' }}>
                  <span style={{
                    display: 'inline-block', width: 7, height: 7, borderRadius: 7, marginRight: 7,
                    background: o.silent ? 'var(--red)' : o.bills > 0 ? 'var(--go)' : 'var(--line-3)',
                  }} />
                  {o.name}
                </td>
                <td style={{ textAlign: 'right', font: `400 13px/1.2 ${MONO}`, color: 'var(--warn-bright)' }}>
                  {mvr(o.revenue)}
                </td>
                <td style={{ textAlign: 'right', font: `400 13px/1.2 ${MONO}`, color: 'var(--text-muted)' }}>
                  {pctText(o.sharePct)}
                </td>
                <td style={{ textAlign: 'right', font: `400 13px/1.2 ${MONO}`, color: 'var(--text-muted)' }}>
                  {o.covers}
                </td>
                <td style={{ textAlign: 'right', font: `400 13px/1.2 ${MONO}`, color: 'var(--text-muted)' }}>
                  {pctText(o.foodCostPct)}
                </td>
              </tr>
            ))}
            {data.outlets.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '10px 0', font: '400 13px/1.4 system-ui', color: 'var(--text-muted)' }}>
                No active outlets.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* §3.4: the footer states the isolation rule, on the screen where
          somebody would otherwise ask for a drill-through. */}
      <div style={{ marginTop: 10, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
        Each site&rsquo;s figures are computed inside that site&rsquo;s own books; this table is
        the sum. It is the only cross-outlet read the system performs, and it is written
        to the audit trail as a group-scope query.
      </div>
    </div>
  );
}

/* ── §3.5 P&L and money position ─────────────────────────────────────────── */

function ProfitAndLoss({ data }: { data: Overview }) {
  const p = data.pnl;
  const rows: Array<[string, number, number | null, boolean]> = [
    ['Revenue', p.revenue, 100, false],
    ['Cost of sales', -p.costOfSales, p.costOfSalesPct, false],
    ['Gross profit', p.grossProfit, p.grossMarginPct, true],
    ['Labour', -p.labour, p.labourPct, false],
    ['Prime cost', p.primeCost, p.primeCostPct, true],
    ['Overheads', -p.overheads, p.overheadsPct, false],
    ['Net profit', p.netProfit, p.netMarginPct, true],
  ];
  const seg: Record<string, string> = {
    food: 'var(--red)', labour: 'var(--amber)',
    overheads: 'var(--line-3)', profit: 'var(--go)',
  };
  return (
    <div style={card}>
      <div style={h}>Profit and loss</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([label, value, share, strong]) => (
            <tr key={label}>
              <td style={{ padding: '5px 0',
                font: `${strong ? 600 : 400} 13px/1.2 system-ui`,
                color: strong ? 'var(--text)' : 'var(--text-muted)',
                borderTop: strong ? '1px solid var(--line)' : undefined }}>{label}</td>
              <td style={{ textAlign: 'right', padding: '5px 0',
                font: `${strong ? 600 : 400} 13px/1.2 ${MONO}`,
                color: value < 0 && strong ? 'var(--red-bright)' : 'var(--text)',
                borderTop: strong ? '1px solid var(--line)' : undefined }}>{mvr(value)}</td>
              <td style={{ textAlign: 'right', padding: '5px 0 5px 12px', width: 58,
                font: `400 12px/1.2 ${MONO}`, color: 'var(--text-faint)',
                borderTop: strong ? '1px solid var(--line)' : undefined }}>{pctText(share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.bar.length > 0 && (
        <>
          <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden',
            marginTop: 12, background: 'var(--bg-2)' }}>
            {p.bar.map((b) => (
              <div key={b.key} title={`${b.key} ${b.pct}%`}
                style={{ width: b.pct + '%', background: seg[b.key] }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 7, flexWrap: 'wrap' }}>
            {p.bar.map((b) => (
              <span key={b.key} style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2,
                  background: seg[b.key], marginRight: 5 }} />
                {b.key} {b.pct}%
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Position({ data }: { data: Overview }) {
  const line = (l: { key: string; label: string; value: number }, held: boolean) => (
    <div key={l.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0' }}>
      <span style={{ font: '400 13px/1.3 system-ui', color: held ? 'var(--text-faint)' : 'var(--text-muted)' }}>
        {l.label}
      </span>
      <span style={{ font: `400 13px/1.3 ${MONO}`, color: held ? 'var(--text-muted)' : 'var(--warn-bright)' }}>
        {mvr(l.value)}
      </span>
    </div>
  );
  return (
    <div style={card}>
      <div style={h}>Money position</div>
      {data.position.ours.map((l) => line(l, false))}
      <div style={{ ...h, marginTop: 14 }}>Held on behalf of someone else</div>
      {data.position.heldForOthers.map((l) => line(l, true))}
      <div style={{ marginTop: 8, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
        These four are not the business&rsquo;s money. Netting them into the cash figure reads
        healthy right up to the morning the payroll run empties it.
      </div>
    </div>
  );
}

/* ── §3.6 waiting on you ─────────────────────────────────────────────────── */

function WaitingOnYou({ data, onGo }: { data: Overview; onGo: (m: string) => void }) {
  return (
    <div style={card}>
      <div style={h}>Waiting on you</div>
      {data.waiting.length === 0 ? (
        <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--go-bright)' }}>
          Nothing. Every decision on this screen belongs to somebody below you today.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {data.waiting.map((w: Waiting, i) => (
            <button key={i} type="button" onClick={() => onGo(w.goTo)}
              style={{
                textAlign: 'left', display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-dim)',
                font: '400 13px/1.45 system-ui',
              }}>
              <span style={{
                font: '600 9px/1.6 system-ui', letterSpacing: '.08em', padding: '2px 6px',
                borderRadius: 5, background: 'var(--bg-3)', color: 'var(--text-faint)',
                textTransform: 'uppercase', flex: '0 0 auto',
              }}>{w.kind}</span>
              <span style={{ flex: 1 }}>{w.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── §3.7 controls, checked not claimed ──────────────────────────────────── */

function Controls({ data }: { data: Overview }) {
  const tone: Record<string, string> = {
    ok: 'var(--go-bright)', attention: 'var(--red-bright)', unknown: 'var(--text-faint)',
  };
  return (
    <div style={card}>
      <div style={h}>Controls</div>
      <div style={{ display: 'grid', gap: 9 }}>
        {data.controls.map((c) => (
          <div key={c.key} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <span style={{ color: tone[c.state], font: `600 12px/1.4 ${MONO}`, flex: '0 0 auto' }}>
              {c.state === 'ok' ? '✓' : c.state === 'attention' ? '!' : '?'}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: '500 13px/1.3 system-ui', color: 'var(--text-dim)' }}>{c.label}</div>
              <div style={{ font: '400 11px/1.45 system-ui', color: 'var(--text-faint)' }}>{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
        Each line above was computed on {data.date}&rsquo;s own rows just now. None of them is a
        stored flag somebody set once.
      </div>
    </div>
  );
}

/* ── §4 the weights are configuration ────────────────────────────────────── */

function Targets({ session, data, onSaved }: {
  session: Session; data: Overview; onSaved: () => void;
}) {
  const call = api.chainAuthed(session);
  const t = data.target;
  const [food, setFood] = useState(t.foodCostTargetPct === null ? '' : String(t.foodCostTargetPct));
  const [labour, setLabour] = useState(String(t.labourTargetPct));
  const [prime, setPrime] = useState(String(t.primeTargetPct));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setFood(t.foodCostTargetPct === null ? '' : String(t.foodCostTargetPct));
    setLabour(String(t.labourTargetPct));
    setPrime(String(t.primeTargetPct));
  }, [t.foodCostTargetPct, t.labourTargetPct, t.primeTargetPct]);

  const save = async () => {
    setSaving(true); setErr('');
    try {
      await call('PUT', '/estate/targets', {
        /* An empty box means "nobody has decided", which is a real state and
           not the same as a zero. */
        foodCostTargetPct: food.trim() === '' ? null : Number(food),
        labourTargetPct: Number(labour),
        primeTargetPct: Number(prime),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  };

  const box: React.CSSProperties = {
    font: `400 14px/1 ${MONO}`, padding: '8px 9px', borderRadius: 8, width: 90,
    background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
  };
  const field = (label: string, v: string, set: (s: string) => void, hint: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>{label}</span>
      <input value={v} inputMode="decimal" onChange={(e) => set(e.target.value)} style={box} />
      <span style={{ font: '400 11px/1.4 system-ui', color: 'var(--text-faint)', maxWidth: 220 }}>
        {hint}
      </span>
    </label>
  );

  return (
    <div style={card}>
      <div style={h}>The targets this screen judges by</div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {field('Food cost %', food, setFood,
          'Left empty on purpose until you decide. A fine dining room runs 28% and a '
          + 'shawarma counter runs 40%, and the system will not pick for you — while it '
          + 'is empty, food cost is reported but never scored.')}
        {field('Labour %', labour, setLabour, 'Wages and benefits as a share of revenue.')}
        {field('Prime cost %', prime, setPrime, 'Cost of sales plus labour together.')}
        <button type="button" onClick={save} disabled={saving}
          style={{
            marginTop: 20, padding: '9px 16px', borderRadius: 9, cursor: 'pointer',
            background: 'var(--amber)', color: '#111214', border: 'none',
            font: '600 13px/1 system-ui', opacity: saving ? 0.6 : 1,
          }}>
          {saving ? 'Saving…' : 'Save targets'}
        </button>
      </div>
      {err && <div style={{ marginTop: 8, color: 'var(--red-bright)', font: '400 12px/1.4 system-ui' }}>{err}</div>}
    </div>
  );
}

/* ── §3.8 what this screen cannot show ───────────────────────────────────── */

function NotHere() {
  return (
    <div style={{ ...card, background: 'var(--bg-0)' }}>
      <div style={h}>Deliberately not here</div>
      <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--text-faint)' }}>
        Individual receipts · open tickets or the floor · staff PINs · guest contact
        details · writes of any kind · another outlet&rsquo;s rows.
        <br />
        This is not modesty about an unfinished screen. The figures above were produced by
        functions that can only return sums, so there is nothing here to drill into — and a
        request to add a drill-through is a request to take that apart.
      </div>
    </div>
  );
}
