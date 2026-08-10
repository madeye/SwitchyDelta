import { describe, it, expect } from 'vitest';
import * as RuleList from '../src/rule-list.js';
import type { Rule } from '../src/types.js';

describe('RuleList', () => {
  describe('AutoProxy', () => {
    const parse = RuleList.AutoProxy.parse;

    it('should parse keyword conditions', () => {
      const line = 'example.com';
      const result = parse(line, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: line,
        profileName: 'match',
        condition: {
          conditionType: 'KeywordCondition',
          pattern: 'example.com',
        },
      });
    });

    it('should parse keyword conditions with asterisks', () => {
      const line = 'example*.com';
      const result = parse(line, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: line,
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'http://*example*.com*',
        },
      });
    });

    it('should parse host conditions', () => {
      const line = '||example.com';
      const result = parse(line, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: line,
        profileName: 'match',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.example.com',
        },
      });
    });

    it('should parse "starts-with" conditions', () => {
      const line = '|https://ssl.example.com';
      const result = parse(line, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: line,
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'https://ssl.example.com*',
        },
      });
    });

    it('should parse "starts-with" conditions for the HTTP scheme', () => {
      const line = '|http://example.com';
      const result = parse(line, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: line,
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'http://example.com*',
        },
      });
    });

    it('should parse url regex conditions', () => {
      const line = '/^https?:\\/\\/[^\\/]+example\.com/';
      const result = parse(line, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: line,
        profileName: 'match',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^https?:\\/\\/[^\\/]+example\.com',
        },
      });
    });

    it('should ignore comment lines', () => {
      const result = parse('!example.com', 'match', 'notmatch');
      expect(result).toHaveLength(0);
    });

    it('should parse multiple lines', () => {
      const result = parse('example.com\n!comment\n||example.com', 'match', 'notmatch');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        source: 'example.com',
        profileName: 'match',
        condition: {
          conditionType: 'KeywordCondition',
          pattern: 'example.com',
        },
      });
      expect(result[1]).toEqual({
        source: '||example.com',
        profileName: 'match',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.example.com',
        },
      });
    });

    it('should put exclusive rules first', () => {
      const result = parse('example.com\n@@||example.com', 'match', 'notmatch');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        source: '@@||example.com',
        profileName: 'notmatch',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.example.com',
        },
      });
      expect(result[1]).toEqual({
        source: 'example.com',
        profileName: 'match',
        condition: {
          conditionType: 'KeywordCondition',
          pattern: 'example.com',
        },
      });
    });
  });

  describe('Switchy', () => {
    const parse = RuleList.Switchy.parse;

    function compose(sections: Record<string, string[]>): string {
      let list = '#BEGIN\r\n\r\n';
      for (const [sec, rules] of Object.entries(sections)) {
        list += `[${sec}]\r\n`;
        for (const rule of rules) {
          list += rule;
          list += '\r\n';
        }
      }
      list += '\r\n\r\n#END\r\n';
      return list;
    }

    it('should parse empty rule lists', () => {
      const list = compose({});
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(0);
    });

    it('should ignore stuff before #BEGIN or after #END.', () => {
      let list = compose({});
      list += '[RegExp]\r\ntest\r\n';
      list = '[Wildcard]\r\ntest\r\n' + list;
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(0);
    });

    it('should parse wildcard rules', () => {
      const list = compose({ Wildcard: ['*://example.com/abc/*'] });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: '*://example.com/abc/*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: '*://example.com/abc/*',
        },
      });
    });

    it('should parse RegExp rules', () => {
      const list = compose({ RegExp: ['^http://www\.example\.com/.*'] });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: '^http://www\.example\.com/.*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^http://www\.example\.com/.*',
        },
      });
    });

    it('should parse exclusive rules', () => {
      const list = compose({ RegExp: ['!^http://www\.example\.com/.*'] });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: '!^http://www\.example\.com/.*',
        profileName: 'notmatch',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^http://www\.example\.com/.*',
        },
      });
    });

    it('should parse multiple rules in multiple sections', () => {
      const list = compose({
        Wildcard: ['http://www.example.com/*', 'http://example.com/*'],
        RegExp: ['^http://www\.example\.com/.*', '^http://example\.com/.*'],
      });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        source: 'http://www.example.com/*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'http://www.example.com/*',
        },
      });
      expect(result[1]).toEqual({
        source: 'http://example.com/*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'http://example.com/*',
        },
      });
      expect(result[2]).toEqual({
        source: '^http://www\.example\.com/.*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^http://www\.example\.com/.*',
        },
      });
      expect(result[3]).toEqual({
        source: '^http://example\.com/.*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^http://example\.com/.*',
        },
      });
    });

    it('should put exclusive rules first', () => {
      const list = compose({
        Wildcard: ['http://www\.example\.com/*'],
        RegExp: ['!^http://www\.example\.com/.*'],
      });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        source: '!^http://www\.example\.com/.*',
        profileName: 'notmatch',
        condition: {
          conditionType: 'UrlRegexCondition',
          pattern: '^http://www.example\.com/.*',
        },
      });
      expect(result[1]).toEqual({
        source: 'http://www\.example\.com/*',
        profileName: 'match',
        condition: {
          conditionType: 'UrlWildcardCondition',
          pattern: 'http://www.example.com/*',
        },
      });
    });
  });

  describe('Switchy (omega format)', () => {
    const parse = RuleList.Switchy.parse;
    const compose = RuleList.Switchy.compose;

    it('should parse empty rule lists', () => {
      const list = compose({ rules: [], defaultProfileName: '' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(0);
    });

    it('should ignore comment lines.', () => {
      let list = compose({ rules: [], defaultProfileName: '' });
      list += ';*.example.com \r\n';
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(0);
    });

    it('should compose and parse HostWildcardCondition', () => {
      const rule: Rule = {
        source: '*.example.com',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.example.com',
        },
        profileName: 'match',
      };
      const list = compose({ rules: [rule], defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(rule);
    });

    it('should compose and parse HostRegexCondition', () => {
      const rule: Rule = {
        source: 'HostRegex: ^http://www\.example\.com/.*',
        condition: {
          conditionType: 'HostRegexCondition',
          pattern: '^http://www\.example\.com/.*',
        },
        profileName: 'match',
      };
      const list = compose({ rules: [rule], defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(rule);
    });

    it('should compose and parse disabled rules', () => {
      const rule: Rule = {
        source: 'Disabled: *.example.com',
        condition: {
          conditionType: 'FalseCondition',
          pattern: '*.example.com',
        },
        profileName: 'match',
      };
      const list = compose({ rules: [rule], defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(rule);
    });

    it('should compose and parse exclusive rules', () => {
      const rule: Rule = {
        source: '!*.example.com',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*.example.com',
        },
        profileName: 'notmatch',
      };
      const list = compose({ rules: [rule], defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(rule);
    });

    it('should compose and parse conditions starting with special chars', () => {
      const rule: Rule = {
        source: ': ;abc',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: ';abc',
        },
        profileName: 'match',
      };
      const list = compose({ rules: [rule], defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(rule);
    });

    it('should parse multiple conditions', () => {
      const rules: Rule[] = [
        {
          source: '*.example.com',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: '*.example.com',
          },
          profileName: 'match',
        },
        {
          source: '*.example.org',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: '*.example.org',
          },
          profileName: 'match',
        },
      ];
      const list = compose({ rules, defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toEqual(rules);
    });

    it('should respect the top-down order of conditions', () => {
      const rules: Rule[] = [
        {
          source: 'b.example.com',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: 'b.example.com',
          },
          profileName: 'match',
        },
        {
          source: '!a.example.org',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: 'a.example.org',
          },
          profileName: 'notmatch',
        },
      ];
      const list = compose({ rules, defaultProfileName: 'notmatch' });
      const result = parse(list, 'match', 'notmatch');
      expect(result).toEqual(rules);
    });

    it('should add a default rule when results are enabled', () => {
      const list = compose({ rules: [], defaultProfileName: 'notmatch' }, { withResult: true });
      expect(list.split(/\r|\n/)).toContain('@with result');
      const result = parse(list, 'ignored', 'alsoIgnored');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        source: '*',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*',
        },
        profileName: 'notmatch',
      });
    });

    it('should compose and parse conditions with results', () => {
      const rules: Rule[] = [
        {
          source: 'b.example.com',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: 'b.example.com',
          },
          profileName: 'abc',
        },
        {
          source: 'a.example.org',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: 'a.example.org',
          },
          profileName: 'def',
        },
      ];
      const list = compose({ rules, defaultProfileName: 'ghi' }, { withResult: true });
      const result = parse(list, 'ignored', 'alsoIgnored');
      rules.push({
        source: '*',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*',
        },
        profileName: 'ghi',
      });
      expect(result).toEqual(rules);
    });

    it('should compose and parse exclusive conditions with results', () => {
      const rules: Rule[] = [
        {
          source: '!b.example.com',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: 'b.example.com',
          },
          profileName: 'default profile',
        },
        {
          source: 'a.example.org',
          condition: {
            conditionType: 'HostWildcardCondition',
            pattern: 'a.example.org',
          },
          profileName: 'some profile',
        },
      ];
      const list = compose(
        { rules, defaultProfileName: 'default profile' },
        { withResult: true, useExclusive: true },
      );
      const result = parse(list, 'ignored', 'alsoIgnored');
      rules.push({
        source: '*',
        condition: {
          conditionType: 'HostWildcardCondition',
          pattern: '*',
        },
        profileName: 'default profile',
      });
      expect(result).toEqual(rules);
    });
  });
});
