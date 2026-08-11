#!/usr/bin/env node
/**
 * Verify the dual-colour action icon in auto-switch mode under headless Chrome.
 *
 * Chrome does not expose the toolbar image over CDP, so the worker records the
 * last setActionIcon arguments and can re-paint the same canvas for pixel
 * sampling. This suite:
 *   1. applies "auto switch"
 *   2. navigates tabs that match different rules
 *   3. asserts last paint = { fill: matched profile, border: switch profile }
 *   4. samples the painted canvas so fill/edge pixels match those colours
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Default to headless so a bare `node test/e2e/action-icon.mjs dist` works.
const HEADLESS_FLAGS =
  process.env.HEADLESS === '0'
    ? []
    : ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const EXT = resolve(process.argv[2] ?? 'dist');
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Colours from packages/target/src/default-options.ts + built-in direct.
const PROXY = '#99ccee';
const AUTO = '#99dd99';
const DIRECT = '#aaaaaa';

class Session {
  #ws;
  #id = 0;
  #pending = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        this.#pending.get(m.id)?.(m);
        this.#pending.delete(m.id);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exc = r.result?.exceptionDetails;
    if (exc) throw new Error(exc.exception?.description ?? exc.text);
    return r.result?.result?.value;
  }
  close() {
    this.#ws.close();
  }
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Allow small channel drift from canvas anti-aliasing on the stroke edge. */
function near(actual, expectedHex, tol = 12) {
  const [er, eg, eb] = hexToRgb(expectedHex);
  const [ar, ag, ab] = actual;
  return Math.abs(ar - er) <= tol && Math.abs(ag - eg) <= tol && Math.abs(ab - eb) <= tol;
}

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`!! port ${PORT} already serving CDP — a stale Chrome is running.`);
  process.exit(2);
} catch {
  /* nothing listening, good */
}

const profile = await mkdtemp(join(tmpdir(), 'sd-icon-'));
console.log(`profile: ${profile}`);
console.log(`extension: ${EXT}`);
console.log(`headless: ${HEADLESS_FLAGS.length > 0}\n`);

const chrome = spawn(
  CHROME,
  [
    ...HEADLESS_FLAGS,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
);

let version = null;
for (let i = 0; i < 40 && !version; i++) {
  await sleep(500);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    /* not up yet */
  }
}
if (!version) {
  console.error('!! Chrome did not expose a debugging endpoint');
  process.exit(1);
}

const browser = await Session.open(version.webSocketDebuggerUrl);
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
if (loaded.error) {
  console.error('!! Extensions.loadUnpacked failed:', loaded.error);
  process.exit(1);
}
const extId = loaded.result.id;
await sleep(2500);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const swTarget = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
if (!swTarget) {
  console.error('!! service worker target not found');
  process.exit(1);
}
const sw = await Session.open(swTarget.webSocketDebuggerUrl);

const tab = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`, {
    method: 'PUT',
  })
).json();
const page = await Session.open(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await sleep(1000);

const rpc = (method, args = []) =>
  page.eval(
    `chrome.runtime.sendMessage({method:${JSON.stringify(method)},args:${JSON.stringify(args)}})
     .then(r => JSON.stringify(r))`,
  );

const actionTitle = () => sw.eval(`new Promise(r => chrome.action.getTitle({}, r))`);
const lastPaint = async () => {
  const raw = await rpc('lastActionIconPaint');
  const parsed = JSON.parse(raw);
  return parsed.result ?? parsed;
};
const sample = async (color, borderColor) => {
  const raw = await rpc('sampleActionIcon', [color, borderColor, 32]);
  const parsed = JSON.parse(raw);
  return parsed.result ?? parsed;
};

const poll = async (label, read, match, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (match(last)) return last;
    await sleep(200);
  }
  return last;
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

console.log(`extension: ${extId}\n`);

// --- Apply auto switch -----------------------------------------------------
console.log('=== apply "auto switch" ===');
console.log('  rpc: ' + (await rpc('applyProfile', ['auto switch'])));
await sleep(800);

// --- Matched rule: www.example.com → proxy ---------------------------------
console.log('\n=== tab matches proxy rule (fill=proxy, border=auto) ===');
await fetch(`http://127.0.0.1:${PORT}/json/new?http://www.example.com/`, { method: 'PUT' });

