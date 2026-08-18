import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/tokens/guest.css';
import { App } from './App';

/* The member portal is reached by a link, not a QR card on a table: it is
   chain-wide, so there is nothing in the URL to read. Who is asking comes from
   the session in storage, or from signing in. */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
