/**
 * Ported from omega-target/test/options_sync.coffee.
 *
 * The chai/sinon `hookPost` + `done()` plumbing becomes `vi.spyOn` +
 * `vi.waitFor` + async tests. Extra cases pin the behaviours MIGRATION.md
 * documents as fixed (the `_waiting` latch, `_legacyGet` value leak) or
 * deliberately changed (the token bucket starting full, `copyTo`'s deletion
 * pass staying dead) during the port, so regressions are caught.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OptionsSync } from '../src/options-sync.js';
import { QuotaExceededError, Storage } from '../src/storage.js';
import type { StorageItems, Unwatch, WatchCallback } from '../src/storage.js';
import { TokenBucket } from '../src/token-bucket.js';
import { BrowserStorage } from '../src/browser-storage.js';
import { Log } from '../src/log.js';

beforeAll(() => {
  // Silence storage and sync logging.
  vi.spyOn(Log, 'log').mockImplementation(() => undefined);
  vi.spyOn(Log, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

/**
 * Effectively unlimited for the handful of writes a test performs. The
 * CoffeeScript suite shared one `new OptionsSync.TokenBucket()` built with no
 * arguments, which only "worked" because `limiter` never compared against the
 * undefined bucket size; the typed constructor requires real numbers.
 */
function unlimited(): TokenBucket {
  return new OptionsSync.TokenBucket(1000, 1000, 'second');
}

