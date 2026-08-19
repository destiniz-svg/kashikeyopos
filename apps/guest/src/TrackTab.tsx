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
  /* What the SERVER says the code is worth on this basket. Until this existed,
     the phone accepted any code, showed nothing, sent the string along, and the
     till ignored it — the guest paid full price having been told nothing at
     all. §16's acceptance criterion forbids exactly that. */
  const [quote, setQuote] = useState<{
    ok: boolean; reason?: string; name?: string; discountMvr?: number; note?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);

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

  /* What the till did with a round.
   *
   * This is the link that was missing. A round was posted, the phone kept its
   * server id, and then nothing joined the two: the tracker matched its stage
   * with `find(() => false)` — a predicate that cannot be true — so every round
   * sat on "With the till" for ever however far along the food actually was.
   * The snapshot now carries this table's orders, each naming the ticket it
   * became once the till accepted it, and the stages in the SAME snapshot are
   * keyed by that ticket. */
  const orderFor = (round: SentRound) =>
    snap?.guestOrders?.find((o) => o.id === round.serverId) ?? null;

  /* The stage of a round, as the till projects it. Absent = the till has it but
     the kitchen has not started, which is "Received". */
  const stageOf = (round: SentRound): number => {
    const o = orderFor(round);
    if (!o || !o.ticketId) return 0;
    /* Delivered outruns the kitchen board: the ticket may still say "Ready"
       when the food is already at the door. */
    if (o.stage === 'delivered') return STAGES.length - 1;
    const mine = (snap?.stages ?? []).filter((s) => s.ticket_id === o.ticketId);
    if (!mine.length) return 0;
    /* The LEAST advanced station. A round is not "Ready" while the grill is
       still cooking half of it, and a guest told it is ready and then left
       waiting has been lied to by their own phone. */
    return mine.reduce((lowest, s) => {
      const i = STAGES.indexOf(s.stage as typeof STAGES[number]);
      return Math.min(lowest, i < 0 ? 0 : i);
    }, STAGES.length - 1);
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

          {/* Promo: the phone treats a code as an OFFER, never a fact. It is
              checked against the SAME evaluator the till will use, so what the
              guest is shown is what the till will charge — and a code that will
              not work says why, here, rather than at the counter. Spec §4. */}
          <div style={{ marginTop: 14, display: 'flex', gap: 9 }}>
            <input
              value={promo}
              onChange={(e) => { setPromo(e.target.value.toUpperCase().slice(0, 24)); setQuote(null); }}
              placeholder="Promo code"
              aria-label="Promo code"
              style={{
                flex: 1, height: HIT.input, padding: '0 14px', borderRadius: 14,
                background: C.surfaceTint, fontSize: 14, color: C.ink, fontFamily: MONO,
              }}
            />
            <button
              disabled={!promo || checking || !cart.length}
              onClick={async () => {
                setChecking(true);
                try { setQuote(await api.quotePromo(promo, goods)); }
                catch { setQuote({ ok: false, reason: 'Could not check that just now.' }); }
                finally { setChecking(false); }
              }}
              style={{
                height: HIT.input, padding: '0 18px', borderRadius: 14,
                background: promo && cart.length ? C.accent : C.surfaceTint,
                color: promo && cart.length ? '#fff' : C.inkFaint,
                fontSize: 14, fontWeight: 700,
              }}
            >{checking ? '…' : 'Check'}</button>
          </div>
          {quote && (
            <div style={{
              marginTop: 9, padding: '11px 13px', borderRadius: 14, fontSize: 13,
              lineHeight: 1.5,
              background: quote.ok ? C.surfaceTint : C.surfaceTint,
              color: quote.ok ? C.ink : C.inkMuted,
            }}>
              {quote.ok ? (
                <>
                  <b>{quote.name}</b> — {money((quote.discountMvr || 0) * 100)} off this round.
                  {quote.note && ' ' + quote.note}
                  <div style={{ marginTop: 4, fontSize: 11.5, color: C.inkFaint }}>
                    The till checks it again when you pay — it is an offer until then.
                  </div>
                </>
              ) : quote.reason}
            </div>
          )}

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
            const order = orderFor(round);
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

                {/* A round the till turned down. Before this it stayed on
                    "With the till" for ever and a guest sat waiting for a drink
                    nobody was making — so the reason a server typed is read
                    back here, in their words, and the stage list is not drawn
                    because there is no food to follow. */}
                {order?.stage === 'rejected' ? (
                  <div style={{
                    marginTop: 13, padding: '12px 14px', borderRadius: 14,
                    background: C.warnBg, border: '1px solid ' + C.warnBorder,
                    color: C.warnInk, fontSize: 13, lineHeight: 1.55,
                  }}>
                    <b>We could not do this one.</b>
                    {order.rejectedReason ? ' ' + order.rejectedReason : ''}
                    <div style={{ marginTop: 5, fontSize: 12, color: C.inkMuted }}>
                      Nothing has been charged for it. Order something else, or ask a server.
                    </div>
                  </div>
                ) : (
                <>
                {/* Until a server presses accept there is no ticket and no
                    kitchen — the first stage dot alone cannot say that, because
                    it looks identical to "the kitchen has it and has not
                    started". This is the sentence that tells them apart. */}
                {order?.stage === 'waiting for the till' && (
                  <div style={{ marginTop: 11, fontSize: 12.5, color: C.inkMuted, lineHeight: 1.5 }}>
                    Waiting for a server to confirm it.
                  </div>
                )}
                {order?.rider && (
                  <div style={{ marginTop: 11, fontSize: 13, color: C.inkMid, lineHeight: 1.5 }}>
                    {order.deliveredAt
                      ? 'Delivered by ' + order.rider + '.'
                      : 'On its way with ' + order.rider + '.'}
                  </div>
                )}
                {/* Spec §5: the stage list. Dot 26px — complete #2ea44f,
                    current #f4553c with a 4px .15 ring, pending #f0f0f2. */}
                <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {STAGES.map((label, si) => {
                    const done = si < at, now = si === at;
                    return (
                      /* The current stage is marked, not merely coloured: a
                         guest using a screen reader hears where their food is
                         rather than four undifferentiated lines. */
                      <div key={label} aria-current={now ? 'step' : undefined}
                        style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
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
                </>
                )}
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
