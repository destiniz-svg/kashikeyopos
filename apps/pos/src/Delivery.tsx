import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Delivery & QR — 02-POS-SPEC.md §2 (`delivery`):
 * "Aggregator and QR channel orders, rider dispatch, stage tracking."
 *
 * THE OLDEST UNANSWERED ORDER IS THE HEADLINE. A count of five waiting says
 * nothing; "the oldest has been there eleven minutes" is the difference between
 * a busy service and a guest about to walk out. So the wait is in the largest
 * type on the screen, and it reddens as it grows.
 *
 * ACCEPTING IS ONE PRESS AND IT MEANS SOMETHING. It creates the ticket and
 * fires the round at the kitchen — the same path a waiter's terminal takes —
 * so pressing it puts food on the pass rather than moving a row between two
 * lists. The button says so.
 *
 * TURNING ONE DOWN NEEDS A SENTENCE. "No" leaves a guest staring at a phone
 * with nothing to do next; "we have run out of cola" is something they can act
 * on, and it is what their own screen will read back to them.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (s: string) =>
  new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface Line { itemId: string; qty: number; note: string | null }
interface Order {
  id: string; at: string; channel: 'dine_in' | 'takeaway' | 'delivery';
  source: 'qr' | 'phone' | 'aggregator';
  tableNo: string | null; address: string | null; extRef: string | null;
  name: string | null; phone: string | null; promo: string | null; fee: number;
  lines: Line[]; items: number; ticketId: string | null;
  acceptedAt: string | null; rejectedAt: string | null; rejectedReason: string | null;
  rider: string | null; dispatchedAt: string | null; deliveredAt: string | null;
  stage: string; waitingMins: number | null;
}
interface Data {
  waiting: Order[]; kitchen: Order[]; riding: Order[]; done: Order[];
  totals: { waiting: number; oldestWait: number; riding: number };
}
interface Item { id: string; name: string; price: number }

const WHERE = (o: Order) =>
  o.channel === 'delivery' ? (o.address || 'delivery')
    : o.channel === 'takeaway' ? 'takeaway'
      : 'table ' + o.tableNo;
const FROM = { qr: 'from the table', phone: 'by telephone', aggregator: 'aggregator' };

