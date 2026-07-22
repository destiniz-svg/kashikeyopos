import React, { useEffect, useMemo, useState } from 'react'
import { api, money, Product } from '../lib/api'

type Line = { p: Product; qty: number }
type OType = 'dinein' | 'takeaway' | 'delivery'

// PP0: real products + settings from our backend; local cart + live totals
// (display-only — the server stays authoritative on charge, wired in PP1).
export function Register({ dv }: { dv: boolean }) {
  const [products, setProducts] = useState<Product[]>([])
  const [currency, setCurrency] = useState('MVR')
  const [gstBp, setGstBp] = useState(800)
  const [svcBp, setSvcBp] = useState(0)
  const [err, setErr] = useState('')
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const [cart, setCart] = useState<Line[]>([])
  const [otype, setOtype] = useState<OType>('takeaway')
  const [disc, setDisc] = useState(0)

  useEffect(() => {
    Promise.all([api.products(), api.settings().catch(() => ({ settings: {} }))])
      .then(([p, s]: any) => {
        setProducts(p.products || []); setCurrency(p.currency || 'MVR')
        setGstBp(Number(s.settings?.gstBp ?? 800)); setSvcBp(Number(s.settings?.svcChargeBp ?? 0))
      })
      .catch(e => setErr(e.message))
  }, [])

  const cats = useMemo(() => ['All', ...Array.from(new Set(products.map(p => p.cat).filter(Boolean) as string[]))], [products])
  const shown = products.filter(p =>
    (cat === 'All' || p.cat === cat) &&
    (!q || (p.name + ' ' + (p.dv || '')).toLowerCase().includes(q.toLowerCase())))

  const qtyOf = (id: string) => cart.find(l => l.p.id === id)?.qty || 0
  const add = (p: Product) => setCart(c => {
    const i = c.findIndex(l => l.p.id === p.id)
    if (i < 0) return [...c, { p, qty: 1 }]
    const n = [...c]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n
  })
  const setQty = (id: string, d: number) => setCart(c =>
    c.map(l => l.p.id === id ? { ...l, qty: l.qty + d } : l).filter(l => l.qty > 0))

  const subtotal = cart.reduce((s, l) => s + l.p.price * l.qty, 0)
  const discount = Math.round(subtotal * disc / 100)
  const net = subtotal - discount
  const service = otype === 'dinein' ? Math.round(net * svcBp / 10000) : 0
  const total = net + service
  const gst = Math.round(total * gstBp / (10000 + gstBp))
  const rateLbl = 'GST ' + (gstBp / 100) + '%'

  if (err) return <Center>Couldn’t load: {err}</Center>

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* left: menu */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search menu…"
            style={{ flex: 1, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--sur)', color: 'var(--ink)', fontSize: 14, outline: 'none' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {cats.map(c => (
            <button key={c} onClick={() => setCat(c)} style={{
              padding: '7px 15px', borderRadius: 999, border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: cat === c ? 'var(--ink)' : 'var(--sur2)', color: cat === c ? 'var(--sur)' : 'var(--ink2)',
            }}>{c}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
          {shown.map(p => {
            const qn = qtyOf(p.id)
            const out = p.soldOut || (p.recipeAvail != null ? p.recipeAvail <= 0 : (p.stock != null && p.stock <= 0))
            return (
              <button key={p.id} disabled={out} onClick={() => add(p)} style={{
                textAlign: 'start', border: qn > 0 ? '1.5px solid var(--coral)' : '1px solid var(--line)',
                borderRadius: 16, background: 'var(--sur)', padding: 12, cursor: out ? 'default' : 'pointer',
                opacity: out ? .5 : 1, position: 'relative', display: 'flex', flexDirection: 'column',
              }}>
                {p.bestSeller && <span style={badge}>★ Best seller</span>}
                {p.img
                  ? <img src={p.img} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'contain', borderRadius: 10, background: 'var(--sur2)', marginBottom: 6 }} />
                  : <div style={{ fontSize: 30, marginBottom: 6 }}>{p.emoji || '🍽️'}</div>}
                <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 }}>{p.name}</div>
                {p.dv && <div style={{ fontSize: 11, opacity: .6, direction: 'rtl' }}>{p.dv}</div>}
                {p.desc && <div style={{ fontSize: 11, color: 'var(--ink3)', lineHeight: 1.25, margin: '2px 0', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as any}>{p.desc}</div>}
                {p.tags && p.tags.length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '2px 0' }}>
                  {p.tags.slice(0, 3).map((t, i) => <span key={i} style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 999, background: 'var(--sur2)', color: 'var(--ink2)' }}>{t}</span>)}
                </div>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
                  <span style={{ fontWeight: 700, fontSize: 13.5 }}>{money(currency, p.price)}</span>
                  {out
                    ? <span style={{ fontSize: 11, color: 'var(--red)' }}>Sold out</span>
                    : qn > 0
                      ? <span onClick={e => { e.stopPropagation(); }} style={stepper}>
                          <b onClick={e => { e.stopPropagation(); setQty(p.id, -1) }} style={stepBtn}>−</b>{qn}
                          <b onClick={e => { e.stopPropagation(); setQty(p.id, 1) }} style={stepBtn}>＋</b>
                        </span>
                      : <span style={{ ...stepBtn, background: 'var(--coralsoft)', color: 'var(--coral)' }}>＋</span>}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* right: cart */}
      <aside style={{ width: 350, flex: '0 0 350px', borderInlineStart: '1px solid var(--line)', background: 'var(--sur)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 15 }}>Order</strong>
          <span style={{ color: 'var(--ink3)', fontSize: 13 }}>#0001</span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setCart([])} style={ghost}>Clear</button>
        </div>
        <div style={{ padding: '10px 16px', display: 'flex', gap: 6, borderBottom: '1px solid var(--line)' }}>
          {(['dinein', 'takeaway', 'delivery'] as OType[]).map(o => (
            <button key={o} onClick={() => setOtype(o)} style={{
              flex: 1, padding: '8px 0', borderRadius: 10, border: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
              background: otype === o ? 'var(--coral)' : 'var(--sur2)', color: otype === o ? 'var(--coralink)' : 'var(--ink2)',
            }}>{o === 'dinein' ? 'Dine-In' : o === 'takeaway' ? 'Takeaway' : 'Delivery'}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {cart.length === 0
            ? <div style={{ color: 'var(--ink3)', textAlign: 'center', marginTop: 40, fontSize: 13 }}>Tap a tile to start the order</div>
            : cart.map(l => (
              <div key={l.p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{l.p.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink3)' }}>{money(currency, l.p.price)}</div>
                </div>
                <span style={stepper}>
                  <b onClick={() => setQty(l.p.id, -1)} style={stepBtn}>−</b>{l.qty}
                  <b onClick={() => setQty(l.p.id, 1)} style={stepBtn}>＋</b>
                </span>
                <div style={{ width: 70, textAlign: 'end', fontWeight: 600, fontSize: 13 }}>{money(currency, l.p.price * l.qty)}</div>
              </div>
            ))}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
            {[['None', 0], ['5%', 5], ['10%', 10], ['15%', 15], ['20%', 20]].map(([lbl, v]) => (
              <button key={lbl} onClick={() => setDisc(v as number)} style={{
                padding: '4px 9px', borderRadius: 8, border: 0, cursor: 'pointer', fontSize: 12,
                background: disc === v ? 'var(--ambersoft)' : 'var(--sur2)', color: disc === v ? 'var(--amber)' : 'var(--ink2)', fontWeight: disc === v ? 700 : 500,
              }}>{lbl}</button>
            ))}
          </div>
          <Row k="Subtotal" v={money(currency, subtotal)} />
          {discount > 0 && <Row k={`Discount ${disc}%`} v={'−' + money(currency, discount)} amber />}
          {service > 0 && <Row k={`Service ${svcBp / 100}%`} v={money(currency, service)} />}
          <Row k={rateLbl} v={money(currency, gst)} sub />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '6px 0 10px' }}>
            <strong style={{ fontSize: 15 }}>Total</strong>
            <strong style={{ fontSize: 22 }}>{money(currency, total)}</strong>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={!cart.length} style={{ ...ghost, flex: 1, padding: '12px 0', opacity: cart.length ? 1 : .5 }}>Send to KOT</button>
            <button disabled={!cart.length} style={{
              flex: 1.4, padding: '12px 0', borderRadius: 12, border: 0, fontWeight: 700, fontSize: 14,
              background: 'var(--coral)', color: 'var(--coralink)', cursor: cart.length ? 'pointer' : 'default', opacity: cart.length ? 1 : .5,
            }}>Charge {money(currency, total)}</button>
          </div>
        </div>
      </aside>
    </div>
  )
}

const badge: React.CSSProperties = { position: 'absolute', top: 8, insetInlineStart: 8, fontSize: 8.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--coral)', color: 'var(--coralink)' }
const stepper: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--coralsoft)', color: 'var(--coral)', borderRadius: 999, padding: '2px 8px', fontSize: 13, fontWeight: 700 }
const stepBtn: React.CSSProperties = { cursor: 'pointer', width: 22, height: 22, display: 'inline-grid', placeItems: 'center', fontSize: 15, borderRadius: 999 }
const ghost: React.CSSProperties = { padding: '6px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--sur)', color: 'var(--ink)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const Row = ({ k, v, sub, amber }: { k: string; v: string; sub?: boolean; amber?: boolean }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, margin: '2px 0', color: amber ? 'var(--amber)' : sub ? 'var(--ink3)' : 'var(--ink2)' }}>
    <span>{k}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
  </div>
)
const Center = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--ink3)', fontSize: 14 }}>{children}</div>
)
