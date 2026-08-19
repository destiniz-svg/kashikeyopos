import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { useBreakpoint } from './useBreakpoint';

/* Audit Log — 02-POS-SPEC §2 (`logs`): "Append-only, filterable, exportable."
 * 08-BUILD-STAGES §29.
 *
 * THE ENTRY IS THE BEFORE AND AFTER, NOT THE HEADLINE. "Settings changed" is a
 * note; "service charge 10% → 12.5%, by the general manager, at 14:06, on the
 * front counter" is a record. So every row opens onto what the value was and
 * what it became, and the screen is built around making that one gesture cheap.
 *
 * APPEND-ONLY IS NOT A CLAIM THIS SCREEN MAKES. It is the absence of a
 * privilege: the outlet's database role holds SELECT and INSERT on the trail
 * and no UPDATE and no DELETE, anywhere. That cannot be relaxed by editing a
 * policy, and `backend/scripts/leak-test.js` tries both on every run. The
 * footer says so, because a screen that simply asserts it is trustworthy is
 * indistinguishable from one that is wrong.
 *
 * IT PAGES BY CURSOR. A trail is read newest-first while new entries are still
 * arriving at the top of it, and OFFSET into a moving list skips and repeats
 * rows — on the one screen where a missing row IS the problem.
 *
 * THE FILTERS ARE BUILT FROM WHAT IS IN THE TRAIL rather than from a list in
 * the code. A hardcoded set of actions goes stale the first time somebody adds
 * a module, and then the filter quietly cannot find the newest thing anybody
 * did.
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
  font: '400 13px/1 system-ui', padding: '7px 9px', borderRadius: 8,
  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
};

interface Entry {
  id: string; at: string;
  actor: string | null; actorName: string | null;
  rank: number; rankName: string;
  action: string; entity: string; entityId: string | null;
  scope: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
interface Page {
  entries: Entry[];
  nextBefore: string | null;
  appendOnly: { enforced: string; why: string };
}
interface Facets {
  actions: Array<{ value: string; count: number }>;
  entities: Array<{ value: string; count: number }>;
  actors: Array<{ value: string; label: string; count: number }>;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleString('en-GB',
    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The fields that actually differ between two payloads, so a settings change
 *  reads as one line rather than a wall of unchanged values. */
function changed(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!after) return [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after)]);
  const out: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const k of keys) {
    const a = before ? before[k] : undefined;
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ key: k, from: a, to: b });
  }
  return out;
}

const show = (v: unknown) =>
  v === undefined ? '—' : v === null ? 'null'
    : typeof v === 'object' ? JSON.stringify(v) : String(v);

