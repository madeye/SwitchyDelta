#!/usr/bin/env node
/**
 * One-click gfwlist import in the switch profile editor.
 *
 * Drives the real options page: the "Import gfwlist" button must attach a
 * rule list to the switch profile, point it at the chosen source with the
 * AutoProxy format, download it straight away, and leave a PAC that routes a
 * well-known blocked host through the proxy.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS_FLAGS = process.env.HEADLESS
  ? ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  : [];
const EXT = process.argv[2];
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  #ws; #id = 0; #pending = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
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
    return new Promise((resolve) => { this.#pending.set(id, resolve); this.#ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exc = r.result?.exceptionDetails;
    if (exc) throw new Error(exc.exception?.description ?? exc.text);
    return r.result?.result?.value;
  }
  close() { this.#ws.close(); }
}

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`!! port ${PORT} already serving CDP — a stale Chrome is running. Aborting.`);
  process.exit(2);
} catch { /* nothing listening, good */ }

const profile = await mkdtemp(join(tmpdir(), 'sd-gfwlist-'));
const chrome = spawn(CHROME, [
  ...HEADLESS_FLAGS,
  `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });

let version = null;
for (let i = 0; i < 40 && !version; i++) {
  await sleep(500);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}

const browser = await Session.open(version.webSocketDebuggerUrl);
const { result: { id: extId } } = await browser.send('Extensions.loadUnpacked', { path: EXT });
await sleep(2500);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const swTarget = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
const sw = await Session.open(swTarget.webSocketDebuggerUrl);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
};

console.log(`extension: ${extId}\n`);

// The default options ship an "auto switch" SwitchProfile; open its editor.
const editorTab = await (await fetch(
  `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html%23/profile/auto%2520switch`,
  { method: 'PUT' })).json();
const editor = await Session.open(editorTab.webSocketDebuggerUrl);
await editor.send('Runtime.enable');
await sleep(1500);

const findImport = `(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /gfwlist/i.test(b.textContent));
  const select = btn?.parentElement?.querySelector('select');
  return { btn, select };
})()`;

console.log('=== before: no rule list attached ===');
const before = JSON.parse(await editor.eval(`(() => {
  const { btn, select } = ${findImport};
  return JSON.stringify({
    hasButton: !!btn,
    sources: select ? [...select.options].map((o) => o.value) : [],
    urlFields: document.querySelectorAll('input[type=url]').length,
  });
})()`));
check('import button is offered before any list is attached', before.hasButton, true);
check('no rule list URL field yet', before.urlFields, 0);
check('every source is https', before.sources.every((u) => u.startsWith('https://')), true);
check('the CDN endpoint is preselected first', before.sources[0]?.includes('jsdelivr.net'), true);
console.log('  sources: ' + before.sources.join(', '));

console.log('\n=== click "Import gfwlist" ===');
await editor.eval(`(() => { const { btn } = ${findImport}; btn.click(); })()`);

const attachedKey = '+__ruleListOf_auto switch';
const stored = async () => JSON.parse(await sw.eval(
  `chrome.storage.local.get(${JSON.stringify(attachedKey)}).then((s) => JSON.stringify(s[${JSON.stringify(attachedKey)}] ?? null))`,
));
let list = null;
for (let i = 0; i < 60; i++) {
  list = await stored();
  if (list?.lastUpdate && list.ruleList) break;
  await sleep(500);
}
check('attached list was created', !!list, true);
check('format is AutoProxy', list?.format, 'AutoProxy');
check('source is the preselected CDN URL', list?.sourceUrl, before.sources[0]);
check('list downloaded (lastUpdate set)', !!list?.lastUpdate, true);
// The download path stores the decoded list, not the base64 wire form.
check('downloaded text is the decoded gfwlist', (list?.ruleList ?? '').startsWith('[AutoProxy'), true);
check('matches go to the proxy the switch rules already use', list?.matchProfileName, 'proxy');
console.log(`  ruleList: ${(list?.ruleList ?? '').length} bytes`);

const switchProfile = JSON.parse(await sw.eval(
  `chrome.storage.local.get('+auto switch').then((s) => JSON.stringify(s['+auto switch']))`,
));
check('switch profile now defaults to the attached list', switchProfile.defaultProfileName, '__ruleListOf_auto switch');

console.log('\n=== editor reflects the import in place ===');
const after = JSON.parse(await editor.eval(`(() => {
  const url = document.querySelector('input[type=url]');
  const radios = [...document.querySelectorAll('input[name=om-rule-list-format]')];
  const checked = radios.findIndex((r) => r.checked);
  const { select } = ${findImport};
  return JSON.stringify({
    url: url?.value,
    urlDisabledText: !!document.querySelector('textarea:disabled'),
    autoProxyChecked: checked === 1,
    selectedSource: select?.value,
    dirty: !!document.querySelector('#om-apply:not(:disabled), button.om-btn-primary:not(:disabled)'),
  });
})()`));
check('URL field shows the gfwlist source', after.url, before.sources[0]);
check('AutoProxy radio is checked', after.autoProxyChecked, true);
check('text area is locked while a URL is set', after.urlDisabledText, true);
check('source picker follows the stored URL', after.selectedSource, before.sources[0]);

console.log('\n=== apply "auto switch" and probe the PAC ===');
await editor.eval(`chrome.runtime.sendMessage({method:'applyProfile',args:['auto switch']}).then(() => 'ok')`);
await sleep(1500);
const cfg = JSON.parse(await sw.eval(
  `new Promise(r => chrome.proxy.settings.get({}, c => r(JSON.stringify(c.value))))`,
));
check('mode is pac_script', cfg.mode, 'pac_script');
const pac = cfg.pacScript?.data ?? '';
const probe = (url, host) => sw.eval(`(() => {
  ${pac}
  return FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)});
})()`);
const blocked = await probe('https://www.google.com/', 'www.google.com');
const local = await probe('https://www.baidu.com/', 'www.baidu.com');
console.log(`  www.google.com -> ${blocked}\n  www.baidu.com  -> ${local}`);
check('a gfwlist host goes through the proxy', blocked, 'PROXY proxy.example.com:8080');
check('an unlisted host stays DIRECT', local, 'DIRECT');

console.log(`\n=== RESULT: ${failures === 0 ? 'all checks passed' : failures + ' FAILURES'} ===`);

editor.close(); sw.close(); browser.close();
try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
await sleep(1000);
await rm(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
