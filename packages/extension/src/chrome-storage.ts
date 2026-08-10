/**
 * A {@link Storage} backed by one `chrome.storage` area.
 *
 * Unlike `BrowserStorage`, keys are not prefixed: this is the area's whole
 * contents, which is how the options bag is stored.
 */

import {
  QuotaExceededError,
  RateLimitExceededError,
  Storage,
  StorageUnavailableError,
} from '@switchydelta/target';
import type { StorageItems, Unwatch, WatchCallback } from '@switchydelta/target';

interface Watcher {
  /** null watches every key in the area. */
  keys: Set<string> | null;
  callback: WatchCallback;
}

const SUSTAINED_PER_MINUTE = 'MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE';

/** Monotonic, so two watchers registered in the same tick cannot collide. */
let nextWatcherId = 0;

export class ChromeStorage extends Storage {
  /** Watchers by area name, then by id. */
  static readonly watchers: Record<string, Map<number, Watcher> | undefined> = {};
  static onChangedListenerInstalled = false;

  /**
   * Translate a `chrome.runtime.lastError` message into one of the typed
   * storage errors, so that callers can react to a quota or rate limit without
   * matching on English prose.
   */
  static parseStorageErrors(err: unknown): Promise<never> {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    if (typeof message !== 'string') return Promise.reject(err);

    if (message.indexOf('QUOTA_BYTES_PER_ITEM') >= 0) {
      const error = new QuotaExceededError(message);
      error.perItem = true;
      return Promise.reject(error);
    }
    if (message.indexOf('QUOTA_BYTES') >= 0) {
      return Promise.reject(new QuotaExceededError(message));
    }
    if (message.indexOf('MAX_ITEMS') >= 0) {
      const error = new QuotaExceededError(message);
      error.maxItems = true;
      return Promise.reject(error);
    }
    if (message.indexOf('MAX_WRITE_OPERATIONS_') >= 0) {
      const error = new RateLimitExceededError(message);
      // FIX: the original tested these on the freshly constructed error, whose
      // message is empty, so neither flag was ever set.
      if (message.indexOf('MAX_WRITE_OPERATIONS_PER_HOUR') >= 0) {
        error.perHour = true;
      } else if (message.indexOf('MAX_WRITE_OPERATIONS_PER_MINUTE') >= 0) {
        error.perMinute = true;
      }
      return Promise.reject(error);
    }
    if (message.indexOf(SUSTAINED_PER_MINUTE) >= 0) {
      const error = new RateLimitExceededError(message);
      error.perMinute = true;
      error.sustained = true;
      return Promise.reject(error);
    }
    if (message.indexOf('is not available') >= 0) {
      // Some Chromium-based browsers disable access to the sync storage.
      return Promise.reject(new StorageUnavailableError(message));
    }
    if (message.indexOf('Please set webextensions.storage.sync.enabled to true') >= 0) {
      // Sync storage disabled in flags.
      return Promise.reject(new StorageUnavailableError(message));
    }
    return Promise.reject(err);
  }

  /** The single `onChanged` listener, shared by every instance and area. */
  static readonly onChangedListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    const area = ChromeStorage.watchers[areaName];
    if (!area) return;

    // Built at most once per event, and only if something actually matches.
    let map: StorageItems | null = null;
    for (const watcher of area.values()) {
      let match = watcher.keys === null;
      if (!match) {
        for (const key of Object.keys(changes)) {
          if (watcher.keys?.has(key)) {
            match = true;
            break;
          }
        }
      }
      if (!match) continue;
      if (map === null) {
        map = {};
        for (const [key, change] of Object.entries(changes)) {
          map[key] = change.newValue;
        }
      }
      watcher.callback(map);
    }
  };

  readonly areaName: string;
  private readonly _area: chrome.storage.StorageArea | undefined;

  constructor(areaName: string) {
    super();
    this.areaName = areaName;
    const areas = chrome.storage as unknown as Record<
      string,
      chrome.storage.StorageArea | undefined
    >;
    this._area = areas[areaName];
  }

  /**
   * Run one area call. The promise form rejects on failure, but some hosts
   * resolve and only report through `runtime.lastError`, so both are checked.
   */
  private async _run<T>(operation: (area: chrome.storage.StorageArea) => Promise<T>): Promise<T> {
    const area = this._area;
    if (!area) {
      return ChromeStorage.parseStorageErrors(
        new Error(`Storage area ${this.areaName} is not available`),
      );
    }
    let result: T;
    try {
      result = await operation(area);
    } catch (e) {
      return ChromeStorage.parseStorageErrors(e);
    }
    const message = chrome.runtime?.lastError?.message;
    if (message) return ChromeStorage.parseStorageErrors(new Error(message));
    return result;
  }

  override get(keys?: string | string[] | null | StorageItems): Promise<StorageItems> {
    return this._run((area) => area.get(keys ?? null));
  }

  override async set(items: StorageItems): Promise<StorageItems> {
    if (Object.keys(items).length === 0) return {};
    await this._run((area) => area.set(items));
    return items;
  }

  override async remove(keys?: string | string[] | null): Promise<void> {
    if (keys == null) {
      await this._run((area) => area.clear());
      return;
    }
    if (Array.isArray(keys) && keys.length === 0) return;
    await this._run((area) => area.remove(keys));
  }

  override watch(keys: string | string[] | null, callback: WatchCallback): Unwatch {
    let area = ChromeStorage.watchers[this.areaName];
    if (!area) {
      area = new Map();
      ChromeStorage.watchers[this.areaName] = area;
    }

    let watchedKeys: Set<string> | null = null;
    if (typeof keys === 'string') {
      // FIX: the original only converted the array form, so a single string key
      // was indexed character-wise and never matched anything.
      watchedKeys = new Set([keys]);
    } else if (Array.isArray(keys)) {
      watchedKeys = new Set(keys);
    }

    const id = nextWatcherId++;
    area.set(id, { keys: watchedKeys, callback });

    if (!ChromeStorage.onChangedListenerInstalled) {
      chrome.storage.onChanged.addListener(ChromeStorage.onChangedListener);
      ChromeStorage.onChangedListenerInstalled = true;
    }

    return () => {
      area.delete(id);
    };
  }
}

export default ChromeStorage;
