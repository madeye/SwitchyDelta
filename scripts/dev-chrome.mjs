#!/usr/bin/env node
/**
 * Launch a Chrome session with the built extension loaded, and leave it
 * running for manual testing.
 *
 * Chrome 137+ ignores --load-extension, so the extension is installed through
 * the Extensions CDP domain instead. The profile persists between runs so
 * settings survive a restart; delete the directory to start fresh.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = process.argv[2] ?? resolve(root, 'dist');
const PORT = Number(process.env['DEV_CDP_PORT'] ?? 9400);
const PROFILE = process.env['DEV_PROFILE'] ?? resolve(root, '.dev-chrome-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attaching to a Chrome that is already up would silently reuse its profile
// and skip the install, so refuse rather than half-work.
try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`A Chrome is already listening on ${PORT}.`);
  console.error(`Close it first, or set DEV_CDP_PORT to a free port.`);
  process.exit(1);
} catch {
  /* nothing there, good */
}

await mkdir(PROFILE, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore', detached: true },
);
// Let this process exit while Chrome keeps running.
chrome.unref();

let version = null;
for (let i = 0; i < 60 && !version; i++) {
  await sleep(500);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    /* still starting */
  }
}
if (!version) {
  console.error('Chrome did not expose a debugging endpoint.');
  process.exit(1);
}

/** One-shot CDP call over the browser-level socket. */
async function browserCall(method, params) {
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const result = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) resolve(msg);
    });
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return result;
}

const loaded = await browserCall('Extensions.loadUnpacked', { path: EXT });
if (loaded.error) {
  console.error('Failed to install the extension: ' + JSON.stringify(loaded.error));
  process.exit(1);
}
const id = loaded.result.id;

await sleep(1500);
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const swRunning = targets.some((t) => t.type === 'service_worker' && t.url.includes(id));

// Land on the settings page so the session is immediately useful.
await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${id}/options.html`, {
  method: 'PUT',
});

console.log(`
Chrome is running and will stay up after this command returns.

  extension id   ${id}
  service worker ${swRunning ? 'running' : 'not started yet (it starts on demand)'}
  loaded from    ${EXT}
  profile        ${PROFILE}
  devtools port  ${PORT}

  settings       chrome-extension://${id}/options.html   (opened for you)
  popup page     chrome-extension://${id}/popup.html
  manage         chrome://extensions/?id=${id}

To try the toolbar popup and the side panel, pin the extension first:
click the puzzle-piece icon in the toolbar, then the pin next to SwitchyDelta.
The popup's settings button opens the side panel.

Rebuild with 'npm run build', then press the reload arrow on
chrome://extensions to pick up the change.
`);
