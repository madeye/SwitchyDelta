import { describe, it, expect } from 'vitest';
import { DomainTrie } from '../src/domain-trie.js';
import * as Profiles from '../src/profiles.js';
import * as Conditions from '../src/conditions.js';
import type { Rule, SwitchProfile, Request as PacRequest } from '../src/types.js';

describe('DomainTrie', () => {
  describe('exact match', () => {
    it('should match exact hosts only', () => {
      const trie = new DomainTrie<number>();
      trie.insert('example.com', 1);
      expect(trie.search('example.com')).toBe(1);
      expect(trie.search('www.example.com')).toBeUndefined();
      expect(trie.search('foo.com')).toBeUndefined();
    });
  });

  describe('star wildcard', () => {
    it('should match exactly one label', () => {
      const trie = new DomainTrie<number>();
      trie.insert('*.example.com', 1);
      expect(trie.search('www.example.com')).toBe(1);
      expect(trie.search('foo.example.com')).toBe(1);
      expect(trie.search('example.com')).toBeUndefined();
      expect(trie.search('a.b.example.com')).toBeUndefined();
    });
  });

  describe('dot wildcard', () => {
    it('should match one or more labels under the suffix', () => {
      const trie = new DomainTrie<number>();
      trie.insert('.example.com', 1);
      expect(trie.search('example.com')).toBeUndefined();
      expect(trie.search('www.example.com')).toBe(1);
      expect(trie.search('a.b.example.com')).toBe(1);
    });
  });

  describe('plus wildcard', () => {
    it('should match one or more labels under the suffix', () => {
      const trie = new DomainTrie<number>();
      trie.insert('+.example.com', 1);
      expect(trie.search('www.example.com')).toBe(1);
      expect(trie.search('a.b.example.com')).toBe(1);
      expect(trie.search('example.com')).toBeUndefined();
    });
  });

  describe('priority (search)', () => {
    it('should prefer exact over wildcards', () => {
      const trie = new DomainTrie<number>();
      trie.insert('www.example.com', 1);
      trie.insert('*.example.com', 2);
      trie.insert('.example.com', 3);
      expect(trie.search('www.example.com')).toBe(1);
      expect(trie.search('foo.example.com')).toBe(2);
      expect(trie.search('a.b.example.com')).toBe(3);
    });
  });

  describe('searchMin', () => {
    it('should fold the minimum value across all matching patterns', () => {
      const trie = new DomainTrie<number>();
      trie.insert('+.a.com', 1);
      trie.insert('+.b.a.com', 3);
      trie.insert('x.b.a.com', 7);
      // Most-specific prefers exact/deepest.
      expect(trie.search('x.b.a.com')).toBe(7);
      // Min folds the earliest rule index among all matches.
      expect(trie.searchMin('x.b.a.com')).toBe(1);
      expect(trie.searchMin('y.b.a.com')).toBe(1);
      expect(trie.searchMin('deep.y.b.a.com')).toBe(1);
      expect(trie.searchMin('unrelated.com')).toBeUndefined();
    });

    it('should see star, dot, and exact values', () => {
      const trie = new DomainTrie<number>();
      trie.insert('exact.example.com', 9);
      trie.insert('*.example.com', 4);
      trie.insert('.example.com', 6);
      expect(trie.searchMin('exact.example.com')).toBe(4);
      expect(trie.searchMin('a.b.example.com')).toBe(6);
      expect(trie.searchMin('example.com')).toBeUndefined();
    });
  });

  describe('first-insert-wins', () => {
    it('should keep the first value for the same pattern', () => {
      const trie = new DomainTrie<number>();
      trie.insert('*.example.com', 1);
      trie.insert('*.example.com', 2);
      expect(trie.search('foo.example.com')).toBe(1);
    });
  });

  describe('case insensitivity', () => {
    it('should match regardless of case', () => {
      const trie = new DomainTrie<number>();
      trie.insert('Example.COM', 1);
      expect(trie.search('example.com')).toBe(1);
      expect(trie.search('EXAMPLE.COM')).toBe(1);
    });
  });

  describe('empty trie', () => {
    it('should match nothing', () => {
      const trie = new DomainTrie<number>();
      expect(trie.isEmpty()).toBe(true);
      expect(trie.search('anything.com')).toBeUndefined();
      expect(trie.searchMin('anything.com')).toBeUndefined();
    });
  });
});

