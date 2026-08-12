/**
 * One-shot importer for SwitchySharp-era options.
 *
 * SwitchySharp kept everything in localStorage as JSON strings under the keys
 * `config`, `profiles`, `quickSwitchProfiles`, `defaultRule` and `rules`. This
 * converts that bag into a schemaVersion-2 options object: settings are mapped
 * key by key, every legacy profile becomes a Pac or Fixed profile, and the
 * rule set becomes one Switch profile backed by a RuleList profile.
 *
 * The caller supplies the localised strings so this module stays free of any
 * `chrome.*` dependency. Returns null when `oldOptions` carries no parseable
 * `config`, i.e. there is nothing to import.
 */

import { Conditions, Profiles, RuleList } from '@switchydelta/pac';
import type {
  BypassCondition,
  Condition,
  FixedProfile,
  PacProfile,
  Profile,
  Rule,
  RuleListProfile,
  SwitchProfile,
} from '@switchydelta/pac';

import type { DeltaOptions } from './options.js';
import type { StorageItems } from './storage.js';

export interface LegacyUpgradeI18n {
  /** The display name for the imported switch profile ("Auto Switch"). */
  upgrade_profile_auto: string;
}

/** A profile as SwitchySharp stored it inside its `profiles` JSON. */
interface LegacyProfile {
  id?: string;
  name?: string;
  proxyMode?: string;
  color?: string;
  proxyConfigUrl?: string;
  useSameProxy?: boolean;
  proxyHttp?: string;
  proxyHttps?: string;
  proxyFtp?: string;
  proxySocks?: string;
  socksVersion?: number;
  proxyExceptions?: string;
}

/** A rule as SwitchySharp stored it inside its `rules` JSON. */
interface LegacyRule {
  name?: string;
  patternType?: string;
  urlPattern?: string;
  profileId?: string;
}

