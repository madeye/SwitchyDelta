#!/usr/bin/env node
/**
 * Real-world test: a local proxy plus the gfwlist rule list.
 *
 * Exercises the download path (fetch + content-type hints), the base64
 * preprocess (atob/TextDecoder in place of Buffer), the AutoProxy parser, and
 * PAC generation at real scale (~4.5k rules).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import net from 'node:net';
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
const PORT = 9335;
const PROXY = {
  scheme: 'http',
  host: process.env.E2E_PROXY_HOST ?? '127.0.0.1',
  port: Number(process.env.E2E_PROXY_PORT ?? 7890),
};
const GFWLIST = 'https://raw.githubusercontent.com/gfwlist/gfwlist/refs/heads/master/gfwlist.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The download deliberately goes through a local proxy, the way a user behind
// one would fetch the list. On a dev machine that is whatever already listens
// on the configured port; anywhere else (CI) a minimal CONNECT proxy is
// started here so the test carries its own dependency.
function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

let builtinProxy = null;
if (!(await portOpen(PROXY.host, PROXY.port))) {
  builtinProxy = createHttpServer((req, res) => {
    // Absolute-form plain HTTP proxying.
    const url = new URL(req.url);
    const upstream = httpRequest({
      host: url.hostname, port: url.port || 80, method: req.method,
      path: url.pathname + url.search, headers: req.headers,
    }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  builtinProxy.on('connect', (req, socket, head) => {
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise((r) => builtinProxy.listen(PROXY.port, PROXY.host, r));
  console.log(`(nothing on ${PROXY.host}:${PROXY.port} — started built-in CONNECT proxy)`);
}

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
    return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
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
  console.error(`!! port ${PORT} already serving CDP — a stale Chrome is running.`);
  console.error('   This run would attach to it and reuse its profile. Aborting.');
  process.exit(2);
} catch { /* nothing listening, good */ }

