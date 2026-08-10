#!/usr/bin/env node
/**
 * Assemble the loadable extension into `dist/`.
 *
 * Replaces the Grunt pipeline (coffee -> browserify -> copy -> compress). The
 * three source bundles that used to be concatenated into the worker's global
 * scope by `importScripts`, in a load-bearing order, are now one ES module.
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copy a path if it is there, reporting what was skipped. */
async function copyIfPresent(from, to, label) {
  if (!(await exists(from))) {
    console.warn(`  skipped ${label}: ${from} not found`);
    return false;
  }
  await cp(from, to, { recursive: true });
  console.log(`  copied  ${label}`);
  return true;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

console.log('building service worker');
await build({
  entryPoints: [resolve(root, 'packages/extension/src/sw.ts')],
  outfile: resolve(out, 'js/sw.js'),
  bundle: true,
  format: 'esm',
  // Matches minimum_chrome_version in the manifest.
  target: 'chrome109',
  minify: process.env['NODE_ENV'] === 'production',
  sourcemap: true,
  logLevel: 'warning',
});

console.log('copying assets');
await copyIfPresent(resolve(root, 'packages/extension/manifest.json'), resolve(out, 'manifest.json'), 'manifest');

// The UI is built separately by Vite; its output is laid out to sit at the
// package root next to the manifest.
await copyIfPresent(resolve(root, 'packages/ui/dist'), out, 'ui (vite output)');

// The delta icon set; rendered from icon.svg by scripts/render-icons.mjs.
await copyIfPresent(resolve(root, 'packages/extension/img'), resolve(out, 'img'), 'icons');

// Translations are compiled from the gettext catalogues on every build.
const { buildLocales } = await import('./build-locales.mjs');
const locales = await buildLocales(resolve(root, 'omega-locales'), resolve(out, '_locales'));
console.log(`  built   _locales (${locales.length} locales)`);

console.log(`\ndone -> ${out}`);
