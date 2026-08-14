import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/tokens/guest.css';
import { App } from './App';

/* A guest reaches this page by scanning the card on their table. The QR encodes
   the outlet and (usually) the table, so both are read from the URL rather than
   asked for — `?o=3&t=4`. A card printed without a table number falls through
   to the table gate, which is why that screen exists at all. */
const params = new URLSearchParams(location.search);
const outletId = Number(params.get('o') || 0);
const table = params.get('t') || '';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App outletId={outletId} initialTable={table} />
  </StrictMode>,
);
