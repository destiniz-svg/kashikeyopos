import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserMultiFormatReader, BrowserQRCodeReader } from '@zxing/library';

window.KashikeyoPOSBarcodeReaders = {
  BrowserMultiFormatReader,
  BrowserQRCodeReader,
};

function App() {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: '#020617',
      color: '#f8fafc',
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      padding: '2rem',
      textAlign: 'center',
    }}>
      <section style={{ maxWidth: '36rem' }}>
        <h1 style={{ fontSize: '2rem', margin: '0 0 0.75rem', fontWeight: 800 }}>
          KashikeyoPOS
        </h1>
        <p style={{ margin: 0, color: '#cbd5e1', lineHeight: 1.6 }}>
          The app is configured for Vite module builds. Barcode readers are loaded from @zxing/library as ES modules.
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
