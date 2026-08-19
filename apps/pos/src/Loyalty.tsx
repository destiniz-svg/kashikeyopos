import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* Loyalty & Rewards — 02-POS-SPEC.md §2 (`loyalty`):
 * "Earn rate, tier ladder, reward catalogue. Points are a liability
 *  (account 2200)."
 *
 * THE FIGURE THIS SCREEN EXISTS FOR is what it would cost to honour every point
 * outstanding. A loyalty scheme is the one thing in a restaurant that quietly
 * accrues a real debt on every sale, at every branch, and the number nobody
 * computes until somebody asks why 2200 keeps growing. It is at the top, in the
 * largest type, before anything about tiers or rewards.
 *
 * A ZERO EARN RATE MEANS THE SCHEME IS NOT RUNNING and the screen says so
 * plainly rather than showing a row of noughts. There is no default rate,
 * because a default would have every restaurant that installed this accruing a
 * liability nobody agreed to.
 *
 * THE CHAIN'S POINTS AND THIS BRANCH'S LIABILITY ARE DIFFERENT NUMBERS. A
 * member earns at one outlet and spends at another, so what this branch issued
 * is not what the chain owes. Both are shown, labelled, rather than one blended
 * figure that would be nobody's balance.
 */

const MONO = "'JetBrains Mono',monospace";
const mvr = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

interface Tier { name: string; points: number }
interface Config {
  earnPerMvr: number; pointValue: number; tiers: Tier[];
  running: boolean; setAt: string | null;
}
interface Reward {
  id: string; name: string; points: number; value: number;
  active: boolean; pointsWorth: number | null;
}
interface Data {
  config: Config;
  outstanding: number; liability: number; members: number;
  hereEarned: number; hereRedeemed: number; hereCost: number;
  ladder: Array<{ name: string; points: number; members: number }>;
  rewards: Reward[];
  canConfigure: boolean;
}

