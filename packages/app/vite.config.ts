import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [solid(), tailwindcss()],
  build: {
    outDir: 'renderer-dist',
  },
  server: {
    port: 5173,
  },
});
