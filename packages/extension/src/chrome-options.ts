/**
 * Chromium bindings for the options controller.
 *
 * This build is deliberately minimal: the service worker exists to handle proxy
 * authentication, to run scheduled downloads, and to apply the proxy. The
 * request monitor, context menus, quick-switch cycling, badge and the
 * SwitchySharp / external-extension bridges are not part of it. The original's
 * per-tab icons survive only as the reduced active-tab-only variant
 * (updateIconForActiveTab).
 */

import { Options, Log, NoOptionsError, upgradeLegacyOptions } from '@switchydelta/target';
import type { StorageItems } from '@switchydelta/target';
import type { OmegaOptions } from '@switchydelta/target';
import { Conditions, Profiles } from '@switchydelta/pac';
import type { MatchResult, OptionsBag, Profile } from '@switchydelta/pac';

import {
  clearBadge,
  getLastActionIconPaint,
  sampleActionIconColors,
  setActionIcon,
  setControlLostBadge,
  type ActionIconPaint,
} from './action-icon.js';
import { setActiveTabIconTracking } from './active-tab-icon.js';
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
    this.#lastActiveTabPaint = '';

    // An inclusive profile's colour depends on the active tab URL. Skip the
    // solid fallback paint so it cannot race past the dual-colour repaint.
    const inclusive = profile != null && Profiles.isInclusive(profile);
    setActiveTabIconTracking(inclusive);
    if (inclusive) {
      void this.updateIconForActiveTab();
      return;
    }

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

  /** Dedupe key of the last active-tab paint, so tab events that resolve to
   *  the same colour and title do not redraw the canvas. Reset whenever the
   *  current profile changes, because that path repaints unconditionally. */
  #lastActiveTabPaint = '';

  /**
   * Tint the action icon with the profile that the active tab's URL matches.
   *
   * Only the single global icon is painted — the per-tab icons of the
   * original were dropped (see MIGRATION.md); this is the reduced,
   * active-tab-only successor. URLs a PAC script would never see
   * (chrome://, about:, the new tab page) keep the profile's own colour.
   *
   * Fill = the result profile the URL resolves to (walking through nested
   * rule lists). Border = the inclusive (auto switch) profile's own colour.
   */
  async updateIconForActiveTab(): Promise<void> {
    const profile = this._currentProfileName ? this.currentProfile() : null;
    if (!profile || !Profiles.isInclusive(profile)) return;

    let match: { profile: Profile | null | undefined; results: MatchResult[] } | undefined;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    // While a navigation is uncommitted (slow site, DNS failure, error page)
    // `tab.url` is empty and the destination sits in `pendingUrl` — and a
    // failed navigation never fires an onUpdated `url` change afterwards, so
    // reading only `tab.url` left the icon stuck on the fallback paint.
    const url = tab?.pendingUrl || tab?.url;
    if (url && /^(https?|ftp|ws|wss):/i.test(url)) {
      try {
        match = await this.matchProfile(Conditions.requestFromUrl(url));
      } catch (err) {
        // Bad URL or a broken rule list: fall through to the switch colour.
        Log.error('updateIconForActiveTab: match failed', err);
      }
    }
    // The profile may have been switched while we awaited; that switch's own
    // currentProfileChanged repaint wins.
    if (profile.name !== this._currentProfileName) return;

    // Fill with the result profile (walking past nested rule lists); ring
    // with the inclusive switch colour so both stay visible at once.
    const result = iconResultProfile(profile, match, this._options);
    const color = colorOf(result ?? profile, this._options) ?? profile.color ?? '#1a73e8';
    const ring =
      result && result.name !== profile.name ? (profile.color ?? undefined) : undefined;

    const currentName = chrome.i18n.getMessage('profile_' + profile.name) || profile.name;
    const resultName = result
      ? chrome.i18n.getMessage('profile_' + result.name) || result.name
      : null;
    const title =
      resultName && result!.name !== profile.name
        ? `${currentName} → ${resultName}`
        : currentName;

    const key = `${color}\n${ring ?? ''}\n${title}`;
    if (key === this.#lastActiveTabPaint) return;
    this.#lastActiveTabPaint = key;
    void chrome.action.setTitle({ title });
    await setActionIcon(color, ring);
  }

  // --- Action-icon introspection (e2e) --------------------------------------

  /**
   * Arguments of the most recent {@link setActionIcon} call.
   *
   * The toolbar image itself is not readable over CDP; the e2e suite uses
   * this together with {@link sampleActionIcon} to assert the dual-colour
   * ring without a visible browser window.
   */
  lastActionIconPaint(): ActionIconPaint | null {
    return getLastActionIconPaint();
  }

  /** Sample fill/edge pixels of an icon painted with the given colours. */
  sampleActionIcon(
    color: string,
    borderColor?: string,
    size = 32,
  ): { fill: number[]; edge: number[] } {
    return sampleActionIconColors(color, borderColor, size);
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

// --- Icon colour helpers ----------------------------------------------------

/** Follow a virtual profile to the profile it currently points at. */
function colorOf(profile: Profile, options: OptionsBag): string | undefined {
  let current = profile;
  const seen = new Set<string>();
  while (current.profileType === 'VirtualProfile') {
    if (seen.has(current.name)) break;
    seen.add(current.name);
    const next = Profiles.byName(
      (current as Profile & { defaultProfileName: string }).defaultProfileName,
      options,
    );
    if (!next) break;
    current = next;
  }
  return current.color ?? profile.color;
}

/**
 * Profile whose colour should fill the action icon.
 *
 * Walks the match chain and prefers the last non-inclusive result (proxy,
 * direct, …). Nested rule lists are intermediate: attached lists often share
 * the switch profile's colour, so using the rule list itself as the fill made
 * the icon look unchanged when a rule matched.
 */
function iconResultProfile(
  current: Profile,
  match: { profile: Profile | null | undefined; results: MatchResult[] } | undefined,
  options: OptionsBag,
): Profile | undefined {
  if (!match) return undefined;

  // Prefer the leaf when it is a distinct non-inclusive profile.
  const leaf = match.profile ?? undefined;
  if (leaf && leaf.name !== current.name && !Profiles.isInclusive(leaf)) {
    return leaf;
  }

  // Walk results from the end for a profile reference. Array entries that are
  // profile keys start with '+'; Rules carry profileName.
  for (let i = match.results.length - 1; i >= 0; i--) {
    const r = match.results[i]!;
    let key: string | undefined;
    if (Array.isArray(r)) {
      if (typeof r[0] === 'string' && r[0].charCodeAt(0) === 43 /* + */) key = r[0];
    } else if (r && typeof r === 'object' && r.profileName) {
      const pn = r.profileName;
      key = pn.charCodeAt(0) === 43 /* + */ ? pn : Profiles.nameAsKey(pn);
    }
    if (!key) continue;
    const target = Profiles.byKey(key, options);
    if (!target || target.name === current.name) continue;
    // Skip inclusive intermediates (nested switch / rule list) when a deeper
    // result exists; fall back to them only if nothing better was found.
    if (!Profiles.isInclusive(target)) return target;
  }

  // Leaf may be a nested rule list (match profile missing). Still distinct
  // from the switch — show it so the title/path is not a lie.
  if (leaf && leaf.name !== current.name) return leaf;
  return undefined;
}
