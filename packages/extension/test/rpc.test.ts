import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorizeSender,
  dispatchRpc,
  extensionPageOrigin,
  RPC_METHODS,
  stripAuthFromResult,
} from '../src/rpc.js';
import type { RpcContext } from '../src/rpc.js';

const EXT_ID = 'abcdefghijklmnopqrstuvwxyzabcdef';

function installChrome(overrides: { id?: string; getURL?: (path: string) => string } = {}): void {
  const id = overrides.id ?? EXT_ID;
  const getURL =
    overrides.getURL ?? ((path: string) => `chrome-extension://${id}/${path.replace(/^\//, '')}`);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id, getURL },
  };
}

beforeEach(() => {
  installChrome();
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('RPC_METHODS', () => {
  it('lists the UI and e2e methods and excludes worker-only hooks', () => {
    const names = Object.keys(RPC_METHODS);
    for (const name of [
      'getState',
      'setState',
      'getAll',
      'patch',
      'reset',
      'applyChanges',
      'applyProfile',
      'addProfile',
      'renameProfile',
      'replaceRef',
      'setDefaultProfile',
      'addTempRule',
      'addCondition',
      'updateProfile',
      'pacForProfile',
      'setOptionsSync',
      'resetOptionsSync',
      'proxyAuthStatus',
      'lastActionIconPaint',
      'sampleActionIcon',
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('fetchUrl');
    expect(names).not.toContain('upgrade');
    expect(names).not.toContain('schedule');
    expect(names).not.toContain('setProxyNotControllable');
  });
});

describe('authorizeSender', () => {
  it('rejects a missing or foreign extension id', () => {
    expect(authorizeSender({} as chrome.runtime.MessageSender)).toEqual({
      allowed: false,
      trustedPage: false,
    });
    expect(authorizeSender({ id: 'other' } as chrome.runtime.MessageSender)).toEqual({
      allowed: false,
      trustedPage: false,
    });
  });

  it('rejects a matching id with a web origin (content script)', () => {
    expect(
      authorizeSender({
        id: EXT_ID,
        origin: 'https://evil.example',
        url: 'https://evil.example/page',
      }),
    ).toEqual({ allowed: false, trustedPage: false });
  });

  it('accepts an extension-page origin as a trusted page', () => {
    const origin = extensionPageOrigin();
    expect(
      authorizeSender({
        id: EXT_ID,
        origin,
        url: `${origin}/popup.html`,
      }),
    ).toEqual({ allowed: true, trustedPage: true });
  });

  it('allows a matching id with no origin but strips trust', () => {
    expect(authorizeSender({ id: EXT_ID })).toEqual({
      allowed: true,
      trustedPage: false,
    });
  });

  it('uses getURL so Firefox moz-extension origins match', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    installChrome({
      id: 'switchydelta@madeye.github.io',
      getURL: (path) => `moz-extension://${uuid}/${path.replace(/^\//, '')}`,
    });
    expect(
      authorizeSender({
        id: 'switchydelta@madeye.github.io',
        origin: `moz-extension://${uuid}`,
        url: `moz-extension://${uuid}/options.html`,
      }),
    ).toEqual({ allowed: true, trustedPage: true });
  });
});

describe('stripAuthFromResult', () => {
  it('drops auth from nested profiles and leaves other keys', () => {
    const input = {
      schemaVersion: 2,
      '+proxy': {
        name: 'proxy',
        profileType: 'FixedProfile',
        color: '#000',
        auth: { all: { username: 'u', password: 'secret' } },
      },
      '-downloadInterval': 15,
    };
    expect(stripAuthFromResult(input)).toEqual({
      schemaVersion: 2,
      '+proxy': { name: 'proxy', profileType: 'FixedProfile', color: '#000' },
      '-downloadInterval': 15,
    });
    // Original is untouched.
    expect((input['+proxy'] as { auth?: unknown }).auth).toBeDefined();
  });

  it('does not strip an unrelated auth key on a non-profile object', () => {
    expect(stripAuthFromResult({ auth: 'keep', name: 1 })).toEqual({ auth: 'keep', name: 1 });
  });
});

describe('dispatchRpc', () => {
  it('rejects unknown methods without reflecting', async () => {
    const ctx = { options: {}, state: {} } as unknown as RpcContext;
    await expect(dispatchRpc('fetchUrl', ctx, ['http://example.com'])).rejects.toThrow(
      'No such method: fetchUrl',
    );
  });

  it('forwards allowlisted calls', async () => {
    const getAll = vi.fn(() => ({ ok: 1 }));
    const ctx = { options: { getAll }, state: {} } as unknown as RpcContext;
    await expect(dispatchRpc('getAll', ctx, [])).resolves.toEqual({ ok: 1 });
    expect(getAll).toHaveBeenCalledOnce();
  });
});
