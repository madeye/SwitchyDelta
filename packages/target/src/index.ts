/**
 * @switchydelta/target — browser-agnostic core.
 *
 * Chrome-specific behaviour lives in the extension package, which subclasses
 * `Options` and `Storage`.
 */

export { Log, setTracing, isTracing } from './log.js';
export type { Logger } from './log.js';

export {
  Storage,
  RateLimitExceededError,
  QuotaExceededError,
  StorageUnavailableError,
} from './storage.js';
export type {
  StorageItems,
  WriteOperations,
  ChangeOperations,
  MergeFn,
  WatchCallback,
  Unwatch,
} from './storage.js';

export { BrowserStorage } from './browser-storage.js';
export { OptionsSync } from './options-sync.js';
export { TokenBucket } from './token-bucket.js';
export { defaultOptions } from './default-options.js';
export { Options } from './options.js';
export type { OmegaOptions, ProxyImpl } from './options.js';
export { upgradeLegacyOptions } from './upgrade-legacy.js';
export type { LegacyUpgradeI18n } from './upgrade-legacy.js';

export {
  NetworkError,
  HttpError,
  HttpNotFoundError,
  HttpServerError,
  ContentTypeRejectedError,
  ProfileNotExistError,
  NoOptionsError,
} from './errors.js';
