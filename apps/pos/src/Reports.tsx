import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { useIntent } from './intent';
import type { Intent } from './intent';

/* Reports & Exports — 02-POS-SPEC.md §2 (`reports`): "Z-read, tax return, P&L,
 * trial balance, MIRA exports."
 *
 * 08-BUILD-STAGES §22 asks that these "agree with each other and with the sum
 * of the day's Z-reads". Every figure comes from the same posted journals, so
 * the screen's job is to SHOW the agreement rather than assert it — each check
 * prints both numbers and the difference between them. A green tick is what a
 * broken check also looks like; a difference of 0.00 beside the two figures it
 * came from is something a manager can actually sign.
 *
 * Export is CSV, built in the browser from the data already on screen. Not a
 * MIRA filing — that needs their schema and a submission channel, and inventing
 * a file that claims to be one would be worse than not offering it. What this
 * gives an accountant is the ledger in a form a spreadsheet opens.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

type Tab = 'zread' | 'pnl' | 'tax' | 'tb';

interface Acct { code: string; name: string; type: string; dr: number; cr: number; balance: number }
interface Check { name: string; a: number; b: number; difference: number; ok: boolean }
interface Zread {
  date: string;
  sales: {
    tickets: number; covers: number; voided: number; gross: number; discount: number;
    service: number; tax: number; rounding: number; total: number; cogs: number; average: number;
  };
  tender: Array<{ method: string; count: number; amount: number; tip: number }>;
  drawer: {
    sessions: Array<{
      id: string; openedAt: string; closedAt: string | null;
      openedBy: string | null; closedBy: string | null;
      float: number | null; counted: number | null; expected: number | null;
      variance: number | null; stillOpen: boolean;
    }>;
    float: number; expected: number; counted: number; variance: number; unclosed: number;
  };
  journals: Array<{ source: string; count: number }>;
  checks: Check[];
}
interface Pnl {
  revenue: { lines: Acct[]; total: number };
  costOfSales: { lines: Acct[]; total: number };
  grossProfit: number; grossMarginPct: number | null;
  operatingCosts: { lines: Acct[]; total: number };
  netProfit: number; primeCost: number; labourPosted: boolean;
}
interface Tax {
  bands: Array<{ code: string; rate: number; sales: number; taxableValue: number; tax: number }>;
  outputTax: number; checkedAgainstSales: number; difference: number; agrees: boolean;
}
interface Tb {
  accounts: Acct[];
  totals: { dr: number; cr: number; difference: number };
  balanced: boolean;
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', wallet: 'Wallet', bank: 'Transfer', points: 'Points',
};
const SOURCE_LABEL: Record<string, string> = {
  sale: 'Sales', stock: 'Stock movements', drawer: 'Drawer variance', manual: 'Manual entries',
};

export function Reports({ session, intent, onIntentDone }: {
  session: Session;
  intent?: Intent | null;
  onIntentDone?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('zread');
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  /* The payload is stored WITH the tab it was fetched for, and rendered only
     when the two match. Held as a bare `data`, the render immediately after a
     tab change drew the previous report's shape against the new tab's view —
     the P&L reading `revenue.total` off a Z-read — and took the whole app down
     with it. Loading state cannot cover that gap, because the flag is set
     inside an effect that runs after the render. The same guard also stops a
     slow response painting under a tab the user has already left. */
  const [payload, setPayload] = useState<{ tab: Tab; data: unknown } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const data = payload && payload.tab === tab ? payload.data : null;

  /* One helper, one BASE — see api.authed. Each of these screens used to
     write its own fetch('/api/...'), which resolves only behind the Vite
     proxy; deployed on its own origin every one of them would have 404'd. */
  const authed = useMemo(() => api.authed(session), [session]);

  /* Arriving from the palette's "Z-report". Z-read is already the opening tab,
     but somebody who left this screen on Trial balance would otherwise land on
     Trial balance, and the row promised them a Z-read. */
  useIntent(intent, 'reports', (act) => {
    if (act === 'zread') setTab('zread');
  }, () => onIntentDone?.());

  const call = useCallback((path: string) => authed('GET', path), [authed]);

  const load = useCallback(async () => {
    setLoading(true);
    const path = tab === 'zread' ? `/reports/zread?date=${date}`
      : tab === 'pnl' ? `/reports/pnl?from=${from}&to=${to}`
        : tab === 'tax' ? `/reports/tax?from=${from}&to=${to}`
          : `/reports/trial-balance?from=${from}&to=${to}`;
    try { setPayload({ tab, data: await call(path) }); setError(''); }
    catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not build the report.');
      setPayload(null);
    } finally { setLoading(false); }
  }, [call, tab, date, from, to]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Reports</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <TabBtn on={tab === 'zread'} onClick={() => setTab('zread')}>Z-read</TabBtn>
          <TabBtn on={tab === 'pnl'} onClick={() => setTab('pnl')}>Profit &amp; loss</TabBtn>
          <TabBtn on={tab === 'tax'} onClick={() => setTab('tax')}>Tax return</TabBtn>
          <TabBtn on={tab === 'tb'} onClick={() => setTab('tb')}>Trial balance</TabBtn>
        </span>
        <span style={{ flex: 1 }} />
        {tab === 'zread' ? (
          <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)}
            aria-label="Business date" style={dateInput} />
        ) : (
          <>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              aria-label="From" style={dateInput} />
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>to</span>
            <input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)}
              aria-label="To" style={dateInput} />
          </>
        )}
        <button onClick={() => exportCsv(tab, data, tab === 'zread' ? date : from + '_' + to)}
          disabled={!data}
          style={{ padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: data ? 'var(--text-muted)' : 'var(--text-faint)' }}>
          Export CSV
        </button>
      </div>

      {error && (
        <div role="status" style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--red-dim)', color: 'var(--red-bright)' }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {loading || !data ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>
            {error ? '' : 'Building the report…'}
          </div>
        ) : tab === 'zread' ? <ZreadView z={data as Zread} />
          : tab === 'pnl' ? <PnlView p={data as Pnl} />
            : tab === 'tax' ? <TaxView t={data as Tax} />
              : <TbView t={data as Tb} />}
      </div>
    </div>
  );
}

