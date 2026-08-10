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
export default defineConfig(({ mode }) => ({
  // The extension loads pages from its own package root, so asset URLs must be
  // relative rather than server-absolute.
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Matches minimum_chrome_version in the manifest, so no needless downlevelling.
    target: 'chrome109',
    // Disable modulepreload entirely. Vite would inject
    // `<link rel="modulepreload" href="./js/messaging-….js">` for the shared
    // chunk; Chrome then warns that the preloaded resource was not used soon
    // enough (common on extension pages / side panel). The entry still loads
    // the chunk via a normal static import — only the speculative hint goes.
    // Polyfill stays off so nothing is inlined (MV3 script-src 'self').
    modulePreload: false,
    cssCodeSplit: false,
    // Maps are dev-only: build-extension.mjs copies this output into the
    // release zip verbatim, and shipped maps are pure package weight.
    sourcemap: mode === 'development',

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
}));
