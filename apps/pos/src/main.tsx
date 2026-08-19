import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/tokens/pos.css';
import { App } from './App';

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
