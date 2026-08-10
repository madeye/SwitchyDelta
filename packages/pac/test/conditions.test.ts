import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as Conditions from '../src/conditions.js';
import type { Condition, Request } from '../src/types.js';

/**
 * Assert that a condition agrees with itself: `match` evaluated in-process and
 * the compiled PAC expression evaluated as real JavaScript must both give
 * `shouldMatch`. This cross-check is the core invariant of the whole module.
 */
function testCond(
  condition: Condition,
  request: string | Partial<Request>,
  shouldMatch: boolean,
): boolean {
  const req = (
    typeof request === 'string' ? Conditions.requestFromUrl(request) : request
  ) as Request;

  const matchResult = Conditions.match(condition, req);

  const expr = Conditions.compile(condition);
  const compiled = new Function('url', 'host', 'scheme', `return (${expr.code});`) as (
    url: string,
    host: string,
    scheme: string,
  ) => unknown;
  const compileResult = !!compiled(req.url, req.host, req.scheme);

  const describeCase = (which: string) =>
    `expected ${which}condition ${JSON.stringify(condition)} ` +
    `${shouldMatch ? 'to match' : 'not to match'} request ${JSON.stringify(request)}`;

  expect(matchResult, describeCase('')).toBe(shouldMatch);
  expect(compileResult, describeCase('COMPILED ')).toBe(shouldMatch);

  return matchResult;
}

/** Evaluate a compiled condition with a stub `isInNet` that always matches. */
function compileWithStubIsInNet(condition: Condition) {
  const expr = Conditions.compile(condition);
  return new Function(
    'url',
    'host',
    'scheme',
    `var isInNet = function () { return true; }; return (${expr.code});`,
  ) as (url: unknown, host: string, scheme?: string) => boolean;
}

