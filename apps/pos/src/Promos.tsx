import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Promotions & Banners — 02-POS-SPEC.md §2 (`promos`):
 * "Codes, windows, caps. A promo the guest sees is a promo the till charges."
 *
 * WHY IS IT NOT WORKING? is the question this screen exists to answer. A
 * promotion that quietly stopped applying three weeks ago — ended, fully used,
 * not started, stopped by somebody — looks exactly like a live one in a list of
 * rows, and the first anybody hears of it is a guest at the counter holding a
 * flyer. So every row says whether it is live, and if not, in what way.
 *
 * WHAT IT HAS COST is the other figure nobody has. A promotion is the only
 * thing in a restaurant that gives money away by rule rather than by decision,
 * and "SAVE20 has been used 340 times and given away 12,400" is the sentence
 * that ends an argument about whether to run it again.
 *
 * The caps are what make a promotion safe to print. A per-bill cap especially:
 * "20% off" on a party of thirty is a number nobody signed off, and the form
 * says what the cap would do before it is saved.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m: number) =>
  String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

interface Promo {
  id: string; code: string; name: string; kind: 'percent' | 'amount'; value: number;
  minSpend: number; maxDiscount: number | null;
  maxUses: number | null; maxPerMember: number | null;
  startsOn: string | null; endsOn: string | null; days: number[];
  fromMin: number | null; toMin: number | null;
  outlet: string | null; outletId: number | null;
  membersOnly: boolean; active: boolean;
  uses: number; given: number; dormant: string | null;
}
interface Data {
  promos: Promo[];
  totals: { live: number; given: number; uses: number };
  canConfigure: boolean;
}
interface Use {
  id: number; at: string; amount: number;
  outlet: string; member: string | null; docNo: string | null;
}