const profile = await mkdtemp(join(tmpdir(), 'sd-gfw-'));
const chrome = spawn(CHROME, [
  ...HEADLESS_FLAGS,
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

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = await Session.open(targets.find((t) => t.type === 'service_worker' && t.url.includes(extId)).webSocketDebuggerUrl);
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' })).json();
const page = await Session.open(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await sleep(800);

const rpc = (method, ...args) =>
  page.eval(`chrome.runtime.sendMessage({method:${JSON.stringify(method)},args:${JSON.stringify(args)}})
             .then(r => JSON.stringify(r ?? null))`).then((s) => JSON.parse(s));

let failures = 0;
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  return v;
};
const check = (label, actual, expected) => {
  const ok = JSON.stringify(norm(actual)) === JSON.stringify(norm(expected));
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`}`);
};

console.log(`extension: ${extId}\n`);

console.log('=== add profiles ===');
const brief = (r) => (r?.error ? 'ERROR ' + JSON.stringify(r.error) : 'ok');
console.log('  local  : ' + brief(await rpc('addProfile', {
  name: 'local', profileType: 'FixedProfile', color: '#99ccee', revision: 'test1',
  fallbackProxy: PROXY,
  bypassList: [
    { conditionType: 'BypassCondition', pattern: '127.0.0.1' },
    { conditionType: 'BypassCondition', pattern: '[::1]' },
    { conditionType: 'BypassCondition', pattern: 'localhost' },
  ],
})));
console.log('  gfwlist: ' + brief(await rpc('addProfile', {
  name: 'gfwlist', profileType: 'RuleListProfile', format: 'AutoProxy', color: '#dd7788',
  revision: 'test2', sourceUrl: GFWLIST, ruleList: '',
  matchProfileName: 'local', defaultProfileName: 'direct',
})));

// Download through the local proxy, the way a user behind it would.
console.log('\n=== apply "local" so the download uses the proxy ===');
await rpc('applyProfile', 'local');
await sleep(600);
let cfg = JSON.parse(await sw.eval(`new Promise(r => chrome.proxy.settings.get({}, c => r(JSON.stringify(c.value))))`));
check('mode is fixed_servers', cfg.mode, 'fixed_servers');
check('singleProxy', cfg.rules?.singleProxy, PROXY);

console.log('\n=== download + parse gfwlist ===');
const t0 = Date.now();
const upd = await rpc('updateProfile', 'gfwlist');
const downloadMs = Date.now() - t0;
console.log('  updateProfile -> ' + brief(upd));
console.log(`  took ${downloadMs} ms`);

const stored = JSON.parse(await sw.eval(
  `chrome.storage.local.get('+gfwlist').then(s => JSON.stringify({
     bytes: (s['+gfwlist'].ruleList||'').length,
     head: (s['+gfwlist'].ruleList||'').slice(0, 40),
     format: s['+gfwlist'].format,
     lastUpdate: !!s['+gfwlist'].lastUpdate,
   }))`));
console.log(`  stored ruleList: ${stored.bytes} bytes, format=${stored.format}, lastUpdate=${stored.lastUpdate}`);
check('rule list was base64-decoded', stored.head.startsWith('[AutoProxy'), true);
check('format detected as AutoProxy', stored.format, 'AutoProxy');

console.log('\n=== apply "gfwlist" (generate PAC from ~4.5k rules) ===');
const t1 = Date.now();
await rpc('applyProfile', 'gfwlist');
const applyMs = Date.now() - t1;
await sleep(1200);
cfg = JSON.parse(await sw.eval(`new Promise(r => chrome.proxy.settings.get({}, c => r(JSON.stringify(c.value))))`));
check('mode is pac_script', cfg.mode, 'pac_script');
const pac = cfg.pacScript?.data ?? '';
console.log(`  PAC generated: ${pac.length} bytes in ~${applyMs} ms (apply round trip)`);
console.log(`  PAC head: ${pac.slice(0, 120)}...`);

console.log('\n=== PAC generation cost (in the worker, no RPC) ===');
const timing = JSON.parse(await page.eval(`(async () => {
  const r = await chrome.runtime.sendMessage({method:'pacForProfile', args:['gfwlist']});
  const t = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    await chrome.runtime.sendMessage({method:'pacForProfile', args:['gfwlist']});
    t.push(performance.now() - s);
  }
  return JSON.stringify({ bytes: (r?.result||'').length, times: t.map(x => Math.round(x)) });
})()`));
console.log('  round trips (ms): ' + timing.times.join(', ') + `  [PAC ${timing.bytes} bytes]`);

console.log('\n=== resolve real URLs through the generated PAC ===');
const expectProxy = `PROXY ${PROXY.host}:${PROXY.port}`;
const resolve = (url, host) =>
  page.eval(`(function(){ ${JSON.stringify(pac)} ; })(), (function(){ ${pac}
    return FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)}); })()`);

for (const [url, host, expected] of [
  ['https://twitter.com/', 'twitter.com', expectProxy],
  ['https://www.google.com/', 'www.google.com', expectProxy],
  ['https://www.youtube.com/', 'www.youtube.com', expectProxy],
  ['https://www.wikipedia.org/', 'www.wikipedia.org', expectProxy],
  ['https://www.baidu.com/', 'www.baidu.com', 'DIRECT'],
  ['https://www.qq.com/', 'www.qq.com', 'DIRECT'],
  ['http://localhost/', 'localhost', 'DIRECT'],
]) {
  let got;
  try { got = await resolve(url, host); } catch (e) { got = 'THREW: ' + e.message; }
  check(`${host} -> ${expected}`, got, expected);
}

console.log(`\n=== RESULT: ${failures === 0 ? 'all checks passed' : failures + ' FAILURES'} ===`);

sw.close(); page.close(); browser.close();
builtinProxy?.close();
try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
await sleep(1000);
await rm(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
