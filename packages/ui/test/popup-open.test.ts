/**
 * Toolbar popup first paint: last-published storage snapshot must render
 * without waiting on worker RPC; empty storage waits for getState; a failed
 * fetch surfaces the error. Drives the shipped `bootPopup` path.
 */
// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const popupHtml = readFileSync(join(uiRoot, 'popup.html'), 'utf8');
const STATE_PREFIX = 'delta.local.';

interface AvailableProfile {
  name: string;
  profileType: string;
  color?: string;
  builtin?: boolean;
  desc?: string;
}

function representativeProfiles(): Record<string, AvailableProfile> {
  return {
    '+direct': {
      name: 'direct',
      profileType: 'DirectProfile',
      color: '#aaaaaa',
      builtin: true,
    },
    '+system': {
      name: 'system',
      profileType: 'SystemProfile',
      color: '#000000',
      builtin: true,
    },
    '+proxy': { name: 'proxy', profileType: 'FixedProfile', color: '#99ccee' },
    '+auto': { name: 'auto', profileType: 'SwitchProfile', color: '#99cc99' },
    '+_hidden': { name: '_hidden', profileType: 'FixedProfile', color: '#ff0000' },
  };
}

function snapshotItems(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    availableProfiles: representativeProfiles(),
    currentProfileName: 'proxy',
    isSystemProfile: false,
    currentProfileCanAddRule: true,
    proxyNotControllable: 'app',
    refreshOnProfileChange: false,
    ...overrides,
  };
  const items: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    items[STATE_PREFIX + key] = value;
  }
  return items;
}

function rpcState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    availableProfiles: representativeProfiles(),
    currentProfileName: 'proxy',
    isSystemProfile: false,
    currentProfileCanAddRule: true,
    proxyNotControllable: 'app',
    refreshOnProfileChange: false,
    ...overrides,
  };
}

function installPopupDom(): void {
  const body = popupHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

function profileButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('#om-profiles .om-item')];
}

function profileNames(): string[] {
  return profileButtons().map((el) => el.querySelector('.om-name')?.textContent ?? '');
}

function currentNames(): string[] {
  return profileButtons()
    .filter((el) => el.getAttribute('aria-current') === 'true')
    .map((el) => el.querySelector('.om-name')?.textContent ?? '');
}

interface ChromeStubOptions {
  storage?: Record<string, unknown>;
  sendMessage: (request: { method: string; args?: unknown[] }) => Promise<unknown>;
  hostAccess?: boolean;
}

function installChrome(opts: ChromeStubOptions): void {
  const data = { ...(opts.storage ?? {}) };
  vi.stubGlobal('chrome', {
    i18n: {
      getMessage: vi.fn(() => ''),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
          }
          return out;
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(opts.sendMessage),
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      id: 'test',
    },
    permissions: {
      contains: vi.fn(async () => opts.hostAccess ?? false),
      request: vi.fn(async () => false),
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      reload: vi.fn(async () => undefined),
    },
    windows: {
      update: vi.fn(async () => ({})),
      WINDOW_ID_CURRENT: -1,
    },
    sidePanel: undefined,
  });
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
}