/* ── Z-read ──────────────────────────────────────────────────────────────── */

function ZreadView({ z }: { z: Zread }) {
  return (
    <>
      <Checks checks={z.checks} />

      <Card title="The day">
        <Fig label="Takings" value={mvr(z.sales.total)} big />
        <Fig label="Tickets" value={String(z.sales.tickets)} />
        <Fig label="Covers" value={String(z.sales.covers)} />
        <Fig label="Average ticket" value={mvr(z.sales.average)} />
        {z.sales.voided > 0 && <Fig label="Voided" value={String(z.sales.voided)} warn />}
      </Card>

      <Two>
        <Card title="What was billed">
          <Total label="Goods, net of GST" value={mvr(z.sales.gross)} />
          {z.sales.discount !== 0 && <Total label="Discounts" value={'−' + mvr(z.sales.discount)} />}
          {z.sales.service !== 0 && <Total label="Service charge" value={mvr(z.sales.service)} />}
          <Total label="GST" value={mvr(z.sales.tax)} />
          {z.sales.rounding !== 0 && <Total label="Cash rounding" value={mvr(z.sales.rounding)} />}
          <Total label="Total" value={mvr(z.sales.total)} strong />
          <Total label="Cost of what was sold" value={mvr(z.sales.cogs)} />
        </Card>

        <Card title="How it was tendered">
          {z.tender.length ? z.tender.map((t) => (
            <Total key={t.method}
              label={(METHOD_LABEL[t.method] ?? t.method) + ' · ' + t.count
                + (t.tip ? ' · tips ' + mvr(t.tip) : '')}
              value={mvr(t.amount)} />
          )) : <Empty>Nothing was taken on this day.</Empty>}
        </Card>
      </Two>

      <Card title="The drawer">
        {!z.drawer.sessions.length ? (
          <Empty>
            No register was opened on this day. Cash sales still posted to the ledger —
            but nothing was counted, so there is no over/short figure to sign.
          </Empty>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1 }}>REGISTER</span>
              <span style={{ width: 80, textAlign: 'right' }}>FLOAT</span>
              <span style={{ width: 92, textAlign: 'right' }}>EXPECTED</span>
              <span style={{ width: 92, textAlign: 'right' }}>COUNTED</span>
              <span style={{ width: 92, textAlign: 'right' }}>OVER/SHORT</span>
            </div>
            {z.drawer.sessions.map((s) => (
              <div key={s.id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text)' }}>
                    {new Date(s.openedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    {s.closedAt ? '–' + new Date(s.closedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ' — still open'}
                  </span>
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                    {[s.openedBy && 'opened by ' + s.openedBy, s.closedBy && 'closed by ' + s.closedBy]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Num w={80}>{mvr(s.float)}</Num>
                <Num w={92}>{mvr(s.expected)}</Num>
                <Num w={92}>{mvr(s.counted)}</Num>
                <span style={{ width: 92, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: s.variance === null ? 'var(--text-faint)' : s.variance === 0 ? 'var(--go-bright)' : 'var(--red-bright)' }}>
                  {s.variance === null ? '—' : (s.variance > 0 ? '+' : '') + mvr(s.variance)}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, padding: '8px 0', fontWeight: 700 }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)' }}>Counted registers</span>
              <Num w={80}>{mvr(z.drawer.float)}</Num>
              <Num w={92}>{mvr(z.drawer.expected)}</Num>
              <Num w={92}>{mvr(z.drawer.counted)}</Num>
              <span style={{ width: 92, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: z.drawer.variance === 0 ? 'var(--go-bright)' : 'var(--red-bright)' }}>
                {(z.drawer.variance > 0 ? '+' : '') + mvr(z.drawer.variance)}
              </span>
            </div>
            {z.drawer.variance !== 0 && (
              <p style={{ margin: '4px 2px 0', fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)' }}>
                Posted to 6920 Cash over or short. It is an operating cost, never a sale — if a
                surplus reached the revenue line it would be taxed and it would flatter the day.
              </p>
            )}
          </>
        )}
      </Card>

      {z.journals.length > 0 && (
        <Card title="What posted to the ledger">
          {z.journals.map((j) => (
            <Total key={j.source} label={SOURCE_LABEL[j.source] ?? j.source}
              value={j.count + ' entr' + (j.count === 1 ? 'y' : 'ies')} />
          ))}
        </Card>
      )}
    </>
  );
}

/* ── P&L ─────────────────────────────────────────────────────────────────── */

function PnlView({ p }: { p: Pnl }) {
  return (
    <>
      <Card title="Result">
        <Fig label="Revenue" value={mvr(p.revenue.total)} big />
        <Fig label="Gross profit" value={mvr(p.grossProfit)} />
        <Fig label="Gross margin" value={p.grossMarginPct === null ? '—' : p.grossMarginPct.toFixed(1) + '%'} />
        <Fig label="Net profit" value={mvr(p.netProfit)} warn={p.netProfit < 0} />
        <Fig label="Prime cost" value={mvr(p.primeCost)} />
      </Card>

      {!p.labourPosted && (
        <p style={{ margin: '0 2px 12px', fontSize: 11, lineHeight: 1.55, color: 'var(--text-faint)' }}>
          Prime cost here is cost of sales only — no wages have been posted, because payroll
          is not built yet. Read it as incomplete rather than as low.
        </p>
      )}

      <Section title="Revenue" lines={p.revenue.lines} total={p.revenue.total} />
      <Section title="Cost of sales" lines={p.costOfSales.lines} total={p.costOfSales.total} />
      <div style={{ display: 'flex', gap: 12, padding: '8px 2px', marginBottom: 12, borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>Gross profit</span>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(p.grossProfit)}</span>
      </div>
      <Section title="Operating costs" lines={p.operatingCosts.lines} total={p.operatingCosts.total} />
      <div style={{ display: 'flex', gap: 12, padding: '10px 2px', borderTop: '2px solid var(--line)' }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Net profit</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: p.netProfit < 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
          {mvr(p.netProfit)}
        </span>
      </div>
    </>
  );
}

function Section({ title, lines, total }: { title: string; lines: Acct[]; total: number }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ margin: '0 2px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{title.toUpperCase()}</div>
      {lines.length ? lines.map((l) => (
        <div key={l.code} style={{ display: 'flex', gap: 12, padding: '6px 2px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>
            <b style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint)' }}>{l.code}</b> {l.name}
          </span>
          <span style={{ fontSize: 12.5, fontFamily: MONO, color: l.balance < 0 ? 'var(--red-bright)' : 'var(--text-dim)' }}>{mvr(l.balance)}</span>
        </div>
      )) : <div style={{ padding: '6px 2px', fontSize: 11.5, color: 'var(--text-faint)' }}>Nothing posted.</div>}
      <div style={{ display: 'flex', gap: 12, padding: '6px 2px' }}>
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>Total</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(total)}</span>
      </div>
    </div>
  );
}

/* ── tax return ──────────────────────────────────────────────────────────── */

function TaxView({ t }: { t: Tax }) {
  return (
    <>
      <Checks checks={[{
        name: 'The ledger and the receipts agree on the tax collected',
        a: t.outputTax, b: t.checkedAgainstSales, difference: t.difference, ok: t.agrees,
      }]} />

      <Card title="Output tax">
        <Fig label="To declare" value={mvr(t.outputTax)} big />
        <Fig label="On the receipts" value={mvr(t.checkedAgainstSales)} />
      </Card>

      <div style={{ display: 'flex', gap: 12, padding: '6px 2px', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ width: 70 }}>CODE</span>
        <span style={{ width: 56, textAlign: 'right' }}>RATE</span>
        <span style={{ flex: 1, textAlign: 'right' }}>SALES</span>
        <span style={{ width: 110, textAlign: 'right' }}>TAXABLE VALUE</span>
        <span style={{ width: 96, textAlign: 'right' }}>TAX</span>
      </div>
      {t.bands.length ? t.bands.map((b) => (
        <div key={b.code + b.rate} style={{ display: 'flex', gap: 12, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ width: 70, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{b.code}</span>
          <span style={{ width: 56, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{b.rate}%</span>
          <span style={{ flex: 1, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-faint)' }}>{b.sales}</span>
          <Num w={110}>{mvr(b.taxableValue)}</Num>
          <span style={{ width: 96, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(b.tax)}</span>
        </div>
      )) : <Empty>Nothing was sold in this period.</Empty>}

      <p style={{ margin: '10px 2px 0', fontSize: 11, lineHeight: 1.6, color: 'var(--text-faint)' }}>
        Menu prices are tax-inclusive, so the taxable value is the money taken less the
        government&apos;s share — not the money taken. The rate on each line is the rate that was
        in force when the sale was rung up and is stamped on the sale itself, so a rate change
        never restates a period that has already been filed.
        <br />
        Input tax on purchases is not here: purchasing posts to accounts payable without a tax
        split yet, so this is output tax only and is not a complete return.
      </p>
    </>
  );
}

/* ── trial balance ───────────────────────────────────────────────────────── */

function TbView({ t }: { t: Tb }) {
  return (
    <>
      <Checks checks={[{
        name: 'Debits equal credits across the whole ledger',
        a: t.totals.dr, b: t.totals.cr, difference: t.totals.difference, ok: t.balanced,
      }]} />

      <div style={{ display: 'flex', gap: 12, padding: '6px 2px', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ flex: 1 }}>ACCOUNT</span>
        <span style={{ width: 100, textAlign: 'right' }}>DEBIT</span>
        <span style={{ width: 100, textAlign: 'right' }}>CREDIT</span>
        <span style={{ width: 100, textAlign: 'right' }}>BALANCE</span>
      </div>
      {t.accounts.map((a) => (
        <div key={a.code} style={{ display: 'flex', gap: 12, padding: '7px 2px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>
            <b style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint)' }}>{a.code}</b> {a.name}
          </span>
          <Num w={100}>{a.dr ? mvr(a.dr) : '—'}</Num>
          <Num w={100}>{a.cr ? mvr(a.cr) : '—'}</Num>
          <span style={{ width: 100, textAlign: 'right', fontSize: 12.5, fontWeight: 600, fontFamily: MONO, color: a.balance < 0 ? 'var(--red-bright)' : 'var(--text)' }}>{mvr(a.balance)}</span>
        </div>
      ))}
      {!t.accounts.length && <Empty>Nothing has posted in this period.</Empty>}
      <div style={{ display: 'flex', gap: 12, padding: '9px 2px', borderTop: '2px solid var(--line)' }}>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>Total</span>
        <span style={{ width: 100, textAlign: 'right', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(t.totals.dr)}</span>
        <span style={{ width: 100, textAlign: 'right', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(t.totals.cr)}</span>
        <span style={{ width: 100 }} />
      </div>
      <p style={{ margin: '8px 2px 0', fontSize: 11, lineHeight: 1.6, color: 'var(--text-faint)' }}>
        A balance is shown on the account&apos;s own side, so a negative figure means the account
        is the wrong way round. 4090 Discounts given is an income account whose normal side is
        a debit, so it reads negative and correctly reduces revenue rather than looking like a cost.
      </p>
    </>
  );
}

/* ── the checks, which are the point ─────────────────────────────────────── */

function Checks({ checks }: { checks: Check[] }) {
  const bad = checks.filter((c) => !c.ok);
  return (
    <div style={{ marginBottom: 14, borderRadius: 9, overflow: 'hidden', border: '1px solid ' + (bad.length ? 'var(--red-line, var(--line))' : 'var(--line-soft)') }}>
      {checks.map((c) => (
        <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', background: c.ok ? 'var(--bg-1)' : 'var(--red-dim)', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: c.ok ? 'var(--go-bright)' : 'var(--red-bright)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12, color: c.ok ? 'var(--text-muted)' : 'var(--red-bright)' }}>{c.name}</span>
          {/* Both figures and the difference between them. "OK" alone is what a
              broken check also prints. */}
          <span style={{ fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
            {mvr(c.a)} vs {mvr(c.b)}
          </span>
          <span style={{ width: 92, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: c.ok ? 'var(--text-dim)' : 'var(--red-bright)' }}>
            {c.difference > 0 ? '+' : ''}{mvr(c.difference)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── CSV ─────────────────────────────────────────────────────────────────── */

function exportCsv(tab: Tab, data: unknown, stamp: string) {
  if (!data) return;
  const rows: Array<Array<string | number>> = [];
  if (tab === 'tb') {
    const t = data as Tb;
    rows.push(['Code', 'Account', 'Type', 'Debit', 'Credit', 'Balance']);
    t.accounts.forEach((a) => rows.push([a.code, a.name, a.type, a.dr, a.cr, a.balance]));
    rows.push(['', 'TOTAL', '', t.totals.dr, t.totals.cr, t.totals.difference]);
  } else if (tab === 'pnl') {
    const p = data as Pnl;
    rows.push(['Section', 'Code', 'Account', 'Amount']);
    const put = (s: string, ls: Acct[]) => ls.forEach((l) => rows.push([s, l.code, l.name, l.balance]));
    put('Revenue', p.revenue.lines);
    put('Cost of sales', p.costOfSales.lines);
    put('Operating costs', p.operatingCosts.lines);
    rows.push(['', '', 'Gross profit', p.grossProfit]);
    rows.push(['', '', 'Net profit', p.netProfit]);
  } else if (tab === 'tax') {
    const t = data as Tax;
    rows.push(['Code', 'Rate', 'Sales', 'Taxable value', 'Tax']);
    t.bands.forEach((b) => rows.push([b.code, b.rate, b.sales, b.taxableValue, b.tax]));
    rows.push(['', '', '', 'Output tax', t.outputTax]);
    rows.push(['', '', '', 'On the receipts', t.checkedAgainstSales]);
  } else {
    const z = data as Zread;
    rows.push(['Z-read', z.date]);
    rows.push([]);
    rows.push(['Tickets', z.sales.tickets], ['Covers', z.sales.covers],
      ['Goods net of GST', z.sales.gross], ['Discounts', z.sales.discount],
      ['Service', z.sales.service], ['GST', z.sales.tax],
      ['Rounding', z.sales.rounding], ['Total', z.sales.total], ['Cost of sales', z.sales.cogs]);
    rows.push([]);
    rows.push(['Tender', 'Count', 'Amount', 'Tips']);
    z.tender.forEach((t) => rows.push([t.method, t.count, t.amount, t.tip]));
    rows.push([]);
    rows.push(['Register opened', 'Closed', 'Float', 'Expected', 'Counted', 'Over/short']);
    z.drawer.sessions.forEach((s) => rows.push([
      s.openedAt, s.closedAt ?? 'still open', s.float ?? '', s.expected ?? '',
      s.counted ?? '', s.variance ?? '']));
    rows.push([]);
    rows.push(['Check', 'A', 'B', 'Difference', 'OK']);
    z.checks.forEach((c) => rows.push([c.name, c.a, c.b, c.difference, c.ok ? 'yes' : 'NO']));
  }

  const csv = rows.map((r) => r.map((cell) => {
    const s = String(cell ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tab}-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const dateInput: React.CSSProperties = {
  height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)',
  border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO,
};

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: on ? 700 : 600,
      background: on ? 'var(--bg-2)' : 'transparent',
      border: '1px solid ' + (on ? 'var(--line)' : 'transparent'),
      color: on ? 'var(--text)' : 'var(--text-faint)',
    }}>{children}</button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14, padding: '11px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <div style={{ marginBottom: 8, fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{title.toUpperCase()}</div>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>{children}</div>
    </div>
  );
}

function Two({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 300px), 1fr))', gap: 12 }}>{children}</div>;
}

function Fig({ label, value, big, warn }: { label: string; value: string; big?: boolean; warn?: boolean }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label.toUpperCase()}</span>
      <span style={{ fontSize: big ? 22 : 15, fontWeight: 700, fontFamily: MONO, color: warn ? 'var(--red-bright)' : 'var(--text)' }}>{value}</span>
    </span>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ width: '100%', display: 'flex', gap: 12, padding: '4px 0' }}>
      <span style={{ flex: 1, fontSize: strong ? 12.5 : 11.5, fontWeight: strong ? 700 : 400, color: strong ? 'var(--text)' : 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: strong ? 14 : 12, fontWeight: strong ? 700 : 400, fontFamily: MONO, color: strong ? 'var(--text)' : 'var(--text-dim)' }}>{value}</span>
    </div>
  );
}

function Num({ w, children }: { w: number; children: React.ReactNode }) {
  return <span style={{ width: w, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: 'var(--text-dim)' }}>{children}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ width: '100%', padding: '18px 2px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>{children}</div>;
}
