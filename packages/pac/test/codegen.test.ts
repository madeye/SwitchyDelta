import { describe, it, expect } from 'vitest';
import { binary, ref, num, str } from '../src/codegen.js';
import * as PacGenerator from '../src/pac-generator.js';
import * as Profiles from '../src/profiles.js';
import * as Conditions from '../src/conditions.js';
import type { FixedProfile, OptionsBag, SwitchProfile } from '../src/types.js';

describe('codegen', () => {
  it('parenthesises a negative numeric right operand of subtraction', () => {
    const expr = binary('-', ref('x'), num(-1));
    expect(expr.code).toBe('x-(-1)');
    const fn = new Function('x', `return (${expr.code});`) as (x: number) => number;
    expect(fn(5)).toBe(5 - -1);
    expect(fn(5)).toBe(6);
  });
});

function evalStringLiteral(literal: string): string {
  return new Function(`return (${literal});`)() as string;
}

function evalPac(script: string): (url: string, host: string) => string {
  return new Function(script + '; return FindProxyForURL;')() as (
    url: string,
    host: string,
  ) => string;
}

/** Walk the in-process profile chain to the leaf PAC result string. */
function inProcessPacResult(options: OptionsBag, profileName: string, url: string): string {
  const req = Conditions.requestFromUrl(url);
  let profile = Profiles.byName(profileName, options);
  const visited = new Set<string>();
  let last: string | undefined;
  while (profile) {
    const key = Profiles.nameAsKey(profile);
    if (visited.has(key)) break;
    visited.add(key);
    const result = Profiles.match(profile, req);
    if (result == null) break;
    if (Array.isArray(result)) {
      const next = result[0];
      if (typeof next !== 'string') break;
      // PAC compilation maps the builtin +direct key to the DIRECT result.
      if (next === '+direct' || next === 'DIRECT') return 'DIRECT';
      last = next;
      if (next.charCodeAt(0) !== 43 /* + */) return next;
      profile = Profiles.byKey(next, options);
    } else if (result.profileName) {
      last = result.profileName;
      profile = Profiles.byName(result.profileName, options);
    } else {
      break;
    }
  }
  return last ?? 'DIRECT';
}

function bagWithNamedProxy(name: string): OptionsBag {
  return {
    '+auto': {
      name: 'auto',
      profileType: 'SwitchProfile',
      revision: 'test',
      defaultProfileName: 'direct',
      rules: [
        {
          profileName: name,
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
        },
      ],
    } satisfies SwitchProfile,
    ['+' + name]: {
      name,
      profileType: 'FixedProfile',
      revision: 'test',
      fallbackProxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
    } satisfies FixedProfile,
  };
}

describe('codegen str() / PAC injection', () => {
  const names = [
    'quo"te',
    'back\\slash',
    'new\nline',
    'car\rriage',
    'tab\there',
    'café',
    '名字',
    'line\u2028sep',
    'para\u2029sep',
  ];

  it('emits a JS string literal that round-trips every special character', () => {
    for (const value of names) {
      const literal = str(value);
      expect(literal.startsWith('"') && literal.endsWith('"')).toBe(true);
      expect(evalStringLiteral(literal)).toBe(value);
      // PAC is handed to the browser with no declared encoding.
      expect(/[^\x00-\x7F]/.test(literal)).toBe(false);
    }
  });

  it.each(names)(
    'generates valid PAC for a profile named %j whose match agrees with in-process',
    (name) => {
      const options = bagWithNamedProxy(name);
      const pac = PacGenerator.script(options, 'auto');
      expect(/[^\x00-\x7F]/.test(pac)).toBe(false);

      const FindProxyForURL = evalPac(pac);
      const hit = 'http://www.example.com/';
      const miss = 'http://other.test/';
      expect(FindProxyForURL(hit, 'www.example.com')).toBe(
        inProcessPacResult(options, 'auto', hit),
      );
      expect(FindProxyForURL(hit, 'www.example.com')).toBe('PROXY proxy.example.com:8080');
      expect(FindProxyForURL(miss, 'other.test')).toBe(inProcessPacResult(options, 'auto', miss));
      expect(FindProxyForURL(miss, 'other.test')).toBe('DIRECT');
    },
  );
});
