/**
 * The central controller.
 *
 * `Options` owns the in-memory options bag, keeps it in sync with local
 * storage (and optionally with remote sync storage), decides which profile is
 * currently applied, and pushes the resulting proxy settings through a
 * platform-specific `ProxyImpl`.
 *
 * Everything a platform needs to specialise is a plain method on this class,
 * because the Chromium build subclasses it heavily and overrides those hooks.
 */

import { Conditions, PacGenerator, Profiles, Revision } from '@switchydelta/pac';
import type {
  MatchResult,
  OptionsBag,
  Condition,
  Profile,
  Request,
  Rule,
  SwitchProfile,
} from '@switchydelta/pac';
import { patch as applyJsonPatch } from 'jsondiffpatch';
import type { Delta } from 'jsondiffpatch';

import { NoOptionsError, ProfileNotExistError } from './errors.js';
import { Log } from './log.js';
import type { Logger } from './log.js';
import { Storage, StorageUnavailableError } from './storage.js';
import type { StorageItems, Unwatch, WatchCallback } from './storage.js';
import type { OptionsSync } from './options-sync.js';
import getDefaultOptions from './default-options.js';

/** The persisted options bag, keyed by `+profileName` and `-settingName`. */
export type OmegaOptions = OptionsBag;

/** The platform hook that actually programs the browser's proxy settings. */
export interface ProxyImpl {
  applyProfile(profile: Profile, meta: Profile, options: OmegaOptions): Promise<unknown>;
}

export interface ApplyProfileOptions {
  /** Set the browser proxy for the applied profile. Defaults to true. */
  proxy?: boolean;
  /** Update this profile and the profiles it references. Defaults to true. */
  update?: boolean;
  /** Whether options are in system mode. */
  system?: boolean;
  /** Passed through to {@link Options.currentProfileChanged}. */
  reason?: string;
}

export interface SetOptionsArgs {
  /**
   * Skip incoming profiles that are not newer than the local copy. Used for
   * changes arriving from storage, which may be stale echoes of our own write.
   */
  checkRevision?: boolean;
  /** Write the changes back to storage. Defaults to true. */
  persist?: boolean;
}

export interface SetExternalProfileArgs {
  /** Do not revert the external change even if `-revertProxyChanges` is set. */
  noRevert?: boolean;
  /** Treat the change as caused by us rather than by another extension. */
  internal?: boolean;
}

export interface SetOptionsSyncArgs {
  /** Overwrite local options with sync storage even when they conflict. */
  force?: boolean;
}

export interface MatchProfileResult {
  profile: Profile | null | undefined;
  results: MatchResult[];
}

/** A rule that only lives in memory, created by {@link Options.addTempRule}. */
interface TempRule extends Rule {
  isTempRule: true;
}

/** The summary of a profile published to the UI via state storage. */
interface AvailableProfile {
  name: string;
  profileType: string;
  color: string | undefined;
  desc: string | null;
  builtin: true | undefined;
  defaultProfileName?: string;
  validResultProfiles?: string[];
}

export class Options {
  /** All the options, in a map from key to value. */
  protected _options: OmegaOptions = {};
  protected _storage: Storage;
  protected _state: Storage;
  protected _currentProfileName: string | null = null;
  protected _revertToProfileName: string | null = null;
  /**
   * Every profile the current profile transitively depends on, keyed by
   * `+name`. A change to any of them invalidates the applied proxy settings.
   *
   * Note: these used to be CoffeeScript prototype-level defaults, i.e. a
   * single object shared by every instance. They are per-instance now.
   */
  protected _watchingProfiles: Record<string, string> = {};
  protected _tempProfile: SwitchProfile | null = null;
  protected _tempProfileActive = false;
  protected _tempProfileRules: Record<string, TempRule | undefined> = {};
  protected _tempProfileRulesByProfile: Record<string, TempRule[] | undefined> = {};
  protected _externalProfile: Profile | null = null;
  protected _isSystem = false;
  protected _watchStop: Unwatch | null = null;
  protected _syncWatchStop: Unwatch | null = null;

  fallbackProfileName = 'system';
  debugStr = 'Options';

  log: Logger;
  sync: OptionsSync | null;
  proxyImpl: ProxyImpl;

  /** Resolves with the options once the first profile has been applied. */
  ready!: Promise<OmegaOptions>;
  /** Resolves with the options once they have been loaded from storage. */
  optionsLoaded!: Promise<OmegaOptions>;

