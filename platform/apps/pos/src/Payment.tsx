import { useState } from 'react';

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
 */

const MONO = "'JetBrains Mono',monospace";
const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Method = 'cash' | 'card' | 'wallet';

interface Props {
  total: number;                       // laari
  onCancel: () => void;
  onConfirm: (payments: { method: Method; amount: number }[]) => void | Promise<void>;
}

export function Payment({ total, onCancel, onConfirm }: Props) {
  const [method, setMethod] = useState<Method>('cash');
  const [buf, setBuf] = useState('');
  const [busy, setBusy] = useState(false);

  /* The keypad buffer is read as laari — typing 1 2 5 0 means MVR 12.50. A till
     keypad has no decimal point for the same reason a card terminal does not:
     the operator is typing what the guest handed over, fast, and a misplaced
     point is a hundredfold error. */
  const tendered = buf ? Number(buf) : 0;

  // Card and wallet are settled to the exact bill; only cash is tendered over.
  const effective = method === 'cash' ? (tendered || total) : total;
  const change = Math.max(0, effective - total);
  const short = effective < total;

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
      await onConfirm([{ method, amount: total }]);
    } finally {
      setBusy(false);
    }
  };

  const METHODS: { k: Method; label: string }[] = [
    { k: 'cash', label: 'Cash' },
    { k: 'card', label: 'Card' },
    { k: 'wallet', label: 'Wallet' },
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
