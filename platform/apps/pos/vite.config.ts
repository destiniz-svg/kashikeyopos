import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/api': { target: 'http://127.0.0.1:4600', changeOrigin: true } } },
  preview: { port: 5200, proxy: { '/api': { target: 'http://127.0.0.1:4600', changeOrigin: true } } },
  build: { outDir: 'dist', sourcemap: true },
});
