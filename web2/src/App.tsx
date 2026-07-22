import React, { useEffect, useState } from 'react'
import { applyTheme } from './theme'
import { Register } from './screens/Register'

const NAV: [string, string][] = [
  ['register', 'Register'], ['floor', 'Floor'], ['kitchen', 'Kitchen'],
  ['qr', 'QR Orders'], ['dashboard', 'Dashboard'], ['analytics', 'Analytics'],
  ['inventory', 'Inventory'], ['tabs', 'Tabs'], ['dayend', 'Day End'],
  ['staff', 'Staff'], ['outlets', 'Outlets'], ['delivery', 'Delivery'],
  ['expenses', 'Expenses'], ['setup', 'Setup'],
]

export function App() {
  const [scr, setScr] = useState('register')
  const [dark, setDark] = useState(false)
  const [dv, setDv] = useState(false)
  useEffect(() => applyTheme(dark), [dark])

  return (
    <div style={{ display: 'flex', minHeight: '100vh', direction: dv ? 'rtl' : 'ltr' }}>
      {/* Icon rail */}
      <nav style={{
        width: 92, flex: '0 0 92px', background: 'var(--sur)', borderInlineEnd: '1px solid var(--line)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 0', gap: 4,
        position: 'sticky', top: 0, height: '100vh', overflowY: 'auto',
      }}>
        <div style={{
          width: 46, height: 46, borderRadius: 14, marginBottom: 10, display: 'grid', placeItems: 'center',
          background: 'linear-gradient(160deg, var(--coral), color-mix(in srgb, var(--coral) 70%, #000))',
          color: 'var(--coralink)', fontWeight: 800, fontSize: 20,
        }}>K</div>
        {NAV.map(([id, label]) => {
          const on = scr === id
          return (
            <button key={id} onClick={() => setScr(id)} style={{
              width: 74, padding: '8px 4px', border: 0, borderRadius: 12, cursor: 'pointer',
              background: on ? 'var(--coralsoft)' : 'transparent', color: on ? 'var(--coral)' : 'var(--ink2)',
              fontSize: 10.5, fontWeight: on ? 700 : 500, lineHeight: 1.15,
            }}>{label}</button>
          )
        })}
      </nav>

      {/* Right column */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{
          height: 58, flex: '0 0 58px', display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 18px', borderBottom: '1px solid var(--line)',
        }}>
          <strong style={{ fontSize: 15 }}>Kashikeyo Café</strong>
          <span style={{
            fontSize: 12, padding: '3px 9px', borderRadius: 999, background: 'var(--greensoft)',
            color: 'var(--green)', fontWeight: 600,
          }}>● General · GGST 8%</span>
          <div style={{ flex: 1 }} />
          <span style={{
            fontSize: 12, padding: '3px 9px', borderRadius: 999, background: 'var(--greensoft)', color: 'var(--green)',
          }}>● Online</span>
          <button onClick={() => setDv(v => !v)} style={pill}>{dv ? 'EN' : 'ދިވެހި'}</button>
          <button onClick={() => setDark(d => !d)} style={pill}>{dark ? '☀' : '☾'}</button>
        </header>

        <main style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {scr === 'register'
            ? <Register dv={dv} />
            : <Placeholder title={NAV.find(n => n[0] === scr)?.[1] || scr} />}
        </main>
      </div>
    </div>
  )
}

const pill: React.CSSProperties = {
  fontSize: 12, padding: '5px 10px', borderRadius: 10, border: '1px solid var(--line)',
  background: 'var(--sur)', color: 'var(--ink)', cursor: 'pointer',
}

function Placeholder({ title }: { title: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--ink3)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink2)' }}>{title}</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>Wired in a later phase (PP3–PP9) against our existing API.</div>
      </div>
    </div>
  )
}
