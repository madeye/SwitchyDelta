#!/usr/bin/env node
/**
 * Side panel: the settings page is registered as a side panel, opens through
 * chrome.sidePanel.open, and lays out without horizontal overflow at panel
 * width (~360px).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = process.argv[2];
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  #ws; #id = 0; #pending = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) { this.#pending.get(m.id)?.(m); this.#pending.delete(m.id); }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new Session(ws);
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
  }
  /** userGesture: true makes Chrome treat this as user-activated. */
  async evalGesture(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.result?.exceptionDetails) return 'THREW: ' + (r.result.exceptionDetails.exception?.description ?? '').split('\n')[0];
    return r.result?.result?.value;
  }
  close() { this.#ws.close(); }
}

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`!! port ${PORT} busy — stale Chrome. Aborting.`); process.exit(2);
} catch {}

const profile = await mkdtemp(join(tmpdir(), 'sd-sp-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });

let version = null;
for (let i = 0; i < 40 && !version; i++) {
  await sleep(500);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}
const browser = await Session.open(version.webSocketDebuggerUrl);
const { result: { id: extId } } = await browser.send('Extensions.loadUnpacked', { path: EXT });
await sleep(2500);

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' })).json();
const page = await Session.open(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await sleep(800);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`));
};

console.log('=== side panel registration ===');
check('manifest declares side_panel',
  JSON.parse(await page.evalGesture(`JSON.stringify(chrome.runtime.getManifest().side_panel)`)),
  { default_path: 'options.html' });
check('sidePanel.open is available',
  await page.evalGesture(`typeof chrome.sidePanel?.open`), 'function');
check('panel is enabled and points at options.html',
  JSON.parse(await page.evalGesture(`chrome.sidePanel.getOptions({}).then(o => JSON.stringify(o))`)),
  { enabled: true, path: 'options.html' });

console.log('\n=== opening the panel ===');
check('open({windowId: WINDOW_ID_CURRENT})', await page.evalGesture(
  `chrome.sidePanel.open({windowId: chrome.windows.WINDOW_ID_CURRENT}).then(() => 'OK').catch(e => 'REJECTED: ' + e.message)`), 'OK');
check('open({windowId: <real id>})', await page.evalGesture(
  `chrome.windows.getCurrent().then(w => chrome.sidePanel.open({windowId: w.id})).then(() => 'OK').catch(e => 'REJECTED: ' + e.message)`), 'OK');


// Layout check at side-panel width.
const opts = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html`, { method: 'PUT' })).json();
const op = await Session.open(opts.webSocketDebuggerUrl);
await op.send('Runtime.enable');
await op.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 700, deviceScaleFactor: 1, mobile: false });
await sleep(1500);

console.log('\n=== options.html at 360px (side panel width) ===');
const layout = JSON.parse(await op.evalGesture(`JSON.stringify({
  bodyScrollW: document.body.scrollWidth,
  clientW: document.documentElement.clientWidth,
  overflowsX: document.body.scrollWidth > document.documentElement.clientWidth + 1,
  sidebarDisplay: getComputedStyle(document.querySelector('.om-sidebar nav')).display,
  navScrollable: (() => { const n = document.querySelector('.om-sidebar nav');
    return n.scrollWidth > n.clientWidth; })(),
  openInTabVisible: getComputedStyle(document.querySelector('#om-open-tab')).display !== 'none',
  navItems: document.querySelectorAll('.om-sidebar .om-item').length,
})`));
check('no horizontal overflow of the page', layout.overflowsX, false);
check('body fits the panel width', layout.bodyScrollW, layout.clientW);
check('nav collapsed to a scrollable strip', layout.sidebarDisplay, 'flex');
check('nav scrolls internally instead of widening the page', layout.navScrollable, true);
check('open-in-tab escape hatch is visible', layout.openInTabVisible, true);
if (failures) console.log('\n=== elements exceeding 360px ===');
if (failures) console.log(await op.evalGesture(`(() => {
  const w = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > w + 0.5 || r.width > w + 0.5) {
      out.push(\`  \${el.tagName.toLowerCase()}\${el.id ? '#'+el.id : ''}\${el.className && typeof el.className === 'string' ? '.'+el.className.trim().split(/\\s+/).join('.') : ''}  width=\${Math.round(r.width)} right=\${Math.round(r.right)}\`);
    }
  }
  return out.slice(0, 12).join('\\n') || '  (none)';
})()`));
op.close();

console.log(`\n=== RESULT: ${failures === 0 ? 'all checks passed' : failures + ' FAILURES'} ===`);

page.close(); browser.close();
try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
await sleep(800);
await rm(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
