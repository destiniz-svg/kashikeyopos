import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Menu Master — 02-POS-SPEC.md §2 (`menu`).
 *
 * The module every other one waits on: until a menu can be entered here, the
 * till has nothing to ring, the kitchen has nothing to cook and a recipe has
 * nothing to cost.
 *
 * NOT offline-first, deliberately, unlike the till. A menu is edited in an
 * office by one person; an edit queued on a tablet for three hours and then
 * replayed over somebody else's newer price is a worse outcome than being told
 * to reconnect. The till is offline-first because a queue of customers cannot
 * wait — a price list is not that.
 */

const MONO = "'JetBrains Mono',monospace";
const money = (v: string | number) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Item {
  id: string; name: string; category: string | null; price: string;
  station: string | null; yieldQty: number; active: boolean; offMenu: boolean;
  recipeLines: number; sold: number;
}
interface Station { name: string; target_mins: number; sort: number }

type Draft = {
  id: string; name: string; category: string; price: string; station: string;
};
const BLANK: Draft = { id: '', name: '', category: '', price: '', station: '' };

export function Menu({ session }: { session: Session }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [q, setQ] = useState('');

  /* Through api.authed, not a bare fetch — see there. This one built its own
     absolute base string, which is why a regex looking for fetch('/api…') did
     not find it and a static deploy 404'd on the menu and nowhere else. */
  const authed = useMemo(() => api.authed(session), [session]);
  const call = useCallback(
    (method: string, path: string, body?: unknown) => authed(method, '/menu' + path, body),
    [authed]);

  const load = useCallback(async () => {
    try {
      const j = await call('GET', '') as { items: Item[]; stations: Station[] };
      setItems(j.items);
      setStations(j.stations);
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the menu.');
      setItems([]);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 2600); };

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = {
        name: draft.name,
        category: draft.category || null,
        price: draft.price === '' ? undefined : Number(draft.price),
        station: draft.station || null,
      };
      if (adding) {
        await call('POST', '', { id: draft.id, ...body });
        say('Added ' + draft.name);
      } else {
        await call('PATCH', '/' + encodeURIComponent(editing!), body);
        say('Saved ' + draft.name);
      }
      setEditing(null); setAdding(false); setDraft(BLANK);
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  const retire = async (it: Item) => {
    setBusy(true); setError('');
    try {
      await call('DELETE', '/' + encodeURIComponent(it.id));
      say(it.name + ' taken off the menu');
      await load();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not remove it.');
    } finally { setBusy(false); }
  };

  const setFlag = async (it: Item, patch: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await call('PATCH', '/' + encodeURIComponent(it.id), patch); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (!showRetired && !i.active) return false;
      if (!needle) return true;
      return (i.name + ' ' + i.id + ' ' + (i.category ?? '')).toLowerCase().includes(needle);
    });
  }, [items, q, showRetired]);

  const retiredCount = (items ?? []).filter((i) => !i.active).length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Menu Master</span>
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search dishes" aria-label="Search dishes"
          style={{ flex: 1, maxWidth: 260, height: 30, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12 }}
        />
        <span style={{ flex: 1 }} />
        {retiredCount > 0 && (
          <button onClick={() => setShowRetired((v) => !v)}
            style={{ padding: '6px 11px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: showRetired ? 'var(--bg-3)' : 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
            {showRetired ? 'Hide' : 'Show'} {retiredCount} retired
          </button>
        )}
        <button
          onClick={() => { setAdding(true); setEditing(null); setDraft(BLANK); setError(''); }}
          style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
          Add a dish
        </button>
      </div>

      {(error || flash) && (
        <div role="status" style={{
          flexShrink: 0, padding: '9px 14px', fontSize: 11.5,
          background: error ? 'var(--red-dim)' : 'var(--go-dim)',
          color: error ? 'var(--red-bright)' : 'var(--go-bright)',
        }}>{error || flash}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {(adding || editing) && (
          <form
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
            style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)' }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', marginBottom: 11 }}>
              {adding ? 'New dish' : 'Editing ' + editing}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
              {adding && (
                <Field label="Code" hint="A-Z, 0-9, dash. Cannot change later.">
                  <input required value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    style={inputStyle} placeholder="REEF-CURRY" />
                </Field>
              )}
              <Field label="Name">
                <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Category">
                <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} style={inputStyle} placeholder="Mains" />
              </Field>
              <Field label="Price (MVR)" hint="GST-inclusive — what the guest pays.">
                <input required inputMode="decimal" value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  style={{ ...inputStyle, fontFamily: MONO }} placeholder="95.00" />
              </Field>
              <Field label="Station" hint={stations.length ? undefined : 'No stations configured yet.'}>
                <select value={draft.station} onChange={(e) => setDraft({ ...draft, station: e.target.value })} style={inputStyle}>
                  <option value="">The pass</option>
                  {stations.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button type="submit" disabled={busy}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                {busy ? 'Saving…' : adding ? 'Add it' : 'Save'}
              </button>
              <button type="button" onClick={() => { setAdding(false); setEditing(null); setError(''); }}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {items === null ? (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>Loading the menu…</div>
        ) : !shown.length ? (
          /* §6: a real empty state — what lands here, what creates it, and the
             button that starts that. Never "No data". */
          <div style={{ padding: '54px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {q ? 'Nothing matches that' : 'No dishes yet'}
            </div>
            <div style={{ margin: '9px auto 0', maxWidth: 420, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
              {q
                ? 'Try another word, or clear the search.'
                : 'This is the price list the till rings and the guest’s phone reads — one price, two surfaces. Add a dish and it appears on both immediately.'}
            </div>
            {!q && (
              <button onClick={() => { setAdding(true); setDraft(BLANK); }}
                style={{ marginTop: 16, padding: '10px 18px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
                Add the first dish
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
            {shown.map((it) => (
              <div key={it.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px',
                background: 'var(--bg-1)', opacity: it.active ? 1 : 0.55,
              }}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 600, color: 'var(--text)',
                      textDecoration: it.offMenu ? 'line-through' : 'none',
                    }}>{it.name}</span>
                    <span style={{ fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>{it.id}</span>
                    {!it.active && <Tag tone="red">Retired</Tag>}
                    {it.offMenu && it.active && <Tag tone="warn">Off menu</Tag>}
                    {it.recipeLines === 0 && it.active && <Tag tone="warn">No recipe</Tag>}
                  </span>
                  <span style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                    <span>{it.category || 'Uncategorised'}</span>
                    <span>{it.station || 'The pass'}</span>
                    {it.sold > 0 && <span>{it.sold} sold</span>}
                  </span>
                </span>

                <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>
                  {money(it.price)}
                </span>

                <span style={{ display: 'flex', gap: 6 }}>
                  <RowBtn onClick={() => {
                    setEditing(it.id); setAdding(false); setError('');
                    setDraft({ id: it.id, name: it.name, category: it.category ?? '', price: String(it.price), station: it.station ?? '' });
                  }}>Edit</RowBtn>
                  {it.active ? (
                    <>
                      <RowBtn onClick={() => void setFlag(it, { offMenu: !it.offMenu })}>
                        {it.offMenu ? 'Back on' : '86'}
                      </RowBtn>
                      <RowBtn danger onClick={() => void retire(it)}>Remove</RowBtn>
                    </>
                  ) : (
                    <RowBtn onClick={() => void setFlag(it, { active: true })}>Restore</RowBtn>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 32, padding: '0 10px', borderRadius: 7,
  background: 'var(--bg-2)', border: '1px solid var(--line)',
  color: 'var(--text)', fontSize: 12.5,
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', marginBottom: 4, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
        {label.toUpperCase()}
      </span>
      {children}
      {hint && <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}

function Tag({ tone, children }: { tone: 'red' | 'warn'; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700, letterSpacing: '.03em',
      background: tone === 'red' ? 'var(--red-dim)' : 'var(--warn-dim)',
      color: tone === 'red' ? 'var(--red-bright)' : 'var(--warn-bright)',
    }}>{children}</span>
  );
}

function RowBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
      background: 'var(--bg-2)', border: '1px solid var(--line)',
      color: danger ? 'var(--red-bright)' : 'var(--text-muted)',
    }}>{children}</button>
  );
}
