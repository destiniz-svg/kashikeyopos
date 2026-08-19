import { useRef, useState } from 'react';
import { ApiError } from './api';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* §1 Sign in — "Mobile number, +960 prefixed, then a one-time code."
 *
 * THE KEYPAD MUST NOT DROP DIGITS ON FAST TYPING, which the spec calls out by
 * name: "buffer input and apply per keystroke, not per render." A six-digit
 * code entered by somebody reading it off another screen arrives in about a
 * second, and a handler that recomputes from stale state loses the fourth
 * digit. So the buffer is a ref — the value that is true the instant a key is
 * pressed — and React state follows it for the drawing.
 *
 * AND THERE IS NO SIGN-UP BUTTON. A member exists because a cashier attached
 * their number to a sale. The screen says so plainly rather than offering a
 * form that would fail.
 */

interface Props {
  onRequest: (phone: string) => Promise<unknown>;
  onSignIn: (phone: string, code: string) => Promise<void>;
}

export function SignIn({ onRequest, onSignIn }: Props) {
  const [phone, setPhone] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);

  /* The authoritative code. State is a copy for rendering. */
  const buffer = useRef('');
  const [code, setCode] = useState('');

  const ask = async () => {
    setBusy(true); setError(''); setHint('');
    try {
      await onRequest(phone);
      setStage('code');
      setHint('We have sent you a code.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        /* Not an error the guest can fix, and not a dead end either: the
           counter is the other door, and saying so is the whole point. */
        setStage('code');
        setHint(e.message);
      } else {
        setError(e instanceof ApiError ? e.message : 'We could not do that just now.');
      }
    } finally { setBusy(false); }
  };

  const press = (d: string) => {
    if (buffer.current.length >= 6) return;
    buffer.current += d;
    setCode(buffer.current);
    if (buffer.current.length === 6) void submit(buffer.current);
  };
  const back = () => { buffer.current = buffer.current.slice(0, -1); setCode(buffer.current); };

  const submit = async (value: string) => {
    setBusy(true); setError('');
    try {
      await onSignIn(phone, value);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
      buffer.current = '';
      setCode('');
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      minHeight: '100dvh', background: C.appBg, color: '#fff',
      fontFamily: "'Instrument Sans',system-ui,sans-serif",
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '28px 24px calc(28px + env(safe-area-inset-bottom))',
    }}>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.03em' }}>
        Your card
      </div>
      <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.6, color: 'rgba(255,255,255,.66)', textWrap: 'pretty' }}>
        {stage === 'phone'
          ? 'Sign in with the mobile number you gave at the restaurant.'
          : 'Enter the six-digit code.'}
      </div>

      {stage === 'phone' ? (
        <>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              height: HIT.input, padding: '0 13px', borderRadius: 14,
              display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 15,
              background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.7)',
            }}>+960</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 7))}
              inputMode="numeric" autoFocus aria-label="Mobile number"
              placeholder="777 9999"
              style={{
                flex: 1, height: HIT.input, padding: '0 15px', borderRadius: 14,
                background: 'rgba(255,255,255,.08)', color: '#fff',
                fontSize: 17, fontFamily: MONO, letterSpacing: '.04em',
              }}
            />
          </div>
          <button
            onClick={ask} disabled={phone.length !== 7 || busy}
            style={{
              marginTop: 16, width: '100%', minHeight: HIT.primary, borderRadius: 16,
              background: phone.length === 7 ? C.accent : 'rgba(255,255,255,.12)',
              color: phone.length === 7 ? '#fff' : 'rgba(255,255,255,.4)',
              fontSize: 15, fontWeight: 700,
            }}
          >{busy ? 'One moment…' : 'Send me a code'}</button>
        </>
      ) : (
        <>
          <div style={{ marginTop: 24, display: 'flex', gap: 9, justifyContent: 'center' }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} style={{
                width: 42, height: 54, borderRadius: 13, display: 'grid', placeItems: 'center',
                background: 'rgba(255,255,255,.08)',
                border: '1px solid ' + (code.length === i ? C.accent : 'transparent'),
                fontFamily: MONO, fontSize: 22, fontWeight: 700,
              }}>{code[i] ?? ''}</span>
            ))}
          </div>

          <div style={{
            marginTop: 22, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10,
          }}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
              k === '' ? <span key={i} /> : (
                <button key={i}
                  onClick={() => (k === '⌫' ? back() : press(k))}
                  aria-label={k === '⌫' ? 'Delete' : k}
                  style={{
                    minHeight: 58, borderRadius: 16, background: 'rgba(255,255,255,.08)',
                    color: '#fff', fontSize: k === '⌫' ? 18 : 22, fontWeight: 600,
                    fontFamily: k === '⌫' ? 'inherit' : MONO,
                  }}>{k}</button>
              )
            ))}
          </div>

          <button onClick={() => { setStage('phone'); buffer.current = ''; setCode(''); setError(''); }}
            style={{
              marginTop: 16, minHeight: HIT.row, fontSize: 13.5,
              color: 'rgba(255,255,255,.6)', background: 'transparent',
            }}>Use a different number</button>
        </>
      )}

      {hint && (
        <div style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,.66)', textWrap: 'pretty' }}>
          {hint}
        </div>
      )}
      {error && (
        <div style={{
          marginTop: 14, padding: '12px 14px', borderRadius: 14, fontSize: 13.5,
          lineHeight: 1.6, background: 'rgba(244,85,60,.14)', color: '#ffb9ab',
          textWrap: 'pretty',
        }}>{error}</div>
      )}

      <div style={{ marginTop: 26, fontSize: 12.5, lineHeight: 1.65, color: 'rgba(255,255,255,.42)', textWrap: 'pretty' }}>
        There is no sign-up. You become a member the first time a server adds your
        number at the counter — ask next time you are in.
      </div>
    </div>
  );
}