describe('OptionsSync', () => {
  describe('#merge', () => {
    const sync = new OptionsSync(new Storage());
    it('should choose the one with newer revision', () => {
      const newVal = { revision: '2' };
      const oldVal = { revision: '1' };
      expect(sync.merge('example', newVal, oldVal)).toBe(newVal);
    });
    it('should use oldVal when sync is disabled in newVal', () => {
      const newVal = { revision: '2', is: 'newVal', syncOptions: 'disabled' };
      const oldVal = { revision: '1', is: 'oldVal' };
      expect(sync.merge('example', newVal, oldVal)).toBe(oldVal);
    });
    it('should use oldVal when sync is disabled in oldVal', () => {
      const newVal = { revision: '2', is: 'newVal' };
      const oldVal = { revision: '1', is: 'oldVal', syncOptions: 'disabled' };
      expect(sync.merge('example', newVal, oldVal)).toBe(oldVal);
    });
    it('should favor oldVal when revisions are equal', () => {
      const newVal = { revision: '1', is: 'newVal' };
      const oldVal = { revision: '1', is: 'oldVal' };
      expect(sync.merge('example', newVal, oldVal)).toBe(oldVal);
    });
    it('should favor oldVal when newVal deeply equals oldVal', () => {
      const newVal = { they: 'are', the: 'same' };
      const oldVal = { they: 'are', the: 'same' };
      expect(sync.merge('example', newVal, oldVal)).toBe(oldVal);
    });
    it('should choose newVal when newVal is different', () => {
      const newVal = { they: 'are', not: 'equal' };
      const oldVal = { they: 'are', not: 'identical' };
      expect(sync.merge('example', newVal, oldVal)).toBe(newVal);
    });
  });

  describe('#requestPush', () => {
    it('should store pendingChanges', () => {
      const sync = new OptionsSync(new Storage());
      sync.enabled = false;
      sync.requestPush({ a: 1 });
      expect(sync.pendingChanges()).toEqual({ a: 1 });
    });

    it('should schedule storage write', async () => {
      const storage = new Storage();
      await storage.set({ a: 1 });
      const setSpy = vi.spyOn(storage, 'set');
      const removeSpy = vi.spyOn(storage, 'remove');

      const sync = new OptionsSync(storage, unlimited());
      sync.debounce = 0;
      sync.requestPush({ a: undefined, b: 1 });

      await vi.waitFor(() => {
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledTimes(1);
      });
      expect(setSpy).toHaveBeenCalledWith({ b: 1 });
      expect(removeSpy).toHaveBeenCalledWith(['a']);
    });

    it('should combine multiple write operations', async () => {
      const storage = new Storage();
      await storage.set({ a: 1, b: 1 });
      const setSpy = vi.spyOn(storage, 'set');
      const removeSpy = vi.spyOn(storage, 'remove');

      const sync = new OptionsSync(storage, unlimited());
      sync.debounce = 0;
      sync.requestPush({ a: undefined });
      sync.requestPush({ b: 2 });
      sync.requestPush({ b: undefined });
      sync.requestPush({ c: 1 });
      sync.requestPush({ d: 1 });
      sync.requestPush({ e: 1 });
      sync.requestPush({ e: undefined });

      await vi.waitFor(() => {
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledTimes(1);
      });
      expect(setSpy).toHaveBeenCalledWith({ c: 1, d: 1 });
      expect(removeSpy).toHaveBeenCalledWith(['a', 'b']);
    });

    it('should disable syncing for the profiles if quota is exceeded', async () => {
      const options: StorageItems = { '+a': { is: 'a', oversized: true }, b: { is: 'b' } };

      const storage = new Storage();
      const setSpy = vi.spyOn(storage, 'set').mockImplementation(async (changes) => {
        for (const value of Object.values(changes)) {
          if ((value as { oversized?: boolean } | undefined)?.oversized) {
            const err = new QuotaExceededError();
            err.perItem = true;
            throw err;
          }
        }
        return changes;
      });

      const sync = new OptionsSync(storage, unlimited());
      sync.debounce = 0;
      sync.requestPush(options);

      // First push fails on the oversized profile; the handler opts it out of
      // syncing (mutating the caller's object in place — the re-queued values
      // are the same references) and retries with only what remains.
      await vi.waitFor(() => {
        expect(setSpy).toHaveBeenCalledTimes(2);
      });
      expect(setSpy).toHaveBeenCalledWith(options);
      expect(setSpy).toHaveBeenCalledWith({ b: { is: 'b' } });
      const profile = options['+a'] as Record<string, unknown>;
      expect(profile['syncOptions']).toBe('disabled');
      expect((profile['syncError'] as { reason: string }).reason).toBe('quotaPerItem');
    });

    it('should recover after a failed read of remote state', async () => {
      // Regression test for a bug fixed during the port: _doPush cleared its
      // _waiting latch only on the success path, so one transient failure
      // reading remote state wedged every later push for the life of the
      // object (and the read sat outside the catch, leaving the rejection
      // unhandled).
      const storage = new Storage();
      let failNext = true;
      const getSpy = vi.spyOn(storage, 'get').mockImplementation(async function (
        this: Storage,
        keys,
      ) {
        if (failNext) {
          failNext = false;
          throw new Error('transient read failure');
        }
        return Storage.prototype.get.call(this, keys);
      });
      const setSpy = vi.spyOn(storage, 'set');

      const sync = new OptionsSync(storage, unlimited());
      sync.debounce = 0;
      sync.requestPush({ a: 1 });

      await vi.waitFor(() => {
        expect(getSpy).toHaveBeenCalledTimes(1);
      });
      // The failed attempt must not consume the pending changes.
      expect(sync.pendingChanges()).toEqual({ a: 1 });

      sync.requestPush({ b: 1 });
      await vi.waitFor(() => {
        expect(setSpy).toHaveBeenCalledTimes(1);
      });
      expect(setSpy).toHaveBeenCalledWith({ a: 1, b: 1 });
    });

    it('should write immediately because the token bucket starts full', async () => {
      // Deliberate deviation from the CoffeeScript version (see MIGRATION.md):
      // `limiter`'s bucket started empty, costing 6 s before the first sync
      // write — once per session under MV2, but after every worker wake-up
      // under MV3. The replacement bucket starts full.
      const bucket = new TokenBucket(10, 10, 'minute');
      expect(bucket.content).toBe(10);
      expect(bucket.tryRemoveTokens(1)).toBe(true);

      const storage = new Storage();
      const setSpy = vi.spyOn(storage, 'set');
      const sync = new OptionsSync(storage); // Default bucket, not `unlimited`.
      sync.debounce = 0;
      sync.requestPush({ a: 1 });
      // An empty-start bucket would sit 6 s waiting for its first token; well
      // under that, the write must already have landed.
      await vi.waitFor(
        () => {
          expect(setSpy).toHaveBeenCalledWith({ a: 1 });
        },
        { timeout: 2000 },
      );
    });
  });

  describe('#copyTo', () => {
    it('should fetch all items from remote storage', async () => {
      const remote = new Storage();
      await remote.set({ a: 1, b: 2, c: 3 });

      const storage = new Storage();
      const setSpy = vi.spyOn(storage, 'set');

      const sync = new OptionsSync(remote);
      await sync.copyTo(storage);

      expect(setSpy).toHaveBeenCalledWith({ a: 1, b: 2, c: 3 });
    });

    it('should merge with local as base', async () => {
      const remote = new Storage();
      await remote.set({ a: 1, b: 2, c: 3, d: undefined });

      const storage = new Storage();
      await storage.set({ a: 1, b: 0, d: 4 });

      const setSpy = vi.spyOn(storage, 'set');
      const removeSpy = vi.spyOn(storage, 'remove');

      const sync = new OptionsSync(remote);
      await sync.copyTo(storage);

      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledWith({ b: 2, c: 3 });
      expect(removeSpy).toHaveBeenCalledWith(['d']);
    });

    it('should leave local-only profiles alone', async () => {
      // The CoffeeScript copyTo had a pass meant to delete local profiles that
      // are gone upstream, dead behind an always-false guard
      // (`not base[key]?.syncOptions == 'disabled'`). Per MIGRATION.md's
      // "Needs a decision" it stays a no-op in the port: enabling it would
      // start deleting local-only profiles on the first sync of an existing
      // install. This pins the no-op; do not "fix" it here without that
      // decision being made.
      const remote = new Storage();
      await remote.set({ '+synced': { color: 'blue' } });

      const local = new Storage();
      await local.set({ '+localOnly': { color: 'red' } });
      const removeSpy = vi.spyOn(local, 'remove');

      const sync = new OptionsSync(remote);
      await sync.copyTo(local);

      expect(await local.get(null)).toEqual({
        '+synced': { color: 'blue' },
        '+localOnly': { color: 'red' },
      });
      expect(removeSpy).not.toHaveBeenCalledWith(['+localOnly']);
    });
  });

  describe('#watchAndPull', () => {
    /** The base Storage never fires watches; give the remote a controllable one. */
    class WatchableStorage extends Storage {
      readonly callbacks: WatchCallback[] = [];
      override watch(_keys: string | string[] | null, callback: WatchCallback): Unwatch {
        this.callbacks.push(callback);
        return () => undefined;
      }
      emit(changes: StorageItems): void {
        for (const callback of this.callbacks) callback(changes);
      }
    }

    it('should pull changes into local when remote changes', async () => {
      const remote = new WatchableStorage();

      const storage = new Storage();
      await storage.set({ a: 1, b: 0, d: 4 });
      const setSpy = vi.spyOn(storage, 'set');
      const removeSpy = vi.spyOn(storage, 'remove');

      const sync = new OptionsSync(remote);
      sync.pullThrottle = 0;
      sync.watchAndPull(storage);

      expect(remote.callbacks).toHaveLength(1);
      remote.emit({ a: 1 });
      remote.emit({ b: 2 });
      remote.emit({ c: 3 });
      remote.emit({ d: undefined });

      await vi.waitFor(() => {
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledTimes(1);
      });
      expect(setSpy).toHaveBeenCalledWith({ b: 2, c: 3 });
      expect(removeSpy).toHaveBeenCalledWith(['d']);
    });
  });
});

