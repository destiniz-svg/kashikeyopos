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
 * THE ACCOUNT TENDER IS THE ODD ONE OUT. No money changes hands: the customer's
 * debt goes up instead, so the tender needs a customer and the customer needs
 * room on their limit. Both are checked here BEFORE the button is pressed —
 * the server checks them again and is the authority, but a cashier standing in
 * front of a guest should not learn about a credit limit from a refusal.
 *
 * And it is only offered ONLINE. Every other tender can be queued and replayed
 * hours later because nothing about it can turn out to be untrue. A house
 * charge can: the limit is checked when the sale reaches the server, so an
 * offline one could be refused on replay long after the guest has walked out,
 * leaving a meal nobody paid for and no way to find them. A tender that can
 * evaporate is worse than a tender that is unavailable.
 */

const MONO = "'JetBrains Mono',monospace";
const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Method = 'cash' | 'card' | 'wallet' | 'account';

interface Customer {
  id: string; phone: string; name: string | null; company: string | null;
  available: number; owed: number; onAccount: boolean; blocked: boolean;
}

interface Props {
  total: number;                       // laari
  session: Session;
  online: boolean;
  onCancel: () => void;
  onConfirm: (payments: { method: Method; amount: number }[], memberId?: string)
    => void | Promise<void>;
}

export function Payment({ total, session, online, onCancel, onConfirm }: Props) {
  const [method, setMethod] = useState<Method>('cash');
  const [buf, setBuf] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Customer[] | null>(null);
  const [who, setWho] = useState<Customer | null>(null);

  /* Search only while the account tender is showing, and only online. */
  useEffect(() => {
    if (method !== 'account' || !online) return;
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.authed(session)<{ members: Customer[] }>(
          'GET', '/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
        if (!dead) setFound(r.members.filter((m) => m.onAccount));
      } catch { if (!dead) setFound([]); }
    }, 220);
    return () => { dead = true; clearTimeout(t); };
  }, [method, q, online, session]);

  /* The keypad buffer is read as laari — typing 1 2 5 0 means MVR 12.50. A till
     keypad has no decimal point for the same reason a card terminal does not:
     the operator is typing what the guest handed over, fast, and a misplaced
     point is a hundredfold error. */
  const tendered = buf ? Number(buf) : 0;

  // Only cash is tendered over; everything else settles to the exact bill.
  const effective = method === 'cash' ? (tendered || total) : total;
  const change = Math.max(0, effective - total);
  const shortCash = effective < total;
  /* An account charge is blocked by its own arithmetic, not by the keypad. */
  const noRoom = method === 'account' && !!who && who.available * 100 < total;
  const short = shortCash || (method === 'account' && (!who || noRoom));

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
      await onConfirm([{ method, amount: total }],
        method === 'account' && who ? who.id : undefined);
    } finally {
      setBusy(false);
    }
  };

  const METHODS: { k: Method; label: string }[] = [
    { k: 'cash', label: 'Cash' },
    { k: 'card', label: 'Card' },
    { k: 'wallet', label: 'Wallet' },
    ...(online ? [{ k: 'account' as Method, label: 'Account' }] : []),
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

        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {/* Keypad — left */}
          <div style={{ flex: '1 1 260px', minWidth: 240, padding: 16, borderRight: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
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

            {method === 'cash' ? (
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
            ) : method === 'account' ? (
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
                      No house accounts match. An account is opened in Customers &amp; Credit,
                      by an admin — a customer record on its own carries no credit.
                    </div>
                  ) : found.map((m) => {
                    const room = m.available * 100 >= total && !m.blocked;
                    const on = who?.id === m.id;
                    return (
                      <button key={m.id} onClick={() => setWho(m)} disabled={!room}
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
                          {m.blocked ? 'blocked' : money(m.available * 100) + ' left'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ padding: '26px 8px', fontSize: 12, lineHeight: 1.65, color: 'var(--text-faint)' }}>
                {method === 'card'
                  ? 'Take the amount on the card terminal, then confirm here. The sale is recorded against card, and settles to the acquirer batch when it arrives.'
                  : 'Take the amount on the wallet app, then confirm here.'}
              </div>
            )}
          </div>

          {/* Bill — right */}
          <div style={{ flex: '1 1 240px', minWidth: 220, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>TO PAY</div>
            <div style={{ marginTop: 6, fontSize: 26, fontWeight: 700, fontFamily: MONO, color: 'var(--text)', letterSpacing: '-.02em' }}>
              {money(total)}
            </div>

            {method === 'cash' && (
              <>
                <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>TENDERED</div>
                <div style={{ marginTop: 5, fontSize: 22, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>
                  {buf ? money(tendered) : money(total)}
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
                    {money(total - effective)} short of the bill.
                  </div>
                )}
              </>
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
                        Only {money(who.available * 100)} left on the limit — this bill is{' '}
                        {money(total)}.
                      </div>
                    ) : (
                      <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.5 }}>
                        No money is taken. It becomes {money(total)} owed, and leaves{' '}
                        {money(who.available * 100 - total)} on the account.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <button
              onClick={confirm}
              disabled={busy || short}
              style={{
                marginTop: 18, width: '100%', minHeight: 46, borderRadius: 9,
                background: busy || short ? 'var(--bg-2)' : 'var(--go)',
                color: busy || short ? 'var(--text-faint)' : 'var(--on-go)',
                fontSize: 14, fontWeight: 700, textAlign: 'center',
              }}
            >
              {busy ? 'Recording…' : 'Confirm ' + money(total)}
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
