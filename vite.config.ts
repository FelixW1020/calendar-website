import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves project sites from /<repo>/, so built asset URLs need
// that prefix. Vercel serves from the root, and sets VERCEL=1 in its build
// environment — which is enough to tell the two apart without a flag anyone has
// to remember. Dev stays at the root so `npm run dev` is still just /.
const onVercel = Boolean(process.env.VERCEL);

export default defineConfig(({ command }) => ({
  base: command === 'build' && !onVercel ? '/calendar-website/' : '/',
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
}));
