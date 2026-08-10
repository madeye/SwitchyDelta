/**
 * Condition matching and PAC compilation.
 *
 * Every condition type provides `match` (evaluated in-process) and `compile`
 * (emitted into the generated PAC script). The two must agree; the test suite
 * asserts that for every fixture.
 */

import * as g from './codegen.js';
import { escapeSlash, safeRegExp, shExp2RegExp } from './shexp.js';
import { AttachedCache, unbracket } from './utils.js';
import { formatIp, isInSubnet, netmask, parseIp, subnetSuffix, type IpAddress } from './ip.js';
import type {
  Condition,
  ConditionType,
  HostLevelsCondition,
  IpCondition,
  KeywordCondition,
  PatternCondition,
  Request,
  TimeCondition,
  WeekdayCondition,
} from './types.js';

const CHAR_COLON = ':'.charCodeAt(0);
const CHAR_DOT = '.'.charCodeAt(0);

/** Hosts that Chromium's `<local>` bypass token covers. */
export const localHosts: readonly string[] = ['127.0.0.1', '[::1]', 'localhost'];

interface AnalysisCache {
  analyzed: unknown;
  compiled?: g.Expr;
}

interface Handler<C extends Condition = Condition, A = unknown> {
  abbrs: string[];
  analyze(condition: C): A;
  match(condition: C, request: Request, analyzed: A): boolean;
  compile(condition: C, analyzed: A): g.Expr;
  str?(condition: C): string;
  fromStr?(text: string, condition: { conditionType: ConditionType }): Condition | null;
  tag?(condition: C): string;
}

// --- Public API -------------------------------------------------------------

/** Build a matcher request from a URL string or parsed URL. */
export function requestFromUrl(url: string | URL): Request {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return {
    url: parsed.href,
    // PAC passes `host` unbracketed, so IPv6 literals are normalised to match.
    host: unbracket(parsed.hostname),
    scheme: parsed.protocol.replace(':', ''),
  };
}

/**
 * Reduce a `*://host/*` URL wildcard to the bare host wildcard, or undefined
 * when the pattern is not of that shape.
 */
export function urlWildcard2HostWildcard(pattern: string): string | undefined {
  const result = /^\*:\/\/((?:\w|[?*._\-])+)\/\*$/.exec(pattern);
  return result?.[1];
}

export function tag(condition: Condition): string {
  return condCache.tag(condition) as string;
}

export function analyze(condition: Condition): unknown {
  return getCache(condition).analyzed;
}

export function match(condition: Condition, request: Request): boolean {
  const cache = getCache(condition);
  const handler = handlerFor(condition.conditionType);
  return handler.match(condition, request, cache.analyzed);
}

export function compile(condition: Condition): g.Expr {
  const cache = getCache(condition);
  if (cache.compiled !== undefined) return cache.compiled;
  const handler = handlerFor(condition.conditionType);
  cache.compiled = handler.compile(condition, cache.analyzed);
  return cache.compiled;
}

export interface StrOptions {
  /**
   * Which abbreviation to use. A number indexes into the type's abbreviation
   * list (negative counts from the end, the default -1 being the longest,
   * most readable form). A non-number uses the full condition type name.
   */
  abbr?: number | boolean;
}

/** Render a condition as a single rule-list line. */
export function str(condition: Condition, options: StrOptions = { abbr: -1 }): string {
  const handler = handlerFor(condition.conditionType);
  const abbr = options.abbr ?? -1;

  // Host wildcards have an empty abbreviation, so a plain pattern needs no
  // prefix at all — unless it would be ambiguous with a typed line.
  if (handler.abbrs[0]!.length === 0) {
    const pattern = (condition as PatternCondition).pattern;
    const endCode = pattern.charCodeAt(pattern.length - 1);
    if (endCode !== CHAR_COLON && pattern.indexOf(' ') < 0) {
      return pattern;
    }
  }

  const typeStr =
    typeof abbr === 'number'
      ? handler.abbrs[(handler.abbrs.length + abbr) % handler.abbrs.length]!
      : condition.conditionType;

  const part = handler.str ? handler.str(condition) : (condition as PatternCondition).pattern;
  return part ? `${typeStr}: ${part}` : `${typeStr}:`;
}

