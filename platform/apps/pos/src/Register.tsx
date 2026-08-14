import { useCallback, useEffect, useState } from 'react';
import type { Session } from './api';
import * as outbox from './outbox';

/* The cash drawer, on the till — 08-BUILD-STAGES.md stage 1:
 * "A cashier signs in, opens the register with a float, sells, takes cash, and
 *  the drawer reconciles at close with a real over/short figure."
 *
 * It lives on the FLOOR, under the tables, because that is where the cashier
 * is standing at the end of a shift. Putting the drawer behind Reports would
 * have made the whole thing unreachable by the only rank that uses it — the
 * reports are manager-only and a cashier is rank 2.
 *
 * The expected figure is the SERVER's, from the ledger, refreshed as sales
 * land. It is deliberately shown BEFORE the count is entered rather than after:
 * a cashier who has to guess what the drawer should hold cannot tell a genuine
 * shortfall from their own arithmetic.
 *
 * Open and close queue through the outbox like every other operation that moves
 * money, so a register can be closed with the network down.
 */

const MONO = "'JetBrains Mono',monospace";

interface Drawer {
  open: boolean;
  drawerId?: string;
  openedAt?: string;
  openedBy?: string | null;
  float?: string;
  takings?: string;
  expected?: string;
}

export function Register({ session, onQueued }: { session: Session; onQueued: () => void | Promise<void> }) {
  const [d, setD] = useState<Drawer | null>(null);
  const [mode, setMode] = useState<'idle' | 'open' | 'close'>('idle');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/outlet/${session.outletId}/drawer`, {
        headers: { authorization: 'Bearer ' + session.token },
      });
      if (!r.ok) throw new Error(String(r.status));
      setD(await r.json() as Drawer);
      setOffline(false);
    } catch {
      /* The drawer state is the server's. With no connection the last known
         figure is kept on screen and marked stale rather than blanked — a
         cashier mid-shift needs to know what it said, and a blank reads as
         "no register open", which would be a lie. */
      setOffline(true);
    }
  }, [session]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(t);
  }, [load]);

  const queue = async (kind: string, payload: unknown, said: string) => {
    await outbox.enqueue(kind, payload);
    setMode('idle'); setValue(''); setNote(said);
    await onQueued();
    setTimeout(() => { void load(); }, 1200);
    setTimeout(() => setNote(''), 6000);
  };

  const amount = Number(value);
  const expected = Number(d?.expected ?? 0);
  const variance = mode === 'close' && value !== '' ? amount - expected : null;

  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid var(--line-soft)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>REGISTER</span>
        <span style={{ flex: 1 }} />
        {offline && <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>stale</span>}
        {d && !offline && (
          <span style={{ fontSize: 9.5, color: d.open ? 'var(--go-bright)' : 'var(--text-faint)' }}>
            {d.open ? 'open' : 'closed'}
          </span>
        )}
      </div>

      {note && (
        <div role="status" style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.5, color: 'var(--go-bright)' }}>{note}</div>
      )}

      {d === null ? (
        <div style={{ marginTop: 7, fontSize: 11, color: 'var(--text-faint)' }}>Checking…</div>
      ) : !d.open ? (
        mode === 'open' ? (
          <Prompt
            label="Float in the drawer"
            value={value} onChange={setValue}
            onCancel={() => { setMode('idle'); setValue(''); }}
            onSubmit={() => void queue('drawer_open', { float: amount },
              'Register opening with a float of ' + amount.toFixed(2) + ' — queued')}
            ok={value !== '' && amount >= 0}
            cta="Open the register"
          />
        ) : (
          <>
            <div style={{ marginTop: 6, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faint)' }}>
              No register is open. Selling still works; cash taken will be counted against
              whichever register is open when it is.
            </div>
            <button onClick={() => setMode('open')}
              style={{ marginTop: 8, width: '100%', padding: '8px 0', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
              Open the register
            </button>
          </>
        )
      ) : mode === 'close' ? (
        <>
          <Line label="Expected in the drawer" value={d.expected ?? '—'} strong />
          <Prompt
            label="Counted"
            value={value} onChange={setValue}
            onCancel={() => { setMode('idle'); setValue(''); }}
            onSubmit={() => void queue('drawer_close', { drawerId: d.drawerId, counted: amount },
              'Register closing at ' + amount.toFixed(2) + ' — queued')}
            ok={value !== '' && amount >= 0}
            cta="Close and count"
          />
          {/* The over/short the cashier is about to post, shown before they
              commit to it — so a mis-keyed count is caught by the person who
              can still recount, not by a manager tomorrow. */}
          {variance !== null && (
            <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: variance === 0 ? 'var(--go-bright)' : Math.abs(variance) < 1 ? 'var(--warn-bright)' : 'var(--red-bright)' }}>
              {variance === 0 ? 'Exact.'
                : (variance > 0 ? 'Over by ' : 'Short by ') + Math.abs(variance).toFixed(2)}
            </div>
          )}
        </>
      ) : (
        <>
          <Line label="Float" value={d.float ?? '—'} />
          <Line label="Taken since" value={d.takings ?? '—'} />
          <Line label="Should be in the drawer" value={d.expected ?? '—'} strong />
          <div style={{ marginTop: 3, fontSize: 9.5, color: 'var(--text-faint)' }}>
            {d.openedBy ? 'opened by ' + d.openedBy : ''}
            {d.openedAt && ' at ' + new Date(d.openedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </div>
          <button onClick={() => { setMode('close'); setValue(''); }}
            style={{ marginTop: 8, width: '100%', padding: '8px 0', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
            Close and count
          </button>
        </>
      )}
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ marginTop: 5, display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ flex: 1, fontSize: 10.5, color: strong ? 'var(--text-muted)' : 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: strong ? 13 : 11.5, fontWeight: strong ? 700 : 500, fontFamily: MONO, color: strong ? 'var(--text)' : 'var(--text-dim)' }}>{value}</span>
    </div>
  );
}

function Prompt({ label, value, onChange, onSubmit, onCancel, ok, cta }: {
  label: string; value: string; onChange: (v: string) => void;
  onSubmit: () => void; onCancel: () => void; ok: boolean; cta: string;
}) {
  return (
    <div style={{ marginTop: 7 }}>
      <label style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
        {label.toUpperCase()}
      </label>
      <input
        autoFocus inputMode="decimal" value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && ok) onSubmit(); }}
        aria-label={label}
        style={{ marginTop: 3, width: '100%', height: 32, padding: '0 9px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--amber-line)', color: 'var(--text)', fontSize: 13, fontFamily: MONO, textAlign: 'right' }}
      />
      <div style={{ marginTop: 7, display: 'flex', gap: 6 }}>
        <button onClick={onSubmit} disabled={!ok}
          style={{ flex: 1, padding: '7px 0', borderRadius: 7, fontSize: 11.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          {cta}
        </button>
        <button onClick={onCancel}
          style={{ padding: '7px 11px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
