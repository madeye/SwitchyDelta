import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Multi-page build for the extension's two HTML surfaces.
 *
 * MV3 allows `script-src 'self'` only, so nothing may be inlined. Two settings
 * matter for that: `modulePreload.polyfill` off (the polyfill is injected as an
 * inline script) and `cssCodeSplit` off (avoids the inline style injector).
 * Everything Vite emits is then an external file the manifest can load.
 */
export default defineConfig({
  // The extension loads pages from its own package root, so asset URLs must be
  // relative rather than server-absolute.
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Matches minimum_chrome_version in the manifest, so no needless downlevelling.
    target: 'chrome109',
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    sourcemap: true,

    rollupOptions: {
      input: {
        options: resolve(__dirname, 'options.html'),
        popup: resolve(__dirname, 'popup.html'),
      },
      output: {
        entryFileNames: 'js/[name].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
