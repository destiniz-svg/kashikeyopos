import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Settings — 02-POS-SPEC §2 (`settings`), 08-BUILD-STAGES §29.
 *
 * TWO KINDS OF SETTING, AND THEY ARE KEPT APART BECAUSE THEY DIFFER IN WHAT
 * THEY COST TO GET WRONG.
 *
 *   THIS MACHINE — theme, and nothing else. It lives in local storage, applies
 *   to the screen in front of you and to no other terminal. A till by a window
 *   needs light mode and a bar at midnight needs dark; that is a preference,
 *   not a decision about the business.
 *
 *   THIS OUTLET — the service charge on every bill, cash rounding, the table
 *   count, and the GST rate. Each of these is on a receipt somebody will keep.
 *   They are admin-rank and they are all in the audit trail with what they were
 *   before, because "the service charge changed" without a before is a note
 *   rather than a record.
 *
 * A TAX RATE IS ADDED WITH A DATE, NEVER EDITED, AND NEVER BACKDATED. Every
 * sale records the rate it was rung up at. A rate that took effect last Tuesday
 * would restate every receipt printed since — including a period already filed
 * with MIRA — so the form's date will not go into the past and says why.
 *
 * FOUR FIELDS ARE SHOWN AND CANNOT BE EDITED BY ANYONE: an outlet's id, code,
 * schema and database role. They are the tenancy model — the connection every
 * request runs on is resolved through them — and no grant in this application
 * can write them. Showing them greyed with the reason beside them is better
 * than leaving somebody hunting for the screen that changes them.
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
  padding: '9px 15px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  color: primary ? '#111214' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

const LS_THEME = 'kashikeyo.pos.theme.v1';

