/**
 * Two-way synchronisation between a local storage and a remote (sync) storage.
 *
 * Writes are debounced and rate limited: `chrome.storage.sync` enforces both a
 * write-per-minute budget and a per-item quota, and blowing either one costs
 * the whole batch, so pushes are coalesced and gated by a token bucket.
 */

import { Log } from './log.js';
import { QuotaExceededError, RateLimitExceededError, Storage } from './storage.js';
import type { MergeFn, StorageItems, Unwatch, WriteOperations } from './storage.js';
import { TokenBucket } from './token-bucket.js';
import { Revision } from '@switchydelta/pac';

/** The minimum a rate bucket must provide; see {@link TokenBucket}. */
export interface RateBucket {
  content: number;
  tryRemoveTokens(count: number): boolean;
  removeTokens(count: number): Promise<void>;
  clear?(): void;
}

/** Internal signal: the bucket ran dry between the set and the remove. */
class BucketEmptyError extends Error {
  override readonly name: string = 'BucketEmptyError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const KNOWN_PROFILE_TYPES = new Set([
  'DirectProfile',
  'SystemProfile',
  'FixedProfile',
  'PacProfile',
  'AutoDetectProfile',
  'SwitchProfile',
  'VirtualProfile',
  'RuleListProfile',
  'SwitchyRuleListProfile',
  'AutoProxyRuleListProfile',
]);

const BOOLEAN_SETTING_KEYS = new Set([
  '-enableQuickSwitch',
  '-refreshOnProfileChange',
  '-revertProxyChanges',
  '-confirmDeletion',
  '-showInspectMenu',
  '-addConditionsToBottom',
  '-showExternalProfile',
  '-monitorWebRequests',
]);

const NUMBER_SETTING_KEYS = new Set(['-downloadInterval']);
const STRING_SETTING_KEYS = new Set(['-startupProfileName']);
const ARRAY_SETTING_KEYS = new Set(['-quickSwitchProfiles']);

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'boolean' || t === 'string') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object') return false;
  if (Array.isArray(value)) return value.every(isJsonValue);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isValidSyncProfile(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (typeof profile['name'] !== 'string' || profile['name'].length === 0) return false;
  const profileType = profile['profileType'];
  if (typeof profileType !== 'string' || !KNOWN_PROFILE_TYPES.has(profileType)) return false;
  if ('rules' in profile && profile['rules'] != null) {
    if (!Array.isArray(profile['rules'])) return false;
    for (const rule of profile['rules']) {
      if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) return false;
      const condition = (rule as { condition?: unknown }).condition;
      if (condition != null) {
        if (typeof condition !== 'object' || Array.isArray(condition)) return false;
        if (typeof (condition as { conditionType?: unknown }).conditionType !== 'string') {
          return false;
        }
      }
    }
  } else if (profileType === 'SwitchProfile' || profileType === 'VirtualProfile') {
    return false;
  }
  if (
    (profileType === 'SwitchProfile' || profileType === 'VirtualProfile') &&
    typeof profile['defaultProfileName'] !== 'string'
  ) {
    return false;
  }
  return true;
}

function isValidSettingValue(key: string, value: unknown): boolean {
  if (typeof value === 'undefined') return true;
  if (BOOLEAN_SETTING_KEYS.has(key)) return typeof value === 'boolean';
  if (NUMBER_SETTING_KEYS.has(key)) return typeof value === 'number' && Number.isFinite(value);
  if (STRING_SETTING_KEYS.has(key)) return typeof value === 'string';
  if (ARRAY_SETTING_KEYS.has(key)) return Array.isArray(value) && value.every(isJsonValue);
  return isJsonValue(value);
}

/**
 * Drop remote values whose `+profile` / `-key` shape would crash the options
 * controller (primitives under `+`, missing name/profileType, non-array
 * `rules`, unknown conditionType). Invalid keys are omitted so the local
 * copy is left as-is rather than deleted.
 */
export function sanitizeSyncItems(items: StorageItems): StorageItems {
  const out: StorageItems = {};
  for (const [key, value] of Object.entries(items)) {
    const prefix = key.charCodeAt(0);
    if (prefix === 43 /* + */) {
      if (key.length < 2) continue;
      if (typeof value === 'undefined' || isValidSyncProfile(value)) out[key] = value;
      continue;
    }
    if (prefix === 45 /* - */) {
      if (key.length < 2) continue;
      if (isValidSettingValue(key, value)) out[key] = value;
      continue;
    }
    if (key === 'schemaVersion') {
      if (typeof value === 'number' || typeof value === 'undefined') out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Structural equality, used only as an "is this write a no-op?" test.
 *
 * Key order must not matter, which rules out comparing JSON.stringify output.
 * The CoffeeScript version called jsondiffpatch purely for this, which meant
 * building a full delta just to throw it away.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => deepEqual(value, b[i]));
  }
  if (Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
  );
}

