/** Parsing and composing of the AutoProxy and Switchy rule list formats. */

import * as Conditions from './conditions.js';
import type { Condition, Rule, RuleListFormat, RuleListProfile } from './types.js';

export interface ParseArgs {
  /** Throw on malformed lines instead of skipping them. */
  strict?: boolean;
  /** Record the originating text on each rule. Defaults to true. */
  source?: boolean;
}

export interface RuleListError extends Error {
  reason: string;
  source?: string;
  sourceLineNo?: number;
}

export interface FormatHandler {
  /** True/false when the format is certain, undefined when unknown. */
  detect?(text: string): boolean | undefined;
  preprocess?(text: string): string;
  parse(text: string, matchProfileName: string, defaultProfileName: string): Rule[];
  directReferenceSet?(profile: RuleListProfile): Record<string, string> | undefined;
}

function decodeBase64Utf8(text: string): string {
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --- AutoProxy --------------------------------------------------------------

const AUTOPROXY_MAGIC_PREFIX = 'W0F1dG9Qcm94'; // base64 of "[AutoProxy"

export const AutoProxy: FormatHandler = {
  detect(text) {
    if (text.startsWith(AUTOPROXY_MAGIC_PREFIX)) return true;
    if (text.startsWith('[AutoProxy')) return true;
    return undefined;
  },

  preprocess(text) {
    return text.startsWith(AUTOPROXY_MAGIC_PREFIX) ? decodeBase64Utf8(text) : text;
  },

  parse(text, matchProfileName, defaultProfileName) {
    const normalRules: Rule[] = [];
    const exclusiveRules: Rule[] = [];

    for (const rawLine of text.split(/\n|\r/)) {
      let line = rawLine.trim();
      if (line.length === 0 || line[0] === '!' || line[0] === '[') continue;

      const source = line;
      let profile = matchProfileName;
      let list = normalRules;

      if (line[0] === '@' && line[1] === '@') {
        profile = defaultProfileName;
        list = exclusiveRules;
        line = line.substring(2);
      }

      let condition: Condition;
      if (line[0] === '/') {
        condition = {
          conditionType: 'UrlRegexCondition',
          pattern: line.substring(1, line.length - 1),
        };
      } else if (line[0] === '|') {
        condition =
          line[1] === '|'
            ? { conditionType: 'HostWildcardCondition', pattern: '*.' + line.substring(2) }
            : { conditionType: 'UrlWildcardCondition', pattern: line.substring(1) + '*' };
      } else if (line.indexOf('*') < 0) {
        condition = { conditionType: 'KeywordCondition', pattern: line };
      } else {
        condition = { conditionType: 'UrlWildcardCondition', pattern: 'http://*' + line + '*' };
      }

      list.push({ condition, profileName: profile, source });
    }

    // Exclusive rules take priority, so they are evaluated first.
    return exclusiveRules.concat(normalRules);
  },
};

// --- Switchy ----------------------------------------------------------------

const OMEGA_PREFIX = '[SwitchyDelta Conditions';
/** Rule lists written before the project was renamed. */
const LEGACY_OMEGA_PREFIX = '[SwitchyOmega Conditions';
const SPECIAL_LINE_START = '[;#@!';

type SwitchyParser = 'parseOmega' | 'parseLegacy';

function getParser(text: string): SwitchyParser {
  const hasOmegaHeader =
    text.startsWith(OMEGA_PREFIX) || text.startsWith(LEGACY_OMEGA_PREFIX);
  if (!hasOmegaHeader && (text[0] === '#' || text.indexOf('\n#') >= 0)) {
    return 'parseLegacy';
  }
  return 'parseOmega';
}

export interface ComposeOptions {
  withResult?: boolean;
  useExclusive?: boolean;
}

/**
 * For the Switchy rule list format, see:
 * https://github.com/FelisCatus/SwitchyOmega/wiki/SwitchyOmega-conditions-format
 */
export function compose(
  { rules, defaultProfileName }: { rules: Rule[]; defaultProfileName: string },
  { withResult, useExclusive }: ComposeOptions = {},
): string {
  const eol = '\r\n';
  let ruleList = '[SwitchyDelta Conditions]' + eol;
  useExclusive ??= !withResult;
  ruleList += withResult ? '@with result' + eol + eol : eol;

  const specialLineStart = SPECIAL_LINE_START + '+';
  for (const rule of rules) {
    if (rule.note) {
      ruleList += '@note ' + rule.note + eol;
    }
    let line = Conditions.str(rule.condition);
    if (useExclusive && rule.profileName === defaultProfileName) {
      line = '!' + line;
    } else {
      if (specialLineStart.indexOf(line[0]!) >= 0) {
        line = ': ' + line;
      }
      if (withResult) {
        line += ' +' + rule.profileName;
      }
    }
    ruleList += line + eol;
  }
  if (withResult) {
    ruleList += eol + '* +' + defaultProfileName + eol;
  }
  return ruleList;
}

function conditionFromLegacyWildcard(pattern: string): Condition {
  let source = pattern;
  if (source[0] === '@') {
    source = source.substring(1);
  } else {
    if (source.indexOf('://') <= 0 && source[0] !== '*') {
      source = '*' + source;
    }
    if (source[source.length - 1] !== '*') {
      source += '*';
    }
  }

  const host = Conditions.urlWildcard2HostWildcard(source);
  return host
    ? { conditionType: 'HostWildcardCondition', pattern: host }
    : { conditionType: 'UrlWildcardCondition', pattern: source };
}

function parseLegacy(
  text: string,
  matchProfileName: string,
  defaultProfileName: string,
): Rule[] {
  const normalRules: Rule[] = [];
  const exclusiveRules: Rule[] = [];
  let begin = false;
  let section = 'WILDCARD';

  for (const rawLine of text.split(/\n|\r/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line[0] === ';') continue;

    if (!begin) {
      if (line.toUpperCase() === '#BEGIN') begin = true;
      continue;
    }
    if (line.toUpperCase() === '#END') break;

    if (line[0] === '[' && line[line.length - 1] === ']') {
      section = line.substring(1, line.length - 1).toUpperCase();
      continue;
    }

    const source = line;
    let profile = matchProfileName;
    let list = normalRules;
    if (line[0] === '!') {
      profile = defaultProfileName;
      list = exclusiveRules;
      line = line.substring(1);
    }

    let condition: Condition | null = null;
    if (section === 'WILDCARD') {
      condition = conditionFromLegacyWildcard(line);
    } else if (section === 'REGEXP') {
      condition = { conditionType: 'UrlRegexCondition', pattern: line };
    }

    if (condition) {
      list.push({ condition, profileName: profile, source });
    }
  }

  return exclusiveRules.concat(normalRules);
}

function parseOmega(
  text: string,
  matchProfileName: string,
  defaultProfileName: string,
  args: ParseArgs = {},
): Rule[] {
  const { strict } = args;
  const includeSource = args.source ?? true;

  const fail = (fields: { message: string; reason: string; source?: string; sourceLineNo?: number }) => {
    if (!strict) return;
    const err = new Error(fields.message) as RuleListError;
    err.reason = fields.reason;
    if (fields.source !== undefined) err.source = fields.source;
    if (fields.sourceLineNo !== undefined) err.sourceLineNo = fields.sourceLineNo;
    throw err;
  };

  const rules: Rule[] = [];
  const rulesWithDefaultProfile: Rule[] = [];
  let withResult = false;
  let exclusiveProfile: string | null = null;
  let noteForNextRule: string | null = null;
  let lno = 0;

  for (const rawLine of text.split(/\n|\r/)) {
    lno++;
    let line = rawLine.trim();
    if (line.length === 0) continue;

    if (line[0] === '[' || line[0] === ';') continue; // header / comment

    if (line[0] === '@') {
      // Directive line.
      let iSpace = line.indexOf(' ');
      if (iSpace < 0) iSpace = line.length;
      const directive = line.substring(1, iSpace);
      line = line.substring(iSpace + 1).trim();
      const upper = directive.toUpperCase();
      if (upper === 'WITH') {
        const feature = line.toUpperCase();
        if (feature === 'RESULT' || feature === 'RESULTS') withResult = true;
      } else if (upper === 'NOTE') {
        noteForNextRule = line;
      }
      continue;
    }

    let source: string | null = null;
    if (strict) exclusiveProfile = null;

    let profile: string | null;
    if (line[0] === '!') {
      profile = withResult ? null : defaultProfileName;
      source = line;
      line = line.substring(1);
    } else if (withResult) {
      const iSpace = line.lastIndexOf(' +');
      if (iSpace < 0) {
        fail({
          message: 'Missing result profile name: ' + line,
          reason: 'missingResultProfile',
          source: line,
          sourceLineNo: lno,
        });
        continue;
      }
      profile = line.substring(iSpace + 2).trim();
      line = line.substring(0, iSpace).trim();
      if (line === '*') exclusiveProfile = profile;
    } else {
      profile = matchProfileName;
    }

    const condition = Conditions.fromStr(line);
    if (!condition) {
      fail({
        message: 'Invalid rule: ' + line,
        reason: 'invalidRule',
        source: source ?? line,
        sourceLineNo: lno,
      });
      continue;
    }

    const rule: Rule = { condition, profileName: profile };
    if (includeSource) rule.source = source ?? line;
    if (noteForNextRule !== null) {
      rule.note = noteForNextRule;
      noteForNextRule = null;
    }
    rules.push(rule);
    if (!profile) rulesWithDefaultProfile.push(rule);
  }

  if (withResult) {
    if (!exclusiveProfile) {
      fail({
        message: "Missing default rule with catch-all '*' condition",
        reason: 'noDefaultRule',
      });
      exclusiveProfile = defaultProfileName || 'direct';
    }
    for (const rule of rulesWithDefaultProfile) {
      rule.profileName = exclusiveProfile;
    }
  }

  return rules;
}

export const Switchy: FormatHandler & {
  compose: typeof compose;
  parseOmega: typeof parseOmega;
  parseLegacy: typeof parseLegacy;
  conditionFromLegacyWildcard: typeof conditionFromLegacyWildcard;
  omegaPrefix: string;
  legacyOmegaPrefix: string;
  specialLineStart: string;
} = {
  omegaPrefix: OMEGA_PREFIX,
  legacyOmegaPrefix: LEGACY_OMEGA_PREFIX,
  specialLineStart: SPECIAL_LINE_START,

  detect(text) {
    if (text.startsWith(OMEGA_PREFIX)) return true;
    if (text.startsWith(LEGACY_OMEGA_PREFIX)) return true;
    return undefined;
  },

  parse(text, matchProfileName, defaultProfileName) {
    const parser = getParser(text);
    return parser === 'parseOmega'
      ? parseOmega(text, matchProfileName, defaultProfileName)
      : parseLegacy(text, matchProfileName, defaultProfileName);
  },

  directReferenceSet({ ruleList, defaultProfileName }) {
    const text = ruleList.trim();
    if (getParser(text) !== 'parseOmega') return undefined;
    if (!/(^|\n)@with\s+results?(\r|\n|$)/i.test(text)) return undefined;

    const refs: Record<string, string> = {};
    for (const rawLine of text.split(/\n|\r/)) {
      const line = rawLine.trim();
      if (SPECIAL_LINE_START.indexOf(line[0]!) < 0) {
        const iSpace = line.lastIndexOf(' +');
        const profile =
          iSpace < 0 ? defaultProfileName || 'direct' : line.substring(iSpace + 2).trim();
        refs['+' + profile] = profile;
      }
    }
    return refs;
  },

  compose,
  parseOmega,
  parseLegacy,
  conditionFromLegacyWildcard,
};

export const formats: Record<RuleListFormat, FormatHandler> = {
  Switchy,
  AutoProxy,
};
