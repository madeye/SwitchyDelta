/**
 * Profile behaviour: matching, PAC compilation, reference graph and updates.
 */

import * as g from './codegen.js';
import * as Conditions from './conditions.js';
import * as RuleList from './rule-list.js';
import { DomainTrie } from './domain-trie.js';
import { AttachedCache, Revision } from './utils.js';
import type {
  Condition,
  FixedProfile,
  HostWildcardCondition,
  MatchResult,
  OptionsBag,
  PacProfile,
  Profile,
  ProfileNotFoundAction,
  ProfileType,
  ProxyAuth,
  ProxyServer,
  Request,
  Rule,
  RuleListFormat,
  RuleListProfile,
  SwitchProfile,
} from './types.js';

const CHAR_PLUS = '+'.charCodeAt(0);

export const builtinProfiles: Record<string, Profile> = {
  '+direct': {
    name: 'direct',
    profileType: 'DirectProfile',
    color: '#aaaaaa',
    builtin: true,
  },
  '+system': {
    name: 'system',
    profileType: 'SystemProfile',
    color: '#000000',
    builtin: true,
  },
};

export interface SchemeMapping {
  scheme: string;
  prop: 'proxyForHttp' | 'proxyForHttps' | 'proxyForFtp' | 'fallbackProxy';
}

export const schemes: readonly SchemeMapping[] = [
  { scheme: 'http', prop: 'proxyForHttp' },
  { scheme: 'https', prop: 'proxyForHttps' },
  { scheme: 'ftp', prop: 'proxyForFtp' },
  { scheme: '', prop: 'fallbackProxy' },
];

export const pacProtocols: Record<string, string> = {
  http: 'PROXY',
  https: 'HTTPS',
  socks4: 'SOCKS',
  socks5: 'SOCKS5',
};

export const formatByType: Record<string, RuleListFormat> = {
  SwitchyRuleListProfile: 'Switchy',
  AutoProxyRuleListProfile: 'AutoProxy',
};

export const ruleListFormats: readonly RuleListFormat[] = ['Switchy', 'AutoProxy'];

export function parseHostPort(str: string, scheme: string): ProxyServer | undefined {
  const sep = str.lastIndexOf(':');
  if (sep < 0) return undefined;
  const port = parseInt(str.substring(sep + 1), 10) || 80;
  const host = str.substring(0, sep);
  if (!host) return undefined;
  return { scheme, host, port };
}

/** The PAC return string for a proxy server, e.g. `PROXY 127.0.0.1:8080`. */
export function pacResult(proxy?: ProxyServer): string {
  if (!proxy) return 'DIRECT';
  if (proxy.scheme === 'socks5') {
    // SOCKS5 is not understood by every client, so a SOCKS4 fallback follows.
    return `SOCKS5 ${proxy.host}:${proxy.port}; SOCKS ${proxy.host}:${proxy.port}`;
  }
  return `${pacProtocols[proxy.scheme]} ${proxy.host}:${proxy.port}`;
}

export function isFileUrl(url: string | undefined): boolean {
  return !!(url?.substring(0, 5).toUpperCase() === 'FILE:');
}

export function nameAsKey(profileName: string | Profile): string {
  const name = typeof profileName === 'string' ? profileName : profileName.name;
  return '+' + name;
}

export function byName(
  profileName: string | Profile | undefined,
  options: OptionsBag,
): Profile | undefined {
  if (typeof profileName !== 'string') return profileName;
  const key = nameAsKey(profileName);
  return (builtinProfiles[key] ?? options[key]) as Profile | undefined;
}

export function byKey(key: string | Profile, options: OptionsBag): Profile | undefined {
  if (typeof key !== 'string') return key;
  return (builtinProfiles[key] ?? options[key]) as Profile | undefined;
}

/** Visit every profile in `options`, then every builtin profile. */
export function each(
  options: OptionsBag,
  callback: (key: string, profile: Profile) => void,
): void {
  for (const [key, profile] of Object.entries(options)) {
    if (key.charCodeAt(0) === CHAR_PLUS) callback(key, profile as Profile);
  }
  for (const [key, profile] of Object.entries(builtinProfiles)) {
    if (key.charCodeAt(0) === CHAR_PLUS) callback(key, profile);
  }
}

