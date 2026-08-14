import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Orders & Tickets — 02-POS-SPEC.md §2 (`orders`):
 * "Every ticket today, open and closed, with its receipt, tender, server and
 *  audit trail."
 *
 * This is the screen that proves the governing principle. "No screen is a dead
 * end. A financial or stock consequence must be visible and reachable from
 * where it was caused." So a receipt here is not a picture of a receipt: it
 * opens onto the tender that closed it, the journal it posted, the stock it
 * consumed and the trail of who did what — each reached from the sale that
 * caused it, without a search.
 *
 * At TILL rank the server strips cost, COGS and the inventory legs of the
 * journal. The screen does not draw an empty column where they were and does
 * not pretend they are zero; it says they are withheld. A blank is a fact
 * nobody can act on.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number | null) =>
  n === null || n === undefined ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (s: string) =>
  new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface OpenTicket {
  ticketId: string; table: string | null; split: number; covers: number;
  channel: string; status: string; openedAt: string; server: string | null;
  lines: number; sent: number; value: number;
}
interface ClosedSale {
  saleId: string; receiptNo: string; at: string; table: string | null;
  channel: string; covers: number; gross: number; discount: number;
  service: number; tax: number; taxCode: string; rounding: number; total: number;
  methods: string[]; server: string | null; voided: boolean; mismatch: number | null;
}
interface Day {
  date: string;
  open: OpenTicket[];
  closed: ClosedSale[];
  page: { limit: number; offset: number; count: number };
  totals: {
    tickets: number; covers: number; gross: number; discount: number;
    service: number; tax: number; rounding: number; total: number;
    cogs: number | null; voided: number; mismatched: number; average: number;
  };
  tender: Array<{ method: string; count: number; amount: number; tip: number }>;
}
interface Receipt {
  sale: {
    id: string; receiptNo: string; at: string; businessDate: string;
    channel: string; covers: number; table: string | null; openedAt: string | null;
    server: string | null; closedBy: string | null;
    gross: number; discount: number; discountReason: string | null;
    service: number; tax: number; taxCode: string; taxRate: number;
    rounding: number; total: number; cogs: number | null;
    voided: boolean; voidedAt: string | null; voidedBy: string | null;
    clientTotal: number | null; mismatch: boolean;
  };
  lines: Array<{
    id: string; itemId: string; name: string; qty: number; unitPrice: number;
    lineTotal: number; unitCost: number | null; lineCost: number | null;
  }>;
  payments: Array<{
    id: string; method: string; amount: number; currency: string;
    tendered: number | null; change: number | null; tip: number;
    ref: string | null; at: string; takenBy: string | null;
  }>;
  ticketLines: Array<{
    id: string; name: string; qty: number; unitPrice: number; note: string | null;
    sentAt: string | null; voided: boolean; voidReason: string | null;
    by: string | null; voidBy: string | null;
  }>;
  journal: {
    jvNo: string; memo: string; partial?: boolean;
    lines: Array<{ account: string; name: string | null; dr: number; cr: number }>;
  } | null;
  stock: Array<{
    ingredientId: string; name: string | null; unit: string | null;
    qty: number; unitCost: number | null; value: number | null;
  }>;
  audit: Array<{
    at: string; action: string; entity: string; actor: string | null; rank: number | null;
  }> | null;
  auditVisible: boolean;
}

const ACTION_LABEL: Record<string, string> = {
  ticket_send: 'Sent to the kitchen',
  kds_stage: 'Kitchen moved it on',
  sale: 'Paid and closed',
  sale_total_mismatch: 'The till and the server disagreed on the total',
  guest_order: 'Ordered from the table',
};
const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', wallet: 'Wallet', bank: 'Transfer', points: 'Points',
};

const today = () => new Date().toISOString().slice(0, 10);
const PAGE = 50;

