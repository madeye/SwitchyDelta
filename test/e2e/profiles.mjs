#!/usr/bin/env node
/**
 * End-to-end functional test: install the extension into a throwaway Chrome
 * profile, apply each profile type over the real RPC path, and check what
 * actually lands in chrome.proxy.settings — including evaluating the generated
 * PAC script.
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
const PORT = 9334;
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
  /** Evaluate an async expression and return its value, throwing on error. */
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
  console.error(`!! port ${PORT} already serving CDP — a stale Chrome is running.`);
  console.error('   This run would attach to it and reuse its profile. Aborting.');
  process.exit(2);
} catch { /* nothing listening, good */ }

const profile = await mkdtemp(join(tmpdir(), 'sd-func-'));
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

// An extension page gives us a context with chrome.runtime, so profile changes
// go through the same RPC path the real UI uses.
const tab = await (await fetch(
  `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' })).json();
const page = await Session.open(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await sleep(1000);

const applyProfile = (name) =>
  page.eval(`chrome.runtime.sendMessage({method:'applyProfile',args:[${JSON.stringify(name)}]})
             .then(r => JSON.stringify(r))`);

const proxyConfig = () =>
  sw.eval(`new Promise(r => chrome.proxy.settings.get({}, c => r(JSON.stringify(c.value))))`)
    .then(JSON.parse);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
};

console.log(`extension: ${extId}\n`);

// --- FixedProfile ----------------------------------------------------------
console.log('=== apply "proxy" (FixedProfile) ===');
console.log('  rpc reply: ' + (await applyProfile('proxy')));
await sleep(800);
let cfg = await proxyConfig();
check('mode is fixed_servers', cfg.mode, 'fixed_servers');
// An http-scheme fallback cannot go in rules.fallbackProxy, so it is promoted.
check('singleProxy host', cfg.rules?.singleProxy?.host, 'proxy.example.com');
check('singleProxy port', cfg.rules?.singleProxy?.port, 8080);
// Chrome's bypass list wants IPv6 literals bracketed, which is what
// Conditions.str emits for a BypassCondition.
check('bypass list', cfg.rules?.bypassList, ['127.0.0.1', '[::1]', 'localhost']);

// --- SwitchProfile ---------------------------------------------------------
console.log('\n=== apply "auto switch" (SwitchProfile -> generated PAC) ===');
console.log('  rpc reply: ' + (await applyProfile('auto switch')));
await sleep(800);
cfg = await proxyConfig();
check('mode is pac_script', cfg.mode, 'pac_script');

const pac = cfg.pacScript?.data ?? '';
console.log(`\n  generated PAC (${pac.length} bytes):`);
console.log('  ' + pac.replace(/\n/g, '\n  '));

console.log('\n=== resolve URLs through the generated PAC ===');
const resolve = async (url, host) =>
  page.eval(`(function(){ ${pac}\n return FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)}); })()`);

check('internal.example.com -> DIRECT (rule 1)',
  await resolve('http://internal.example.com/', 'internal.example.com'), 'DIRECT');
check('www.example.com -> proxy (rule 2)',
  await resolve('http://www.example.com/', 'www.example.com'), 'PROXY proxy.example.com:8080');
check('example.com -> proxy (apex, wildcard magic)',
  await resolve('http://example.com/', 'example.com'), 'PROXY proxy.example.com:8080');
check('other.org -> DIRECT (default)',
  await resolve('http://other.org/', 'other.org'), 'DIRECT');
check('127.0.0.1 -> DIRECT (bypass inside proxy profile)',
  await resolve('http://127.0.0.1/', '127.0.0.1'), 'DIRECT');

// --- Active-tab icon tracking ----------------------------------------------
console.log('\n=== active-tab icon follows the matched profile ===');
// Navigating a tab wakes the worker's tab listeners, which retint the icon
// with the matched profile's colour. The icon canvas is not readable over
// CDP, but the same repaint writes the "current → matched" action title.
// Both names here are custom, so i18n falls through to the raw names.
const actionTitle = () => sw.eval(`new Promise(r => chrome.action.getTitle({}, r))`);
const pollTitle = async (expected) => {
  for (let i = 0; i < 25; i++) {
    const title = await actionTitle();
    if (title === expected) return title;
    await sleep(200);
  }
  return actionTitle();
};
await fetch(`http://127.0.0.1:${PORT}/json/new?http://www.example.com/`, { method: 'PUT' });
check('title shows the rule match', await pollTitle('auto switch → proxy'), 'auto switch → proxy');

// --- Add-condition prefill --------------------------------------------------
console.log('\n=== ?addRuleHost pre-fills a rule in the switch editor ===');
// The popup's "Add condition" button opens the editor with the active tab's
// host in the fragment query; the editor must add a pending rule for the
// *registrable* domain (www.other-site.org -> *.other-site.org, the psl
// helper) and strip the one-shot query from the address bar.
const editorTab = await (await fetch(
  `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html%23/profile/auto%2520switch?addRuleHost=www.other-site.org`,
  { method: 'PUT' })).json();
const editor = await Session.open(editorTab.webSocketDebuggerUrl);
await sleep(1500);
const prefill = JSON.parse(await editor.eval(`JSON.stringify({
  hash: location.hash,
  patterns: [...document.querySelectorAll('input')].map(i => i.value)
    .filter(v => v.includes('other-site')),
})`));
check('rule pre-filled with the registrable domain', prefill.patterns, ['*.other-site.org']);
check('one-shot query stripped from the hash', prefill.hash, '#/profile/auto%20switch');

// --- DirectProfile ---------------------------------------------------------
console.log('\n=== apply "direct" ===');
console.log('  rpc reply: ' + (await applyProfile('direct')));
await sleep(800);
cfg = await proxyConfig();
check('mode is direct', cfg.mode, 'direct');
// A static profile paints its own identity; no match arrow.
check('title reverts to the static profile', await pollTitle('[Direct]'), '[Direct]');

console.log(`\n=== RESULT: ${failures === 0 ? 'all checks passed' : failures + ' FAILURES'} ===`);

sw.close(); page.close(); browser.close();
try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
await sleep(1000);
await rm(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