/** The PAC expression that yields a profile reference (or DIRECT). */
export function profileResult(profileName: string | Profile): g.Expr {
  const key = nameAsKey(profileName);
  return g.string(key === '+direct' ? pacResult() : key);
}

export function isIncludable(profile: Profile): boolean {
  const includable = handlerFor(profile).includable;
  if (typeof includable === 'function') return !!includable(profile);
  return !!includable;
}

export function isInclusive(profile: Profile): boolean {
  return !!handlerFor(profile).inclusive;
}

export function updateUrl(profile: Profile): string | undefined {
  return handlerFor(profile).updateUrl?.(profile);
}

export function updateContentTypeHints(profile: Profile): string[] | undefined {
  return handlerFor(profile).updateContentTypeHints?.();
}

export function update(profile: Profile, data: string): boolean {
  const handler = handlerFor(profile);
  if (!handler.update) return false;
  return handler.update(profile, data);
}

export function tag(profile: Profile): unknown {
  return profileCache.tag(profile);
}

export function create(profile: string | Profile, optProfileType?: ProfileType): Profile {
  let target: Profile;
  if (typeof profile === 'string') {
    target = { name: profile, profileType: optProfileType } as Profile;
  } else {
    target = profile;
    if (optProfileType) target.profileType = optProfileType;
  }
  handlerFor(target).create?.(target);
  return target;
}

export function updateRevision(profile: Profile, revision?: string): void {
  profile.revision = revision ?? Revision.fromTime();
}

export function replaceRef(profile: Profile, fromName: string, toName: string): boolean {
  if (!isInclusive(profile)) return false;
  return handlerFor(profile).replaceRef?.(profile, fromName, toName) ?? false;
}

interface ProfileCache {
  analyzed?: unknown;
  compiled?: g.Expr;
  directReferenceSet?: Record<string, string>;
}

const profileCache = new AttachedCache<Profile, ProfileCache>((profile) => profile.revision);

export function analyze(profile: Profile): unknown {
  const cache = profileCache.get(profile, () => ({}) as ProfileCache);
  if (!('analyzed' in cache)) {
    cache.analyzed = handlerFor(profile).analyze?.(profile);
  }
  return cache.analyzed;
}

export function dropCache(profile: Profile): void {
  profileCache.drop(profile);
}

export function directReferenceSet(profile: Profile): Record<string, string> {
  if (!isInclusive(profile)) return {};
  const cache = profileCache.get(profile, () => ({}) as ProfileCache);
  if (cache.directReferenceSet) return cache.directReferenceSet;
  cache.directReferenceSet = handlerFor(profile).directReferenceSet?.(profile) ?? {};
  return cache.directReferenceSet;
}

export function profileNotFound(name: string, action?: ProfileNotFoundAction): Profile | null {
  if (action === undefined || action === null) {
    throw new Error(`Profile ${name} does not exist!`);
  }
  let resolved = action;
  if (typeof resolved === 'function') {
    resolved = resolved(name);
  }
  if (typeof resolved === 'object' && resolved.profileType) {
    return resolved;
  }
  switch (resolved) {
    case 'ignore':
      return null;
    case 'dumb':
      return create({
        name,
        profileType: 'VirtualProfile',
        defaultProfileName: 'direct',
      } as Profile);
    default:
      throw resolved;
  }
}

export interface ReferenceSetArgs {
  out?: Record<string, string>;
  profileNotFound?: ProfileNotFoundAction;
}

