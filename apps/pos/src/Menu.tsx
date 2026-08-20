import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';
import { CAT_RAMP, ICON_KEYS, SPICE, TAGSET, catIcon, initials, tagLabel } from './dishes';
import { Busy, DishPhoto, HButton, LIFT } from './ui';

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
 *
 * THREE MODES, because a menu is three things (migration 037, and the
 * prototype's own division):
 *
 *   DISHES    what is sold, and now what it LOOKS like — photograph, the
 *             merchant's own words, heat and diet tags. A till that only knows
 *             a name and a price can only draw a rectangle of text.
 *   SECTIONS  the wayfinding. A section's colour bands the till grid, tints the
 *             artifact on a dish with no photograph, and colours the KDS docket
 *             rail. One hue per section, reused everywhere, is what lets a
 *             cashier aim at a section before reading a word.
 *   ADD-ONS   the priced extras. Priced ONCE, here — the till posts ids and the
 *             server does the arithmetic, so an "extra shot" can never be
 *             repriced from a terminal.
 */

const MONO = "'JetBrains Mono',monospace";
const money = (v: string | number) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Item {
  id: string; name: string; category: string | null; price: string;
  station: string | null; yieldQty: number; active: boolean; offMenu: boolean;
  recipeLines: number; sold: number;
  description: string | null; imageUrl: string | null;
  tags: string[]; spice: number; addonsOwn: boolean; addonIds: string[];
}
interface Station { name: string; target_mins: number; sort: number }
interface SectionRow {
  name: string; color: string | null; icon: string | null;
  station: string | null; sort: number; hidden: boolean; dishes: number;
}
interface AddonRow {
  id: string; name: string; price: string; sections: string[];
  active: boolean; sort: number; dishes: number;
  recipeItemId: string | null; recipeItemName: string | null;
}

type Mode = 'dishes' | 'sections' | 'addons';

type Draft = {
  id: string; name: string; category: string; price: string; station: string;
  description: string; imageUrl: string; tags: string[]; spice: number;
  addonsOwn: boolean; addonIds: string[];
};
const BLANK: Draft = {
  id: '', name: '', category: '', price: '', station: '',
  description: '', imageUrl: '', tags: [], spice: 0, addonsOwn: false, addonIds: [],
};

type AddonDraft = {
  id: string; name: string; price: string; sections: string[]; recipeItemId: string;
};
const BLANK_ADDON: AddonDraft = { id: '', name: '', price: '', sections: [], recipeItemId: '' };

export function Menu({ session }: { session: Session }) {
  const [mode, setMode] = useState<Mode>('dishes');
  const [items, setItems] = useState<Item[] | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [addons, setAddons] = useState<AddonRow[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [q, setQ] = useState('');
  const [editAddon, setEditAddon] = useState<string | null>(null);
  const [addonDraft, setAddonDraft] = useState<AddonDraft>(BLANK_ADDON);
  const [addingAddon, setAddingAddon] = useState(false);
  const [editSection, setEditSection] = useState<string | null>(null);

  /* Through api.authed, not a bare fetch — see there. This one built its own
     absolute base string, which is why a regex looking for fetch('/api…') did
     not find it and a static deploy 404'd on the menu and nowhere else. */
  const authed = useMemo(() => api.authed(session), [session]);
  const call = useCallback(
    (method: string, path: string, body?: unknown) => authed(method, '/menu' + path, body),
    [authed]);

  const load = useCallback(async () => {
    try {
      /* All three in one pass. The dish editor needs the add-on catalogue to
         draw its ticks and the section list to offer a section, so loading them
         lazily per mode would mean the editor opening with an empty list. */
      const [m, s, a] = await Promise.all([
        call('GET', '') as Promise<{ items: Item[]; stations: Station[] }>,
        call('GET', '/sections') as Promise<{ sections: SectionRow[] }>,
        call('GET', '/addons') as Promise<{ addons: AddonRow[] }>,
      ]);
      setItems(m.items);
      setStations(m.stations);
      setSections(s.sections);
      setAddons(a.addons);
      setError('');
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the menu.');
      setItems([]);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 2600); };
  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof api.ApiError ? e.message : fallback);

  /* ── dishes ────────────────────────────────────────────────────────────── */

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = {
        name: draft.name,
        category: draft.category || null,
        price: draft.price === '' ? undefined : Number(draft.price),
        station: draft.station || null,
        description: draft.description,
        imageUrl: draft.imageUrl,
        tags: draft.tags,
        spice: draft.spice,
        addonsOwn: draft.addonsOwn,
        /* Sent only when the dish names its own. A dish that inherits its
           section's list has no rows of its own, and writing an empty set for
           it would be indistinguishable from "this dish takes none". */
        ...(draft.addonsOwn ? { addonIds: draft.addonIds } : { addonIds: [] }),
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
    } catch (e) { fail(e, 'Could not save.'); }
    finally { setBusy(false); }
  };

  const retire = async (it: Item) => {
    setBusy(true); setError('');
    try {
      await call('DELETE', '/' + encodeURIComponent(it.id));
      say(it.name + ' taken off the menu');
      await load();
    } catch (e) { fail(e, 'Could not remove it.'); }
    finally { setBusy(false); }
  };

  const setFlag = async (it: Item, patch: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await call('PATCH', '/' + encodeURIComponent(it.id), patch); await load(); }
    catch (e) { fail(e, 'Could not save.'); }
    finally { setBusy(false); }
  };

  const openDish = (it: Item) => {
    setEditing(it.id); setAdding(false); setError('');
    setDraft({
      id: it.id, name: it.name, category: it.category ?? '', price: String(it.price),
      station: it.station ?? '', description: it.description ?? '',
      imageUrl: it.imageUrl ?? '', tags: it.tags ?? [], spice: it.spice ?? 0,
      addonsOwn: it.addonsOwn, addonIds: it.addonIds ?? [],
    });
  };

  /* ── sections ──────────────────────────────────────────────────────────── */

  const saveSection = async (name: string, patch: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      await call('PUT', '/sections/' + encodeURIComponent(name), patch);
      await load();
    } catch (e) { fail(e, 'Could not save the section.'); }
    finally { setBusy(false); }
  };

  /* ── add-ons ───────────────────────────────────────────────────────────── */

  const submitAddon = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = {
        name: addonDraft.name,
        price: addonDraft.price === '' ? 0 : Number(addonDraft.price),
        sections: addonDraft.sections,
        recipeItemId: addonDraft.recipeItemId,
      };
      if (addingAddon) {
        await call('POST', '/addons', { id: addonDraft.id, ...body });
        say('Added ' + addonDraft.name);
      } else {
        await call('PATCH', '/addons/' + encodeURIComponent(editAddon!), body);
        say('Saved ' + addonDraft.name);
      }
      setEditAddon(null); setAddingAddon(false); setAddonDraft(BLANK_ADDON);
      await load();
    } catch (e) { fail(e, 'Could not save the add-on.'); }
    finally { setBusy(false); }
  };

  const retireAddon = async (a: AddonRow) => {
    setBusy(true); setError('');
    try {
      await call('DELETE', '/addons/' + encodeURIComponent(a.id));
      say(a.name + ' taken off');
      await load();
    } catch (e) { fail(e, 'Could not remove it.'); }
    finally { setBusy(false); }
  };

  /* ── what is on screen ─────────────────────────────────────────────────── */

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (!showRetired && !i.active) return false;
      if (!needle) return true;
      return (i.name + ' ' + i.id + ' ' + (i.category ?? '') + ' ' + (i.description ?? ''))
        .toLowerCase().includes(needle);
    });
  }, [items, q, showRetired]);

  const retiredCount = (items ?? []).filter((i) => !i.active).length;
  const sectionNames = sections.map((s) => s.name);

  /* The colour a section resolves to here has to be the colour the till draws,
     so it is derived the same way: the merchant's choice if there is one, and
     otherwise the ramp at the section's own position. */
  const hueOf = (s: SectionRow) =>
    s.color || CAT_RAMP[Math.max(0, sections.indexOf(s)) % CAT_RAMP.length];

  const TABS: Array<[Mode, string, number]> = [
    ['dishes', 'Dishes', (items ?? []).filter((i) => i.active).length],
    ['sections', 'Sections', sections.length],
    ['addons', 'Add-ons', addons.filter((a) => a.active).length],
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Menu Master</span>
        {/* One rail, three modes. Counts on the tabs, because "Add-ons 0" and
            "Add-ons" are different messages: the first says nobody has made one
            yet, the second says nothing at all. */}
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map(([k, label, n]) => (
            <HButton key={k} onClick={() => { setMode(k); setError(''); }}
              hover={mode === k ? undefined : LIFT}
              style={{
                padding: '6px 11px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 6,
                background: mode === k ? 'var(--bg-3)' : 'var(--bg-2)',
                color: mode === k ? 'var(--text)' : 'var(--text-muted)',
                border: '1px solid ' + (mode === k ? 'var(--line-2)' : 'var(--line)'),
              }}>
              {label}
              <span style={{ fontSize: 10, fontFamily: MONO, opacity: .6 }}>{n}</span>
            </HButton>
          ))}
        </div>
        {mode === 'dishes' && (
          <input
            data-screen-search value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search dishes" aria-label="Search dishes"
            style={{ flex: 1, maxWidth: 240, height: 30, padding: '0 10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12 }}
          />
        )}
        <span style={{ flex: 1 }} />
        {mode === 'dishes' && retiredCount > 0 && (
          <HButton onClick={() => setShowRetired((v) => !v)} hover={LIFT}
            style={{ padding: '6px 11px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: showRetired ? 'var(--bg-3)' : 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
            {showRetired ? 'Hide' : 'Show'} {retiredCount} retired
          </HButton>
        )}
        {mode === 'dishes' && (
          <HButton
            onClick={() => { setAdding(true); setEditing(null); setDraft(BLANK); setError(''); }}
            hover={{ background: 'var(--amber-deep)' }}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            Add a dish
          </HButton>
        )}
        {mode === 'addons' && (
          <HButton
            onClick={() => { setAddingAddon(true); setEditAddon(null); setAddonDraft(BLANK_ADDON); setError(''); }}
            hover={{ background: 'var(--amber-deep)' }}
            style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
            New add-on
          </HButton>
        )}
      </div>

      {(error || flash) && (
        <div role="status" style={{
          flexShrink: 0, padding: '9px 14px', fontSize: 11.5,
          background: error ? 'var(--red-dim)' : 'var(--go-dim)',
          color: error ? 'var(--red-bright)' : 'var(--go-bright)',
        }}>{error || flash}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {mode === 'dishes' && (adding || editing) && (
          <form
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
            style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)', animation: 'krise .18s cubic-bezier(.2,.7,.3,1)' }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', marginBottom: 11 }}>
              {adding ? 'New dish' : 'Editing ' + editing}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 150px), 1fr))', gap: 10 }}>
              {adding && (
                <Field label="Code" hint="A-Z, 0-9, dash. Cannot change later.">
                  <input required value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    style={inputStyle} placeholder="REEF-CURRY" />
                </Field>
              )}
              <Field label="Name">
                <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Section" hint="Its colour bands the till grid and the KDS rail.">
                <input list="menu-sections" value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  style={inputStyle} placeholder="Mains" />
                <datalist id="menu-sections">
                  {sectionNames.map((n) => <option key={n} value={n} />)}
                </datalist>
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

            {/* THE DISH'S FACE. Everything below reaches the till tile and the
                guest's phone unchanged — one dish, one description, two
                surfaces. */}
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 240px), 1fr))', gap: 10 }}>
              <Field label="Description" hint="What the guest reads under the name. Two lines on the tile.">
                <textarea value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={2}
                  style={{ ...inputStyle, height: 'auto', minHeight: 54, padding: '7px 10px', resize: 'vertical', lineHeight: 1.45 }}
                  placeholder="Reef fish, young coconut, curry leaf" />
              </Field>
              <Field label="Photograph"
                hint="An address starting https:// or /. Leave it empty and the till draws the section artifact instead — never an empty box.">
                <input value={draft.imageUrl}
                  onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })}
                  style={inputStyle} placeholder="https://…/reef-curry.jpg" />
              </Field>
            </div>

            <div style={{ marginTop: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <div>
                <FieldLabel>Tags</FieldLabel>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {TAGSET.map(([k, label]) => {
                    const on = draft.tags.includes(k);
                    return (
                      <HButton key={k} type="button" hover={on ? undefined : LIFT}
                        onClick={() => setDraft({
                          ...draft,
                          tags: on ? draft.tags.filter((t) => t !== k) : draft.tags.concat([k]),
                        })}
                        style={{
                          padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          background: on ? 'var(--go-dim)' : 'var(--bg-2)',
                          color: on ? 'var(--green)' : 'var(--text-muted)',
                          border: '1px solid ' + (on ? 'var(--go-line)' : 'var(--line)'),
                        }}>{label}</HButton>
                    );
                  })}
                </div>
              </div>
              <div>
                <FieldLabel>Heat</FieldLabel>
                <div style={{ display: 'flex', gap: 5 }}>
                  {SPICE.map((label, i) => {
                    const on = draft.spice === i;
                    return (
                      <HButton key={label} type="button" hover={on ? undefined : LIFT}
                        onClick={() => setDraft({ ...draft, spice: i })}
                        style={{
                          padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          background: on ? 'var(--danger-dim)' : 'var(--bg-2)',
                          color: on ? 'var(--red-bright)' : 'var(--text-muted)',
                          border: '1px solid ' + (on ? 'var(--red-line)' : 'var(--line)'),
                        }}>{label}</HButton>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* WHICH ADD-ONS THIS DISH OFFERS. Inheriting is the normal case and
                the reason the section list exists — "extra sambol on every main"
                is one row, not forty. */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
              <FieldLabel>Add-ons</FieldLabel>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                <HButton type="button" hover={draft.addonsOwn ? LIFT : undefined}
                  onClick={() => setDraft({ ...draft, addonsOwn: false })}
                  style={pill(!draft.addonsOwn)}>
                  {'Section default · ' + addons.filter(
                    (a) => a.active && a.sections.includes(draft.category)).length}
                </HButton>
                <HButton type="button" hover={draft.addonsOwn ? undefined : LIFT}
                  onClick={() => setDraft({ ...draft, addonsOwn: true })}
                  style={pill(draft.addonsOwn)}>
                  Choose for this dish
                </HButton>
              </div>
              <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 560 }}>
                {draft.addonsOwn
                  ? 'Only the add-ons ticked below are offered on this dish, at the till and in the QR menu. Ticking none means this dish takes no add-ons at all.'
                  : draft.category
                    ? 'Inherits every add-on published to ' + draft.category
                      + ' — publish one to the section and this dish picks it up.'
                    : 'Give the dish a section and it inherits that section’s add-ons.'}
              </div>
              {draft.addonsOwn && (
                <div style={{ marginTop: 9, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {addons.filter((a) => a.active).map((a) => {
                    const on = draft.addonIds.includes(a.id);
                    return (
                      <HButton key={a.id} type="button" hover={on ? undefined : LIFT}
                        onClick={() => setDraft({
                          ...draft,
                          addonIds: on ? draft.addonIds.filter((x) => x !== a.id)
                            : draft.addonIds.concat([a.id]),
                        })}
                        style={pill(on)}>
                        {a.name}
                        <span style={{ marginLeft: 6, fontSize: 10, fontFamily: MONO, opacity: .7 }}>
                          {Number(a.price) ? '+' + money(a.price) : 'Free'}
                        </span>
                      </HButton>
                    );
                  })}
                  {!addons.filter((a) => a.active).length && (
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                      No add-ons exist yet. Make one under Add-ons and it appears here.
                    </span>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <HButton type="submit" disabled={busy} hover={{ background: 'var(--go-bright)' }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                {busy && <Busy />}
                {busy ? 'Saving…' : adding ? 'Add it' : 'Save'}
              </HButton>
              <HButton type="button" hover={LIFT}
                onClick={() => { setAdding(false); setEditing(null); setError(''); }}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                Cancel
              </HButton>
            </div>
          </form>
        )}

        {mode === 'dishes' && (items === null ? (
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
              <HButton onClick={() => { setAdding(true); setDraft(BLANK); }}
                hover={{ background: 'var(--amber-deep)' }}
                style={{ marginTop: 16, padding: '10px 18px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
                Add the first dish
              </HButton>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
            {shown.map((it) => {
              const sec = sections.find((s) => s.name === it.category);
              const hue = sec ? hueOf(sec) : 'var(--cat-all)';
              const offers = it.addonsOwn
                ? it.addonIds.length
                : addons.filter((a) => a.active && it.category && a.sections.includes(it.category)).length;
              return (
                <div key={it.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px',
                  /* A dish row is a name, a price and three buttons. At 390px they
                     do not fit on one line, and a nowrap flex row does not clip
                     them — it draws them over each other, which is how "No recipe"
                     ended up printed across "Edit". Wrapping is the honest answer:
                     the row becomes two lines and stays readable. */
                  flexWrap: 'wrap',
                  background: 'var(--bg-1)', opacity: it.active ? 1 : 0.55,
                }}>
                  {/* The dish as the till will draw it — its photograph, or its
                      section artifact. Seeing it HERE is the point: a merchant
                      who cannot see the tile cannot tell that the address they
                      pasted is broken. */}
                  <span aria-hidden style={{
                    position: 'relative', width: 40, height: 40, borderRadius: 9,
                    flexShrink: 0, overflow: 'hidden', display: 'block', fontSize: 12,
                  }}>
                    <DishPhoto url={it.imageUrl}
                      tint={'color-mix(in oklab, ' + hue + ' 22%, transparent)'}
                      ink={'color-mix(in oklab, ' + hue + ' 55%, var(--text))'}
                      text={initials(it.name) || '?'} dimmed={it.offMenu} size={13} />
                  </span>

                  <span style={{ minWidth: 0, flex: '1 1 200px' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                      <span style={{
                        fontSize: 13, fontWeight: 600, color: 'var(--text)',
                        textDecoration: it.offMenu ? 'line-through' : 'none',
                        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{it.name}</span>
                      <span style={{ fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>{it.id}</span>
                      {!it.active && <Tag tone="red">Retired</Tag>}
                      {it.offMenu && it.active && <Tag tone="warn">Off menu</Tag>}
                      {it.recipeLines === 0 && it.active && <Tag tone="warn">No recipe</Tag>}
                      {it.tags.map((t) => <Tag key={t} tone="ok">{tagLabel(t)}</Tag>)}
                      {it.spice > 0 && <Tag tone="red">{SPICE[it.spice]}</Tag>}
                    </span>
                    <span style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)', flexWrap: 'wrap' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 999, background: hue }} />
                        {it.category || 'Uncategorised'}
                      </span>
                      <span>{it.station || 'The pass'}</span>
                      {offers > 0 && <span>{offers} add-on{offers === 1 ? '' : 's'}</span>}
                      {it.sold > 0 && <span>{it.sold} sold</span>}
                    </span>
                  </span>

                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)' }}>
                    {money(it.price)}
                  </span>

                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <RowBtn onClick={() => openDish(it)}>Edit</RowBtn>
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
              );
            })}
          </div>
        ))}

        {/* ── SECTIONS ─────────────────────────────────────────────────────── */}
        {mode === 'sections' && (
          <>
            <Note>
              Colour is the wayfinding. A section’s hue bands the till grid, tints
              the artifact on a dish with no photograph, and colours the KDS docket
              rail — one hue per section, reused everywhere, is what lets a cashier
              aim at a section before reading a word. A section appears here as soon
              as a dish names it; choosing a colour is optional and can wait.
            </Note>
            {!sections.length ? (
              <div style={{ padding: '54px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>No sections yet</div>
                <div style={{ margin: '9px auto 0', maxWidth: 420, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
                  A section is created by putting a dish in it. Give a dish a section
                  under Dishes and it appears here, ready for a colour.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
                {sections.map((s) => {
                  const hue = hueOf(s);
                  const open = editSection === s.name;
                  return (
                    <div key={s.name} style={{ background: 'var(--bg-1)', padding: '10px 13px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span aria-hidden style={{
                          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                          display: 'grid', placeItems: 'center', color: hue,
                          background: 'color-mix(in oklab, ' + hue + ' 16%, transparent)',
                        }}>
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d={catIcon(s.icon)} />
                          </svg>
                        </span>
                        <span style={{ minWidth: 0, flex: '1 1 160px' }}>
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.name}</span>
                            {s.hidden && <Tag tone="warn">Hidden</Tag>}
                            {!s.color && <Tag tone="warn">No colour chosen</Tag>}
                          </span>
                          <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)' }}>
                            {s.dishes} dish{s.dishes === 1 ? '' : 'es'}
                            {s.station ? ' · ' + s.station : ''}
                          </span>
                        </span>
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <RowBtn onClick={() => setEditSection(open ? null : s.name)}>
                            {open ? 'Done' : 'Style it'}
                          </RowBtn>
                          <RowBtn onClick={() => void saveSection(s.name, { hidden: !s.hidden })}>
                            {s.hidden ? 'Show it' : 'Hide it'}
                          </RowBtn>
                        </span>
                      </div>

                      {open && (
                        <div style={{ marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--line-soft)', animation: 'krise .18s cubic-bezier(.2,.7,.3,1)' }}>
                          <FieldLabel>Colour</FieldLabel>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {CAT_RAMP.map((c) => (
                              <HButton key={c} onClick={() => void saveSection(s.name, { color: c })}
                                aria-label={'Use ' + c}
                                style={{
                                  width: 26, height: 26, borderRadius: 7, background: c,
                                  border: '2px solid ' + (s.color === c ? 'var(--text)' : 'transparent'),
                                }} />
                            ))}
                            <HButton onClick={() => void saveSection(s.name, { color: null })}
                              hover={LIFT}
                              style={{
                                height: 26, padding: '0 10px', borderRadius: 7, fontSize: 11,
                                fontWeight: 600, background: 'var(--bg-2)',
                                border: '1px solid var(--line)', color: 'var(--text-muted)',
                              }}>Clear</HButton>
                          </div>

                          <div style={{ marginTop: 11 }}>
                            <FieldLabel>Glyph</FieldLabel>
                            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                              {ICON_KEYS.map((k) => (
                                <HButton key={k} onClick={() => void saveSection(s.name, { icon: k })}
                                  aria-label={k} title={k} hover={s.icon === k ? undefined : LIFT}
                                  style={{
                                    width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center',
                                    background: s.icon === k ? 'var(--bg-3)' : 'var(--bg-2)',
                                    border: '1px solid ' + (s.icon === k ? 'var(--line-3)' : 'var(--line)'),
                                    color: s.icon === k ? 'var(--text)' : 'var(--text-muted)',
                                  }}>
                                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                                    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                    <path d={catIcon(k)} />
                                  </svg>
                                </HButton>
                              ))}
                            </div>
                          </div>

                          <div style={{ marginTop: 11, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 170px), 1fr))', gap: 10 }}>
                            {/* RENAMING MOVES THE DISHES WITH IT. A section is
                                the text on the dish, so renaming it here and
                                nowhere else would leave every dish pointing at
                                a name with no row and silently revert its
                                colour — the server does both in one
                                transaction (backend/src/menu.js). */}
                            <Field label="Name"
                              hint="Renaming moves every dish in this section with it.">
                              <input defaultValue={s.name} style={inputStyle}
                                onBlur={(e) => {
                                  const to = e.target.value.trim();
                                  if (!to || to === s.name) return;
                                  setEditSection(to);
                                  void saveSection(s.name, { renameTo: to });
                                }} />
                            </Field>
                            <Field label="Default station"
                              hint="Where a dish in this section is cooked when it names none of its own.">
                              <select value={s.station ?? ''} style={inputStyle}
                                onChange={(e) => void saveSection(s.name, { station: e.target.value || null })}>
                                <option value="">The pass</option>
                                {stations.map((st) => <option key={st.name} value={st.name}>{st.name}</option>)}
                              </select>
                            </Field>
                            <Field label="Position" hint="Lower comes first, on the till and in the QR menu.">
                              <input inputMode="numeric" defaultValue={String(s.sort)}
                                style={{ ...inputStyle, fontFamily: MONO }}
                                onBlur={(e) => void saveSection(s.name, { sort: Number(e.target.value) || 0 })} />
                            </Field>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── ADD-ONS ──────────────────────────────────────────────────────── */}
        {mode === 'addons' && (
          <>
            {(addingAddon || editAddon) && (
              <form
                onSubmit={(e) => { e.preventDefault(); void submitAddon(); }}
                style={{ marginBottom: 14, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--amber-line)', animation: 'krise .18s cubic-bezier(.2,.7,.3,1)' }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', marginBottom: 11 }}>
                  {addingAddon ? 'New add-on' : 'Editing ' + editAddon}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 160px), 1fr))', gap: 10 }}>
                  {addingAddon && (
                    <Field label="Code" hint="A-Z, 0-9, dash. Cannot change later.">
                      <input required value={addonDraft.id}
                        onChange={(e) => setAddonDraft({ ...addonDraft, id: e.target.value })}
                        style={inputStyle} placeholder="EXTRA-SAMBOL" />
                    </Field>
                  )}
                  <Field label="Name">
                    <input required value={addonDraft.name}
                      onChange={(e) => setAddonDraft({ ...addonDraft, name: e.target.value })}
                      style={inputStyle} placeholder="Extra sambol" />
                  </Field>
                  <Field label="Price (MVR)"
                    hint="GST-inclusive. Nought is a real price — a free add-on still prints on the docket.">
                    <input inputMode="decimal" value={addonDraft.price}
                      onChange={(e) => setAddonDraft({ ...addonDraft, price: e.target.value })}
                      style={{ ...inputStyle, fontFamily: MONO }} placeholder="15.00" />
                  </Field>
                  <Field label="Costs the same as"
                    hint="Optional. Naming a dish makes this add-on move that dish's ingredients when it sells, so add-on revenue carries add-on cost.">
                    <select value={addonDraft.recipeItemId} style={inputStyle}
                      onChange={(e) => setAddonDraft({ ...addonDraft, recipeItemId: e.target.value })}>
                      <option value="">Nothing — it consumes no stock</option>
                      {(items ?? []).filter((i) => i.active).map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div style={{ marginTop: 12 }}>
                  <FieldLabel>Published to</FieldLabel>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {sectionNames.map((n) => {
                      const on = addonDraft.sections.includes(n);
                      return (
                        <HButton key={n} type="button" hover={on ? undefined : LIFT}
                          onClick={() => setAddonDraft({
                            ...addonDraft,
                            sections: on ? addonDraft.sections.filter((x) => x !== n)
                              : addonDraft.sections.concat([n]),
                          })}
                          style={pill(on)}>{n}</HButton>
                      );
                    })}
                    {!sectionNames.length && (
                      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                        No sections yet — put a dish in one and it appears here.
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 560 }}>
                    Every dish in a published section offers this at the next order.
                    Publishing to none means only the dishes that name it directly do.
                  </div>
                </div>

                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <HButton type="submit" disabled={busy} hover={{ background: 'var(--go-bright)' }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
                    {busy && <Busy />}
                    {busy ? 'Saving…' : addingAddon ? 'Add it' : 'Save'}
                  </HButton>
                  <HButton type="button" hover={LIFT}
                    onClick={() => { setAddingAddon(false); setEditAddon(null); setError(''); }}
                    style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                    Cancel
                  </HButton>
                </div>
              </form>
            )}

            <Note>
              Priced once, everywhere. An add-on carries its own price and the till
              re-prices every line from this list at settlement — the terminal never
              sends a price of its own. Change it here and the next order charges the
              new figure on both the till and the guest’s phone.
            </Note>

            {!addons.length ? (
              <div style={{ padding: '54px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>No add-ons yet</div>
                <div style={{ margin: '9px auto 0', maxWidth: 420, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
                  Create one and every dish in its sections offers it at the next
                  order — at the till and on the guest’s phone, from this one price.
                </div>
                <HButton onClick={() => { setAddingAddon(true); setAddonDraft(BLANK_ADDON); }}
                  hover={{ background: 'var(--amber-deep)' }}
                  style={{ marginTop: 16, padding: '10px 18px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, background: 'var(--amber)', color: 'var(--on-amber)' }}>
                  Create the first add-on
                </HButton>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--line-soft)', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line-soft)' }}>
                {addons.map((a) => (
                  <div key={a.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px',
                    flexWrap: 'wrap', background: 'var(--bg-1)', opacity: a.active ? 1 : .55,
                  }}>
                    <span style={{ minWidth: 0, flex: '1 1 200px' }}>
                      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{a.name}</span>
                        <span style={{ fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>{a.id}</span>
                        {!a.active && <Tag tone="red">Retired</Tag>}
                      </span>
                      <span style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)', flexWrap: 'wrap' }}>
                        <span>{a.sections.length ? a.sections.join(' · ') : 'Named dishes only'}</span>
                        <span>{a.dishes} dish{a.dishes === 1 ? '' : 'es'}</span>
                        {a.recipeItemName && <span>costs like {a.recipeItemName}</span>}
                      </span>
                    </span>

                    <span style={{
                      fontSize: 14, fontWeight: 700, fontFamily: MONO,
                      color: Number(a.price) ? 'var(--warn-bright)' : 'var(--green)',
                    }}>{Number(a.price) ? '+' + money(a.price) : 'Free'}</span>

                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <RowBtn onClick={() => {
                        setEditAddon(a.id); setAddingAddon(false); setError('');
                        setAddonDraft({
                          id: a.id, name: a.name, price: String(a.price),
                          sections: a.sections, recipeItemId: a.recipeItemId ?? '',
                        });
                      }}>Edit</RowBtn>
                      {a.active
                        ? <RowBtn danger onClick={() => void retireAddon(a)}>Remove</RowBtn>
                        : <RowBtn onClick={() => void call('PATCH', '/addons/' + encodeURIComponent(a.id), { active: true }).then(load)}>Restore</RowBtn>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
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

const pill = (on: boolean): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: on ? 'var(--fwd-dim)' : 'var(--bg-2)',
  color: on ? 'var(--blue-bright)' : 'var(--text-muted)',
  border: '1px solid ' + (on ? 'var(--fwd-line)' : 'var(--line)'),
});

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: 'block', marginBottom: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
      {String(children).toUpperCase()}
    </span>
  );
}

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

/* The prototype puts a note under each screen explaining the rule the screen
   enforces. It is not decoration: the rule is invisible in the data, and a
   merchant who does not know it will fight the software. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 12, padding: '10px 13px', borderRadius: 9,
      background: 'var(--bg-1)', border: '1px solid var(--line-soft)',
      fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 720,
    }}>{children}</div>
  );
}

function Tag({ tone, children }: { tone: 'red' | 'warn' | 'ok'; children: React.ReactNode }) {
  const tint = tone === 'red' ? 'var(--red-dim)' : tone === 'ok' ? 'var(--go-dim)' : 'var(--warn-dim)';
  const ink = tone === 'red' ? 'var(--red-bright)' : tone === 'ok' ? 'var(--green)' : 'var(--warn-bright)';
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 5, fontSize: 9.5, fontWeight: 700, letterSpacing: '.03em',
      background: tint, color: ink,
    }}>{children}</span>
  );
}

function RowBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <HButton onClick={onClick} hover={{ background: 'var(--bg-3)', color: danger ? 'var(--red-bright)' : 'var(--text)' }}
      style={{
        padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
        background: 'var(--bg-2)', border: '1px solid var(--line)',
        color: danger ? 'var(--red-bright)' : 'var(--text-muted)',
      }}>{children}</HButton>
  );
}
