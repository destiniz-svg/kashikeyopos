import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { DataGrid } from './DataGrid';
import { Skeleton } from './ui';

/* Outlets — 02-POS-SPEC §2 (`branches`): "Locations, tax profiles, printers,
 * stock sub-locations."
 *
 * THIS SCREEN ADDS NO ENDPOINT. It is three answers that already exist, put
 * side by side: what this branch IS (settings), what it prints on (devices),
 * and — at rank 5 only — the other branches, through the estate aggregate. A
 * fourth endpoint returning the same rows in a fourth shape is how two screens
 * come to disagree about a service charge.
 *
 * WHAT AN ADMIN SEES IS ONE BRANCH, AND THAT IS THE TENANCY MODEL WORKING, not
 * a missing feature. `chain.outlet` is guarded by a policy that matches this
 * outlet's row and nobody else's; another branch is not filtered out of a
 * list, it is unreachable on this connection. Only rank 5, on the read-only
 * reporting role, sees across — and what it gets back is sums, never rows.
 *
 * PROVISIONING IS NOT OFFERED, and the reason is shown rather than hidden
 * behind a button that fails. Creating an outlet runs `CREATE SCHEMA` and
 * `CREATE ROLE`; the application has never held a connection that can do
 * either, and it should not start. The command is printed so somebody with the
 * deploy console can run it.
 *
 * PRINTERS ARE DEVICES. There is no separate printer register and there should
 * not be: a printer is a machine that gets paired, revoked and goes quiet like
 * any other, so it lives on Sync & Devices and appears here as a summary.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};
const row: React.CSSProperties = {
  display: 'flex', gap: 12, padding: '6px 0', font: '400 13px/1.4 system-ui',
};
const key: React.CSSProperties = { width: 160, flex: '0 0 160px', color: 'var(--text-faint)' };

interface Settings {
  outlet: {
    id: number; code: string; name: string; currency: string; tz: string;
    servicePct: number; cashRoundLaari: number; tables: number;
    active: boolean; createdAt: string;
    address: string | null; phone: string | null; tin: string | null;
  };
  tax: Array<{ code: string; rate: number; from: string; live: boolean; scheduled: boolean }>;
  canEdit: boolean;
}
interface Devices {
  devices: Array<{ id: string; label: string; kind: string; revoked: boolean;
    pairedAt: string | null; quietForMins: number | null }>;
}
interface EstateDay {
  date: string;
  outlets: Array<{ outlet_id: number; outlet: string; code: string;
    revenue: string; covers: string; bills: string; last_sale_at: string | null }>;
}

export function Branches({ session, onGo }: { session: Session; onGo: (m: string) => void }) {
  const call = useMemo(() => api.authed(session), [session]);
  const chain = useMemo(() => api.chainAuthed(session), [session]);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<Devices | null>(null);
  const [estate, setEstate] = useState<EstateDay | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        call<Settings>('GET', '/settings'),
        call<Devices>('GET', '/devices'),
      ]);
      setSettings(s);
      setDevices(d);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    /* Rank 5 only, and it is a real cross-outlet read: audited as group scope,
       aggregates only. A failure here is not a failure of the screen. */
    if (session.rank >= 5) {
      try { setEstate(await chain<EstateDay>('GET', '/estate/day')); }
      catch { /* the branch's own half stands */ }
    }
  }, [call, chain, session.rank]);

  useEffect(() => { void load(); }, [load]);

  if (error && !settings) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!settings) return <div style={card}><Skeleton /></div>;

  const o = settings.outlet;
  const printers = (devices?.devices || []).filter((d) => d.kind === 'printer' && !d.revoked);
  const live = settings.tax.filter((t) => t.live);
  const missing: string[] = [];
  if (!o.address) missing.push('a registered address');
  if (!o.tin) missing.push('a TIN');
  if (live.length === 0) missing.push('a tax rate in force');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={h}>This branch</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ font: '600 20px/1.2 system-ui', color: 'var(--text)' }}>{o.name}</span>
          <span style={{ font: `400 13px/1.2 ${MONO}`, color: 'var(--text-faint)' }}>{o.code}</span>
          <span style={{ font: '400 12px/1.2 system-ui',
            color: o.active ? 'var(--go-bright)' : 'var(--red-bright)' }}>
            {o.active ? 'trading' : 'closed'}
          </span>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={row}>
            <span style={key}>Address</span>
            <span style={{ color: o.address ? 'var(--text-dim)' : 'var(--warn-bright)' }}>
              {o.address || 'not entered — a GST receipt has to carry it'}
            </span>
          </div>
          <div style={row}>
            <span style={key}>TIN</span>
            <span style={{ color: o.tin ? 'var(--text-dim)' : 'var(--warn-bright)',
              fontFamily: o.tin ? MONO : undefined }}>
              {o.tin || 'not entered — receipts printed without it are not compliant'}
            </span>
          </div>
          <div style={row}>
            <span style={key}>Phone</span>
            <span style={{ color: 'var(--text-dim)' }}>{o.phone || '—'}</span>
          </div>
          <div style={row}>
            <span style={key}>Timezone</span>
            <span style={{ color: 'var(--text-dim)' }}>
              {o.tz} — decides which business day a sale after midnight belongs to
            </span>
          </div>
          <div style={row}>
            <span style={key}>Floor</span>
            <span style={{ color: 'var(--text-dim)' }}>{o.tables} tables</span>
          </div>
          <div style={row}>
            <span style={key}>Service charge</span>
            <span style={{ color: 'var(--text-dim)' }}>{o.servicePct}% on the goods, and taxable</span>
          </div>
          <div style={row}>
            <span style={key}>Cash rounding</span>
            <span style={{ color: 'var(--text-dim)' }}>
              {o.cashRoundLaari === 0
                ? 'none — cash bills are taken to the laari'
                : o.cashRoundLaari + ' laari, on cash bills only'}
            </span>
          </div>
          <div style={row}>
            <span style={key}>Tax profile</span>
            <span style={{ color: live.length ? 'var(--text-dim)' : 'var(--warn-bright)' }}>
              {live.length
                ? live.map((t) => `${t.code} ${t.rate}% since ${t.from}`).join(' · ')
                : 'nothing in force — this outlet is charging no tax at all'}
              {settings.tax.some((t) => t.scheduled) && (
                <span style={{ color: 'var(--amber-bright)' }}>
                  {' · '}
                  {settings.tax.filter((t) => t.scheduled)
                    .map((t) => `${t.code} ${t.rate}% from ${t.from}`).join(' · ')}
                </span>
              )}
            </span>
          </div>
        </div>

        {missing.length > 0 && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10,
            background: 'var(--bg-2)', border: '1px solid var(--line)',
            font: '400 13px/1.5 system-ui', color: 'var(--warn-bright)' }}>
            This branch is missing {missing.join(', ')}.{' '}
            <button type="button" onClick={() => onGo('settings')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                font: '600 13px/1.5 system-ui', color: 'var(--amber-bright)',
                textDecoration: 'underline' }}>
              Fix it in Settings
            </button>
          </div>
        )}
      </div>

      {/* ── printers ───────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>What it prints on</div>
        {printers.length === 0 ? (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)', maxWidth: 640 }}>
            No printer has been paired here. A printer is a device like any other —
            it pairs with a code, it can be revoked, and it goes quiet when it is
            unplugged — so it is registered on{' '}
            <button type="button" onClick={() => onGo('sync')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                font: '600 13px/1.5 system-ui', color: 'var(--amber-bright)',
                textDecoration: 'underline' }}>
              Sync &amp; Devices
            </button>
            {' '}rather than in a register of its own.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 7 }}>
            {printers.map((p) => (
              <div key={p.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <span style={{ font: '500 13px/1.4 system-ui', color: 'var(--text)', width: 180 }}>
                  {p.label}
                </span>
                <span style={{ font: '400 12px/1.4 system-ui',
                  color: p.quietForMins !== null && p.quietForMins < 30
                    ? 'var(--go-bright)' : 'var(--text-faint)' }}>
                  {p.pairedAt ? 'paired' : 'waiting to be paired'}
                  {p.quietForMins !== null && ` · last heard ${p.quietForMins} min ago`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── the rest of the estate ─────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>The rest of the estate</div>
        {session.rank < 5 ? (
          <div style={{ font: '400 13px/1.6 system-ui', color: 'var(--text-muted)', maxWidth: 700 }}>
            You can see this branch and no other, and that is the system working rather
            than a screen withholding something. Each outlet owns its own database
            schema and its own login role; another branch&rsquo;s tables are not filtered
            out of your view, they are unreachable on the connection your session is
            made on. Only an owner, through a read-only reporting role, can see across
            — and what that returns is sums, never rows.
          </div>
        ) : estate ? (
          <div>
            <DataGrid
              cols={[
                { label: 'Outlet', w: '1.6fr' },
                { label: 'Today', mono: true, a: 'right' },
                { label: 'Bills', mono: true, a: 'right' },
                { label: 'Covers', mono: true, a: 'right' },
              ]}
              rows={estate.outlets.map((x) => ({
                key: String(x.outlet_id),
                on: x.outlet_id === o.id,
                cells: [
                  { t: `${x.outlet} · ${x.code}${x.outlet_id === o.id ? ' · here' : ''}`, w: 600 },
                  { t: Number(x.revenue).toFixed(2), c: 'var(--warn-bright)' },
                  { t: String(x.bills), c: 'var(--text-muted)' },
                  { t: String(x.covers), c: 'var(--text-muted)' },
                ],
              }))}
            />
            <div style={{ marginTop: 10, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
              Aggregates, computed inside each branch&rsquo;s own books. This read is in the
              audit trail, stamped as group scope.
            </div>
          </div>
        ) : (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
            The estate could not be read just now. This branch&rsquo;s own details above
            are unaffected.
          </div>
        )}
      </div>

      {/* ── opening a branch ───────────────────────────────────────────── */}
      <div style={{ ...card, background: 'var(--bg-0)' }}>
        <div style={h}>Opening a new branch</div>
        <div style={{ font: '400 12px/1.7 system-ui', color: 'var(--text-faint)', maxWidth: 720 }}>
          There is no button for this on purpose. Provisioning an outlet runs
          <span style={{ fontFamily: MONO }}> CREATE SCHEMA </span> and
          <span style={{ fontFamily: MONO }}> CREATE ROLE </span>, and the application
          has never held a connection that can do either — that is what keeps one
          branch out of another&rsquo;s tables. It is run once, from the deploy console,
          by somebody with the owner connection:
        </div>
        <div style={{ marginTop: 9, padding: '10px 12px', borderRadius: 9,
          background: 'var(--bg-2)', border: '1px solid var(--line)',
          font: `400 12px/1.7 ${MONO}`, color: 'var(--code-text)', overflowX: 'auto' }}>
          npm run provision:outlet -- 5 ADD-01 &quot;Kashikeyo Addu&quot;
        </div>
        <div style={{ marginTop: 9, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)', maxWidth: 720 }}>
          It creates the schema, the login role, the document series and the chart of
          accounts, and the new branch appears in the estate the moment it takes its
          first order.
        </div>
      </div>

      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