/** Every profile transitively reachable from `profile`, keyed by `+name`. */
export function allReferenceSet(
  profile: string | Profile | undefined,
  options: OptionsBag,
  args: ReferenceSetArgs = {},
): Record<string, string> {
  const original = profile;
  let resolved = byName(profile, options);
  if (!resolved && typeof original === 'string') {
    resolved = profileNotFound(original, args.profileNotFound) ?? undefined;
  }
  const result = (args.out ??= {});
  if (resolved) {
    result[nameAsKey(resolved.name)] = resolved.name;
    for (const name of Object.values(directReferenceSet(resolved))) {
      if (!(nameAsKey(name) in result)) {
        allReferenceSet(name, options, args);
      }
    }
  }
  return result;
}

/** Every profile that transitively references `profile`. */
export function referencedBySet(
  profile: string | Profile,
  options: OptionsBag,
  args: ReferenceSetArgs = {},
): Record<string, string> {
  const profileKey = nameAsKey(profile);
  const result = (args.out ??= {});
  each(options, (key, prof) => {
    if (directReferenceSet(prof)[profileKey] && !(key in result)) {
      result[key] = prof.name;
      referencedBySet(prof, options, args);
    }
  });
  return result;
}

/** Profiles that `profile` may target without creating a reference cycle. */
export function validResultProfilesFor(
  profile: string | Profile,
  options: OptionsBag,
): Profile[] {
  const resolved = byName(profile, options);
  if (!resolved || !isInclusive(resolved)) return [];
  const profileKey = nameAsKey(resolved);
  const ref = referencedBySet(resolved, options);
  ref[profileKey] = profileKey;
  const result: Profile[] = [];
  each(options, (key, prof) => {
    if (!ref[key] && isIncludable(prof)) result.push(prof);
  });
  return result;
}

export function match(
  profile: Profile,
  request: Request,
  optProfileType?: ProfileType,
): MatchResult {
  const type = optProfileType ?? profile.profileType;
  const analyzed = analyze(profile);
  return handlerFor(type).match?.(profile, request, analyzed);
}

export function compile(profile: Profile, optProfileType?: ProfileType): g.Expr {
  const type = optProfileType ?? profile.profileType;
  const cache = profileCache.get(profile, () => ({}) as ProfileCache);
  if (cache.compiled !== undefined) return cache.compiled;
  // analyze() shares the same cache entry and must run first.
  const analyzed = analyze(profile);
  cache.compiled = handlerFor(type).compile(profile, analyzed);
  return cache.compiled;
}

// --- Rule analysis (DomainTrie acceleration) --------------------------------

export interface RulesAnalysis {
  rules: Rule[];
  domainTrie: DomainTrie<number>;
  /** Per-rule: true when every pattern of the rule went into the trie. */
  simpleHost: boolean[];
  hasNonHostRules: boolean;
}

/** True when a domain still has wildcards after prefix forms are stripped. */
function isComplexHostDomain(domain: string): boolean {
  return domain.indexOf('*') >= 0 || domain.indexOf('?') >= 0;
}

/**
 * Map a host wildcard pattern to DomainTrie keys, mirroring the matching magic
 * in `Conditions`. Returns null when the pattern is too complex for the trie,
 * in which case the rule stays on the linear match path.
 *
 * Exported for tests: the trie keys must stay in lockstep with the regular
 * expressions `Conditions` builds for the same pattern.
 */
export function hostPatternToTrieKeys(pattern: string): string[] | null {
  let source = pattern;
  if (source.charCodeAt(0) === '.'.charCodeAt(0)) {
    source = '*' + source;
  }

  if (source.indexOf('**.') === 0) {
    const domain = source.substring(3);
    if (domain.length === 0 || isComplexHostDomain(domain)) return null;
    // Any subdomain depth, but never the apex.
    return ['.' + domain];
  }

  if (source.indexOf('*.') === 0) {
    const domain = source.substring(2);
    if (domain.length === 0 || isComplexHostDomain(domain)) return null;
    // The magical form: apex plus any subdomain depth.
    return [domain, '.' + domain];
  }

  if (source.length === 0 || isComplexHostDomain(source)) return null;
  return [source];
}

