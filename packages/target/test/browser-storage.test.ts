/**
 * BrowserStorage chrome.storage path: prefixing, defaults, lastError
 * translation, and "clear only our prefix".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserStorage } from '../src/browser-storage.js';
import { QuotaExceededError, RateLimitExceededError } from '../src/storage.js';

interface AreaMock {
  data: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function mockArea(initial: Record<string, unknown> = {}): AreaMock {
  const data = { ...initial };
  return {
    data,
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (key in data) out[key] = data[key];
      }
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  };
}

function installChrome(area: AreaMock, areaName = 'local', lastError?: { message: string }): void {
  vi.stubGlobal('chrome', {
    runtime: { lastError },
    storage: { [areaName]: area },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BrowserStorage chrome path', () => {
  it('prefixes keys on set / get / remove', async () => {
    const area = mockArea();
    installChrome(area);
    const storage = new BrowserStorage('delta.local.');

    await storage.set({ a: 1, skip: undefined });
    expect(area.set).toHaveBeenCalledWith({ 'delta.local.a': 1 });
    expect(area.data).toEqual({ 'delta.local.a': 1 });

    expect(await storage.get('a')).toEqual({ a: 1 });
    expect(await storage.get(['a', 'missing'])).toEqual({ a: 1 });
    expect(await storage.get({ a: 0, missing: 'fallback' })).toEqual({
      a: 1,
      missing: 'fallback',
    });

    await storage.remove('a');
    expect(area.remove).toHaveBeenCalledWith('delta.local.a');
  });

  it('get(null) and remove(null) only touch the prefixed slice', async () => {
    const area = mockArea({
      'delta.local.keep': 1,
      'delta.local.drop': 2,
      'other.x': 3,
    });
    installChrome(area);
    const storage = new BrowserStorage('delta.local.');

    expect(await storage.get(null)).toEqual({ keep: 1, drop: 2 });

    await storage.remove();
    expect(area.remove).toHaveBeenCalledWith(['delta.local.keep', 'delta.local.drop']);
    expect(area.data).toEqual({ 'other.x': 3 });
  });

  it('uses the named chrome.storage area', async () => {
    const area = mockArea();
    installChrome(area, 'sync');
    const storage = new BrowserStorage('delta.sync.', 'sync');
    await storage.set({ n: 1 });
    expect(area.set).toHaveBeenCalledWith({ 'delta.sync.n': 1 });
    expect(await storage.get('n')).toEqual({ n: 1 });
  });

  it('returns empty when chrome.storage is absent', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const storage = new BrowserStorage('delta.local.');
    expect(await storage.get(null)).toEqual({});
    expect(await storage.set({ a: 1 })).toEqual({ a: 1 });
    await storage.remove('a');
  });

  it('translates a thrown chrome error via parseStorageErrors', async () => {
    const area = mockArea();
    area.set.mockRejectedValue(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE'));
    installChrome(area);
    const storage = new BrowserStorage('delta.local.');
    await expect(storage.set({ a: 1 })).rejects.toMatchObject({
      name: 'RateLimitExceededError',
      perMinute: true,
    });
    expect(RateLimitExceededError).toBeTruthy();
  });

  it('translates runtime.lastError after a resolved chrome call', async () => {
    const area = mockArea();
    installChrome(area, 'local', { message: 'QUOTA_BYTES_PER_ITEM' });
    const storage = new BrowserStorage('delta.local.');
    await expect(storage.set({ a: 1 })).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