export function Delivery({ session, toast}: {
  /* The terminal's shared toast (src/ui.tsx). Optional, so this module
     still speaks when it is rendered on its own. */
  toast?: (t: string) => void; session: Session }) {
  const [data, setData] = useState<Data | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [rejecting, setRejecting] = useState<Order | null>(null);
  const [dispatching, setDispatching] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try { setData(await call<Data>('GET', '/delivery')); setError(''); }
    catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the board.');
      setData(null);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);
  /* An order waiting is a clock running. */
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 20000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    (async () => {
      try {
        const s = await call<{ items?: Item[] }>('GET', '/snapshot');
        setItems(s.items ?? []);
      } catch { setItems([]); }
    })();
  }, [call]);

  /* Routed to the terminal's toast when one is supplied (src/ui.tsx), and to
     the module's own banner when it is not. A confirmation belongs at the
     bottom of the SCREEN rather than at the top of one card: the operator who
     just pressed Save is looking at the thing they saved, not at the header.
     Errors are deliberately NOT routed here — those stay in the form, beside
     the field that has to change, until somebody changes it. */
  const say = (t: string) => {
    if (toast) { toast(t); return; }
    setFlash(t); setTimeout(() => setFlash(''), 8000);
  };
  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const accept = (o: Order) => act(async () => {
    const r = await call<{ message?: string; already?: boolean }>(
      'POST', `/delivery/${o.id}/accept`, {});
    say(r.already ? 'Already on the pass.' : (r.message || 'On the pass.'));
  }, '');

  const wait = data?.totals.oldestWait ?? 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Orders in</span>
        {data && (
          <>
            <span>
              <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
                LONGEST WAIT
              </span>
              {/* The figure that decides whether somebody is about to walk out. */}
              <span style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: wait >= 10 ? 'var(--stop-bright)' : wait >= 5 ? 'var(--warn-bright)' : 'var(--text)' }}>
                {data.totals.waiting ? wait + ' min' : '—'}
              </span>
            </span>
            <Fig label="WAITING" value={String(data.totals.waiting)} />
            <Fig label="WITH RIDERS" value={String(data.totals.riding)} />
          </>
        )}
      </div>

      {(error || flash) && (
        <div style={{ flexShrink: 0, padding: '8px 14px', fontSize: 11.5, lineHeight: 1.5, background: error ? 'var(--stop-dim)' : 'var(--go-dim)', color: error ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
          {error || flash}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 40px' }}>
        {!data ? (
          <div style={{ padding: '40px 4px', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {error ? '' : 'Loading…'}
          </div>
        ) : (
          <>
            <SubHead>Waiting for somebody to say yes</SubHead>
            {!data.waiting.length ? (
              <div style={{ padding: '18px 4px 24px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 580 }}>
                Nothing waiting. A round sent from a guest&apos;s phone arrives here, and accepting
                it puts the food on the pass — it is not a note somebody has to copy into the
                till afterwards.
              </div>
            ) : data.waiting.map((o) => (
              <div key={o.id} style={{ marginBottom: 9, padding: 12, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid ' + ((o.waitingMins ?? 0) >= 10 ? 'var(--stop)' : 'var(--line-soft)') }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    {WHERE(o)}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {FROM[o.source]} · {clock(o.at)}
                    {o.name && ' · ' + o.name}
                    {o.phone && ' · ' + o.phone}
                    {o.extRef && ' · ' + o.extRef}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, fontFamily: MONO, color: (o.waitingMins ?? 0) >= 10 ? 'var(--stop-bright)' : 'var(--text-muted)' }}>
                    {o.waitingMins} min
                  </span>
                </div>
                <div style={{ marginTop: 7, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {o.lines.map((l, i) => (
                    <span key={i} style={{ padding: '3px 8px', borderRadius: 6, fontSize: 11.5, background: 'var(--bg-2)', color: 'var(--text)' }}>
                      <b style={{ fontFamily: MONO }}>{l.qty}</b>{' '}
                      {items.find((x) => x.id === l.itemId)?.name ?? l.itemId}
                      {l.note && <span style={{ color: 'var(--text-faint)' }}> · {l.note}</span>}
                    </span>
                  ))}
                  {o.promo && (
                    <span style={{ padding: '3px 8px', borderRadius: 6, fontSize: 11, fontFamily: MONO, background: 'var(--bg-2)', color: 'var(--text-faint)' }}>
                      {o.promo}
                    </span>
                  )}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button disabled={busy} onClick={() => accept(o)}
                    style={{ padding: '8px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                    Accept — send it to the kitchen
                  </button>
                  <button disabled={busy} onClick={() => setRejecting(o)}
                    style={{ padding: '8px 13px', borderRadius: 7, fontSize: 12, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                    Turn it down
                  </button>
                  {o.fee > 0 && (
                    <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                      delivery fee {mvr(o.fee)}
                    </span>
                  )}
                </div>
              </div>
            ))}

            <Take busy={busy} items={items}
              onTake={(b) => act(() => call('POST', '/delivery', b),
                'Taken. It is on the board — accept it to send it to the kitchen.')} />

            {data.kitchen.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <SubHead>Being cooked</SubHead>
                {data.kitchen.map((o) => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ width: 62, fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      {clock(o.at)}
                    </span>
                    <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>
                      {WHERE(o)}
                      <span style={{ marginLeft: 7, fontSize: 10.5, color: 'var(--text-faint)' }}>
                        {o.items} {o.items === 1 ? 'item' : 'items'}
                        {o.name && ' · ' + o.name}
                      </span>
                    </span>
                    {o.channel === 'delivery' && (
                      <button disabled={busy} onClick={() => setDispatching(o)}
                        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                        Give it to a rider
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {data.riding.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <SubHead>Out with a rider</SubHead>
                {data.riding.map((o) => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>
                      {o.address}
                      <span style={{ marginLeft: 7, fontSize: 10.5, color: 'var(--text-faint)' }}>
                        {o.rider} · left {o.dispatchedAt ? clock(o.dispatchedAt) : ''}
                      </span>
                    </span>
                    <button disabled={busy}
                      onClick={() => act(() => call('POST', `/delivery/${o.id}/delivered`, {}),
                        'Delivered.')}
                      style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11.5, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                      It arrived
                    </button>
                  </div>
                ))}
              </div>
            )}

            {data.done.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <SubHead>Finished with</SubHead>
                {data.done.map((o) => (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 2px', borderBottom: '1px solid var(--line-soft)', color: 'var(--text-faint)' }}>
                    <span style={{ width: 62, fontSize: 10.5, fontFamily: MONO }}>{clock(o.at)}</span>
                    <span style={{ flex: 1, fontSize: 11.5 }}>
                      {WHERE(o)}
                      {o.rejectedReason && ' · ' + o.rejectedReason}
                    </span>
                    <span style={{ width: 100, textAlign: 'right', fontSize: 10.5, color: o.rejectedAt ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
                      {o.stage}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {rejecting && (
        <Ask title={'Turn down ' + WHERE(rejecting)} label="Why"
          hint="The guest reads this on their own phone, so it has to be something they can act on."
          action="Turn it down" busy={busy} onClose={() => setRejecting(null)}
          onSubmit={(reason) => act(
            () => call('POST', `/delivery/${rejecting.id}/reject`, { reason }),
            'Turned down. Their phone will say why.').then(() => setRejecting(null))} />
      )}
      {dispatching && (
        <Ask title={'Out to ' + (dispatching.address || 'the address')} label="Rider"
          hint="Named, so somebody can be asked where it got to."
          action="Send it out" busy={busy} onClose={() => setDispatching(null)}
          onSubmit={(rider) => act(
            () => call('POST', `/delivery/${dispatching.id}/dispatch`, { rider }),
            'On its way.').then(() => setDispatching(null))} />
      )}
    </div>
  );
}

/* ── an order the till takes itself ──────────────────────────────────────── */

function Take({ busy, items, onTake }: {
  busy: boolean; items: Item[]; onTake: (b: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<'delivery' | 'takeaway'>('delivery');
  const [source, setSource] = useState<'phone' | 'aggregator'>('phone');
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [extRef, setExtRef] = useState('');
  const [fee, setFee] = useState('');
  const [lines, setLines] = useState<Record<string, number>>({});

  const chosen = Object.entries(lines).filter(([, q]) => q > 0);
  const ok = chosen.length > 0 && (channel !== 'delivery' || address.trim() !== '');

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ marginTop: 6, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
        Take one on the telephone
      </button>
    );
  }

  return (
    <div style={{ marginTop: 10, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <SubHead>Take an order</SubHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 140px), 1fr))', gap: 11, marginTop: 6 }}>
        <L label="Going">
          <select value={channel} aria-label="Going"
            onChange={(e) => setChannel(e.target.value as 'delivery' | 'takeaway')} style={inp}>
            <option value="delivery">out for delivery</option>
            <option value="takeaway">collected</option>
          </select>
        </L>
        <L label="Came from">
          <select value={source} aria-label="Came from"
            onChange={(e) => setSource(e.target.value as 'phone' | 'aggregator')} style={inp}>
            <option value="phone">the telephone</option>
            <option value="aggregator">an aggregator</option>
          </select>
        </L>
        {channel === 'delivery' && (
          <L label="Address" hint="No address, no delivery.">
            <input value={address} onChange={(e) => setAddress(e.target.value)}
              aria-label="Address" style={inp} />
          </L>
        )}
        <L label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            aria-label="Name" style={inp} />
        </L>
        <L label="Phone">
          <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
            aria-label="Their phone" style={{ ...inp, fontFamily: MONO }} />
        </L>
        {source === 'aggregator' && (
          <L label="Their reference" hint="What you quote when you ring them.">
            <input value={extRef} onChange={(e) => setExtRef(e.target.value)}
              aria-label="Their reference" style={{ ...inp, fontFamily: MONO }} />
          </L>
        )}
        {channel === 'delivery' && (
          <L label="Delivery fee (MVR)">
            <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)}
              aria-label="Delivery fee" style={{ ...inp, fontFamily: MONO }} />
          </L>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <SubHead>What they want</SubHead>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {items.map((it) => {
            const q = lines[it.id] ?? 0;
            return (
              <span key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px', borderRadius: 7, background: q > 0 ? 'var(--bg-3)' : 'var(--bg-2)', border: '1px solid ' + (q > 0 ? 'var(--amber-line)' : 'var(--line)') }}>
                <span style={{ fontSize: 11.5, color: 'var(--text)' }}>{it.name}</span>
                <button onClick={() => setLines((l) => ({ ...l, [it.id]: Math.max(0, q - 1) }))}
                  aria-label={'One fewer ' + it.name}
                  style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--bg-2)', color: 'var(--text-muted)' }}>−</button>
                <span style={{ minWidth: 14, textAlign: 'center', fontSize: 12, fontFamily: MONO, color: 'var(--text)' }}>{q}</span>
                <button onClick={() => setLines((l) => ({ ...l, [it.id]: q + 1 }))}
                  aria-label={'One more ' + it.name}
                  style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--bg-2)', color: 'var(--text-muted)' }}>+</button>
              </span>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 13, display: 'flex', gap: 9 }}>
        <button disabled={busy || !ok} onClick={() => {
          onTake({
            channel, source, address: address.trim() || null,
            name: name.trim() || null, phone: phone.trim() || null,
            extRef: extRef.trim() || null, fee: Number(fee) || 0,
            lines: chosen.map(([itemId, qty]) => ({ itemId, qty })),
          });
          setLines({}); setAddress(''); setName(''); setPhone(''); setExtRef(''); setFee('');
          setOpen(false);
        }}
          style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          Put it on the board
        </button>
        <button onClick={() => setOpen(false)}
          style={{ padding: '9px 14px', borderRadius: 7, fontSize: 12, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Never mind
        </button>
      </div>
    </div>
  );
}

/* ── one question, asked properly ────────────────────────────────────────── */

function Ask({ title, label, hint, action, busy, onClose, onSubmit }: {
  title: string; label: string; hint: string; action: string; busy: boolean;
  onClose: () => void; onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState('');
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'var(--scrim)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}
        style={{ width: '100%', maxWidth: 440, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>
          {title}
        </div>
        <div style={{ padding: 16 }}>
          <L label={label} hint={hint}>
            <input value={v} onChange={(e) => setV(e.target.value)}
              aria-label={label} style={inp} autoFocus />
          </L>
          <div style={{ marginTop: 13, display: 'flex', gap: 9 }}>
            <button disabled={busy || v.trim().length < 3} onClick={() => onSubmit(v.trim())}
              style={{ flex: 1, minHeight: 40, borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: v.trim().length >= 3 ? 'var(--go)' : 'var(--bg-2)', color: v.trim().length >= 3 ? 'var(--on-go)' : 'var(--text-faint)' }}>
              {action}
            </button>
            <button onClick={onClose}
              style={{ padding: '0 16px', minHeight: 40, borderRadius: 8, fontSize: 12, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
              Never mind
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

const inp: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5,
};

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{value}</span>
    </span>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: '0 2px 6px', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
      {children}
    </div>
  );
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', marginBottom: 4, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label.toUpperCase()}</span>
      {children}
      {hint && <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}
