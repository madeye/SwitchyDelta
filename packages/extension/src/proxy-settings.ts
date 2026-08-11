/**
 * Programming the browser proxy through `chrome.proxy.settings`.
 *
 * This is the only `ProxyImpl` in the Chromium build: the script-based and
 * listener-based implementations existed for Firefox and are gone, as is the
 * on-demand `importScripts` of a separate PAC compiler bundle — `PacGenerator`
 * now emits compact script text directly.
 */

import { Conditions, PacGenerator, Profiles } from '@switchydelta/pac';
import type {
  BypassCondition,
  FixedProfile,
  OptionsBag,
  Profile,
  ProxyServer,
} from '@switchydelta/pac';
import { Log } from '@switchydelta/target';
import type { Logger } from '@switchydelta/target';

import { ProxyAuth } from './proxy-auth.js';

const PROTOCOLS = ['proxyForHttp', 'proxyForHttps', 'proxyForFtp'] as const;

/**
 * `chrome.proxy.settings` is a ChromeSetting, which has no promise form, so
 * these keep the callback and translate `runtime.lastError` into a rejection.
 */
function settingsSet(details: chrome.types.ChromeSettingSetDetails): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function settingsClear(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({}, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

/**
 * Structurally conforms to the `ProxyImpl` interface in `@switchydelta/target`
 * (`options.ts`), which is not re-exported from that package's entry point.
 */
export class ProxySettings {
  static isSupported(): boolean {
    return typeof chrome !== 'undefined' && chrome.proxy?.settings != null;
  }

  readonly features: readonly string[] = ['fullUrlHttp', 'pacScript'];

  log: Logger;

  constructor(log?: Logger | null) {
    this.log = log ?? Log;
  }

  async applyProfile(
    profile: Profile,
    meta?: Profile | null,
    options?: OptionsBag | null,
  ): Promise<void> {
    // `meta` identified the profile in the PAC magic comment, which no longer
    // exists; the parameter stays for the ProxyImpl signature.
    void meta;
    const opts = options ?? {};

    if (profile.profileType === 'SystemProfile') {
      // Drop any stored credentials so the popup no longer offers the host
      // permission for a profile that is no longer applied, then hand proxy
      // control back to Chromium.
      await this.setProxyAuth(profile, opts);
      await settingsClear();
      return;
    }

    let config: chrome.proxy.ProxyConfig;
    let releaseCaches = false;
    if (profile.profileType === 'DirectProfile') {
      config = { mode: 'direct' };
    } else if (profile.profileType === 'PacProfile') {
      config = {
        mode: 'pac_script',
        pacScript:
          !profile.pacScript || Profiles.isFileUrl(profile.pacUrl)
            ? { url: profile.pacUrl, mandatory: true }
            : { data: PacGenerator.ascii(profile.pacScript), mandatory: true },
      };
    } else if (profile.profileType === 'FixedProfile') {
      config = this._fixedProfileConfig(profile);
    } else {
      config = {
        mode: 'pac_script',
        pacScript: { mandatory: true, data: this.getProfilePacScript(profile, opts) },
      };
      releaseCaches = true;
    }

    await this.setProxyAuth(profile, opts);
    await settingsSet({ value: config });
    if (releaseCaches) this._dropProfileCaches(profile, opts);
  }

  /**
   * Once the compiled PAC string is in Chrome's settings, the analysis and
   * codegen caches that produced it (parsed rules, regexes, code strings —
   * megabytes for a large rule list) have no consumer left in the worker.
   * They are rebuilt on demand, which the re-boot-on-wake model assumes.
   */
  private _dropProfileCaches(profile: Profile, options: OptionsBag): void {
    const refSet = Profiles.allReferenceSet(profile, options, { profileNotFound: 'ignore' });
    for (const name of Object.values(refSet)) {
      const referenced = Profiles.byName(name, options);
      if (referenced) Profiles.dropCache(referenced);
    }
  }

  private _fixedProfileConfig(profile: FixedProfile): chrome.proxy.ProxyConfig {
    const rules: chrome.proxy.ProxyRules = {};
    let protocolProxySet = false;
    for (const protocol of PROTOCOLS) {
      const proxy = profile[protocol];
      if (proxy) {
        rules[protocol] = proxy;
        protocolProxySet = true;
      }
    }

    let mode = 'fixed_servers';
    const fallback: ProxyServer | undefined = profile.fallbackProxy;
    if (fallback) {
      if (fallback.scheme === 'http') {
        // Chromium refuses an HTTP proxy in `rules.fallbackProxy`: that slot is
        // for the non-per-protocol catch-all, which it only accepts as SOCKS or
        // HTTPS. The equivalent configuration therefore has to be expressed
        // per protocol instead — as `singleProxy` when nothing else is set, or
        // by filling every empty protocol slot with the same server.
        if (!protocolProxySet) {
          rules.singleProxy = fallback;
        } else {
          for (const protocol of PROTOCOLS) {
            rules[protocol] ??= { ...fallback };
          }
        }
      } else {
        rules.fallbackProxy = fallback;
      }
    } else if (!protocolProxySet) {
      mode = 'direct';
    }

    if (mode === 'direct') return { mode };

    // FIX: `bypassList` is optional on a FixedProfile; the original iterated it
    // unguarded and threw on a profile that had never had one.
    rules.bypassList = (profile.bypassList ?? []).map((condition) =>
      this._formatBypassItem(condition),
    );
    return { mode, rules };
  }

  /** Chromium wants the bare pattern, not the `Bypass: ` prefixed rule line. */
  private _formatBypassItem(condition: BypassCondition): string {
    const str = Conditions.str(condition);
    const i = str.indexOf(' ');
    return str.substring(i + 1);
  }

  private _profileNotFound(name: string): Profile {
    this.log.error(`Profile ${name} not found! Things may go very, very wrong.`);
    return Profiles.create({
      name,
      profileType: 'VirtualProfile',
      defaultProfileName: 'direct',
    } as Profile);
  }

  /**
   * Hand the credentials of every profile this one depends on to the auth
   * singleton, which the service worker has already attached its listener to.
   */
  async setProxyAuth(profile: Profile, options: OptionsBag): Promise<void> {
    const proxyAuth = ProxyAuth.shared(this.log);
    proxyAuth.listen();

    const referenced: Profile[] = [];
    const refSet = Profiles.allReferenceSet(profile, options, {
      profileNotFound: (name) => this._profileNotFound(name),
    });
    for (const name of Object.values(refSet)) {
      const referencedProfile = Profiles.byName(name, options);
      if (referencedProfile) referenced.push(referencedProfile);
    }
    proxyAuth.setProxies(referenced);
  }

  getProfilePacScript(profile: Profile, options: OptionsBag): string {
    return PacGenerator.script(options, profile, {
      profileNotFound: (name) => this._profileNotFound(name),
    });
  }

  /**
   * Observe proxy setting changes, including the initial state. The callback
   * receives the ChromeSetting details ({value, levelOfControl}).
   */
  watchProxyChange(callback: (details: chrome.types.ChromeSettingGetResultDetails) => void): void {
    chrome.proxy.settings.onChange.addListener(callback);
    chrome.proxy.settings.get({}, callback);
  }

  /**
   * Identify the profile equivalent to an externally set proxy config: a
   * builtin, an existing profile with the same effect, or an unnamed snapshot
   * profile the popup can offer to import. Ported from the original
   * `proxy_impl_settings.coffee` (minus the PAC magic-comment probe — this
   * build's PAC scripts no longer carry one).
   */
  parseExternalProfile(
    details: chrome.types.ChromeSettingGetResultDetails,
    options: OptionsBag,
  ): Profile | null {
    const value = details.value as chrome.proxy.ProxyConfig | undefined;
    switch (value?.mode) {
      case 'system':
        return Profiles.byName('system', options) ?? null;
      case 'direct':
        return Profiles.byName('direct', options) ?? null;
      case 'auto_detect':
        return {
          profileType: 'PacProfile',
          name: '',
          pacUrl: 'http://wpad/wpad.dat',
        } as Profile;
      case 'pac_script': {
        const url = value.pacScript?.url;
        const data = value.pacScript?.data;
        let found: Profile | null = null;
        Profiles.each(options, (_key, p) => {
          const pac = p as Profile & { pacUrl?: string; pacScript?: string };
          if (p.profileType !== 'PacProfile') return;
          if ((url && pac.pacUrl === url) || (!url && data && pac.pacScript === data)) found = p;
        });
        if (found) return found;
        return (
          url
            ? { profileType: 'PacProfile', name: '', pacUrl: url }
            : { profileType: 'PacProfile', name: '', pacScript: data ?? '' }
        ) as Profile;
      }
      case 'fixed_servers': {
        const rules = value.rules ?? {};
        // Compare against each fixed profile's own generated config; matching
        // the effect beats matching the representation.
        const normalize = (config: chrome.proxy.ProxyRules) => {
          const copy: Record<string, unknown> = { ...config };
          if (copy['singleProxy']) {
            copy['fallbackProxy'] = copy['singleProxy'];
            delete copy['singleProxy'];
          }
          (copy['bypassList'] as string[] | undefined)?.sort();
          return JSON.stringify(copy);
        };
        const wanted = normalize(rules);
        let found: Profile | null = null;
        Profiles.each(options, (_key, p) => {
          if (p.profileType !== 'FixedProfile') return;
          const config = this._fixedProfileConfig(p as FixedProfile);
          if (config.mode === 'fixed_servers' && normalize(config.rules ?? {}) === wanted) {
            found = p;
          }
        });
        if (found) return found;
        return {
          profileType: 'FixedProfile',
          name: '',
          fallbackProxy: rules.singleProxy ?? rules.fallbackProxy,
          proxyForHttp: rules.proxyForHttp,
          proxyForHttps: rules.proxyForHttps,
          proxyForFtp: rules.proxyForFtp,
          bypassList: (rules.bypassList ?? []).map((pattern) => ({
            conditionType: 'BypassCondition',
            pattern,
          })),
        } as Profile;
      }
      default:
        return null;
    }
  }
}

export default ProxySettings;
