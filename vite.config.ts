import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // los .glb son grandes: no inlinear ningún asset
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    open: true,
  },
});
