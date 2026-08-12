/**
 * Covers the SwitchySharp options importer. There was no CoffeeScript suite
 * for upgrade.coffee; these tests pin the ported behaviour, including the two
 * fixes made during the port (the synthetic 'Example Profile' no longer
 * clobbers a converted profile of the same name, and quick-switch entries for
 * unconverted profile ids are dropped instead of becoming undefined holes).
 */
import { describe, expect, it } from 'vitest';
import type {
  FixedProfile,
  PacProfile,
  RuleListProfile,
  SwitchProfile,
} from '@switchydelta/pac';
import { upgradeLegacyOptions } from '../src/upgrade-legacy.js';
import type { DeltaOptions } from '../src/options.js';

const i18n = { upgrade_profile_auto: 'Auto Switch' };

function upgrade(oldOptions: Record<string, unknown>): DeltaOptions {
  const result = upgradeLegacyOptions(oldOptions, i18n);
  expect(result).not.toBeNull();
  return result!;
}

/** A minimal but complete SwitchySharp storage bag. */
function legacyOptions(
  config: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { config: JSON.stringify(config), ...extra };
}

describe('upgradeLegacyOptions', () => {
  it('should return null when there is no parseable config', () => {
    expect(upgradeLegacyOptions({}, i18n)).toBeNull();
    expect(upgradeLegacyOptions({ config: 'not json{' }, i18n)).toBeNull();
    expect(upgradeLegacyOptions({ config: 'null' }, i18n)).toBeNull();
  });

  it('should map the boolean settings and the download interval', () => {
    const options = upgrade(
      legacyOptions({
        confirmDeletion: true,
        refreshTab: 1,
        quickSwitch: false,
        ruleListReload: '60',
      }),
    );
    expect(options['schemaVersion']).toBe(2);
    expect(options['-confirmDeletion']).toBe(true);
    expect(options['-refreshOnProfileChange']).toBe(true);
    expect(options['-enableQuickSwitch']).toBe(false);
    expect(options['-revertProxyChanges']).toBe(false);
    expect(options['-downloadInterval']).toBe(60);
  });

  it('should default the download interval to 15', () => {
    expect(upgrade(legacyOptions())['-downloadInterval']).toBe(15);
    expect(upgrade(legacyOptions({ ruleListReload: 'never' }))['-downloadInterval']).toBe(15);
    expect(upgrade(legacyOptions({ ruleListReload: '0' }))['-downloadInterval']).toBe(15);
  });

  it('should create the auto switch profile backed by a rule list profile', () => {
    const options = upgrade(legacyOptions({ ruleListUrl: 'http://example.com/list.txt' }));
    const auto = options['+Auto Switch'] as SwitchProfile;
    expect(auto).toBeTruthy();
    expect(auto.profileType).toBe('SwitchProfile');
    expect(auto.color).toBe('#55bb55');
    expect(auto.revision).toBeTruthy();

    const rulelist = options['+__ruleListOf_Auto Switch'] as RuleListProfile;
    expect(rulelist).toBeTruthy();
    expect(rulelist.profileType).toBe('RuleListProfile');
    expect(rulelist.format).toBe('Switchy');
    expect(rulelist.sourceUrl).toBe('http://example.com/list.txt');
    expect(rulelist.defaultProfileName).toBe('direct');
    expect(rulelist.revision).toBeTruthy();

    expect(auto.defaultProfileName).toBe(rulelist.name);
  });

  it('should use the AutoProxy format when ruleListAutoProxy is set', () => {
    const options = upgrade(legacyOptions({ ruleListAutoProxy: true }));
    const rulelist = options['+__ruleListOf_Auto Switch'] as RuleListProfile;
    expect(rulelist.format).toBe('AutoProxy');
  });

  describe('profiles', () => {
    it('should convert an auto profile with a plain url to a PacProfile', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              pac: {
                id: 'pac',
                name: 'My PAC',
                proxyMode: 'auto',
                proxyConfigUrl: 'http://example.com/proxy.pac',
                color: 'green',
              },
            }),
          },
        ),
      );
      const profile = options['+My PAC'] as PacProfile;
      expect(profile.profileType).toBe('PacProfile');
      expect(profile.pacUrl).toBe('http://example.com/proxy.pac');
      expect(profile.color).toBe('#99dd99');
      expect(profile.revision).toBeTruthy();
    });

    it('should decode a base64 data: url into a pacScript', () => {
      const script = 'function FindProxyForURL(url, host) { return "DIRECT"; }';
      const dataUrl = 'data:application/x-ns-proxy-autoconfig;base64,' + btoa(script);
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              pac: { id: 'pac', name: 'Inline', proxyMode: 'auto', proxyConfigUrl: dataUrl },
            }),
          },
        ),
      );
      const profile = options['+Inline'] as PacProfile;
      expect(profile.pacScript).toBe(script);
      expect(profile.pacUrl).toBeUndefined();
    });

    it('should convert a manual profile with useSameProxy to a single fallback proxy', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: {
                id: 'p1',
                name: 'Proxy',
                proxyMode: 'manual',
                useSameProxy: true,
                proxyHttp: '127.0.0.1:8080',
                proxyHttps: 'ignored:1',
              },
            }),
          },
        ),
      );
      const profile = options['+Proxy'] as FixedProfile;
      expect(profile.profileType).toBe('FixedProfile');
      expect(profile.fallbackProxy).toEqual({ scheme: 'http', host: '127.0.0.1', port: 8080 });
      expect(profile.proxyForHttp).toBeUndefined();
      expect(profile.proxyForHttps).toBeUndefined();
    });

    it.each([
      [5, 'socks5'],
      [4, 'socks4'],
      [undefined, 'socks4'],
    ])('should map socksVersion %s to %s', (socksVersion, scheme) => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: {
                id: 'p1',
                name: 'Socks',
                proxyMode: 'manual',
                proxySocks: 'localhost:1080',
                socksVersion,
              },
            }),
          },
        ),
      );
      const profile = options['+Socks'] as FixedProfile;
      expect(profile.fallbackProxy).toEqual({ scheme, host: 'localhost', port: 1080 });
    });

    it('should convert per-scheme proxies when useSameProxy is off', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: {
                id: 'p1',
                name: 'PerScheme',
                proxyMode: 'manual',
                proxyHttp: 'a:1',
                proxyHttps: 'b:2',
                proxyFtp: 'c:3',
              },
            }),
          },
        ),
      );
      const profile = options['+PerScheme'] as FixedProfile;
      expect(profile.fallbackProxy).toBeUndefined();
      expect(profile.proxyForHttp).toEqual({ scheme: 'http', host: 'a', port: 1 });
      expect(profile.proxyForHttps).toEqual({ scheme: 'http', host: 'b', port: 2 });
      expect(profile.proxyForFtp).toEqual({ scheme: 'http', host: 'c', port: 3 });
    });

    it('should parse the bypass list from proxyExceptions', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: {
                id: 'p1',
                name: 'Proxy',
                proxyMode: 'manual',
                useSameProxy: true,
                proxyHttp: 'a:1',
                proxyExceptions: ' *.example.com ; ;10.0.0.0/8',
              },
            }),
          },
        ),
      );
      const profile = options['+Proxy'] as FixedProfile;
      expect(profile.bypassList).toEqual([
        { conditionType: 'BypassCondition', pattern: '*.example.com' },
        { conditionType: 'BypassCondition', pattern: '10.0.0.0/8' },
      ]);
    });

    it('should drop explicit local hosts when <local> is present', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: {
                id: 'p1',
                name: 'Proxy',
                proxyMode: 'manual',
                useSameProxy: true,
                proxyHttp: 'a:1',
                proxyExceptions: 'localhost;127.0.0.1;[::1];<local>;*.example.com',
              },
            }),
          },
        ),
      );
      const profile = options['+Proxy'] as FixedProfile;
      expect(profile.bypassList!.map((c) => c.pattern)).toEqual(['<local>', '*.example.com']);
    });

    it('should keep the default bypass list when proxyExceptions is absent', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: { id: 'p1', name: 'Proxy', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'a:1' },
            }),
          },
        ),
      );
      const profile = options['+Proxy'] as FixedProfile;
      expect(profile.bypassList!.map((c) => c.pattern)).toEqual([
        '127.0.0.1',
        '[::1]',
        'localhost',
      ]);
    });

    it('should skip profiles in unconvertible modes', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              d: { id: 'd', name: 'Direct-ish', proxyMode: 'direct' },
            }),
          },
        ),
      );
      expect(options['+Direct-ish']).toBeUndefined();
    });

    it('should prefix names starting with an underscore', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: { id: 'p1', name: '_hidden', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'a:1' },
            }),
          },
        ),
      );
      expect(options['+p_hidden']).toBeTruthy();
    });

    it('should resolve name collisions by appending a number', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: { id: 'p1', name: 'Proxy', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'a:1' },
              p2: { id: 'p2', name: ' Proxy ', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'b:2' },
              p3: { id: 'p3', name: 'Proxy', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'c:3' },
            }),
          },
        ),
      );
      expect((options['+Proxy'] as FixedProfile).fallbackProxy!.host).toBe('a');
      expect((options['+Proxy1'] as FixedProfile).fallbackProxy!.host).toBe('b');
      expect((options['+Proxy2'] as FixedProfile).fallbackProxy!.host).toBe('c');
    });
  });

  describe('example profile', () => {
    it('should synthesize an Example Profile when no fixed profile was seen', () => {
      const options = upgrade(legacyOptions());
      const example = options['+Example Profile'] as FixedProfile;
      expect(example).toBeTruthy();
      expect(example.profileType).toBe('FixedProfile');
      expect(example.fallbackProxy).toEqual({
        scheme: 'http',
        host: 'proxy.example.com',
        port: 8080,
      });
      expect(example.bypassList!.map((c) => c.pattern)).toEqual([
        '127.0.0.1',
        '::1',
        'localhost',
      ]);
    });

    it('should not synthesize one when a fixed profile exists', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: { id: 'p1', name: 'Proxy', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'a:1' },
            }),
          },
        ),
      );
      expect(options['+Example Profile']).toBeUndefined();
    });

    it('should not clobber a converted profile named Example Profile', () => {
      // The CoffeeScript importer overwrote the converted PacProfile here.
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              pac: {
                id: 'pac',
                name: 'Example Profile',
                proxyMode: 'auto',
                proxyConfigUrl: 'http://example.com/proxy.pac',
              },
            }),
          },
        ),
      );
      expect((options['+Example Profile'] as PacProfile).profileType).toBe('PacProfile');
      expect((options['+Example Profile1'] as FixedProfile).profileType).toBe('FixedProfile');
    });
  });

  describe('references', () => {
    const storage = (config: Record<string, unknown>, extra: Record<string, unknown>) =>
      legacyOptions(config, {
        profiles: JSON.stringify({
          p1: { id: 'p1', name: 'Proxy', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'a:1' },
        }),
        ...extra,
      });

    it('should resolve the startup profile through the name map', () => {
      expect(upgrade(storage({ startupProfileId: 'p1' }, {}))['-startupProfileName']).toBe('Proxy');
      expect(upgrade(storage({ startupProfileId: 'auto' }, {}))['-startupProfileName']).toBe(
        'Auto Switch',
      );
      expect(upgrade(storage({ startupProfileId: 'gone' }, {}))['-startupProfileName']).toBe('');
      expect(upgrade(storage({}, {}))['-startupProfileName']).toBe('');
    });

    it('should map quick switch profiles, dropping unresolvable ids', () => {
      const options = upgrade(
        storage({}, { quickSwitchProfiles: JSON.stringify(['p1', 'direct', 'gone']) }),
      );
      expect(options['-quickSwitchProfiles']).toEqual(['Proxy', 'direct']);
    });

    it('should default quick switch profiles to an empty list', () => {
      expect(upgrade(storage({}, {}))['-quickSwitchProfiles']).toEqual([]);
    });

    it('should resolve the rule list match profile', () => {
      const options = upgrade(storage({ ruleListProfileId: 'p1' }, {}));
      const rulelist = options['+__ruleListOf_Auto Switch'] as RuleListProfile;
      expect(rulelist.matchProfileName).toBe('Proxy');
    });

    it('should apply the default rule to the rule list default', () => {
      const options = upgrade(
        storage({ ruleListEnabled: true }, { defaultRule: JSON.stringify({ profileId: 'p1' }) }),
      );
      const rulelist = options['+__ruleListOf_Auto Switch'] as RuleListProfile;
      const auto = options['+Auto Switch'] as SwitchProfile;
      expect(rulelist.defaultProfileName).toBe('Proxy');
      // The rule list stays in the fallthrough path when enabled.
      expect(auto.defaultProfileName).toBe(rulelist.name);
    });

    it('should bypass the rule list when it is disabled', () => {
      const options = upgrade(
        storage({ ruleListEnabled: false }, { defaultRule: JSON.stringify({ profileId: 'p1' }) }),
      );
      const auto = options['+Auto Switch'] as SwitchProfile;
      expect(auto.defaultProfileName).toBe('Proxy');
    });
  });

  describe('rules', () => {
    it('should convert wildcard and regexp rules', () => {
      const options = upgrade(
        legacyOptions(
          {},
          {
            profiles: JSON.stringify({
              p1: { id: 'p1', name: 'Proxy', proxyMode: 'manual', useSameProxy: true, proxyHttp: 'a:1' },
            }),
            rules: JSON.stringify({
              r1: { name: 'wild', patternType: 'wildcard', urlPattern: '*://*.example.com/*', profileId: 'p1' },
              r2: { name: 'url', patternType: 'wildcard', urlPattern: 'example.com', profileId: 'p1' },
              r3: { name: 're', patternType: 'regexp', urlPattern: 'example\\.com', profileId: 'gone' },
            }),
          },
        ),
      );
      const auto = options['+Auto Switch'] as SwitchProfile;
      expect(auto.rules).toEqual([
        {
          profileName: 'Proxy',
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          note: 'wild',
        },
        {
          profileName: 'Proxy',
          // Bare legacy wildcards get '*' affixes and stay URL wildcards.
          condition: { conditionType: 'UrlWildcardCondition', pattern: '*example.com*' },
          note: 'url',
        },
        {
          profileName: 'direct',
          condition: { conditionType: 'UrlRegexCondition', pattern: 'example\\.com' },
          note: 're',
        },
      ]);
    });

    it('should leave the auto profile without rules when none are stored', () => {
      const auto = upgrade(legacyOptions())['+Auto Switch'] as SwitchProfile;
      expect(auto.rules).toEqual([]);
    });
  });
});
