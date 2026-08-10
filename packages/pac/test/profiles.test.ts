import { describe, it, expect } from 'vitest';
import * as Profiles from '../src/profiles.js';
import * as Conditions from '../src/conditions.js';
import type {
  FixedProfile,
  PacProfile,
  Profile,
  Request,
  Rule,
  RuleListProfile,
  SwitchProfile,
} from '../src/types.js';

function ruleListResult(profileName: string, source: string): { profileName: string; source: string } {
  return { profileName, source };
}

/**
 * Evaluate a compiled `Expr`'s code the same way the original test used
 * `eval('(' + compiled.print_to_string() + ')')`: the result may itself be a
 * plain PAC result string, or a function to be invoked with (url, host, scheme).
 */
function evalExpr(expr: { code: string }): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('return (' + expr.code + ');')();
}

/**
 * Mirrors the CoffeeScript `testProfile` helper exactly, including its use of
 * loosely-typed fixtures (`expected` varies in shape across call sites: an
 * array tuple, a Rule-like object, or null).
 */
function testProfile(
  profile: Profile,
  request: Request | string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected: any,
  expectedCompiled?: unknown,
): unknown {
  const oRequest = request;
  const req: Request = typeof request === 'string' ? Conditions.requestFromUrl(request) : request;

  const compiled = Profiles.compile(profile);
  let compileResult: unknown = evalExpr(compiled);
  if (typeof compileResult === 'function') {
    compileResult = (compileResult as (url: string, host: string, scheme: string) => unknown)(
      req.url,
      req.host,
      req.scheme,
    );
  }

  let resolvedExpectedCompiled = expectedCompiled;
  if (resolvedExpectedCompiled === undefined) {
    resolvedExpectedCompiled = expected?.[0] ?? Profiles.nameAsKey(expected?.profileName);
  }

  if (expected !== null && expected !== undefined) {
    const matchResult = Profiles.match(profile, req);
    if (expected.source !== undefined) {
      expect((matchResult as Rule | undefined)?.profileName).toBe(expected.profileName);
      expect((matchResult as Rule | undefined)?.source).toBe(expected.source);
    } else {
      expect(matchResult).toEqual(expected);
    }
  }

  if (compileResult !== resolvedExpectedCompiled) {
    throw new Error(
      `expect COMPILED profile to return ${String(resolvedExpectedCompiled)} instead of ` +
        `${String(compileResult)} for request ${String(oRequest)}`,
    );
  }

  return expected;
}

