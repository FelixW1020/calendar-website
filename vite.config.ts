import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves project sites from /<repo>/, so built asset URLs need
// that prefix. Dev stays at the root so `npm run dev` is still just /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/calendar-website/' : '/',
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
}));
