import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Log } from '../src/log.js';
import {
  parseStorageErrors,
  QuotaExceededError,
  RateLimitExceededError,
  Storage,
  StorageUnavailableError,
} from '../src/storage.js';

beforeAll(() => {
  vi.spyOn(Log, 'log').mockImplementation(() => undefined);
  vi.spyOn(Log, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('Storage', () => {
  it('round-trips get / set / remove for string, array, and default-map keys', async () => {
    const storage = new Storage();
    expect(await storage.get(null)).toEqual({});

    await storage.set({ a: 1, b: 2, c: 3 });
    expect(await storage.get(null)).toEqual({ a: 1, b: 2, c: 3 });
    expect(await storage.get('a')).toEqual({ a: 1 });
    expect(await storage.get(['a', 'missing'])).toEqual({ a: 1, missing: undefined });
    expect(await storage.get({ a: 0, missing: 'fallback' })).toEqual({
      a: 1,
      missing: 'fallback',
    });

    await storage.remove('b');
    expect(await storage.get(null)).toEqual({ a: 1, c: 3 });
    await storage.remove(['c']);
    expect(await storage.get(null)).toEqual({ a: 1 });
    await storage.remove();
    expect(await storage.get(null)).toEqual({});
  });

  it('watch is a no-op that returns an unwatch function', () => {
    const storage = new Storage();
    const stop = storage.watch(null, () => undefined);
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('Storage.operationsForChanges / apply', () => {
  it('drops no-ops against a base and honours merge', () => {
    expect(Storage.operationsForChanges({ a: 1, b: undefined })).toEqual({
      set: { a: 1 },
      remove: ['b'],
    });
    expect(Storage.operationsForChanges({ a: 1, b: 2 }, { base: { a: 1 } })).toEqual({
      set: { b: 2 },
      remove: [],
    });
    expect(
      Storage.operationsForChanges(
        { a: 2 },
        { base: { a: 1 }, merge: (_key, _n, oldVal) => oldVal },
      ),
    ).toEqual({ set: {}, remove: [] });
    expect(Storage.operationsForChanges({ gone: undefined }, { base: {} })).toEqual({
      set: {},
      remove: [],
    });
  });

  it('apply writes the reduced set/remove pair', async () => {
    const storage = new Storage();
    await storage.set({ keep: 1, drop: 2 });
    await storage.apply({
      changes: { keep: 1, drop: undefined, add: 3 },
      base: { keep: 1, drop: 2 },
    });
    expect(await storage.get(null)).toEqual({ keep: 1, add: 3 });
  });
});

describe('parseStorageErrors', () => {
  it('classifies quota, rate-limit, and unavailable messages', async () => {
    await expect(parseStorageErrors(new Error('QUOTA_BYTES_PER_ITEM'))).rejects.toMatchObject({
      name: 'QuotaExceededError',
      perItem: true,
    });
    await expect(parseStorageErrors(new Error('QUOTA_BYTES'))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    await expect(parseStorageErrors(new Error('MAX_ITEMS'))).rejects.toMatchObject({
      name: 'QuotaExceededError',
      maxItems: true,
    });
    await expect(
      parseStorageErrors(new Error('MAX_WRITE_OPERATIONS_PER_HOUR')),
    ).rejects.toMatchObject({ name: 'RateLimitExceededError', perHour: true });
    await expect(
      parseStorageErrors(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE')),
    ).rejects.toMatchObject({ name: 'RateLimitExceededError', perMinute: true });
    await expect(
      parseStorageErrors(new Error('MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE')),
    ).rejects.toMatchObject({
      name: 'RateLimitExceededError',
      perMinute: true,
      sustained: true,
    });
    await expect(parseStorageErrors(new Error('Sync is not available'))).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    await expect(
      parseStorageErrors(
        new Error('Please set webextensions.storage.sync.enabled to true in about:config'),
      ),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('re-raises unrecognised errors and non-Error values', async () => {
    const err = new Error('something else');
    await expect(parseStorageErrors(err)).rejects.toBe(err);
    await expect(parseStorageErrors('nope')).rejects.toBe('nope');
    expect(Storage.parseStorageErrors).toBe(parseStorageErrors);
    expect(Storage.RateLimitExceededError).toBe(RateLimitExceededError);
  });
});