/** Parse a rule-list line back into a condition, or null if unrecognised. */
export function fromStr(text: string): Condition | null {
  let rest = text.trim();
  let i = rest.indexOf(' ');
  if (i < 0) i = rest.length;

  let typeName: string;
  if (rest.charCodeAt(i - 1) === CHAR_COLON) {
    typeName = rest.substring(0, i - 1);
    rest = rest.substring(i + 1).trim();
  } else {
    typeName = '';
  }

  const conditionType = typeFromAbbr(typeName);
  if (!conditionType) return null;

  const handler = handlerFor(conditionType);
  if (handler.fromStr) {
    return handler.fromStr(rest, { conditionType });
  }
  return { conditionType, pattern: rest } as Condition;
}

let abbrIndex: Map<string, ConditionType> | null = null;

/** Resolve an abbreviation (case-insensitive) to a condition type. */
export function typeFromAbbr(abbr: string): ConditionType | undefined {
  if (abbrIndex === null) {
    abbrIndex = new Map();
    for (const [type, handler] of Object.entries(handlers) as Array<[ConditionType, Handler]>) {
      abbrIndex.set(type.toUpperCase(), type);
      for (const ab of handler.abbrs) {
        abbrIndex.set(ab.toUpperCase(), type);
      }
    }
  }
  return abbrIndex.get(abbr.toUpperCase());
}

/** The seven-day enabled flags of a weekday condition. */
export function getWeekdayList(condition: WeekdayCondition): boolean[] {
  const result: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    if (condition.days) {
      result.push(condition.days.charCodeAt(i) > 64);
    } else {
      result.push((condition.startDay ?? 0) <= i && i <= (condition.endDay ?? 0));
    }
  }
  return result;
}

export { parseIp };

/** Canonical text form of a parsed address. */
export function normalizeIp(address: IpAddress): string {
  return formatIp(address);
}

// --- Internals --------------------------------------------------------------

const condCache = new AttachedCache<Condition, AnalysisCache>((condition) => {
  const handler = handlerFor(condition.conditionType);
  const result = handler.tag ? handler.tag(condition) : str(condition);
  return condition.conditionType + '$' + result;
});

function getCache(condition: Condition): AnalysisCache {
  return condCache.get(condition, () => ({
    analyzed: handlerFor(condition.conditionType).analyze(condition),
  }));
}

function handlerFor(conditionType: ConditionType | Condition): Handler {
  const name = typeof conditionType === 'string' ? conditionType : conditionType.conditionType;
  const handler = (handlers as Record<string, Handler | undefined>)[name];
  if (handler === undefined) throw new Error(`Unknown condition type: ${name}`);
  return handler;
}

/**
 * A numeric range test, specialised for compactness.
 *
 * A single value collapses to `===`, an empty range to `false`, and a short
 * integer range to a character-table lookup, which is both shorter and faster
 * than two comparisons in the PAC interpreter.
 */
function between(value: g.Expr, min: number, max: number): g.Expr {
  if (min === max) {
    return g.binary('===', value, g.num(min));
  }
  if (min > max) {
    return g.FALSE;
  }
  if (Number.isInteger(min) && Number.isInteger(max) && max - min < 32) {
    const template = '0123456789abcdefghijklmnopqrstuvwxyz';
    const table =
      max < template.length
        ? template.substring(min, max + 1)
        : template.substring(0, max - min + 1);
    const pos = min === 0 ? value : g.binary('-', value, g.num(min));
    return g.binary('>', g.call(g.member(g.string(table), 'charCodeAt'), [pos]), g.num(0));
  }
  return g.and([g.binary('<=', g.num(min), value), g.binary('<=', value, g.num(max))]);
}

interface BypassAnalysis {
  host: string | RegExp | null;
  ip: IpCondition | null;
  scheme: string | null;
  url: RegExp | null;
  port: string | null;
  normalizedPattern: string;
}