export function Promos({ session }: { session: Session }) {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<Promo | null>(null);
  const [uses, setUses] = useState<Use[] | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try { setData(await call<Data>('GET', '/promos')); setError(''); }
    catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load promotions.');
      setData(null);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 9000); };
  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true); setError('');
    try { await fn(); if (said) say(said); await load(); }
    catch (e) { setError(e instanceof api.ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const openOne = async (p: Promo) => {
    setOpen(p); setUses(null);
    try {
      const r = await call<{ uses: Use[] }>('GET', `/promos/${p.id}/uses`);
      setUses(r.uses);
    } catch { setUses([]); }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Promotions</span>
        {data && data.promos.length > 0 && (
          <>
            <Fig label="RUNNING NOW" value={String(data.totals.live)} />
            <Fig label="GIVEN AWAY" value={mvr(data.totals.given)} big />
            <Fig label="TIMES USED" value={String(data.totals.uses)} />
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
            {data.canConfigure && (
              <Compose busy={busy} onSave={(b) => act(() => call('POST', '/promos', b),
                'Saved. The phone and the till read the same rules from here.')} />
            )}

            {!data.promos.length ? (
              <div style={{ padding: '30px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 580 }}>
                No promotions. Until one exists, a code typed into the guest portal is refused
                with a reason rather than quietly ignored — which is the point: a promotion the
                guest is shown is one the till will charge, and nothing else is offered.
              </div>
            ) : (
              <>
                <SubHead>Every promotion</SubHead>
                {data.promos.map((p) => (
                  <button key={p.id} onClick={() => void openOne(p)}
                    style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 2px', borderBottom: '1px solid var(--line-soft)', background: 'transparent', textAlign: 'left' }}>
                    <span style={{ width: 120, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: p.dormant ? 'var(--text-faint)' : 'var(--text)' }}>
                        {p.code}
                      </span>
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12, color: p.dormant ? 'var(--text-faint)' : 'var(--text)' }}>
                        {p.name}
                        {p.membersOnly && (
                          <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                            MEMBERS
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {describe(p)}
                      </span>
                    </span>
                    {/* Why it is not working, said on the row rather than left
                        to be worked out from four columns. */}
                    <span style={{ width: 130, textAlign: 'right', fontSize: 10.5, fontWeight: 600, color: p.dormant ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
                      {p.dormant || 'running'}
                    </span>
                    <span style={{ width: 60, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      {p.uses}
                    </span>
                    <span style={{ width: 100, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                      {mvr(p.given)}
                    </span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {open && (
        <Sheet promo={open} uses={uses} busy={busy} canConfigure={!!data?.canConfigure}
          onClose={() => { setOpen(null); setUses(null); }}
          onStop={() => act(() => call('DELETE', '/promos/' + open.id),
            open.code + ' stopped. What it already gave away stays given.')
            .then(() => setOpen(null))} />
      )}
    </div>
  );
}

/** The rules, in a sentence. */
function describe(p: Promo): string {
  const bits: string[] = [];
  bits.push(p.kind === 'percent' ? p.value + '% off' : mvr(p.value) + ' off');
  if (p.minSpend > 0) bits.push('over ' + mvr(p.minSpend));
  if (p.maxDiscount !== null) bits.push('capped at ' + mvr(p.maxDiscount));
  if (p.days.length) bits.push(p.days.map((d) => DAYS[d]).join(' '));
  if (p.fromMin !== null && p.toMin !== null) {
    bits.push(hhmm(p.fromMin) + '–' + hhmm(p.toMin));
  }
  if (p.startsOn || p.endsOn) {
    bits.push((p.startsOn || '…') + ' to ' + (p.endsOn || '…'));
  }
  if (p.maxUses !== null) bits.push(p.maxUses + ' in total');
  if (p.maxPerMember !== null) {
    bits.push(p.maxPerMember === 1 ? 'once each' : p.maxPerMember + ' each');
  }
  if (p.outlet) bits.push(p.outlet + ' only');
  return bits.join(' · ');
}

/* ── writing one ─────────────────────────────────────────────────────────── */

function Compose({ busy, onSave }: {
  busy: boolean; onSave: (b: Record<string, unknown>) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [minSpend, setMinSpend] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [maxUses, setMaxUses] = useState('');
  const [maxPerMember, setMaxPerMember] = useState('');
  const [membersOnly, setMembersOnly] = useState(false);

  const valueN = Number(value) || 0;
  const ok = /^[A-Za-z0-9]{2,24}$/.test(code.trim()) && valueN > 0
    && (kind !== 'percent' || valueN <= 100);

  /* What it would take off a typical bill, said before it is saved. A
     percentage is not a number anybody feels until it is money. */
  const example = 50000;                                  // MVR 500 of goods
  const wouldTake = kind === 'percent'
    ? Math.round(example * valueN / 100)
    : Math.round(valueN * 100);
  const capped = Number(maxDiscount) > 0
    && wouldTake > Math.round(Number(maxDiscount) * 100);

  return (
    <div style={{ marginBottom: 18, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <SubHead>Write a promotion</SubHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 140px), 1fr))', gap: 11, marginTop: 6 }}>
        <L label="Code" hint="Letters and digits — it gets read out over a telephone.">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            aria-label="Code" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="What to call it">
          <input value={name} onChange={(e) => setName(e.target.value)}
            aria-label="What to call it" style={inp} />
        </L>
        <L label="Kind">
          <select value={kind} aria-label="Kind"
            onChange={(e) => setKind(e.target.value as 'percent' | 'amount')} style={inp}>
            <option value="percent">a percentage off</option>
            <option value="amount">an amount off</option>
          </select>
        </L>
        <L label={kind === 'percent' ? 'Percent' : 'Amount (MVR)'}>
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)}
            aria-label="Value" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Only over (MVR)" hint="Blank for any bill.">
          <input inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)}
            aria-label="Only over" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Never more than (MVR)"
          hint="The most it can take off one bill. Blank is uncapped.">
          <input inputMode="decimal" value={maxDiscount}
            onChange={(e) => setMaxDiscount(e.target.value)}
            aria-label="Never more than" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="From">
          <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)}
            aria-label="From" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Until">
          <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)}
            aria-label="Until" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Total uses" hint="Blank for no limit.">
          <input inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)}
            aria-label="Total uses" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="Per customer" hint="Needs the customer named at the till.">
          <input inputMode="numeric" value={maxPerMember}
            onChange={(e) => setMaxPerMember(e.target.value)}
            aria-label="Per customer" style={{ ...inp, fontFamily: MONO }} />
        </L>
      </div>

      <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>
          DAYS
        </span>
        {DAYS.map((d, i) => {
          const on = days.includes(i);
          return (
            <button key={d} onClick={() => setDays(on ? days.filter((x) => x !== i) : [...days, i])}
              style={{ padding: '4px 9px', borderRadius: 6, fontSize: 11, fontWeight: on ? 700 : 500, background: on ? 'var(--amber)' : 'var(--bg-2)', color: on ? 'var(--on-amber)' : 'var(--text-muted)', border: '1px solid ' + (on ? 'var(--amber)' : 'var(--line)') }}>
              {d}
            </button>
          );
        })}
        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
          {days.length ? '' : 'every day'}
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={membersOnly}
            onChange={(e) => setMembersOnly(e.target.checked)} />
          members only
        </label>
      </div>

      <div style={{ marginTop: 13, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button disabled={busy || !ok} onClick={() => {
          onSave({
            code: code.trim(), name: name.trim() || code.trim(), kind, value: valueN,
            minSpend: Number(minSpend) || 0,
            maxDiscount: Number(maxDiscount) || null,
            maxUses: Number(maxUses) || null,
            maxPerMember: Number(maxPerMember) || null,
            startsOn: startsOn || null, endsOn: endsOn || null,
            days, membersOnly,
          });
          setCode(''); setName(''); setValue(''); setMinSpend(''); setMaxDiscount('');
          setMaxUses(''); setMaxPerMember(''); setDays([]); setMembersOnly(false);
        }}
          style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
          Save it
        </button>
        {valueN > 0 && (
          <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 460 }}>
            On a <b style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>500.00</b> bill this
            takes off{' '}
            <b style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>
              {mvr(Math.min(wouldTake, Number(maxDiscount) > 0 ? Number(maxDiscount) * 100 : wouldTake) / 100)}
            </b>
            {capped && ' — the cap bites'}.
          </span>
        )}
      </div>
    </div>
  );
}

/* ── one promotion ───────────────────────────────────────────────────────── */

function Sheet({ promo, uses, busy, canConfigure, onClose, onStop }: {
  promo: Promo; uses: Use[] | null; busy: boolean; canConfigure: boolean;
  onClose: () => void; onStop: () => void;
}) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 20, animation: 'kfade .14s' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Promotion"
        style={{ width: '100%', maxWidth: 660, maxHeight: '86dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', animation: 'kmodal .18s' }}>
        <div style={{ flexShrink: 0, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
            {promo.code}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{promo.name}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div style={{ flexShrink: 0, padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <Fig label="USED" value={String(promo.uses)} />
          <Fig label="GIVEN AWAY" value={mvr(promo.given)} big />
          <span style={{ fontSize: 11, color: promo.dormant ? 'var(--stop-bright)' : 'var(--go-bright)' }}>
            {promo.dormant || 'running'}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', maxWidth: 300, lineHeight: 1.5 }}>
            {describe(promo)}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px 16px' }}>
          <SubHead>Where it has been used</SubHead>
          {!uses ? (
            <div style={{ padding: '18px 2px', fontSize: 12, color: 'var(--text-faint)' }}>Loading…</div>
          ) : !uses.length ? (
            <div style={{ padding: '18px 2px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-faint)', maxWidth: 480 }}>
              Nobody has used it yet. A code that has been printed and never redeemed is worth
              knowing about too.
            </div>
          ) : uses.map((u) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 2px', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ width: 96, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                {new Date(u.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text)' }}>
                {u.member || 'a guest'}
                {u.docNo && (
                  <span style={{ marginLeft: 6, fontSize: 10, fontFamily: MONO, color: 'var(--text-faint)' }}>
                    {u.docNo}
                  </span>
                )}
              </span>
              <span style={{ width: 90, textAlign: 'right', fontSize: 10.5, color: 'var(--text-faint)' }}>
                {u.outlet}
              </span>
              <span style={{ width: 90, textAlign: 'right', fontSize: 12.5, fontWeight: 600, fontFamily: MONO, color: 'var(--text)' }}>
                {mvr(u.amount)}
              </span>
            </div>
          ))}

          {canConfigure && promo.active && (
            <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
              <button disabled={busy} onClick={onStop}
                style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--stop)', color: 'var(--on-stop, #fff)' }}>
                Stop it
              </button>
              <p style={{ margin: '9px 2px 0', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 480 }}>
                It stops being honoured from the moment you press this — on the phone and at the
                till alike, because both ask the same question of the same row. What it has
                already given away stays given.
              </p>
            </div>
          )}
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

function Fig({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <span>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: big ? 20 : 14, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>{value}</span>
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
