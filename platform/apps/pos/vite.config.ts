import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/api': { target: 'http://127.0.0.1:4600', changeOrigin: true } } },
  preview: { port: 5200, proxy: { '/api': { target: 'http://127.0.0.1:4600', changeOrigin: true } } },
  build: {
    outDir: 'dist', sourcemap: true,
    /* packages/money is CommonJS and lives OUTSIDE this app, so Vite's
       CommonJS interop has to be told about it explicitly — by default it only
       transforms node_modules. Without this the till would have to keep its own
       copy of the bill calculation, which is the one thing this build has
       already been burnt by. */
    commonjsOptions: { include: [/packages[/\\]money/, /node_modules/] },
  },
  optimizeDeps: { include: [] },
});