/** A LegacyStorageArea double; class methods live on the prototype, as BrowserStorage expects. */
class FakeLocalStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  clear(): void {
    this.map.clear();
  }
}

// The legacy-localStorage path lives in BrowserStorage in the port (MIGRATION.md
// files the bug under OptionsSync, but `_legacyGet` was always browser_storage's).
// It is the storage the sync suite historically stubbed, so its regression test
// sits here.
describe('BrowserStorage#_legacyGet', () => {
  it('should not leak the previous value into a key that fails to parse', async () => {
    // Regression test for a bug fixed during the port: `value` was declared
    // function-scoped and only assigned inside `try`, so a key whose JSON
    // failed to parse inherited the previous key's parsed value instead of
    // falling back to the supplied default.
    const legacy = new FakeLocalStorage();
    const storage = new BrowserStorage(legacy, 'p.');
    await storage.set({ good: { is: 'good' } });
    legacy.setItem('p.bad', '{not json');

    // Key order matters: 'good' parses first, then 'bad' throws.
    const withDefaults = await storage.get({ good: 'unused-default', bad: 'fallback' });
    expect(withDefaults['good']).toEqual({ is: 'good' });
    expect(withDefaults['bad']).toBe('fallback');

    // Without a default the unparsable key is simply absent.
    const bare = await storage.get(['good', 'bad']);
    expect(bare['good']).toEqual({ is: 'good' });
    expect('bad' in bare).toBe(false);
  });
});
