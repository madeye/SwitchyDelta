/**
 * State storage backed by `chrome.storage` (service-worker safe).
 *
 * Keys carry a string prefix so that state can share an area with options data
 * without clashing. Two constructions are supported:
 *
 *     new BrowserStorage('omega.local.')            // chrome.storage.local
 *     new BrowserStorage('omega.local.', 'sync')    // chrome.storage.sync
 *     new BrowserStorage(localStorage, 'omega.local.')  // legacy pages / tests
 */

import { Storage } from './storage.js';
import type { StorageItems } from './storage.js';

/** The subset of the `Storage` DOM interface the legacy path relies on. */
export interface LegacyStorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  clear(): void;
}

type ChromeArea = chrome.storage.StorageArea;

function lastErrorMessage(): string | undefined {
  if (typeof chrome === 'undefined') return undefined;
  return chrome.runtime?.lastError?.message;
}

/**
 * Run one `chrome.storage` call and normalise its failure modes.
 *
 * MV3 rejects the returned promise, but some hosts resolve and only report the
 * failure through `runtime.lastError`, so both are checked.
 */
async function chromeCall<T>(operation: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  const message = lastErrorMessage();
  if (message) throw new Error(message);
  return result;
}

export class BrowserStorage extends Storage {
  readonly prefix: string;
  readonly areaName: string;
  private readonly _legacy: LegacyStorageArea | null;
  /**
   * The prototype of the legacy storage object. Calls go through it rather than
   * through the instance so that a page overwriting `localStorage.getItem`
   * (or a key literally named `getItem`) cannot hijack them.
   */
  private readonly _proto: LegacyStorageArea | null;

  constructor(prefix: string, areaName?: string);
  constructor(legacy: LegacyStorageArea, prefix?: string);
  constructor(storageOrPrefix: string | LegacyStorageArea, prefixOrArea?: string) {
    super();
    if (typeof storageOrPrefix === 'string') {
      this.prefix = storageOrPrefix;
      this.areaName = prefixOrArea || 'local';
      this._legacy = null;
      this._proto = null;
    } else {
      this._legacy = storageOrPrefix;
      this.prefix = prefixOrArea || 'omega.local.';
      this.areaName = 'local';
      this._proto = storageOrPrefix
        ? (Object.getPrototypeOf(storageOrPrefix) as LegacyStorageArea)
        : null;
    }
  }

  private _chromeArea(): ChromeArea | undefined {
    if (typeof chrome === 'undefined' || !chrome.storage) return undefined;
    const areas = chrome.storage as unknown as Record<string, ChromeArea | undefined>;
    return areas[this.areaName];
  }

  /** The legacy path is only taken when chrome.storage is genuinely absent. */
  private _isLegacy(): boolean {
    return !!(this._legacy && this._proto?.getItem && !this._chromeArea());
  }

  override async get(keys?: string | string[] | null | StorageItems): Promise<StorageItems> {
    if (this._isLegacy()) return this._legacyGet(keys);
    const area = this._chromeArea();
    if (!area) return {};

    if (keys == null) {
      const items = await chromeCall(() => area.get(null));
      const map: StorageItems = {};
      for (const [fullKey, value] of Object.entries(items ?? {})) {
        if (fullKey.startsWith(this.prefix)) {
          map[fullKey.slice(this.prefix.length)] = value;
        }
      }
      return map;
    }

    // The object form of `keys` carries default values, returned for keys that
    // are missing from storage.
    const defaults: StorageItems = {};
    let keyList: string[];
    if (typeof keys === 'string') {
      keyList = [keys];
      defaults[keys] = undefined;
    } else if (Array.isArray(keys)) {
      keyList = keys;
      for (const key of keys) defaults[key] = undefined;
    } else {
      Object.assign(defaults, keys);
      keyList = Object.keys(keys);
    }

    const items =
      (await chromeCall(() => area.get(keyList.map((key) => this.prefix + key)))) ?? {};
    const result: StorageItems = {};
    for (const key of keyList) {
      const full = this.prefix + key;
      if (Object.prototype.hasOwnProperty.call(items, full)) {
        result[key] = items[full];
      } else if (defaults[key] !== undefined) {
        result[key] = defaults[key];
      }
    }
    return result;
  }