export function buildRulesAnalysis(rules: Rule[]): RulesAnalysis {
  const domainTrie = new DomainTrie<number>();
  const simpleHost = new Array<boolean>(rules.length).fill(false);
  let hasNonHostRules = false;

  rules.forEach((rule, i) => {
    const cond = rule.condition;
    if (cond.conditionType !== 'HostWildcardCondition') {
      hasNonHostRules = true;
      return;
    }
    const patterns = (cond as HostWildcardCondition).pattern.split('|').filter((p) => p);
    const keysPerPattern: string[][] = [];
    let allSimple = patterns.length > 0;
    for (const pattern of patterns) {
      const keys = hostPatternToTrieKeys(pattern);
      if (keys === null) {
        allSimple = false;
        break;
      }
      keysPerPattern.push(keys);
    }
    if (allSimple) {
      for (const keys of keysPerPattern) {
        for (const key of keys) domainTrie.insert(key, i);
      }
      simpleHost[i] = true;
    } else {
      hasNonHostRules = true;
    }
  });

  return { rules, domainTrie, simpleHost, hasNonHostRules };
}

// --- Handlers ---------------------------------------------------------------

interface ProfileHandler<P extends Profile = Profile, A = unknown> {
  includable?: boolean | ((profile: P) => boolean);
  inclusive?: boolean;
  create?(profile: P): void;
  analyze?(profile: P): A;
  match?(profile: P, request: Request, analyzed: A): MatchResult;
  compile(profile: P, analyzed: A): g.Expr;
  str?(profile: P): string;
  directReferenceSet?(profile: P): Record<string, string>;
  replaceRef?(profile: P, fromName: string, toName: string): boolean;
  updateUrl?(profile: P): string | undefined;
  updateContentTypeHints?(): string[];
  update?(profile: P, data: string): boolean;
}

