import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// Served at /app2 alongside the live till at /app — coexistence, zero risk.
export default defineConfig({
  base: '/app2/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
