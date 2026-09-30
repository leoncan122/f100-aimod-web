import { defineConfig } from 'vite';

// GitHub Pages de proyecto sirve en https://<user>.github.io/<repo>/, así que
// los assets necesitan ese prefijo. En dev y en previews locales, './'.
// BASE_PATH lo inyecta el workflow de Pages.
const base = process.env.BASE_PATH ?? './';

export default defineConfig({
  base,
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
