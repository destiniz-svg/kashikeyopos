import { useEffect, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* The payment modal — 02-POS-SPEC.md §3.4.
 *
 * "Keypad on the left, bill on the right (stacks under shortVp()). Tendered is
 *  22px/700 monospace in --warn-bright; change due appears the moment tendered
 *  exceeds the total."
 *
 * WHAT THIS SCREEN DOES NOT DO. It does not compute the sale. On confirm it
 * hands the till's chosen tender to Floor, which queues ONE `sale` operation;
 * the server allocates the receipt number, prices the bill from the item master
 * and the tax version in force, moves the stock, posts the journal and closes
 * the ticket — all in one transaction (§3.4's own list). This modal's job is to
 * take a number from a person's fingers and hand it on.
 *
 * TWO TENDERS TAKE NO MONEY. On ACCOUNT, the customer's debt goes up; in
 * POINTS, a promise the business already accrued is settled. Both need a member
 * named, and both can fail for a reason the cashier cannot see — no credit
 * left, not enough points — so both are checked here BEFORE the button is
 * pressed. The server checks them again and is the authority, but somebody
 * standing in front of a guest should not learn about a credit limit from a
 * refusal.
 *
 * A MEMBER CAN BE ATTACHED TO ANY BILL, not only to one settled in points. The
 * first version of this screen only asked who the guest was when the tender
 * needed to know — so a member paying cash, which is most of them, earned
 * nothing and the scheme quietly did not work for the people it was for. The
 * question "who is this?" belongs to the sale, not to the tender.
 *
 * And the two member tenders are only offered ONLINE. Every other tender can be queued and replayed
 * hours later because nothing about it can turn out to be untrue. These two
 * can: the limit is checked when the sale reaches the server, so an
 * offline one could be refused on replay long after the guest has walked out,
 * leaving a meal nobody paid for and no way to find them. A tender that can
 * evaporate is worse than a tender that is unavailable.
 */

const MONO = "'JetBrains Mono',monospace";
const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Method = 'cash' | 'card' | 'wallet' | 'bank' | 'account' | 'points' | 'voucher';

/** A part of the bill, once the cashier has taken it. */
interface Part { method: Method; amount: number; ref?: string }

interface Customer {
  id: string; phone: string; name: string | null; company: string | null;
  available: number; owed: number; onAccount: boolean; blocked: boolean;
  points: number;
}
interface Scheme { pointValue: number; running: boolean }
interface Quote {
  ok: boolean; reason?: string; code?: string; name?: string;
  discount?: number; discountMvr?: number; note?: string;
}

interface Props {
  /* laari, AFTER any promotion and BEFORE cash rounding — whether it rounds
     depends on the tender, and the tender is chosen on this screen. */
  total: number;
  /* What a CASH bill rounds to, in laari; 0 means none. sale.js rounds the
     WHOLE bill when ANY part of the tender is cash, and this screen has to
     reach the same figure or the server refuses the sale outright. */
  cashRoundLaari: number;
  /* INCLUSIVE goods — the prices on the menu board. A promotion is evaluated
     against what the guest was shown, and the server does the same. */
  goods: number;
  session: Session;
  online: boolean;
  promoCode?: string;
  /* Reported UP, because a promotion changes the bill and not just the tender:
     Floor recomputes the whole thing through the one calculation. */
  onPromo: (code: string | undefined, discount: number) => void;
  onCancel: () => void;
  /* `voucherCode` rides beside the payments rather than inside one, because
     that is where sale.js reads it: the code is checked against its own value
     and CLAIMED after the sale exists, so it belongs to the sale and not to a
     tender line. */
  onConfirm: (payments: { method: Method; amount: number; ref?: string }[], memberId?: string,
    promoCode?: string, voucherCode?: string) => void | Promise<void>;
  /* What the member's own phone offered against this bill, and whose it is.
     04-MEMBER-PORTAL §3: "The till still takes the payment: the portal posts
     intent." This is where that intent surfaces — an offer nobody at the
     counter sees is a promise made to a guest and kept by nobody. */
  offeredPoints?: number | null;
  offeredBy?: string | null;
}

export function Payment({ total: raw, goods, session, online, promoCode, onPromo,
  cashRoundLaari, onCancel, onConfirm, offeredPoints, offeredBy }: Props) {
  const [method, setMethod] = useState<Method>('cash');
  /* THE BILL CAN BE PAID IN MORE THAN ONE WAY. sale.js has always taken an
     ARRAY of payments and posted each to its own ledger account; this screen
     sent exactly one, for the whole total, which is why "half cash, half card"
     — the most ordinary request in a restaurant — could not be rung up at all.
     `parts` is what has already been taken; the keypad is working on the rest. */
  const [parts, setParts] = useState<Part[]>([]);
  /* A voucher settles against the liability it was issued from, so the server
     needs to know WHICH one. */
  const [voucherRef, setVoucherRef] = useState('');
  /* WHAT THE VOUCHER IS WORTH. Looked up, because the cashier cannot know: a
     voucher that does not cover the bill has to be taken as PART of the tender
     and the rest collected some other way, and until the till showed the value
     there was no way to work out what that part was. The server refused the
     whole sale with "that voucher is worth 35.00 — it cannot cover 38.50",
     which is the right answer to the wrong question. */
  const [voucher, setVoucher] = useState<{
    value: number; name: string; state: string; usable: boolean; member: string | null;
  } | null>(null);
  const [voucherErr, setVoucherErr] = useState('');
  const [buf, setBuf] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Customer[] | null>(null);
  const [who, setWho] = useState<Customer | null>(null);
  const [scheme, setScheme] = useState<Scheme | null>(null);
  /* Opened by hand for a cash or card bill; forced open by a tender that
     cannot proceed without a member. */
  const [attaching, setAttaching] = useState(false);
  /* The code the guest is holding. Quoted against the SAME evaluator their
     phone asked, so the figure the cashier reads out is the figure the sale
     will charge — and a code that will not work says why here, not after the
     receipt has printed. */
  const [promo, setPromo] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [checking, setChecking] = useState(false);

  /* Search only while a member tender is showing, and only online. The account
     tender needs somebody with credit; points need somebody with points. */
  const memberTender = method === 'account' || method === 'points';
  const picking = memberTender || attaching;
  useEffect(() => {
    if (!picking || !online) return;
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.authed(session)<{ members: Customer[] }>(
          'GET', '/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
        /* Filtered by what the TENDER needs. Attaching a member to a cash bill
           needs nothing of them, so nothing is filtered out — the commonest
           case is a member with no credit and no points yet. */
        if (!dead) {
          setFound(method === 'account' ? r.members.filter((m) => m.onAccount)
            : method === 'points' ? r.members.filter((m) => m.points > 0)
              : r.members);
        }
      } catch { if (!dead) setFound([]); }
    }, 220);
    return () => { dead = true; clearTimeout(t); };
  }, [picking, method, q, online, session]);

  /* What a point is worth, so the screen can say how many this bill costs
     before anybody presses anything. */
  useEffect(() => {
    /* Fetched once for any bill, not only a points one: the attach row shows a
       member's balance, and a cashier telling a guest what they have is the
       cheapest reason this scheme gets used at all. */
    if (!online || scheme) return;
    let dead = false;
    (async () => {
      try {
        const r = await api.authed(session)<{ config: Scheme }>('GET', '/loyalty');
        if (!dead) setScheme(r.config);
      } catch { if (!dead) setScheme({ pointValue: 0, running: false }); }
    })();
    return () => { dead = true; };
  }, [online, session, scheme]);

  /* Look the voucher up as it is typed. Debounced, because a cashier reading a
     code off a phone types it one character at a time and every prefix would
     otherwise be a 404. */
  useEffect(() => {
    const code = voucherRef.trim();
    if (method !== 'voucher' || code.length < 3 || !online) {
      setVoucher(null); setVoucherErr('');
      return;
    }
    let dead = false;
    const t = setTimeout(() => {
      (async () => {
        try {
          const r = await api.authed(session)<{
            value: number; name: string; state: string; usable: boolean; member: string | null;
          }>('GET', '/vouchers/' + encodeURIComponent(code));
          if (dead) return;
          setVoucher(r); setVoucherErr('');
        } catch (e) {
          if (dead) return;
          setVoucher(null);
          setVoucherErr(e instanceof api.ApiError ? e.message : 'could not check that code');
        }
      })();
    }, 350);
    return () => { dead = true; clearTimeout(t); };
  }, [voucherRef, method, online, session]);

  /* The keypad buffer is read as laari — typing 1 2 5 0 means MVR 12.50. A till
     keypad has no decimal point for the same reason a card terminal does not:
     the operator is typing what the guest handed over, fast, and a misplaced
     point is a hundredfold error. */
  const tendered = buf ? Number(buf) : 0;

  /* CASH ROUNDING, THE SAME WAY THE SERVER DOES IT. sale.js rounds the whole
     bill when ANY part of the tender is cash — coins below the increment do not
     exist, and a bill half-settled on a card is still handed over in cash at
     the end. This screen used not to know the increment at all: the till sent
     the unrounded figure, the server rounded, and every cash sale at an outlet
     that rounds came back "payments do not equal the bill" with nothing the
     cashier could do about it. */
  const cashInTender = method === 'cash' || parts.some((x) => x.method === 'cash');
  const rounds = cashRoundLaari > 1 && cashInTender;
  const total = rounds ? Math.round(raw / cashRoundLaari) * cashRoundLaari : raw;
  const rounding = total - raw;

  /* WHAT IS LEFT TO PAY. With no parts taken this is the whole bill and every
     figure below reads exactly as it did before splitting existed. */
  const taken = parts.reduce((a, x) => a + x.amount, 0);
  const due = Math.max(0, total - taken);

  // Only cash is tendered over; everything else settles to the exact balance.
  const effective = method === 'cash' ? (tendered || due) : due;
  const change = Math.max(0, effective - due);
  const shortCash = effective < due;
  /* An account charge is blocked by its own arithmetic, not by the keypad. */
  const noRoom = method === 'account' && !!who && who.available * 100 < due;
  /* Points needed, rounded UP — the server does the same, and a screen that
     rounded down would offer a redemption the server then refuses. */
  const pointsNeeded = scheme && scheme.pointValue > 0
    ? Math.ceil((due / 100) / scheme.pointValue * 100) / 100 : 0;
  const notEnough = method === 'points'
    && (!scheme?.running || !who || who.points < pointsNeeded);
  const needsRef = method === 'voucher' && voucherRef.trim().length < 3;
  /* WHAT THIS VOUCHER CAN ACTUALLY SETTLE. Capped at the balance: a voucher
     worth more than the bill is not change, it is a voucher with something
     left on it, and the server would refuse a payment larger than what is
     owed. Capped at zero when the code is bad or spent, so the button below
     says why instead of the server saying it after the fact. */
  const voucherWorth = method === 'voucher' && voucher?.usable ? Math.round(voucher.value * 100) : 0;
  /* Reasons this TENDER cannot be used at all, as opposed to a cash amount that
     merely does not cover the bill. The distinction matters: the second is what
     splitting a bill looks like on the way in. */
  const methodBlocked = (method === 'account' && (!who || noRoom))
    || (method === 'points' && notEnough)
    || needsRef
    || (method === 'voucher' && (!!voucherErr || (!!voucher && !voucher.usable)));

  /* A voucher that does not cover the balance cannot SETTLE it — Confirm sends
     the whole remaining balance for every other tender, and pressing it here
     would queue a sale the server refuses for being short. But it CAN be taken
     as a part, and that button is the way through, so this blocks the one and
     not the other. Folding it into `methodBlocked` disabled the escape route
     along with the trap. */
  const voucherShort = method === 'voucher' && voucherWorth > 0 && voucherWorth < due;
  const short = shortCash || methodBlocked || voucherShort;

  /* TAKING PART OF THE BILL. The amount is what the operator keyed, capped at
     what is still owed — a part larger than the balance would make the payments
     exceed the bill, and the server refuses that whole sale rather than the one
     bad part, which is a refusal at the worst possible moment.
     Deliberately NOT gated on `short`: a cash amount under the bill IS the
     split case, and gating on it hid the button in exactly the situation it
     exists for. */
  /* A voucher's amount is not keyed — it is what the voucher is worth, up to
     the balance. Everything else takes the keypad. */
  const partAmount = method === 'voucher'
    ? Math.min(due, voucherWorth)
    : Math.min(due, tendered);
  const canPart = partAmount > 0 && partAmount < due && !methodBlocked;
  const takePart = () => {
    if (!canPart) return;
    setParts((ps) => ps.concat([{
      method, amount: partAmount,
      ...(method === 'voucher' ? { ref: voucherRef.trim() } : {}),
    }]));
    setBuf(''); setVoucherRef('');
    /* Back to cash for the remainder: it is the commonest second tender, and
       leaving the last method selected invites the same one being taken twice. */
    setMethod('cash');
  };

  /* WHY THE BUTTON IS GREY, ON THE BUTTON. Every one of these already had a
     sentence somewhere in the right-hand column explaining the tender, but the
     control the cashier is pressing said nothing — so a bill that would not
     settle looked like a bill the till had broken on, with a guest waiting.
     The blocker belongs on the thing that is refusing to move. */
  const blocker = needsRef ? 'Type the voucher code'
    : voucherErr ? 'No voucher with that code'
      : (method === 'voucher' && voucher && !voucher.usable)
        ? (voucher.state === 'used' ? 'That voucher has been used' : 'That voucher has expired')
        : (method === 'voucher' && !voucher) ? 'Checking the voucher…'
          : voucherShort
            ? 'Take the ' + money(voucherWorth) + ' below, then collect ' + money(due - voucherWorth)
    : (method === 'account' && !who) ? 'Choose whose account'
      : (method === 'account' && noRoom) ? 'Not enough left on the limit'
        : (method === 'points' && !scheme?.running) ? 'The loyalty scheme is not running'
          : (method === 'points' && !who) ? 'Choose whose points'
            : (method === 'points' && notEnough) ? 'Not enough points'
              : shortCash ? money(due - effective) + ' short'
                : null;

  const key = (d: string) => {
    if (busy) return;
    if (d === 'c') { setBuf(''); return; }
    if (d === 'del') { setBuf((b) => b.slice(0, -1)); return; }
    setBuf((b) => (b + d).replace(/^0+(?=\d)/, '').slice(0, 9));
  };

  const confirm = async () => {
    if (busy || short) return;
    setBusy(true);
    try {
      /* The PAYMENT is the bill, not the tendered amount: change handed back is
         not revenue and must never reach the ledger as if it were. The server
         refuses a sale whose payments do not equal the bill it computed, which
         is the backstop under this. */
      /* The member goes with the SALE whatever paid for it — that is how a
         cash-paying member earns. The code goes with it too; the server
         evaluates it again at settlement and is the authority. */
      const last: Part = {
        /* A voucher settles what it is worth. Everything else settles the
           balance — a card or a cash drawer can take any figure, a voucher
           cannot. */
        method, amount: method === 'voucher' ? Math.min(due, voucherWorth) : due,
        ...(method === 'voucher' ? { ref: voucherRef.trim() } : {}),
      };
      const all = parts.concat([last]);
      const voucher = all.find((x) => x.method === 'voucher');
      await onConfirm(all, who ? who.id : undefined, promoCode, voucher?.ref);
    } finally {
      setBusy(false);
    }
  };

  /* Every tender sale.js knows, which is the point: the list here and the list
     there used to differ by two, so `bank` and `voucher` had a ledger account,
     a validation branch and a journal line each, and no way for anybody to
     choose them. A tender the server accepts and the till cannot offer is a
     feature that exists only in the tests. */
  const METHODS: { k: Method; label: string }[] = [
    { k: 'cash', label: 'Cash' },
    { k: 'card', label: 'Card' },
    { k: 'wallet', label: 'Wallet' },
    /* Bank transfer settles to 1010 rather than the card float, and it takes no
       cash, so the drawer must not expect it. */
    { k: 'bank', label: 'Transfer' },
    { k: 'voucher', label: 'Voucher' },
    ...(online ? [{ k: 'account' as Method, label: 'Account' },
      { k: 'points' as Method, label: 'Points' }] : []),
  ];

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)',
        display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s',
      }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-label="Take payment"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 620, background: 'var(--bg-1)',
          border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden',
          animation: 'kmodal .18s',
        }}
      >
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Take payment</span>
          <span style={{ flex: 1 }} />
          <button onClick={onCancel} aria-label="Cancel"
            style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* WHAT THE GUEST'S PHONE OFFERED. §3 of the member spec: the portal
            posts intent, the till settles. So the offer arrives here, above
            the tender, and it is a prompt rather than a decision — pressing it
            selects the points tender and attaches the member, which the
            cashier then confirms like any other payment. */}
        {offeredPoints ? (
          <div style={{
            padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 12,
            flexWrap: 'wrap', background: 'var(--go-dim)', color: 'var(--go-bright)',
            borderBottom: '1px solid var(--line-soft)', fontSize: 12.5, lineHeight: 1.5,
          }}>
            <span>
              The guest offered <b>{offeredPoints}</b> points from their phone
              {scheme && scheme.pointValue > 0
                && ' (' + (offeredPoints * scheme.pointValue).toFixed(2) + ')'}.
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => {
                setMethod('points');
                setAttaching(true);
                if (offeredBy) setQ('');
              }}
              style={{
                padding: '6px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                background: 'var(--go)', color: 'var(--on-go)',
              }}>Take the points</button>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {/* Keypad — left */}
          <div style={{ flex: '1 1 260px', minWidth: 240, padding: 16, borderRight: '1px solid var(--line-soft)' }}>
            {/* Seven tenders, not five. The row was a single nowrap line built
                when there were five of them, and adding the two the ledger has
                always known pushed Account and Points off the right edge of a
                phone. It wraps. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              {METHODS.map((m) => {
                const on = method === m.k;
                return (
                  <button key={m.k} onClick={() => { setMethod(m.k); setBuf(''); }}
                    style={{
                      flex: 1, minHeight: 36, borderRadius: 7, fontSize: 12, fontWeight: 700, textAlign: 'center',
                      background: on ? 'var(--amber)' : 'var(--bg-2)',
                      color: on ? 'var(--on-amber)' : 'var(--text-muted)',
                      border: '1px solid ' + (on ? 'var(--amber)' : 'var(--line)'),
                    }}>{m.label}</button>
                );
              })}
            </div>

            {/* A CODE THE GUEST IS HOLDING. Quoted against the SAME evaluator
                their phone asked, so what the cashier reads out is what the
                sale will charge — and a code that will not work says why here,
                rather than after the receipt has printed. */}
            {online && (
              <div style={{ marginBottom: 11 }}>
                <div style={{ display: 'flex', gap: 7 }}>
                  <input value={promo}
                    onChange={(e) => { setPromo(e.target.value.toUpperCase().slice(0, 24)); setQuote(null); }}
                    placeholder="Promo code" aria-label="Promo code"
                    style={{ flex: 1, height: 34, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5, fontFamily: MONO }} />
                  {promoCode ? (
                    <button onClick={() => { onPromo(undefined, 0); setPromo(''); setQuote(null); }}
                      style={{ height: 34, padding: '0 12px', borderRadius: 7, fontSize: 11.5, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                      Remove
                    </button>
                  ) : (
                    <button disabled={!promo || checking}
                      onClick={async () => {
                        setChecking(true);
                        try {
                          const r = await api.authed(session)<Quote>(
                            'POST', '/promos/quote',
                            { code: promo, goodsLaari: goods, memberId: who?.id });
                          setQuote(r);
                          if (r.ok) onPromo(r.code, r.discount || 0);
                        } catch { setQuote({ ok: false, reason: 'Could not check that.' }); }
                        finally { setChecking(false); }
                      }}
                      style={{ height: 34, padding: '0 14px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, background: promo ? 'var(--go)' : 'var(--bg-2)', color: promo ? 'var(--on-go)' : 'var(--text-faint)' }}>
                      {checking ? '…' : 'Apply'}
                    </button>
                  )}
                </div>
                {quote && (
                  <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: quote.ok ? 'var(--go-bright)' : 'var(--stop-bright)' }}>
                    {quote.ok
                      ? quote.name + ' — ' + money(quote.discount || 0) + ' off'
                        + (quote.note ? '. ' + quote.note : '')
                      : quote.reason}
                  </div>
                )}
              </div>
            )}

            {/* WHO IS THIS? — asked of the sale, not of the tender, so a member
                paying cash earns like anybody else. */}
            {online && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, padding: '7px 9px', borderRadius: 7, background: who ? 'var(--bg-3)' : 'var(--bg-2)', border: '1px solid ' + (who ? 'var(--amber-line)' : 'var(--line)') }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: who ? 'var(--text)' : 'var(--text-faint)' }}>
                  {who ? (who.name || who.phone) : 'No member on this bill'}
                  {who && scheme?.running && (
                    <span style={{ marginLeft: 6, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      {who.points} pts
                    </span>
                  )}
                </span>
                {who ? (
                  <button onClick={() => { setWho(null); if (!memberTender) setAttaching(false); }}
                    style={{ padding: '4px 9px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                    Remove
                  </button>
                ) : !memberTender && (
                  <button onClick={() => setAttaching((a) => !a)}
                    style={{ padding: '4px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: attaching ? 'var(--bg-3)' : 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                    {attaching ? 'Never mind' : 'Attach a member'}
                  </button>
                )}
              </div>
            )}

            {!picking ? (
              <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 7 }}>
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'c', '0', 'del'].map((d) => (
                  <button key={d} onClick={() => key(d)}
                    aria-label={d === 'del' ? 'Delete' : d === 'c' ? 'Clear' : d}
                    style={{
                      minHeight: 46, borderRadius: 8, background: 'var(--bg-2)',
                      border: '1px solid var(--line)', color: 'var(--text)',
                      fontSize: 16, fontWeight: 600, fontFamily: MONO,
                      display: 'grid', placeItems: 'center',
                    }}>
                    {d === 'del' ? '⌫' : d === 'c' ? 'C' : d}
                  </button>
                ))}
              </div>
                {/* WHAT THE KEYPAD MEANS depends on the tender, and saying so is
                    the difference between a split and a mis-key. On cash it is
                    what the guest handed over; on every other amount tender it
                    is how much of the bill goes this way, and leaving it empty
                    means all of it. */}
                <div style={{ marginTop: 9, fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
                  {method === 'cash'
                    ? 'What they handed over. Leave it empty for the exact bill.'
                    : method === 'card'
                      ? 'Take it on the card terminal, then confirm. Key an amount first only to put part of the bill on the card.'
                      : method === 'wallet'
                        ? 'Take it on the wallet app, then confirm. Key an amount first only to put part of the bill on it.'
                        : 'Key an amount to put part of the bill on this tender; leave it empty for the whole balance.'}
                </div>
              </>
            ) : (
              <div style={{ padding: '4px 0' }}>
                <input value={q} onChange={(e) => { setQ(e.target.value); setWho(null); }}
                  placeholder="name or number…" aria-label="Find the account"
                  style={{ width: '100%', height: 36, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 13 }} />
                <div style={{ marginTop: 8, maxHeight: 190, overflowY: 'auto' }}>
                  {!found ? (
                    <div style={{ padding: '14px 2px', fontSize: 11.5, color: 'var(--text-faint)' }}>
                      Looking…
                    </div>
                  ) : !found.length ? (
                    <div style={{ padding: '14px 2px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
                      {method === 'account'
                        ? 'No house accounts match. An account is opened in Customers & Credit, by an admin — a customer record on its own carries no credit.'
                        : method === 'points'
                          ? 'Nobody matching has any points. Points are earned on a sale once a member is attached to it.'
                          : 'Nobody matching. A member is added in Customers & Credit — a phone number and a name is enough.'}
                    </div>
                  ) : found.map((m) => {
                    /* Whether this member can be PICKED, which depends on what
                       the tender needs of them. Attaching to a cash bill needs
                       nothing at all — the ordinary case is somebody with no
                       credit and no points yet, and refusing them would be
                       refusing the only way they ever get any. */
                    const room = method === 'account'
                      ? m.available * 100 >= total && !m.blocked
                      : method === 'points' ? m.points >= pointsNeeded
                        : true;
                    const on = who?.id === m.id;
                    return (
                      <button key={m.id} disabled={!room}
                        onClick={() => {
                          setWho(m);
                          /* On a cash bill the picker was covering the keypad,
                             so picking closes it — otherwise the cashier can no
                             longer type what the guest handed over. A member
                             tender has no keypad to go back to. */
                          if (!memberTender) setAttaching(false);
                        }}
                        style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 8px', marginBottom: 4, borderRadius: 7, textAlign: 'left', background: on ? 'var(--bg-3)' : 'transparent', border: '1px solid ' + (on ? 'var(--amber-line)' : 'transparent'), opacity: room ? 1 : 0.5 }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                            {m.name || m.phone}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                            {m.company || m.phone}
                          </span>
                        </span>
                        {/* What is LEFT, not what was granted — the only figure
                            that answers "can this go on the account?" */}
                        <span style={{ fontSize: 11.5, fontFamily: MONO, color: room ? 'var(--text-muted)' : 'var(--stop-bright)' }}>
                          {method === 'account'
                            ? (m.blocked ? 'blocked' : money(m.available * 100) + ' left')
                            : m.points.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' pts'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Bill — right */}
          <div style={{ flex: '1 1 240px', minWidth: 220, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
              {parts.length ? 'STILL TO PAY' : 'TO PAY'}
            </div>
            <div style={{ marginTop: 6, fontSize: 26, fontWeight: 700, fontFamily: MONO, color: 'var(--text)', letterSpacing: '-.02em' }}>
              {money(due)}
            </div>

            {/* THE ROUNDING, SAID OUT LOUD. A figure that changes the moment
                Cash is pressed and does not explain itself reads as a bug at
                the counter — and it is the cashier who has to answer the guest
                for it. */}
            {rounding !== 0 && (
              <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)' }}>
                {rounding > 0 ? 'Rounded up ' : 'Rounded down '}
                <b style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{money(Math.abs(rounding))}</b>
                {' '}for cash — {money(raw)} on the bill. Card and account bills never round.
              </div>
            )}

            {/* WHAT HAS ALREADY BEEN TAKEN. Drawn only once there is something,
                so a bill paid one way looks exactly as it always did. */}
            {parts.length > 0 && (
              <div style={{ marginTop: 12, padding: '9px 11px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: 'var(--text-faint)' }}>
                  TAKEN SO FAR — {money(taken)} of {money(total)}
                </div>
                {parts.map((x, i) => (
                  <div key={i} style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>
                      {x.method === 'bank' ? 'Transfer' : x.method}
                      {x.ref && <span style={{ color: 'var(--text-faint)', fontFamily: MONO }}> {x.ref}</span>}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{money(x.amount)}</span>
                    {/* Nothing has reached the server yet, so taking a part back
                        is free — and a cashier who mis-keyed the split must not
                        have to cancel the whole payment to fix it. */}
                    <button onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                      aria-label={'Undo the ' + x.method + ' part'}
                      style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '2px 7px', borderRadius: 5, border: '1px solid var(--line)', minHeight: 24 }}>
                      Undo
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* A voucher settles against the liability it was issued from, so
                the server is told which one. */}
            {method === 'voucher' && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>VOUCHER CODE</div>
                <input
                  value={voucherRef} aria-label="Voucher code"
                  placeholder="from their phone"
                  onChange={(e) => setVoucherRef(e.target.value.toUpperCase())}
                  style={{
                    marginTop: 6, width: '100%', minHeight: 38, padding: '8px 10px', borderRadius: 8,
                    background: 'var(--bg-2)', border: '1px solid ' + (needsRef ? 'var(--line-2)' : 'var(--go-line, var(--line))'),
                    color: 'var(--text)', fontSize: 14, fontFamily: MONO, letterSpacing: '.04em',
                  }} />
                {voucherErr && (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 7, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 11.5, lineHeight: 1.5 }}>
                    {voucherErr}
                  </div>
                )}
                {voucher && (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 7,
                    background: voucher.usable ? 'var(--bg-2)' : 'var(--red-dim)',
                    color: voucher.usable ? 'var(--text-dim)' : 'var(--red-bright)',
                    fontSize: 11.5, lineHeight: 1.5 }}>
                    <b>{voucher.name}</b>
                    {voucher.member && <span style={{ color: 'var(--text-faint)' }}> · {voucher.member}</span>}
                    <span style={{ display: 'block', marginTop: 3 }}>
                      {voucher.state === 'used' ? 'Already redeemed — it cannot be used again.'
                        : voucher.state === 'expired' ? 'Expired.'
                          : <>
                            Worth <b style={{ fontFamily: MONO }}>{money(Math.round(voucher.value * 100))}</b>
                            {voucherWorth >= due
                              ? ' — it covers this bill.'
                              : ' — ' + money(due - voucherWorth) + ' left to collect another way.'}
                            </>}
                    </span>
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
                  No money is taken. The voucher settles against the same liability points do —
                  the obligation was booked when it was issued.
                </div>
              </div>
            )}

            {method === 'bank' && (
              <div style={{ marginTop: 16, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.55 }}>
                Confirm once the transfer shows on the account. It settles to the bank rather
                than the drawer, so the cash count at close is unaffected by it.
              </div>
            )}

            {method === 'cash' && (
              <>
                <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>TENDERED</div>
                <div style={{ marginTop: 5, fontSize: 22, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>
                  {buf ? money(tendered) : money(due)}
                </div>

                {/* §3.4: change due appears the MOMENT tendered exceeds total. */}
                {change > 0 && (
                  <>
                    <div style={{ marginTop: 14, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>CHANGE DUE</div>
                    <div style={{ marginTop: 5, fontSize: 22, fontWeight: 700, fontFamily: MONO, color: 'var(--go-bright)' }}>
                      {money(change)}
                    </div>
                  </>
                )}
                {short && (
                  <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 11.5, lineHeight: 1.5 }}>
                    {money(due - effective)} short{parts.length ? ' of the balance' : ' of the bill'}.
                  </div>
                )}
              </>
            )}

            {/* On a non-cash tender the keypad says how much of the bill goes
                this way. Without a readout the operator is typing into nothing
                they can see. */}
            {method !== 'cash' && tendered > 0 && (
              <>
                <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                  ON THIS TENDER
                </div>
                <div style={{ marginTop: 5, fontSize: 22, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>
                  {money(Math.min(due, tendered))}
                </div>
                {tendered >= due && (
                  <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)' }}>
                    That is the whole balance — confirm settles it.
                  </div>
                )}
              </>
            )}

            {method === 'points' && (
              <div style={{ marginTop: 16 }}>
                {!scheme?.running ? (
                  <div style={{ padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.55 }}>
                    The loyalty scheme is not running, so there is nothing to spend. An admin
                    sets an earn rate and what a point is worth.
                  </div>
                ) : !who ? (
                  <div style={{ padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.55 }}>
                    Whose points? This bill costs{' '}
                    <b style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{pointsNeeded}</b>{' '}
                    of them.
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                      IN POINTS
                    </div>
                    <div style={{ marginTop: 5, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                      {who.name || who.phone}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      has {who.points} · this costs {pointsNeeded}
                    </div>
                    {notEnough ? (
                      <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 11.5, lineHeight: 1.5 }}>
                        {pointsNeeded - who.points} points short.
                      </div>
                    ) : (
                      <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.5 }}>
                        No money is taken. It settles a promise the business already owed, and
                        leaves {Math.round((who.points - pointsNeeded) * 100) / 100} points.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {method === 'account' && (
              <div style={{ marginTop: 16 }}>
                {!who ? (
                  <div style={{ padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.55 }}>
                    Whose account is it going on? Nothing is taken now — the bill becomes money
                    they owe, and somebody has to owe it.
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                      ON ACCOUNT
                    </div>
                    <div style={{ marginTop: 5, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                      {who.name || who.phone}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      owes {money(who.owed * 100)} · {money(who.available * 100)} left
                    </div>
                    {noRoom ? (
                      <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--red-dim)', color: 'var(--red-bright)', fontSize: 11.5, lineHeight: 1.5 }}>
                        Only {money(who.available * 100)} left on the limit — this is{' '}
                        {money(due)}.
                      </div>
                    ) : (
                      <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.5 }}>
                        No money is taken. It becomes {money(due)} owed, and leaves{' '}
                        {money(who.available * 100 - due)} on the account.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* TAKE PART OF IT. Offered only when the keyed amount is less than
                the balance — at or above it, the button beneath settles the
                whole bill and a second control saying nearly the same thing is
                how the wrong one gets pressed. */}
            {canPart && (
              <button
                onClick={takePart}
                disabled={busy}
                style={{
                  marginTop: 18, width: '100%', minHeight: 42, borderRadius: 9,
                  background: 'var(--bg-2)', border: '1px solid var(--amber-line)',
                  color: 'var(--amber-bright)', fontSize: 13, fontWeight: 700, textAlign: 'center',
                }}
              >
                Take {money(partAmount)} this way — {money(due - partAmount)} left
              </button>
            )}

            <button
              onClick={confirm}
              disabled={busy || short}
              /* A stable name: the label now says what is BLOCKING the payment
                 when something is, so the word "Confirm" is not always on it. */
              aria-label="Take the payment"
              style={{
                marginTop: canPart ? 8 : 18, width: '100%', minHeight: 46, borderRadius: 9,
                background: busy || short ? 'var(--bg-2)' : 'var(--go)',
                color: busy || short ? 'var(--text-faint)' : 'var(--on-go)',
                fontSize: 14, fontWeight: 700, textAlign: 'center',
              }}
            >
              {busy ? 'Recording…'
                : blocker ? blocker
                  : parts.length ? 'Confirm ' + money(due) + ' — settles ' + money(total)
                    : 'Confirm ' + money(total)}
            </button>
            <div style={{ marginTop: 9, fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
              Recorded on this terminal immediately, and sent to the server when there
              is a connection. The receipt number is allocated by the server.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