interface IpAnalysis {
  addr: IpAddress;
  normalized: string;
  mask: string;
}

const handlers = {
  TrueCondition: {
    abbrs: ['True'],
    analyze: () => null,
    match: () => true,
    compile: () => g.TRUE,
    str: () => '',
    fromStr: (_text, condition) => condition as Condition,
  } satisfies Handler<Condition, null>,

  FalseCondition: {
    abbrs: ['False', 'Disabled'],
    analyze: () => null,
    match: () => false,
    compile: () => g.FALSE,
    fromStr: (text, condition) => {
      if (text.length > 0) {
        (condition as PatternCondition).pattern = text;
      }
      return condition as Condition;
    },
  } satisfies Handler<Condition, null>,

  UrlRegexCondition: {
    abbrs: ['UR', 'URegex', 'UrlR', 'UrlRegex'],
    analyze: (condition) => safeRegExp(escapeSlash(condition.pattern)),
    match: (_condition, request, analyzed) => analyzed.test(request.url),
    compile: (_condition, analyzed) => g.regexTest('url', analyzed),
  } satisfies Handler<PatternCondition, RegExp>,

  UrlWildcardCondition: {
    abbrs: ['U', 'UW', 'Url', 'UrlW', 'UWild', 'UWildcard', 'UrlWild', 'UrlWildcard'],
    analyze: (condition) => {
      const parts = condition.pattern
        .split('|')
        .filter((pattern) => pattern)
        .map((pattern) => shExp2RegExp(pattern, { trimAsterisk: true }));
      return safeRegExp(parts.join('|'));
    },
    match: (_condition, request, analyzed) => analyzed.test(request.url),
    compile: (_condition, analyzed) => g.regexTest('url', analyzed),
  } satisfies Handler<PatternCondition, RegExp>,

  HostRegexCondition: {
    abbrs: ['R', 'HR', 'Regex', 'HostR', 'HRegex', 'HostRegex'],
    analyze: (condition) => safeRegExp(escapeSlash(condition.pattern)),
    match: (_condition, request, analyzed) => analyzed.test(request.host),
    compile: (_condition, analyzed) => g.regexTest('host', analyzed),
  } satisfies Handler<PatternCondition, RegExp>,

  HostWildcardCondition: {
    abbrs: [
      '',
      'H',
      'W',
      'HW',
      'Wild',
      'Wildcard',
      'Host',
      'HostW',
      'HWild',
      'HWildcard',
      'HostWild',
      'HostWildcard',
    ],
    analyze: (condition) => {
      const parts = condition.pattern
        .split('|')
        .filter((pattern) => pattern)
        .map((pattern) => hostWildcardToRegExpSource(pattern));
      return safeRegExp(parts.join('|'));
    },
    match: (_condition, request, analyzed) => analyzed.test(request.host),
    compile: (_condition, analyzed) => g.regexTest('host', analyzed),
  } satisfies Handler<PatternCondition, RegExp>,

  BypassCondition: {
    abbrs: ['B', 'Bypass'],
    // See https://developer.chrome.com/docs/extensions/reference/api/proxy
    analyze: (condition): BypassAnalysis => analyzeBypass(condition.pattern),
    match: (_condition, request, analyzed) => {
      if (analyzed.scheme !== null && analyzed.scheme !== request.scheme) return false;
      if (analyzed.ip !== null && !match(analyzed.ip, request)) return false;
      if (analyzed.host !== null) {
        if (analyzed.host === '<local>') {
          // Align with Chromium, which bypasses 127.0.0.1, ::1 and any host
          // without dots. Note this also matches IPv6 literals, which have none.
          return (
            request.host === '127.0.0.1' ||
            request.host === '::1' ||
            request.host.indexOf('.') < 0
          );
        }
        if (!(analyzed.host as RegExp).test(request.host)) return false;
      }
      if (analyzed.url !== null && !analyzed.url.test(request.url)) return false;
      return true;
    },
    str: (condition) => {
      const analyzed = analyzeBypass(condition.pattern);
      return analyzed.normalizedPattern || condition.pattern;
    },
    compile: (_condition, analyzed) => {
      if (analyzed.url !== null) {
        return g.regexTest('url', analyzed.url);
      }
      if (analyzed.host === '<local>') {
        const hostEquals = (host: string) => g.binary('===', g.ref('host'), g.string(host));
        return g.or([
          hostEquals('127.0.0.1'),
          hostEquals('::1'),
          g.binary('<', g.call(g.member(g.ref('host'), 'indexOf'), [g.string('.')]), g.num(0)),
        ]);
      }
      const conditions: g.Expr[] = [];
      if (analyzed.scheme !== null) {
        conditions.push(g.binary('===', g.ref('scheme'), g.string(analyzed.scheme)));
      }
      if (analyzed.host !== null) {
        conditions.push(g.regexTest('host', analyzed.host as RegExp));
      } else if (analyzed.ip !== null) {
        conditions.push(compile(analyzed.ip));
      }
      return g.and(conditions);
    },
  } satisfies Handler<PatternCondition, BypassAnalysis>,

  KeywordCondition: {
    abbrs: ['K', 'KW', 'Keyword'],
    analyze: () => null,
    match: (condition, request) =>
      request.scheme === 'http' && request.url.indexOf(condition.pattern) >= 0,
    compile: (condition) =>
      g.and([
        g.binary('===', g.ref('scheme'), g.string('http')),
        g.binary(
          '>=',
          g.call(g.member(g.ref('url'), 'indexOf'), [g.string(condition.pattern)]),
          g.num(0),
        ),
      ]),
  } satisfies Handler<KeywordCondition, null>,

  IpCondition: {
    abbrs: ['Ip'],
    analyze: (condition): IpAnalysis => {
      const ip = unbracket(condition.ip);
      const text = `${ip}/${condition.prefixLength}`;
      const addr = parseIp(text);
      if (addr === null) throw new Error(`Invalid IP address ${text}`);
      return { addr, normalized: formatIp(addr), mask: formatIp(netmask(addr)) };
    },
    match: (_condition, request, analyzed) => {
      const addr = parseIp(request.host);
      if (addr === null) return false;
      if (addr.v4 !== analyzed.addr.v4) return false;
      return isInSubnet(addr, analyzed.addr);
    },
    compile: (_condition, analyzed) => {
      // Guard isInNet with a cheap syntactic check so that a hostname never
      // reaches it — that would trigger a blocking DNS lookup.
      const hostLooksLikeIp = analyzed.addr.v4
        ? // A trailing digit is a good enough proxy for "is an IPv4 literal".
          g.binary(
            '>=',
            g.index(g.ref('host'), g.binary('-', g.member(g.ref('host'), 'length'), g.num(1))),
            g.num(0),
          )
        : // Likewise, a colon means "is an IPv6 literal".
          g.binary('>=', g.call(g.member(g.ref('host'), 'indexOf'), [g.string(':')]), g.num(0));

      if (analyzed.addr.prefixLength === 0) {
        // 0.0.0.0/0 or ::/0 — matches every literal of that family, so the
        // syntactic check alone is both sufficient and cheaper than isInNet.
        return hostLooksLikeIp;
      }

      let hostIsInNet: g.Expr = g.call(g.ref('isInNet'), [
        g.ref('host'),
        g.string(analyzed.normalized),
        g.string(analyzed.mask),
      ]);

      if (!analyzed.addr.v4) {
        // isInNetEx takes a prefix directly and is the only correct option for
        // IPv6, but it is not universally available.
        const hostIsInNetEx = g.call(g.ref('isInNetEx'), [
          g.ref('host'),
          g.string(analyzed.normalized + subnetSuffix(analyzed.addr)),
        ]);
        hostIsInNet = g.conditional(
          g.binary('===', g.unary('typeof', g.ref('isInNetEx')), g.string('function')),
          hostIsInNetEx,
          hostIsInNet,
        );
      }

      return g.and([hostLooksLikeIp, hostIsInNet]);
    },
    str: (condition) => `${condition.ip}/${condition.prefixLength}`,
    fromStr: (text, condition) => {
      const target = condition as unknown as IpCondition;
      const addr = parseIp(text);
      if (addr !== null) {
        target.ip = formatIp(addr);
        target.prefixLength = addr.prefixLength;
      } else {
        target.ip = '0.0.0.0';
        target.prefixLength = 0;
      }
      return target;
    },
  } satisfies Handler<IpCondition, IpAnalysis>,

  HostLevelsCondition: {
    abbrs: ['Lv', 'Level', 'Levels', 'HL', 'HLv', 'HLevel', 'HLevels', 'HostL', 'HostLv', 'HostLevel', 'HostLevels'],
    analyze: () => null,
    match: (condition, request) => {
      let dotCount = 0;
      for (let i = 0; i < request.host.length; i++) {
        if (request.host.charCodeAt(i) === CHAR_DOT) {
          dotCount++;
          if (dotCount > condition.maxValue) return false;
        }
      }
      return dotCount >= condition.minValue;
    },
    compile: (condition) => {
      const value = g.member(g.call(g.member(g.ref('host'), 'split'), [g.string('.')]), 'length');
      return between(value, condition.minValue + 1, condition.maxValue + 1);
    },
    str: (condition) => `${condition.minValue}~${condition.maxValue}`,
    fromStr: (text, condition) => {
      const target = condition as unknown as HostLevelsCondition;
      const [minValue, maxValue] = text.split('~');
      target.minValue = parseInt(minValue ?? '', 10);
      target.maxValue = parseInt(maxValue ?? '', 10);
      if (!(target.minValue > 0)) target.minValue = 1;
      if (!(target.maxValue > 0)) target.maxValue = 1;
      return target;
    },
  } satisfies Handler<HostLevelsCondition, null>,

  WeekdayCondition: {
    abbrs: ['WD', 'Week', 'Day', 'Weekday'],
    analyze: () => null,
    match: (condition) => {
      const day = new Date().getDay();
      if (condition.days) return condition.days.charCodeAt(day) > 64;
      return (condition.startDay ?? 0) <= day && day <= (condition.endDay ?? 0);
    },
    compile: (condition) => {
      const getDay = g.call(g.member(g.construct(g.ref('Date')), 'getDay'));
      if (condition.days) {
        return g.binary(
          '>',
          g.call(g.member(g.string(condition.days), 'charCodeAt'), [getDay]),
          g.num(64),
        );
      }
      return between(getDay, condition.startDay ?? 0, condition.endDay ?? 0);
    },
    str: (condition) =>
      condition.days ? condition.days : `${condition.startDay}~${condition.endDay}`,
    fromStr: (text, condition) => {
      const target = condition as unknown as WeekdayCondition;
      if (text.indexOf('~') < 0 && text.length === 7) {
        target.days = text;
      } else {
        const [startDay, endDay] = text.split('~');
        target.startDay = parseInt(startDay ?? '', 10);
        target.endDay = parseInt(endDay ?? '', 10);
        if (!(target.startDay >= 0 && target.startDay <= 6)) target.startDay = 0;
        if (!(target.endDay >= 0 && target.endDay <= 6)) target.endDay = 0;
      }
      return target;
    },
  } satisfies Handler<WeekdayCondition, null>,

  TimeCondition: {
    abbrs: ['T', 'Time', 'Hour'],
    analyze: () => null,
    match: (condition) => {
      const hour = new Date().getHours();
      return condition.startHour <= hour && hour <= condition.endHour;
    },
    compile: (condition) => {
      const getHours = g.call(g.member(g.construct(g.ref('Date')), 'getHours'));
      return between(getHours, condition.startHour, condition.endHour);
    },
    str: (condition) => `${condition.startHour}~${condition.endHour}`,
    fromStr: (text, condition) => {
      const target = condition as unknown as TimeCondition;
      const [startHour, endHour] = text.split('~');
      target.startHour = parseInt(startHour ?? '', 10);
      target.endHour = parseInt(endHour ?? '', 10);
      if (!(target.startHour >= 0 && target.startHour < 24)) target.startHour = 0;
      if (!(target.endHour >= 0 && target.endHour < 24)) target.endHour = 0;
      return target;
    },
  } satisfies Handler<TimeCondition, null>,
} as const;

