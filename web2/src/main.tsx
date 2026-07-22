import React from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme } from './theme'
import { App } from './App'

applyTheme(false)
document.body.style.margin = '0'
document.body.style.background = 'var(--bg)'
document.body.style.color = 'var(--ink)'
document.body.style.fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

createRoot(document.getElementById('root')!).render(<App />)
