/**
 * Chromium bindings for the options controller.
 *
 * This build is deliberately minimal: the service worker exists to handle proxy
 * authentication, to run scheduled downloads, and to apply the proxy. The
 * per-tab icons, request monitor, context menus, quick-switch cycling, badge
 * and the SwitchySharp / external-extension bridges are not part of it.
 */

import { Options, Log, NoOptionsError, upgradeLegacyOptions } from '@switchydelta/target';
import type { StorageItems } from '@switchydelta/target';
import type { OmegaOptions } from '@switchydelta/target';
import { Profiles } from '@switchydelta/pac';
import type { Profile } from '@switchydelta/pac';

import { clearBadge, setActionIcon, setControlLostBadge } from './action-icon.js';
import { fetchUrl } from './fetch-url.js';
import { ProxyAuth } from './proxy-auth.js';

export class ChromeOptions extends Options {
  /** Alarm callbacks, keyed by the name passed to {@link schedule}. */
  readonly #alarms = new Map<string, () => void>();
  #alarmListenerInstalled = false;

  /**
   * Whether any applied profile carries proxy credentials, and whether the
   * optional `<all_urls>` host permission that auth interception depends on
   * has been granted. The popup offers the grant when credentials exist
   * without host access.
   */
  async proxyAuthStatus(): Promise<{ hasCredentials: boolean; hostAccess: boolean }> {
    const [hasCredentials, hostAccess] = await Promise.all([
      ProxyAuth.shared(Log).hasCredentials(),
      chrome.permissions.contains({ origins: ['<all_urls>'] }),
    ]);
    return { hasCredentials, hostAccess };
  }

  override fetchUrl(
    url: string,
    bypassCache?: boolean,
    typeHints?: string[],
  ): Promise<string> {
    return fetchUrl(url, bypassCache, typeHints);
  }

  /**
   * Schedule a repeating callback.
   *
   * `chrome.alarms` is the only timer that survives the worker being
   * suspended; a `setInterval` would die with it.
   */
  override async schedule(
    name: string,
    periodInMinutes: number,
    callback: () => void,
  ): Promise<void> {
    const alarmName = 'omega.' + name;

    if (periodInMinutes < 0) {
      this.#alarms.delete(alarmName);
      await chrome.alarms.clear(alarmName);
      return;
    }

    this.#alarms.set(alarmName, callback);

    if (!this.#alarmListenerInstalled) {
      this.#alarmListenerInstalled = true;
      chrome.alarms.onAlarm.addListener((alarm) => {
        this.#alarms.get(alarm.name)?.();
      });
    }

    await chrome.alarms.create(alarmName, { periodInMinutes });
  }

  /**
   * Apply a map of changed top-level option keys.
   *
   * The UI sends this instead of a jsondiffpatch delta: options is a flat bag
   * at the top level, and the delta was reduced to exactly this before being
   * applied anyway. A key with an `undefined` value is a removal.
   */
  async applyChanges(changes: StorageItems): Promise<unknown> {
    return this._setOptions(changes);
  }

  /** A human-readable description of a profile, for UI tooltips. */
  override printProfile(profile: Profile): string | null {
    if (!profile) return null;

    switch (profile.profileType) {
      case 'FixedProfile': {
        const lines: string[] = [];
        for (const scheme of Profiles.schemes) {
          const proxy = (profile as unknown as Record<string, unknown>)[scheme.prop];
          if (!proxy) continue;
          const label = scheme.scheme || 'default';
          lines.push(`${label}: ${Profiles.pacResult(proxy as never)}`);
        }
        return lines.length > 0 ? lines.join('\n') : chrome.i18n.getMessage('DirectProfile');
      }
      case 'PacProfile':
      case 'AutoDetectProfile':
        return (profile as { pacUrl?: string }).pacUrl ?? null;
      default: {
        const type = profile.profileType.endsWith('RuleListProfile')
          ? 'RuleListProfile'
          : profile.profileType;
        return chrome.i18n.getMessage('browserAction_profileDetails_' + type) || null;
      }
    }
  }

  /**
   * Handle the two legacy shapes the base class cannot: a SwitchySharp-era
   * `config` bag already sitting in local storage, which is imported via
   * {@link upgradeLegacyOptions}, and anything else without a schemaVersion
   * (including entirely empty storage), which is a first run rather than a
   * corrupt state.
   *
   * The original also queried a legacy SwitchySharp extension over external
   * messaging before falling back to the `config` key; that bridge is not part
   * of this build, so only the local-storage path remains.
   */
  override async upgrade(
    options: OmegaOptions | null | undefined,
    changes?: StorageItems,
  ): Promise<[OmegaOptions, StorageItems]> {
    try {
      return await super.upgrade(options, changes);
    } catch (err) {
      if (options?.['schemaVersion']) throw err;
      if (options?.['config']) {
        let upgraded: OmegaOptions | null;
        try {
          upgraded = upgradeLegacyOptions(options, {
            upgrade_profile_auto: chrome.i18n.getMessage('upgrade_profile_auto'),
          });
        } catch (ex) {
          Log.error(ex);
          throw ex;
        }
        if (upgraded) {
          void this._state.set({ firstRun: 'upgrade' });
          // The upgraded bag doubles as the change set so it all gets written.
          return super.upgrade(upgraded, upgraded);
        }
        // A `config` key that fails to parse: the original still pushed the
        // undefined result into super() and failed with the generic
        // "Invalid schemaVersion" error. Treat it as having no options.
      }
      throw new NoOptionsError();
    }
  }

  /** Open the options page the first time the extension runs. */
  override onFirstRun(): void {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }

  // Intentionally inert in this build. The base class calls these when the
  // corresponding settings change; there is nothing here to drive.
  override async setInspect(): Promise<void> {}
  override async setMonitorWebRequests(): Promise<void> {}
  override async setQuickSwitch(): Promise<void> {}

  override currentProfileChanged(reason?: string): void {
    Log.log('Options#currentProfileChanged', reason ?? '');

    const profile = this._currentProfileName ? this.currentProfile() : null;
    // Virtual profiles take the colour of their target, like the popup does.
    let display = profile;
    if (display?.profileType === 'VirtualProfile') {
      const target = Profiles.byName(
        (display as Profile & { defaultProfileName: string }).defaultProfileName,
        this._options,
      );
      if (target) display = target;
    }
    void setActionIcon(display?.color ?? '#1a73e8');

    if (profile) {
      const name = chrome.i18n.getMessage('profile_' + profile.name) || profile.name;
      void chrome.action.setTitle({ title: name });
    }
  }

  // --- Proxy control loss ---------------------------------------------------

  private _proxyNotControllable: string | null = null;

  proxyNotControllable(): string | null {
    return this._proxyNotControllable;
  }

  /**
   * Record why the proxy setting cannot be controlled ('app' or 'policy'),
   * or null when control is (back) in our hands. Drives the popup notice via
   * state and the red "=" badge, matching the original.
   */
  setProxyNotControllable(reason: string | null): void {
    this._proxyNotControllable = reason;
    if (reason) {
      void this._state.set({ proxyNotControllable: reason });
      setControlLostBadge();
    } else {
      void this._state.remove(['proxyNotControllable']);
      clearBadge();
    }
  }
}

export default ChromeOptions;
