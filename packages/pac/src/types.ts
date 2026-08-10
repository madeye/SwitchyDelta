/** Shared data model for profiles, conditions and rules. */

export interface ProxyServer {
  scheme: string;
  host: string;
  port: number;
}

export interface ProxyAuth {
  username: string;
  password: string;
}

/** A request as seen by the matcher; mirrors the PAC `FindProxyForURL` inputs. */
export interface Request {
  url: string;
  host: string;
  scheme: string;
}

// --- Conditions -------------------------------------------------------------

export type ConditionType =
  | 'TrueCondition'
  | 'FalseCondition'
  | 'UrlRegexCondition'
  | 'UrlWildcardCondition'
  | 'HostRegexCondition'
  | 'HostWildcardCondition'
  | 'BypassCondition'
  | 'KeywordCondition'
  | 'IpCondition'
  | 'HostLevelsCondition'
  | 'WeekdayCondition'
  | 'TimeCondition';

export interface TrueCondition {
  conditionType: 'TrueCondition';
  pattern?: string;
}
export interface FalseCondition {
  conditionType: 'FalseCondition';
  pattern?: string;
}
export interface UrlRegexCondition {
  conditionType: 'UrlRegexCondition';
  pattern: string;
}
export interface UrlWildcardCondition {
  conditionType: 'UrlWildcardCondition';
  pattern: string;
}
export interface HostRegexCondition {
  conditionType: 'HostRegexCondition';
  pattern: string;
}
export interface HostWildcardCondition {
  conditionType: 'HostWildcardCondition';
  pattern: string;
}
export interface BypassCondition {
  conditionType: 'BypassCondition';
  pattern: string;
}
export interface KeywordCondition {
  conditionType: 'KeywordCondition';
  pattern: string;
}
export interface IpCondition {
  conditionType: 'IpCondition';
  ip: string;
  prefixLength: number;
}
export interface HostLevelsCondition {
  conditionType: 'HostLevelsCondition';
  minValue: number;
  maxValue: number;
}
export interface WeekdayCondition {
  conditionType: 'WeekdayCondition';
  /** Seven characters; a letter (code > 64) enables that weekday. */
  days?: string;
  startDay?: number;
  endDay?: number;
}
export interface TimeCondition {
  conditionType: 'TimeCondition';
  startHour: number;
  endHour: number;
}

export type Condition =
  | TrueCondition
  | FalseCondition
  | UrlRegexCondition
  | UrlWildcardCondition
  | HostRegexCondition
  | HostWildcardCondition
  | BypassCondition
  | KeywordCondition
  | IpCondition
  | HostLevelsCondition
  | WeekdayCondition
  | TimeCondition;

/** Conditions whose entire state is a single `pattern` string. */
export type PatternCondition = Extract<Condition, { pattern: string }>;

export interface Rule {
  condition: Condition;
  /** Null while parsing a `@with result` list before the default is resolved. */
  profileName: string | null;
  source?: string;
  note?: string;
}

// --- Profiles ---------------------------------------------------------------

export type ProfileType =
  | 'DirectProfile'
  | 'SystemProfile'
  | 'FixedProfile'
  | 'PacProfile'
  | 'AutoDetectProfile'
  | 'SwitchProfile'
  | 'VirtualProfile'
  | 'RuleListProfile'
  | 'SwitchyRuleListProfile'
  | 'AutoProxyRuleListProfile';

export interface ProfileBase {
  name: string;
  profileType: ProfileType;
  revision?: string;
  color?: string;
  builtin?: boolean;
}

export interface DirectProfile extends ProfileBase {
  profileType: 'DirectProfile';
}

export interface SystemProfile extends ProfileBase {
  profileType: 'SystemProfile';
}

export interface FixedProfile extends ProfileBase {
  profileType: 'FixedProfile';
  bypassList?: BypassCondition[];
  proxyForHttp?: ProxyServer;
  proxyForHttps?: ProxyServer;
  proxyForFtp?: ProxyServer;
  fallbackProxy?: ProxyServer;
  auth?: Record<string, ProxyAuth | undefined>;
}

export interface PacProfile extends ProfileBase {
  profileType: 'PacProfile' | 'AutoDetectProfile';
  pacUrl?: string;
  pacScript?: string;
}

export interface SwitchProfile extends ProfileBase {
  profileType: 'SwitchProfile' | 'VirtualProfile';
  defaultProfileName: string;
  rules: Rule[];
}

export interface RuleListProfile extends ProfileBase {
  profileType: 'RuleListProfile' | 'SwitchyRuleListProfile' | 'AutoProxyRuleListProfile';
  format?: RuleListFormat;
  defaultProfileName: string;
  matchProfileName: string;
  ruleList: string;
  sourceUrl?: string;
}

export type RuleListFormat = 'Switchy' | 'AutoProxy';

export type Profile =
  | DirectProfile
  | SystemProfile
  | FixedProfile
  | PacProfile
  | SwitchProfile
  | RuleListProfile;

/**
 * The persisted options bag. Profile entries are keyed by `+name`; other keys
 * hold unrelated settings, so lookups are narrowed at the call site.
 */
export type OptionsBag = Record<string, unknown>;

/**
 * What a matcher returns: the winning rule, or a synthesised
 * `[profileKey, null]` pair when nothing matched and the default applies.
 */
export type MatchResult = Rule | [string, null] | null | undefined;

/** How to react to a reference to a profile that does not exist. */
export type ProfileNotFoundAction =
  | 'ignore'
  | 'dumb'
  | Profile
  | ((name: string) => 'ignore' | 'dumb' | Profile);