const titleMatch = await poll(
  'title',
  actionTitle,
  (t) => t === 'auto switch → proxy',
);
check('title shows auto switch → proxy', titleMatch === 'auto switch → proxy', JSON.stringify(titleMatch));

const paintMatch = await poll(
  'paint',
  lastPaint,
  (p) => p?.color === PROXY && p?.borderColor === AUTO,
);
check(
  'last paint fill is proxy colour',
  paintMatch?.color === PROXY,
  JSON.stringify(paintMatch),
);
check(
  'last paint border is auto-switch colour',
  paintMatch?.borderColor === AUTO,
  JSON.stringify(paintMatch),
);

const pixelsMatch = await sample(PROXY, AUTO);
check(
  'centre pixel is proxy fill',
  near(pixelsMatch.fill, PROXY),
  `fill=${JSON.stringify(pixelsMatch.fill)} expected ${PROXY}`,
);
check(
  'edge pixel is auto-switch border',
  near(pixelsMatch.edge, AUTO),
  `edge=${JSON.stringify(pixelsMatch.edge)} expected ${AUTO}`,
);

// --- Default match: no rule → direct ---------------------------------------
console.log('\n=== tab falls through to default (fill=direct, border=auto) ===');
// Use the CDP version endpoint as a plain http URL that matches no rule.
await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${PORT}/json/version`, {
  method: 'PUT',
});

const titleDefault = await poll(
  'title',
  actionTitle,
  (t) => t === 'auto switch → [Direct]',
);
check(
  'title shows auto switch → [Direct]',
  titleDefault === 'auto switch → [Direct]',
  JSON.stringify(titleDefault),
);

const paintDefault = await poll(
  'paint',
  lastPaint,
  (p) => p?.color === DIRECT && p?.borderColor === AUTO,
);
check(
  'last paint fill is direct colour',
  paintDefault?.color === DIRECT,
  JSON.stringify(paintDefault),
);
check(
  'last paint border stays auto-switch colour',
  paintDefault?.borderColor === AUTO,
  JSON.stringify(paintDefault),
);

const pixelsDefault = await sample(DIRECT, AUTO);
check(
  'centre pixel is direct fill',
  near(pixelsDefault.fill, DIRECT),
  `fill=${JSON.stringify(pixelsDefault.fill)} expected ${DIRECT}`,
);
check(
  'edge pixel is still auto-switch border',
  near(pixelsDefault.edge, AUTO),
  `edge=${JSON.stringify(pixelsDefault.edge)} expected ${AUTO}`,
);

// --- Static profile: no border ---------------------------------------------
console.log('\n=== static "proxy" profile (fill only, no border) ===');
console.log('  rpc: ' + (await rpc('applyProfile', ['proxy'])));
await sleep(800);

const titleStatic = await poll('title', actionTitle, (t) => t === 'proxy');
check('title reverts to proxy', titleStatic === 'proxy', JSON.stringify(titleStatic));

const paintStatic = await poll(
  'paint',
  lastPaint,
  (p) => p?.color === PROXY && (p?.borderColor === undefined || p?.borderColor === null),
);
check(
  'last paint fill is proxy colour',
  paintStatic?.color === PROXY,
  JSON.stringify(paintStatic),
);
check(
  'last paint has no border colour',
  paintStatic?.borderColor === undefined || paintStatic?.borderColor === null,
  JSON.stringify(paintStatic),
);

const pixelsStatic = await sample(PROXY);
check(
  'centre pixel is proxy fill',
  near(pixelsStatic.fill, PROXY),
  `fill=${JSON.stringify(pixelsStatic.fill)} expected ${PROXY}`,
);
// Without a border the edge is still the fill colour (rounded square, opaque).
check(
  'edge pixel matches fill when no border',
  near(pixelsStatic.edge, PROXY),
  `edge=${JSON.stringify(pixelsStatic.edge)} expected ${PROXY}`,
);

console.log(`\n=== RESULT: ${failures === 0 ? 'all checks passed' : failures + ' FAILURES'} ===`);

sw.close();
page.close();
browser.close();
try {
  process.kill(-chrome.pid, 'SIGKILL');
} catch {
  chrome.kill('SIGKILL');
}
await sleep(1000);
await rm(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
