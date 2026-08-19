import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Sync & Devices — 02-POS-SPEC §2 (`sync`), 08-BUILD-STAGES §28.
 *
 * THE SCREEN LEADS WITH SILENCE, because silence is the only honest signal it
 * has. Writes waiting to be replayed sit in each till's own outbox until that
 * till reconnects — that is what makes the register work offline, and it means
 * this server cannot count them. A "0 pending" tile would be a confident number
 * about the one thing here that is unknowable. So what it says instead is which
 * paired devices have gone quiet WHILE OTHERS ARE TALKING, which is a real
 * finding, and it says the rest out loud rather than implying it.
 *
 * REPLAY WAIT AND CLOCK DRIFT ARE THE SAME SUBTRACTION AND DIFFERENT FACTS.
 * `applied_at − client_at` is how long an op waited PLUS however wrong that
 * device's clock is. The server separates them (backend/src/devices.js) and
 * this screen shows both, because a till ten minutes fast and a till on a bad
 * network look identical in the raw figure and need opposite fixes.
 *
 * THIS MACHINE'S OWN CARD IS FIRST. The question a person opens this screen
 * with is usually "is it me?", and answering it takes one glance rather than
 * finding your own row in a list of six identical tills.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};
const btn = (primary?: boolean): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  color: primary ? '#111214' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

interface Device {
  id: string; label: string; kind: string;
  pairedAt: string | null; addedAt: string; lastSeen: string | null;
  quietForMins: number | null;
  revoked: boolean; revokedAt: string | null;
  pairCode: string | null; pairCodeExpires: string | null;
  platform: string | null; appVersion: string | null; note: string | null;
  ops: number; lastOpAt: string | null; firstOpAt: string | null;
  clockOffsetSecs: number | null; worstReplayWaitSecs: number | null;
}
interface Health {
  devices: Device[];
  paired: number;
  unpairedOpsToday: number;
  silent: Array<{ id: string; label: string; quietForMins: number | null }>;
  opsByKind: Array<{ kind: string; ops: number }>;
  opsByHour: Array<{ hour: string; ops: number }>;
  outbox: { known: boolean; why: string };
  kinds: string[];
  canManage: boolean;
  thisDevice: string | null;
}

const quiet = (mins: number | null) =>
  mins === null ? 'never' : mins < 1 ? 'just now'
    : mins < 60 ? mins + ' min ago'
      : mins < 1440 ? Math.round(mins / 60) + ' h ago'
        : Math.round(mins / 1440) + ' d ago';

/** Seconds, said the way a person would say them. */
const secs = (s: number | null) => {
  if (s === null) return '—';
  const a = Math.abs(s);
  if (a < 60) return s + 's';
  if (a < 3600) return Math.round(s / 60) + ' min';
  return Math.round(s / 360) / 10 + ' h';
};

