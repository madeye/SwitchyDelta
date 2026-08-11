#!/usr/bin/env node
/**
 * Repro: the action icon colour in auto-switch mode when the match comes from
 * a rule list (gfwlist) rather than from a rule on the switch profile itself.
 *
 * Two shapes are exercised, because the options UI can produce either:
 *   A. attached  — the switch profile's defaultProfileName points at the
 *      implicit "__ruleListOf_<switch>" rule list (the "attach rule list" button)
 *   B. referenced — a standalone rule list profile named by one of the switch
 *      profile's own rules
 *
 * For each shape a gfwlist-matched URL should paint fill = the proxy colour and
 * border = the switch colour; a non-matched URL should fall back to direct.
 *
 * gfwlist is embedded from test/fixtures/gfwlist.txt (base64 AutoProxy, the
 * upstream file verbatim) so the test needs no network.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS_FLAGS =
  process.env.HEADLESS === '0'
    ? []
    : ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const EXT = resolve(process.argv[2] ?? 'dist');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROXY = '#99ccee'; // "local" fixed profile
const AUTO = '#99dd99'; // "auto switch"
const DIRECT = '#aaaaaa'; // built-in direct
const LIST = '#dd7788'; // standalone gfwlist profile colour (shape B)

const gfwlist = (await readFile(join(HERE, '..', 'fixtures', 'gfwlist.txt'), 'utf8')).trim();

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
    return new Promise((r) => {
      this.#pending.set(id, r);
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

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`!! port ${PORT} already serving CDP — a stale Chrome is running.`);
  process.exit(2);
} catch {
  /* nothing listening, good */
}

