import { useMemo, useState } from 'react';
import type { Item, Session, Snapshot } from './api';
import * as outbox from './outbox';
import { Payment } from './Payment';
/* One bill calculation, shared with the server. See packages/money/money.js —
   Node requires it, the browsers bundle it, and neither has a copy. */
import { priceBill } from '../../../packages/money/money.js';
import { Register } from './Register';

/* POS Floor — 02-POS-SPEC.md §3.
 *
 * Three columns on desktop: zones + tables → menu → ticket. Every colour, size
 * and weight below is from the prototype and §3's own measurements.
 *
 * WHAT THE TICKET IS. A local basket, held in component state, that becomes a
 * `sale` operation in the outbox when it is paid. It is deliberately NOT a
 * server round-trip per line: a cashier ringing a burger must not wait for a
 * network, and on a dropped connection they must not be stopped at all.
 */

const MONO = "'JetBrains Mono',monospace";
const toLaari = (mvr: string) => Math.round(Number(mvr) * 100);
const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface Line { itemId: string; name: string; qty: number; unitPrice: number }

interface Props {
  snap: Snapshot | null;
  now: Date;
  session: Session;
  /* The house tender is offered only online — see Payment.tsx. A charge queued
     offline could be refused on replay long after the guest has gone. */
  online: boolean;
  onQueued: () => void | Promise<void>;
}

