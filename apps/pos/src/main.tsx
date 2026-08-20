import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/tokens/pos.css';
import { App } from './App';
import { applyTheme, readTheme, watchSystem } from './theme';

/* BEFORE REACT RENDERS ANYTHING. The palette used to be applied by an effect
   inside Settings, so it only took hold while that screen was open — a manager
   who chose Light and reloaded got Dark on the till, with Settings still
   truthfully reporting "Light". */
applyTheme(readTheme(), false);
watchSystem(readTheme);

/* A terminal belongs to one outlet. It is set at install time, not chosen by
   whoever is standing at it — a till that can be pointed at another branch is a
   till that can ring a sale into the wrong books. */
const outletId = Number(
  new URLSearchParams(location.search).get('o')
  || import.meta.env.VITE_OUTLET_ID
  || 0,
);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App outletId={outletId} /></StrictMode>,
);
