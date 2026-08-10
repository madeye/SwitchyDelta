/**
 * Chromium bindings for the options controller.
 *
 * This build is deliberately minimal: the service worker exists to handle proxy
 * authentication, to run scheduled downloads, and to apply the proxy. The
 * per-tab icons, request monitor, context menus, quick-switch cycling, badge
 * and the SwitchySharp / external-extension bridges are not part of it.
 */

import { Options, Log } from '@switchydelta/target';
import type { StorageItems } from '@switchydelta/target';
import { Profiles } from '@switchydelta/pac';
import type { Profile } from '@switchydelta/pac';

import { fetchUrl } from './fetch-url.js';

export class ChromeOptions extends Options {
  /** Alarm callbacks, keyed by the name passed to {@link schedule}. */
  readonly #alarms = new Map<string, () => void>();
  #alarmListenerInstalled = false;

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
          const proxy = (profile as Record<string, unknown>)[scheme.prop];
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
  }
}

export default ChromeOptions;