export class OptionsSync {
  static readonly TokenBucket = TokenBucket;

  /** The debounce timeout (ms) for requestPush scheduling. See requestPush. */
  debounce = 1000;

  /** The throttling timeout (ms) for watchAndPull. See watchAndPull. */
  pullThrottle = 1000;

  /** Whether syncing is enabled or not. See requestPush for the effect. */
  enabled = true;

  /** The remote storage of syncing. */
  readonly storage: Storage;

  private readonly _bucket: RateBucket;
  private readonly _clearBucket: () => void;
  private _pending: StorageItems = {};
  private _timeout: ReturnType<typeof setTimeout> | null = null;
  private _waiting = false;

  constructor(storage: Storage, bucket?: RateBucket) {
    this.storage = storage;
    this._bucket = bucket ?? new TokenBucket(10, 10, 'minute', null);
    // Buckets are allowed to come from outside without a clear(); draining by
    // taking everything currently in it is the same thing.
    const bucketClear = this._bucket.clear;
    this._clearBucket = bucketClear
      ? bucketClear.bind(this._bucket)
      : () => {
          this._bucket.tryRemoveTokens(this._bucket.content);
        };
  }

  /**
   * Transform storage values for syncing. The default implementation applies no
   * transformation, but the behavior can be altered by assigning to this field.
   * Note: Transformation is applied before merging.
   */
  transformValue: (value: unknown, key: string) => unknown = (value) => value;

  /**
   * Merge newVal and oldVal of a given key, choosing between them by:
   * 1. Choose oldVal if syncOptions is 'disabled' in either oldVal or newVal.
   * 2. Choose oldVal if it has a revision newer than or equal to that of newVal.
   * 3. Choose oldVal if it deeply equals newVal.
   * 4. Otherwise, choose newVal.
   *
   * The order is load-bearing: the revision test runs before the equality test
   * so that an equal-but-older value still loses on revision alone, and the
   * 'disabled' test runs first so a profile opted out of syncing is never
   * overwritten by whatever stale copy the remote still holds.
   */
  merge: MergeFn = (_key, newVal, oldVal) => {
    if (newVal === oldVal) return oldVal;

    const oldRec = isRecord(oldVal) ? oldVal : undefined;
    const newRec = isRecord(newVal) ? newVal : undefined;
    if (oldRec?.['syncOptions'] === 'disabled' || newRec?.['syncOptions'] === 'disabled') {
      return oldVal;
    }

    const oldRev = oldRec?.['revision'];
    const newRev = newRec?.['revision'];
    if (oldRev != null && newRev != null) {
      if (Revision.compare(String(oldRev), String(newRev)) >= 0) return oldVal;
    }

    if (deepEqual(oldVal, newVal)) return oldVal;
    return newVal;
  };

  /**
   * Request pushing the changes to remote storage. The changes are cached first,
   * and then the actual write operations are scheduled if enabled is true.
   * The actual operation is delayed and debounced, combining continuous writes
   * in a short period into a single write operation.
   */
  requestPush(changes: StorageItems): void {
    if (this._timeout != null) clearTimeout(this._timeout);
    for (const key of Object.keys(changes)) {
      let value = changes[key];
      if (typeof value !== 'undefined') {
        value = this.transformValue(value, key);
        // A transform returning undefined means "do not sync this key at all",
        // which is not the same as the undefined that means "delete".
        if (typeof value === 'undefined') continue;
      }
      this._pending[key] = value;
    }
    if (!this.enabled) return;
    this._timeout = setTimeout(() => {
      void this._doPush();
    }, this.debounce);
  }

  /** The pending changes not yet written to the remote storage. */
  pendingChanges(): StorageItems {
    return this._pending;
  }

