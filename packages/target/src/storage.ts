/** Abstract asynchronous key-value storage. */

import { Log } from './log.js';

/** Operations that failed because a write rate limit was hit. */
export class RateLimitExceededError extends Error {
  override readonly name: string = 'RateLimitExceededError';
  perHour?: boolean;
  perMinute?: boolean;
  sustained?: boolean;
}

/** Operations that failed because a storage quota was exhausted. */
export class QuotaExceededError extends Error {
  override readonly name: string = 'QuotaExceededError';
  perItem?: boolean;
  maxItems?: boolean;
}

/**
 * The storage cannot be used at all. This is fatal and unrecoverable for the
 * lifetime of the process; callers should stop touching this storage.
 */
export class StorageUnavailableError extends Error {
  override readonly name: string = 'StorageUnavailableError';
}

export type StorageItems = Record<string, unknown>;

/** A set of writes to perform against a storage. */
export interface WriteOperations {
  set: StorageItems;
  remove: string[];
}

export interface ChangeOperations {
  changes: StorageItems;
  base?: StorageItems | undefined;
  merge?: MergeFn | undefined;
}

export type MergeFn = (key: string, newVal: unknown, oldVal: unknown) => unknown;

export type WatchCallback = (changes: StorageItems) => void;

export type Unwatch = () => void;

export class Storage {
  static readonly RateLimitExceededError = RateLimitExceededError;
  static readonly QuotaExceededError = QuotaExceededError;
  static readonly StorageUnavailableError = StorageUnavailableError;

  protected _items: StorageItems | undefined;

  /**
   * Reduce a set of desired changes to the writes actually needed.
   *
   * When `base` is given, values equal to what is already stored are dropped.
   * `merge` may substitute a different value, which is how sync conflict
   * resolution hooks in.
   */
  static operationsForChanges(
    changes: StorageItems,
    { base, merge }: { base?: StorageItems | undefined; merge?: MergeFn | undefined } = {},
  ): WriteOperations {
    const set: StorageItems = {};
    const remove: string[] = [];

    for (const key of Object.keys(changes)) {
      let newVal = changes[key];
      const oldVal = base != null ? base[key] : newVal;
      if (merge) {
        newVal = merge(key, newVal, oldVal);
      }
      if (base != null && newVal === oldVal) continue;
      if (typeof newVal === 'undefined') {
        if (typeof oldVal !== 'undefined' || base == null) {
          remove.push(key);
        }
      } else {
        set[key] = newVal;
      }
    }

    return { set, remove };
  }

  /** Read values by key, or everything when `keys` is null. */
  async get(keys?: string | string[] | null | StorageItems): Promise<StorageItems> {
    Log.method('Storage#get', this, arguments);
    if (!this._items) return {};

    const items = this._items;
    const map: StorageItems = {};
    const source = keys ?? items;

    if (typeof source === 'string') {
      map[source] = items[source];
    } else if (Array.isArray(source)) {
      for (const key of source) map[key] = items[key];
    } else if (typeof source === 'object') {
      for (const [key, fallback] of Object.entries(source)) {
        map[key] = items[key] ?? fallback;
      }
    }
    return map;
  }

  /** Write multiple values, returning the items just written. */
  async set(items: StorageItems): Promise<StorageItems> {
    Log.method('Storage#set', this, arguments);
    this._items ??= {};
    for (const [key, value] of Object.entries(items)) {
      this._items[key] = value;
    }
    return items;
  }

  /** Remove values by key, or everything when `keys` is null. */
  async remove(keys?: string | string[] | null): Promise<void> {
    Log.method('Storage#remove', this, arguments);
    if (!this._items) return;
    if (keys == null) {
      this._items = {};
    } else if (Array.isArray(keys)) {
      for (const key of keys) delete this._items[key];
    } else {
      delete this._items[keys];
    }
  }

  /** Observe changes. The returned function stops watching. */
  watch(keys: string | string[] | null, callback: WatchCallback): Unwatch {
    Log.method('Storage#watch', this, arguments);
    void keys;
    void callback;
    return () => undefined;
  }

  /** Apply writes, or a set of changes to be reduced to writes first. */
  async apply(operations: WriteOperations | ChangeOperations): Promise<WriteOperations> {
    const resolved: WriteOperations =
      'changes' in operations
        ? Storage.operationsForChanges(operations.changes, operations)
        : operations;
    await this.set(resolved.set);
    await this.remove(resolved.remove);
    return resolved;
  }
}

export default Storage;
