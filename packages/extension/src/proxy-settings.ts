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
      // Clear proxy settings, returning proxy control to Chromium.
      await settingsClear();
      return;
    }

    let config: chrome.proxy.ProxyConfig;
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
    }

    await this.setProxyAuth(profile, opts);
    await settingsSet({ value: config });
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
}

export default ProxySettings;