  /**
   * Transform options values (especially profiles) for syncing.
   *
   * Downloaded payloads are dropped: they can be re-fetched from their source
   * URL, and they are large enough to blow the per-item sync quota.
   */
  static transformValueForSync(value: unknown, key: string): unknown {
    if (key[0] === '+') {
      const profile = value as Profile | undefined;
      if (profile && Profiles.updateUrl(profile)) {
        const stripped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(profile as unknown as Record<string, unknown>)) {
          if (k === 'lastUpdate' || k === 'ruleList' || k === 'pacScript') continue;
          stripped[k] = v;
        }
        return stripped;
      }
    }
    return value;
  }

  constructor(
    options: OmegaOptions | null | undefined,
    storage?: Storage | null,
    state?: Storage | null,
    log?: Logger | null,
    sync?: OptionsSync | null,
    proxyImpl?: ProxyImpl,
  ) {
    // The CoffeeScript version called `Storage()` without `new`, which yields
    // undefined for a class; these fall back to a real in-memory Storage.
    this._storage = storage ?? new Storage();
    this._state = state ?? new Storage();
    this.log = log ?? Log;
    this.sync = sync ?? null;
    this.proxyImpl = proxyImpl as ProxyImpl;

    if (options == null) {
      this.init();
    } else {
      // Bound to a local so the closure does not defeat definite-assignment
      // analysis on the field.
      const storageRef = this._storage;
      this.ready = (async () => {
        await storageRef.remove();
        await storageRef.set(options);
        return this.init();
      })();
    }
  }

  toString(): string {
    return '<Options>';
  }

  /** Read a single value from state storage, with a default. */
  protected async _stateGet<T>(key: string, fallback: T): Promise<T> {
    const items = await this._state.get({ [key]: fallback });
    return items[key] as T;
  }

  /** Read a single options value, narrowed by the caller. */
  protected _get<T>(key: string): T | undefined {
    return this._options[key] as T | undefined;
  }

  // --- Loading --------------------------------------------------------------

  /**
   * Read the raw options, either straight from local storage or after pulling
   * the remote sync storage into it.
   */
  private _loadRawOptions(): Promise<StorageItems> {
    if (!this.sync?.enabled) {
      if (!this.sync) {
        void this._state.set({ syncOptions: 'unsupported' });
      }
      return this._storage.get(null);
    }

    void this._state.set({ syncOptions: 'sync' });
    const sync = this.sync;
    this._syncWatchStop = sync.watchAndPull(this._storage);
    return sync
      .copyTo(this._storage)
      .catch(async (e: unknown) => {
        // Only StorageUnavailableError disables syncing; anything else is a
        // real failure and must keep propagating.
        if (!(e instanceof StorageUnavailableError)) throw e;
        console.error(
          'Warning: Sync storage is not available in this browser! Disabling options sync.',
        );
        this._syncWatchStop?.();
        this._syncWatchStop = null;
        this.sync = null;
        await this._state.set({ syncOptions: 'unsupported' });
      })
      .then(() => this._storage.get(null));
  }

  /**
   * Attempt to load options from local and remote storage.
   *
   * On failure this wipes local storage, installs a fallback set of options
   * (from sync storage if it looks usable, otherwise the defaults) and retries.
   */
  loadOptions(args: { retry?: number } = {}): Promise<OmegaOptions> {
    const retry = args.retry ?? 3;
    this._syncWatchStop?.();
    this._syncWatchStop = null;
    this._watchStop?.();
    this._watchStop = null;

    const loadRaw = this._loadRawOptions();

    this.optionsLoaded = loadRaw
      .then((raw) => this.upgrade(raw))
      .then(async ([options, changes]) => {
        await this._storage.apply({ changes });
        return options;
      })
      .then(async (options) => {
        this._options = options;
        this._watchStop = this._watch();
        // Try to set syncOptions to some value if not initialized. A sync
        // storage with no schemaVersion has never been written to, so adopting
        // the local options later will not clobber anything ('pristine').
        const syncOptions = await this._stateGet('syncOptions', '');
        // FIX: the original dereferenced sync unconditionally. The write that
        // would have set 'unsupported' is fire-and-forget, so with no sync
        // available there is a window where this key is still empty and the
        // dereference throws. That TypeError lands in the retry catch below,
        // which treats it as a serious failure and reinstalls default options
        // over the user's real ones.
        if (!syncOptions && this.sync) {
          await this._state.set({ syncOptions: 'conflict' });
          const { schemaVersion } = await this.sync.storage.get('schemaVersion');
          if (!schemaVersion) await this._state.set({ syncOptions: 'pristine' });
        }
        return options;
      })
      .catch(async (e: unknown): Promise<OmegaOptions> => {
        if (!(retry > 0)) throw e;

        let fallbackOptions: OmegaOptions | null | undefined = null;
        if (e instanceof NoOptionsError) {
          void this._state
            .get({ firstRun: 'new', 'web.switchGuide': 'showOnFirstUse' })
            .then((items) => this._state.set(items));
          if (this.sync) {
            const syncOptions = await this._stateGet('syncOptions', '');
            if (syncOptions !== 'conflict') {
              // Nothing locally, so try to adopt whatever sync storage has.
              try {
                const remote = await this.sync.storage.get(null);
                if (!remote['schemaVersion']) {
                  void this._state.set({ syncOptions: 'pristine' });
                  fallbackOptions = null;
                } else {
                  void this._state.set({ syncOptions: 'sync' });
                  this.sync.enabled = true;
                  this.log.log('Options#loadOptions::fromSync', remote);
                  fallbackOptions = remote;
                }
              } catch {
                fallbackOptions = null;
              }
            }
          }
        } else {
          this.log.error((e as Error | undefined)?.stack);
          // Some serious error happened when loading options. Disable syncing
          // and use fallback options.
          void this._state.remove(['syncOptions']);
          fallbackOptions = null;
        }

        const options = fallbackOptions ?? this.parseOptions(this.getDefaultOptions());
        let prevEnabled: boolean | undefined;
        if (this.sync) {
          prevEnabled = this.sync.enabled;
          this.sync.enabled = false;
        }
        await this._storage.remove();
        await this._storage.set(options);
        if (this.sync && prevEnabled !== undefined) this.sync.enabled = prevEnabled;
        return this.loadOptions({ retry: retry - 1 });
      });

    return this.optionsLoaded;
  }

  /** Attempt to initialize (or reinitialize) options. */
  init(): Promise<OmegaOptions> {
    this.ready = this.loadOptions()
      .then(async () => {
        const startup = this._get<string>('-startupProfileName');
        if (startup) {
          return this.applyProfile(startup);
        }
        const st = await this._state.get({
          currentProfileName: this.fallbackProfileName,
          isSystemProfile: false,
        });
        if (st['isSystemProfile']) {
          return this.applyProfile('system');
        }
        return this.applyProfile(
          (st['currentProfileName'] as string) || this.fallbackProfileName,
        );
      })
      .catch((err: unknown) => {
        // FIX: was `if not err instanceof ProfileNotExistError`, which
        // CoffeeScript parsed as `(not err) instanceof ...` — always false, so
        // real errors were silently swallowed instead of logged.
        if (!(err instanceof ProfileNotExistError)) {
          this.log.error(err);
        }
        return this.applyProfile(this.fallbackProfileName);
      })
      .catch((err: unknown) => {
        this.log.error(err);
      })
      .then(() => this.getAll());

    // Deliberately not chained into `ready`: these are follow-up side effects,
    // and callers must not wait on a profile download to consider us ready.
    void this.ready.then(() => {
      if (this.sync?.enabled) this.sync.requestPush(this._options);

      void this._stateGet('firstRun', '').then((firstRun) => {
        if (firstRun) this.onFirstRun(firstRun);
      });

      const interval = this._get<number>('-downloadInterval');
      if (interval !== undefined && interval > 0) {
        void this.updateProfile();
      }
    });

    return this.ready;
  }

  /**
   * Upgrade options from previous versions.
   *
   * Only schemaVersion 1 and 2 are handled here; 1 is migrated to 2 and 2 is
   * current. Derived classes are expected to call super() at the beginning and
   * at the end of their implementation.
   */
  async upgrade(
    options: OmegaOptions | null | undefined,
    changes?: StorageItems,
  ): Promise<[OmegaOptions, StorageItems]> {
    const pending: StorageItems = changes ?? {};
    let version = options?.['schemaVersion'];
    if (version === 1) {
      const opts = options as OmegaOptions;
      let autoDetectUsed = false;
      Profiles.each(opts, (_key, profile) => {
        if (!autoDetectUsed) {
          const refs = Profiles.directReferenceSet(profile);
          if (refs['+auto_detect']) autoDetectUsed = true;
        }
      });
      if (autoDetectUsed) {
        opts['+auto_detect'] = Profiles.create({
          name: 'auto_detect',
          profileType: 'PacProfile',
          pacUrl: 'http://wpad/wpad.dat',
          color: '#00cccc',
        } as Profile);
      }
      version = 2;
      pending['schemaVersion'] = 2;
      opts['schemaVersion'] = 2;
    }
    if (version === 2) {
      // Current schemaVersion.
      return [options as OmegaOptions, pending];
    }
    throw new Error(`Invalid schemaVerion ${String(version)}!`);
  }

  /** Parse options in various formats (including JSON & base64). */
  parseOptions(options: OmegaOptions | string | null | undefined): OmegaOptions {
    let parsed: unknown = options;
    if (typeof options === 'string') {
      let text: string | null = options;
      if (options[0] !== '{') {
        try {
          // The original used Node's `new Buffer(str, 'base64').toString('utf8')`.
          // atob yields raw bytes, so decode them as UTF-8 explicitly; this also
          // works in a service worker, where Buffer does not exist.
          const binary = atob(options);
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          text = new TextDecoder('utf-8').decode(bytes);
        } catch {
          text = null;
        }
      }
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!parsed) {
      throw new Error('Invalid options!');
    }
    return parsed as OmegaOptions;
  }

  /** Reset the options to the given options or the initial options. */
  async reset(options?: OmegaOptions | string | null): Promise<OmegaOptions> {
    this.log.method('Options#reset', this, arguments);
    const source = options ?? this.getDefaultOptions();
    const [opt] = await this.upgrade(this.parseOptions(source));
    // Disable syncing when resetting to avoid affecting sync storage.
    if (this.sync) this.sync.enabled = false;
    void this._state.remove(['syncOptions']);
    await this._storage.remove();
    await this._storage.set(opt);
    return this.init();
  }

  /** Called on the first initialization of options. */
  onFirstRun(reason: string): void {
    void reason;
  }

  /** Return the default options used initially and on resets. */
  getDefaultOptions(): OmegaOptions {
    return getDefaultOptions();
  }

  /** Return all options. */
  getAll(): OmegaOptions {
    return this._options;
  }

  /** Get profile by name. */
  profile(name: string): Profile | undefined {
    return Profiles.byName(name, this._options);
  }

  /**
   * Apply a jsondiffpatch delta to the current options.
   *
   * The delta format is the wire protocol used by the options UI, so it stays
   * even though nothing else here uses jsondiffpatch.
   */
  patch(patch: Delta): Promise<OmegaOptions> | undefined {
    if (!patch) return undefined;
    this.log.method('Options#patch', this, arguments);

    this._options = applyJsonPatch(this._options, patch) as OmegaOptions;
    // Only set the keys whose values have changed.
    const changes: StorageItems = {};
    for (const [key, delta] of Object.entries(patch as Record<string, unknown>)) {
      if (Array.isArray(delta) && delta.length === 3 && delta[1] === 0 && delta[2] === 0) {
        // [previousValue, 0, 0] indicates that the key was removed.
        changes[key] = undefined;
      } else {
        changes[key] = this._options[key];
      }
    }

    return this._setOptions(changes);
  }

  /**
   * Merge `changes` into the in-memory options, react to what changed and
   * (unless `persist` is false) write them back.
   */
  protected _setOptions(
    changes: StorageItems,
    args?: SetOptionsArgs,
  ): Promise<OmegaOptions> | undefined {
    const removed: string[] = [];
    const checkRev = args?.checkRevision ?? false;
    let profilesChanged = false;
    let currentProfileAffected: false | 'removed' | 'changed' = false;

    for (const key of Object.keys(changes)) {
      const value = changes[key];
      if (typeof value === 'undefined') {
        delete this._options[key];
        removed.push(key);
        if (key[0] === '+') {
          profilesChanged = true;
          if (key === '+' + this._currentProfileName) {
            currentProfileAffected = 'removed';
          }
        }
      } else {
        if (key[0] === '+') {
          const existing = this._options[key] as Profile | undefined;
          if (checkRev && existing) {
            // Storage echoes and sync pulls can be stale; ignore anything that
            // is not strictly newer than what we already hold.
            const result = Revision.compare(existing.revision, (value as Profile).revision);
            if (result >= 0) continue;
          }
          profilesChanged = true;
        }
        this._options[key] = value;
      }
      if (!currentProfileAffected && this._watchingProfiles[key]) {
        currentProfileAffected = 'changed';
      }
    }

    switch (currentProfileAffected) {
      case 'removed':
        void this.applyProfile(this.fallbackProfileName);
        break;
      case 'changed':
        void this.applyProfile(this._currentProfileName, { update: false });
        break;
      default:
        if (profilesChanged) this._setAvailableProfiles();
        break;
    }

    if (args?.persist ?? true) {
      if (this.sync?.enabled) this.sync.requestPush(changes);
      for (const key of removed) {
        delete changes[key];
      }
      // FIX: the removal was not chained, so the returned promise could resolve
      // before the keys were actually gone from storage.
      return this._storage
        .set(changes)
        .then(() => this._storage.remove(removed))
        .then(() => this._options);
    }
    return undefined;
  }

  protected _watch(): Unwatch {
    const handler = (changes?: StorageItems): void => {
      let source: StorageItems;
      if (changes) {
        this._setOptions(changes, { checkRevision: true, persist: false });
        source = changes;
      } else {
        // Initial update.
        source = this._options;
      }
      const initial = source === this._options;

      const refresh = source['-refreshOnProfileChange'];
      if (refresh != null) {
        void this._state.set({ refreshOnProfileChange: refresh });
      }

      if (Object.prototype.hasOwnProperty.call(source, '-showExternalProfile')) {
        let showExternal = source['-showExternalProfile'];
        if (showExternal == null) {
          showExternal = true;
          this._setOptions({ '-showExternalProfile': true }, { persist: true });
        }
        void this._state.set({ showExternalProfile: showExternal });
      }

      const quickSwitchProfiles = this._cleanUpQuickSwitchProfiles(
        source['-quickSwitchProfiles'] as string[] | undefined,
      );
      if (source['-enableQuickSwitch'] != null || quickSwitchProfiles != null) {
        void this.reloadQuickSwitch();
      }
      if (source['-downloadInterval'] != null) {
        void this.schedule('updateProfile', this._get<number>('-downloadInterval') as number, () => {
          void this.updateProfile();
        });
      }
      if (source['-showInspectMenu'] != null || initial) {
        let showMenu = this._get<boolean>('-showInspectMenu');
        if (showMenu == null) {
          showMenu = true;
          this._setOptions({ '-showInspectMenu': true }, { persist: true });
        }
        void this.setInspect({ showMenu });
      }
      if (source['-monitorWebRequests'] != null || initial) {
        let monitorWebRequests = this._get<boolean>('-monitorWebRequests');
        if (monitorWebRequests == null) {
          monitorWebRequests = true;
          this._setOptions({ '-monitorWebRequests': true }, { persist: true });
        }
        void this.setMonitorWebRequests(monitorWebRequests);
      }
    };

    handler();
    return this._storage.watch(null, handler as WatchCallback);
  }

  /** Drop empty, duplicate and dangling entries from the quick switch list. */
  protected _cleanUpQuickSwitchProfiles(
    quickSwitchProfiles: string[] | undefined | null,
  ): string[] | undefined {
    if (quickSwitchProfiles == null) return undefined;
    const seen: Record<string, boolean | undefined> = {};
    const valid = quickSwitchProfiles.filter((name) => {
      if (!name) return false;
      const key = Profiles.nameAsKey(name);
      if (seen[key]) return false;
      if (!Profiles.byName(name, this._options)) return false;
      seen[key] = true;
      return true;
    });
    if (valid.length !== quickSwitchProfiles.length) {
      this._setOptions({ '-quickSwitchProfiles': valid }, { persist: true });
    }
    return valid;
  }

  /** Reload the quick switch according to settings. */
  reloadQuickSwitch(): Promise<void> {
    // FIX: this key can be absent; the original dereferenced it unguarded.
    const configured = this._get<string[]>('-quickSwitchProfiles') ?? [];
    const profiles = configured.length < 2 ? null : configured;
    if (this._get<boolean>('-enableQuickSwitch')) {
      return this.setQuickSwitch(profiles, !!profiles);
    }
    return this.setQuickSwitch(null, !!profiles);
  }

  /**
   * Apply the settings related to element proxy inspection.
   * Not implemented in the base class.
   */
  setInspect(settings: { showMenu: boolean }): Promise<void> {
    void settings;
    return Promise.resolve();
  }

  /**
   * Apply the settings related to web request monitoring.
   * Not implemented in the base class.
   */
  setMonitorWebRequests(enabled: boolean): Promise<void> {
    void enabled;
    return Promise.resolve();
  }

  /** Watch for any changes to the options. */
  watch(callback: WatchCallback): Unwatch {
    return this._storage.watch(null, callback);
  }

  protected _profileNotFound(name: string): Profile {
    this.log.error(`Profile ${name} not found! Things may go very, very wrong.`);
    return Profiles.create({
      name,
      profileType: 'VirtualProfile',
      defaultProfileName: 'direct',
    } as Profile);
  }

  /**
   * Get the PAC script for a profile.
   *
   * `compress` is kept for call-site compatibility only: the generator now
   * always emits compact output, and the separate "full compiler" bundle that
   * `_pacWithCompiler()` used to load on demand no longer exists.
   */
  pacForProfile(profile: string | Profile, compress = false): string {
    void compress;
    return PacGenerator.script(this._options, profile, {
      profileNotFound: (name) => this._profileNotFound(name),
    });
  }

  /** Publish the profile list (and valid switch targets) to the UI. */
  protected _setAvailableProfiles(): void {
    const profile = this._currentProfileName ? this.currentProfile() : null;
    const profiles: Record<string, AvailableProfile> = {};
    const currentIncludable = !!profile && Profiles.isIncludable(profile);
    let allReferenceSet: Record<string, string> | null = null;
    let results: string[] | undefined;
    if (!profile || !Profiles.isInclusive(profile)) {
      results = [];
    }
    Profiles.each(this._options, (key, p) => {
      const entry: AvailableProfile = {
        name: p.name,
        profileType: p.profileType,
        color: p.color,
        desc: this.printProfile(p),
        builtin: p.builtin ? true : undefined,
      };
      profiles[key] = entry;
      if (p.profileType === 'VirtualProfile') {
        entry.defaultProfileName = (p as SwitchProfile).defaultProfileName;
        allReferenceSet ??= profile
          ? Profiles.allReferenceSet(profile, this._options, {
              profileNotFound: (name) => this._profileNotFound(name),
            })
          : {};
        if (allReferenceSet[key]) {
          entry.validResultProfiles = Profiles.validResultProfilesFor(p, this._options).map(
            (result) => result.name,
          );
        }
      }
      if (currentIncludable && Profiles.isIncludable(p)) {
        results?.push(p.name);
      }
    });
    if (profile && Profiles.isInclusive(profile)) {
      results = Profiles.validResultProfilesFor(profile, this._options).map((p) => p.name);
    }
    void this._state.set({
      availableProfiles: profiles,
      validResultProfiles: results,
    });
  }

  /** Apply the profile by name. */
  applyProfile(
    name: string | Profile | null | undefined,
    options?: ApplyProfileOptions,
  ): Promise<unknown> {
    this.log.method('Options#applyProfile', this, arguments);
    const profile = Profiles.byName(name ?? undefined, this._options);
    if (!profile) {
      return Promise.reject(new ProfileNotExistError(name as string));
    }

    this._currentProfileName = profile.name;
    this._isSystem = options?.system || profile.profileType === 'SystemProfile';
    this._watchingProfiles = Profiles.allReferenceSet(profile, this._options, {
      profileNotFound: (n) => this._profileNotFound(n),
    });

    void this._state.set({
      currentProfileName: this._currentProfileName,
      isSystemProfile: this._isSystem,
      currentProfileCanAddRule:
        (profile as SwitchProfile).rules != null && profile.profileType !== 'VirtualProfile',
    });
    this._setAvailableProfiles();

    this.currentProfileChanged(options?.reason);
    if (options && options.proxy === false) {
      return Promise.resolve();
    }

    this._tempProfileActive = false;
    let applyProxy: Promise<unknown>;
    if (this._tempProfile != null && Profiles.isIncludable(profile)) {
      // Temp rules are layered on top of the real profile: the temp profile is
      // a SwitchProfile whose default result is the profile being applied, so
      // anything not matched by a temp rule behaves exactly as before.
      const temp = this._tempProfile;
      this._tempProfileActive = true;
      if (temp.defaultProfileName !== profile.name) {
        temp.defaultProfileName = profile.name;
        temp.color = profile.color;
        Profiles.updateRevision(temp);
      }

      // Drop temp rules pointing at profiles that no longer exist.
      const removedKeys: string[] = [];
      for (const key of Object.keys(this._tempProfileRulesByProfile)) {
        const list = this._tempProfileRulesByProfile[key];
        if (!list) continue;
        if (!Profiles.byKey(key, this._options)) {
          removedKeys.push(key);
          for (const rule of list) {
            rule.profileName = null;
            // FIX: guard the index. splice(-1, 1) would remove the last,
            // unrelated rule when the rule is not present.
            const index = temp.rules.indexOf(rule);
            if (index >= 0) temp.rules.splice(index, 1);
          }
        }
      }
      if (removedKeys.length > 0) {
        for (const key of removedKeys) {
          delete this._tempProfileRulesByProfile[key];
        }
        Profiles.updateRevision(temp);
      }

      this._watchingProfiles = Profiles.allReferenceSet(temp, this._options, {
        profileNotFound: (n) => this._profileNotFound(n),
      });

      applyProxy = this.proxyImpl.applyProfile(temp, profile, this._options);
    } else {
      applyProxy = this.proxyImpl.applyProfile(profile, profile, this._options);
    }

    if (options && options.update === false) return applyProxy;

    void applyProxy.then(() => {
      const interval = this._get<number>('-downloadInterval');
      if (!(interval !== undefined && interval > 0)) return;
      if (this._currentProfileName !== profile.name) return;
      const updateProfiles = Object.values(this._watchingProfiles);
      if (updateProfiles.length > 0) {
        void this.updateProfile(updateProfiles);
      }
    });
    return applyProxy;
  }

  /** Get the currently applied profile. */
  currentProfile(): Profile | null | undefined {
    if (this._currentProfileName) {
      return Profiles.byName(this._currentProfileName, this._options);
    }
    return this._externalProfile;
  }

  /** Return true if in system mode. */
  isSystem(): boolean {
    return this._isSystem;
  }

  /**
   * Called when the current profile has changed.
   * Not implemented in the base class.
   */
  currentProfileChanged(reason?: string): void {
    void reason;
  }

  /**
   * Set or disable the quick switch profiles.
   * Not implemented in the base class.
   */
  setQuickSwitch(quickSwitch: string[] | null, canEnable: boolean): Promise<void> {
    void quickSwitch;
    void canEnable;
    return Promise.resolve();
  }

  /**
   * Schedule a task that runs every periodInMinutes, replacing any previous
   * schedule with the same name. Not implemented in the base class.
   */
  schedule(name: string, periodInMinutes: number, callback: () => void): Promise<void> {
    void name;
    void periodInMinutes;
    void callback;
    return Promise.resolve();
  }

  /** True if the match result of the current profile does not depend on the URL. */
  isCurrentProfileStatic(): boolean {
    if (!this._currentProfileName) return true;
    if (this._tempProfileActive) return false;
    const currentProfile = this.currentProfile();
    if (currentProfile && Profiles.isInclusive(currentProfile)) return false;
    return true;
  }

  /**
   * Update the profiles with the given name (or all profiles when null).
   *
   * Resolves with a map from profile key to either the updated profile or the
   * Error that prevented the update.
   */
  updateProfile(
    name?: string | string[] | null,
    optBypassCache?: boolean,
  ): Promise<Record<string, Profile | Error>> {
    this.log.method('Options#updateProfile', this, arguments);
    const results: Record<string, Promise<Profile | Error>> = {};
    Profiles.each(this._options, (key, profile) => {
      if (name != null) {
        if (Array.isArray(name)) {
          if (name.indexOf(profile.name) < 0) return;
        } else if (profile.name !== name) {
          return;
        }
      }
      const url = Profiles.updateUrl(profile);
      if (!url) return;
      const typeHints = Profiles.updateContentTypeHints(profile);
      const fetchResult = this.fetchUrl(url, optBypassCache, typeHints);
      results[key] = fetchResult
        .then(async (data): Promise<Profile> => {
          // Errors and unsuccessful response codes should have been rejected
          // by fetchUrl already, so empty data means success without any
          // update (e.g. a 304).
          if (!data) return profile;
          const current = Profiles.byKey(key, this._options)!;
          (current as Profile & { lastUpdate?: string }).lastUpdate = new Date().toISOString();
          if (Profiles.update(current, data)) {
            Profiles.dropCache(current);
            await this._setOptions({ [key]: current });
            return current;
          }
          return current;
        })
        .catch((reason: unknown) =>
          reason instanceof Error ? reason : new Error(String(reason)),
        );
    });

    return this._allProps(results);
  }

  /** Native replacement for bluebird's Promise.props. */
  private async _allProps<T>(map: Record<string, Promise<T>>): Promise<Record<string, T>> {
    const keys = Object.keys(map);
    const values = await Promise.all(keys.map((key) => map[key] as Promise<T>));
    const result: Record<string, T> = {};
    keys.forEach((key, i) => {
      result[key] = values[i] as T;
    });
    return result;
  }

  /**
   * Make an HTTP GET request to fetch the content of the url.
   * Not implemented in the base class; always rejects.
   */
  fetchUrl(url: string, optBypassCache?: boolean, optTypeHints?: string[]): Promise<string> {
    void url;
    void optBypassCache;
    void optTypeHints;
    return Promise.reject(new Error('not implemented'));
  }

  protected _replaceRefChanges(
    fromName: string,
    toName: string,
    changes?: StorageItems,
  ): StorageItems {
    const result: StorageItems = changes ?? {};

    Profiles.each(this._options, (_key, p) => {
      if (p.name === fromName || p.name === toName) return;
      if (Profiles.replaceRef(p, fromName, toName)) {
        Profiles.updateRevision(p);
        result[Profiles.nameAsKey(p)] = p;
      }
    });

    if (this._options['-startupProfileName'] === fromName) {
      result['-startupProfileName'] = toName;
    }
    // FIX: this key can be absent; the original dereferenced it unguarded.
    const quickSwitch = this._get<string[]>('-quickSwitchProfiles') ?? [];
    // Change fromName to toName in Quick Switch, but only if it does not
    // contain toName already. Otherwise it may cause duplicates.
    if (quickSwitch.indexOf(toName) < 0) {
      for (let i = 0; i < quickSwitch.length; i++) {
        if (quickSwitch[i] === fromName) {
          quickSwitch[i] = toName;
          result['-quickSwitchProfiles'] = quickSwitch;
        }
      }
    }

    return result;
  }

  /** Replace all references of profile fromName to toName. */
  replaceRef(fromName: string, toName: string): Promise<OmegaOptions> | undefined {
    this.log.method('Options#replaceRef', this, arguments);
    const profile = Profiles.byName(fromName, this._options);
    if (!profile) {
      return Promise.reject(new ProfileNotExistError(fromName)) as Promise<OmegaOptions>;
    }

    const changes = this._replaceRefChanges(fromName, toName);
    for (const key of Object.keys(changes)) {
      this._options[key] = changes[key];
    }

    const fromKey = Profiles.nameAsKey(fromName);
    if (this._watchingProfiles[fromKey]) {
      if (this._currentProfileName === fromName) {
        this._currentProfileName = toName;
      }
      void this.applyProfile(this._currentProfileName);
    }

    return this._setOptions(changes);
  }

  /** Rename a profile and update references and options. */
  renameProfile(fromName: string, toName: string): Promise<OmegaOptions> | undefined {
    this.log.method('Options#renameProfile', this, arguments);
    if (Profiles.byName(toName, this._options)) {
      // FIX: the message used to interpolate an undeclared `name`, which
      // resolved to the global `name` (an empty string) instead of `toName`.
      return Promise.reject(
        new Error(`Target name ${toName} already taken!`),
      ) as Promise<OmegaOptions>;
    }
    const profile = Profiles.byName(fromName, this._options);
    if (!profile) {
      return Promise.reject(new ProfileNotExistError(fromName)) as Promise<OmegaOptions>;
    }

    profile.name = toName;
    const changes: StorageItems = {};
    changes[Profiles.nameAsKey(profile)] = profile;

    this._replaceRefChanges(fromName, toName, changes);
    for (const key of Object.keys(changes)) {
      this._options[key] = changes[key];
    }

    const fromKey = Profiles.nameAsKey(fromName);
    changes[fromKey] = undefined;
    delete this._options[fromKey];

    if (this._watchingProfiles[fromKey]) {
      if (this._currentProfileName === fromName) {
        this._currentProfileName = toName;
      }
      void this.applyProfile(this._currentProfileName);
    }

    return this._setOptions(changes);
  }

  /** Add a temp rule mapping a domain to a profile. */
  addTempRule(domain: string, profileName: string): Promise<unknown> {
    this.log.method('Options#addTempRule', this, arguments);
    if (!this._currentProfileName) return Promise.resolve();
    const profile = Profiles.byName(profileName, this._options);
    if (!profile) {
      return Promise.reject(new ProfileNotExistError(profileName));
    }
    if (this._tempProfile == null) {
      const created = Profiles.create('', 'SwitchProfile') as SwitchProfile;
      const currentProfile = this.currentProfile() as Profile;
      created.color = currentProfile.color;
      created.defaultProfileName = currentProfile.name;
      this._tempProfile = created;
    }
    const tempProfile = this._tempProfile;

    let changed = false;
    let rule = this._tempProfileRules[domain];
    if (rule && rule.profileName) {
      if (rule.profileName !== profileName) {
        const oldKey = Profiles.nameAsKey(rule.profileName);
        const list = this._tempProfileRulesByProfile[oldKey];
        // FIX: guard the index; splice(-1, 1) would drop an unrelated rule.
        const index = list ? list.indexOf(rule) : -1;
        if (list && index >= 0) list.splice(index, 1);

        rule.profileName = profileName;
        changed = true;
      }
    } else {
      rule = {
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.' + domain,
        },
        profileName,
        isTempRule: true,
      };
      tempProfile.rules.push(rule);
      this._tempProfileRules[domain] = rule;
      changed = true;
    }

    // FIX: only index the rule when it is new or has just moved profile. The
    // CoffeeScript pushed unconditionally, so calling addTempRule twice with
    // the same domain and profile appended the same rule object again. The
    // stale-rule cleanup in applyProfile then spliced by indexOf once per
    // duplicate, and after the first removal indexOf returns -1 — splice(-1, 1)
    // deletes the last, unrelated rule.
    if (changed) {
      const key = Profiles.nameAsKey(profileName);
      let rulesByProfile = this._tempProfileRulesByProfile[key];
      if (rulesByProfile == null) {
        rulesByProfile = [];
        this._tempProfileRulesByProfile[key] = rulesByProfile;
      }
      if (!rulesByProfile.includes(rule)) rulesByProfile.push(rule);
    }

    if (changed) {
      Profiles.updateRevision(tempProfile);
      return this.applyProfile(this._currentProfileName);
    }
    return Promise.resolve();
  }

  /** Find a temp rule by domain, returning its result profile name. */
  queryTempRule(domain: string): string | null {
    const rule = this._tempProfileRules[domain];
    if (rule) {
      if (rule.profileName) {
        return rule.profileName;
      }
      delete this._tempProfileRules[domain];
    }
    return null;
  }

  /** Add one or more conditions to the current active switch profile. */
  addCondition(
    condition: Condition | Condition[],
    profileName: string,
  ): Promise<OmegaOptions> | undefined {
    this.log.method('Options#addCondition', this, arguments);
    if (!this._currentProfileName) return Promise.resolve(this._options);
    const profile = Profiles.byName(this._currentProfileName, this._options) as
      | SwitchProfile
      | undefined;
    if (!profile?.rules) {
      // FIX: the original interpolated `@profile.name` (the *method* named
      // `profile`, so always the string "profile") and `profile.type`, which
      // does not exist.
      return Promise.reject(
        new Error(
          `Cannot add condition to Profile ${String(profile?.name)} (${String(
            profile?.profileType,
          )})`,
        ),
      ) as Promise<OmegaOptions>;
    }
    const target = Profiles.byName(profileName, this._options);
    if (target == null) {
      return Promise.reject(new ProfileNotExistError(profileName)) as Promise<OmegaOptions>;
    }
    const conditions = Array.isArray(condition) ? condition : [condition];

    for (const cond of conditions) {
      // Try to remove rules with the same condition first.
      const tag = Conditions.tag(cond);
      for (let i = 0; i < profile.rules.length; i++) {
        const existing = profile.rules[i];
        if (existing && Conditions.tag(existing.condition) === tag) {
          profile.rules.splice(i, 1);
          break;
        }
      }

      const rule: Rule = { condition: cond, profileName };
      if (this._options['-addConditionsToBottom']) {
        profile.rules.push(rule);
      } else {
        profile.rules.unshift(rule);
      }
    }

    Profiles.updateRevision(profile);
    return this._setOptions({ [Profiles.nameAsKey(profile)]: profile });
  }

  /** Set the defaultProfileName of a profile. */
  setDefaultProfile(
    profileName: string,
    defaultProfileName: string,
  ): Promise<OmegaOptions> | undefined {
    this.log.method('Options#setDefaultProfile', this, arguments);
    const profile = Profiles.byName(profileName, this._options) as SwitchProfile | undefined;
    if (profile == null) {
      return Promise.reject(new ProfileNotExistError(profileName)) as Promise<OmegaOptions>;
    }
    if (profile.defaultProfileName == null) {
      // FIX: same broken interpolation as in addCondition (`@profile.name` and
      // a literal `@{profile.type}` that was never interpolated at all).
      return Promise.reject(
        new Error(
          `Profile ${profile.name} (${profile.profileType}) does not have defaultProfileName!`,
        ),
      ) as Promise<OmegaOptions>;
    }
    const target = Profiles.byName(defaultProfileName, this._options);
    if (target == null) {
      return Promise.reject(
        new ProfileNotExistError(defaultProfileName),
      ) as Promise<OmegaOptions>;
    }

    profile.defaultProfileName = defaultProfileName;
    Profiles.updateRevision(profile);
    return this._setOptions({ [Profiles.nameAsKey(profile)]: profile });
  }

  /** Add a profile to the options. */
  addProfile(profile: Profile): Promise<OmegaOptions> | undefined {
    this.log.method('Options#addProfile', this, arguments);
    if (Profiles.byName(profile.name, this._options)) {
      return Promise.reject(
        new Error(`Target name ${profile.name} already taken!`),
      ) as Promise<OmegaOptions>;
    }
    return this._setOptions({ [Profiles.nameAsKey(profile)]: profile });
  }

  /**
   * Get the matching results of a request: the profile finally selected plus
   * every intermediate match along the profile chain.
   */
  matchProfile(request: Request): Promise<MatchProfileResult> {
    if (!this._currentProfileName) {
      return Promise.resolve({ profile: this._externalProfile, results: [] });
    }
    const results: MatchResult[] = [];
    let profile: Profile | undefined = this._tempProfileActive
      ? (this._tempProfile as SwitchProfile)
      : Profiles.byName(this._currentProfileName, this._options);
    let lastProfile: Profile | undefined;
    while (profile) {
      lastProfile = profile;
      const result = Profiles.match(profile, request);
      if (result == null) break;
      results.push(result);
      let next: string | undefined;
      if (Array.isArray(result)) {
        next = result[0];
        // Only profile keys (leading '+') continue the chain. A PAC result
        // string such as "PROXY host:port" means this profile is the leaf.
        if (typeof next !== 'string' || next.charCodeAt(0) !== 43 /* + */) break;
      } else if (result.profileName) {
        // Rules may carry a plain name or an already-keyed "+name".
        const pn = result.profileName;
        next = pn.charCodeAt(0) === 43 /* + */ ? pn : Profiles.nameAsKey(pn);
      } else {
        break;
      }
      const nextProfile = Profiles.byKey(next, this._options);
      if (!nextProfile) break;
      profile = nextProfile;
    }
    return Promise.resolve({ profile: lastProfile, results });
  }

  /**
   * Notify Options that the proxy settings were set externally.
   *
   * With `-revertProxyChanges` on, an external change is undone by re-applying
   * the profile we were on before the *first* such change (`_revertToProfileName`),
   * which is recorded while `noRevert` is set (i.e. while the proxy is under
   * someone else's control and reverting would be futile).
   */
  setExternalProfile(profile: Profile, args?: SetExternalProfileArgs): void {
    if (this._options['-revertProxyChanges'] && !this._isSystem) {
      if (profile.name !== this._currentProfileName && this._currentProfileName) {
        if (!args?.noRevert) {
          // FIX: on the first external change nothing has been remembered yet,
          // so this passed null and rejected with ProfileNotExistError — which
          // nothing awaited, so the revert silently never happened. Fall back
          // to the profile currently applied, which is what we are reverting
          // to by definition.
          const revertTo = this._revertToProfileName ?? this._currentProfileName;
          this._revertToProfileName = null;
          this.applyProfile(revertTo).catch((err: unknown) => {
            this.log.error('Options#setExternalProfile::revert', err);
          });
          return;
        }
        this._revertToProfileName ??= this._currentProfileName;
      }
    }
    const p = Profiles.byName(profile.name, this._options);
    if (p) {
      if (args?.internal) {
        void this.applyProfile(p.name, { proxy: false });
      } else {
        void this.applyProfile(p.name, {
          proxy: false,
          system: this._isSystem,
          reason: 'external',
        });
      }
    } else {
      this._currentProfileName = null;
      this._externalProfile = profile;
      profile.color ??= '#49afcd';
      void this._state.set({
        currentProfileName: '',
        externalProfile: profile,
        validResultProfiles: [],
        currentProfileCanAddRule: false,
      });
      this.currentProfileChanged('external');
    }
  }

  /**
   * Switch options syncing on and off.
   *
   * 'conflict' means local options and sync storage both hold real data and
   * one of them must lose; enabling sync from that state requires `force`, and
   * resolves by wiping local storage and re-initialising from sync.
   */
  async setOptionsSync(enabled: boolean, args?: SetOptionsSyncArgs): Promise<unknown> {
    this.log.method('Options#setOptionsSync', this, arguments);
    if (this.sync == null) {
      throw new Error('Options syncing is unsupported.');
    }
    const sync = this.sync;
    const syncOptions = await this._stateGet('syncOptions', '');

    if (!enabled) {
      if (syncOptions === 'sync') {
        void this._state.set({ syncOptions: 'conflict' });
      }
      sync.enabled = false;
      this._syncWatchStop?.();
      this._syncWatchStop = null;
      return undefined;
    }

    if (syncOptions === 'conflict' && !args?.force) {
      throw new Error(
        'Syncing not enabled due to conflict. Retry with force to overwrite ' +
          'local options and enable syncing.',
      );
    }
    if (syncOptions === 'sync') return undefined;

    await this._state.set({ syncOptions: 'sync' });
    if (syncOptions === 'conflict') {
      // Try to re-init options from sync.
      sync.enabled = false;
      await this._storage.remove();
      sync.enabled = true;
      return this.init();
    }
    sync.enabled = true;
    this._syncWatchStop?.();
    sync.requestPush(this._options);
    this._syncWatchStop = sync.watchAndPull(this._storage);
    return undefined;
  }

  /** Clear the sync storage, resetting the syncing state to pristine. */
  async resetOptionsSync(): Promise<void> {
    this.log.method('Options#resetOptionsSync', this, arguments);
    if (this.sync == null) {
      throw new Error('Options syncing is unsupported.');
    }
    this.sync.enabled = false;
    this._syncWatchStop?.();
    this._syncWatchStop = null;
    void this._state.set({ syncOptions: 'conflict' });

    await this.sync.storage.remove();
    await this._state.set({ syncOptions: 'pristine' });
  }

  /**
   * Return a localized, human-readable description of the given profile.
   * Not implemented in the base class.
   */
  printProfile(profile: Profile | null | undefined): string | null {
    void profile;
    return null;
  }
}

export default Options;