describe('DomainTrie integration with profiles', () => {
  describe('_hostPatternToTrieKeys', () => {
    // `hostPatternToTrieKeys` is now exported from src/profiles.ts as a
    // deliberate testing seam, mirroring the CoffeeScript original's
    // `Profiles._hostPatternToTrieKeys`.
    const keys = Profiles.hostPatternToTrieKeys;

    it('should map *.example.com to apex + subdomain keys', () => {
      expect(keys('*.example.com')).toEqual(['example.com', '.example.com']);
    });

    it('should map .example.com like *.', () => {
      expect(keys('.example.com')).toEqual(['example.com', '.example.com']);
    });

    it('should map **.example.com to subdomain-only key', () => {
      expect(keys('**.example.com')).toEqual(['.example.com']);
    });

    it('should map exact domains', () => {
      expect(keys('example.com')).toEqual(['example.com']);
    });

    it('should reject complex patterns', () => {
      expect(keys('*.*example.com')).toBeNull();
      expect(keys('test?.com')).toBeNull();
      expect(keys('*')).toBeNull();
    });
  });

  describe('_buildRulesAnalysis', () => {
    it('should mark simple HostWildcard rules and build the trie', () => {
      const rules: Rule[] = [
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy',
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.test.org' },
          profileName: 'proxy',
        },
      ];
      const result = Profiles.buildRulesAnalysis(rules);
      expect(result.simpleHost[0]).toBe(true);
      expect(result.simpleHost[1]).toBe(true);
      expect(result.domainTrie.isEmpty()).toBe(false);
      expect(result.domainTrie.searchMin('www.example.com')).toBe(0);
      expect(result.domainTrie.searchMin('www.test.org')).toBe(1);
      expect(result.hasNonHostRules).toBe(false);
    });

    it('should detect non-host rules', () => {
      const rules: Rule[] = [
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy',
        },
        {
          condition: { conditionType: 'KeywordCondition', pattern: 'test' },
          profileName: 'proxy',
        },
      ];
      const result = Profiles.buildRulesAnalysis(rules);
      expect(result.simpleHost[0]).toBe(true);
      expect(result.simpleHost[1]).toBe(false);
      expect(result.hasNonHostRules).toBe(true);
    });

    it('should keep complex host patterns on the linear path', () => {
      const rules: Rule[] = [
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.*example.com' },
          profileName: 'proxy',
        },
      ];
      const result = Profiles.buildRulesAnalysis(rules);
      expect(result.simpleHost[0]).toBe(false);
      expect(result.hasNonHostRules).toBe(true);
    });

    it('should not partially insert multi-pattern rules with a complex part', () => {
      const rules: Rule[] = [
        {
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: '*.example.com|*.*other.com',
          },
          profileName: 'proxy',
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy2',
        },
      ];
      const result = Profiles.buildRulesAnalysis(rules);
      expect(result.simpleHost[0]).toBe(false);
      expect(result.simpleHost[1]).toBe(true);
      // Rule 1 owns example.com; rule 0 must not have claimed it.
      expect(result.domainTrie.searchMin('www.example.com')).toBe(1);
    });

    it('should handle multi-pattern simple conditions', () => {
      const rules: Rule[] = [
        {
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: '*.example.com|*.test.org',
          },
          profileName: 'proxy',
        },
      ];
      const result = Profiles.buildRulesAnalysis(rules);
      expect(result.simpleHost[0]).toBe(true);
      expect(result.domainTrie.searchMin('a.example.com')).toBe(0);
      expect(result.domainTrie.searchMin('b.test.org')).toBe(0);
    });

    it('should handle empty rules', () => {
      const result = Profiles.buildRulesAnalysis([]);
      expect(result.domainTrie.isEmpty()).toBe(true);
      expect(result.rules).toHaveLength(0);
    });
  });

  describe('SwitchProfile with domain trie', () => {
    function makeProfile(rules: Rule[], defaultProfile = 'direct'): SwitchProfile {
      const profile = Profiles.create({
        name: 'test',
        profileType: 'SwitchProfile',
        defaultProfileName: defaultProfile,
        rules,
      } as SwitchProfile) as SwitchProfile;
      profile.revision = 'test-rev-' + Math.random();
      return profile;
    }

    function makeRequest(url: string): PacRequest {
      return Conditions.requestFromUrl(url);
    }

    it('should not materialise the trie for compile(), only for match()', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy1',
        },
      ]);
      Profiles.compile(profile);
      const analysis = Profiles.analyze(profile) as Profiles.RulesAnalysis;
      expect(analysis.hostAnalysisBuilt).toBe(false);
      Profiles.match(profile, makeRequest('http://www.example.com/'));
      expect(analysis.hostAnalysisBuilt).toBe(true);
    });

    it('should match domains via the trie', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy1',
        },
      ]);
      let result = Profiles.match(profile, makeRequest('http://www.example.com/'));
      expect((result as Rule).profileName).toBe('proxy1');
      result = Profiles.match(profile, makeRequest('http://example.com/'));
      expect((result as Rule).profileName).toBe('proxy1');
    });

    it('should honor **. subdomain-only patterns', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '**.example.com' },
          profileName: 'proxy1',
        },
      ]);
      let result = Profiles.match(profile, makeRequest('http://www.example.com/'));
      expect((result as Rule).profileName).toBe('proxy1');
      result = Profiles.match(profile, makeRequest('http://example.com/'));
      expect((result as [string, null])[0]).toBe('+direct');
    });

    it('should skip non-matching hosts without linear host checks', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy1',
        },
      ]);
      const result = Profiles.match(profile, makeRequest('http://other.net/'));
      expect((result as [string, null])[0]).toBe('+direct');
    });

    it('should still match non-host rules when host misses the trie', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy1',
        },
        {
          condition: { conditionType: 'KeywordCondition', pattern: 'keyword' },
          profileName: 'proxy2',
        },
      ]);
      const result = Profiles.match(profile, makeRequest('http://other.net/path?keyword'));
      expect((result as Rule).profileName).toBe('proxy2');
    });

    it('should preserve rule priority order', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy1',
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy2',
        },
      ]);
      const result = Profiles.match(profile, makeRequest('http://www.example.com/'));
      expect((result as Rule).profileName).toBe('proxy1');
    });

    it('should let earlier non-host rules win over later host hits', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'KeywordCondition', pattern: 'special' },
          profileName: 'proxy-kw',
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'proxy-host',
        },
      ]);
      const result = Profiles.match(profile, makeRequest('http://www.example.com/special'));
      expect((result as Rule).profileName).toBe('proxy-kw');
    });

    it('should handle complex patterns correctly via linear path', () => {
      const profile = makeProfile([
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.*example.com' },
          profileName: 'proxy1',
        },
      ]);
      const result = Profiles.match(profile, makeRequest('http://www.some-example.com/'));
      expect((result as Rule).profileName).toBe('proxy1');
    });

    it('should handle large rule sets', () => {
      const rules: Rule[] = [];
      for (let i = 0; i < 1000; i++) {
        rules.push({
          condition: { conditionType: 'HostWildcardCondition', pattern: `*.domain${i}.com` },
          profileName: 'proxy',
        });
      }

      const profile = makeProfile(rules);

      let result = Profiles.match(profile, makeRequest('http://www.domain500.com/'));
      expect((result as Rule).profileName).toBe('proxy');

      result = Profiles.match(profile, makeRequest('http://www.nomatch.org/'));
      expect((result as [string, null])[0]).toBe('+direct');
    });
  });
});
