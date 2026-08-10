#!/usr/bin/env node
/**
 * Load the built extension into a throwaway Chrome profile and report whether
 * the service worker boots cleanly. Drives Chrome over CDP.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// The "new" headless mode supports extensions; the sandbox flags are for CI
// runners where the Chrome sandbox cannot be used.
const HEADLESS_FLAGS = process.env.HEADLESS
  ? ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  : [];
const EXT = process.argv[2];
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpList() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

/** Minimal CDP client over the debugger WebSocket. */
class Session {
  #ws;
  #id = 0;
  #pending = new Map();
  events = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        this.#pending.get(msg.id)?.(msg);
        this.#pending.delete(msg.id);
      } else {
        this.events.push(msg);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`!! port ${PORT} already serving CDP — a stale Chrome is running.`);
  console.error('   This run would attach to it and reuse its profile. Aborting.');
  process.exit(2);
} catch { /* nothing listening, good */ }

const profile = await mkdtemp(join(tmpdir(), 'sd-smoke-'));
console.log(`profile: ${profile}`);
console.log(`extension: ${EXT}\n`);

const chrome = spawn(
  CHROME,
  [
    ...HEADLESS_FLAGS,
  `--user-data-dir=${profile}`,
    // Chrome 137+ ignores --load-extension entirely; the extension is
    // installed below via the Extensions CDP domain, which needs this flag.
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);

let chromeErr = '';
chrome.stderr.on('data', (d) => (chromeErr += d));

let version = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (version) break;
  } catch {
    /* not up yet */
  }
}
if (!version) {
  console.log('!! Chrome did not expose a debugging endpoint');
  process.exit(1);
}

// Install the unpacked extension through the browser-level session.
const browser = await Session.open(version.webSocketDebuggerUrl);
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
if (loaded.error) {
  console.log('!! Extensions.loadUnpacked failed: ' + JSON.stringify(loaded.error));
  process.exit(1);
}
const loadedId = loaded.result?.id;
console.log(`loaded extension id: ${loadedId}`);
await sleep(2000);

let targets = await cdpList();

console.log('=== CDP targets ===');
for (const t of targets) console.log(`  ${t.type.padEnd(16)} ${t.url}`);

const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(loadedId));
const extId = loadedId;

console.log(`\nextension id: ${extId || '(not detected)'}`);

let failed = false;

if (!sw) {
  console.log('\n!! service worker target not found — extension did not load or SW did not start');
  failed = true;
} else {
  const s = await Session.open(sw.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await sleep(2500);

  // Chrome logs this when webRequest listeners are registered while the
  // optional <all_urls> grant is still ungranted. That is the intended state
  // of a fresh profile: proxy-auth listeners must be registered in the
  // worker's first turn, and stay silent until the user grants host access.
  const expectedPreGrant =
    'You need to request host permissions in the manifest file in order to' +
    ' be notified about requests from the webRequest API.';

  const errorText = (e) =>
    e.params?.exceptionDetails?.exception?.description ??
    e.params?.exceptionDetails?.text ??
    e.params?.entry?.text ??
    (e.params?.args?.map((a) => a.value ?? a.description).join(' ') || '');

  const errors = s.events.filter(
    (e) =>
      (e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error') ||
        (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')) &&
      !errorText(e).includes(expectedPreGrant),
  );

  console.log(`\n=== service worker errors: ${errors.length} ===`);
  for (const e of errors) {
    const d = e.params?.exceptionDetails;
    console.log('  ' + (d?.exception?.description ?? d?.text ?? e.params?.entry?.text ??
      JSON.stringify(e.params?.args?.map((a) => a.value ?? a.description))));
  }
  if (errors.length) failed = true;

  const probe = await s.send('Runtime.evaluate', {
    expression: `(async () => {
      const cfg = await new Promise(r => chrome.proxy.settings.get({}, r));
      const st = await chrome.storage.local.get(null);
      return JSON.stringify({
        proxyMode: cfg?.value?.mode ?? null,
        levelOfControl: cfg?.levelOfControl ?? null,
        profileKeys: Object.keys(st).filter(k => k[0] === '+'),
        schemaVersion: st.schemaVersion ?? null,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  console.log('\n=== worker state probe ===');
  const val = probe.result?.result?.value;
  const exc = probe.result?.exceptionDetails;
  if (exc) {
    console.log('  probe threw: ' + (exc.exception?.description ?? exc.text));
    failed = true;
  } else {
    console.log('  ' + val);
  }
  s.close();
}

// Load the popup as a page and check it renders without script errors.
if (extId) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' });
  const tab = await res.json().catch(() => null);
  if (tab?.webSocketDebuggerUrl) {
    const p = await Session.open(tab.webSocketDebuggerUrl);
    await p.send('Runtime.enable');
    await p.send('Log.enable');
    await sleep(2500);
    const perrs = p.events.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'),
    );
    console.log(`\n=== popup errors: ${perrs.length} ===`);
    for (const e of perrs) {
      const d = e.params?.exceptionDetails;
      console.log('  ' + (d?.exception?.description ?? d?.text ?? e.params?.entry?.text));
    }
    if (perrs.length) failed = true;

    const dom = await p.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        profiles: [...document.querySelectorAll('#om-profiles .om-item')].map(e => e.textContent.trim()),
        // aria-current must be a real attribute or the highlight rule cannot match.
        current: [...document.querySelectorAll('#om-profiles .om-item[aria-current="true"]')]
          .map(e => e.textContent.trim()),
        error: document.querySelector('#om-error')?.hidden === false
          ? document.querySelector('#om-error').textContent : null,
      })`,
      returnByValue: true,
    });
    console.log('\n=== popup rendered ===');
    console.log('  ' + dom.result?.result?.value);
    p.close();
  }
}

console.log(`\n=== RESULT: ${failed ? 'FAILURES DETECTED' : 'clean'} ===`);
if (chromeErr.trim()) {
  const lines = chromeErr.trim().split('\n').filter((l) => /error|fail|invalid|manifest/i.test(l));
  if (lines.length) {
    console.log('\n=== chrome stderr (filtered) ===');
    for (const l of lines.slice(0, 20)) console.log('  ' + l);
  }
}

try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
await sleep(1000);
await rm(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