/**
 * Host wildcard patterns carry extra magic beyond plain globbing:
 *   .example.com  is shorthand for *.example.com
 *   *.example.com matches the apex domain as well as any subdomain
 *   **.example.com matches subdomains only, never the apex
 * See the Host-wildcard-condition wiki page for the full rationale.
 */
function hostWildcardToRegExpSource(pattern: string): string {
  let source = pattern;
  if (source.charCodeAt(0) === CHAR_DOT) {
    source = '*' + source;
  }
  if (source.indexOf('**.') === 0) {
    return shExp2RegExp(source.substring(1), { trimAsterisk: true });
  }
  if (source.indexOf('*.') === 0) {
    return shExp2RegExp(source.substring(2), { trimAsterisk: false })
      .replace(/./, '(?:^|\\.)')
      .replace(/\.\*\$$/, '');
  }
  return shExp2RegExp(source, { trimAsterisk: true });
}

function analyzeBypass(pattern: string): BypassAnalysis {
  const cache: BypassAnalysis = {
    host: null,
    ip: null,
    scheme: null,
    url: null,
    port: null,
    normalizedPattern: '',
  };

  let server = pattern;
  if (server === '<local>') {
    cache.host = server;
    return cache;
  }

  const schemeParts = server.split('://');
  if (schemeParts.length > 1) {
    cache.scheme = schemeParts[0]!;
    cache.normalizedPattern = cache.scheme + '://';
    server = schemeParts[1]!;
  }

  const slashParts = server.split('/');
  if (slashParts.length > 1) {
    const addr = parseIp(slashParts[0]!);
    const prefixLength = parseInt(slashParts[1]!, 10);
    if (addr !== null && !Number.isNaN(prefixLength)) {
      cache.ip = {
        conditionType: 'IpCondition',
        ip: formatIp(addr),
        prefixLength,
      };
      cache.normalizedPattern += `${cache.ip.ip}/${cache.ip.prefixLength}`;
      return cache;
    }
  }

  // The server may be an IP literal with or without brackets, and with or
  // without a port.
  let matchPort: string | undefined;
  let serverIp = parseIp(server);
  if (serverIp === null) {
    const pos = server.lastIndexOf(':');
    if (pos >= 0) {
      matchPort = server.substring(pos + 1);
      server = server.substring(0, pos);
    }
    serverIp = parseIp(server);
  }

  if (serverIp !== null) {
    server = formatIp(serverIp);
    cache.normalizedPattern += serverIp.v4 ? server : `[${server}]`;
  } else {
    if (server.charCodeAt(0) === CHAR_DOT) {
      server = '*' + server;
    }
    // Note: the CoffeeScript original assigned here instead of appending,
    // which silently dropped the scheme from patterns like
    // `http://*.example.com` when rendered back to text.
    cache.normalizedPattern += server;
  }

  if (matchPort) {
    cache.port = matchPort;
    cache.normalizedPattern += ':' + cache.port;
    // Inside a URL, IPv6 literals must be bracketed.
    const urlServer = serverIp !== null && !serverIp.v4 ? `[${server}]` : server;
    let serverRegex = shExp2RegExp(urlServer);
    serverRegex = serverRegex.substring(1, serverRegex.length - 1);
    const scheme = cache.scheme ?? '[^:]+';
    cache.url = safeRegExp(`^${scheme}:\\/\\/${serverRegex}:${matchPort}\\/`);
  } else if (server !== '*') {
    // Inside a host, IPv6 literals are never bracketed.
    cache.host = safeRegExp(shExp2RegExp(server, { trimAsterisk: true }));
  }

  return cache;
}