export function Orders({ session }: { session: Session }) {
  const [date, setDate] = useState(today());
  const [offset, setOffset] = useState(0);
  const [day, setDay] = useState<Day | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');

  /* One helper, one BASE — see api.authed. Each of these screens used to
     write its own fetch('/api/...'), which resolves only behind the Vite
     proxy; deployed on its own origin every one of them would have 404'd. */
  const authed = useMemo(() => api.authed(session), [session]);
  const call = useCallback((path: string) => authed('GET', path), [authed]);

  const load = useCallback(async () => {
    try {
      setDay(await call(`/orders?date=${date}&limit=${PAGE}&offset=${offset}`) as Day);
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the day.');
      setDay(null);
    }
  }, [call, date, offset]);

  useEffect(() => { void load(); }, [load]);

  const open = async (saleId: string) => {
    setError('');
    try { setReceipt(await call(`/orders/${saleId}`) as Receipt); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not open the receipt.'); }
  };

  const t = day?.totals;
  const pages = day ? Math.ceil(day.page.count / PAGE) : 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Orders &amp; tickets</span>
        <input type="date" value={date} max={today()}
          onChange={(e) => { setOffset(0); setDate(e.target.value); }}
          aria-label="Business date"
          style={{ height: 30, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12, fontFamily: MONO }} />
        {date !== today() && (
          <button onClick={() => { setOffset(0); setDate(today()); }}
            style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
            Back to today
          </button>
        )}
        <span style={{ flex: 1 }} />
        {t && (
          <span style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
            <Fig label="TAKINGS" value={mvr(t.total)} strong />
            <Fig label="TICKETS" value={String(t.tickets)} />
            <Fig label="COVERS" value={String(t.covers)} />
            <Fig label="AVERAGE" value={mvr(t.average)} />
            <Fig label="GST" value={mvr(t.tax)} />
          </span>
        )}
      </div>

      {error && (
        <div role="status" style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--red-dim)', color: 'var(--red-bright)' }}>
          {error}
        </div>
      )}

      {/* A till whose own total disagreed with the server's. Loud, because the
          only reason to store the difference is that somebody looks at it. */}
      {t && t.mismatched > 0 && (
        <div style={{ flexShrink: 0, padding: '9px 14px', fontSize: 11.5, background: 'var(--warn-dim)', color: 'var(--warn-bright)' }}>
          {t.mismatched} receipt{t.mismatched === 1 ? '' : 's'} where a till computed a
          different total from the server. The server&apos;s figure was banked; open the
          receipt to see what the till thought.
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {day === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>Loading…</div>
        ) : (
          <>
            {/* ── still on the floor ───────────────────────────────────── */}
            {day.open.length > 0 && (
              <section style={{ marginBottom: 18 }}>
                <Head>On the floor — {day.open.length} open ticket{day.open.length === 1 ? '' : 's'}</Head>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 9 }}>
                  {day.open.map((o) => (
                    <div key={o.ticketId} style={{ padding: '10px 12px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                          {o.table ? 'Table ' + o.table : 'Counter'}
                          {o.split > 0 && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}> /{o.split}</span>}
                        </span>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--amber)' }}>{mvr(o.value)}</span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                        open since {time(o.openedAt)} · {o.covers} cover{o.covers === 1 ? '' : 's'}
                        {o.server && ' · ' + o.server}
                        <span style={{ display: 'block' }}>
                          {o.lines} line{o.lines === 1 ? '' : 's'}
                          {o.sent === o.lines ? ' · all with the kitchen'
                            : ' · ' + (o.lines - o.sent) + ' not sent yet'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <p style={{ margin: '8px 2px 0', fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                  These are running tabs, priced at the menu. The bill — service, GST and any
                  discount — is worked out when the ticket is settled, so a tab is not a total.
                </p>
              </section>
            )}

            {/* ── closed, with the money ───────────────────────────────── */}
            <section>
              <Head>
                {date === today() ? 'Settled today' : 'Settled on ' + date}
                {day.page.count > 0 && ' — ' + day.page.count}
              </Head>

              {!day.closed.length ? (
                <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                    {day.open.length ? 'Nothing settled yet' : 'Nothing traded on this day'}
                  </div>
                  <div style={{ margin: '9px auto 0', maxWidth: 440, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
                    {day.open.length
                      ? 'There are tickets on the floor. They appear here with their receipt and tender the moment they are paid.'
                      : 'Every settled ticket lands here with its receipt, its tender and the trail of who did what.'}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
                  <div style={{ display: 'flex', gap: 12, padding: '8px 13px', background: 'var(--bg-2)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                    <span style={{ width: 46 }}>TIME</span>
                    <span style={{ flex: 1 }}>RECEIPT</span>
                    <span style={{ width: 92 }}>TENDER</span>
                    <span style={{ width: 78, textAlign: 'right' }}>GST</span>
                    <span style={{ width: 92, textAlign: 'right' }}>TOTAL</span>
                  </div>
                  {day.closed.map((s) => (
                    <button key={s.saleId} onClick={() => void open(s.saleId)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--bg-1)', textAlign: 'left', width: '100%' }}>
                      <span style={{ width: 46, fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>{time(s.at)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: MONO, color: 'var(--text)' }}>{s.receiptNo}</span>
                          {s.voided && <Tag tone="red">Voided</Tag>}
                          {s.mismatch !== null && <Tag tone="warn">Till said {mvr(s.mismatch)}</Tag>}
                        </span>
                        <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                          {s.table ? 'table ' + s.table : s.channel.replace('_', ' ')}
                          {' · '}{s.covers} cover{s.covers === 1 ? '' : 's'}
                          {s.server && ' · ' + s.server}
                          {s.discount > 0 && ' · discount ' + mvr(s.discount)}
                        </span>
                      </span>
                      <span style={{ width: 92, fontSize: 11, color: 'var(--text-dim)' }}>
                        {s.methods.map((m) => METHOD_LABEL[m] ?? m).join(' + ') || '—'}
                      </span>
                      <span style={{ width: 78, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>{mvr(s.tax)}</span>
                      <span style={{ width: 92, textAlign: 'right', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: s.voided ? 'var(--text-faint)' : 'var(--text)', textDecoration: s.voided ? 'line-through' : 'none' }}>
                        {mvr(s.total)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {pages > 1 && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 9 }}>
                  <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}
                    style={pageBtn(offset === 0)}>Newer</button>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                    {offset + 1}–{Math.min(offset + PAGE, day.page.count)} of {day.page.count}
                  </span>
                  <button disabled={offset + PAGE >= day.page.count} onClick={() => setOffset(offset + PAGE)}
                    style={pageBtn(offset + PAGE >= day.page.count)}>Older</button>
                </div>
              )}
            </section>

            {/* ── how the money arrived ────────────────────────────────── */}
            {day.tender.length > 0 && t && (
              <section style={{ marginTop: 18 }}>
                <Head>How the money arrived</Head>
                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                  {day.tender.map((x) => (
                    <div key={x.method} style={{ padding: '9px 13px', borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--line-soft)', minWidth: 128 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                        {(METHOD_LABEL[x.method] ?? x.method).toUpperCase()}
                      </div>
                      <div style={{ marginTop: 2, fontSize: 15, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(x.amount)}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {x.count} ticket{x.count === 1 ? '' : 's'}{x.tip > 0 && ' · tips ' + mvr(x.tip)}
                      </div>
                    </div>
                  ))}
                </div>
                {/* The day's own invariant, shown rather than asserted: what was
                    taken has to equal what was billed. */}
                <p style={{ margin: '8px 2px 0', fontSize: 10.5, color: 'var(--text-faint)' }}>
                  Taken {mvr(day.tender.reduce((a, x) => a + x.amount, 0))} · billed {mvr(t.total)}
                  {day.tender.reduce((a, x) => a + x.amount, 0).toFixed(2) !== t.total.toFixed(2)
                    && ' — these disagree, which should not be possible.'}
                </p>
              </section>
            )}
          </>
        )}
      </div>

      {receipt && <ReceiptSheet r={receipt} rank={session.rank} onClose={() => setReceipt(null)} />}
    </div>
  );
}

/* ── one receipt, and everything it caused ──────────────────────────────── */

function ReceiptSheet({ r, rank, onClose }: { r: Receipt; rank: number; onClose: () => void }) {
  const [tab, setTab] = useState<'receipt' | 'journal' | 'stock' | 'trail'>('receipt');
  const s = r.sale;
  const voidedLines = r.ticketLines.filter((l) => l.voided);

  return (
    <Sheet title={s.receiptNo} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, paddingBottom: 11, borderBottom: '1px solid var(--line-soft)' }}>
        <span>
          <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>TOTAL</span>
          <span style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{mvr(s.total)}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ textAlign: 'right', fontSize: 10.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
          {s.table ? 'Table ' + s.table : s.channel.replace('_', ' ')} · {s.covers} cover{s.covers === 1 ? '' : 's'}
          <span style={{ display: 'block' }}>
            {new Date(s.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
          <span style={{ display: 'block' }}>
            {[s.server && 'served by ' + s.server, s.closedBy && 'closed by ' + s.closedBy]
              .filter(Boolean).join(' · ')}
          </span>
        </span>
      </div>

      {s.mismatch && (
        <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 8, background: 'var(--warn-dim)', color: 'var(--warn-bright)', fontSize: 11.5, lineHeight: 1.55 }}>
          The till computed {mvr(s.clientTotal)} for this bill; the server computed {mvr(s.total)}.
          The server&apos;s figure is what was banked and what the accounts hold. The
          difference is recorded against this receipt so the terminal can be found.
        </div>
      )}

      <div style={{ margin: '12px 0 4px', display: 'flex', gap: 4 }}>
        <Tab on={tab === 'receipt'} onClick={() => setTab('receipt')}>Receipt</Tab>
        <Tab on={tab === 'journal'} onClick={() => setTab('journal')}>Journal</Tab>
        <Tab on={tab === 'stock'} onClick={() => setTab('stock')}>Stock</Tab>
        <Tab on={tab === 'trail'} onClick={() => setTab('trail')}>Trail</Tab>
      </div>

      {tab === 'receipt' && (
        <div>
          {r.lines.map((l) => (
            <Row key={l.id}
              main={l.name}
              sub={l.qty + ' × ' + mvr(l.unitPrice) + (l.lineCost !== null ? ' · cost ' + mvr(l.lineCost) : '')}
              amount={mvr(l.lineTotal)} />
          ))}

          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)' }}>
            <Total label="Subtotal, net of GST" value={mvr(s.gross)} />
            {s.discount > 0 && (
              <Total label={'Discount' + (s.discountReason ? ' — ' + s.discountReason : '')} value={'−' + mvr(s.discount)} />
            )}
            {s.service > 0 && <Total label="Service charge" value={mvr(s.service)} />}
            <Total label={s.taxCode + ' at ' + s.taxRate + '%'} value={mvr(s.tax)} />
            {s.rounding !== 0 && <Total label="Cash rounding" value={mvr(s.rounding)} />}
            <Total label="Total" value={mvr(s.total)} strong />
          </div>

          {/* Prices on the menu are GST-inclusive and the tax is EXTRACTED from
              them. Said on the receipt, because a guest asking "was GST added on
              top?" deserves the answer from the document itself. */}
          <p style={{ margin: '7px 2px 0', fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Menu prices include {s.taxCode}. The tax above is the part of the price that is
            {' '}{s.taxCode}, not an amount added to it.
          </p>

          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
            <SubHead>Tender</SubHead>
            {r.payments.map((p) => (
              <Row key={p.id}
                main={METHOD_LABEL[p.method] ?? p.method}
                sub={[
                  p.tendered !== null ? 'given ' + mvr(p.tendered) : null,
                  p.change ? 'change ' + mvr(p.change) : null,
                  p.tip ? 'tip ' + mvr(p.tip) : null,
                  p.ref, p.takenBy ? 'taken by ' + p.takenBy : null,
                ].filter(Boolean).join(' · ')}
                amount={mvr(p.amount)} />
            ))}
          </div>

          {voidedLines.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
              <SubHead>Struck off before payment</SubHead>
              {voidedLines.map((l) => (
                <Row key={l.id}
                  main={l.name}
                  sub={(l.voidReason || 'no reason given') + (l.voidBy ? ' · ' + l.voidBy : '')}
                  amount={mvr(l.qty * l.unitPrice)} muted />
              ))}
              <p style={{ margin: '6px 2px 0', fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                Not charged. Kept so &ldquo;we were charged for something we sent back&rdquo; can
                be answered from the receipt.
              </p>
            </div>
          )}
        </div>
      )}

      {tab === 'journal' && (
        r.journal ? (
          <div>
            <SubHead>{r.journal.jvNo} — {r.journal.memo}</SubHead>
            <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ flex: 1 }}>ACCOUNT</span>
              <span style={{ width: 88, textAlign: 'right' }}>DEBIT</span>
              <span style={{ width: 88, textAlign: 'right' }}>CREDIT</span>
            </div>
            {r.journal.lines.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>
                  <b style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-dim)' }}>{l.account}</b>
                  {' '}{l.name ?? ''}
                </span>
                <span style={{ width: 88, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: l.dr ? 'var(--text)' : 'var(--text-faint)' }}>{l.dr ? mvr(l.dr) : '—'}</span>
                <span style={{ width: 88, textAlign: 'right', fontSize: 12, fontFamily: MONO, color: l.cr ? 'var(--text)' : 'var(--text-faint)' }}>{l.cr ? mvr(l.cr) : '—'}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, padding: '8px 0', fontWeight: 700 }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)' }}>
                {r.journal.partial ? 'Shown to you' : 'Balance'}
              </span>
              <span style={{ width: 88, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(r.journal.lines.reduce((a, l) => a + l.dr, 0))}
              </span>
              <span style={{ width: 88, textAlign: 'right', fontSize: 12.5, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(r.journal.lines.reduce((a, l) => a + l.cr, 0))}
              </span>
            </div>
            {r.journal.partial && (
              <Withheld>
                The cost-of-sales and inventory entries are not shown at your rank, so these two
                columns will not agree here. The posted entry balances.
              </Withheld>
            )}
          </div>
        ) : <Empty>This sale posted no journal, which should not happen.</Empty>
      )}

      {tab === 'stock' && (
        r.stock.length ? (
          <div>
            <SubHead>What it took out of the store</SubHead>
            {r.stock.map((m) => (
              <Row key={m.ingredientId}
                main={m.name ?? m.ingredientId}
                sub={m.value !== null ? 'at ' + mvr(m.value) : 'quantity only'}
                amount={m.qty.toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' ' + (m.unit ?? '')} />
            ))}
            {rank >= 3 && s.cogs !== null && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)' }}>
                <Total label="Cost of what was sold" value={mvr(s.cogs)} strong />
                <Total label="Gross margin"
                  value={mvr(s.gross - s.cogs) + '  ·  ' + (s.gross ? Math.round(((s.gross - s.cogs) / s.gross) * 100) : 0) + '%'} />
              </div>
            )}
            {rank < 3 && <Withheld>Cost and margin are not shown at your rank.</Withheld>}
          </div>
        ) : <Empty>Nothing on this ticket has a recipe, so no stock moved.</Empty>
      )}

      {tab === 'trail' && (
        !r.auditVisible ? (
          <Withheld>The audit trail is shown to managers and above. It exists — it is not being shown to you.</Withheld>
        ) : !r.audit || !r.audit.length ? (
          <Empty>Nothing was recorded against this ticket.</Empty>
        ) : (
          <div>
            {r.audit.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ width: 52, fontSize: 10.5, fontFamily: MONO, color: 'var(--text-faint)' }}>{time(a.at)}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: a.action === 'sale_total_mismatch' ? 'var(--warn-bright)' : 'var(--text)' }}>
                    {ACTION_LABEL[a.action] ?? a.action}
                  </span>
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>
                    {a.actor ?? 'system'}{a.rank ? ' · rank ' + a.rank : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </Sheet>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const pageBtn = (off: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600,
  background: 'var(--bg-2)', border: '1px solid var(--line)',
  color: off ? 'var(--text-faint)' : 'var(--text-muted)',
});

function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span style={{ textAlign: 'right' }}>
      <span style={{ display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: strong ? 15 : 12.5, fontWeight: 700, fontFamily: MONO, color: strong ? 'var(--text)' : 'var(--text-dim)' }}>{value}</span>
    </span>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: '0 2px 8px', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>{children}</div>;
}
/* textTransform, NOT String(children).toUpperCase(). A React node is not a
   string: given `{a} — {b}` the JS version stringified the ARRAY and rendered
   "MAL-01-JV-000003, — ,Sale …", commas and all. */
function SubHead({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: '0 0 6px', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '26px 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>{children}</div>;
}
function Withheld({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

function Row({ main, sub, amount, muted }: { main: string; sub?: string; amount: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: muted ? 'var(--text-faint)' : 'var(--text)', textDecoration: muted ? 'line-through' : 'none' }}>{main}</span>
        {sub && <span style={{ display: 'block', marginTop: 2, fontSize: 10, color: 'var(--text-faint)' }}>{sub}</span>}
      </span>
      <span style={{ fontSize: 12.5, fontFamily: MONO, color: muted ? 'var(--text-faint)' : 'var(--text-dim)' }}>{amount}</span>
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0' }}>
      <span style={{ flex: 1, fontSize: strong ? 12.5 : 11.5, fontWeight: strong ? 700 : 400, color: strong ? 'var(--text)' : 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: strong ? 14 : 12, fontWeight: strong ? 700 : 400, fontFamily: MONO, color: strong ? 'var(--text)' : 'var(--text-dim)' }}>{value}</span>
    </div>
  );
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: on ? 700 : 600,
      background: on ? 'var(--bg-2)' : 'transparent',
      border: '1px solid ' + (on ? 'var(--line)' : 'transparent'),
      color: on ? 'var(--text)' : 'var(--text-faint)',
    }}>{children}</button>
  );
}

function Tag({ tone, children }: { tone: 'red' | 'warn'; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700,
      background: tone === 'red' ? 'var(--red-dim)' : 'var(--warn-dim)',
      color: tone === 'red' ? 'var(--red-bright)' : 'var(--warn-bright)',
    }}>{children}</span>
  );
}

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}
        style={{ width: '100%', maxWidth: 560, maxHeight: '86dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{title}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}