describe('Conditions', () => {
  describe('TrueCondition', () => {
    it('should always return true', () => {
      testCond({ conditionType: 'TrueCondition' }, {}, true);
    });
  });

  describe('FalseCondition', () => {
    it('should always return false', () => {
      testCond({ conditionType: 'FalseCondition' }, {}, false);
    });
  });

  describe('UrlRegexCondition', () => {
    const cond: Condition = {
      conditionType: 'UrlRegexCondition',
      pattern: 'example\\.com',
    };
    it('should match requests based on regex pattern', () => {
      testCond(cond, 'http://www.example.com/', true);
    });
    it('should not match requests not matching the pattern', () => {
      testCond(cond, 'http://www.example.net/', false);
    });
    it('should support regex meta chars', () => {
      testCond(
        { conditionType: 'UrlRegexCondition', pattern: 'exam.*\\.com' },
        'http://www.example.com/',
        true,
      );
    });
    it('should fallback to not match if pattern is invalid', () => {
      testCond(
        { conditionType: 'UrlRegexCondition', pattern: ')Invalid(' },
        'http://www.example.com/',
        false,
      );
    });
  });

  describe('UrlWildcardCondition', () => {
    const cond: Condition = {
      conditionType: 'UrlWildcardCondition',
      pattern: '*example.com*',
    };
    it('should match requests based on wildcard pattern', () => {
      testCond(cond, 'http://www.example.com/', true);
    });
    it('should not match requests not matching the pattern', () => {
      testCond(cond, 'http://www.example.net/', false);
    });
    it('should support wildcard question marks', () => {
      testCond(
        { conditionType: 'UrlWildcardCondition', pattern: '*exam???.com*' },
        'http://www.example.com/',
        true,
      );
    });
    it('should not support regex meta chars', () => {
      testCond(
        { conditionType: 'UrlWildcardCondition', pattern: '.*example.com.*' },
        'http://example.com/',
        false,
      );
    });
    it('should support multiple patterns in one condition', () => {
      const multi: Condition = {
        conditionType: 'UrlWildcardCondition',
        pattern: '*.example.com/*|*.example.net/*',
      };
      testCond(multi, 'http://a.example.com/abc', true);
      testCond(multi, 'http://b.example.net/def', true);
      testCond(multi, 'http://c.example.org/ghi', false);
    });
  });

  describe('HostRegexCondition', () => {
    const cond: Condition = {
      conditionType: 'HostRegexCondition',
      pattern: '.*\\.example\\.com',
    };
    it('should match requests based on regex pattern', () => {
      testCond(cond, 'http://www.example.com/', true);
    });
    it('should not match requests not matching the pattern', () => {
      testCond(cond, 'http://example.com/', false);
    });
    it('should not match URL parts other than the host', () => {
      expect(testCond(cond, 'http://example.net/www.example.com', false)).toBe(false);
    });
  });

  describe('HostWildcardCondition', () => {
    const cond: Condition = {
      conditionType: 'HostWildcardCondition',
      pattern: '*.example.com',
    };
    it('should match requests based on wildcard pattern', () => {
      testCond(cond, 'http://www.example.com/', true);
    });
    it('should also match hostname without the optional level', () => {
      // https://github.com/FelisCatus/SwitchyOmega/wiki/Host-wildcard-condition
      testCond(cond, 'http://example.com/', true);
    });
    it('should process patterns like *.*example.com correctly', () => {
      // https://github.com/FelisCatus/SwitchyOmega/issues/158
      const con: Condition = {
        conditionType: 'HostWildcardCondition',
        pattern: '*.*example.com',
      };
      testCond(con, 'http://example.com/', true);
      testCond(con, 'http://www.example.com/', true);
      testCond(con, 'http://www.some-example.com/', true);
      testCond(con, 'http://xample.com/', false);
    });
    it('should allow override of the magical behavior', () => {
      const con: Condition = {
        conditionType: 'HostWildcardCondition',
        pattern: '**.example.com',
      };
      testCond(con, 'http://www.example.com/', true);
      testCond(con, 'http://example.com/', false);
    });
    it('should not match URL parts other than the host', () => {
      expect(testCond(cond, 'http://example.net/www.example.com', false)).toBe(false);
    });
    it('should support multiple patterns in one condition', () => {
      const multi: Condition = {
        conditionType: 'HostWildcardCondition',
        pattern: '*.example.com|*.example.net',
      };
      testCond(multi, 'http://a.example.com/abc', true);
      testCond(multi, 'http://example.net/def', true);
      testCond(multi, 'http://c.example.org/ghi', false);
    });
  });

  describe('BypassCondition', () => {
    // See https://developer.chrome.com/docs/extensions/reference/api/proxy
    it('should correctly support patterns containing hosts', () => {
      testCond(
        { conditionType: 'BypassCondition', pattern: '.example.com' },
        'http://www.example.com/',
        true,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: '.example.com' },
        'http://example.com/',
        false,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: '*.example.com' },
        'http://www.example.com/',
        true,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: '*.example.com' },
        'http://example.com/',
        false,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: 'example.com' },
        'http://example.com/',
        true,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: 'example.com' },
        'http://www.example.com/',
        false,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: '*example.com' },
        'http://example.com/',
        true,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: '*example.com' },
        'http://www.example.com/',
        true,
      );
      testCond(
        { conditionType: 'BypassCondition', pattern: '*example.com' },
        'http://anotherexample.com/',
        true,
      );
    });

    it('should match the scheme specified in the pattern', () => {
      const cond: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'http://example.com',
      };
      testCond(cond, 'http://example.com/', true);
      testCond(cond, 'https://example.com/', false);
    });

    it('should match the port specified in the pattern', () => {
      const cond: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'http://example.com:8080',
      };
      testCond(cond, 'http://example.com:8080/', true);
      testCond(cond, 'http://example.com:888/', false);
    });

    it('should correctly support patterns using IPv4 literals', () => {
      const cond: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'http://127.0.0.1:8080',
      };
      testCond(cond, 'http://127.0.0.1:8080/', true);
      testCond(cond, 'http://127.0.0.2:8080/', false);
    });

    it('should correctly support IPv6 canonicalization', () => {
      const cond: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'http://[0:0::1]:8080',
      };
      testCond(cond, 'http://[::1]:8080/', true);
      testCond(cond, 'http://[1::1]:8080/', false);
    });

    it('should correctly support IPv6 canonicalization 2', () => {
      const cond: Condition = { conditionType: 'BypassCondition', pattern: '[::1]' };
      testCond(cond, 'http://[::1]:8080/', true);
      testCond(cond, 'http://[1::1]:8080/', false);
    });

    it('should parse IPv4 CIDR notation', () => {
      const cond: Condition = {
        conditionType: 'BypassCondition',
        pattern: '192.168.0.0/16',
      };
      const result = Conditions.analyze(cond) as { ip: unknown };
      expect(result.ip).toBeTruthy();
      expect(result.ip).toEqual({
        conditionType: 'IpCondition',
        ip: '192.168.0.0',
        prefixLength: 16,
      });
    });

    it('should parse IPv6 CIDR notation', () => {
      const cond: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'fefe:13::abc/33',
      };
      const result = Conditions.analyze(cond) as { ip: unknown };
      expect(result.ip).toBeTruthy();
      expect(result.ip).toEqual({
        conditionType: 'IpCondition',
        ip: 'fefe:13::abc',
        prefixLength: 33,
      });
    });

    it('should parse IPv6 CIDR notation with zero prefixLength', () => {
      const cond: Condition = { conditionType: 'BypassCondition', pattern: '::/0' };
      const result = Conditions.analyze(cond) as { ip: unknown };
      expect(result.ip).toBeTruthy();
      expect(result.ip).toEqual({
        conditionType: 'IpCondition',
        ip: '::',
        prefixLength: 0,
      });
    });

    it('should match 127.0.0.1 when <local> is used', () => {
      testCond(
        { conditionType: 'BypassCondition', pattern: '<local>' },
        'http://127.0.0.1:8080/',
        true,
      );
    });

    it('should match [::1] when <local> is used', () => {
      testCond(
        { conditionType: 'BypassCondition', pattern: '<local>' },
        'http://[::1]:8080/',
        true,
      );
    });

    it('should match any host without dots when <local> is used', () => {
      const cond: Condition = { conditionType: 'BypassCondition', pattern: '<local>' };
      testCond(cond, 'http://localhost:8080/', true);
      testCond(cond, 'http://intranet:8080/', true);
      testCond(cond, 'http://foobar/', true);
      testCond(cond, 'http://example.com/', false);

      // Intended: see the reasoning in the BypassCondition <local> handler.
      testCond(cond, 'http://[::ffff:eeee]/', true);

      // Behavior change from the CoffeeScript version. The old implementation
      // parsed URLs with Node's legacy `url.parse`, which left `::1.2.3.4`
      // untouched, so the embedded-IPv4 dots made this NOT match. Requests are
      // now parsed with the WHATWG `URL`, which canonicalises the host to
      // `::102:304` — exactly what Chrome passes to a PAC script — so it has no
      // dots and does match. The new result reflects real browser behavior.
      testCond(cond, 'http://[::1.2.3.4]/', true);
    });
  });

  describe('IpCondition', () => {
    // IpCondition compiles to isInNet/isInNetEx, which the PAC runner provides
    // and the unit test does not, so testCond cannot be used directly here.
    it('should support IPv4 subnet', () => {
      const cond: Condition = {
        conditionType: 'IpCondition',
        ip: '192.168.1.1',
        prefixLength: 16,
      };
      const request = Conditions.requestFromUrl('http://192.168.4.4/');
      expect(Conditions.match(cond, request)).toBe(true);
      expect(Conditions.compile(cond).code).toContain(
        'isInNet(host,"192.168.1.1","255.255.0.0")',
      );
    });

    it('should support IPv6 subnet', () => {
      const cond: Condition = {
        conditionType: 'IpCondition',
        ip: 'fefe:13::abc',
        prefixLength: 33,
      };
      const request = Conditions.requestFromUrl('http://[fefe:13::def]/');
      expect(Conditions.match(cond, request)).toBe(true);

      const compiled = Conditions.compile(cond).code;
      expect(compiled).toContain('isInNet(host,"fefe:13::abc","ffff:ffff:8000::")');
      expect(compiled).toContain('isInNetEx(host,"fefe:13::abc/33")');
    });

    it('should support IPv6 subnet with zero prefixLength', () => {
      const cond: Condition = {
        conditionType: 'IpCondition',
        ip: '::',
        prefixLength: 0,
      };
      const request = Conditions.requestFromUrl('http://[fefe:13::def]/');
      expect(Conditions.match(cond, request)).toBe(true);
      expect(Conditions.compile(cond).code.indexOf('indexOf(')).toBeGreaterThan(0);
    });

    it('should not match domain name to IP subnet', () => {
      const cond: Condition = {
        conditionType: 'IpCondition',
        ip: '::',
        prefixLength: 0,
      };
      const request = Conditions.requestFromUrl('http://www.example.com/');
      expect(Conditions.match(cond, request)).toBe(false);
    });

    it('should not pass domain name to isInNet function', () => {
      const ipToCompiledFunc = (ip: string, prefixLength: number) =>
        compileWithStubIsInNet({ conditionType: 'IpCondition', ip, prefixLength });

      let compiledFunc = ipToCompiledFunc('0.0.0.0', 0);
      expect(compiledFunc(null, 'www.example.com')).toBe(false);
      expect(compiledFunc(null, '127.0.0.1')).toBe(true);

      compiledFunc = ipToCompiledFunc('0.0.0.0', 1);
      expect(compiledFunc(null, 'www.example.com')).toBe(false);
      expect(compiledFunc(null, '127.0.0.1')).toBe(true);

      compiledFunc = ipToCompiledFunc('::', 0);
      expect(compiledFunc(null, 'www.example.com')).toBe(false);
      expect(compiledFunc(null, '::1')).toBe(true);

      compiledFunc = ipToCompiledFunc('::', 1);
      expect(compiledFunc(null, 'www.example.com')).toBe(false);
      expect(compiledFunc(null, '::1')).toBe(true);
    });
  });

  describe('KeywordCondition', () => {
    const cond: Condition = {
      conditionType: 'KeywordCondition',
      pattern: 'example.com',
    };
    it('should match requests based on substring', () => {
      testCond(cond, 'http://www.example.com/', true);
      testCond(cond, 'http://www.example.net/', false);
    });
    it('should not match HTTPS requests', () => {
      testCond(cond, 'https://example.com/', false);
      testCond(cond, 'https://example.net/', false);
    });
  });

  describe('WeekdayCondition', () => {
    beforeAll(() => {
      vi.useFakeTimers();
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    // Feb 2016 calendar used by these fixtures:
    // Su Mo Tu We Th Fr Sa
    // .. 01 02 03 04 05 06
    // 07 08 09 10 11 12 13
    const testCondDay = (cond: Condition, day: number, shouldMatch: boolean) => {
      const date = day > 0 ? day : 7;
      vi.setSystemTime(new Date(`2016-02-0${date}T00:00:00Z`));
      testCond(cond, `http://weekday-${day}/`, shouldMatch);
    };

    it('should match requests based on date range', () => {
      const cond: Condition = {
        conditionType: 'WeekdayCondition',
        startDay: 3,
        endDay: 5,
      };
      testCondDay(cond, 0, false);
      testCondDay(cond, 1, false);
      testCondDay(cond, 2, false);
      testCondDay(cond, 3, true);
      testCondDay(cond, 4, true);
      testCondDay(cond, 5, true);
      testCondDay(cond, 6, false);
    });

    it('should match the day if startDay == endDay', () => {
      const cond: Condition = {
        conditionType: 'WeekdayCondition',
        startDay: 3,
        endDay: 3,
      };
      testCondDay(cond, 0, false);
      testCondDay(cond, 1, false);
      testCondDay(cond, 2, false);
      testCondDay(cond, 3, true);
      testCondDay(cond, 4, false);
      testCondDay(cond, 5, false);
      testCondDay(cond, 6, false);
    });

    it('should not match anything if startDay > endDay', () => {
      const cond: Condition = {
        conditionType: 'WeekdayCondition',
        startDay: 4,
        endDay: 3,
      };
      for (let day = 0; day <= 6; day++) {
        testCondDay(cond, day, false);
      }
    });

    it('should match according to .days', () => {
      let cond: Condition = { conditionType: 'WeekdayCondition', days: 'SMTWtFs' };
      for (let day = 0; day <= 6; day++) {
        testCondDay(cond, day, true);
      }

      cond = { conditionType: 'WeekdayCondition', days: 'S-TW-F-' };
      testCondDay(cond, 0, true);
      testCondDay(cond, 1, false);
      testCondDay(cond, 2, true);
      testCondDay(cond, 3, true);
      testCondDay(cond, 4, false);
      testCondDay(cond, 5, true);
      testCondDay(cond, 6, false);
    });

    it('should prefer .days to .startDay and .endDay', () => {
      const cond: Condition = {
        conditionType: 'WeekdayCondition',
        days: '--TW---',
        startDay: 0,
        endDay: 0,
      };
      testCondDay(cond, 0, false);
      testCondDay(cond, 1, false);
      testCondDay(cond, 2, true);
      testCondDay(cond, 3, true);
      testCondDay(cond, 4, false);
      testCondDay(cond, 5, false);
      testCondDay(cond, 6, false);
    });
  });

  describe('TimeCondition', () => {
    beforeAll(() => {
      vi.useFakeTimers();
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    // RFC 2822 format keeps these in the local time zone; ISO-8601 would be
    // interpreted as UTC.
    const testCondTime = (cond: Condition, time: string, shouldMatch: boolean) => {
      vi.setSystemTime(new Date(`01 Feb 2016 ${time}`));
      // Colons are not legal in a host, so they are dropped here. The URL is
      // arbitrary for a TimeCondition; it only has to be a parseable one.
      testCond(cond, `http://time-${time.replace(/:/g, '')}/`, shouldMatch);
    };

    it('should match requests based on hour range', () => {
      const cond: Condition = {
        conditionType: 'TimeCondition',
        startHour: 7,
        endHour: 9,
      };
      testCondTime(cond, '00:00:00', false);
      testCondTime(cond, '06:00:00', false);
      testCondTime(cond, '07:00:00', true);
      testCondTime(cond, '08:00:00', true);
      testCondTime(cond, '09:00:00', true);
      testCondTime(cond, '09:59:59', true);
      testCondTime(cond, '10:00:00', false);
      testCondTime(cond, '19:00:00', false);
      testCondTime(cond, '23:00:00', false);
    });

    it('should match the hour if startHour == endHour', () => {
      const cond: Condition = {
        conditionType: 'TimeCondition',
        startHour: 7,
        endHour: 7,
      };
      testCondTime(cond, '00:00:00', false);
      testCondTime(cond, '06:00:00', false);
      testCondTime(cond, '07:00:00', true);
      testCondTime(cond, '07:00:01', true);
      testCondTime(cond, '07:59:59', true);
      testCondTime(cond, '08:00:00', false);
      testCondTime(cond, '19:00:00', false);
    });

    it('should not match anything if startHour > endHour', () => {
      const cond: Condition = {
        conditionType: 'TimeCondition',
        startHour: 7,
        endHour: 6,
      };
      for (const time of [
        '00:00:00',
        '06:00:00',
        '06:59:59',
        '07:00:00',
        '08:00:00',
        '09:00:00',
        '10:00:00',
        '19:00:00',
        '23:00:00',
      ]) {
        testCondTime(cond, time, false);
      }
    });
  });

  describe('#typeFromAbbr', () => {
    it('should get condition types by abbrs', () => {
      expect(Conditions.typeFromAbbr('True')).toBe('TrueCondition');
      expect(Conditions.typeFromAbbr('HR')).toBe('HostRegexCondition');
    });
  });

  describe('#str and #fromStr', () => {
    it('should encode & decode TrueCondition correctly', () => {
      const condition: Condition = { conditionType: 'TrueCondition' };
      const result = Conditions.str(condition);
      expect(result).toBe('True:');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode conditions with pattern correctly', () => {
      const condition: Condition = {
        conditionType: 'UrlWildcardCondition',
        pattern: '*://*.example.com/*',
      };
      const result = Conditions.str(condition);
      expect(result).toBe('UrlWildcard: ' + condition.pattern);
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode False while preserving pattern', () => {
      const condition: Condition = {
        conditionType: 'FalseCondition',
        pattern: 'a b c',
      };
      const result = Conditions.str(condition);
      expect(result).toBe('Disabled: a b c');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode FalseCondition without any pattern', () => {
      const condition: Condition = { conditionType: 'FalseCondition' };
      const result = Conditions.str(condition);
      expect(result).toBe('Disabled:');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode HostWildcardCondition using shorthand syntax', () => {
      const condition: Condition = {
        conditionType: 'HostWildcardCondition',
        pattern: '*.example.com',
      };
      const result = Conditions.str(condition);
      expect(result).toBe(condition.pattern);
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode HostWildcardCondition ending with colon', () => {
      const condition: Condition = {
        conditionType: 'HostWildcardCondition',
        pattern: 'bogus:',
      };
      const result = Conditions.str(condition);
      expect(result).toBe('HostWildcard: ' + condition.pattern);
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode BypassCondition correctly', () => {
      const condition: Condition = {
        conditionType: 'BypassCondition',
        pattern: '127.0.0.1/16',
      };
      const result = Conditions.str(condition);
      expect(result).toBe('Bypass: 127.0.0.1/16');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should add brackets for IPv6 hosts in BypassCondition', () => {
      const condition: Condition = { conditionType: 'BypassCondition', pattern: '::1' };
      const result = Conditions.str(condition);
      expect(result).toBe('Bypass: [::1]');
      const cond = Conditions.fromStr(result)!;
      expect(cond.conditionType).toBe('BypassCondition');
      expect((cond as { pattern: string }).pattern).toBe('[::1]');
    });

    it('should add brackets for IPv6 hosts with scheme in BypassCondition', () => {
      const condition: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'http://::1',
      };
      const result = Conditions.str(condition);
      expect(result).toBe('Bypass: http://[::1]');
      const cond = Conditions.fromStr(result)!;
      expect(cond.conditionType).toBe('BypassCondition');
      expect((cond as { pattern: string }).pattern).toBe('http://[::1]');
    });

    it('should preserve the scheme of a host pattern in BypassCondition', () => {
      // Regression test for a bug in the CoffeeScript implementation, which
      // overwrote the accumulated normalized pattern instead of appending to it
      // and so silently dropped the scheme from hostname patterns.
      const condition: Condition = {
        conditionType: 'BypassCondition',
        pattern: 'http://*.example.com',
      };
      expect(Conditions.str(condition)).toBe('Bypass: http://*.example.com');
    });

    it('should encode & decode IpCondition correctly', () => {
      const condition: Condition = {
        conditionType: 'IpCondition',
        ip: '127.0.0.1',
        prefixLength: 16,
      };
      const result = Conditions.str(condition);
      expect(result).toBe('Ip: 127.0.0.1/16');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should provide sensible fallbacks for invalid IpCondition', () => {
      expect(Conditions.fromStr('Ip: foo/-233')).toEqual({
        conditionType: 'IpCondition',
        ip: '0.0.0.0',
        prefixLength: 0,
      });
      expect(Conditions.fromStr('Ip: nonsense stuff')).toEqual({
        conditionType: 'IpCondition',
        ip: '0.0.0.0',
        prefixLength: 0,
      });
    });

    it('should assume full match for IpCondition without prefixLength', () => {
      expect(Conditions.fromStr('Ip: 127.0.0.1')).toEqual({
        conditionType: 'IpCondition',
        ip: '127.0.0.1',
        prefixLength: 32,
      });
      expect(Conditions.fromStr('Ip: ::1')).toEqual({
        conditionType: 'IpCondition',
        ip: '::1',
        prefixLength: 128,
      });
    });

    it('should provide sensible fallbacks for negative prefixLength', () => {
      expect(Conditions.fromStr('Ip: 0.0.0.0/-233')).toEqual({
        conditionType: 'IpCondition',
        ip: '0.0.0.0',
        prefixLength: 0,
      });
    });

    it('should encode & decode HostLevelsCondition correctly', () => {
      const condition: Condition = {
        conditionType: 'HostLevelsCondition',
        minValue: 4,
        maxValue: 7,
      };
      const result = Conditions.str(condition);
      expect(result).toBe('HostLevels: 4~7');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should provide sensible fallbacks for HostLevels out of range', () => {
      expect(Conditions.fromStr('HostLevels: A~-1')).toEqual({
        conditionType: 'HostLevelsCondition',
        minValue: 1,
        maxValue: 1,
      });
      expect(Conditions.fromStr('HostLevels: nonsense')).toEqual({
        conditionType: 'HostLevelsCondition',
        minValue: 1,
        maxValue: 1,
      });
    });

    it('should encode & decode WeekdayCondition correctly', () => {
      const condition: Condition = {
        conditionType: 'WeekdayCondition',
        startDay: 3,
        endDay: 6,
      };
      const result = Conditions.str(condition);
      expect(result).toBe('Weekday: 3~6');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should provide sensible fallbacks for Weekday out of range', () => {
      expect(Conditions.fromStr('Weekday: -1~100')).toEqual({
        conditionType: 'WeekdayCondition',
        startDay: 0,
        endDay: 0,
      });
      expect(Conditions.fromStr('Weekday: nonsense')).toEqual({
        conditionType: 'WeekdayCondition',
        startDay: 0,
        endDay: 0,
      });
    });

    it('should encode & decode WeekdayCondition with days', () => {
      let condition: Condition = { conditionType: 'WeekdayCondition', days: 'SMTWtFs' };
      let result = Conditions.str(condition);
      expect(result).toBe('Weekday: SMTWtFs');
      expect(Conditions.fromStr(result)).toEqual(condition);

      condition = { conditionType: 'WeekdayCondition', days: 'SM-W-Fs' };
      result = Conditions.str(condition);
      expect(result).toBe('Weekday: SM-W-Fs');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should encode & decode TimeCondition correctly', () => {
      const condition: Condition = {
        conditionType: 'TimeCondition',
        startHour: 7,
        endHour: 23,
      };
      const result = Conditions.str(condition);
      expect(result).toBe('Hour: 7~23');
      expect(Conditions.fromStr(result)).toEqual(condition);
    });

    it('should provide sensible fallbacks for Hour out of range', () => {
      expect(Conditions.fromStr('Hour: -1~100')).toEqual({
        conditionType: 'TimeCondition',
        startHour: 0,
        endHour: 0,
      });
      expect(Conditions.fromStr('Hour: nonsense')).toEqual({
        conditionType: 'TimeCondition',
        startHour: 0,
        endHour: 0,
      });
    });

    it('should parse conditions with extra spaces correctly', () => {
      expect(Conditions.fromStr('url:    *abcde*   ')).toEqual({
        conditionType: 'UrlWildcardCondition',
        pattern: '*abcde*',
      });
    });

    it('should parse abbreviated condition types correctly', () => {
      expect(Conditions.fromStr('url: *://*.example.com/*')).toEqual({
        conditionType: 'UrlWildcardCondition',
        pattern: '*://*.example.com/*',
      });
    });

    it('should parse escaped HostWildcardCondition starting with colon', () => {
      expect(Conditions.fromStr(': :bogus:')).toEqual({
        conditionType: 'HostWildcardCondition',
        pattern: ':bogus:',
      });
    });
  });
});
