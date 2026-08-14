import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The guest portal is a static site (DEPLOYMENT.md: three static sites on
// Railway). It talks to the API by absolute origin, configured at build time,
// so the deployed bundle has no same-origin assumption baked into it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4600', changeOrigin: true } } },
  build: { outDir: 'dist', sourcemap: true },
});