describe('Profiles', () => {
  describe('#pacResult', () => {
    it('should return DIRECT for no proxy', () => {
      expect(Profiles.pacResult()).toBe('DIRECT');
    });

    it('should return a valid PAC result for a proxy', () => {
      const proxy = { scheme: 'http', host: '127.0.0.1', port: 8888 };
      expect(Profiles.pacResult(proxy)).toBe('PROXY 127.0.0.1:8888');
    });

    it('should return special compatible result for SOCKS5', () => {
      const proxy = { scheme: 'socks5', host: '127.0.0.1', port: 8888 };
      const compatibleResult = 'SOCKS5 127.0.0.1:8888; SOCKS 127.0.0.1:8888';
      expect(Profiles.pacResult(proxy)).toBe(compatibleResult);
    });
  });

  describe('#byName', () => {
    it('should get profiles from builtin profiles', () => {
      const profile = Profiles.byName('direct', {});
      expect(typeof profile).toBe('object');
      expect(profile?.profileType).toBe('DirectProfile');
    });

    it('should get profiles from given options', () => {
      let profile: Profile = {} as Profile;
      profile = Profiles.byName('profile', { '+profile': profile }) as Profile;
      expect(profile).toBe(profile);
    });
  });

  describe('#allReferenceSet', () => {
    const profile = Profiles.create('test', 'VirtualProfile') as SwitchProfile;
    profile.defaultProfileName = 'bogus';

    it('should throw if referenced profile does not exist', () => {
      const getAllReferenceSet = () => Profiles.allReferenceSet(profile, {});
      expect(getAllReferenceSet).toThrow(Error);
    });

    it('should process a dumb profile for each missing profile if requested', () => {
      profile.defaultProfileName = 'bogus';
      const refs = Profiles.allReferenceSet(profile, {}, { profileNotFound: 'dumb' });
      expect(refs['+bogus']).toBe('bogus');
    });
  });

  describe('SystemProfile', () => {
    it('should be builtin with the name "system"', () => {
      const profile = Profiles.byName('system', {});
      expect(typeof profile).toBe('object');
      expect(profile?.profileType).toBe('SystemProfile');
    });

    it('should not match request to profiles', () => {
      const profile = Profiles.byName('system', {}) as Profile;
      expect(Profiles.match(profile, {} as Request)).toBeUndefined();
    });

    it('should throw when trying to compile', () => {
      const profile = Profiles.byName('system', {}) as Profile;
      expect(() => Profiles.compile(profile)).toThrow();
    });
  });

  describe('DirectProfile', () => {
    it('should be builtin with the name "direct"', () => {
      const profile = Profiles.byName('direct', {});
      expect(typeof profile).toBe('object');
      expect(profile?.profileType).toBe('DirectProfile');
    });

    it('should return "DIRECT" when compiled', () => {
      const profile = Profiles.byName('direct', {}) as Profile;
      testProfile(profile, {} as Request, null, 'DIRECT');
    });
  });

  describe('FixedProfile', () => {
    const profile = {
      profileType: 'FixedProfile',
      bypassList: [
        {
          conditionType: 'BypassCondition',
          pattern: '<local>',
        },
      ],
      proxyForHttp: {
        scheme: 'socks4',
        host: '127.0.0.1',
        port: 1234,
      },
      proxyForHttps: {
        scheme: 'http',
        host: '127.0.0.1',
        port: 2345,
      },
      fallbackProxy: {
        scheme: 'socks4',
        host: '127.0.0.1',
        port: 3456,
      },
      auth: {
        proxyForHttps: { username: 'test', password: 'cheesecake' },
      },
    } as unknown as FixedProfile;

    it('should use protocol-specific proxies if suitable', () => {
      testProfile(profile, 'https://www.example.com/', [
        'PROXY 127.0.0.1:2345',
        'https',
        profile.proxyForHttps,
        profile.auth?.proxyForHttps,
      ]);
    });

    it('should use fallback proxies for other protocols', () => {
      testProfile(profile, 'ftp://www.example.com/', [
        'SOCKS 127.0.0.1:3456',
        '',
        profile.fallbackProxy,
        undefined,
      ]);
    });

    it('should not return authentication if not provided for protocol', () => {
      testProfile(profile, 'http://www.example.com/', [
        'SOCKS 127.0.0.1:1234',
        'http',
        profile.proxyForHttp,
        undefined,
      ]);
    });

    it('should not use any proxy for requests matching the bypassList', () => {
      testProfile(profile, 'ftp://localhost/', [
        'DIRECT',
        profile.bypassList?.[0],
        { scheme: 'direct' },
        undefined,
      ]);
    });
  });

  describe('PacProfile', () => {
    const profile = Profiles.create('test', 'PacProfile') as PacProfile;
    profile.pacScript =
      'function FindProxyForURL(url, host) {\n  return "PROXY " + host + ":8080";\n}';

    it('should return the result of the pac script', () => {
      testProfile(profile, 'ftp://www.example.com:9999/abc', null, 'PROXY www.example.com:8080');
    });

    it('should not fail for PAC with trailing comments', () => {
      let p = Profiles.create('test', 'PacProfile') as PacProfile;
      p.pacScript = profile.pacScript + '\n// This is a trailing line comment.\n';
      testProfile(p, 'ftp://www.example.com:9999/abc', null, 'PROXY www.example.com:8080');

      p = Profiles.create('test', 'PacProfile') as PacProfile;
      p.pacScript =
        profile.pacScript + '\n/* This is a multiline comment which is not properly closed.\n';
      testProfile(p, 'ftp://www.example.com:9999/abc', null, 'PROXY www.example.com:8080');
    });

    it('should return includable for non-file pacUrl', () => {
      expect(Profiles.isIncludable(profile)).toBe(true);
    });

    it('should return not includable for file: pacUrl', () => {
      const p = Profiles.create('test', 'PacProfile') as PacProfile;
      p.pacUrl = 'file:///proxy.pac';
      expect(Profiles.isIncludable(p)).toBe(false);
    });
  });

  describe('SwitchProfile', () => {
    const profile = Profiles.create('test', 'SwitchProfile') as SwitchProfile;
    profile.rules = [
      {
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: 'company.abc.example.com',
        },
        profileName: 'company',
      },
      {
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.example.com',
        },
        profileName: 'example',
      },
      {
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.abc.example.com',
        },
        profileName: 'abc',
      },
    ];
    profile.defaultProfileName = 'default';

    it('should match requests based on rules', () => {
      testProfile(profile, 'http://company.abc.example.com:998/abc', profile.rules[0]);
    });

    it('should respect the order of rules', () => {
      testProfile(profile, 'http://abc.example.com:9999/abc', profile.rules[1]);
      testProfile(profile, 'http://www.example.com:9999/abc', profile.rules[1]);
    });

    it('should return defaultProfileName when no rules match', () => {
      testProfile(profile, 'http://www.example.org:9999/abc', ['+default', null]);
    });

    it('should calulate directly referenced profiles correctly', () => {
      const set = Profiles.directReferenceSet(profile);
      expect(set).toEqual({
        '+company': 'company',
        '+example': 'example',
        '+abc': 'abc',
        '+default': 'default',
      });
    });

    it('should clear the reference cache on profile revision change', () => {
      profile.revision = 'a';
      Profiles.directReferenceSet(profile);
      // Remove 'default' from references.
      profile.defaultProfileName = 'abc';
      profile.revision = 'b';
      const newSet = Profiles.directReferenceSet(profile);
      expect(newSet).toEqual({
        '+company': 'company',
        '+example': 'example',
        '+abc': 'abc',
      });
    });

    it('should clear the reference cache if explicitly requested', () => {
      profile.revision = 'a';
      Profiles.directReferenceSet(profile);
      // Remove 'default' from references.
      profile.defaultProfileName = 'abc';
      Profiles.dropCache(profile);
      const newSet = Profiles.directReferenceSet(profile);
      expect(newSet).toEqual({
        '+company': 'company',
        '+example': 'example',
        '+abc': 'abc',
      });
    });
  });

  describe('VirtualProfile', () => {
    const profile = Profiles.create('test', 'VirtualProfile') as SwitchProfile;
    profile.defaultProfileName = 'default';

    it('should always return defaultProfileName', () => {
      testProfile(profile, 'http://www.example.com/abc', ['+default', null]);
    });
  });

  describe('RulelistProfile', () => {
    let profile = Profiles.create('test', 'AutoProxyRuleListProfile') as RuleListProfile;
    profile.defaultProfileName = 'default';
    profile.matchProfileName = 'example';
    profile.ruleList = 'example.com';
    profile.revision = 'a';

    it('should calulate directly referenced profiles correctly', () => {
      const set = Profiles.directReferenceSet(profile);
      expect(set).toEqual({
        '+example': 'example',
        '+default': 'default',
      });
    });

    it('should calulate referenced profiles for rule list with results', () => {
      const set = Profiles.directReferenceSet({
        profileType: 'RuleListProfile',
        format: 'Switchy',
        matchProfileName: 'ignored',
        defaultProfileName: 'alsoIgnored',
        ruleList: `[SwitchyDelta Conditions]
@with result
!*.example.org
*.example.com +ABC
* +DEF`,
      } as RuleListProfile);
      expect(set).toEqual({
        '+ABC': 'ABC',
        '+DEF': 'DEF',
      });
    });

    it('should accept legacy SwitchyOmega rule list headers', () => {
      const set = Profiles.directReferenceSet({
        profileType: 'RuleListProfile',
        format: 'Switchy',
        matchProfileName: 'ignored',
        defaultProfileName: 'alsoIgnored',
        ruleList: `[SwitchyOmega Conditions]
@with result
!*.example.org
*.example.com +ABC
* +DEF`,
      } as RuleListProfile);
      expect(set).toEqual({
        '+ABC': 'ABC',
        '+DEF': 'DEF',
      });
    });

    it('should match requests based on the rule list', () => {
      testProfile(
        profile,
        'http://localhost/example.com',
        ruleListResult('example', 'example.com'),
      );
      testProfile(profile, 'http://localhost/example.org', ['+default', null]);
    });

    it('should update rule list on update', () => {
      Profiles.update(profile, 'example.org');
      profile.revision = 'b';
      testProfile(profile, 'http://localhost/example.com', ['+default', null]);
      testProfile(
        profile,
        'http://localhost/example.org',
        ruleListResult('example', 'example.org'),
      );
    });

    it('should not fail when ruleList is not provided', () => {
      const p = {
        profileType: 'RuleListProfile',
        format: 'Switchy',
        matchProfileName: 'match',
        defaultProfileName: 'default',
      } as RuleListProfile;
      expect(typeof Profiles.directReferenceSet(p)).toBe('object');
      testProfile(p, 'http://localhost/example.com', ['+default', null]);
    });

    it('should switch to AutoProxy format on update if detected', () => {
      profile = Profiles.create('test2', 'RuleListProfile') as RuleListProfile;
      profile.format = 'Switchy';
      profile.defaultProfileName = 'default';
      profile.matchProfileName = 'example';

      expect(profile.format).toBe('Switchy');
      Profiles.update(profile, '[AutoProxy]\nexample.org');
      expect(profile.format).toBe('AutoProxy');

      testProfile(profile, 'http://localhost/example.com', ['+default', null]);
      testProfile(
        profile,
        'http://localhost/example.org',
        ruleListResult('example', 'example.org'),
      );
    });
  });
});
