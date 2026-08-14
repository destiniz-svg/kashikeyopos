import { useState } from 'react';
import { ApiError } from './api';

/* The lock screen — 02-POS-SPEC.md §1.4.
 *
 * "A terminal with nobody signed in IS locked." Sign-in is by PIN against staff
 * at this outlet. The countdown on a lockout is SHOWN, not hidden: an operator
 * who does not know why the till will not take their PIN starts power-cycling
 * the terminal mid-service.
 *
 * The lockout itself is enforced in the database (5 attempts / 15 minutes, see
 * backend migration 007) — this screen only reports it. A client-side counter
 * would be reset by a reload, which is not a lockout.
 */
export function Lock({ outletId, onSignIn }: { outletId: number; onSignIn: (pin: string) => Promise<void> }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (value: string) => {
    if (busy || value.length < 4) return;
    setBusy(true);
    setError('');
    try {
      await onSignIn(value);
    } catch (e) {
      setPin('');
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Check the connection.');
    } finally {
      setBusy(false);
    }
  };

  const key = (d: string) => {
    if (busy) return;
    if (d === 'del') { setPin((p) => p.slice(0, -1)); return; }
    const next = (pin + d).slice(0, 8);
    setPin(next);
    // A PIN is a fixed length in practice; submit on the fourth digit so the
    // operator never reaches for a separate Enter key with wet hands.
    if (next.length === 4) void submit(next);
  };

  return (
    <div style={{
      height: '100dvh', display: 'grid', placeItems: 'center',
      background: 'var(--bg)', padding: 20,
    }}>
      <div style={{
        width: '100%', maxWidth: 320, padding: 24, borderRadius: 12,
        background: 'var(--bg-1)', border: '1px solid var(--line)',
        animation: 'kmodal .18s',
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Sign in</div>
        <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--text-faint)' }}>
          {outletId ? 'Outlet ' + outletId : 'No outlet configured on this terminal'}
        </div>

        {/* The buffer, as dots. Never the digits: a till faces the room. */}
        <div style={{ margin: '20px 0', display: 'flex', justifyContent: 'center', gap: 11 }}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} style={{
              width: 12, height: 12, borderRadius: 6,
              background: i < pin.length ? 'var(--amber-bright)' : 'var(--bg-3)',
              display: 'block',
            }} />
          ))}
        </div>

        {error && (
          <div role="alert" style={{
            marginBottom: 14, padding: '9px 11px', borderRadius: 7,
            background: 'var(--red-dim)', color: 'var(--red-bright)',
            fontSize: 11.5, lineHeight: 1.5,
          }}>{error}</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((d, i) => (
            d === '' ? <span key={i} /> : (
              <button
                key={i}
                onClick={() => key(d)}
                disabled={busy}
                aria-label={d === 'del' ? 'Delete' : d}
                style={{
                  minHeight: 48, borderRadius: 9, background: 'var(--bg-2)',
                  border: '1px solid var(--line)', color: 'var(--text)',
                  fontSize: 17, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace",
                  display: 'grid', placeItems: 'center',
                }}
              >
                {d === 'del' ? '⌫' : d}
              </button>
            )
          ))}
        </div>

        {busy && (
          <div style={{ marginTop: 14, textAlign: 'center', fontSize: 11.5, color: 'var(--text-faint)' }}>
            Checking…
          </div>
        )}
      </div>
    </div>
  );
}
