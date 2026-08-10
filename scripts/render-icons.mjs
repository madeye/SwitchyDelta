#!/usr/bin/env node
/**
 * Rasterize packages/extension/img/icon.svg to the PNG sizes the manifest
 * needs, using headless Chrome over CDP (no native image dependencies).
 * The PNGs are checked in; re-run after editing the SVG.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = resolve(root, 'packages/extension/img/icon.svg');
const OUT = resolve(root, 'packages/extension/img/icons');
const SIZES = [16, 19, 24, 32, 48, 64, 128];

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9353;
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
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Session(ws);
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
  }
}

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`port ${PORT} busy`);
  process.exit(2);
} catch { /* free */ }

const profile = await mkdtemp(join(tmpdir(), 'sd-icons-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });

let version = null;
for (let i = 0; i < 40 && !version; i++) {
  await sleep(500);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}

const svg = await readFile(SVG, 'utf8');
const page = `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`;
const url = 'data:text/html;base64,' + Buffer.from(page).toString('base64');

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const session = await Session.open(tab.webSocketDebuggerUrl);
await session.send('Page.enable');
await session.send('Page.navigate', { url });
await sleep(800);
// Transparent page background so the SVG's rounded corners stay transparent.
await session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

for (const size of SIZES) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false,
  });
  await session.send('Runtime.evaluate', {
    expression: `(() => { const s = document.querySelector('svg');
      s.setAttribute('width', ${size}); s.setAttribute('height', ${size}); })()`,
  });
  await sleep(150);
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `delta-${size}.png`);
  await writeFile(file, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', file);
}

process.kill(-chrome.pid, 'SIGKILL');
process.exit(0);
