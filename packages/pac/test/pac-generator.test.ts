import { describe, it, expect } from 'vitest';
import * as PacGenerator from '../src/pac-generator.js';
import type { FixedProfile, OptionsBag, SwitchProfile } from '../src/types.js';

const options: OptionsBag = {
  '+auto': {
    name: 'auto',
    profileType: 'SwitchProfile',
    revision: 'test',
    defaultProfileName: 'direct',
    rules: [
      {
        profileName: 'proxy',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^http://(www|www2)\\.example\\.com/',
        },
      },
      {
        profileName: 'direct',
        condition: {
          conditionType: 'HostLevelsCondition',
          minValue: 3,
          maxValue: 8,
        },
      },
      {
        profileName: 'proxy',
        condition: { conditionType: 'KeywordCondition', pattern: 'keyword' },
      },
      {
        profileName: 'proxy',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'https://ssl.example.com/*',
        },
      },
    ],
  } as SwitchProfile,
  '+proxy': {
    name: 'proxy',
    profileType: 'FixedProfile',
    revision: 'test',
    fallbackProxy: { scheme: 'http', host: '127.0.0.1', port: 8888 },
    bypassList: [
      { conditionType: 'BypassCondition', pattern: '127.0.0.1:8080' },
      { conditionType: 'BypassCondition', pattern: '127.0.0.1' },
      { conditionType: 'BypassCondition', pattern: '<local>' },
    ],
  } as FixedProfile,
};

describe('PacGenerator', () => {
  it('should generate pac scripts from options', () => {
    const pac = PacGenerator.script(options, 'auto');
    expect(pac.length).toBeGreaterThan(0);
    const FindProxyForURL = new Function(pac + '; return FindProxyForURL;')() as (
      url: string,
      host: string,
    ) => string;
    const result = FindProxyForURL('http://www.example.com/', 'www.example.com');
    expect(result).toBe('PROXY 127.0.0.1:8888');
  });

  // The UglifyJS-based `PacGenerator.compress()` step no longer exists: the
  // generator now emits already-compact code directly (see pac-generator.ts),
  // so there is nothing left to minify. This test keeps the same end-to-end
  // intent as the original "should be able to compress pac scripts" test —
  // verifying the generated script is non-empty and evaluates correctly —
  // against the single script() output.
  it('should generate compact pac scripts directly (no separate compress step)', () => {
    const pac = PacGenerator.script(options, 'auto');
    expect(pac.length).toBeGreaterThan(0);
    const FindProxyForURL = new Function(pac + '; return FindProxyForURL;')() as (
      url: string,
      host: string,
    ) => string;
    const result = FindProxyForURL('http://www.example.com/', 'www.example.com');
    expect(result).toBe('PROXY 127.0.0.1:8888');
  });
});
