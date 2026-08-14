import { useMemo, useState } from 'react';
import { Api, ApiError, type Snapshot } from './api';
import { C, HIT, MONO } from '../../../packages/tokens/guest';

/* Bill tab — spec §6. The live ticket AS THE TILL HOLDS IT.
 *
 * The phone keeps no copy of what is owed. Every figure on this screen is read
 * from the snapshot, so a round a server added at the table appears here
 * without the guest doing anything, and the two can never disagree.
 *
 * The primary action ASKS TO PAY. It notifies the till with the tender
 * preference, the split and the tip. It does not charge anything — there is no
 * endpoint on this app that could.
 */

const money = (laari: number) =>
  (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toLaari = (mvr: string | number) => Math.round(Number(mvr) * 100);

type Split = 'all' | 'evenly' | 'mine' | 'custom';

interface Props {
  snap: Snapshot | null;
  table: string;
  api: Api;
  say: (m: string) => void;
  onBrowse: () => void;
}

export function BillTab({ snap, table, api, say, onBrowse }: Props) {
  const [split, setSplit] = useState<Split>('all');
  const [splitN, setSplitN] = useState(2);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [custom, setCustom] = useState('');
  const [tipPct, setTipPct] = useState(0);
  const [tender, setTender] = useState<'card' | 'cash'>('card');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  /* The table's open ticket, as the till holds it. A table with several splits
     shows the one for this table number; the till owns which is which. */
  const ticket = useMemo(
    () => snap?.tickets?.find((t) => String(t.table_no) === String(table)) ?? null,
    [snap, table],
  );

  const lines = ticket?.lines ?? [];
  const goods = lines.reduce((a, l) => a + toLaari(l.price) * Number(l.qty), 0);
  const servicePct = Number(snap?.outlet?.service_pct ?? 0);
  const taxCode = snap?.tax?.code ?? 'GST';
  const taxRate = Number(snap?.tax?.rate ?? 0);

  /* The same model the server uses: prices are GST-INCLUSIVE, service applies
     to the goods and is itself taxable, and GST is EXTRACTED rather than added.
     Shown here so a guest can see how the figure is built — the till's own
     computation is still the one that settles. */
  const service = Math.round(goods * servicePct / 100);
  const taxable = goods + service;
  const tax = Math.round(taxable * (taxRate / 100) / (1 + taxRate / 100));
  const total = taxable;

  const mine = useMemo(() => {
    if (split === 'all') return total;
    if (split === 'evenly') return Math.round(total / Math.max(1, splitN));
    if (split === 'custom') return Math.max(0, Math.round(Number(custom || 0) * 100));
    const g = lines.reduce((a, l, i) => a + (picked[i] ? toLaari(l.price) * Number(l.qty) : 0), 0);
    const s = Math.round(g * servicePct / 100);
    return g + s;
  }, [split, splitN, custom, picked, lines, total, servicePct]);

  const tip = Math.round(mine * tipPct / 100);
  const paying = mine + tip;
  const over = split === 'custom' && mine > total;

  const ask = async () => {
    if (asking) return;
    setAsking(true);
    setError('');
    try {
      const detail = [
        tender === 'cash' ? 'cash' : 'card',
        split === 'all' ? 'the whole table'
          : split === 'evenly' ? 'split ' + splitN + ' ways'
            : split === 'custom' ? 'a set amount' : 'what they ate',
        'MVR ' + money(paying),
        tip ? 'incl. MVR ' + money(tip) + ' tip' : '',
      ].filter(Boolean).join(' · ');
      await api.askToPay(table, detail);
      say('A server is on their way to settle');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not reach the till. Please catch a server.');
    } finally {
      setAsking(false);
    }
  };

  if (!ticket || !lines.length) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px' }} className="qs">
        <div style={{ fontSize: 22, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.03em' }}>Your bill</div>
        <div style={{ padding: '46px 6px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: C.inkGhost, lineHeight: 1.6, textWrap: 'pretty' }}>
            {snap
              ? 'Nothing on this table yet. Your bill appears here as soon as a server has confirmed your first round.'
              : 'Loading your bill…'}
          </div>
          <button onClick={onBrowse} style={{ marginTop: 16, padding: '13px 20px', borderRadius: 16, background: C.accent, color: '#fff', fontSize: 14, fontWeight: 700, minHeight: HIT.primary }}>
            Browse the menu
          </button>
        </div>
      </div>
    );
  }

  const SPLITS: { k: Split; label: string }[] = [
    { k: 'all', label: "I'll get it" },
    { k: 'evenly', label: 'Split evenly' },
    { k: 'mine', label: 'What I ate' },
    { k: 'custom', label: 'Custom amount' },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px' }} className="qs">
      <div style={{ fontSize: 22, fontWeight: 700, color: C.inkStrong, letterSpacing: '-.03em' }}>Your bill</div>
      <div style={{ marginTop: 4, fontSize: 13, color: C.inkMuted }}>{'Table ' + table}</div>

      {/* Lines */}
      <div style={{ marginTop: 16 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid ' + C.hairlineSoft }}>
            {split === 'mine' && (
              <button
                onClick={() => setPicked((p) => ({ ...p, [i]: !p[i] }))}
                aria-pressed={!!picked[i]}
                aria-label={'Include ' + l.name}
                style={{
                  width: 24, height: 24, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: picked[i] ? C.accent : C.surfaceTint,
                  border: '1px solid ' + (picked[i] ? C.accent : C.hairline),
                }}
              >
                {picked[i] && (
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                )}
              </button>
            )}
            <span style={{ fontSize: 13, fontWeight: 500, fontFamily: MONO, color: C.inkMuted, minWidth: 26 }}>
              {Number(l.qty)}×
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: C.inkMid }}>{l.name}</span>
            <span style={{ fontSize: 13.5, fontWeight: 500, fontFamily: MONO, color: C.inkStrong }}>
              {money(toLaari(l.price) * Number(l.qty))}
            </span>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row label="Subtotal" value={money(goods)} />
        {servicePct > 0 && <Row label={'Service charge ' + servicePct + '%'} value={money(service)} />}
        {taxRate > 0 && <Row label={taxCode + ' ' + taxRate + '%'} value={money(tax)} muted />}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, paddingTop: 10, borderTop: '1px solid ' + C.hairline }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.inkStrong }}>Table total</span>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: C.inkStrong }}>{money(total)}</span>
        </div>
        {taxRate > 0 && (
          <div style={{ fontSize: 11.5, color: C.inkGhost, lineHeight: 1.5 }}>
            {taxCode + ' is included in the prices shown.'}
          </div>
        )}
      </div>

      {/* Split modes */}
      <div style={{ marginTop: 22, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>HOW ARE YOU PAYING?</div>
      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
        {SPLITS.map((s) => {
          const on = split === s.k;
          return (
            <button key={s.k} onClick={() => setSplit(s.k)}
              style={{
                padding: '13px 14px', borderRadius: 14, minHeight: HIT.row, fontSize: 13.5, fontWeight: 600,
                background: on ? '#fff5f3' : C.surfaceTint,
                border: '1px solid ' + (on ? C.accent : 'transparent'),
                color: on ? C.accentDeep : C.inkSoft,
              }}>{s.label}</button>
          );
        })}
      </div>

      {split === 'evenly' && (
        <div style={{ marginTop: 13, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 13.5, color: C.inkSoft, flex: 1 }}>Between how many?</span>
          <button onClick={() => setSplitN((n) => Math.max(2, n - 1))} aria-label="Fewer people"
            style={{ width: 32, height: 32, borderRadius: 16, background: C.surfaceTint, color: C.inkMid, display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
          </button>
          <span style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO, minWidth: 22, textAlign: 'center' }}>{splitN}</span>
          <button onClick={() => setSplitN((n) => Math.min(20, n + 1))} aria-label="More people"
            style={{ width: 32, height: 32, borderRadius: 16, background: C.surfaceTint, color: C.inkMid, display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      )}

      {split === 'custom' && (
        <div style={{ marginTop: 13, display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 14px', borderRadius: 14, border: '1.4px solid ' + C.accent }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: C.accentDeep, fontFamily: MONO }}>MVR</span>
          <input value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal" placeholder="0.00" aria-label="Amount you are paying"
            style={{ fontSize: 16, fontWeight: 700, color: C.inkStrong, fontFamily: MONO }} />
        </div>
      )}

      {/* Spec §6: paying more than the bill should be a TIP, added below, so
          the team actually receives it. */}
      {over && (
        <div style={{ marginTop: 11, padding: '11px 13px', borderRadius: 12, background: C.warnBg, border: '1px solid ' + C.warnBorder, color: C.danger, fontSize: 13, lineHeight: 1.5 }}>
          That is more than the table owes. If you meant it as a tip, add it below instead — that way the team actually receives it.
        </div>
      )}

      {/* Tip */}
      <div style={{ marginTop: 22, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>ADD A TIP</div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        {[0, 5, 10, 15].map((p) => {
          const on = tipPct === p;
          return (
            <button key={p} onClick={() => setTipPct(p)}
              style={{
                flex: 1, minHeight: HIT.row, borderRadius: 14, fontSize: 13.5, fontWeight: 700, textAlign: 'center',
                background: on ? C.accent : C.surfaceTint, color: on ? '#fff' : C.inkSoft,
              }}>{p === 0 ? 'None' : p + '%'}</button>
          );
        })}
      </div>

      {/* Tender preference */}
      <div style={{ marginTop: 22, fontSize: 12, fontWeight: 700, color: C.label, letterSpacing: '.08em' }}>HOW WILL YOU PAY?</div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        {(['card', 'cash'] as const).map((t) => {
          const on = tender === t;
          return (
            <button key={t} onClick={() => setTender(t)}
              style={{
                flex: 1, minHeight: HIT.row, borderRadius: 14, fontSize: 13.5, fontWeight: 700, textAlign: 'center',
                background: on ? C.accent : C.surfaceTint, color: on ? '#fff' : C.inkSoft,
              }}>{t === 'card' ? 'Card' : 'Cash'}</button>
          );
        })}
      </div>

      {/* "You are paying" panel — spec §6 */}
      <div style={{ marginTop: 22, padding: 16, borderRadius: 16, background: '#fff5f3' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.danger }}>You are paying</div>
        <div style={{ marginTop: 5, fontSize: 23, fontWeight: 800, fontFamily: MONO, color: C.accent, letterSpacing: '-.03em' }}>
          {'MVR ' + money(paying)}
        </div>
        <div style={{ marginTop: 7, fontSize: 12.5, color: C.inkSoft, lineHeight: 1.5, textWrap: 'pretty' }}>
          {(split === 'all' ? 'The whole table'
            : split === 'evenly' ? 'Your share of ' + splitN
              : split === 'custom' ? 'An amount you set'
                : 'The dishes you ticked')
            + (servicePct ? ', including service' : '')
            + (taxRate ? ' and ' + taxCode : '')
            + (tip ? ', plus a ' + tipPct + '% tip for the team' : '') + '.'}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12, padding: '11px 13px', borderRadius: 12, background: C.warnBg, border: '1px solid ' + C.warnBorder, color: C.warnInk, fontSize: 13, lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      <button
        onClick={ask}
        disabled={asking}
        style={{
          marginTop: 16, width: '100%', padding: 15, borderRadius: 16,
          background: asking ? C.disabled : C.accent, color: '#fff',
          fontSize: 15, fontWeight: 700, textAlign: 'center', minHeight: HIT.primary,
          boxShadow: asking ? 'none' : C.accentShadow,
        }}
      >
        {asking ? 'Letting them know…' : 'Ask to pay'}
      </button>
      <div style={{ marginTop: 9, fontSize: 12, color: C.inkGhost, lineHeight: 1.5, textAlign: 'center', textWrap: 'pretty' }}>
        This tells the till how you would like to settle. A server brings the machine over — nothing is charged from your phone.
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ fontSize: 13, color: muted ? C.inkMuted : C.inkSoft }}>{label}</span>
      <span style={{ fontSize: 13, fontFamily: MONO, color: muted ? C.inkMuted : C.inkMid }}>{value}</span>
    </div>
  );
}
