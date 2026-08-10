#!/usr/bin/env node
/**
 * Upload dist/ to the Chrome Web Store and submit it for publishing.
 *
 * Credentials come from a Google Cloud service account key referenced by
 * CWS_KEY_PATH in .env (the key itself must live outside the repo). The
 * service account has to be linked to the publisher in the Chrome Web Store
 * developer dashboard (Account > Service account).
 *
 * .env values:
 *   CWS_KEY_PATH      path to the service-account JSON key   (required)
 *   CWS_ITEM_ID       store item id (from the dashboard after the one-time
 *                     first upload; new items cannot be created via the API)
 *   CWS_PUBLISHER_ID  publisher id; when set, the V2 API is used
 *                     (the V1.1 API works without it until 2026-10-15)
 *   HTTPS_PROXY       optional proxy for reaching googleapis.com
 *
 * Usage: node scripts/publish-chrome.mjs [--no-publish]
 */

import { spawnSync } from 'node:child_process';
import { createSign, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(root, 'dist');
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const publish = !process.argv.includes('--no-publish');

// --- .env -------------------------------------------------------------------

const env = { ...process.env };
try {
  for (const line of (await readFile(resolve(root, '.env'), 'utf8')).split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2];
  }
} catch {
  /* no .env; environment variables only */
}

// Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY is set at
// startup, so re-exec once when .env configures a proxy (e.g. on networks
// where googleapis.com is only reachable through one).
if (env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== '1') {
  const rerun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HTTPS_PROXY: env.HTTPS_PROXY, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(rerun.status ?? 1);
}

const keyPath = env.CWS_KEY_PATH;
if (!keyPath) {
  console.error('CWS_KEY_PATH is not set (in .env or the environment).');
  process.exit(1);
}
const itemId = env.CWS_ITEM_ID;
const publisherId = env.CWS_PUBLISHER_ID;

// --- Access token from the service-account key ------------------------------

async function accessToken() {
  const key = JSON.parse(await readFile(keyPath, 'utf8'));
  if (key.type !== 'service_account') {
    throw new Error(`${keyPath} is not a service-account key (type=${key.type})`);
  }
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64url({
      iss: key.client_email,
      scope: SCOPE,
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
      jti: randomUUID(),
    });
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

// --- Package dist/ ----------------------------------------------------------

async function packDist() {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error('dist/manifest.json missing — run `npm run build` first');
  }
  const zipPath = join(await mkdtemp(join(tmpdir(), 'sd-cws-')), 'switchydelta.zip');
  const zip = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: DIST });
  if (zip.status !== 0) throw new Error('zip failed: ' + zip.stderr);
  return zipPath;
}

// --- Chrome Web Store API ---------------------------------------------------

async function call(method, url, token, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

const token = await accessToken();
console.log('access token acquired for', SCOPE);

const zipPath = await packDist();
const zipBytes = await readFile(zipPath);
console.log(`packaged dist -> ${zipPath} (${zipBytes.length} bytes)`);

let upload;
let uploadedItemId = itemId;
if (publisherId && itemId) {
  // V2: publishers/{publisherId}/items/{itemId}
  const name = `publishers/${publisherId}/items/${itemId}`;
  upload = await call(
    'POST',
    `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`,
    token,
    zipBytes,
    'application/zip',
  );
} else if (itemId) {
  // V1.1 update of an existing item.
  upload = await call(
    'PUT',
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${itemId}`,
    token,
    zipBytes,
    'application/zip',
  );
} else {
  // Creating a brand-new item through the API is not supported by Google —
  // the first upload must be done once in the developer dashboard, which
  // also collects the listing metadata the API cannot set.
  console.error(
    [
      'CWS_ITEM_ID is not set and new items cannot be created via the API.',
      'One-time setup:',
      '  1. Upload the zip above at https://chrome.google.com/webstore/devconsole',
      '  2. Fill in the listing (description, category, screenshots, privacy).',
      '  3. Put the new extension id into .env as CWS_ITEM_ID=<id>.',
      'Every later release can then use `npm run publish:chrome`.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log('upload:', upload.status, JSON.stringify(upload.body, null, 2));
if (!upload.ok || upload.body?.uploadState === 'FAILURE') {
  process.exit(1);
}
if (!itemId && uploadedItemId) {
  console.log(`\nNEW ITEM CREATED — add this to .env:\n  CWS_ITEM_ID=${uploadedItemId}\n`);
}

if (!publish) {
  console.log('upload done (--no-publish).');
  process.exit(0);
}

let result;
if (publisherId && uploadedItemId) {
  const name = `publishers/${publisherId}/items/${uploadedItemId}`;
  result = await call(
    'POST',
    `https://chromewebstore.googleapis.com/v2/${name}:publish`,
    token,
    JSON.stringify({}),
    'application/json',
  );
} else {
  result = await call(
    'POST',
    `https://www.googleapis.com/chromewebstore/v1.1/items/${uploadedItemId}/publish`,
    token,
  );
}
console.log('publish:', result.status, JSON.stringify(result.body, null, 2));
process.exit(result.ok ? 0 : 1);
