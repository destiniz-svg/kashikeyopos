import { useState } from 'react';
import { Api, ApiError, type Snapshot } from './api';
import type { CartLine, Identity, SentRound } from './session';
import { C, HIT, MONO } from '../../../packages/tokens/guest';
import { STAGES } from './App';

/* Track tab — spec §5, and the cart review the cart bar leads to.
 *
 * Two things live here because they are one flow: what you are about to send,
 * and what you have already sent. The stage of a sent round is the TILL's
 * projection, read from the snapshot — never inferred on the phone from ticket
 * lines it can only half-see.
 */

const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Props {
  snap: Snapshot | null;
  table: string;
  cart: CartLine[];
  setCart: (f: (c: CartLine[]) => CartLine[]) => void;
  sent: SentRound[];
  setSent: (f: (s: SentRound[]) => SentRound[]) => void;
  promo: string;
  setPromo: (p: string) => void;
  api: Api;
  ident: Identity | null;
  say: (m: string) => void;
  onBrowse: () => void;
}

export function TrackTab({ snap, table, cart, setCart, sent, setSent, promo, setPromo, api, ident, say, onBrowse }: Props) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const goods = cart.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const taxLabel = snap?.tax?.code ?? 'GST';

  const setQty = (lineId: string, d: number) =>
    setCart((c) => c
      .map((l) => (l.lineId === lineId ? { ...l, qty: Math.max(0, l.qty + d) } : l))
      .filter((l) => l.qty > 0));

  /* Send the round. The opId is minted HERE and kept with the round, so a
     retry — a timeout, a tap on a dead connection, a guest pressing twice —
     replays the same id and the server returns the original result instead of
     creating a second order. That is the whole of the idempotency story on
     this side; op_log's primary key is the other half. */
  const send = async () => {
    if (!cart.length || sending) return;
    setSending(true);
    setError('');
    const opId = crypto.randomUUID();
    const round: SentRound = { opId, at: Date.now(), lines: cart };
    try {
      const res = await api.sendRound(
        opId, table,
        cart.map((l) => ({ itemId: l.itemId, qty: l.qty, note: l.note })),
        promo || undefined, ident?.name, ident?.phone,
      );
      setSent((s) => s.concat([{ ...round, serverId: res.id }]));
      setCart(() => []);
      say('Sent to the till — a server will confirm it shortly');
    } catch (e) {
      /* The round is NOT discarded on a failure and NOT optimistically shown as
         sent. It stays in the cart with its opId reserved, so the retry is the
         same operation rather than a new one. Telling a guest their food is
         ordered when it is not is the one outcome worth avoiding here. */
      setError(e instanceof ApiError ? e.message : 'We could not reach the till. Your round is still here — try again.');
    } finally {
      setSending(false);
    }
  };

  /* The stage of a round, as the till projects it. Absent = the till has it but
     the kitchen has not started, which is "Received". */
  const stageOf = (round: SentRound): number => {
    const s = snap?.stages?.find(() => false);   // matched by ticket once the till accepts the round
    if (!s) return round.serverId ? 0 : 0;
    const i = STAGES.indexOf(s.stage as typeof STAGES[number]);
    return i < 0 ? 0 : i;
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px' }} className="qs">
      <div style={{ fontSize: 22, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.03em' }}>
        Your order
      </div>

      {/* ── This round, not yet sent ─────────────────────────────────────── */}
      {cart.length > 0 && (
        <>
          <div style={{ marginTop: 20, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>
            THIS ROUND
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {cart.map((l) => (
              <div key={l.lineId} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 0', minHeight: HIT.row, borderBottom: '1px solid ' + C.hairlineSoft }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{l.name}</div>
                  {l.note && <div style={{ marginTop: 3, fontSize: 12, color: C.inkMuted, lineHeight: 1.4 }}>{l.note}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <button onClick={() => setQty(l.lineId, -1)} aria-label={'One less ' + l.name}
                    style={{ width: 27, height: 27, borderRadius: 14, background: C.surfaceTint, color: C.inkMid, display: 'grid', placeItems: 'center' }}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
                  </button>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, minWidth: 16, textAlign: 'center' }}>{l.qty}</span>
                  <button onClick={() => setQty(l.lineId, 1)} aria-label={'One more ' + l.name}
                    style={{ width: 27, height: 27, borderRadius: 14, background: C.surfaceTint, color: C.inkMid, display: 'grid', placeItems: 'center' }}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </div>
                <div style={{ width: 74, textAlign: 'right', fontSize: 13.5, fontWeight: 700, fontFamily: MONO, color: C.inkStrong }}>
                  {money(l.unitPrice * l.qty)}
                </div>
              </div>
            ))}
          </div>

          {/* Promo: the phone treats a code as an OFFER, never a fact. It
              travels with the order and the till decides. Spec §4. */}
          <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
            <input
              value={promo}
              onChange={(e) => setPromo(e.target.value.toUpperCase().slice(0, 24))}
              placeholder="Promo code"
              aria-label="Promo code"
              style={{
                flex: 1, height: HIT.input, padding: '0 14px', borderRadius: 14,
                background: C.surfaceTint, fontSize: 14, color: C.ink, fontFamily: MONO,
              }}
            />
          </div>

          {/* Spec §4: the total is labelled "Goods, before service and {tax}" —
              the phone never quotes a final figure the till has not computed. */}
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 13, color: C.inkSoft }}>
              {'Goods, before service and ' + taxLabel}
            </span>
            <span style={{ fontSize: 19, fontWeight: 800, fontFamily: MONO, color: C.inkStrong, letterSpacing: '-.03em' }}>
              {money(goods)}
            </span>
          </div>

          {error && (
            <div style={{
              marginTop: 12, padding: '11px 13px', borderRadius: 12,
              background: C.warnBg, border: '1px solid ' + C.warnBorder,
              color: C.warnInk, fontSize: 13, lineHeight: 1.5,
            }}>{error}</div>
          )}

          <button
            onClick={send}
            disabled={sending}
            style={{
              marginTop: 14, width: '100%', padding: 15, borderRadius: 16,
              background: sending ? C.disabled : C.accent, color: '#fff',
              fontSize: 15, fontWeight: 700, textAlign: 'center', minHeight: HIT.primary,
              boxShadow: sending ? 'none' : C.accentShadow,
            }}
          >
            {sending ? 'Sending…' : 'Send this round to the kitchen'}
          </button>
          <div style={{ marginTop: 9, fontSize: 12, color: C.inkGhost, lineHeight: 1.5, textAlign: 'center', textWrap: 'pretty' }}>
            A server confirms every round before it reaches the kitchen.
          </div>
        </>
      )}

      {/* ── Rounds already sent, with the till's stage ───────────────────── */}
      {sent.length > 0 && (
        <>
          <div style={{ marginTop: cart.length ? 28 : 20, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>
            SENT
          </div>
          {sent.map((round, i) => {
            const at = stageOf(round);
            return (
              <div key={round.opId} style={{
                marginTop: 12, padding: 15, borderRadius: 16,
                background: C.surface, border: '1px solid ' + C.hairline,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.inkStrong }}>
                    {'Round ' + (i + 1)}
                  </span>
                  <span style={{ fontSize: 12, color: C.inkMuted, fontFamily: MONO }}>
                    {new Date(round.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div style={{ marginTop: 8, fontSize: 13, color: C.inkMid, lineHeight: 1.5 }}>
                  {round.lines.map((l) => l.qty + ' × ' + l.name).join(' · ')}
                </div>

                {/* Spec §5: the stage list. Dot 26px — complete #2ea44f,
                    current #f4553c with a 4px .15 ring, pending #f0f0f2. */}
                <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {STAGES.map((label, si) => {
                    const done = si < at, now = si === at;
                    return (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                        <span style={{
                          width: 26, height: 26, borderRadius: 13, flexShrink: 0,
                          display: 'grid', placeItems: 'center',
                          background: done ? C.success : now ? C.accent : '#f0f0f2',
                          boxShadow: now ? '0 0 0 4px rgba(244,85,60,.15)' : 'none',
                        }}>
                          {done && (
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                        <span style={{
                          fontSize: 13.5, fontWeight: now ? 700 : 500,
                          color: done ? C.inkMid : now ? C.inkStrong : C.inkGhost,
                        }}>
                          {/* Copy written for a guest, not an operator. Spec §5. */}
                          {label === 'Received' ? 'With the till'
                            : label === 'In the kitchen' ? 'In the kitchen'
                              : label === 'Ready' ? 'Plated and waiting to come over'
                                : 'On your table — enjoy'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}

      {!cart.length && !sent.length && (
        <div style={{ padding: '46px 10px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: C.inkGhost, lineHeight: 1.6, textWrap: 'pretty' }}>
            Nothing ordered yet. Anything you add from the menu lands here, and you can follow it to the kitchen.
          </div>
          <button
            onClick={onBrowse}
            style={{
              marginTop: 16, padding: '13px 20px', borderRadius: 16, background: C.accent,
              color: '#fff', fontSize: 14, fontWeight: 700, minHeight: HIT.primary,
            }}
          >Browse the menu</button>
        </div>
      )}
    </div>
  );
}