async function loadBoot(): Promise<typeof import('../src/popup/main.js')> {
  vi.resetModules();
  return import('../src/popup/main.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

beforeEach(() => {
  installPopupDom();
});

describe('popup first paint', () => {
  it('paints a storage snapshot without waiting for a hung getState RPC', async () => {
    let resolveRpc!: (value: unknown) => void;
    const hung = new Promise((resolve) => {
      resolveRpc = resolve;
    });
    installChrome({
      storage: snapshotItems(),
      sendMessage: (request) => {
        if (request.method === 'getState') return hung;
        return Promise.resolve({ result: undefined });
      },
    });

    const { bootPopup } = await loadBoot();
    const boot = bootPopup();

    await vi.waitFor(() => {
      expect(profileNames()).toEqual(['direct', 'system', 'proxy', 'auto']);
    });
    expect(currentNames()).toEqual(['proxy']);
    expect(document.querySelector<HTMLButtonElement>('#om-add-rule')?.hidden).toBe(false);
    expect(document.querySelector('#om-not-controllable')?.hidden).toBe(false);
    await vi.waitFor(() => {
      expect(document.querySelector('#om-auth-permission')?.hidden).toBe(false);
    });
    expect(document.querySelector('#om-error')?.hidden).toBe(true);
    expect(
      await Promise.race([boot.then(() => 'settled' as const), Promise.resolve('pending' as const)]),
    ).toBe('pending');

    resolveRpc({ result: rpcState() });
    await boot;
  });

  it('keeps apply-profile on worker RPC after a snapshot paint', async () => {
    const applyCalls: string[] = [];
    let resolveState!: (value: unknown) => void;
    const pendingState = new Promise((resolve) => {
      resolveState = resolve;
    });
    installChrome({
      storage: snapshotItems({ proxyNotControllable: null }),
      sendMessage: (request) => {
        if (request.method === 'getState') return pendingState;
        if (request.method === 'applyProfile') {
          applyCalls.push(String(request.args?.[0] ?? ''));
          return Promise.resolve({ result: undefined });
        }
        return Promise.resolve({ result: undefined });
      },
    });

    const { bootPopup } = await loadBoot();
    const boot = bootPopup();
    await vi.waitFor(() => {
      expect(profileNames()).toContain('auto');
    });

    document.querySelector<HTMLButtonElement>('#om-profiles .om-item[data-profile="auto"]')?.click();
    await vi.waitFor(() => {
      expect(applyCalls).toEqual(['auto']);
    });

    resolveState({ result: rpcState({ proxyNotControllable: null }) });
    await boot;
  });

  it('fills the list from getState when storage has no snapshot', async () => {
    let resolveRpc!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveRpc = resolve;
    });
    const sendMessage = vi.fn((request: { method: string }) => {
      if (request.method === 'getState') return pending;
      return Promise.resolve({ result: undefined });
    });
    installChrome({ storage: {}, sendMessage });

    const { bootPopup } = await loadBoot();
    const boot = bootPopup();

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });
    expect(profileNames()).toEqual([]);
    expect(document.querySelector('#om-error')?.hidden).toBe(true);

    resolveRpc({ result: rpcState({ currentProfileCanAddRule: false, proxyNotControllable: null }) });
    await boot;

    expect(profileNames()).toEqual(['direct', 'system', 'proxy', 'auto']);
    expect(currentNames()).toEqual(['proxy']);
    expect(document.querySelector<HTMLButtonElement>('#om-add-rule')?.hidden).toBe(true);
  });

  it('shows the error surface when storage is empty and getState is rejected', async () => {
    installChrome({
      storage: {},
      sendMessage: async () => ({
        error: { _error: 'error', message: 'worker down' },
      }),
    });

    const { bootPopup } = await loadBoot();
    await bootPopup();

    expect(profileNames()).toEqual([]);
    const error = document.querySelector('#om-error');
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe('worker down');
  });

  it('does not replace a snapshot paint with an error when RPC fails', async () => {
    installChrome({
      storage: snapshotItems({ proxyNotControllable: null }),
      sendMessage: async () => ({
        error: { _error: 'error', message: 'worker down' },
      }),
    });

    const { bootPopup } = await loadBoot();
    await bootPopup();

    expect(profileNames()).toEqual(['direct', 'system', 'proxy', 'auto']);
    expect(document.querySelector('#om-error')?.hidden).toBe(true);
  });

  it('keeps keyboard focus on the current profile after snapshot then getState refresh', async () => {
    installChrome({
      storage: snapshotItems({ proxyNotControllable: null }),
      sendMessage: async (request) => {
        if (request.method === 'getState') return { result: rpcState({ proxyNotControllable: null }) };
        return { result: undefined };
      },
    });

    const { bootPopup } = await loadBoot();
    await bootPopup();

    const current = document.querySelector<HTMLButtonElement>(
      '#om-profiles .om-item[aria-current="true"]',
    );
    expect(current?.dataset['profile']).toBe('proxy');
    expect(current?.isConnected).toBe(true);
    expect(document.activeElement).toBe(current);
  });

  it('does not open Options or close when Add condition is unavailable and a is pressed', async () => {
    installChrome({
      storage: snapshotItems({
        currentProfileCanAddRule: false,
        proxyNotControllable: null,
      }),
      sendMessage: async (request) => {
        if (request.method === 'getState') {
          return {
            result: rpcState({ currentProfileCanAddRule: false, proxyNotControllable: null }),
          };
        }
        return { result: undefined };
      },
    });

    const { bootPopup } = await loadBoot();
    await bootPopup();

    expect(document.querySelector<HTMLButtonElement>('#om-add-rule')?.hidden).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(window.close).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
});

function importSpecifiers(src: string): string[] {
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('popup static graph', () => {
  it('does not import PAC, PSL, or profile-view from the popup entry', () => {
    const files = [
      join(uiRoot, 'src/popup/main.ts'),
      join(uiRoot, 'src/popup/shortcuts.ts'),
      join(uiRoot, 'src/lib/hex-color.ts'),
    ];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      for (const spec of specifiers) {
        expect(spec, file).not.toMatch(/profile-view|@switchydelta\/pac|\/psl/);
      }
    }
  });
});