export function Sync({ session, onPaired }: { session: Session; onPaired: () => void }) {
  /* useMemo, and not decoration. `api.authed(session)` returns a NEW function
     every render, so a `useCallback` that depends on it changes identity every
     render too, and the `useEffect` that loads on it fires on every render —
     an endless fetch loop that also resets this form's fields out from under
     whoever is typing in them. Found by a browser check where a filled input
     came back with its old value. */
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('till');
  const [pairing, setPairing] = useState('');
  const [paired, setPaired] = useState<string | null>(api.thisDevice());

  const load = useCallback(async () => {
    try {
      setData(await call<Health>('GET', '/devices'));
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const pair = async () => {
    setBusy('pair'); setError('');
    try {
      const d = await api.pairDevice(session.outletId, pairing.trim().toUpperCase());
      setPaired(d.id);
      setPairing('');
      await load();
      /* THE SESSION IN THE ROOM WAS OPENED BEFORE THIS MACHINE HAD A NAME, so
         it is bound to no device: nothing it goes on to ring up would carry
         one, and revoking the device would not end it — which is the failure
         that matters. Four keystrokes now beats a till that looks paired and
         is not. */
      setTimeout(onPaired, 1500);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  if (error && !data) {
    return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  }
  if (!data) return <div style={{ ...card, color: 'var(--text-muted)' }}>Reading…</div>;

  const me = data.devices.find((d) => d.id === paired);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── this machine ───────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>This machine</div>
        {me ? (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ font: '600 17px/1.3 system-ui', color: 'var(--text)' }}>{me.label}</div>
            <div style={{ font: '400 12px/1.4 system-ui', color: 'var(--text-muted)' }}>
              paired · {me.kind} · {me.ops} operation{me.ops === 1 ? '' : 's'} sent in the last week
            </div>
          </div>
        ) : (
          <>
            <div style={{ font: '400 13px/1.6 system-ui', color: 'var(--text-muted)', maxWidth: 640 }}>
              This machine is not paired. It works exactly as it does now —
              pairing is not a permission, and the PIN is still what opens the till.
              What it adds is a name against everything this machine rings up, and a
              way for a manager to cut it off if it goes missing.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={pairing} onChange={(e) => setPairing(e.target.value.toUpperCase())}
                placeholder="PAIRING CODE" maxLength={6}
                style={{
                  font: `600 16px/1 ${MONO}`, letterSpacing: '.18em', width: 150,
                  padding: '9px 10px', borderRadius: 8, background: 'var(--bg-2)',
                  color: 'var(--text)', border: '1px solid var(--line-2)',
                }} />
              <button type="button" style={btn(true)} disabled={busy === 'pair' || pairing.length < 6}
                onClick={() => void pair()}>
                {busy === 'pair' ? 'Pairing…' : 'Pair this machine'}
              </button>
              <span style={{ font: '400 12px/1.4 system-ui', color: 'var(--text-faint)' }}>
                A manager issues the code below.
              </span>
            </div>
          </>
        )}
        {paired && !me && (
          <div style={{ marginTop: 10, font: '400 12px/1.5 system-ui', color: 'var(--red-bright)' }}>
            This machine holds a pairing this outlet does not recognise — it was
            revoked, or it belongs to another branch. It is being treated as
            unpaired.{' '}
            <button type="button" style={{ ...btn(), padding: '4px 9px' }}
              onClick={() => { api.forgetDevice(); setPaired(null); }}>
              Forget it
            </button>
          </div>
        )}
      </div>

      {/* ── what the server can and cannot see ─────────────────────────── */}
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 230px), 1fr))' }}>
        <div style={card}>
          <div style={h}>Devices gone quiet</div>
          {data.silent.length === 0 ? (
            <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--go-bright)' }}>
              {data.paired === 0
                ? 'No devices paired yet, so there is nothing to be quiet.'
                : 'None. Every paired device has been heard from recently.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {data.silent.map((s) => (
                <div key={s.id} style={{ font: '400 13px/1.4 system-ui', color: 'var(--red-bright)' }}>
                  {s.label} — last heard {quiet(s.quietForMins)}
                </div>
              ))}
              <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
                Flagged because other devices here ARE talking. When everything is
                quiet the restaurant is shut, and nothing is wrong.
              </div>
            </div>
          )}
        </div>

        <div style={card}>
          <div style={h}>Writes waiting to reach here</div>
          {/* The honest one. Not a zero. */}
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text-faint)' }}>unknown</div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            {data.outbox.why}
          </div>
        </div>

        <div style={card}>
          <div style={h}>Operations, last 24 hours</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text)' }}>
            {data.opsByKind.reduce((a, k) => a + k.ops, 0)}
          </div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)', marginTop: 6 }}>
            {data.opsByKind.slice(0, 4).map((k) => `${k.kind} ${k.ops}`).join(' · ') || 'nothing yet'}
          </div>
          {data.unpairedOpsToday > 0 && (
            <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--warn-bright)', marginTop: 6 }}>
              {data.unpairedOpsToday} of them came from a machine nobody has paired, so
              they carry no device. Pairing the tills is what makes that number fall.
            </div>
          )}
        </div>
      </div>

      {/* ── the register of devices ────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={h}>Devices</div>
          {data.canManage && (
            <button type="button" style={btn(true)} onClick={() => setAdding(!adding)}>
              {adding ? 'Cancel' : 'Add a device'}
            </button>
          )}
        </div>

        {adding && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap',
            padding: '10px 0 14px' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>Label</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder="Front counter"
                style={{ font: '400 14px/1 system-ui', padding: '8px 9px', borderRadius: 8,
                  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)' }} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}
                style={{ font: '400 14px/1 system-ui', padding: '8px 9px', borderRadius: 8,
                  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)' }}>
                {data.kinds.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <button type="button" style={btn(true)} disabled={busy === 'add' || !label.trim()}
              onClick={() => void act('add', async () => {
                await call('POST', '/devices', { label: label.trim(), kind });
                setLabel(''); setAdding(false);
              })}>
              Create and issue a code
            </button>
          </div>
        )}

        {data.devices.length === 0 ? (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
            No devices yet. Until one is added, every operation arrives with no machine
            against it — which is not an error, only a thinner audit trail.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {data.devices.map((d) => (
              <div key={d.id} style={{
                padding: '11px 12px', borderRadius: 10,
                background: d.id === paired ? 'var(--bg-3)' : 'var(--bg-2)',
                border: '1px solid ' + (d.revoked ? 'var(--red)' : 'var(--line)'),
                opacity: d.revoked ? 0.75 : 1,
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ font: '600 14px/1.3 system-ui', color: 'var(--text)' }}>{d.label}</span>
                  <span style={{ font: '400 11px/1.3 system-ui', color: 'var(--text-faint)' }}>{d.kind}</span>
                  {d.id === paired && (
                    <span style={{ font: '600 10px/1.6 system-ui', letterSpacing: '.06em',
                      padding: '1px 6px', borderRadius: 5, background: 'var(--amber)', color: '#111214' }}>
                      THIS MACHINE
                    </span>
                  )}
                  {d.revoked && (
                    <span style={{ font: '600 10px/1.6 system-ui', letterSpacing: '.06em',
                      padding: '1px 6px', borderRadius: 5, background: 'var(--red)', color: '#fff' }}>
                      REVOKED
                    </span>
                  )}
                  {!d.revoked && !d.pairedAt && (
                    <span style={{ font: '400 11px/1.3 system-ui', color: 'var(--warn-bright)' }}>
                      waiting to be paired
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 7,
                  font: `400 12px/1.4 ${MONO}`, color: 'var(--text-muted)' }}>
                  <span>last heard {quiet(d.quietForMins)}</span>
                  <span>{d.ops} ops / 7 days</span>
                  <span title="How long the slowest operation waited in this device's outbox, with its own clock error taken off.">
                    worst replay wait {secs(d.worstReplayWaitSecs)}
                  </span>
                  <span title="How far this device's clock is from the server's. Negative means it runs fast.">
                    clock {d.clockOffsetSecs === null ? '—'
                      : Math.abs(d.clockOffsetSecs) < 5 ? 'in step'
                        : secs(d.clockOffsetSecs) + (d.clockOffsetSecs < 0 ? ' fast' : ' slow')}
                  </span>
                  {d.appVersion && <span>v{d.appVersion}</span>}
                </div>
                {d.note && (
                  <div style={{ font: '400 12px/1.4 system-ui', color: 'var(--text-faint)', marginTop: 4 }}>
                    {d.note}
                  </div>
                )}

                {d.pairCode && (
                  <div style={{ marginTop: 9, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ font: `700 20px/1 ${MONO}`, letterSpacing: '.2em',
                      color: 'var(--amber-bright)' }}>{d.pairCode}</span>
                    <span style={{ font: '400 11px/1.4 system-ui', color: 'var(--text-faint)' }}>
                      Type this into the device&rsquo;s own Sync screen. Single use, and it
                      expires — a code on a whiteboard for a fortnight is a way in.
                    </span>
                  </div>
                )}

                {data.canManage && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    {!d.revoked && (
                      <button type="button" style={btn()} disabled={!!busy}
                        onClick={() => void act('code' + d.id, () =>
                          call('POST', `/devices/${d.id}/code`, {}))}>
                        {d.pairCode ? 'New code' : 'Issue a pairing code'}
                      </button>
                    )}
                    {d.revoked ? (
                      <button type="button" style={btn()} disabled={!!busy}
                        onClick={() => void act('restore' + d.id, () =>
                          call('POST', `/devices/${d.id}/restore`, {}))}>
                        Bring it back
                      </button>
                    ) : (
                      <button type="button" disabled={!!busy}
                        style={{ ...btn(), color: 'var(--red-bright)', borderColor: 'var(--red)' }}
                        onClick={() => void act('revoke' + d.id, () =>
                          call('POST', `/devices/${d.id}/revoke`, {}))}>
                        Revoke
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 12, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)' }}>
          Revoking ends every session that device is holding, straight away — a till
          lost at seven o&rsquo;clock stops there rather than at midnight. What it cannot
          do is stop somebody who has the machine and knows a PIN: they can clear its
          storage and sign in again as an unpaired device. The PIN and the audit trail
          are the controls; this is the kill switch and the name on the work.
        </div>
      </div>

      {error && (
        <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>
      )}
    </div>
  );
}