const profileDir = await mkdtemp(join(tmpdir(), 'sd-listicon-'));
const chrome = spawn(
  CHROME,
  [
    ...HEADLESS_FLAGS,
    `--user-data-dir=${profileDir}`,
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
const sw = await Session.open(swTarget.webSocketDebuggerUrl);

const tab = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`, {
    method: 'PUT',
  })
).json();
const page = await Session.open(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await sleep(1000);

const rpc = (method, ...args) =>
  page
    .eval(
      `chrome.runtime.sendMessage({method:${JSON.stringify(method)},args:${JSON.stringify(args)}})
       .then(r => JSON.stringify(r ?? null))`,
    )
    .then((s) => JSON.parse(s));

const actionTitle = () => sw.eval(`new Promise(r => chrome.action.getTitle({}, r))`);

/**
 * Sample the icon Chrome was actually handed.
 *
 * chrome.action.setIcon is hooked in the worker and the 32px ImageData is
 * sampled at the centre (fill) and one pixel in from the mid-left edge
 * (border). This reads the real toolbar bitmap, so the test works against any
 * build — it needs no introspection API in the extension itself.
 */
const installIconHook = () =>
  sw.eval(`(() => {
    if (globalThis.__iconHook) return 'already';
    globalThis.__lastIcon = null;
    const orig = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = (details, cb) => {
      try {
        const img = details?.imageData?.[32] ?? Object.values(details?.imageData ?? {}).pop();
        if (img) {
          const px = (x, y) => {
            const i = (y * img.width + x) * 4;
            return [img.data[i], img.data[i + 1], img.data[i + 2]];
          };
          const mid = Math.floor(img.width / 2);
          globalThis.__lastIcon = { fill: px(mid, mid), edge: px(1, mid) };
        }
      } catch (e) { globalThis.__lastIcon = { error: String(e) }; }
      return orig(details, cb);
    };
    globalThis.__iconHook = true;
    return 'installed';
  })()`);

const lastIcon = async () => {
  const raw = await sw.eval(`JSON.stringify(globalThis.__lastIcon ?? null)`);
  return raw ? JSON.parse(raw) : null;
};

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
/** Allow small channel drift from anti-aliasing along the stroke edge. */
const near = (actual, hex, tol = 12) => {
  if (!Array.isArray(actual)) return false;
  const e = hexToRgb(hex);
  return actual.every((c, i) => Math.abs(c - e[i]) <= tol);
};

const poll = async (read, match, timeoutMs = 6000) => {
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
const brief = (r) => (r?.error ? 'ERROR ' + JSON.stringify(r.error) : 'ok');

console.log(`extension: ${extId}\n`);

// --- profiles ---------------------------------------------------------------
console.log('=== add profiles ===');
console.log(
  '  local          : ' +
    brief(
      await rpc('addProfile', {
        name: 'local',
        profileType: 'FixedProfile',
        color: PROXY,
        revision: 'r1',
        fallbackProxy: { scheme: 'http', host: '127.0.0.1', port: 7890 },
        bypassList: [{ conditionType: 'BypassCondition', pattern: '127.0.0.1' }],
      }),
    ),
);
// Shape A: the implicit attached rule list of "auto switch".
console.log(
  '  attached list  : ' +
    brief(
      await rpc('addProfile', {
        name: '__ruleListOf_auto switch',
        profileType: 'RuleListProfile',
        format: 'AutoProxy',
        color: AUTO, // the UI copies the switch colour
        revision: 'r2',
        ruleList: gfwlist,
        matchProfileName: 'local',
        defaultProfileName: 'direct',
      }),
    ),
);
// Shape B: a standalone rule list profile with its own colour.
console.log(
  '  gfwlist profile: ' +
    brief(
      await rpc('addProfile', {
        name: 'gfwlist',
        profileType: 'RuleListProfile',
        format: 'AutoProxy',
        color: LIST,
        revision: 'r3',
        ruleList: gfwlist,
        matchProfileName: 'local',
        defaultProfileName: 'direct',
      }),
    ),
);

const setSwitch = (patch) =>
  rpc('applyChanges', {
    '+auto switch': {
      profileType: 'SwitchProfile',
      name: 'auto switch',
      color: AUTO,
      revision: 'r4' + JSON.stringify(patch).length,
      rules: [],
      defaultProfileName: 'direct',
      ...patch,
    },
  });

const matchOf = async (url) => {
  const host = new URL(url).hostname;
  const r = await rpc('matchProfile', { url, host, scheme: new URL(url).protocol.replace(':', '') });
  return r?.result ?? r;
};

const openTab = (url) =>
  fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json());

/** A single reusable tab, so navigations happen the way a user browses. */
let navTab = null;
async function navigate(url) {
  if (!navTab) {
    const t = await openTab('about:blank');
    navTab = await Session.open(t.webSocketDebuggerUrl);
    await sleep(500);
  }
  await navTab.send('Page.navigate', { url });
}

async function scenario(label, expectFill, expectBorder, url, expectTitle, { sameTab } = {}) {
  console.log(`\n--- ${label}${sameTab ? ' (same tab)' : ' (new tab)'}: ${url} ---`);
  await installIconHook();
  if (sameTab) await navigate(url);
  else await openTab(url);
  const icon = await poll(
    lastIcon,
    (p) => near(p?.fill, expectFill) && near(p?.edge, expectBorder ?? expectFill),
  );
  const title = await actionTitle();
  console.log(`    match chain: ${JSON.stringify(await matchOf(url))}`);
  check(
    `icon fill=${expectFill}`,
    near(icon?.fill, expectFill),
    `fill=${JSON.stringify(icon?.fill)}`,
  );
  check(
    `icon edge=${expectBorder ?? expectFill}`,
    near(icon?.edge, expectBorder ?? expectFill),
    `edge=${JSON.stringify(icon?.edge)}`,
  );
  if (expectTitle) check(`title "${expectTitle}"`, title === expectTitle, JSON.stringify(title));
}

// --- Shape A: attached rule list -------------------------------------------
console.log('\n=== shape A: rule list attached to "auto switch" ===');
console.log('  setSwitch: ' + brief(await setSwitch({ defaultProfileName: '__ruleListOf_auto switch' })));
console.log('  apply    : ' + brief(await rpc('applyProfile', 'auto switch')));
await sleep(1200);

await scenario('gfwlist match', PROXY, AUTO, 'http://twitter.com/', 'auto switch → local');
await scenario('gfwlist miss', DIRECT, AUTO, 'http://www.baidu.com/', 'auto switch → [Direct]');
// Same-tab navigation: what a user actually does by clicking a link.
await scenario('gfwlist match', PROXY, AUTO, 'http://www.google.com/', 'auto switch → local', {
  sameTab: true,
});
await scenario('gfwlist miss', DIRECT, AUTO, 'http://www.taobao.com/', 'auto switch → [Direct]', {
  sameTab: true,
});
await scenario('gfwlist match', PROXY, AUTO, 'http://www.facebook.com/', 'auto switch → local', {
  sameTab: true,
});

// --- Shape B: rule list referenced by a rule --------------------------------
console.log('\n=== shape B: rule pointing at a standalone gfwlist profile ===');
console.log(
  '  setSwitch: ' +
    brief(
      await setSwitch({
        rules: [
          {
            condition: { conditionType: 'HostWildcardCondition', pattern: '*' },
            profileName: 'gfwlist',
          },
        ],
      }),
    ),
);
console.log('  apply    : ' + brief(await rpc('applyProfile', 'auto switch')));
await sleep(1200);

await scenario('gfwlist match', PROXY, AUTO, 'http://www.youtube.com/', 'auto switch → local');
await scenario('gfwlist miss', DIRECT, AUTO, 'http://www.qq.com/', 'auto switch → [Direct]');

console.log(`\n=== RESULT: ${failures === 0 ? 'all checks passed' : failures + ' FAILURES'} ===`);

sw.close();
navTab?.close();
page.close();
browser.close();
try {
  process.kill(-chrome.pid, 'SIGKILL');
} catch {
  chrome.kill('SIGKILL');
}
await sleep(1000);
await rm(profileDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
