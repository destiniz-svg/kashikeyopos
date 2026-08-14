import { useState } from 'react';
import { Api, ApiError, type Snapshot } from './api';
import type { Identity } from './session';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* You tab — spec §7.
 *
 * Not identified: name + `+960`-prefixed mobile inputs (50px, monospace) and an
 * accent save button. Identifying is OPTIONAL everywhere except loyalty, which
 * is why nothing else in this app asks for it.
 *
 * THIS TABLE: call a server, ask for water, ask for the bill. Each posts a
 * request that appears on the floor terminal until acknowledged.
 */

interface Props {
  snap: Snapshot | null;
  table: string;
  api: Api;
  ident: Identity | null;
  setIdent: (i: Identity | null) => void;
  rated: boolean;
  setRated: (r: boolean) => void;
  say: (m: string) => void;
}

export function YouTab({ table, api, ident, setIdent, rated, setRated, say }: Props) {
  const [name, setName] = useState(ident?.name ?? '');
  const [phone, setPhone] = useState(ident?.phone ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [stars, setStars] = useState(0);

  const ACTIONS: { k: 'server' | 'water' | 'bill'; label: string; sub: string }[] = [
    { k: 'server', label: 'Call a server', sub: 'Someone will come to the table' },
    { k: 'water', label: 'Ask for water', sub: 'We will bring a jug over' },
    { k: 'bill', label: 'Ask for the bill', sub: 'A server brings the machine over' },
  ];

  const send = async (kind: 'server' | 'water' | 'bill', label: string) => {
    if (busy) return;
    setBusy(kind);
    setError('');
    try {
      await api.request(table, kind);
      say(label + ' — a server has been notified');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not reach the till. Please catch a server.');
    } finally {
      setBusy('');
    }
  };

  const saveIdentity = () => {
    const n = name.trim();
    if (!n) { setError('A name helps the team know whose table this is.'); return; }
    setError('');
    setIdent({ name: n, phone: phone.trim() });
    say('Thanks, ' + n.split(/\s+/)[0]);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px' }} className="qs">
      <div style={{ fontSize: 22, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.03em' }}>You</div>

      {ident ? (
        /* Identified: the gradient member card. Spec §7 — 22px/700 name, masked
           number, points balance. Points read 0 until the loyalty scheme is
           wired; showing an invented balance would be demo data on a customer's
           screen (10-NO-DEMO-DATA.md §1). */
        <div style={{
          marginTop: 16, padding: 18, borderRadius: 17, background: C.accentGradient,
          color: '#fff', boxShadow: C.accentShadow,
        }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.08em', opacity: .8 }}>MEMBER</div>
          <div style={{ marginTop: 7, fontSize: 22, fontWeight: 700, letterSpacing: '-.02em' }}>{ident.name}</div>
          <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO, opacity: .85 }}>
            {ident.phone ? '+960 •••• ' + ident.phone.replace(/\D/g, '').slice(-4) : 'No mobile on file'}
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 8, fontSize: 13.5, color: C.inkSoft, lineHeight: 1.6, textWrap: 'pretty' }}>
            Leave your name if you would like the team to know whose table this is. It is optional — you can order without it.
          </div>
          <input
            value={name} onChange={(e) => setName(e.target.value.slice(0, 60))}
            placeholder="Your name" aria-label="Your name"
            style={{ marginTop: 14, height: HIT.input, padding: '0 14px', borderRadius: 14, background: C.surfaceTint, fontSize: 14.5, color: C.ink }}
          />
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, height: HIT.input, padding: '0 14px', borderRadius: 14, background: C.surfaceTint }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.inkMuted, fontFamily: MONO, flexShrink: 0 }}>+960</span>
            <input
              value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
              inputMode="numeric" placeholder="Mobile (optional)" aria-label="Your mobile number"
              style={{ fontSize: 14.5, color: C.ink, fontFamily: MONO }}
            />
          </div>
          <button
            onClick={saveIdentity}
            style={{ marginTop: 12, width: '100%', padding: 15, borderRadius: 16, background: C.accent, color: '#fff', fontSize: 14.5, fontWeight: 700, textAlign: 'center', minHeight: HIT.primary }}
          >Save</button>
        </>
      )}

      {/* THIS TABLE */}
      <div style={{ marginTop: 26, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>THIS TABLE</div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {ACTIONS.map((a) => (
          <button
            key={a.k}
            onClick={() => send(a.k, a.label)}
            disabled={!!busy}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px',
              borderRadius: 15, minHeight: HIT.row, background: C.surfaceTint,
              opacity: busy && busy !== a.k ? .5 : 1,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.ink }}>{a.label}</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.inkMuted }}>
                {busy === a.k ? 'Letting them know…' : a.sub}
              </span>
            </span>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke={C.inkGhost} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        ))}
      </div>

      {error && (
        <div style={{ marginTop: 12, padding: '11px 13px', borderRadius: 12, background: C.warnBg, border: '1px solid ' + C.warnBorder, color: C.warnInk, fontSize: 13, lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {/* Rating — spec §7: once, then never again for that visit. */}
      {!rated && (
        <>
          <div style={{ marginTop: 26, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>HOW WAS IT?</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setStars(n)}
                aria-label={n + ' star' + (n > 1 ? 's' : '')}
                style={{ flex: 1, minHeight: HIT.row, borderRadius: 14, background: C.surfaceTint, display: 'grid', placeItems: 'center' }}
              >
                <svg viewBox="0 0 24 24" width="21" height="21" fill={n <= stars ? C.accent : 'none'} stroke={n <= stars ? C.accent : C.disabled} strokeWidth="1.8" strokeLinejoin="round">
                  <path d="M12 2.8l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.5l5.4-.8z" />
                </svg>
              </button>
            ))}
          </div>
          {stars > 0 && (
            <button
              onClick={() => { setRated(true); say('Thank you — that goes straight to the team'); }}
              style={{ marginTop: 12, width: '100%', padding: 15, borderRadius: 16, background: C.accent, color: '#fff', fontSize: 14.5, fontWeight: 700, textAlign: 'center', minHeight: HIT.primary }}
            >Send</button>
          )}
        </>
      )}
    </div>
  );
}
