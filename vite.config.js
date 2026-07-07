import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' -> works on GitHub Pages project URLs (username.github.io/repo/)
export default defineConfig({
  base: './',
  plugins: [react()],
});
