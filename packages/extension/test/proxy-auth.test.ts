import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FixedProfile } from '@switchydelta/pac';

import { AUTH_REQUEST_CAP, AUTH_REQUEST_TTL_MS, ProxyAuth } from '../src/proxy-auth.js';

interface AreaMock {
  data: Record<string, unknown>;
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

function mockArea(): AreaMock {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in data) out[key] = data[key];
      }
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

function installChrome(areas: {
  session?: AreaMock;
  local?: AreaMock;
  sync?: AreaMock;
  webRequest?: boolean;
}): {
  onAuthRequired: { addListener: ReturnType<typeof vi.fn> };
  onCompleted: { addListener: ReturnType<typeof vi.fn> };
  onErrorOccurred: { addListener: ReturnType<typeof vi.fn> };
} {
  const onAuthRequired = { addListener: vi.fn() };
  const onCompleted = { addListener: vi.fn() };
  const onErrorOccurred = { addListener: vi.fn() };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: areas.session,
      local: areas.local,
      sync: areas.sync,
    },
    webRequest: areas.webRequest
      ? {
          onAuthRequired,
          onCompleted,
          onErrorOccurred,
        }
      : undefined,
    runtime: { lastError: undefined },
  };
  return { onAuthRequired, onCompleted, onErrorOccurred };
}

function fixedProfile(): FixedProfile {
  return {
    name: 'proxy',
    profileType: 'FixedProfile',
    fallbackProxy: { scheme: 'http', host: 'proxy.example', port: 8080 },
    auth: { fallbackProxy: { username: 'alice', password: 's3cret' } },
  };
}

function challenge(requestId: string): chrome.webRequest.WebAuthenticationChallengeDetails {
  return {
    isProxy: true,
    requestId,
    challenger: { host: 'proxy.example', port: 8080 },
  } as chrome.webRequest.WebAuthenticationChallengeDetails;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.useRealTimers();
});

describe('ProxyAuth.listen', () => {
  it('does not register <all_urls> completion listeners', () => {
    const listeners = installChrome({
      session: mockArea(),
      local: mockArea(),
      webRequest: true,
    });
    new ProxyAuth(null).listen();
    expect(listeners.onAuthRequired.addListener).toHaveBeenCalledOnce();
    expect(listeners.onCompleted.addListener).not.toHaveBeenCalled();
    expect(listeners.onErrorOccurred.addListener).not.toHaveBeenCalled();
  });
});

describe('ProxyAuth persist', () => {
  it('writes credentials to session and clears leftover local', async () => {
    const session = mockArea();
    const local = mockArea();
    const sync = mockArea();
    local.data['deltaProxyAuth'] = { leftover: true };
    installChrome({ session, local, sync });

    new ProxyAuth(null).setProxies([fixedProfile()]);
    await vi.waitFor(() => {
      expect(session.data['deltaProxyAuth']).toBeDefined();
      expect(local.data['deltaProxyAuth']).toBeUndefined();
    });
    expect(sync.data['deltaProxyAuth']).toBeUndefined();
  });

  it('falls back to local when session storage is missing', async () => {
    const local = mockArea();
    const sync = mockArea();
    installChrome({ local, sync });

    new ProxyAuth(null).setProxies([fixedProfile()]);
    await vi.waitFor(() => {
      expect(local.data['deltaProxyAuth']).toBeDefined();
    });
    expect(sync.data['deltaProxyAuth']).toBeUndefined();
    const payload = local.data['deltaProxyAuth'] as {
      proxies: Record<string, { auth: { username: string } }[]>;
    };
    expect(payload.proxies['proxy.example:8080']?.[0]?.auth.username).toBe('alice');
  });
});

describe('ProxyAuth request cache', () => {
  it('expires retry state by TTL instead of a completion listener', () => {
    installChrome({ session: mockArea(), local: mockArea() });
    vi.useFakeTimers();
    const auth = new ProxyAuth(null);
    auth.setProxies([fixedProfile()]);

    const first = auth.authHandler(challenge('r1'));
    expect(first).toEqual({
      authCredentials: { username: 'alice', password: 's3cret' },
    });
    expect(auth.authHandler(challenge('r1'))).toEqual({});

    vi.advanceTimersByTime(AUTH_REQUEST_TTL_MS + 1);
    expect(auth.authHandler(challenge('r1'))).toEqual({
      authCredentials: { username: 'alice', password: 's3cret' },
    });
  });

  it('evicts the oldest requestId once the cap is reached', () => {
    installChrome({ session: mockArea(), local: mockArea() });
    const auth = new ProxyAuth(null);
    auth.setProxies([fixedProfile()]);

    auth.authHandler(challenge('keep-me'));
    expect(auth.authHandler(challenge('keep-me'))).toEqual({});

    for (let i = 0; i < AUTH_REQUEST_CAP; i++) {
      auth.authHandler(challenge(`n${i}`));
    }
    // `keep-me` was LRU-oldest and must have been evicted: a new try is issued.
    expect(auth.authHandler(challenge('keep-me'))).toEqual({
      authCredentials: { username: 'alice', password: 's3cret' },
    });
  });
});
