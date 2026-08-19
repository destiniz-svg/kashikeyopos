import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Dispatches — 02-POS-SPEC §2 (`dispatches`): "Inter-outlet transfers, both
 * sides of the move."
 *
 * TWO COLUMNS, NOT ONE LIST, because they are two different jobs. What is
 * COMING needs confirming today; what WENT needs chasing, and the second is the
 * one that quietly turns into an argument three weeks later when nobody can
 * remember whether the van arrived. A single chronological list makes somebody
 * read every row to find the two that are theirs.
 *
 * THE RECEIVER PICKS THEIR OWN INGREDIENT, and the form says why: ids are
 * per-outlet, so Malé's beef and Hulhumalé's beef are different rows in
 * different schemas and may not even be the same word. Assuming they match
 * works for exactly as long as one chain sets both branches up from one
 * spreadsheet.
 *
 * A SHORTFALL IS NOT AN ERROR MESSAGE. The quantity box is pre-filled with what
 * was sent and can be changed, and if it is changed the screen says what
 * happens next: the difference sits in the clearing account with this
 * transfer's reference on it until somebody decides whose it is. Making the two
 * numbers agree automatically would be inventing the answer to the only
 * question worth asking.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};
const box: React.CSSProperties = {
  font: `400 14px/1 ${MONO}`, padding: '8px 9px', borderRadius: 8,
  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
};
const btn = (primary?: boolean): React.CSSProperties => ({
  padding: '7px 13px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  color: primary ? '#111214' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

const money = (x: number) =>
  (x + 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (x: number) => Math.round(x * 10000) / 10000;

interface Outlet { id: number; code: string; name: string }
interface Transfer {
  id: string; ref: string; state: string; direction: 'in' | 'out';
  from: Outlet; to: Outlet;
  item: string; unit: string;
  fromIngredient: string; toIngredient: string | null;
  qtySent: number; qtyReceived: number | null; variance: number | null;
  unitCost: number; value: number;
  note: string | null; reason: string | null;
  sentAt: string; sentBy: string | null;
  settledAt: string | null; settledBy: string | null;
}
interface Ingredient { id: string; name: string; unit: string; onHand: number }
interface Board {
  inbound: Transfer[]; outbound: Transfer[];
  waitingOnYou: number; notConfirmed: number; inFlightValue: number;
  clearing: { account: string; why: string };
  destinations: Outlet[]; ingredients: Ingredient[];
  days: number;
}

const STATE: Record<string, { label: string; tone: string }> = {
  sent: { label: 'in flight', tone: 'var(--warn-bright)' },
  received: { label: 'received', tone: 'var(--go-bright)' },
  rejected: { label: 'turned away', tone: 'var(--red-bright)' },
  cancelled: { label: 'cancelled', tone: 'var(--text-faint)' },
};

export function Dispatches({ session }: { session: Session }) {
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ toOutlet: '', ingredientId: '', qty: '', note: '' });
  const [receiving, setReceiving] = useState('');
  const [got, setGot] = useState({ ingredientId: '', qty: '', reason: '' });

  const load = useCallback(async () => {
    try { setData(await call<Board>('GET', '/dispatches')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={{ ...card, color: 'var(--text-muted)' }}>Reading…</div>;

  const openReceive = (t: Transfer) => {
    setReceiving(t.id);
    /* Pre-filled with what was sent and changeable. The default is the common
       case; the change is the one that matters. */
    setGot({ ingredientId: '', qty: String(t.qtySent), reason: '' });
  };

  const row = (t: Transfer) => {
    const st = STATE[t.state] || { label: t.state, tone: 'var(--text-faint)' };
    const other = t.direction === 'in' ? t.from : t.to;
    return (
      <div key={t.id} style={{
        padding: '11px 12px', borderRadius: 10, background: 'var(--bg-2)',
        border: '1px solid ' + (t.state === 'sent' ? 'var(--amber)' : 'var(--line)'),
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ font: '600 14px/1.3 system-ui', color: 'var(--text)' }}>
            {n4(t.qtySent)} {t.unit} {t.item}
          </span>
          <span style={{ font: '400 12px/1.3 system-ui', color: 'var(--text-muted)' }}>
            {t.direction === 'in' ? 'from' : 'to'} {other.name}
          </span>
          <span style={{ font: '400 12px/1.3 system-ui', color: st.tone }}>{st.label}</span>
          <span style={{ flex: 1 }} />
          <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--warn-bright)' }}>
            {money(t.value)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 5,
          font: `400 11px/1.4 ${MONO}`, color: 'var(--text-faint)' }}>
          <span>{t.ref}</span>
          <span>{new Date(t.sentAt).toLocaleString('en-GB',
            { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          {t.sentBy && <span>sent by {t.sentBy}</span>}
          {t.qtyReceived !== null && (
            <span style={{ color: t.variance ? 'var(--red-bright)' : 'var(--go-bright)' }}>
              {n4(t.qtyReceived)} arrived
              {t.variance ? ` (${t.variance > 0 ? '+' : ''}${n4(t.variance)})` : ''}
            </span>
          )}
          {t.reason && <span style={{ color: 'var(--text-muted)' }}>{t.reason}</span>}
        </div>
        {t.note && (
          <div style={{ font: '400 12px/1.4 system-ui', color: 'var(--text-muted)', marginTop: 4 }}>
            {t.note}
          </div>
        )}

        {/* ── confirming what turned up ─────────────────────────────────── */}
        {t.direction === 'in' && t.state === 'sent' && (receiving === t.id ? (
          <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'flex-end',
            flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                Your ingredient
              </span>
              <select value={got.ingredientId} style={{ ...box, font: '400 13px/1 system-ui' }}
                onChange={(e) => setGot({ ...got, ingredientId: e.target.value })}>
                <option value="">choose…</option>
                {data.ingredients.filter((i) => i.unit === t.unit).map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                What arrived ({t.unit})
              </span>
              <input value={got.qty} inputMode="decimal" style={{ ...box, width: 110 }}
                onChange={(e) => setGot({ ...got, qty: e.target.value })} />
            </label>
            {Number(got.qty) !== t.qtySent && (
              <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 170 }}>
                <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>
                  Why the difference
                </span>
                <input value={got.reason} placeholder="one bag was light…"
                  style={{ ...box, width: '100%', font: '400 13px/1 system-ui' }}
                  onChange={(e) => setGot({ ...got, reason: e.target.value })} />
              </label>
            )}
            <button type="button" style={btn(true)} disabled={busy === t.id || !got.ingredientId}
              onClick={() => void act(t.id, () => call('POST', `/dispatches/${t.id}/receive`, {
                ingredientId: got.ingredientId, qty: Number(got.qty),
                reason: got.reason.trim() || undefined,
              }))}>
              Confirm it
            </button>
            <button type="button" style={btn()} onClick={() => setReceiving('')}>Cancel</button>
            {Number(got.qty) !== t.qtySent && (
              <div style={{ width: '100%', font: '400 11px/1.5 system-ui',
                color: 'var(--warn-bright)' }}>
                {n4(t.qtySent)} left {t.from.name} and you are recording {n4(Number(got.qty) || 0)}.
                The difference stays in account {data.clearing.account} with {t.ref} against it
                until somebody says whose it is — nothing here decides that for you.
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} onClick={() => openReceive(t)}>
              Confirm what arrived
            </button>
            <button type="button" disabled={busy === t.id}
              style={{ ...btn(), color: 'var(--red-bright)', borderColor: 'var(--red)' }}
              onClick={() => {
                const reason = window.prompt('Why is it being turned away?');
                if (reason && reason.trim()) {
                  void act(t.id, () => call('POST', `/dispatches/${t.id}/reject`,
                    { reason: reason.trim() }));
                }
              }}>
              Turn it away
            </button>
          </div>
        ))}

        {/* ── the sending end ──────────────────────────────────────────── */}
        {t.direction === 'out' && t.state === 'sent' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center',
            flexWrap: 'wrap' }}>
            <button type="button" style={btn()} disabled={busy === t.id}
              onClick={() => {
                const reason = window.prompt('Why is it being cancelled?');
                if (reason && reason.trim()) {
                  void act(t.id, () => call('POST', `/dispatches/${t.id}/cancel`,
                    { reason: reason.trim() }));
                }
              }}>
              Cancel it
            </button>
            <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
              {other.name} has not confirmed this yet.
            </span>
          </div>
        )}

        {t.direction === 'out' && (t.state === 'rejected' || t.state === 'cancelled') && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center',
            flexWrap: 'wrap' }}>
            <button type="button" style={btn(true)} disabled={busy === t.id}
              onClick={() => void act(t.id, () => call('POST', `/dispatches/${t.id}/take-back`, {}))}>
              Take it back into stock
            </button>
            <span style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
              It is still out of this branch&rsquo;s stock until you do. Nothing at the
              other end can put it back — only this branch can write these books.
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── the two numbers ────────────────────────────────────────────── */}
      <div style={{ ...card, display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={h}>Waiting on you</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`,
            color: data.waitingOnYou ? 'var(--amber-bright)' : 'var(--go-bright)' }}>
            {data.waitingOnYou || 'none'}
          </div>
        </div>
        <div>
          <div style={h}>Sent, not confirmed</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`,
            color: data.notConfirmed ? 'var(--warn-bright)' : 'var(--go-bright)' }}>
            {data.notConfirmed || 'none'}
          </div>
        </div>
        <div>
          <div style={h}>In flight</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text)' }}>
            {money(data.inFlightValue)}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 260, font: '400 11px/1.6 system-ui',
          color: 'var(--text-faint)' }}>
          {data.clearing.why}
        </div>
        <button type="button" style={btn(true)} onClick={() => setSending(!sending)}>
          {sending ? 'Cancel' : 'Send stock somewhere'}
        </button>
      </div>

      {sending && (
        <div style={card}>
          <div style={h}>Send stock to another branch</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>To</span>
              <select value={form.toOutlet} style={{ ...box, font: '400 13px/1 system-ui' }}
                onChange={(e) => setForm({ ...form, toOutlet: e.target.value })}>
                <option value="">choose…</option>
                {data.destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>What</span>
              <select value={form.ingredientId} style={{ ...box, font: '400 13px/1 system-ui' }}
                onChange={(e) => setForm({ ...form, ingredientId: e.target.value })}>
                <option value="">choose…</option>
                {data.ingredients.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} ({n4(i.onHand)} {i.unit})</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>How much</span>
              <input value={form.qty} inputMode="decimal" style={{ ...box, width: 110 }}
                onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 160 }}>
              <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Note</span>
              <input value={form.note} placeholder="they ran short…"
                style={{ ...box, width: '100%', font: '400 13px/1 system-ui' }}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <button type="button" style={btn(true)}
              disabled={busy === 'send' || !form.toOutlet || !form.ingredientId || !form.qty}
              onClick={() => void act('send', async () => {
                await call('POST', '/dispatches', {
                  toOutlet: Number(form.toOutlet), ingredientId: form.ingredientId,
                  qty: Number(form.qty), note: form.note.trim() || undefined,
                });
                setForm({ toOutlet: '', ingredientId: '', qty: '', note: '' });
                setSending(false);
              })}>
              Send it
            </button>
          </div>
          <div style={{ marginTop: 10, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)',
            maxWidth: 720 }}>
            It leaves this branch&rsquo;s stock now, at what it cost here — a transfer is
            not a sale and must not make margin at one end or destroy it at the other.
            It does not arrive anywhere until the other branch confirms it, because
            nothing here can write their books.
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        <div style={card}>
          <div style={h}>Coming here</div>
          {data.inbound.length === 0 ? (
            <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
              Nothing on its way.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 9 }}>{data.inbound.map(row)}</div>
          )}
        </div>
        <div style={card}>
          <div style={h}>Sent from here</div>
          {data.outbound.length === 0 ? (
            <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
              Nothing has gone out.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 9 }}>{data.outbound.map(row)}</div>
          )}
        </div>
      </div>

      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