export function Logs({ session }: { session: Session }) {
  const isPhone = useBreakpoint() === 'm';
  /* useMemo, and not decoration. `api.authed(session)` returns a NEW function
     every render, so a `useCallback` that depends on it changes identity every
     render too, and the `useEffect` that loads on it fires on every render —
     an endless fetch loop that also resets this form's fields out from under
     whoever is typing in them. Found by a browser check where a filled input
     came back with its old value. */
  const call = useMemo(() => api.authed(session), [session]);
  const grab = api.download(session);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [appendOnly, setAppendOnly] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>('');

  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');

  const query = useCallback((before?: string | null) => {
    const p = new URLSearchParams();
    if (action) p.set('action', action);
    if (entity) p.set('entity', entity);
    if (actor) p.set('actor', actor);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (text.trim()) p.set('text', text.trim());
    if (before) p.set('before', before);
    return p.toString();
  }, [action, entity, actor, from, to, text]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await call<Page>('GET', '/audit?' + query());
      setEntries(r.entries);
      setCursor(r.nextBefore);
      setAppendOnly(r.appendOnly.why);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [call, query]);

  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await call<Page>('GET', '/audit?' + query(cursor));
      /* Appended, not replaced — and by CURSOR, so nothing arriving at the top
         of the trail while this is open can push a row past the boundary. */
      setEntries((prev) => [...prev, ...r.entries]);
      setCursor(r.nextBefore);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void call<Facets>('GET', '/audit/facets').then(setFacets).catch(() => { /* filters stay open */ });
  }, [call]);

  const clear = () => {
    setAction(''); setEntity(''); setActor(''); setFrom(''); setTo(''); setText('');
  };
  const filtered = Boolean(action || entity || actor || from || to || text.trim());

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={h}>Filter</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Action</span>
            <select value={action} onChange={(e) => setAction(e.target.value)} style={box}>
              <option value="">any</option>
              {facets?.actions.map((a) => (
                <option key={a.value} value={a.value}>{a.value} ({a.count})</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Entity</span>
            <select value={entity} onChange={(e) => setEntity(e.target.value)} style={box}>
              <option value="">any</option>
              {facets?.entities.map((a) => (
                <option key={a.value} value={a.value}>{a.value} ({a.count})</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Who</span>
            <select value={actor} onChange={(e) => setActor(e.target.value)} style={box}>
              <option value="">anybody</option>
              {facets?.actors.map((a) => (
                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={box} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={box} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ font: '400 11px/1 system-ui', color: 'var(--text-faint)' }}>Contains</span>
            <input value={text} onChange={(e) => setText(e.target.value)}
              placeholder="action, entity or id" style={{ ...box, width: 180 }} />
          </label>
          {filtered && (
            <button type="button" onClick={clear}
              style={{ ...box, cursor: 'pointer', color: 'var(--text-dim)' }}>
              Clear
            </button>
          )}
          <button type="button"
            onClick={() => void grab('/audit.csv?' + query(), 'audit-log.csv')}
            style={{ padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
              background: 'var(--bg-2)', color: 'var(--text-dim)',
              border: '1px solid var(--line-2)', font: '600 13px/1 system-ui' }}>
            Export what is filtered
          </button>
        </div>
        <div style={{ marginTop: 9, font: '400 11px/1.5 system-ui', color: 'var(--text-faint)' }}>
          The export is itself an entry in the trail — a copy of the audit log leaving
          the building is exactly the kind of thing an audit log is for.
        </div>
      </div>

      <div style={card}>
        <div style={h}>{filtered ? 'Matching entries' : 'The trail'}</div>
        {entries.length === 0 ? (
          <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
            {filtered
              ? 'Nothing matches those filters. That is an answer, not an error.'
              : 'Nothing has been recorded here yet.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 2 }}>
            {entries.map((e) => {
              const diff = changed(e.before, e.after);
              const isOpen = open === e.id;
              return (
                <div key={e.id}>
                  <button type="button"
                    onClick={() => setOpen(isOpen ? '' : e.id)}
                    style={{
                      width: '100%', textAlign: 'left', display: 'flex', gap: 12,
                      alignItems: 'baseline', flexWrap: 'wrap', cursor: diff.length ? 'pointer' : 'default',
                      padding: '8px 10px', borderRadius: 8, border: '1px solid transparent',
                      background: isOpen ? 'var(--bg-2)' : 'transparent', color: 'var(--text-dim)',
                    }}>
                    <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-faint)', width: isPhone ? undefined : 130 }}>
                      {clock(e.at)}
                    </span>
                    <span style={{ font: '500 13px/1.3 system-ui', color: 'var(--text)', minWidth: isPhone ? 0 : 160 }}>
                      {e.action}
                    </span>
                    <span style={{ font: `400 12px/1.3 ${MONO}`, color: 'var(--text-muted)', minWidth: isPhone ? 0 : 130 }}>
                      {e.entity}{e.entityId ? ' ' + String(e.entityId).slice(0, 12) : ''}
                    </span>
                    <span style={{ font: '400 12px/1.3 system-ui', color: 'var(--text-muted)', minWidth: isPhone ? 0 : 140 }}>
                      {e.actorName || 'the system'} · {e.rankName}
                    </span>
                    {e.scope === 'group' && (
                      <span style={{ font: '600 10px/1.6 system-ui', letterSpacing: '.06em',
                        padding: '1px 6px', borderRadius: 5, background: 'var(--bg-3)',
                        color: 'var(--amber-bright)' }}>
                        GROUP SCOPE
                      </span>
                    )}
                    {diff.length > 0 && (
                      <span style={{ font: '400 11px/1.3 system-ui', color: 'var(--text-faint)' }}>
                        {isOpen ? '▾' : '▸'} {diff.length} field{diff.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                  {isOpen && diff.length > 0 && (
                    <div style={{ padding: isPhone ? '4px 10px 12px 10px' : '4px 10px 12px 152px', display: 'grid', gap: 4, overflowX: 'auto' }}>
                      {diff.map((d) => (
                        <div key={d.key} style={{ font: `400 12px/1.5 ${MONO}` }}>
                          <span style={{ color: 'var(--text-muted)' }}>{d.key}</span>{'  '}
                          <span style={{ color: 'var(--red-bright)' }}>{show(d.from)}</span>
                          <span style={{ color: 'var(--text-faint)' }}> → </span>
                          <span style={{ color: 'var(--go-bright)' }}>{show(d.to)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {cursor && (
          <button type="button" onClick={() => void more()} disabled={busy}
            style={{ marginTop: 12, padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
              background: 'var(--bg-2)', color: 'var(--text-dim)',
              border: '1px solid var(--line-2)', font: '600 13px/1 system-ui' }}>
            {busy ? 'Reading…' : 'Older entries'}
          </button>
        )}

        <div style={{ marginTop: 12, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)', maxWidth: 700 }}>
          {appendOnly}
        </div>
      </div>

      {error && <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>{error}</div>}
    </div>
  );
}