  override async set(items: StorageItems): Promise<StorageItems> {
    if (this._isLegacy()) return this._legacySet(items);
    const area = this._chromeArea();
    if (!area) return items;

    const packed: StorageItems = {};
    for (const [key, value] of Object.entries(items)) {
      if (typeof value === 'undefined') continue;
      packed[this.prefix + key] = value;
    }
    if (Object.keys(packed).length === 0) return items;

    await chromeCall(() => area.set(packed));
    return items;
  }

  override async remove(keys?: string | string[] | null): Promise<void> {
    if (this._isLegacy()) return this._legacyRemove(keys);
    const area = this._chromeArea();
    if (!area) return;

    if (keys == null) {
      // Never `clear()`: the area is shared with options data and possibly with
      // other prefixes, so enumerate and drop only what belongs to us.
      const items = await chromeCall(() => area.get(null));
      const toRemove = Object.keys(items ?? {}).filter((key) => key.startsWith(this.prefix));
      if (toRemove.length === 0) return;
      await chromeCall(() => area.remove(toRemove));
      return;
    }

    if (typeof keys === 'string') {
      await chromeCall(() => area.remove(this.prefix + keys));
      return;
    }
    await chromeCall(() => area.remove(keys.map((key) => this.prefix + key)));
  }

  // --- legacy localStorage path (tests / old MV2 pages) ---------------------

  private async _legacyGet(
    keys?: string | string[] | null | StorageItems,
  ): Promise<StorageItems> {
    const map: StorageItems = {};
    if (typeof keys === 'string') {
      map[keys] = undefined;
    } else if (Array.isArray(keys)) {
      for (const key of keys) map[key] = undefined;
    } else if (keys != null && typeof keys === 'object') {
      Object.assign(map, keys);
    }

    const legacy = this._legacy;
    const proto = this._proto;
    if (!legacy || !proto) return map;

    for (const key of Object.keys(map)) {
      let value: unknown;
      try {
        const raw = proto.getItem.call(legacy, this.prefix + key);
        value = JSON.parse(raw as unknown as string);
      } catch {
        // Unparsable entry: fall through and keep whatever default was given.
      }
      if (value != null) map[key] = value;
      if (typeof map[key] === 'undefined') delete map[key];
    }
    return map;
  }

  private async _legacySet(items: StorageItems): Promise<StorageItems> {
    const legacy = this._legacy;
    const proto = this._proto;
    if (!legacy || !proto) return items;
    for (const [key, value] of Object.entries(items)) {
      proto.setItem.call(legacy, this.prefix + key, JSON.stringify(value));
    }
    return items;
  }

  private async _legacyRemove(keys?: string | string[] | null): Promise<void> {
    const legacy = this._legacy;
    const proto = this._proto;
    if (!legacy || !proto) return;

    if (keys == null) {
      if (!this.prefix) {
        proto.clear.call(legacy);
        return;
      }
      // Scan the whole area, dropping only prefixed keys. The index is not
      // advanced after a removal because removing shifts the remaining keys
      // down into the slot just consumed.
      let index = 0;
      for (;;) {
        const key = proto.key.call(legacy, index);
        if (key === null) break;
        if (key.startsWith(this.prefix)) {
          proto.removeItem.call(legacy, key);
        } else {
          index++;
        }
      }
      return;
    }

    if (typeof keys === 'string') {
      proto.removeItem.call(legacy, this.prefix + keys);
      return;
    }
    for (const key of keys) {
      proto.removeItem.call(legacy, this.prefix + key);
    }
  }
}

export default BrowserStorage;