export function Floor({ snap, now, session, online, onQueued }: Props) {
  const [table, setTable] = useState<string>('');
  const [lines, setLines] = useState<Line[]>([]);
  /* What a promotion takes off, once the payment screen has had the server
     confirm it. Held here because it changes the BILL, not just the tender. */
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoCode, setPromoCode] = useState<string | undefined>();
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [paying, setPaying] = useState(false);
  const [flash, setFlash] = useState('');
  /* §3.3's two foot actions are Send and Pay, and they are different things. A
     round goes to the kitchen the moment it is ordered; the bill is settled
     when the guest leaves. `sentIds` remembers what has already been fired so
     a second Send only carries what was added since — not the whole ticket
     again, which would cook everything twice. */
  const [sentIds, setSentIds] = useState<Record<string, number>>({});

  const items = snap?.items ?? [];
  const outlet = snap?.outlet ?? null;
  const tableCount = outlet?.tables ?? 0;

  const cats = useMemo(() => {
    const out: string[] = [];
    for (const it of items) {
      const c = it.category || 'Other';
      if (!out.includes(c)) out.push(c);
    }
    return out;
  }, [items]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (cat !== 'all' && (it.category || 'Other') !== cat) return false;
      if (!needle) return true;
      return it.name.toLowerCase().includes(needle);
    });
  }, [items, cat, q]);

  /* Which tables are busy, from the till's own open tickets. Free/Seated is
     derived from the server's state, never from a counter this screen keeps —
     two terminals are looking at the same floor. */
  const openByTable = useMemo(() => {
    const m = new Map<string, { covers: number }>();
    for (const t of snap?.tickets ?? []) {
      if (t.table_no) m.set(String(t.table_no), { covers: t.covers });
    }
    return m;
  }, [snap]);

  const add = (it: Item) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.itemId === it.id);
      if (i >= 0) {
        const next = ls.slice();
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return next;
      }
      return ls.concat([{ itemId: it.id, name: it.name, qty: 1, unitPrice: toLaari(it.price) }]);
    });
  };

  const step = (itemId: string, d: number) =>
    setLines((ls) => ls
      .map((l) => (l.itemId === itemId ? { ...l, qty: l.qty + d } : l))
      .filter((l) => l.qty > 0));

  const servicePct = Number(outlet?.service_pct ?? 0);
  const taxRate = Number(snap?.tax?.rate ?? 0);
  const taxCode = snap?.tax?.code ?? 'GST';

  /* THE SAME CALCULATION THE SERVER USES, imported rather than rewritten.
     These four lines used to be a hand-written second implementation: goods,
     service, and a tax extraction, with no discount, no fee and no cash
     rounding in it at all. It agreed with the server on a simple bill and
     would have disagreed the moment a promotion came off one — which is
     exactly how a till and a ledger drift, quietly, each satisfying its own
     invariant. packages/money's own header always said "the browsers load it
     as a script"; now they do. */
  const bill = priceBill({
    lines: lines.map((l) => ({ unitPrice: l.unitPrice, qty: l.qty })),
    discount: promoDiscount,
    servicePct, taxRate,
  });
  const goods = bill.gross;
  const service = bill.service;
  const tax = bill.tax;
  const total = bill.total;

  /* Fire the unsent part of the ticket. Queued like everything else, so a
     server on a dead connection still gets the food to the kitchen the moment
     the network returns — and the kitchen never waits on the card machine. */
  const unsent = lines
    .map((l) => ({ ...l, qty: l.qty - (sentIds[l.itemId] ?? 0) }))
    .filter((l) => l.qty > 0);

  const send = async () => {
    if (!unsent.length) return;
    await outbox.enqueue('ticket_send', {
      table,
      covers: openByTable.get(table)?.covers ?? 1,
      channel: table === 'Takeaway' ? 'takeaway' : table === 'Delivery' ? 'delivery' : 'dine_in',
      lines: unsent.map((l) => ({ itemId: l.itemId, qty: l.qty })),
    });
    const next = { ...sentIds };
    for (const l of lines) next[l.itemId] = l.qty;
    setSentIds(next);
    setFlash(unsent.reduce((a, l) => a + l.qty, 0) + ' to the kitchen');
    setTimeout(() => setFlash(''), 2600);
    await onQueued();
  };

  const settled = async (payments: { method: string; amount: number }[],
    memberId?: string, code?: string) => {
    /* One `sale` operation, queued locally. It carries what only the till knows
       — which items, how many, which table, which tender — and nothing about
       what they cost: the server prices it from the item master and the tax
       version in force on the business date. */
    await outbox.enqueue('sale', {
      businessDate: new Date().toISOString().slice(0, 10),
      channel: table === 'Takeaway' ? 'takeaway' : table === 'Delivery' ? 'delivery' : 'dine_in',
      covers: openByTable.get(table)?.covers ?? 1,
      lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
      payments: payments.map((p) => ({ method: p.method, amount: (p.amount / 100).toFixed(2) })),
      /* Whose account, when the tender is one. The server checks the limit
         again — it is the authority — but it cannot check it against nobody. */
      memberId,
      /* The code, not the amount. The server evaluates it again and derives
         what it is worth — a till that named its own discount is the hole this
         closed. */
      promoCode: code,
      clientTotal: (total / 100).toFixed(2),
    });
    setPaying(false);
    setLines([]);
    setSentIds({});
    setPromoDiscount(0);
    setPromoCode(undefined);
    setFlash('Sale queued — ' + money(total));
    setTimeout(() => setFlash(''), 2600);
    await onQueued();
  };

  const TILE = (label: string, busy: boolean, key: string) => (
    <button
      key={key}
      onClick={() => { setTable(label); setLines([]); setSentIds({}); }}
      style={{
        padding: '10px 9px', borderRadius: 9, minHeight: 62, textAlign: 'left',
        background: table === label ? 'var(--bg-3)' : busy ? 'var(--amber-dim)' : 'var(--bg-1)',
        border: '1px solid ' + (table === label ? 'var(--amber-line)' : busy ? 'var(--amber-line)' : 'var(--line)'),
      }}
    >
      <span style={{ display: 'block', fontSize: 20, fontWeight: 700, letterSpacing: '-.03em', fontFamily: MONO, color: busy ? 'var(--amber-bright)' : 'var(--text)' }}>
        {label}
      </span>
      <span style={{ display: 'block', marginTop: 3, fontSize: 9.5, color: 'var(--text-faint)' }}>
        {busy ? (openByTable.get(label)?.covers ?? 1) + ' covers' : 'Free'}
      </span>
    </button>
  );

  return (
    <div style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      {/* ── Column 1: floor plan (§3.1) ─────────────────────────────────── */}
      <section style={{ width: 250, flexShrink: 0, borderRight: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '11px 12px 8px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
          FLOOR
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignContent: 'start' }}>
          {/* §3.1: "Two non-table slots always exist: Takeaway and Delivery." */}
          {TILE('Takeaway', false, 'tk')}
          {TILE('Delivery', false, 'dl')}
          {Array.from({ length: tableCount }, (_, i) => i + 1).map((n) => {
            const label = 'T' + (n < 10 ? '0' + n : n);
            return TILE(label, openByTable.has(label) || openByTable.has(String(n)), label);
          })}
          {!tableCount && (
            <div style={{ gridColumn: '1/-1', padding: '20px 4px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
              This outlet has no tables configured. Set the table count on the outlet
              record and they appear here.
            </div>
          )}
        </div>

        {/* The drawer lives here, under the tables, because this is where the
            cashier is standing when the shift ends. */}
        <Register session={session} onQueued={onQueued} />
      </section>

      {/* ── Column 2: menu grid (§3.2) ──────────────────────────────────── */}
      <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--line-soft)' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search dishes"
            aria-label="Search dishes"
            style={{
              flex: 1, height: 32, padding: '0 11px', borderRadius: 7,
              background: 'var(--bg-2)', border: '1px solid var(--line)',
              color: 'var(--text)', fontSize: 12.5,
            }}
          />
        </div>

        <div className="krail" style={{ flexShrink: 0, display: 'flex', gap: 6, padding: '9px 12px', overflowX: 'auto' }}>
          {[{ id: 'all', name: 'All' }, ...cats.map((c) => ({ id: c, name: c }))].map((c) => {
            const on = cat === c.id;
            return (
              <button key={c.id} onClick={() => setCat(c.id)}
                style={{
                  flexShrink: 0, padding: '6px 12px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
                  whiteSpace: 'nowrap',
                  background: on ? 'var(--amber)' : 'var(--bg-2)',
                  color: on ? 'var(--on-amber)' : 'var(--text-muted)',
                  border: '1px solid ' + (on ? 'var(--amber)' : 'var(--line)'),
                }}>{c.name}</button>
            );
          })}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(148px,1fr))', gap: 9, alignContent: 'start' }}>
          {shown.map((it) => (
            <button
              key={it.id}
              onClick={() => add(it)}
              disabled={!table}
              title={table ? undefined : 'Choose a table first'}
              style={{
                padding: 11, borderRadius: 9, minHeight: 74, textAlign: 'left',
                background: 'var(--bg-1)', border: '1px solid var(--line)',
                opacity: table ? 1 : .45,
                // §3.2: "Off-menu dishes are visibly struck, not hidden."
                textDecoration: it.off_menu ? 'line-through' : 'none',
              }}
            >
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>
                {it.name}
              </span>
              <span style={{ display: 'block', marginTop: 7, fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>
                {money(toLaari(it.price))}
              </span>
            </button>
          ))}
          {!shown.length && (
            <div style={{ gridColumn: '1/-1', padding: '32px 6px', textAlign: 'center', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)' }}>
              {!snap ? 'Loading the menu…'
                : items.length === 0
                  ? 'No dishes yet. Add them in Menu Master and they appear here.'
                  : 'Nothing matches that search.'}
            </div>
          )}
        </div>
      </section>

      {/* ── Column 3: ticket (§3.3) ─────────────────────────────────────── */}
      <section style={{ width: 300, flexShrink: 0, borderLeft: '1px solid var(--line-soft)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '11px 13px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, letterSpacing: '-.02em', color: table ? 'var(--amber-bright)' : 'var(--text-faint)' }}>
            {table || 'No table'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9.5, color: 'var(--text-faint)', fontFamily: MONO }}>
            {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 13px' }}>
          {lines.map((l) => (
            <div key={l.itemId} style={{ padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{l.name}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                  {money(l.unitPrice * l.qty)}
                </span>
              </div>
              <div style={{ marginTop: 7, display: 'inline-flex', alignItems: 'center', gap: 0, borderRadius: 6, background: 'var(--bg-2)', overflow: 'hidden' }}>
                <button onClick={() => step(l.itemId, -1)} aria-label={'One less ' + l.name}
                  style={{ width: 26, height: 24, color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>−</button>
                <span style={{ minWidth: 26, textAlign: 'center', fontSize: 12, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{l.qty}</span>
                <button onClick={() => step(l.itemId, 1)} aria-label={'One more ' + l.name}
                  style={{ width: 26, height: 24, color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>+</button>
              </div>
            </div>
          ))}
          {!lines.length && (
            <div style={{ padding: '30px 4px', textAlign: 'center', fontSize: 11.5, lineHeight: 1.65, color: 'var(--text-faint)' }}>
              {table
                ? 'Nothing on this ticket yet. Tap a dish to add it.'
                : 'Choose a table, then tap dishes to build the ticket.'}
            </div>
          )}
        </div>

        {/* Foot: subtotal, service, tax, total, then Pay. §3.3 */}
        <div style={{ flexShrink: 0, borderTop: '1px solid var(--line)', padding: 13 }}>
          <Row label="Subtotal" value={money(goods)} />
          {/* Without this line the footer does not add up on screen: subtotal
              is the goods BEFORE the discount, while service and the total are
              after it. A cashier reading four figures that do not reconcile
              stops trusting all four. */}
          {bill.discount > 0 && (
            <Row label={'Discount' + (promoCode ? ' — ' + promoCode : '')}
              value={'−' + money(bill.discount)} />
          )}
          {servicePct > 0 && <Row label={'Service ' + servicePct + '%'} value={money(service)} />}
          {taxRate > 0 && <Row label={taxCode + ' ' + taxRate + '% (incl.)'} value={money(tax)} muted />}
          <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Total</span>
            <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>{money(total)}</span>
          </div>

          {flash && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 7, background: 'var(--go-dim)', color: 'var(--go-bright)', fontSize: 11.5, fontWeight: 600 }}>
              {flash}
            </div>
          )}

          {/* §3.3: "Then Send (to kitchen) and Pay." */}
          <div style={{ marginTop: 11, display: 'flex', gap: 8 }}>
            <button
              onClick={() => void send()}
              disabled={!unsent.length}
              style={{
                flex: 1, minHeight: 44, borderRadius: 9,
                background: unsent.length ? 'var(--bg-3)' : 'var(--bg-2)',
                border: '1px solid ' + (unsent.length ? 'var(--amber-line)' : 'var(--line)'),
                color: unsent.length ? 'var(--amber-bright)' : 'var(--text-faint)',
                fontSize: 13.5, fontWeight: 700, textAlign: 'center',
              }}
            >{unsent.length ? 'Send ' + unsent.reduce((a, l) => a + l.qty, 0) : 'Sent'}</button>
            <button
              onClick={() => setPaying(true)}
              disabled={!lines.length}
              style={{
                flex: 1, minHeight: 44, borderRadius: 9,
                background: lines.length ? 'var(--amber)' : 'var(--bg-2)',
                color: lines.length ? 'var(--on-amber)' : 'var(--text-faint)',
                fontSize: 13.5, fontWeight: 700, textAlign: 'center',
              }}
            >Pay</button>
          </div>
        </div>
      </section>

      {paying && (
        <Payment
          total={total}
          goods={lines.reduce((a, l) => a + l.unitPrice * l.qty, 0)}
          session={session}
          online={online}
          promoCode={promoCode}
          onPromo={(code, discount) => { setPromoCode(code); setPromoDiscount(discount); }}
          onCancel={() => setPaying(false)}
          onConfirm={settled}
        />
      )}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 5 }}>
      <span style={{ fontSize: 11.5, color: muted ? 'var(--text-faint)' : 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: MONO, color: muted ? 'var(--text-faint)' : 'var(--text-dim)' }}>{value}</span>
    </div>
  );
}