/**
 * Handlers are authored against their concrete profile type but dispatched
 * dynamically, so the registry erases the parameter types.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyProfileHandler = ProfileHandler<any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

function handlerFor(profileType: ProfileType | Profile): AnyProfileHandler {
  let name: string = typeof profileType === 'string' ? profileType : profileType.profileType;
  let handler: AnyProfileHandler | string | undefined = name;
  // Aliases are stored as strings pointing at another handler.
  while (typeof handler === 'string') {
    name = handler;
    handler = profileTypes[handler];
  }
  if (handler === undefined) {
    throw new Error(`Unknown profile type: ${name}`);
  }
  return handler;
}

const PAC_ARGS = ['url', 'host', 'scheme'];

const profileTypes: Record<string, AnyProfileHandler | string> = {
  SystemProfile: {
    compile(): g.Expr {
      throw new Error('SystemProfile cannot be used in PAC scripts');
    },
  },

  DirectProfile: {
    includable: true,
    compile: () => g.string(pacResult()),
  },

  FixedProfile: {
    includable: true,
    create(profile: FixedProfile) {
      profile.bypassList ??= [
        { conditionType: 'BypassCondition', pattern: '127.0.0.1' },
        { conditionType: 'BypassCondition', pattern: '[::1]' },
        { conditionType: 'BypassCondition', pattern: 'localhost' },
      ];
    },
    match(profile: FixedProfile, request: Request): MatchResult {
      if (profile.bypassList) {
        for (const cond of profile.bypassList) {
          if (Conditions.match(cond, request)) {
            return [pacResult(), cond, { scheme: 'direct' }, undefined] as unknown as MatchResult;
          }
        }
      }
      for (const s of schemes) {
        if (s.scheme === request.scheme && profile[s.prop]) {
          return [
            pacResult(profile[s.prop]),
            s.scheme,
            profile[s.prop],
            profile.auth?.[s.prop] ?? profile.auth?.['all'],
          ] as unknown as MatchResult;
        }
      }
      return [
        pacResult(profile.fallbackProxy),
        '',
        profile.fallbackProxy,
        profile.auth?.['fallbackProxy'] ?? profile.auth?.['all'],
      ] as unknown as MatchResult;
    },
    compile(profile: FixedProfile): g.Expr {
      // With no bypass list and no per-scheme proxies there is nothing to
      // branch on, so a constant result is enough.
      if (
        (!profile.bypassList || !profile.fallbackProxy) &&
        !profile.proxyForHttp &&
        !profile.proxyForHttps &&
        !profile.proxyForFtp
      ) {
        return g.string(pacResult(profile.fallbackProxy));
      }

      let body = '"use strict";';

      if (profile.bypassList && profile.bypassList.length) {
        const conditions = g.or(profile.bypassList.map((cond) => Conditions.compile(cond)));
        body += g.ifThen(conditions, g.ret(g.string(pacResult())));
      }

      if (!profile.proxyForHttp && !profile.proxyForHttps && !profile.proxyForFtp) {
        body += g.ret(g.string(pacResult(profile.fallbackProxy)));
      } else {
        const cases = schemes
          .filter((s) => !s.scheme || profile[s.prop])
          .map((s) => ({
            test: s.scheme ? g.string(s.scheme) : null,
            body: g.ret(g.string(pacResult(profile[s.prop]))),
          }));
        body += g.switchStmt(g.ref('scheme'), cases);
      }

      return g.func(PAC_ARGS, body);
    },
  },

  PacProfile: {
    includable: (profile: PacProfile) => !isFileUrl(profile.pacUrl),
    create(profile: PacProfile) {
      profile.pacScript ??= 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}';
    },
    compile(profile: PacProfile): g.Expr {
      // The user's PAC script is spliced in verbatim, so it must be terminated
      // defensively (see SwitchyOmega issue #390):
      //   1. a newline ends any trailing line comment (// ...)
      //   2. a second newline survives a trailing backslash escaping the first
      //   3. a comment block closes any unterminated /* ...
      //   4. a semicolon terminates the final statement
      const raw = `;\n${profile.pacScript ?? ''}\n\n/* End of PAC */;`;
      const body = raw + g.ret(g.ref('FindProxyForURL'));
      return g.call(g.member(g.func([], body), 'call'), [g.ref('this')]);
    },
    updateUrl: (profile: PacProfile) => (isFileUrl(profile.pacUrl) ? undefined : profile.pacUrl),
    updateContentTypeHints: () => [
      '!text/html',
      '!application/xhtml+xml',
      'application/x-ns-proxy-autoconfig',
      'application/x-javascript-config',
    ],
    update(profile: PacProfile, data: string): boolean {
      if (profile.pacScript === data) return false;
      profile.pacScript = data;
      return true;
    },
  },

  AutoDetectProfile: 'PacProfile',

  SwitchProfile: {
    includable: true,
    inclusive: true,
    create(profile: SwitchProfile) {
      profile.defaultProfileName ??= 'direct';
      profile.rules ??= [];
    },
    directReferenceSet(profile: SwitchProfile): Record<string, string> {
      const refs: Record<string, string> = {};
      refs[nameAsKey(profile.defaultProfileName)] = profile.defaultProfileName;
      for (const rule of profile.rules) {
        if (rule.profileName) refs[nameAsKey(rule.profileName)] = rule.profileName;
      }
      return refs;
    },
    analyze: (profile: SwitchProfile) => buildRulesAnalysis(profile.rules),
    replaceRef(profile: SwitchProfile, fromName: string, toName: string): boolean {
      let changed = false;
      if (profile.defaultProfileName === fromName) {
        profile.defaultProfileName = toName;
        changed = true;
      }
      for (const rule of profile.rules) {
        if (rule.profileName === fromName) {
          rule.profileName = toName;
          changed = true;
        }
      }
      return changed;
    },
    match(profile: SwitchProfile, request: Request, analyzed: RulesAnalysis): MatchResult {
      const { rules, simpleHost, domainTrie } = analyzed;
      // The trie resolves first-match among all simple host rules in one pass,
      // so those rules never need their regex evaluated.
      const hostRuleIndex = domainTrie.isEmpty() ? undefined : domainTrie.searchMin(request.host);

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]!;
        if (simpleHost[i]) {
          if (hostRuleIndex === i) return rule;
          continue;
        }
        if (Conditions.match(rule.condition, request)) return rule;
      }
      return [nameAsKey(profile.defaultProfileName), null];
    },
    compile(profile: SwitchProfile, analyzed: RulesAnalysis): g.Expr {
      const rules = analyzed.rules;
      if (rules.length === 0) {
        return profileResult(profile.defaultProfileName);
      }
      let body = '"use strict";';
      for (const rule of rules) {
        body += g.ifThen(
          Conditions.compile(rule.condition),
          g.ret(profileResult(rule.profileName ?? profile.defaultProfileName)),
        );
      }
      body += g.ret(profileResult(profile.defaultProfileName));
      return g.func(PAC_ARGS, body);
    },
  },

  VirtualProfile: 'SwitchProfile',

  RuleListProfile: {
    includable: true,
    inclusive: true,
    create(profile: RuleListProfile) {
      profile.profileType ??= 'RuleListProfile';
      profile.format ??= formatByType[profile.profileType] ?? 'Switchy';
      profile.defaultProfileName ??= 'direct';
      profile.matchProfileName ??= 'direct';
      profile.ruleList ??= '';
    },
    directReferenceSet(profile: RuleListProfile): Record<string, string> {
      if (profile.ruleList != null) {
        const format = profile.format ?? formatByType[profile.profileType];
        const refs = format ? RuleList.formats[format]?.directReferenceSet?.(profile) : undefined;
        if (refs) return refs;
      }
      const refs: Record<string, string> = {};
      for (const name of [profile.matchProfileName, profile.defaultProfileName]) {
        refs[nameAsKey(name)] = name;
      }
      return refs;
    },
    replaceRef(profile: RuleListProfile, fromName: string, toName: string): boolean {
      let changed = false;
      if (profile.defaultProfileName === fromName) {
        profile.defaultProfileName = toName;
        changed = true;
      }
      if (profile.matchProfileName === fromName) {
        profile.matchProfileName = toName;
        changed = true;
      }
      return changed;
    },
    analyze(profile: RuleListProfile): RulesAnalysis {
      const format = profile.format ?? formatByType[profile.profileType];
      const formatHandler = format ? RuleList.formats[format] : undefined;
      if (!formatHandler) {
        throw new Error(`Unsupported rule list format ${format}!`);
      }
      let ruleList = profile.ruleList?.trim() || '';
      if (formatHandler.preprocess) {
        ruleList = formatHandler.preprocess(ruleList);
      }
      const rules = formatHandler.parse(
        ruleList,
        profile.matchProfileName,
        profile.defaultProfileName,
      );
      return buildRulesAnalysis(rules);
    },
    match: (profile: RuleListProfile, request: Request) =>
      match(profile, request, 'SwitchProfile'),
    compile: (profile: RuleListProfile) => compile(profile, 'SwitchProfile'),
    updateUrl: (profile: RuleListProfile) => profile.sourceUrl,
    updateContentTypeHints: () => ['!text/html', '!application/xhtml+xml', 'text/plain', '*'],
    update(profile: RuleListProfile, data: string): boolean {
      let text = data.trim();
      const original = profile.format ?? formatByType[profile.profileType];
      profile.profileType = 'RuleListProfile';

      let format: RuleListFormat | null = original ?? null;
      if (format && RuleList.formats[format]?.detect?.(text) === false) {
        // The data does not belong to the currently configured format.
        format = null;
      }
      for (const formatName of Object.keys(RuleList.formats) as RuleListFormat[]) {
        const result = RuleList.formats[formatName]?.detect?.(text);
        if (result === true || (result !== false && format === null)) {
          format = formatName;
          profile.format = formatName;
        }
      }
      format ??= original ?? 'Switchy';

      const formatHandler = RuleList.formats[format];
      if (formatHandler?.preprocess) {
        text = formatHandler.preprocess(text);
      }
      if (profile.ruleList === text) return false;
      profile.ruleList = text;
      return true;
    },
  },

  SwitchyRuleListProfile: 'RuleListProfile',
  AutoProxyRuleListProfile: 'RuleListProfile',
};

export type { ProxyAuth, Condition };