/** `try JSON.parse(...)` — undefined rather than a throw on bad input. */
function tryParse(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Decode the base64 payload of a legacy `data:` PAC url as UTF-8.
 *
 * The original used Node's `new Buffer(text, 'base64').toString('utf8')`; the
 * worker has no Buffer, so this mirrors `Options.parseOptions`.
 */
function decodeBase64Utf8(text: string): string {
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function upgradeLegacyOptions(
  oldOptions: StorageItems,
  i18n: LegacyUpgradeI18n,
): DeltaOptions | null {
  const config = tryParse(oldOptions['config']) as Record<string, unknown> | undefined;
  if (!config) return null;

  const options: DeltaOptions = {};
  options['schemaVersion'] = 2;

  // New key -> SwitchySharp config key.
  const boolItems: Record<string, string> = {
    '-confirmDeletion': 'confirmDeletion',
    '-refreshOnProfileChange': 'refreshTab',
    '-enableQuickSwitch': 'quickSwitch',
    '-revertProxyChanges': 'preventProxyChanges',
  };
  for (const [key, oldKey] of Object.entries(boolItems)) {
    options[key] = !!config[oldKey];
  }
  options['-downloadInterval'] = parseInt(String(config['ruleListReload']), 10) || 15;

  const auto = Profiles.create({
    profileType: 'SwitchProfile',
    name: i18n.upgrade_profile_auto,
    color: '#55bb55',
    defaultProfileName: 'direct', // Repointed to rulelist.name just below.
  } as Profile) as SwitchProfile;
  Profiles.updateRevision(auto);
  options[Profiles.nameAsKey(auto.name)] = auto;

  const rulelist = Profiles.create({
    profileType: 'RuleListProfile',
    name: '__ruleListOf_' + auto.name,
    color: '#dd6633',
    format: config['ruleListAutoProxy'] ? 'AutoProxy' : 'Switchy',
    defaultProfileName: 'direct',
    sourceUrl: (config['ruleListUrl'] as string) || '',
  } as Profile) as RuleListProfile;
  options[Profiles.nameAsKey(rulelist.name)] = rulelist;

  auto.defaultProfileName = rulelist.name;

  const nameMap: Record<string, string> = { auto: auto.name, direct: 'direct' };
  const oldProfiles =
    (tryParse(oldOptions['profiles']) as Record<string, LegacyProfile> | undefined) ?? {};
  const colorTranslations: Record<string, string> = {
    blue: '#99ccee',
    green: '#99dd99',
    red: '#ffaa88',
    yellow: '#ffee99',
    purple: '#d497ee',
    '': '#99ccee',
  };

  let seenFixedProfile = false;
  for (const oldProfile of Object.values(oldProfiles)) {
    let profile: Profile | null = null;
    switch (oldProfile.proxyMode) {
      case 'auto': {
        const pac = Profiles.create({ profileType: 'PacProfile' } as Profile) as PacProfile;
        const url = oldProfile.proxyConfigUrl ?? '';
        if (url.substring(0, 5) === 'data:') {
          const text = url.substring(url.indexOf(',') + 1);
          try {
            pac.pacScript = decodeBase64Utf8(text);
          } catch {
            // The original decoded everything after the comma as base64 and
            // silently produced garbage for URI-encoded (non-base64) data:
            // urls. atob throws instead; keep such a url as pacUrl, which
            // Chromium accepts, rather than abort the whole import.
            pac.pacUrl = url;
          }
        } else {
          pac.pacUrl = url;
        }
        profile = pac;
        break;
      }
      case 'manual': {
        seenFixedProfile = true;
        const fixed = Profiles.create({ profileType: 'FixedProfile' } as Profile) as FixedProfile;
        // SwitchySharp initialises the proxy fields to '' but old exports may
        // omit them; `?? ''` makes parseHostPort return undefined instead of
        // the original's throw on a missing field.
        if (oldProfile.useSameProxy) {
          fixed.fallbackProxy = Profiles.parseHostPort(oldProfile.proxyHttp ?? '', 'http');
        } else if (oldProfile.proxySocks) {
          const protocol = oldProfile.socksVersion === 5 ? 'socks5' : 'socks4';
          fixed.fallbackProxy = Profiles.parseHostPort(oldProfile.proxySocks, protocol);
        } else {
          fixed.proxyForHttp = Profiles.parseHostPort(oldProfile.proxyHttp ?? '', 'http');
          fixed.proxyForHttps = Profiles.parseHostPort(oldProfile.proxyHttps ?? '', 'http');
          fixed.proxyForFtp = Profiles.parseHostPort(oldProfile.proxyFtp ?? '', 'http');
        }
        if (oldProfile.proxyExceptions != null) {
          let hasLocalPattern = false;
          let bypassList: BypassCondition[] = [];
          for (const rawLine of oldProfile.proxyExceptions.split(';')) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line === '<local>') hasLocalPattern = true;
            bypassList.push({ conditionType: 'BypassCondition', pattern: line });
          }
          if (hasLocalPattern) {
            // '<local>' already covers the well-known local hosts; drop the
            // now-redundant explicit entries.
            bypassList = bypassList.filter(
              (cond) => Conditions.localHosts.indexOf(cond.pattern) < 0,
            );
          }
          fixed.bypassList = bypassList;
        }
        profile = fixed;
        break;
      }
    }
    if (!profile) continue;

    profile.color = colorTranslations[oldProfile.color ?? ''] ?? colorTranslations[''];
    let name = (oldProfile.name ?? oldProfile.id ?? '').trim();
    if (name[0] === '_') {
      // A leading underscore is reserved for internal names like __ruleListOf.
      name = 'p' + name;
    }
    profile.name = name;
    let num = 1;
    while (Profiles.byName(profile.name, options)) {
      profile.name = name + num;
      num++;
    }
    if (oldProfile.id !== undefined) nameMap[oldProfile.id] = profile.name;
    Profiles.updateRevision(profile);
    options[Profiles.nameAsKey(profile.name)] = profile;
  }

  if (!seenFixedProfile) {
    // Seed a sample FixedProfile so the options page has one to show, exactly
    // as a fresh install would. The original wrote it under the fixed key
    // '+Example Profile' with no collision check, silently overwriting a
    // converted PacProfile of that name (while nameMap kept pointing rules at
    // it); reuse the collision-avoidance loop instead.
    const baseName = 'Example Profile';
    let exampleName = baseName;
    let num = 1;
    while (Profiles.byName(exampleName, options)) {
      exampleName = baseName + num;
      num++;
    }
    const example: FixedProfile = {
      profileType: 'FixedProfile',
      name: exampleName,
      color: '#99ccee',
      bypassList: [
        { pattern: '127.0.0.1', conditionType: 'BypassCondition' },
        { pattern: '::1', conditionType: 'BypassCondition' },
        { pattern: 'localhost', conditionType: 'BypassCondition' },
      ],
      fallbackProxy: { port: 8080, scheme: 'http', host: 'proxy.example.com' },
    };
    options[Profiles.nameAsKey(exampleName)] = example;
  }

  const startupId = config['startupProfileId'];
  options['-startupProfileName'] = nameMap[String(startupId)] || '';

  const quickSwitch = tryParse(oldOptions['quickSwitchProfiles']) as unknown[] | undefined;
  options['-quickSwitchProfiles'] =
    quickSwitch == null
      ? []
      : // The original kept an `undefined` hole for every id that was not
        // converted (e.g. a profile in 'direct'/'system' mode), which then
        // serialised as null and had to be guarded against downstream. Drop
        // unresolvable ids instead.
        quickSwitch.map((p) => nameMap[String(p)]).filter((n): n is string => n != null);

  if (config['ruleListProfileId']) {
    rulelist.matchProfileName = nameMap[String(config['ruleListProfileId'])] || 'direct';
  }

  const defaultRule = tryParse(oldOptions['defaultRule']) as { profileId?: string } | undefined;
  if (defaultRule) {
    rulelist.defaultProfileName = nameMap[String(defaultRule.profileId)] || 'direct';
    if (!config['ruleListEnabled']) {
      // With the rule list disabled, unmatched requests skip it entirely.
      auto.defaultProfileName = rulelist.defaultProfileName;
    }
  }
  Profiles.updateRevision(rulelist);

  const rules = tryParse(oldOptions['rules']) as Record<string, LegacyRule> | undefined;
  if (rules) {
    const conditionFromRule = (rule: LegacyRule): Condition => {
      switch (rule.patternType) {
        case 'wildcard':
          return RuleList.Switchy.conditionFromLegacyWildcard(rule.urlPattern ?? '');
        default:
          return { conditionType: 'UrlRegexCondition', pattern: rule.urlPattern ?? '' };
      }
    };
    auto.rules = Object.values(rules).map(
      (rule): Rule => ({
        profileName: nameMap[String(rule.profileId)] || 'direct',
        condition: conditionFromRule(rule),
        note: rule.name,
      }),
    );
  }

  return options;
}

export default upgradeLegacyOptions;
