import { useEffect, useMemo, useState } from 'react';
import type { Item, Session, Snapshot } from './api';
import * as outbox from './outbox';
import { Payment } from './Payment';
/* One bill calculation, shared with the server. See packages/money/money.js —
   Node requires it, the browsers bundle it, and neither has a copy. */
import { priceBill } from '../../../packages/money/money.js';
import { Register } from './Register';
import { useIntent } from './intent';
import type { Intent } from './intent';
import { useBreakpoint } from './useBreakpoint';

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
  intent?: Intent | null;
  onIntentDone?: () => void;
}

export function Floor({ snap, now, session, online, onQueued, intent, onIntentDone }: Props) {
  /* THE TILL ON A PHONE IS A DIFFERENT MACHINE, and the prototype treats it as
     one. Three columns — 250px of tables, the menu, 300px of ticket — need 550px
     of fixed width before the menu gets a pixel, so on a 390px handset they do
     not merely look cramped, they cannot be laid out at all.

     So the phone shows ONE pane at a time and puts the ticket in a bottom
     sheet, with the three destinations on a bar under the thumb. The
     prototype's note on why: the POS destinations used to live in a tab strip
     in the top-right corner — the furthest point from a thumb on a phone held
     one-handed, and the hardest thing to hit during service. */
  const bp = useBreakpoint();
  const isPhone = bp === 'm';
  const isTablet = bp === 't';
  /* One pane at a time below the desktop: a phone has no room for two, and a
     tablet's third column was eating the menu. */
  const onePane = isPhone || isTablet;
  const [pane, setPane] = useState<'floor' | 'menu'>('floor');

  const [cart, setCart] = useState(false);
  const [table, setTable] = useState<string>('');
  /* WHICH BILL ON THIS TABLE. 0 is the table's own; 1.. are guests who asked to
     pay separately. `ticket.split` has been in the schema since the first
     migration and every write put a literal 0 in it, so a party splitting the
     bill had to be handled on paper. */
  const [split, setSplit] = useState(0);
  /* What has been keyed but not yet fired. The lines the kitchen already has
     live on the SERVER's ticket and are read from the snapshot — this is only
     the part that has not left the till. */
  const [draft, setDraft] = useState<Line[]>([]);
  /* What a promotion takes off, once the payment screen has had the server
     confirm it. Held here because it changes the BILL, not just the tender. */
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoCode, setPromoCode] = useState<string | undefined>();
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  /* THE BILL AS IT STOOD WHEN PAY WAS PRESSED.
     Not a boolean, and this is the point. The payment modal used to read the
     live ticket at CONFIRM time, seconds or minutes after it opened, while the
     snapshot kept refreshing underneath it. If anything emptied the ticket in
     that window — another terminal settling the same table is the ordinary
     case — the till sent a sale with no lines and the server refused it with
     "a sale needs at least one line", which no cashier could act on and which
     nothing on the screen explained.
     It is also the correct semantics regardless of races: the bill somebody is
     being asked to pay is the bill they were shown, not whatever the ticket
     happens to say by the time they hand over a card. */
  const [paying, setPaying] = useState<{
    lines: Line[]; total: number; goods: number; ticketId: string | undefined;
  } | null>(null);
  const [flash, setFlash] = useState('');
  /* §3.3's two foot actions are Send and Pay, and they are different things: a
     round goes to the kitchen the moment it is ordered, the bill is settled
     when the guest leaves.
     A round that has been FIRED but whose ticket has not come back yet — the
     normal case on a bad connection, and every case offline — is held here so
     it stays on the bill in front of the cashier. Each entry remembers the
     server quantity at the moment it was fired, so it can be retired when the
     snapshot has genuinely caught up rather than when it merely looks similar. */
  const [firing, setFiring] = useState<Array<Line & { baseline: number }>>([]);
  /* The line being voided, and the reason being typed for it. */
  const [voiding, setVoiding] = useState<{ id: string; name: string } | null>(null);
  const [voidWhy, setVoidWhy] = useState('');
  /* Clearing the whole bill: null when nobody is asking, otherwise the reason
     being typed for it. */
  const [clearing, setClearing] = useState(false);
  const [clearWhy, setClearWhy] = useState('');

  /* The drawer lives at the foot of the FLOOR pane, and on a phone only one
     pane is on screen. Arriving on the menu pane, "Close the register" would
     open a form the operator cannot see. The intent itself is Register's to
     consume — this only makes sure the pane holding it is the one showing. */
  useIntent(intent, 'pos', (act) => {
    if (act === 'regclose') setPane('floor');
    /* "Open it at the till" from the Orders board. That screen is where
       somebody notices a tab that has been open too long, and until this the
       only thing they could do about it was come here and find the table by
       eye — on a busy floor, the tab most worth chasing is the one hardest to
       spot. */
    if (act.startsWith('open:')) {
      const [, t, sp] = act.split(':');
      if (t) { setTable(tableName(t)); setSplit(Number(sp) || 0); setPane('menu'); setCart(true); }
    }
  }, () => { /* Register clears it — this is a second reader of the same one-shot. */ });

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
  /* OPEN ONLY. The snapshot also carries tickets that are settled but still
     have food on the pass, so the kitchen keeps its card — a table whose party
     has paid and gone is not busy, and shading it would be the same "the table
     never frees" bug in a new place. */
  const openTickets = useMemo(
    () => (snap?.tickets ?? []).filter((t) => t.status === 'open'), [snap]);

  const openByTable = useMemo(() => {
    const m = new Map<string, { covers: number }>();
    for (const t of openTickets) {
      if (t.table_no) m.set(tableName(t.table_no), { covers: t.covers });
    }
    return m;
  }, [openTickets]);

  /* Every open bill on the table being worked, in split order. This is what the
     guest chips are drawn from, and it is the server's answer rather than a
     count this screen keeps: two terminals are looking at the same table. */
  const billsHere = useMemo(
    () => openTickets
      .filter((t) => tableName(t.table_no ?? '') === tableName(table))
      .slice()
      .sort((a, b) => a.split - b.split),
    [openTickets, table]);

  /* Open bills on tables the numbered grid does not draw. Takeaway and
     Delivery have their own tiles, so they are not strays. */
  const strays = useMemo(() => {
    const drawn = new Set(['Takeaway', 'Delivery']);
    for (let n = 1; n <= tableCount; n++) drawn.add(tableName(String(n)));
    return [...openByTable.keys()].filter((k) => !drawn.has(k)).sort();
  }, [openByTable, tableCount]);

  /* The open ticket for the bill being worked, if there is one.
     THE WHOLE POINT OF THIS SCREEN HAVING AN ID. Without it the ticket panel
     was a local scratchpad: a reload emptied it while the server still held the
     round, a second terminal could not take the table over, a round accepted
     from a guest's phone never appeared in front of the cashier, and settling
     could not close the ticket it had just been paid for — so the table stayed
     shaded busy and the same meal sat on the Orders board twice, once as an
     unsettled tab and once as a receipt. */
  const ticket = useMemo(
    () => billsHere.find((t) => t.split === split) ?? null,
    [billsHere, split]);

  /* The lines the kitchen has, from the ticket itself. Every ticket_line is
     created already sent (see kitchen.sendRound), so what is on the server IS
     what has been fired. */
  const sentLines = ticket?.lines ?? [];

  /* Retire a fired round once the ticket it was fired onto has caught up.
     Compared against the baseline captured at fire time, not against zero: two
     espressos fired onto a ticket that already had two must wait for four. */
  useEffect(() => {
    if (!firing.length) return;
    const have = new Map<string, number>();
    for (const l of sentLines) {
      const id = l.itemId ?? l.name;
      have.set(id, (have.get(id) ?? 0) + Number(l.qty));
    }
    const still = firing.filter((f) => (have.get(f.itemId) ?? 0) < f.baseline + f.qty);
    if (still.length !== firing.length) setFiring(still);
  }, [sentLines, firing]);

  /* Changing table or guest starts a different bill. The draft belongs to the
     bill it was keyed against and must not follow the cashier to the next one. */
  useEffect(() => { setDraft([]); setFiring([]); setVoiding(null); }, [table, split]);

  const add = (it: Item) => {
    setDraft((ls) => {
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
    setDraft((ls) => ls
      .map((l) => (l.itemId === itemId ? { ...l, qty: l.qty + d } : l))
      .filter((l) => l.qty > 0));

  /* Taking a line off a bill the kitchen already has. Not a delete — a void
     with a reason, which stays on the ticket and prints in the receipt's own
     voided-lines section. The server refuses one below manager rank. */
  const voidLine = async () => {
    if (!voiding || voidWhy.trim().length < 3) return;
    await outbox.enqueue('ticket_line_void', { lineId: voiding.id, reason: voidWhy.trim() });
    setVoiding(null); setVoidWhy('');
    setFlash('Taken off the bill');
    setTimeout(() => setFlash(''), 2600);
    await onQueued();
  };

  /* Giving the table back without a sale.
     A ticket with nothing on it — seated from the reservations book, or every
     line voided — could not be settled by anybody: Pay is disabled with no
     lines and the server rightly refuses a sale with none, so the table stayed
     shaded busy for the rest of the service. */
  const clearBill = async () => {
    if (!ticket) return;
    if (onKitchen.length > 0 && clearWhy.trim().length < 3) return;
    await outbox.enqueue('ticket_void', {
      ticketId: ticket.id,
      ...(clearWhy.trim() ? { reason: clearWhy.trim() } : {}),
    });
    setClearing(false); setClearWhy('');
    setDraft([]); setFiring([]); setSplit(0);
    setFlash(onKitchen.length ? 'Bill written off' : 'Table given back');
    setTimeout(() => setFlash(''), 2600);
    await onQueued();
  };

  /* Opening a guest their own bill. Nothing is written until the first round is
     fired or the first payment taken — an empty split is a promise, not a row. */
  /* The chips: every open bill on this table, plus the one being keyed if it
     has no server ticket yet. A guest who has been given their own bill but
     whose first round is still in the cashier's hands must still be on the row
     — otherwise pressing "+ Guest" appears to do nothing at all. */
  const guestBills = useMemo(() => {
    const out = billsHere.map((t) => ({
      split: t.split,
      open: true,
      value: t.lines.reduce((a, l) => a + toLaari(l.price) * Number(l.qty), 0),
    }));
    if (!out.some((g) => g.split === split)) out.push({ split, open: false, value: 0 });
    return out.sort((a, b) => a.split - b.split);
  }, [billsHere, split]);

  const addGuest = () => {
    const next = billsHere.reduce((m, t) => Math.max(m, t.split), 0) + 1;
    setSplit(Math.max(next, split + 1));
    setDraft([]);
    setFlash('Guest ' + (Math.max(next, split + 1) + 1) + ' — new items go to their bill');
    setTimeout(() => setFlash(''), 2600);
  };

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
  /* WHAT IS ON THE BILL: what the kitchen has, what is queued to reach it, and
     what has only been keyed. Priced from the menu where the dish is still on
     it, and from the ticket where it is not — a dish taken off the board after
     it was ordered still has to be charged at the price the guest was quoted. */
  const priceOf = (itemId: string | undefined, fallback: string) => {
    const it = itemId ? items.find((i) => i.id === itemId) : undefined;
    return toLaari(it ? it.price : fallback);
  };
  const onKitchen: Line[] = sentLines.map((l, i) => ({
    itemId: l.itemId ?? ('srv' + i),
    name: l.name,
    qty: Number(l.qty),
    unitPrice: priceOf(l.itemId, l.price),
  }));
  const lines: Line[] = [...onKitchen, ...firing, ...draft];

  const bill = priceBill({
    lines: lines.map((l) => ({ unitPrice: l.unitPrice, qty: l.qty })),
    discount: promoDiscount,
    servicePct, taxRate,
  });
  const goods = bill.gross;
  const service = bill.service;
  const tax = bill.tax;
  const total = bill.total;

  /* Fire the keyed part of the ticket. Queued like everything else, so a
     server on a dead connection still gets the food to the kitchen the moment
     the network returns — and the kitchen never waits on the card machine. */
  const send = async () => {
    if (!draft.length) return;
    await outbox.enqueue('ticket_send', {
      table,
      split,
      covers: openByTable.get(table)?.covers ?? 1,
      channel: table === 'Takeaway' ? 'takeaway' : table === 'Delivery' ? 'delivery' : 'dine_in',
      lines: draft.map((l) => ({ itemId: l.itemId, qty: l.qty })),
    });
    /* Held on the bill against the quantity the ticket has NOW, so it survives
       the round trip — or the hours of it, offline — without being counted
       twice when the ticket comes back carrying it. */
    const have = new Map<string, number>();
    for (const l of sentLines) {
      const id = l.itemId ?? l.name;
      have.set(id, (have.get(id) ?? 0) + Number(l.qty));
    }
    setFiring((f) => f.concat(draft.map((l) => ({ ...l, baseline: have.get(l.itemId) ?? 0 }))));
    setDraft([]);
    setFlash(draft.reduce((a, l) => a + l.qty, 0) + ' to the kitchen');
    setTimeout(() => setFlash(''), 2600);
    await onQueued();
  };

  const settled = async (payments: { method: string; amount: number; ref?: string }[],
    memberId?: string, code?: string, voucherCode?: string) => {
    /* THE BILL CAPTURED WHEN PAY WAS PRESSED, never the live one. See the
       `paying` state above for why. */
    const bill = paying;
    if (!bill) return;
    if (!bill.lines.length) {
      /* Belt as well as braces. The server refuses a sale with no lines, and
         rightly, but it should never be asked to: an empty bill is something
         the till can see and say before a guest is left standing. */
      setFlash('Nothing on this bill to settle.');
      setTimeout(() => setFlash(''), 3200);
      setPaying(null);
      return;
    }
    /* One `sale` operation, queued locally. It carries what only the till knows
       — which items, how many, which table, which tender — and nothing about
       what they cost: the server prices it from the item master and the tax
       version in force on the business date. */
    await outbox.enqueue('sale', {
      businessDate: new Date().toISOString().slice(0, 10),
      channel: table === 'Takeaway' ? 'takeaway' : table === 'Delivery' ? 'delivery' : 'dine_in',
      covers: openByTable.get(table)?.covers ?? 1,
      /* WHICH TICKET THIS SETTLES. Without it the server had nothing to close,
         so a paid table stayed shaded busy and its tab stayed on the Orders
         board beside the receipt for the very same meal. */
      ticketId: bill.ticketId,
      lines: bill.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
      payments: payments.map((p) => ({
        method: p.method,
        amount: (p.amount / 100).toFixed(2),
        ...(p.ref ? { ref: p.ref } : {}),
      })),
      /* Whose account, when the tender is one. The server checks the limit
         again — it is the authority — but it cannot check it against nobody. */
      memberId,
      /* The code, not the amount. The server evaluates it again and derives
         what it is worth — a till that named its own discount is the hole this
         closed. */
      promoCode: code,
      /* Which voucher, when one is part of the tender. Checked and CLAIMED by
         the server after the sale exists, so a code that turns out to be spent
         stops the settlement instead of printing on a receipt. */
      voucherCode,
      /* THE TOTAL AS SETTLED, which is the sum of the tender — not this
         screen's figure. They differ whenever the bill rounded for cash, and
         `client_total` exists so a till that has genuinely drifted can be
         found; filling it with a number the till knew was superseded would
         report drift on every rounded sale and hide it on every real one. */
      clientTotal: (payments.reduce((a, x) => a + x.amount, 0) / 100).toFixed(2),
    });
    setPaying(null);
    setDraft([]);
    setFiring([]);
    /* Back to the table's own bill: the guest whose split this was has paid and
       gone, and leaving the cashier pointed at a closed split is how the next
       round gets keyed onto nothing. */
    setSplit(0);
    setPromoDiscount(0);
    setPromoCode(undefined);
    setFlash('Sale queued — ' + money(payments.reduce((a, x) => a + x.amount, 0)));
    setTimeout(() => setFlash(''), 2600);
    await onQueued();
  };

  /* The prototype's Floor/Menu switcher, to its own numbers. It exists there
     at every size: the prototype's till is ONE content pane plus a ticket, and
     this three-column arrangement is ours. On a tablet ours starved the menu —
     250px of tables and 300px of ticket leave 158px at 768px wide — so the
     tablet adopts the prototype's shape. The desktop has the room for three and
     keeps them. */
  const paneTabs = (
    <div style={{ display: 'flex', gap: 2, background: 'var(--bg-2)', borderRadius: 8, padding: 2, flexShrink: 0 }}>
      {(['floor', 'menu'] as const).map((k) => (
        <button
          key={k}
          onClick={() => setPane(k)}
          aria-current={pane === k ? 'page' : undefined}
          style={{
            padding: '6px 14px', borderRadius: 7, fontSize: 11.5,
            fontWeight: pane === k ? 700 : 600, whiteSpace: 'nowrap', minHeight: 30,
            background: pane === k ? 'var(--text)' : 'transparent',
            color: pane === k ? 'var(--bg)' : 'var(--text-dim)',
          }}
        >
          {k === 'floor' ? 'Floor' : 'Menu'}
        </button>
      ))}
    </div>
  );

  const TILE = (label: string, busy: boolean, key: string) => (
    <button
      key={key}
      onClick={() => {
        setTable(label); setSplit(0);
        /* On a phone the panes are one at a time, and choosing a table is the
           step before ordering — so it moves you on rather than leaving you
           looking at the tables you have just chosen from. */
        if (isPhone) setPane('menu');
      }}
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
    <div style={{ height: '100%', display: 'flex', minWidth: 0, position: 'relative' }}>
      {/* ── Column 1: floor plan (§3.1) ─────────────────────────────────── */}
      <section style={onePane
        ? { flex: 1, minWidth: 0, display: pane === 'floor' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }
        : { width: 250, flexShrink: 0, borderRight: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '11px 12px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
            FLOOR
          </span>
          <span style={{ flex: 1 }} />
          {isTablet && paneTabs}
        </div>
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          /* 92px of bottom padding on a phone, because the tab bar is fixed
             over this pane and the last row of tables would sit under it. */
          padding: isPhone ? '0 12px 92px' : '0 12px 12px',
          display: 'grid',
          gridTemplateColumns: onePane ? 'repeat(auto-fill,minmax(min(100%, 96px),1fr))' : '1fr 1fr',
          gap: 8, alignContent: 'start',
        }}>
          {/* §3.1: "Two non-table slots always exist: Takeaway and Delivery." */}
          {TILE('Takeaway', false, 'tk')}
          {TILE('Delivery', false, 'dl')}
          {Array.from({ length: tableCount }, (_, i) => i + 1).map((n) => {
            const label = tableName(String(n));
            return TILE(label, openByTable.has(label), label);
          })}
          {/* EVERY OPEN BILL GETS A TILE, even one on a table this floor does
              not expect. The grid used to draw exactly `outlet.tables` of them,
              so a ticket on T15 at an outlet with twelve — a QR card printed
              for a table since renumbered, a reservation seated by name, or the
              table count simply lowered while a bill was open — was invisible.
              A bill nobody can reach is a bill nobody can settle, and the table
              would have stayed occupied with no way to say otherwise. */}
          {strays.map((label) => TILE(label, true, label))}
          {!tableCount && (
            <div style={{ gridColumn: '1/-1', padding: '20px 4px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
              This outlet has no tables configured. Set the table count on the outlet
              record and they appear here.
            </div>
          )}
        </div>

        {/* The drawer lives here, under the tables, because this is where the
            cashier is standing when the shift ends. It sits OUTSIDE the tables
            scroller, so it needs its own clearance for the tab bar — the
            scroller's bottom padding does not reach it, and without this the
            bar sat across "Open the register". */}
        <div style={{ flexShrink: 0, paddingBottom: isPhone ? 'calc(62px + env(safe-area-inset-bottom))' : 0 }}>
          <Register session={session} onQueued={onQueued} intent={intent} onIntentDone={onIntentDone} />
        </div>
      </section>

      {/* ── Column 2: menu grid (§3.2) ──────────────────────────────────── */}
      <section style={onePane
        ? { flex: 1, minWidth: 0, display: pane === 'menu' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }
        : { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--line-soft)' }}>
          {isTablet && paneTabs}
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

        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          padding: isPhone ? '0 12px 92px' : '0 12px 14px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%, 148px), 1fr))',
          gap: 9, alignContent: 'start',
        }}>
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
      <section
        aria-hidden={isPhone && !cart ? true : undefined}
        style={isPhone
          ? {
            /* The prototype's sheet, to the number: it never unmounts, it
               slides. 101% so the shadow clears the edge too. */
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60,
            height: 'min(88dvh, 680px)',
            background: 'var(--bg-1)', borderTop: '1px solid var(--line)',
            borderRadius: '16px 16px 0 0',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            boxShadow: '0 -12px 44px rgba(0,0,0,.55)',
            transition: 'transform .22s cubic-bezier(.32,.72,0,1)',
            transform: cart ? 'translateY(0)' : 'translateY(101%)',
          }
          : { width: isTablet ? 'clamp(280px, 30vw, 330px)' : 300, flexShrink: 0, borderLeft: '1px solid var(--line-soft)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* The grabber. A sheet with no handle reads as a stuck panel. */}
        {isPhone && (
          <button
            onClick={() => setCart(false)}
            aria-label="Close the ticket"
            style={{ width: '100%', padding: '11px 0 7px', flexShrink: 0, background: 'transparent', display: 'grid', placeItems: 'center' }}
          >
            <span style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--line-3, var(--line-2))', display: 'block' }} />
          </button>
        )}
        <div style={{ padding: '11px 13px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, letterSpacing: '-.02em', color: table ? 'var(--amber-bright)' : 'var(--text-faint)' }}>
            {table || 'No table'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9.5, color: 'var(--text-faint)', fontFamily: MONO }}>
            {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {/* SEPARATE BILLS ON ONE TABLE. Drawn for any real table, because the
            row is also the only way to OPEN a second bill — gated on there
            already being one, "+ Guest" was unreachable and splitting stayed
            exactly as impossible as it was before.
            Not for Takeaway or Delivery: those are not tables and a party
            cannot ask to split one. */}
        {table && table !== 'Takeaway' && table !== 'Delivery' && (
          <div style={{ padding: '8px 13px', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {guestBills.map((g) => {
              const on = g.split === split;
              return (
                <button key={g.split} onClick={() => setSplit(g.split)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 600,
                    padding: '5px 10px', borderRadius: 16, minHeight: 30,
                    border: '1px solid ' + (on ? 'var(--text)' : 'var(--line)'),
                    color: on ? 'var(--bg)' : 'var(--text-dim)',
                    background: on ? 'var(--text)' : 'var(--bg-2)',
                  }}>
                  {g.split === 0 ? 'Table' : 'Guest ' + (g.split + 1)}
                  {g.open && <span style={{ opacity: .7, fontFamily: MONO }}>{money(g.value)}</span>}
                </button>
              );
            })}
            <button onClick={addGuest} disabled={!table}
              style={{ fontSize: 10.5, color: 'var(--text-dim)', padding: '5px 9px', borderRadius: 16, minHeight: 30, border: '1px dashed var(--line-2)' }}>
              + Guest
            </button>
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 13px' }}>
          {/* WITH THE KITCHEN — the server's own lines, drawn one row per line
              as the ticket holds them rather than aggregated, because a void
              acts on a line and an aggregate has no id to act on. */}
          {sentLines.map((l, i) => (
            <div key={l.id ?? i} style={{ padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
                  {Number(l.qty) > 1 && (
                    <span style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{Number(l.qty)}× </span>
                  )}
                  {l.name}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                  {money(priceOf(l.itemId, l.price) * Number(l.qty))}
                </span>
              </div>
              <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--go-bright)' }}>
                  with the kitchen
                </span>
                <span style={{ flex: 1 }} />
                {l.id && (
                  <button onClick={() => { setVoiding({ id: l.id as string, name: l.name }); setVoidWhy(''); }}
                    style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--red-bright)', padding: '3px 8px', borderRadius: 6, border: '1px solid var(--red-line, var(--line))', minHeight: 26 }}>
                    Take off
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* QUEUED — fired, not yet acknowledged. Offline this is where a whole
              service lives, so it is drawn as part of the bill and not hidden. */}
          {firing.map((l, i) => (
            <div key={'q' + i} style={{ padding: '9px 0', borderBottom: '1px solid var(--line-soft)', opacity: .82 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
                  <span style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{l.qty}× </span>{l.name}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                  {money(l.unitPrice * l.qty)}
                </span>
              </div>
              <div style={{ marginTop: 5, fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--warn-bright)' }}>
                on its way to the kitchen
              </div>
            </div>
          ))}

          {/* KEYED, NOT SENT — the only part this screen still owns outright. */}
          {draft.map((l) => (
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

          {/* The reason. A void with no reason is a number nobody can answer
              for at the end of the month. */}
          {voiding && (
            <div style={{ marginTop: 10, padding: 11, borderRadius: 9, background: 'var(--bg-2)', border: '1px solid var(--red-line, var(--line))' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text)' }}>
                Take {voiding.name} off the bill
              </div>
              <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)' }}>
                It stays on the ticket as a voided line, with your name against it.
              </div>
              <input
                value={voidWhy} autoFocus placeholder="Why? — sent back, wrong table, keyed twice"
                aria-label="Why this line is coming off"
                onChange={(e) => setVoidWhy(e.target.value)}
                style={{
                  marginTop: 8, width: '100%', minHeight: 36, padding: '7px 9px', borderRadius: 7,
                  background: 'var(--bg-1)', border: '1px solid var(--line-2)', color: 'var(--text)',
                  fontSize: 12, fontFamily: 'inherit',
                }} />
              <div style={{ marginTop: 8, display: 'flex', gap: 7 }}>
                <button onClick={() => setVoiding(null)}
                  style={{ flex: 1, minHeight: 34, borderRadius: 7, background: 'var(--bg-1)', border: '1px solid var(--line)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>
                  Keep it
                </button>
                <button onClick={() => void voidLine()} disabled={voidWhy.trim().length < 3}
                  style={{
                    flex: 1, minHeight: 34, borderRadius: 7, fontSize: 12, fontWeight: 700,
                    background: voidWhy.trim().length >= 3 ? 'var(--red)' : 'var(--bg-1)',
                    color: voidWhy.trim().length >= 3 ? '#fff' : 'var(--text-faint)',
                    border: '1px solid ' + (voidWhy.trim().length >= 3 ? 'var(--red)' : 'var(--line)'),
                  }}>
                  Take it off
                </button>
              </div>
            </div>
          )}

          {/* GIVING THE TABLE BACK. Offered whenever there is a ticket, because
              the case it exists for is the one with nothing on it — a party
              seated from the book that got up and left, or a bill whose every
              line was voided. Neither could be settled by anybody, and the
              table stayed busy until closing. */}
          {clearing && (
            <div style={{ marginTop: 10, padding: 11, borderRadius: 9, background: 'var(--bg-2)', border: '1px solid ' + (onKitchen.length ? 'var(--red-line, var(--line))' : 'var(--line-2)') }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text)' }}>
                {onKitchen.length
                  ? 'Write off this bill'
                  : 'Give ' + (table || 'this table') + ' back'}
              </div>
              <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
                {onKitchen.length
                  ? 'The kitchen made it and nobody paid. Every line is voided with your'
                    + ' reason against it. NO STOCK MOVES — costing happens at the sale, so'
                    + ' the ingredients are still on the books. Record them through Inventory'
                    + ' as wastage, where they land in the same figure as everything else'
                    + ' thrown away.'
                  : 'Nothing was ordered, so nothing is being written off. The table goes back'
                    + ' to free and the ticket is closed unpaid.'}
              </div>
              {onKitchen.length > 0 && (
                <input
                  value={clearWhy} autoFocus placeholder="Why? — walked out, keyed to the wrong table"
                  aria-label="Why this bill is being written off"
                  onChange={(e) => setClearWhy(e.target.value)}
                  style={{
                    marginTop: 8, width: '100%', minHeight: 36, padding: '7px 9px', borderRadius: 7,
                    background: 'var(--bg-1)', border: '1px solid var(--line-2)', color: 'var(--text)',
                    fontSize: 12, fontFamily: 'inherit',
                  }} />
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 7 }}>
                <button onClick={() => { setClearing(false); setClearWhy(''); }}
                  style={{ flex: 1, minHeight: 34, borderRadius: 7, background: 'var(--bg-1)', border: '1px solid var(--line)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>
                  Keep it
                </button>
                <button onClick={() => void clearBill()}
                  disabled={onKitchen.length > 0 && clearWhy.trim().length < 3}
                  style={{
                    flex: 1, minHeight: 34, borderRadius: 7, fontSize: 12, fontWeight: 700,
                    background: onKitchen.length === 0 || clearWhy.trim().length >= 3 ? 'var(--red)' : 'var(--bg-1)',
                    color: onKitchen.length === 0 || clearWhy.trim().length >= 3 ? '#fff' : 'var(--text-faint)',
                    border: '1px solid ' + (onKitchen.length === 0 || clearWhy.trim().length >= 3 ? 'var(--red)' : 'var(--line)'),
                  }}>
                  {onKitchen.length ? 'Write it off' : 'Give it back'}
                </button>
              </div>
            </div>
          )}

          {!lines.length && !voiding && !clearing && (
            <div style={{ padding: '30px 4px', textAlign: 'center', fontSize: 11.5, lineHeight: 1.65, color: 'var(--text-faint)' }}>
              {table
                ? 'Nothing on this ticket yet. Tap a dish to add it.'
                : 'Choose a table, then tap dishes to build the ticket.'}
            </div>
          )}

          {/* The way in. Only when there IS a ticket — with no ticket there is
              nothing to give back, and the table is already free. */}
          {ticket && !clearing && !voiding && (
            <button onClick={() => { setClearing(true); setClearWhy(''); }}
              style={{
                marginTop: 12, width: '100%', minHeight: 34, borderRadius: 7,
                background: 'transparent', border: '1px dashed var(--line-2)',
                color: 'var(--text-faint)', fontSize: 11.5, fontWeight: 600,
              }}>
              {onKitchen.length ? 'Write off this bill' : 'Give the table back'}
            </button>
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
              disabled={!draft.length}
              style={{
                flex: 1, minHeight: 44, borderRadius: 9,
                background: draft.length ? 'var(--bg-3)' : 'var(--bg-2)',
                border: '1px solid ' + (draft.length ? 'var(--amber-line)' : 'var(--line)'),
                color: draft.length ? 'var(--amber-bright)' : 'var(--text-faint)',
                fontSize: 13.5, fontWeight: 700, textAlign: 'center',
              }}
            >{draft.length ? 'Send ' + draft.reduce((a, l) => a + l.qty, 0) : 'Sent'}</button>
            <button
              onClick={() => setPaying({
                lines, total,
                goods: lines.reduce((a, l) => a + l.unitPrice * l.qty, 0),
                ticketId: ticket?.id,
              })}
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

      {/* ── The scrim behind the ticket sheet ─────────────────────────── */}
      {isPhone && cart && (
        <div
          onClick={() => setCart(false)}
          aria-hidden="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 55,
            background: 'var(--scrim, rgba(0,0,0,.55))', animation: 'kfade .14s',
          }}
        />
      )}

      {/* ── The bar under the thumb ───────────────────────────────────────
          The prototype's reasoning, kept: these three destinations used to be
          a tab strip in the top-right corner — the furthest point from a thumb
          on a phone held one-handed, and the hardest to hit during service. The
          badges are the two counts that decide where you are going: how many
          tables are open, and how many lines are on the bill in hand. */}
      {isPhone && (
        <nav
          aria-label="Till"
          style={{
            /* z-50, BELOW the ticket sheet at z-60 — the prototype's order.
               An open ticket covers this bar completely, which is what keeps
               the Pay button off the bottom edge instead of underneath it. */
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
            display: 'flex', alignItems: 'stretch', gap: 2,
            padding: '5px 8px calc(5px + env(safe-area-inset-bottom))',
            background: 'var(--bg-1)', borderTop: '1px solid var(--line)',
            boxShadow: '0 -8px 24px rgba(0,0,0,.28)',
          }}
        >
          {([
            { k: 'floor', label: 'Floor', badge: openByTable.size || 0,
              icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
            { k: 'menu', label: 'Menu', badge: 0,
              icon: 'M4 6h16M4 12h16M4 18h10' },
            { k: 'bill', label: table ? 'Bill' : 'Start', badge: lines.length,
              icon: 'M6 2h9l4 4v16H6zM9 12h7M9 16h5' },
          ] as const).map((t) => {
            const on = t.k === 'bill' ? cart : !cart && pane === t.k;
            return (
              <button
                key={t.k}
                onClick={() => {
                  if (t.k === 'bill') { setCart(true); return; }
                  setPane(t.k === 'menu' ? 'menu' : 'floor');
                  setCart(false);
                }}
                aria-current={on ? 'page' : undefined}
                style={{
                  position: 'relative', flex: '1 1 0', minWidth: 0,
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 3,
                  padding: '7px 4px', borderRadius: 12, minHeight: 52,
                  background: 'transparent',
                  color: on ? 'var(--text)' : 'var(--text-muted)',
                }}
              >
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.icon} />
                </svg>
                <span style={{ fontSize: 10.5, fontWeight: on ? 700 : 500 }}>{t.label}</span>
                {t.badge > 0 && (
                  <span style={{
                    position: 'absolute', top: 4, right: 'calc(50% - 22px)',
                    minWidth: 16, height: 16, padding: '0 4px', borderRadius: 9,
                    fontSize: 9.5, fontWeight: 800, lineHeight: '16px', textAlign: 'center',
                    background: t.k === 'bill' ? 'var(--amber)' : 'var(--bg-3)',
                    color: t.k === 'bill' ? '#111214' : 'var(--text-dim)',
                  }}>
                    {t.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}

      {paying && (
        <Payment
          /* Cash rounds, card does not — so the total depends on the tender,
             and the tender is chosen in there. */
          cashRoundLaari={Number(outlet?.cash_round_laari ?? 0)}
          total={paying.total}
          goods={paying.goods}
          session={session}
          online={online}
          promoCode={promoCode}
          /* What the guest's own phone offered against this bill, and whose
             card it is. An offer nobody at the counter sees is a promise made
             to a guest and kept by nobody, so it arrives on the screen where
             the tender is chosen. */
          offeredPoints={ticket?.points_offered ? Number(ticket.points_offered) : null}
          offeredBy={ticket?.member_id ?? null}
          onPromo={(code, discount) => { setPromoCode(code); setPromoDiscount(discount); }}
          onCancel={() => setPaying(null)}
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

/* The one spelling of a table, matching backend/src/tables.js.
 *
 * The floor used to draw `T05` while a round sent from a guest's phone opened a
 * ticket called `5`, and this screen half-knew: it checked both spellings when
 * shading a tile busy and then used its own for everything after. So a QR order
 * lit the tile and tapping it opened an empty bill — and sending a round from
 * there would have opened a second ticket for the same table. */
export function tableName(v: string): string {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  const m = /^[Tt]?0*([1-9]\d{0,2})$/.exec(raw);
  if (!m) return raw.slice(0, 20);
  const n = Number(m[1]);
  return 'T' + (n < 10 ? '0' + n : String(n));
}