export function Loyalty({ session }: { session: Session }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useMemo(() => api.authed(session), [session]);

  const load = useCallback(async () => {
    try { setData(await call<Data>('GET', '/loyalty')); setError(''); }
    catch (e) {
      setError(e instanceof api.ApiError ? e.message : 'Could not load the scheme.');
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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Loyalty</span>
        {data?.config.running && (
          <>
            {/* The number the scheme is actually measured by. */}
            <Fig label="OWED IF EVERY POINT WERE SPENT" value={mvr(data.liability)} big />
            <Fig label="POINTS OUT THERE" value={num(data.outstanding)} />
            <Fig label="MEMBERS HOLDING" value={String(data.members)} />
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
            {!data.config.running && (
              <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)', maxWidth: 620 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                  The scheme is not running
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
                  Nothing is being earned and nothing can be spent. There is no default earn
                  rate on purpose: a point is a promise to hand something over later, and a
                  scheme that switched itself on would have this business owing money nobody
                  agreed to. Set a rate and what a point is worth, and it starts.
                </p>
              </div>
            )}

            {data.canConfigure && (
              <Scheme cfg={data.config} busy={busy}
                onSave={(b) => act(() => call('POST', '/loyalty/config', b),
                  'Saved. It applies to every branch — a member earns here and spends there.')} />
            )}

            {data.config.running && (
              <div style={{ marginBottom: 18, padding: 13, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
                <SubHead>At this branch</SubHead>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 6 }}>
                  <Fig label="POINTS ISSUED HERE" value={num(data.hereEarned)} />
                  <Fig label="HONOURED HERE" value={num(data.hereRedeemed)} />
                  <Fig label="COST OF ISSUING" value={mvr(data.hereCost)} />
                </div>
                {/* The distinction that is easy to assume away. */}
                <p style={{ margin: '9px 2px 0', fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 620 }}>
                  A member earns at one branch and spends at another, so what this branch has
                  issued is not what the chain owes. Account 2200 here carries this branch&apos;s
                  own share; a branch that honours more than it issues carries a negative one,
                  which is what one set of books owing another looks like.
                </p>
              </div>
            )}

            {data.ladder.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <SubHead>The ladder</SubHead>
                {data.ladder.map((t) => (
                  <div key={t.name} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 2px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                      {t.name}
                    </span>
                    <span style={{ width: 120, textAlign: 'right', fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>
                      {num(t.points)} points
                    </span>
                    <span style={{ width: 110, textAlign: 'right', fontSize: 13, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
                      {t.members}
                    </span>
                    <span style={{ width: 70, fontSize: 10, color: 'var(--text-faint)' }}>
                      {t.members === 1 ? 'member' : 'members'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <Catalogue data={data} busy={busy}
              onSave={(b) => act(() => call('POST', '/loyalty/rewards', b), 'Added.')}
              onDrop={(id) => act(() => call('DELETE', '/loyalty/rewards/' + id), 'Removed.')} />
          </>
        )}
      </div>
    </div>
  );
}

/* ── the scheme ──────────────────────────────────────────────────────────── */

function Scheme({ cfg, busy, onSave }: {
  cfg: Config; busy: boolean; onSave: (b: Record<string, unknown>) => void;
}) {
  const [earn, setEarn] = useState(String(cfg.earnPerMvr || ''));
  const [value, setValue] = useState(String(cfg.pointValue || ''));
  const [tiers, setTiers] = useState<Tier[]>(cfg.tiers);
  const [name, setName] = useState('');
  const [at, setAt] = useState('');

  const earnN = Number(earn) || 0;
  const valueN = Number(value) || 0;
  /* What a hundred rufiyaa of food actually gives away. An earn rate and a
     point value are two numbers nobody can multiply in their head into the one
     that matters. */
  const per100 = earnN * 100 * valueN;

  return (
    <div style={{ marginBottom: 18, padding: 14, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
      <SubHead>The scheme</SubHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 160px), 1fr))', gap: 11, marginTop: 6 }}>
        <L label="Points per MVR" hint="Earned on the food and drink, not on tax or service.">
          <input inputMode="decimal" value={earn} onChange={(e) => setEarn(e.target.value)}
            aria-label="Points per MVR" style={{ ...inp, fontFamily: MONO }} />
        </L>
        <L label="A point is worth (MVR)" hint="What the business promises to honour.">
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)}
            aria-label="A point is worth" style={{ ...inp, fontFamily: MONO }} />
        </L>
      </div>
      {per100 > 0 && (
        <p style={{ margin: '10px 2px 0', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
          Every <b style={{ color: 'var(--text-muted)', fontFamily: MONO }}>100.00</b> of food gives
          away <b style={{ color: 'var(--text-muted)', fontFamily: MONO }}>{mvr(per100)}</b> —{' '}
          {(per100).toFixed(1)}% of the bill, accrued on the day it is earned.
        </p>
      )}

      <div style={{ marginTop: 16 }}>
        <SubHead>Tiers</SubHead>
        {tiers.map((t, i) => (
          <div key={t.name + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px' }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>{t.name}</span>
            <span style={{ fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>
              from {num(t.points)} points
            </span>
            <button onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
              aria-label={'Remove ' + t.name}
              style={{ padding: '4px 9px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
              Remove
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <span style={{ flex: '1 1 140px' }}>
            <L label="Tier name">
              <input value={name} onChange={(e) => setName(e.target.value)}
                aria-label="Tier name" style={inp} />
            </L>
          </span>
          <span style={{ flex: '0 1 140px' }}>
            <L label="From (points)">
              <input inputMode="numeric" value={at} onChange={(e) => setAt(e.target.value)}
                aria-label="From points" style={{ ...inp, fontFamily: MONO }} />
            </L>
          </span>
          <button disabled={!name.trim() || !(Number(at) >= 0) || at === ''}
            onClick={() => {
              setTiers([...tiers, { name: name.trim(), points: Number(at) }]
                .sort((a, b) => a.points - b.points));
              setName(''); setAt('');
            }}
            style={{ height: 34, padding: '0 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
            Add a tier
          </button>
        </div>
      </div>

      <button disabled={busy}
        onClick={() => onSave({ earnPerMvr: earnN, pointValue: valueN, tiers })}
        style={{ marginTop: 14, padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: 'var(--go)', color: 'var(--on-go)' }}>
        {cfg.running ? 'Save the scheme' : 'Start the scheme'}
      </button>
      {cfg.running && earnN === 0 && (
        <p style={{ margin: '9px 2px 0', fontSize: 11, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 500 }}>
          Setting the rate to nought stops the scheme earning. Points already issued are still
          owed and can still be spent — stopping a scheme does not un-promise anything.
        </p>
      )}
    </div>
  );
}

/* ── the catalogue ───────────────────────────────────────────────────────── */

function Catalogue({ data, busy, onSave, onDrop }: {
  data: Data; busy: boolean;
  onSave: (b: Record<string, unknown>) => void;
  onDrop: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState('');
  const [value, setValue] = useState('');

  const pointsN = Number(points) || 0;
  const valueN = Number(value) || 0;
  const worth = pointsN * data.config.pointValue;
  const ok = name.trim() !== '' && pointsN > 0 && valueN > 0;

  return (
    <>
      <SubHead>What points can buy</SubHead>
      {data.canConfigure && (
        <div style={{ marginBottom: 14, padding: 13, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%, 140px), 1fr))', gap: 11 }}>
            <L label="Reward">
              <input value={name} onChange={(e) => setName(e.target.value)}
                aria-label="Reward" style={inp} />
            </L>
            <L label="Costs (points)">
              <input inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)}
                aria-label="Costs points" style={{ ...inp, fontFamily: MONO }} />
            </L>
            <L label="Worth (MVR)" hint="What the business gives up.">
              <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)}
                aria-label="Worth" style={{ ...inp, fontFamily: MONO }} />
            </L>
          </div>
          <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button disabled={busy || !ok}
              onClick={() => {
                onSave({ name: name.trim(), points: pointsN, value: valueN });
                setName(''); setPoints(''); setValue('');
              }}
              style={{ padding: '9px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, background: ok ? 'var(--go)' : 'var(--bg-2)', color: ok ? 'var(--on-go)' : 'var(--text-faint)' }}>
              Add it
            </button>
            {/* Priced below what the points are worth it is given away twice;
                far above and nobody will ever take it. */}
            {pointsN > 0 && data.config.pointValue > 0 && valueN > 0 && (
              <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)', maxWidth: 420 }}>
                {pointsN} points are worth {mvr(worth)}.{' '}
                {valueN > worth * 1.05
                  ? 'This gives away ' + mvr(valueN - worth) + ' more than the points cover.'
                  : valueN < worth * 0.95
                    ? 'The points are worth more than the reward — nobody will take it.'
                    : 'That is about what they are worth.'}
              </span>
            )}
          </div>
        </div>
      )}

      {!data.rewards.length ? (
        <div style={{ padding: '24px 4px', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)', maxWidth: 560 }}>
          Nothing in the catalogue. Points can still be spent against a bill at what they are
          worth — a catalogue is for the things a member would rather have than the money.
        </div>
      ) : data.rewards.map((rw) => (
        <div key={rw.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: rw.active ? 'var(--text)' : 'var(--text-faint)' }}>
            {rw.name}
            {!rw.active && (
              <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em' }}>
                OFF
              </span>
            )}
          </span>
          <span style={{ width: 110, textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontFamily: MONO, color: 'var(--text)' }}>
            {num(rw.points)}
          </span>
          <span style={{ width: 46, fontSize: 10, color: 'var(--text-faint)' }}>points</span>
          <span style={{ width: 100, textAlign: 'right', fontSize: 11.5, fontFamily: MONO, color: 'var(--text-muted)' }}>
            {mvr(rw.value)}
          </span>
          <span style={{ width: 110, textAlign: 'right', fontSize: 10.5, fontFamily: MONO, color: 'var(--text-faint)' }}>
            {rw.pointsWorth === null ? '' : 'worth ' + mvr(rw.pointsWorth)}
          </span>
          {data.canConfigure && (
            <button disabled={busy} onClick={() => onDrop(rw.id)}
              style={{ padding: '4px 9px', borderRadius: 6, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
              Remove
            </button>
          )}
        </div>
      ))}
    </>
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