  private async _doPush(): Promise<void> {
    this._timeout = null;
    if (this._waiting) return;
    this._waiting = true;

    let base: StorageItems;
    let changes: StorageItems;
    try {
      await this._bucket.removeTokens(1);
      base = await this.storage.get(null);
      // Pending changes are only consumed once the base read has succeeded, so
      // a failure above leaves them queued for the next attempt.
      changes = this._pending;
      this._pending = {};
    } catch (e) {
      // The CoffeeScript original cleared this latch only on the success path,
      // so one transient read failure left it set and every later push
      // returned early — syncing stayed wedged for the life of the object.
      this._waiting = false;
      Log.error('OptionsSync::push could not read remote state', e);
      return;
    }
    this._waiting = false;

    const { set, remove } = Storage.operationsForChanges(changes, { base, merge: this.merge });

    // Values still owed to the remote. Emptied as soon as the write lands, so
    // that a later failure only re-queues what actually failed.
    let unwritten: StorageItems = set;
    try {
      let cost = 0;
      if (Object.keys(set).length > 0) {
        Log.log('OptionsSync::set', set);
        await this.storage.set(set);
        cost = 1;
      }
      unwritten = {};
      if (remove.length > 0) {
        // The removal is a second write against the same budget; give up rather
        // than overrun it, and retry from the top.
        if (!this._bucket.tryRemoveTokens(cost)) throw new BucketEmptyError();
        Log.log('OptionsSync::remove', remove);
        await this.storage.remove(remove);
      }
    } catch (e) {
      // Re-submit the changes for syncing, but with lower priority: anything
      // already queued again by a newer requestPush wins over these.
      for (const key of Object.keys(unwritten)) {
        if (!(key in this._pending)) this._pending[key] = unwritten[key];
      }
      for (const key of remove) {
        if (!(key in this._pending)) this._pending[key] = undefined;
      }

      if (e instanceof BucketEmptyError) {
        await this._doPush();
        return;
      }
      if (e instanceof RateLimitExceededError) {
        Log.log('OptionsSync::rateLimitExceeded');
        // Drain the bucket so the retry waits out a full refill instead of
        // spending the tokens that are already accrued on a doomed write.
        this._clearBucket();
        this.requestPush({});
        return;
      }
      if (e instanceof QuotaExceededError) {
        // A single profile is too large for the per-item quota, and we cannot
        // tell which, so every profile in the failed batch opts out of syncing.
        // TODO(catus): Remove the largest profile each time and retry.
        // The values are the same objects just re-queued above, so marking them
        // here is what gets pushed on the next round.
        let valuesAffected = 0;
        for (const key of Object.keys(unwritten)) {
          const value = unwritten[key];
          if (key[0] === '+' && isRecord(value) && value['syncOptions'] !== 'disabled') {
            value['syncOptions'] = 'disabled';
            value['syncError'] = { reason: 'quotaPerItem' };
            valuesAffected++;
          }
        }
        if (valuesAffected > 0) {
          this.requestPush({});
        } else {
          // Nothing to disable, so the batch is unfixable: drop it.
          this._pending = {};
        }
        return;
      }
      throw e;
    }
  }

  private _logOperations(text: string, operations: WriteOperations): void {
    if (Object.keys(operations.set).length) {
      Log.log(text + '::set', operations.set);
    }
    if (operations.remove.length) {
      Log.log(text + '::remove', operations.remove);
    }
  }

  /**
   * Copy the remote storage over the local one, merging per key.
   * @param local The local storage to be written to
   */
  async copyTo(local: Storage): Promise<void> {
    const [base, changes] = await Promise.all([local.get(null), this.storage.get(null)]);
    // The CoffeeScript version also tried to delete local profiles absent from
    // the remote here, guarded by `not base[key]?.syncOptions == 'disabled'`.
    // CoffeeScript parses that as `(!syncOptions) === 'disabled'`, which is
    // always false, so that pass never ran. It is left out rather than
    // "repaired": enabling it now would start deleting local profiles that were
    // simply never uploaded.
    const operations = await local.apply({
      changes: sanitizeSyncItems(changes),
      base,
      merge: this.merge,
    });
    this._logOperations('OptionsSync::copyTo', operations);
  }

  /**
   * Watch the remote storage for changes, and write them to local.
   * The actual writing is throttled by pullThrottle with initial delay.
   * @param local The local storage to be written to
   * @returns Calling the returned function will stop watching.
   */
  watchAndPull(local: Storage): Unwatch {
    let pullScheduled: ReturnType<typeof setTimeout> | null = null;
    let pull: StorageItems = {};

    const doPull = async (): Promise<void> => {
      const base = await local.get(null);
      const changes = pull;
      pull = {};
      pullScheduled = null;
      const operations = Storage.operationsForChanges(sanitizeSyncItems(changes), {
        base,
        merge: this.merge,
      });
      this._logOperations('OptionsSync::pull', operations);
      await local.apply(operations);
    };

    return this.storage.watch(null, (changes) => {
      for (const key of Object.keys(changes)) {
        pull[key] = changes[key];
      }
      if (pullScheduled != null) return;
      pullScheduled = setTimeout(() => {
        void doPull();
      }, this.pullThrottle);
    });
  }
}

export default OptionsSync;