interface TaxVersion {
  code: string; rate: number; from: string; to: string | null;
  live: boolean; scheduled: boolean;
}
interface SettingsData {
  outlet: {
    id: number; code: string; name: string; currency: string; tz: string;
    servicePct: number; cashRoundLaari: number; tables: number;
    active: boolean; createdAt: string;
  };
  tax: TaxVersion[];
  fixed: { fields: string[]; why: string };
  canEdit: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

export function Settings({ session }: { session: Session }) {
  /* useMemo, and not decoration. `api.authed(session)` returns a NEW function
     every render, so a `useCallback` that depends on it changes identity every
     render too, and the `useEffect` that loads on it fires on every render —
     an endless fetch loop that also resets this form's fields out from under
     whoever is typing in them. Found by a browser check where a filled input
     came back with its old value. */
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [service, setService] = useState('');
  const [round, setRound] = useState('');
  const [tables, setTables] = useState('');
  const [tz, setTz] = useState('');

  const [taxCode, setTaxCode] = useState('GGST');
  const [taxRate, setTaxRate] = useState('');
  const [taxFrom, setTaxFrom] = useState(today());

  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem(LS_THEME) || 'system'; } catch { return 'system'; }
  });

  const fill = useCallback((d: SettingsData) => {
    setData(d);
    setName(d.outlet.name);
    setService(String(d.outlet.servicePct));
    setRound(String(d.outlet.cashRoundLaari));
    setTables(String(d.outlet.tables));
    setTz(d.outlet.tz);
  }, []);

  const load = useCallback(async () => {
    try { fill(await call<SettingsData>('GET', '/settings')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call, fill]);

  useEffect(() => { void load(); }, [load]);

  /* Applied to the document, not to a React tree — the tokens are CSS custom
     properties on :root and every screen reads them from there. */
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem(LS_THEME, theme); } catch { /* private mode */ }
  }, [theme]);

  const save = async () => {
    setBusy(true); setError(''); setSaved('');
    try {
      fill(await call<SettingsData>('PUT', '/settings', {
        name: name.trim(), tz: tz.trim(),
        servicePct: Number(service),
        cashRoundLaari: Number(round),
        tables: Number(tables),
      }));
      setSaved('Saved. Every bill from here on carries it.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const addTax = async () => {
    setBusy(true); setError(''); setSaved('');
    try {
      fill(await call<SettingsData>('POST', '/settings/tax', {
        code: taxCode.trim().toUpperCase(), rate: Number(taxRate), from: taxFrom,
      }));
      setTaxRate('');
      setSaved('Recorded. It starts charging on the date you gave it, not before.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={{ ...card, color: 'var(--text-muted)' }}>Reading…</div>;

  const field = (label: string, value: string, set: (s: string) => void,
    hint: string, width = 120) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)}
        disabled={!data.canEdit} style={{ ...box, width, opacity: data.canEdit ? 1 : 0.6 }} />
      <span style={{ font: '400 11px/1.4 system-ui', color: 'var(--text-faint)', maxWidth: 210 }}>
        {hint}
      </span>
    </label>
  );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── this machine ───────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>This machine</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['system', 'dark', 'light'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTheme(t)}
              style={{ ...btn(theme === t), textTransform: 'capitalize' }}>
              {t}
            </button>
          ))}
          <span style={{ font: '400 12px/1.5 system-ui', color: 'var(--text-faint)', maxWidth: 460 }}>
            This screen only. A till by a window needs light and a bar at midnight
            needs dark, and neither is a decision about the business — so it is not
            sent anywhere and no other terminal changes.
          </span>
        </div>
      </div>

      {/* ── this outlet ────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>This outlet</div>
        {!data.canEdit && (
          <div style={{ font: '400 12px/1.5 system-ui', color: 'var(--text-faint)', marginBottom: 10 }}>
            You can see these but not change them. A service charge is on every bill
            and a tax rate is a filing, so both are admin rank.
          </div>
        )}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {field('Name', name, setName, 'What guests and receipts call this branch.', 200)}
          {field('Service charge %', service, setService,
            'Added to the goods on every bill, and taxable itself.')}
          {field('Cash rounding (laari)', round, setRound,
            'Cash bills round to this; 0 means no rounding. Card and account bills never round.')}
          {field('Tables', tables, setTables, 'How many the floor plan draws.')}
          {field('Timezone', tz, setTz, 'Which day a sale after midnight belongs to.', 190)}
        </div>
        {data.canEdit && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
            <button type="button" style={btn(true)} disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" style={btn()} disabled={busy} onClick={() => void load()}>
              Discard
            </button>
          </div>
        )}
      </div>

      {/* ── tax ────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>GST</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', maxWidth: 560 }}>
          <thead>
            <tr style={{ font: '600 10px/1 system-ui', letterSpacing: '.06em',
              color: 'var(--text-faint)', textAlign: 'left' }}>
              <th style={{ padding: '0 0 8px' }}>Code</th>
              <th style={{ padding: '0 0 8px' }}>Rate</th>
              <th style={{ padding: '0 0 8px' }}>From</th>
              <th style={{ padding: '0 0 8px' }}>State</th>
            </tr>
          </thead>
          <tbody>
            {data.tax.map((v) => (
              <tr key={v.code + v.from} style={{ borderTop: '1px solid var(--line-soft)' }}>
                <td style={{ padding: '7px 0', font: `400 13px/1.2 ${MONO}`, color: 'var(--text)' }}>{v.code}</td>
                <td style={{ padding: '7px 0', font: `400 13px/1.2 ${MONO}`, color: 'var(--text)' }}>{v.rate}%</td>
                <td style={{ padding: '7px 0', font: `400 13px/1.2 ${MONO}`, color: 'var(--text-muted)' }}>{v.from}</td>
                <td style={{ padding: '7px 0', font: '400 12px/1.2 system-ui',
                  color: v.live ? 'var(--go-bright)' : v.scheduled ? 'var(--amber-bright)' : 'var(--text-faint)' }}>
                  {v.live ? 'charging now' : v.scheduled ? 'starts on that date' : 'superseded'}
                </td>
              </tr>
            ))}
            {data.tax.length === 0 && (
              <tr><td colSpan={4} style={{ padding: '8px 0', font: '400 13px/1.4 system-ui',
                color: 'var(--warn-bright)' }}>
                No rate has ever been set here, so nothing is being charged.
              </td></tr>
            )}
          </tbody>
        </table>

        {data.canEdit && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 14 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>Code</span>
              <input value={taxCode} onChange={(e) => setTaxCode(e.target.value.toUpperCase())}
                style={{ ...box, width: 90 }} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>Rate %</span>
              <input value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
                inputMode="decimal" style={{ ...box, width: 80 }} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ font: '400 12px/1 system-ui', color: 'var(--text-muted)' }}>From</span>
              {/* min=today: the form will not offer a date that would restate a
                  receipt, and the server refuses one anyway. */}
              <input type="date" value={taxFrom} min={today()}
                onChange={(e) => setTaxFrom(e.target.value)} style={box} />
            </label>
            <button type="button" style={btn(true)} disabled={busy || !taxRate.trim()}
              onClick={() => void addTax()}>
              Record this rate
            </button>
          </div>
        )}
        <div style={{ marginTop: 10, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)', maxWidth: 640 }}>
          A rate is added with a date and never edited. Every sale records the rate it
          was rung up at, so changing an old one would restate receipts that have
          already been issued — and a period already filed with MIRA. Today or later
          only, for the same reason.
        </div>
      </div>

      {/* ── what nobody can change ─────────────────────────────────────── */}
      <div style={{ ...card, background: 'var(--bg-0)' }}>
        <div style={h}>Set when this outlet was provisioned</div>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap',
          font: `400 13px/1.4 ${MONO}`, color: 'var(--text-muted)' }}>
          <span>id {data.outlet.id}</span>
          <span>code {data.outlet.code}</span>
          <span>currency {data.outlet.currency}</span>
          <span>opened {String(data.outlet.createdAt).slice(0, 10)}</span>
        </div>
        <div style={{ marginTop: 9, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)', maxWidth: 680 }}>
          {data.fixed.why}
        </div>
      </div>

      {saved && <div style={{ ...card, color: 'var(--go-bright)', font: '400 13px/1.4 system-ui' }}>{saved}</div>}
      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
